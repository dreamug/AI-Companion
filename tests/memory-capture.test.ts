import { afterEach, expect, it } from "vitest";
import {
  setup,
  ScriptedModel,
  response,
  finish,
  deferred,
  until,
} from "./helpers.js";
import { currentCandidateOffer } from "../src/memory/candidates.js";
import { readFacts } from "../src/memory/reading.js";
import type { ModelRequest } from "../src/model.js";
import type { AppConfig } from "../src/config.js";

type Assertion = {
  text: string;
  retention?: "durable" | "transient" | "uncertain";
  subject?: string;
  category?: "fact" | "preference" | "interpretation";
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
function make(
  assertions: Assertion[],
  options: { fakeTools?: boolean; config?: Partial<AppConfig> } = {},
) {
  const requests: ModelRequest[] = [];
  const model = new ScriptedModel(async function* (request) {
    requests.push(request);
    if (request.purpose === "extract") {
      const payload = JSON.parse(request.messages[0]!.content);
      const sources = Array.isArray(payload) ? payload : payload.userSources;
      yield* response(
        JSON.stringify({
          assertions: assertions.map((a) => ({
            category: "preference",
            certainty: "stated",
            ...a,
            sourceIds: [sources[0].id],
          })),
          openLoops: [],
        }),
      );
    } else if (
      options.fakeTools &&
      !request.messages.some((m) => m.role === "tool")
    ) {
      // A stale client/model can fabricate calls even when not declared.
      for (const [id, text] of [
        ["one", "用户喜欢观鸟。"],
        ["two", "观鸟是用户的爱好"],
      ])
        yield {
          type: "tool",
          call: {
            id: id!,
            name: "propose_memory",
            input: { text, category: "preference" },
          },
        };
      yield { ...finish, reason: "tool-calls" };
    } else yield* response("好的，聊聊这个。");
  });
  const x = setup({
    model,
    config: { memoryV2: true, memorySummaries: false, ...options.config },
  });
  cleanup.push(x.dispose);
  return { ...x, requests };
}
async function extract(
  x: ReturnType<typeof make>,
  input = "我周末经常去观鸟。",
) {
  const run = x.h.submit(input, crypto.randomUUID());
  await x.h.waitForIdle();
  x.clock.advance(2000);
  await x.h.tick();
  await x.h.waitForIdle();
  return run;
}

it("自动整理只有一个写入方：不同工具ID和改写都不能抢写候选，实际确认后可召回", async () => {
  const x = make([{ text: "用户的休闲爱好是观察鸟类", retention: "durable" }], {
    fakeTools: true,
  });
  const run = await extract(x);
  expect(
    x.requests
      .filter((r) => r.purpose === "chat")
      .every((r) => !r.tools?.some((t) => t.name === "propose_memory")),
  ).toBe(true);
  expect(x.store.toolResult(run.runId, "one")).toMatchObject({
    status: "background_only",
    confirmed: false,
  });
  expect(x.store.toolResult(run.runId, "two")).toMatchObject({
    status: "background_only",
  });
  const [memory] = x.store.byStatus("memories", ["pending"]);
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(1);
  expect(memory!.text).toBe("用户的休闲爱好是观察鸟类");
  expect(memory!.sources.map((s) => s.id)).toEqual([run.messageId]);
  const saved = x.h.reviseMemory(memory!.id, memory!.revision, {
    decision: "confirm",
  });
  expect(
    readFacts(x.store, "我有什么爱好", x.clock.now()).selected.map((m) => m.id),
  ).toContain(saved.id);
  expect(x.store.require("messages", run.messageId).content).toBe(
    "我周末经常去观鸟。",
  );
});

it.each([
  ["用户今晚仍在赶报告", "fact"],
  ["用户此刻只想闲聊", "preference"],
  ["用户刚走出车站", "fact"],
  ["用户这两天比较疲惫", "interpretation"],
] as const)("临时内容不进入候选或消耗确认额度：%s", async (text, category) => {
  const x = make([{ text, category, retention: "transient" }]);
  await extract(x, text);
  expect(x.store.byStatus("memories", ["pending", "active"])).toHaveLength(0);
  expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
  expect(x.store.settings().lastProactiveMemoryOfferDay).toBeUndefined();
  expect(x.store.all("jobs").every((j) => j.status === "completed")).toBe(true);
});

it.each([
  "用户最近开始喜欢爵士乐",
  "用户长期习惯周末登山",
  "用户希望被称为阿洛",
  "用户现在是一名装帧设计师",
])("稳定资料不因近期或现在这样的词被过滤：%s", async (text) => {
  const x = make([{ text, retention: "durable" }]);
  await extract(x, text);
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(1);
  expect(currentCandidateOffer(x.store, x.clock.now())?.kind).toBe("new");
});

it("临时事实只有明确保存意图才进候选；不确定性不能被保存意图变成断言", async () => {
  const x = make([
    { text: "用户这周正在准备展览", retention: "transient", category: "fact" },
    { text: "用户也许经营画廊", retention: "uncertain", category: "fact" },
  ]);
  await extract(x, "请记住，我这周正在准备展览。");
  expect(x.store.byStatus("memories", ["pending"]).map((m) => m.text)).toEqual([
    "用户这周正在准备展览",
  ]);
  expect(currentCandidateOffer(x.store, x.clock.now())?.kind).toBe("explicit");
});

it("不保存的来源即使模型错标长期也不能产生候选", async () => {
  const x = make([{ text: "用户喜欢攀岩", retention: "durable" }]);
  await extract(x, "我喜欢攀岩，但不要记住这个。");
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(0);
});

it("缺少保留判断整批回滚，不能靠默认长期绕过；有效原始消息仍然保留", async () => {
  const x = make([
    { text: "用户喜欢园艺", retention: "durable" },
    { text: "用户现在正浇水" },
  ]);
  const run = await extract(x, "我爱园艺，现在正浇水。");
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(0);
  expect(x.store.all("jobs")[0]).toMatchObject({
    status: "failed",
    reason: "memory_retention_required",
  });
  expect(x.store.require("messages", run.messageId).deleted).toBe(false);
});

it("同一来源的多个独立事实、主体和否定分别保留，不按来源粗暴合并", async () => {
  const x = make([
    { text: "用户喜欢陶笛", retention: "durable", subject: "user" },
    { text: "用户不喜欢打鼓", retention: "durable", subject: "user" },
    { text: "姐姐喜欢陶笛", retention: "durable", subject: "姐姐" },
  ]);
  await extract(x);
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(3);
  expect(x.h.memoryMetrics().produced).toBe(3);
});

it("同文本不同主体和现实范围不合并；完全相同的重复提议幂等", async () => {
  const x = make([]);
  const run = await extract(x);
  const input = {
    text: "喜欢制作模型",
    category: "preference" as const,
    sourceIds: [run.messageId],
    subject: "user",
  };
  const first = x.h.addMemory(input, true);
  expect(x.h.addMemory(input, true).id).toBe(first.id);
  expect(x.h.addMemory({ ...input, subject: "姐姐" }, true).id).not.toBe(
    first.id,
  );
  expect(
    x.h.addMemory({ ...input, realityScope: "roleplay" }, true).id,
  ).not.toBe(first.id);
  expect(x.h.addMemory({ ...input, text: "不喜欢制作模型" }, true).id).not.toBe(
    first.id,
  );
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(4);
});

it("新资料的卡片不受旧候选提醒配额影响，同一轮确认后不连续弹第二张", async () => {
  const x = make([
    { text: "用户喜欢室内攀岩", retention: "durable" },
    { text: "用户喜欢手绘地图", retention: "durable" },
  ]);
  x.store.saveSettings({
    ...x.store.settings(),
    lastProactiveMemoryOfferDay: "2026-10-23",
  });
  const first = await extract(x, "我喜欢室内攀岩，也喜欢手绘地图。");
  const offer = currentCandidateOffer(x.store, x.clock.now())!;
  expect(offer.kind).toBe("new");
  x.h.candidateExposure(offer.memory.id, offer.offerId);
  x.h.reviseMemory(offer.memory.id, offer.memory.revision, {
    decision: "confirm",
  });
  await x.h.tick();
  expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
  expect(x.store.settings().lastInlineMemoryOfferInputId).toBe(first.messageId);
  expect(x.store.settings().lastProactiveMemoryOfferDay).toBe("2026-10-23");
});

it("同一天后续新来源仍有确认入口；稍后不因刷新或tick重弹", async () => {
  const x = make([{ text: "用户偏爱手风琴", retention: "durable" }]);
  await extract(x);
  const first = currentCandidateOffer(x.store, x.clock.now())!;
  x.h.reviseMemory(first.memory.id, first.memory.revision, {
    decision: "later",
  });
  await x.h.tick();
  expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
  const run = x.h.submit("我也喜欢双簧管", "new-preference");
  await x.h.waitForIdle();
  const next = x.h.addMemory(
    { text: "用户喜欢双簧管", sourceIds: [run.messageId] },
    true,
  );
  await x.h.tick();
  expect(currentCandidateOffer(x.store, x.clock.now())?.memory.id).toBe(
    next.id,
  );
});

it("关闭自动整理时普通聊天工具无权收集，明确保存仍可提议且不写两份", async () => {
  const x = make([{ text: "用户喜欢观察鸟类", retention: "durable" }], {
    fakeTools: true,
  });
  x.store.saveSettings({ ...x.store.settings(), autoExtract: false });
  const run = x.h.submit("周末出去走走", "no-auto");
  await x.h.waitForIdle();
  expect(x.store.toolResult(run.runId, "one")).toMatchObject({
    error: "explicit_memory_request_required",
  });
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(0);
  const explicit = x.h.submit("请记住，观鸟是我的长期爱好", "explicit-only");
  await x.h.waitForIdle();
  x.clock.advance(2000);
  await x.h.tick();
  expect(x.store.byStatus("memories", ["pending"])).toHaveLength(1);
  expect(x.store.toolResult(explicit.runId, "one")).toMatchObject({
    status: "background_only",
  });
  expect(x.store.all("jobs")).toHaveLength(1);
  expect(x.store.all("jobs")[0]).toMatchObject({
    explicitMemoryRequest: true,
    status: "completed",
  });
});

it("旧候选的主动提醒在新版仍然每天最多一次", async () => {
  const x = make([]);
  const first = x.h.addMemory({ text: "喜欢古典吉他" }, true);
  await extract(x, "聊聊古典吉他");
  expect(currentCandidateOffer(x.store, x.clock.now())?.kind).toBe("related");
  x.h.reviseMemory(first.id, first.revision, { decision: "later" });
  x.h.addMemory({ text: "喜欢爵士鼓" }, true);
  await extract(x, "聊聊爵士鼓");
  expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
});

it("显式保存任务仍受后续关闭指令和迟到结果检查约束", async () => {
  const gate = deferred();
  const model = new ScriptedModel(async function* (r) {
    if (r.purpose === "extract") {
      await gate.promise;
      const payload = JSON.parse(r.messages[0]!.content);
      const sources = Array.isArray(payload) ? payload : payload.userSources;
      yield* response(
        JSON.stringify({
          assertions: [
            {
              text: "用户喜欢篆刻",
              category: "preference",
              certainty: "stated",
              retention: "durable",
              sourceIds: [sources[0].id],
            },
          ],
          openLoops: [],
        }),
      );
    } else {
      if (!r.messages.some((m) => m.role === "tool")) {
        yield {
          type: "tool",
          call: {
            id: "save",
            name: "propose_memory",
            input: { text: "用户喜欢篆刻", category: "preference" },
          },
        };
        yield { ...finish, reason: "tool-calls" };
      } else yield* response("聊聊篆刻。");
    }
  });
  const x = setup({
    model,
    config: { memoryV2: true, memorySummaries: false },
  });
  cleanup.push(x.dispose);
  x.store.saveSettings({ ...x.store.settings(), autoExtract: false });
  x.h.submit("请记住，我喜欢篆刻", "explicit-revoke");
  await x.h.waitForIdle();
  x.clock.advance(2000);
  const task = x.h.tick();
  await until(() => model.requests.some((r) => r.purpose === "extract"));
  x.h.updateSettings({
    expectedRevision: x.store.settings().revision,
    autoExtract: false,
  });
  gate.resolve();
  await task;
  expect(x.store.byStatus("memories", ["pending", "active"])).toHaveLength(0);
  expect(x.store.all("jobs")[0]).toMatchObject({ status: "cancelled" });
});
