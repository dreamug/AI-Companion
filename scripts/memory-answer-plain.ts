import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { deliveredFixtureFacts } from "./lib/memory-delivery.js";
import { textHash } from "../src/memory/evidence.js";
import type { TurnMessage } from "../src/model.js";

// Capture ordinary product replies: no JSON persona, no vectors, no prior answers.
// Human semantic review is recorded separately; this is not an automatic score.
const dir = mkdtempSync(join(tmpdir(), "memory-plain-answer-")),
  out = resolve(
    process.env.MEMORY_EVAL_OUT ?? "test-results/memory-answer-plain",
  ),
  config = loadConfig({
    dataDir: dir,
    modelMode: "deepseek",
    memoryV2: true,
    memoryVectors: false,
    memoryAnswerReasoning: process.argv.includes("--grounded-reasoning"),
    memorySummaries: false,
    trafficOrigin: "synthetic",
    maxRunMs: 60000,
    maxOutputTokens: 600,
  }),
  store = new Store(dir, LOCAL_SCOPE),
  h = new Harness(store, new ProviderModel(config, () => config.model), config);
mkdirSync(out, { recursive: true });
store.saveSettings({
  ...store.settings(),
  autoExtract: false,
  remoteDisclosureAcknowledged: true,
  dailyTokenBudget: 1000000,
});
const fixtureOption = process.argv.indexOf("--fixture");
const fixtureRaw =
  fixtureOption >= 0
    ? readFileSync(resolve(process.argv[fixtureOption + 1]!), "utf8")
    : undefined;
const fixture = fixtureRaw
  ? (JSON.parse(fixtureRaw) as {
      facts: { id: string; text: string; bot: string; status: string }[];
      queries: {
        id: string;
        query: string;
        expected: string[];
        answer: string | null;
      }[];
    })
  : undefined;
const defaultFacts = fixture
  ? []
  : [
      h.addMemory({
        text: "用户现在的职业是弦乐器修复师，在乐器工坊修复小提琴。",
        realityScope: "reality",
      }),
      h.addMemory({
        text: "用户的姐姐是一名海洋地质研究员。",
        realityScope: "reality",
      }),
    ];
const facts = fixture
  ? fixture.facts
      .filter((f) => f.bot === "a" && f.status === "active")
      .map((f) => h.addMemory({ text: f.text, realityScope: "reality" }))
  : defaultFacts;
const report: {
  syntheticOnly: boolean;
  vectorsEnabled: boolean;
  automaticScore: false;
  answerProfile: string;
  fixtureHash?: string;
  model: string;
  facts: typeof facts;
  rows: unknown[];
  error?: string;
} = {
  syntheticOnly: true,
  vectorsEnabled: false,
  automaticScore: false,
  answerProfile: config.memoryAnswerReasoning ? "grounded-low-v1" : "fast",
  fixtureHash: fixtureRaw ? textHash(fixtureRaw) : undefined,
  model: config.model,
  facts,
  rows: [],
};
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
try {
  const queries = fixture
    ? fixture.queries.map((q) => [q.id, q.query])
    : [
        ["daily-role", "我现在的工作岗位是什么？"],
        ["formal-title", "我合同中职位名称的完整官方写法是什么？"],
        ["partial-known", "我做什么工作？工号又是多少？"],
        ["sister", "我姐姐的职业是什么？"],
        ["distinct-subjects", "我姐姐是海洋地质研究员，我也做这个吗？"],
        ["unknown-grade", "我的正式职级是多少？"],
      ];
  for (const [id, query] of queries) {
    for (const m of store.all("messages"))
      if (!m.deleted) store.put("messages", { ...m, deleted: true });
    const start = performance.now();
    const run = h.submit(query!, crypto.randomUUID());
    await h.waitForIdle(70000);
    const result = store.require("runs", run.runId),
      message = store
        .all("messages")
        .find((m) => m.runId === run.runId && m.role === "assistant");
    const context = h.context(run.runId) as {
      system: string;
      messages: TurnMessage[];
      meta: unknown;
    };
    report.rows.push({
      id,
      query,
      status: result.status,
      answer: message?.content,
      context: context.meta,
      delivery: fixture
        ? deliveredFixtureFacts(
            context.messages,
            fixture.facts
              .filter((f) => f.bot === "a" && f.status === "active")
              .map((f, i) => ({
                actualId: facts[i]!.id,
                id: f.id,
                text: f.text,
              })),
          )
        : undefined,
      systemHash: textHash(context.system),
      elapsedMs: performance.now() - start,
    });
    persist();
    if (result.status !== "completed" || !message)
      throw Error("plain_reply_not_completed");
    h.displayed(message.id, message.content.length);
  }
} catch (e) {
  report.error = e instanceof Error ? e.message : "plain_reply_failed";
  process.exitCode = 1;
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
  persist();
}
