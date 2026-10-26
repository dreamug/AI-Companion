import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import {
  ProviderModel,
  parseJson,
  type ModelRequest,
  type ModelEvent,
} from "../src/model.js";
import { queueConversationSummary } from "../src/memory/conversations.js";
import { LOCAL_SCOPE } from "../src/domain.js";
const dir = mkdtempSync(join(tmpdir(), "memory-continuity-")),
  out = resolve("test-results/memory-continuity-evaluation");
mkdirSync(out, { recursive: true });
const config = loadConfig({
  dataDir: dir,
  modelMode: "deepseek",
  memoryV2: true,
  memoryVectors: false,
  memorySummaries: false,
  trafficOrigin: "synthetic",
  maxRunMs: 60000,
  maxOutputTokens: 600,
});
const store = new Store(dir, LOCAL_SCOPE),
  provider = new ProviderModel(config, () => config.model);
let live = false,
  time = Date.now();
const report: {
  syntheticOnly: boolean;
  controlledHistoricalChat: boolean;
  realSummarizationAndAnswers: boolean;
  provider: string;
  historicalMessages?: number;
  summaries?: unknown[];
  summaryJobs?: unknown[];
  answers: unknown[];
  error?: string;
} = {
  syntheticOnly: true,
  controlledHistoricalChat: true,
  realSummarizationAndAnswers: true,
  provider: config.model,
  answers: [],
};
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
const adapter = {
  name: "deepseek",
  async *stream(r: ModelRequest): AsyncGenerator<ModelEvent> {
    if (live || r.purpose !== "chat") {
      yield* provider.stream(r);
      return;
    }
    yield { type: "text", text: "这条合成交流已经收到。" };
    yield {
      type: "finish",
      reason: "stop",
      usage: {
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimated: true,
      },
    };
  },
};
const h = new Harness(store, adapter, config, { now: () => time });
store.saveSettings({
  ...store.settings(),
  autoExtract: false,
  remoteDisclosureAcknowledged: true,
  dailyTokenBudget: 2000000,
  persona: {
    ...store.settings().persona,
    style:
      store.settings().persona.style +
      '。本次合成记忆测试，只输出JSON {"answer":"简短回答，未知就说不知道","abstain":false}。需要历史决定时可使用search_memory的conversation目标；缺少所问属性应abstain=true。',
  },
});
async function turn(text: string) {
  const r = h.submit(text, crypto.randomUUID());
  await h.waitForIdle(70000);
  const a = store
    .all("messages")
    .find((m) => m.runId === r.runId && m.role === "assistant");
  if (a) h.displayed(a.id, a.content.length);
  return { r, a };
}
try {
  for (let i = 1; i <= 100; i++) {
    await turn(
      i === 15
        ? "项目青岚的最初决定：包装代号使用白榆。这是我们这次讨论的设计决定。"
        : i === 60
          ? "更正项目青岚的设计决定：包装代号现在改为榕青，之前的白榆方案作废。"
          : "合成闲聊第" + i + "轮：今天聊些普通天气和日常，没有新的决定。",
    );
    time += 1000;
    if (i % 12 === 0) {
      await h.tick();
      await h.waitForIdle(70000);
    }
  }
  for (let i = 0; i < 30; i++) {
    queueConversationSummary(store, time);
    if (
      !store
        .byStatus("jobs", ["pending"])
        .some((j) => j.kind === "segment_summary")
    )
      break;
    await h.tick();
    await h.waitForIdle(70000);
  }
  report.historicalMessages = store.all("messages").length;
  report.summaryJobs = store
    .all("jobs")
    .filter((j) => j.kind === "segment_summary")
    .map((j) => ({
      id: j.id,
      status: j.status,
      reason: j.reason,
      attempts: j.attempts,
    }));
  report.summaries = store.all("conversation_summaries").map((s) => ({
    id: s.id,
    text: s.text,
    status: s.status,
    coverage: s.coverage,
  }));
  persist();
  live = true;
  for (const c of [
    {
      id: "original",
      query: "项目青岚的包装代号最初决定用什么？",
      expected: "白榆",
    },
    {
      id: "current",
      query: "项目青岚的包装代号现在决定用什么？",
      expected: "榕青",
    },
    {
      id: "unknown",
      query: "项目青岚包装的具体潘通色号是多少？",
      expected: undefined,
    },
  ]) {
    const { r, a } = await turn(c.query);
    let answer: { answer?: string; abstain?: boolean } = {};
    try {
      answer = parseJson(a?.content ?? "") as typeof answer;
    } catch {}
    const tools = store.db
      .prepare(
        "SELECT call_id,result FROM tool_results WHERE owner=? AND relationship=? AND run_id=?",
      )
      .all(store.scope.ownerUserId, store.scope.relationshipId, r.runId);
    const pass = c.expected
      ? answer.abstain === false && Boolean(answer.answer?.includes(c.expected))
      : answer.abstain === true;
    report.answers.push({
      ...c,
      answer,
      pass,
      raw: a?.content,
      status: store.require("runs", r.runId).status,
      tools,
      context: (h.context(r.runId) as { meta: unknown }).meta,
    });
    persist();
    console.log(`${c.id}: ${pass ? "pass" : "review"}`);
  }
} catch (e) {
  report.error = e instanceof Error ? e.message : "failed";
  process.exitCode = 1;
} finally {
  persist();
  await h.close();
  rmSync(dir, { recursive: true, force: true });
}
