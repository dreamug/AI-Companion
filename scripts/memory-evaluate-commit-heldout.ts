import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel, type ModelRequest } from "../src/model.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { acquireEmbedding } from "../src/memory/embedding.js";
import { writePrivateJson } from "../src/files.js";

const root = resolve("test-results/memory-commit-release");
const out = resolve(process.env.MEMORY_EVAL_OUT ?? join(root, "heldout-v1"));
if (existsSync(join(out, "results.json")))
  throw Error("refusing_to_overwrite_heldout_run");
mkdirSync(out, { recursive: true, mode: 0o700 });
const frozen = JSON.parse(
  readFileSync(
    process.env.MEMORY_EVAL_FREEZE ??
      "tests/fixtures/memory-commit-acceptance-freeze-v1.json",
    "utf8",
  ),
);
const raw = readFileSync(frozen.fixture, "utf8");
const hash = createHash("sha256").update(raw).digest("hex");
if (hash !== frozen.sha256) throw Error("heldout_fixture_changed");
const fixture = JSON.parse(raw) as {
  cases: { id: string; facts: string[]; input: string; acceptance: string }[];
};
writePrivateJson(join(out, "run-manifest.json"), {
  fixtureHash: hash,
  startedAt: new Date().toISOString(),
  sameAuthorSynthetic: true,
  concurrency: Math.min(
    2,
    Math.max(1, Number(process.env.MEMORY_EVAL_CONCURRENCY ?? 1)),
  ),
  protocol: frozen.protocol,
  sourceHashes: Object.fromEntries(
    [
      "src/memory/candidates.ts",
      "src/memory/capture.ts",
      "src/memory/read-scope.ts",
      "src/memory/operations.ts",
      "src/memory/reply-contract.ts",
      "src/context.ts",
      "src/harness.ts",
    ].map((p) => [
      p,
      createHash("sha256").update(readFileSync(p)).digest("hex"),
    ]),
  ),
});
const concurrency = Math.min(
  2,
  Math.max(1, Number(process.env.MEMORY_EVAL_CONCURRENCY ?? 1)),
);
const order = new Map(fixture.cases.map((c, i) => [c.id, i]));
const owner = acquireEmbedding();
owner.warm();
const cold = Date.now();
while (!owner.ready && Date.now() - cold < 30000)
  await new Promise((r) => setTimeout(r, 50));
if (!owner.ready) {
  owner.close();
  throw Error("e5_not_ready");
}
const report: { rows: Record<string, unknown>[] } = { rows: [] };
async function evaluateCase(c: (typeof fixture.cases)[number]) {
  const dir = mkdtempSync(join(tmpdir(), "memory-commit-heldout-"));
  const config = loadConfig({
    dataDir: dir,
    modelMode: "deepseek",
    memoryV2: true,
    memoryVectors: true,
    memorySummaries: false,
    memoryAnswerReasoning: true,
    memoryReplyGuard: true,
    trafficOrigin: "synthetic",
  });
  const store = new Store(dir, LOCAL_SCOPE);
  store.saveSettings({
    ...store.settings(),
    autoExtract: false,
    proactiveEnabled: false,
    remoteDisclosureAcknowledged: true,
    dailyTokenBudget: 2000000,
  });
  const provider = new ProviderModel(config, () => store.settings().model);
  const calls: Record<string, unknown>[] = [];
  const h = new Harness(
    store,
    {
      name: provider.name,
      async *stream(request: ModelRequest) {
        const { signal: _signal, ...safe } = request;
        const call: Record<string, unknown> = { request: safe, text: "" };
        calls.push(call);
        try {
          for await (const e of provider.stream(request)) {
            if (e.type === "text") call.text = String(call.text) + e.text;
            if (e.type === "finish") call.finish = e;
            yield e;
          }
        } catch (e) {
          call.error = e instanceof Error ? e.message : "error";
          throw e;
        }
      },
    },
    config,
  );
  try {
    for (const fact of c.facts)
      h.addMemory({ text: fact, realityScope: "reality" });
    while (await h.memory.indexOne(new AbortController().signal, Date.now())) {}
    await h.memory.prewarm(Date.now());
    const before = store.all("memories");
    const run = h.submit(c.input, randomUUID());
    await h.waitForIdle(70000);
    const result = store.require("runs", run.runId);
    const firstChat = calls.find(
      (c) => (c.request as ModelRequest).purpose === "chat",
    )!;
    const req = firstChat.request as ModelRequest;
    if (req.messages.length !== 2) throw Error("heldout_history_leak");
    const state = JSON.parse(req.messages[0]!.content.split("\n")[1]!);
    if (
      state.conversationSummaries?.length ||
      state.memories.some((m: { kind: string }) => m.kind === "episode")
    )
      throw Error("heldout_summary_leak");
    // Foreground replies cannot mutate or confirm any original fact, regardless
    // of what the model says. Later extraction may add pending candidates only.
    const afterReply = store.all("memories");
    const unchanged = before.every(
      (m) => JSON.stringify(store.get("memories", m.id)) === JSON.stringify(m),
    );
    const addedConfirmed = afterReply.filter(
      (m) => m.certainty === "confirmed" && !before.some((b) => b.id === m.id),
    );
    const answer = store
      .all("messages")
      .filter((m) => m.runId === run.runId && m.role === "assistant")
      .map((m) => m.content)
      .join("\n");
    const foregroundCalls = [...calls];
    const pendingJobs = store.all("jobs");
    // Exercise registration->pending extraction for explicit save requests.
    if (pendingJobs.some((j) => j.explicitMemoryRequest)) {
      await h.tick();
      await h.waitForIdle(40000);
    }
    const row = {
      test: c,
      run: result,
      answer,
      answerHash: createHash("sha256").update(answer).digest("hex"),
      calls,
      foregroundCallCount: foregroundCalls.length,
      stateProof: {
        firstMessages: req.messages.length,
        historyVisible: false,
        summaryVisible: false,
        delivered: state.memories,
        memoryOperations: state.memoryOperations,
        memoryRead: state.memoryRead,
      },
      before,
      afterReply,
      afterExtraction: store.all("memories"),
      pendingJobs,
      jobs: store.all("jobs"),
      trace: store.traces(run.runId),
      invariants: {
        originalFactsUnchanged: unchanged,
        noNewConfirmedFacts: addedConfirmed.length === 0,
      },
      context: h.context(run.runId),
    };
    report.rows.push(row);
    report.rows.sort(
      (a, b) =>
        order.get((a.test as { id: string }).id)! -
        order.get((b.test as { id: string }).id)!,
    );
    writePrivateJson(join(out, "results.json"), report);
    console.log(
      c.id,
      result.status,
      unchanged && addedConfirmed.length === 0 ? "db-ok" : "DB-FAIL",
    );
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
let next = 0;
try {
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < fixture.cases.length) {
        const c = fixture.cases[next++]!;
        await evaluateCase(c);
      }
    }),
  );
} finally {
  owner.close();
}

// Sampling completion is not acceptance: a missing answer or broken database
// invariant must also fail the command. Semantic correctness still needs the
// frozen-requirement audit; it is never inferred from this exit status alone.
if (
  report.rows.some(
    (row) =>
      (row.run as { status: string }).status !== "completed" ||
      Object.values(row.invariants as Record<string, boolean>).some((v) => !v),
  )
)
  process.exitCode = 1;
