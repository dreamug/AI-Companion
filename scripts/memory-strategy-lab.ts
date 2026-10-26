import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel, MockModel } from "../src/model.js";
import type { ModelRequest } from "../src/model.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { projectedTokens } from "../src/memory/reading.js";
import { E5_KEY } from "../src/memory/embedding.js";
import { writePrivateJson } from "../src/files.js";
import { acquireInstance } from "../src/instance.js";
import {
  STRATEGIES,
  type Strategy,
  installStrategy,
  comparisonWireRequest,
  actualDelivery,
  sourceRecall,
} from "./lib/memory-strategy-comparison.js";

const out = resolve("test-results/memory-strategy-comparison-v1");
const fixtureRaw = readFileSync(
  new URL(
    "../tests/fixtures/memory-strategy-comparison-v1.json",
    import.meta.url,
  ),
  "utf8",
);
type Fact = {
  id: string;
  text: string;
  existingId?: string;
  eligibility?: string;
};
type Query = {
  id: string;
  query: string;
  kind: string;
  expected: string[];
  requiredMeaning: string;
  unknownParts: string[];
};
const fixture = JSON.parse(fixtureRaw) as {
  facts: Fact[];
  queries: Query[];
  browserDemoIds: string[];
  protocol: unknown;
};
if (
  createHash("sha256").update(fixtureRaw).digest("hex") !==
  JSON.parse(readFileSync(join(out, "freeze.json"), "utf8")).fixtureHash
)
  throw Error("comparison_fixture_changed");
const labels: Record<Strategy, string> = {
  all: "全量读取",
  keyword: "纯关键词",
  e5: "E5 混合召回",
};
const config = (dir: string, strategy?: Strategy) =>
  loadConfig({
    dataDir: dir,
    modelMode: "deepseek",
    memoryV2: true,
    memoryVectors: strategy === "e5",
    memorySummaries: false,
    memoryAnswerReasoning: true,
    memoryReplyGuard: true,
    maxOutputTokens: 1500,
    trafficOrigin: "synthetic",
  });
const manifestPath = join(out, "seed-manifest.json");
if (!existsSync(manifestPath)) {
  const dir = join(out, "data/master"),
    cfg = config(dir),
    store = new Store(dir, LOCAL_SCOPE),
    h = new Harness(store, new MockModel(), cfg);
  const aliases: Record<string, string> = {};
  try {
    for (const f of fixture.facts) {
      if (f.existingId) {
        const m = store.require("memories", f.existingId);
        if (m.text !== f.text) throw Error("comparison_original_fact_mismatch");
        aliases[m.id] = f.id;
        continue;
      }
      if (f.eligibility === "other_scope") continue;
      const m = h.addMemory(
        {
          text: f.text,
          realityScope: f.eligibility === "roleplay" ? "roleplay" : "reality",
          ...(f.eligibility === "expired" ? { validFrom: 1, validTo: 2 } : {}),
          certainty: "stated",
        },
        f.eligibility === "pending",
      );
      aliases[m.id] = f.id;
      if (f.eligibility === "invalid_source") {
        const source = store.require("sources", m.sources[0]!.id);
        store.put("sources", { ...source, deleted: true });
      }
    }
    const otherStore = new Store(dir, {
      ownerUserId: "comparison-other-owner",
      relationshipId: "comparison-other-relationship",
    });
    const other = new Harness(otherStore, new MockModel(), cfg);
    try {
      for (const f of fixture.facts.filter(
        (f) => f.eligibility === "other_scope",
      )) {
        const m = other.addMemory({ text: f.text, realityScope: "reality" });
        aliases[m.id] = f.id;
      }
    } finally {
      await other.close();
    }
    store.saveSettings({
      ...store.settings(),
      autoExtract: false,
      proactiveEnabled: false,
      remoteDisclosureAcknowledged: true,
      dailyTokenBudget: 2000000,
    });
    const eligible = [...store.qualifiedFacts(Date.now())];
    if (
      eligible.length !== 32 ||
      projectedTokens(eligible) <= 2000 ||
      projectedTokens(eligible) > 12000
    )
      throw Error("comparison_invalid_scale");
    writePrivateJson(manifestPath, {
      aliases,
      eligibleCount: eligible.length,
      allProjectionTokens: projectedTokens(eligible),
      createdAt: new Date().toISOString(),
      fixtureHash: createHash("sha256").update(fixtureRaw).digest("hex"),
      modelKey: E5_KEY,
    });
  } finally {
    await h.close();
  }
  for (const strategy of STRATEGIES) {
    const dest = join(out, "data", strategy);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    copyFileSync(join(dir, "companion.sqlite"), join(dest, "companion.sqlite"));
  }
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  aliases: Record<string, string>;
  eligibleCount: number;
  allProjectionTokens: number;
  modelKey: string;
};
const wireDir = join(out, "wire");
mkdirSync(wireDir, { recursive: true, mode: 0o700 });
type Wire = {
  purpose: string;
  request: Omit<ModelRequest, "signal">;
  answer: string;
  finished: boolean;
};
const instances = new Map<
  Strategy,
  { h: Harness; calls: Wire[]; reads: Record<string, unknown>[] }
>();
for (const strategy of STRATEGIES) {
  const dir = join(out, "data", strategy),
    cfg = config(dir, strategy),
    store = new Store(dir, LOCAL_SCOPE);
  const contextMemories = store.contextMemories.bind(store),
    byStatus = store.byStatus.bind(store);
  store.contextMemories = () =>
    contextMemories().filter((m) => m.kind !== "episode");
  store.byStatus = ((table, statuses) =>
    table === "conversation_summaries"
      ? []
      : byStatus(table, statuses)) as typeof store.byStatus;
  const provider = new ProviderModel(cfg, () => store.settings().model),
    calls: Wire[] = [];
  const h = new Harness(
    store,
    {
      get name() {
        return provider.name;
      },
      async *stream(request) {
        const actual = comparisonWireRequest(request),
          { signal: _signal, ...safe } = actual;
        const call: Wire = {
          purpose: actual.purpose,
          request: safe,
          answer: "",
          finished: false,
        };
        calls.push(call);
        const path = join(
          wireDir,
          `${Date.now()}-${strategy}-${randomUUID()}.json`,
        );
        writePrivateJson(path, call);
        try {
          for await (const event of provider.stream(actual)) {
            if (event.type === "text") call.answer += event.text;
            if (event.type === "finish") call.finished = true;
            yield event;
          }
        } finally {
          writePrivateJson(path, call);
        }
      },
    },
    cfg,
  );
  installStrategy(h, strategy);
  const read = h.memory.facts.bind(h.memory),
    reads: Record<string, unknown>[] = [];
  h.memory.facts = async (...args) => {
    const start = performance.now(),
      r = await read(...args);
    reads.push({
      query: args[0],
      mode: r.mode,
      reasons: r.reasons,
      selected: r.selected.map((m) => manifest.aliases[m.id]),
      tokens: projectedTokens(r.selected),
      elapsedMs: performance.now() - start,
      diagnostic: r.diagnostic,
    });
    return r;
  };
  instances.set(strategy, { h, calls, reads });
}
const hybrid = instances.get("e5")!.h;
const coldStart = performance.now();
hybrid.memory.embedding!.warm();
for (let i = 0; i < 300 && !hybrid.memory.embedding!.ready; i++)
  await new Promise((r) => setTimeout(r, 100));
if (!hybrid.memory.embedding!.ready) throw Error("comparison_e5_not_ready");
const modelLoadMs = performance.now() - coldStart;
let indexed = 0;
while (await hybrid.memory.indexOne(new AbortController().signal, Date.now())) {
  if (++indexed > 100) throw Error("comparison_index_loop");
}
const ready = hybrid.store.db
  .prepare(
    "SELECT count(*) AS n FROM memory_index_state WHERE owner=? AND relationship=? AND modelKey=? AND status='ready'",
  )
  .get(LOCAL_SCOPE.ownerUserId, LOCAL_SCOPE.relationshipId, E5_KEY) as {
  n: number;
};
if (ready.n < 32) throw Error("comparison_incomplete_index");
await hybrid.memory.facts("查看记忆资料", Date.now());
const offline: Record<string, unknown>[] = [];
for (const q of fixture.queries)
  for (const strategy of STRATEGIES) {
    const x = instances.get(strategy)!,
      r = await x.h.memory.facts(q.query, Date.now()),
      ids = r.selected.map((m) => manifest.aliases[m.id]!);
    offline.push({
      queryId: q.id,
      strategy,
      kind: q.kind,
      selected: ids,
      recall: sourceRecall(q.expected, ids),
      mode: r.mode,
      reasons: r.reasons,
      read: x.reads.at(-1),
    });
  }
writePrivateJson(join(out, "retrieval.json"), {
  fixtureHash: JSON.parse(readFileSync(join(out, "freeze.json"), "utf8"))
    .fixtureHash,
  manifest,
  modelLoadMs,
  indexReady: ready.n,
  rows: offline,
});

type Row = Record<string, unknown>;
const results: Row[] = existsSync(join(out, "answers.json"))
  ? JSON.parse(readFileSync(join(out, "answers.json"), "utf8")).rows
  : [];
const persist = () =>
  writePrivateJson(join(out, "answers.json"), {
    protocol: fixture.protocol,
    rows: results,
  });
async function ask(
  strategy: Strategy,
  question: string,
  phase: string,
  qid?: string,
) {
  const x = instances.get(strategy)!,
    callsAt = x.calls.length,
    readAt = x.reads.length,
    start = performance.now();
  const submitted = x.h.submit(question, randomUUID());
  await x.h.waitForIdle(70000);
  const run = x.h.store.require("runs", submitted.runId);
  const answer = x.h.store
    .all("messages")
    .filter((m) => m.role === "assistant" && m.runId === run.id)
    .map((m) => m.content)
    .join("");
  const calls = x.calls.slice(callsAt),
    chats = calls.filter((c) => c.purpose === "chat"),
    actual = chats.at(-1),
    delivery = actual ? actualDelivery(actual.request) : undefined;
  const selected =
    delivery?.memories.map((m) => manifest.aliases[m.id] ?? "unmapped") ?? [];
  const oracle = qid ? fixture.queries.find((q) => q.id === qid) : undefined;
  const row: Row = {
    id: randomUUID(),
    phase,
    queryId: qid,
    strategy,
    label: labels[strategy],
    question,
    runId: run.id,
    status: run.status,
    reason: run.reason,
    answer,
    selected,
    selectedFacts: delivery?.memories,
    readScope: delivery?.memoryRead,
    reads: x.reads.slice(readAt),
    elapsedMs: performance.now() - start,
    usage: run.usage,
    calls,
    trace: x.h.store.traces(run.id),
    ...(oracle ? { recall: sourceRecall(oracle.expected, selected) } : {}),
  };
  results.push(row);
  persist();
  return row;
}
let busy = false;
let batchState: {
  status: string;
  completed: number;
  total: number;
  error?: string;
} = {
  status: "idle",
  completed: results.filter((r) => r.phase === "batch").length,
  total: 90,
};
async function batch() {
  if (busy) throw Error("comparison_busy");
  busy = true;
  batchState.status = "running";
  try {
    for (const q of fixture.queries) {
      if (results.some((r) => r.phase === "batch" && r.queryId === q.id))
        throw Error("comparison_batch_already_sampled");
      await Promise.all(STRATEGIES.map((s) => ask(s, q.query, "batch", q.id)));
      batchState.completed += 3;
      console.log(`batch ${q.id} ${batchState.completed}/90`);
    }
    batchState.status = "completed";
  } catch (error) {
    batchState.status = "failed";
    batchState.error = error instanceof Error ? error.message : "error";
  } finally {
    busy = false;
    writePrivateJson(join(out, "batch-status.json"), batchState);
  }
}
const app = Fastify();
app.get("/", async (_req, reply) =>
  reply
    .type("text/html")
    .send(
      readFileSync(
        new URL("./memory-strategy-lab.html", import.meta.url),
        "utf8",
      ),
    ),
);
app.get("/experiment/state", async () => ({
  batch: batchState,
  busy,
  strategies: STRATEGIES.map((id) => ({ id, label: labels[id] })),
  manifest,
  modelLoadMs,
  indexReady: ready.n,
  results: results.map(({ calls: _calls, trace: _trace, ...r }) => r),
  demo: fixture.browserDemoIds.map((id) => {
    const q = fixture.queries.find((q) => q.id === id)!;
    return { id: q.id, query: q.query };
  }),
  protocol: fixture.protocol,
}));
app.post("/experiment/batch", async (_req, reply) => {
  if (busy) return reply.code(409).send({ error: "busy" });
  void batch();
  return { started: true };
});
const requests = new Map<string, Promise<unknown>>();
app.post("/experiment/ask", async (req, reply) => {
  const p = z
    .object({
      question: z.string().min(1).max(200),
      requestId: z.string().min(1).max(100),
    })
    .strict()
    .parse(req.body);
  if (requests.has(p.requestId)) return requests.get(p.requestId);
  if (busy) return reply.code(409).send({ error: "busy" });
  busy = true;
  const task = Promise.all(
    STRATEGIES.map((s) => ask(s, p.question, "browser")),
  ).finally(() => {
    busy = false;
  });
  requests.set(p.requestId, task);
  return task;
});
const release = acquireInstance(join(out, "data"));
const address = await app.listen({ host: "127.0.0.1", port: 4324 });
writePrivateJson(join(out, "data/daemon.lock"), { pid: process.pid, address });
writePrivateJson(join(out, "status.json"), {
  pid: process.pid,
  address,
  formalSettingsChanged: false,
  vectorsOnlyInE5Clone: true,
  indexReady: ready.n,
  modelLoadMs,
});
console.log(`真实三组隔离实验已启动 ${address}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await Promise.allSettled([...instances.values()].map((x) => x.h.close()));
  release();
}
process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
process.once("SIGINT", () => void stop().then(() => process.exit(0)));
