import {
  parseMemoryReplyAssessment,
  memoryReplyReview,
} from "../src/memory/reply-contract.js";
import { afterEach, expect, it } from "vitest";
import {
  setup,
  ScriptedModel,
  response,
  deferred,
  until,
  finish,
} from "./helpers.js";
import type { ModelRequest } from "../src/model.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
function make(
  script: ConstructorParameters<typeof ScriptedModel>[0],
  focus: "facts" | "operations" = "operations",
) {
  const x = setup({
    model: new ScriptedModel(async function* (request, index) {
      const data =
        request.purpose === "judge"
          ? JSON.parse(request.messages[0]!.content)
          : {};
      if (data.contractPart && data.contractPart !== focus)
        yield* response(JSON.stringify({ checks: [] }));
      else yield* script(request, index);
    }),
    config: {
      memoryV2: true,
      memorySummaries: false,
      memoryReplyGuard: true,
      maxRunMs: 5000,
    },
  });
  cleanup.push(x.dispose);
  x.store.saveSettings({ ...x.store.settings(), autoExtract: false });
  return x;
}
const raw = "需要我把这条偏好保存下来吗？";
const accepted = "徒步挺适合慢慢观察沿途的小变化，你喜欢山间还是河边？";
const ok = () => JSON.stringify({ checks: [] });
const bad = () =>
  JSON.stringify({
    checks: [
      {
        quote: raw,
        scope: "save_workflow",
        reason: "再次征求保存意愿",
        violation: "repeated_save_consent",
      },
    ],
  });
const body = (x: ReturnType<typeof make>, id: string) =>
  x.store
    .all("messages")
    .filter((m) => m.role === "assistant" && m.runId === id)
    .map((m) => m.content)
    .join("");

it("校验前草稿不可见；只做一次完整重生成，采用新正文且不重放工具", async () => {
  const gate = deferred();
  const requests: ModelRequest[] = [];
  let chats = 0,
    reviews = 0;
  const x = make(async function* (r) {
    requests.push(r);
    if (r.purpose === "judge") {
      if (++reviews === 1) {
        await gate.promise;
        yield* response(bad());
      } else yield* response(ok());
    } else yield* response(++chats === 1 ? raw : accepted);
  });
  const run = x.h.submit("请记住，我喜欢徒步。", "guard-repair");
  await until(() => reviews === 1);
  expect(body(x, run.runId)).toBe("");
  const assessment = JSON.parse(requests[1]!.messages[0]!.content);
  expect(assessment).toMatchObject({
    userInput: "请记住，我喜欢徒步。",
    draft: raw,
    saveIntent: true,
  });
  gate.resolve();
  await x.h.waitForIdle();
  expect(requests.map((r) => r.purpose)).toEqual([
    "chat",
    "judge",
    "chat",
    "judge",
  ]);
  expect(requests[2]!.tools).toEqual([]);
  expect(JSON.parse(requests[2]!.messages.at(-1)!.content)).toMatchObject({
    kind: "unpublished_reply_for_rewrite",
    draft: raw,
  });
  expect(body(x, run.runId)).toBe(accepted);
  expect(x.store.require("runs", run.runId)).toMatchObject({
    status: "completed",
    steps: 6,
    usage: { calls: 6 },
  });
  const context = x.h.context(run.runId) as {
    system: string;
    messages: unknown[];
  };
  expect(context.system).toBe(requests[2]!.system);
  expect(context.messages).toEqual(requests[2]!.messages);
  expect(x.store.usageRecords().every((r) => r.data.state === "finished")).toBe(
    true,
  );
});

it("重生成仍不合格则有限失败，不能固定回复或反复重抽直到通过", async () => {
  const requests: ModelRequest[] = [];
  const x = make(async function* (r) {
    requests.push(r);
    yield* response(r.purpose === "judge" ? bad() : raw);
  });
  const run = x.h.submit("请保存，我喜欢观鸟。", "guard-fail");
  await x.h.waitForIdle();
  expect(requests).toHaveLength(4);
  expect(body(x, run.runId)).toBe("");
  expect(x.store.require("runs", run.runId)).toMatchObject({
    status: "failed",
    reason: "memory_reply_contract_failed",
  });
  expect(x.store.all("jobs")).toHaveLength(1);
});

it.each([
  "not json",
  '{"violations":["unknown"]}',
  '{"violations":[],"approved":true}',
])("无效校验结果不能默认为通过：%s", async (verdict) => {
  const requests: ModelRequest[] = [];
  const x = make(async function* (r) {
    requests.push(r);
    yield* response(r.purpose === "judge" ? verdict : raw);
  });
  const run = x.h.submit("请记住，我喜欢皮划艇。", crypto.randomUUID());
  await x.h.waitForIdle();
  expect(x.store.require("runs", run.runId).status).toBe("failed");
  expect(body(x, run.runId)).toBe("");
  expect(requests).toHaveLength(2);
});

it("校验期间取消，迟到通过也不能发布草稿或重生成", async () => {
  const gate = deferred();
  let reviewing = false;
  const x = make(async function* (r) {
    if (r.purpose === "judge") {
      reviewing = true;
      await gate.promise;
      yield* response(ok());
    } else yield* response(raw);
  });
  const run = x.h.submit("请保存，我喜欢看云。", "guard-cancel");
  await until(() => reviewing);
  x.h.cancel(run.runId);
  gate.resolve();
  await x.h.waitForIdle();
  expect(x.store.require("runs", run.runId).status).toBe("cancelled");
  expect(body(x, run.runId)).toBe("");
  expect(
    x.store.usageRecords().some((r) => r.data.state === "failed_usage_unknown"),
  ).toBe(true);
});

it("已经执行工具的回合不自动重试，拒绝后不重复领域副作用", async () => {
  let chats = 0;
  const requests: ModelRequest[] = [];
  const x = make(async function* (r) {
    requests.push(r);
    if (r.purpose === "judge") yield* response(bad());
    else if (++chats === 1) {
      yield {
        type: "tool",
        call: { id: "read-once", name: "read_work_state", input: {} },
      };
      yield { ...finish, reason: "tool-calls" };
    } else yield* response(raw);
  });
  const run = x.h.submit(
    "请记住，我喜欢草坪。顺便看看当前状态。",
    "guard-tool",
  );
  await x.h.waitForIdle();
  expect(requests.map((r) => r.purpose)).toEqual(["chat", "chat", "judge"]);
  expect(x.store.toolResult(run.runId, "read-once")).toBeDefined();
  expect(x.store.require("runs", run.runId).reason).toBe(
    "memory_reply_contract_failed",
  );
  expect(body(x, run.runId)).toBe("");
});

it("空白记忆普通聊天也检查承诺，显式开关按Run固定", async () => {
  const requests: ModelRequest[] = [];
  const x = make(async function* (r) {
    requests.push(r);
    yield* response(r.purpose === "judge" ? ok() : accepted);
  });
  x.h.submit("今天聊聊河边吧", "guard-not-requested");
  await x.h.waitForIdle();
  expect(requests).toHaveLength(2);
  const run = x.h.submit("请记住，我喜欢河边徒步。", "guard-snapshot");
  x.config.memoryReplyGuard = false;
  await x.h.waitForIdle();
  expect(x.store.require("runs", run.runId).config.memoryReplyGuard).toBe(true);
  expect(requests.map((r) => r.purpose)).toEqual([
    "chat",
    "judge",
    "chat",
    "judge",
  ]);
});

it("校验调用也要先过预算，预算不足时不外发草稿", async () => {
  const requests: ModelRequest[] = [];
  let x: ReturnType<typeof make>;
  x = make(async function* (r) {
    requests.push(r);
    x.store.saveSettings({ ...x.store.settings(), dailyTokenBudget: 1000 });
    yield { type: "text", text: accepted };
    yield {
      ...finish,
      usage: {
        calls: 1,
        inputTokens: 600,
        outputTokens: 300,
        totalTokens: 900,
        estimated: false,
      },
    };
  });
  const run = x.h.submit("请记住，我喜欢山地徒步。", "guard-budget");
  await x.h.waitForIdle();
  expect(requests).toHaveLength(1);
  expect(x.store.require("runs", run.runId).reason).toBe("budget_exceeded");
  expect(body(x, run.runId)).toBe("");
});
it("六次请求上限包括校验，不能在循环末尾偷偷追加第七次调用", async () => {
  const requests: ModelRequest[] = [];
  let chats = 0;
  const x = make(async function* (r) {
    requests.push(r);
    if (++chats <= 5) {
      yield {
        type: "tool",
        call: { id: `read-${chats}`, name: "read_work_state", input: {} },
      };
      yield { ...finish, reason: "tool-calls" };
    } else yield* response(accepted);
  });
  const run = x.h.submit("请记住，我喜欢江边散步。", "guard-hard-cap");
  await x.h.waitForIdle();
  expect(requests).toHaveLength(6);
  expect(x.store.require("runs", run.runId)).toMatchObject({
    status: "failed",
    reason: "step_budget_exceeded",
    steps: 6,
  });
  expect(body(x, run.runId)).toBe("");
});

it("完整读取也检查已知约束，冲突草稿只重写一次且保留原始依据和条件", async () => {
  const requests: ModelRequest[] = [];
  let chats = 0,
    reviews = 0;
  const x = make(async function* (r) {
    requests.push(r);
    if (r.purpose === "judge")
      yield* response(
        JSON.stringify({
          checks:
            ++reviews === 1
              ? [
                  {
                    quote: "你预算不超过两百，买二百五的也可以。",
                    scope: "constraint",
                    reason: "超出明确上限",
                    violation: "memory_constraint_conflict",
                  },
                ]
              : [],
        }),
      );
    else
      yield* response(
        ++chats === 1
          ? "你预算不超过两百，买二百五的也可以。"
          : "按你的两百元上限来选。",
      );
  }, "facts");
  const m = x.h.addMemory({ text: "用户购买台灯的预算不超过200元" });
  const run = x.h.submit("帮我挑个台灯", "constraint-repair");
  await x.h.waitForIdle();
  const payload = JSON.parse(requests[1]!.messages[0]!.content);
  expect(payload.memoryReadData.reads[0].status).toBe("complete");
  expect(payload.memoryReadData.evidence).toContainEqual({
    id: m.id,
    text: m.text,
  });
  expect(payload.saveIntent).toBe(false);
  expect(payload).not.toHaveProperty("expected");
  expect(requests.map((r) => r.purpose)).toEqual([
    "chat",
    "judge",
    "chat",
    "judge",
  ]);
  expect(body(x, run.runId)).toBe("按你的两百元上限来选。");
  expect(x.store.all("memories")).toHaveLength(1);
});

it("合规知识范围表述原样发布，当前明确更新的偏好也传给评审", async () => {
  const text = "我目前知道你周日去游泳；你用什么泳镜，这一轮依据不足。";
  const requests: ModelRequest[] = [];
  const x = make(async function* (r) {
    requests.push(r);
    yield* response(r.purpose === "judge" ? ok() : text);
  });
  x.h.addMemory({ text: "用户周日游泳" });
  const run = x.h.submit(
    "我现在改成周六了。之前的泳镜你记得么？",
    "constraint-update",
  );
  await x.h.waitForIdle();
  expect(body(x, run.runId)).toBe(text);
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[1]!.messages[0]!.content).userInput).toContain(
    "我现在改成周六了",
  );
});

it.each([
  [
    "Asia/Shanghai",
    "2026-10-24T16:32:00Z",
    "2026-10-25 00:32:00",
    "2026-10-25T00:32:00+08:00",
    0,
  ],
  [
    "America/New_York",
    "2026-11-01T06:30:00Z",
    "2026-11-01 01:30:00",
    "2026-11-01T01:30:00-05:00",
    1,
  ],
])(
  "阅读状态直接交付 %s 当地时间，避免把 UTC 时段当用户时段",
  async (timezone, utc, local, offsetTime, localHour) => {
    const requests: ModelRequest[] = [];
    const x = make(async function* (r) {
      requests.push(r);
      yield* response(r.purpose === "judge" ? ok() : "按你的偏好安排。");
    });
    x.clock.time = Date.parse(utc);
    x.store.saveSettings({ ...x.store.settings(), timezone });
    x.h.addMemory({ text: "用户下午只听纯音乐" });
    x.h.submit("我下午一般听什么？", crypto.randomUUID());
    await x.h.waitForIdle();
    const state = JSON.parse(requests[0]!.messages[0]!.content.split("\n")[1]!);
    expect(state).toMatchObject({
      currentTime: offsetTime,
      localHour,
      localTime: local,
      timezone,
    });
  },
);

it("结构化评审必须引用真实草稿；按检查项汇总，不能凭空指认或只给旧式结论", () => {
  const draft = "本轮依据不足。";
  expect(
    parseMemoryReplyAssessment(
      {
        checks: [
          {
            quote: draft,
            scope: "knowledge",
            reason: "描述知识范围",
            violation: null,
          },
        ],
      },
      draft,
    ).violations,
  ).toEqual([]);
  expect(() =>
    parseMemoryReplyAssessment(
      {
        checks: [
          {
            quote: "存储没有记录",
            scope: "storage_history",
            reason: "伪造引文",
            violation: "unsupported_memory_absence",
          },
        ],
      },
      draft,
    ),
  ).toThrow("invalid_memory_review_quote");
  expect(() => parseMemoryReplyAssessment({ violations: [] }, draft)).toThrow();
});

it("评审引文允许 Markdown 渲染差异，但数字、否定及措辞变化仍拒绝", () => {
  const draft = "只选择 **350元以内** 的。";
  const assessment = (quote: string) => ({
    checks: [
      { quote, scope: "constraint", reason: "检查上限", violation: null },
    ],
  });
  expect(
    parseMemoryReplyAssessment(assessment("只选择 350元以内 的。"), draft)
      .violations,
  ).toEqual([]);
  for (const quote of [
    "只选择 450元以内 的。",
    "不选择 350元以内 的。",
    "只选择350元以内的。",
  ])
    expect(() => parseMemoryReplyAssessment(assessment(quote), draft)).toThrow(
      "invalid_memory_review_quote",
    );
});

it("程序仅按保存意愿选择重复征求规则，所有回合均可判无依据承诺", () => {
  expect(memoryReplyReview(false)).toContain("unconfirmed_commit");
  expect(memoryReplyReview(true)).toContain("unconfirmed_commit");
  const draft = "我会记住。";
  const value = {
    checks: [
      {
        quote: draft,
        scope: "save_workflow",
        reason: "未来记忆承诺",
        violation: "unconfirmed_commit",
      },
    ],
  };
  expect(parseMemoryReplyAssessment(value, draft, false).violations).toEqual([
    "unconfirmed_commit",
  ]);
  expect(parseMemoryReplyAssessment(value, draft, true).violations).toEqual([
    "unconfirmed_commit",
  ]);
  const repeated = {
    checks: [
      {
        quote: draft,
        scope: "save_workflow",
        reason: "重复征求保存",
        violation: "repeated_save_consent",
      },
    ],
  };
  expect(() => parseMemoryReplyAssessment(repeated, draft, false)).toThrow(
    "memory_review_scope_mismatch",
  );
});

it("fast-path operations require user evidence for upgrades and reject missing or invented authorization", () => {
  const assessment = {
    checks: [],
    requiredAction: "sync_write",
    userEvidence: "以后叫我",
  };
  expect(
    parseMemoryReplyAssessment(
      assessment,
      "好。",
      false,
      "operations",
      "以后叫我青禾。",
    ).requiredAction,
  ).toBe("sync_write");
  expect(() =>
    parseMemoryReplyAssessment(
      assessment,
      "好。",
      false,
      "operations",
      "今天有风。",
    ),
  ).toThrow("invalid_memory_action_evidence");
  expect(() =>
    parseMemoryReplyAssessment(
      { checks: [] },
      "好。",
      false,
      "operations",
      "今天有风。",
    ),
  ).toThrow();
});
