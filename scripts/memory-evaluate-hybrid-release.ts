import { mkdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { Harness } from "../src/harness.js";
import { Store } from "../src/store.js";
import { ProviderModel, type ModelRequest } from "../src/model.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { writePrivateJson } from "../src/files.js";
import {
  comparisonWireRequest,
  actualDelivery,
  sourceRecall,
} from "./lib/memory-strategy-comparison.js";

const out = resolve(
  process.env.MEMORY_EVAL_OUT ?? "test-results/memory-hybrid-release/hybrid-v2",
);
mkdirSync(out, { recursive: true, mode: 0o700 });
const original = resolve("test-results/memory-strategy-comparison-v1");
const raw = readFileSync(
  "tests/fixtures/memory-strategy-comparison-v1.json",
  "utf8",
);
const fixture = JSON.parse(raw);
const manifest = JSON.parse(
  readFileSync(join(original, "seed-manifest.json"), "utf8"),
);
writePrivateJson(join(out, "frozen-plan.json"), {
  fixtureHash: createHash("sha256").update(raw).digest("hex"),
  queries: fixture.queries,
  sameAuthor: true,
  noHistory: true,
  top5: true,
  deadlineUnchanged: true,
});
const dir = mkdtempSync(join(tmpdir(), "memory-hybrid-release-"));
const src = new Database(join(original, "data/master/companion.sqlite"), {
  readonly: true,
});
await src.backup(join(dir, "companion.sqlite"));
src.close();
const config = loadConfig({
  dataDir: dir,
  modelMode: "deepseek",
  memoryV2: true,
  memoryVectors: true,
  memorySummaries: false,
  memoryAnswerReasoning: true,
  memoryReplyGuard: true,
  trafficOrigin: "synthetic",
  maxOutputTokens: 1500,
});
const store = new Store(dir, LOCAL_SCOPE);
const byStatus = store.byStatus.bind(store),
  contextMemories = store.contextMemories.bind(store);
store.contextMemories = () =>
  contextMemories().filter((m) => m.kind !== "episode");
store.byStatus = ((table, statuses) =>
  table === "conversation_summaries"
    ? []
    : byStatus(table, statuses)) as typeof store.byStatus;
const provider = new ProviderModel(config, () => store.settings().model);
const calls: Record<string, unknown>[] = [];
const h = new Harness(
  store,
  {
    name: provider.name,
    async *stream(r: ModelRequest) {
      const actual = r.purpose === "judge" ? r : comparisonWireRequest(r);
      const { signal: _signal, ...safe } = actual;
      const call = { request: safe, text: "" };
      calls.push(call);
      for await (const e of provider.stream(actual)) {
        if (e.type === "text") call.text += e.text;
        yield e;
      }
    },
  },
  config,
);
const rows: Record<string, unknown>[] = [];
try {
  const coldStart = performance.now();
  h.memory.embedding!.warm();
  while (!h.memory.embedding!.ready && performance.now() - coldStart < 30000)
    await new Promise((r) => setTimeout(r, 50));
  if (!h.memory.embedding!.ready) throw Error("not_ready");
  while (await h.memory.indexOne(new AbortController().signal, Date.now())) {}
  await h.memory.prewarm(Date.now());
  const rawReads = [];
  // Concurrent old-strategy context preparation reproduces the comparison's
  // front-end shape. No expected values influence the retrieval itself.
  const allRead = (await import("../src/memory/reading.js")).readFacts;
  for (let round = 0; round < 3; round++)
    for (const q of fixture.queries) {
      const start = performance.now();
      const pending = h.memory.facts(q.query, Date.now());
      allRead(store, q.query, Date.now(), Infinity, 12000, undefined, true);
      allRead(store, q.query, Date.now(), Infinity, 2000);
      const r = await pending;
      const selected = r.selected.map((m) => manifest.aliases[m.id]);
      rawReads.push({
        round,
        id: q.id,
        ms: performance.now() - start,
        mode: r.mode,
        reasons: r.reasons,
        selected,
        sourceRecall: sourceRecall(q.expected, selected),
      });
    }
  writePrivateJson(join(out, "retrieval.json"), rawReads);
  for (const q of fixture.queries) {
    const first = calls.length;
    const r = h.submit(q.query, randomUUID());
    await h.waitForIdle(70000);
    const run = store.require("runs", r.runId);
    const chat = calls
      .slice(first)
      .find((c) => (c.request as ModelRequest).purpose === "chat");
    const actual = actualDelivery(chat!.request as ModelRequest);
    const selected = actual.memories.map((m) => manifest.aliases[m.id]);
    rows.push({
      id: q.id,
      query: q.query,
      expected: q.expected,
      requiredMeaning: q.requiredMeaning,
      unknownParts: q.unknownParts,
      run,
      answer: store
        .all("messages")
        .filter((m) => m.role === "assistant" && m.runId === r.runId)
        .map((m) => m.content)
        .join("\n"),
      selected,
      sourceRecall: sourceRecall(q.expected, selected),
      calls: calls.slice(first),
      traces: store.traces(r.runId),
    });
    writePrivateJson(join(out, "answers.json"), rows);
    console.log(q.id, run.status);
  }
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
}
