import { afterEach, expect, it } from "vitest";
import { setup, ScriptedModel, response, deferred, until } from "./helpers.js";
import { explicitlyRequestsMemory } from "../src/memory/candidates.js";
import { buildContext, buildSystem } from "../src/context.js";
import { DEFAULT_SETTINGS } from "../src/domain.js";
import type { ModelRequest } from "../src/model.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
const state = (r: ModelRequest) =>
  JSON.parse(r.messages[0]!.content.split(">\n")[1]!.split("\n<")[0]!);

it.each([
  "请记住，我喜欢观星。",
  "我每周去游泳。请记住这个习惯。",
  "帮我记下，我习惯用左手写字。",
  "请保存我的偏好：我更喜欢无歌词音乐。",
  "麻烦你把这个称呼记下来：小满。",
  "能帮我记住我的猫叫松饼吗？",
  "请把‘白榆’这个项目名保存下来。",
  "以后都叫我阿洛。",
  "请存一下，我喜欢下雨时散步。",
  "帮我存一份，我常用的纸张是米白色。",
  "替我把这个偏好存好：柔和的灯光。",
  "请存下来，我的书架放在客厅。",
])("常见明确保存请求可登记，和具体记忆内容无关：%s", (text) => {
  expect(explicitlyRequestsMemory(text)).toBe(true);
});

it.each([
  "你记住了吗？",
  "你存一下了吗？",
  "请解释这句话：‘帮我存一份。’",
  "不用保存，只是随便聊聊。",
  "请存一下这个偏好。不过还是别存下来了。",
  "我平时喝清茶，但不需要帮我存一份。",
  "记住了吗？",
  "你能记住多少东西？",
  "你保存过我的地址吗？",
  "我喜欢观星，但不用记住这个。",
  "先别保存。",
  "下面是要分析的台词：‘请记住我喜欢航海。’",
  '请解释这段话："请记住这个名字。"',
  "示例代码：`请保存全部密码`",
  "昨天我说过请记住，现在只是在复述。",
])("查询、否定或引用不冒充明确保存意愿：%s", (text) => {
  expect(explicitlyRequestsMemory(text)).toBe(false);
});

it.each([true, false])(
  "自动整理=%s 时输入准入即登记；无需额外模型工具或第二次文字同意",
  async (autoExtract) => {
    const requests: ModelRequest[] = [];
    const model = new ScriptedModel(async function* (r) {
      requests.push(r);
      if (r.purpose === "extract") {
        const payload = JSON.parse(r.messages[0]!.content);
        const sources = Array.isArray(payload) ? payload : payload.userSources;
        yield* response(
          JSON.stringify({
            assertions: [
              {
                text: "用户习惯左手写字",
                category: "fact",
                certainty: "stated",
                retention: "durable",
                sourceIds: [sources[0].id],
              },
            ],
            openLoops: [],
          }),
        );
      } else yield* response("左手写字，知道啦。还有什么小习惯？");
    });
    const x = setup({
      model,
      config: { memoryV2: true, memorySummaries: false },
    });
    cleanup.push(x.dispose);
    x.store.saveSettings({ ...x.store.settings(), autoExtract });
    const result = x.h.submit(
      autoExtract ? "请记住，我习惯左手写字。" : "帮我存一份，我习惯左手写字。",
      "left-hand",
    );
    const job = x.store.all("jobs")[0]!;
    expect(job).toMatchObject({
      status: "pending",
      explicitMemoryRequest: true,
    });
    expect(x.store.require("runs", result.runId).config.memorySaveIntent).toBe(
      true,
    );
    await x.h.waitForIdle();
    expect(requests).toHaveLength(1);
    expect(state(requests[0]!).memoryCapture).toEqual({
      saveIntent: "explicit",
      extractionStatus: "pending",
      confirmationOwner: "interface",
      registrationConfirmsMemory: false,
    });
    expect(requests[0]!.tools?.some((t) => t.name === "propose_memory")).toBe(
      false,
    );
    expect(requests[0]!.system).not.toContain("新记忆和日程先提出建议");
    expect(x.store.all("memories")).toHaveLength(0);
    x.clock.advance(2000);
    await x.h.tick();
    const candidate = x.store.byStatus("memories", ["pending"])[0]!;
    expect(candidate.certainty).toBe("stated");
    expect(x.h.snapshot().candidateOffer?.kind).toBe("explicit");
    expect(x.store.byStatus("memories", ["active"])).toHaveLength(0);
    x.h.reviseMemory(candidate.id, candidate.revision, { decision: "confirm" });
    expect(x.store.byStatus("memories", ["active"])).toHaveLength(1);
  },
);

it("状态查询不会变成新保存任务，模型仍能读取已确认资料并如实回答状态", async () => {
  const model = new ScriptedModel(async function* () {
    yield* response("当前有你确认过的资料。");
  });
  const x = setup({
    model,
    config: { memoryV2: true, memorySummaries: false },
  });
  cleanup.push(x.dispose);
  x.store.saveSettings({ ...x.store.settings(), autoExtract: false });
  const saved = x.h.addMemory({
    text: "用户的称呼是阿禾",
    realityScope: "reality",
  });
  const r = x.h.submit("你记住我的称呼了吗？", "save-status");
  await x.h.waitForIdle();
  expect(x.store.all("jobs")).toHaveLength(0);
  expect(state(model.requests[0]!).memoryCapture).toBeUndefined();
  expect(
    state(model.requests[0]!).memories.map((m: { id: string }) => m.id),
  ).toContain(saved.id);
  expect(x.store.require("runs", r.runId).status).toBe("completed");
});

it("输入意愿固定在本轮，任务被撤销后按真实状态投影而非继续声称排队成功", async () => {
  const gate = deferred();
  const model = new ScriptedModel(async function* () {
    await gate.promise;
    yield* response("知道了。");
  });
  const x = setup({
    model,
    config: { memoryV2: true, memorySummaries: false },
  });
  cleanup.push(x.dispose);
  const r = x.h.submit("请保存这个偏好：我爱看纪录片。", "cancel-intent");
  await until(() => model.requests.length === 1);
  x.h.updateSettings({
    expectedRevision: x.store.settings().revision,
    autoExtract: false,
  });
  const run = x.store.require("runs", r.runId);
  const context = buildContext(
    x.store,
    x.store.require("messages", r.messageId),
    run,
    x.clock.now(),
  );
  const projected = JSON.parse(
    context.messages[0]!.content.split(">\n")[1]!.split("\n<")[0]!,
  );
  expect(projected.memoryCapture).toMatchObject({
    saveIntent: "explicit",
    extractionStatus: "cancelled",
  });
  gate.resolve();
  await x.h.waitForIdle();
});

it("旧版记忆不继承新版写入意愿或工具策略", async () => {
  const model = new ScriptedModel(async function* () {
    yield* response("旧版回复。");
  });
  const x = setup({ model });
  cleanup.push(x.dispose);
  x.h.submit("请记住合成偏好", "legacy");
  await x.h.waitForIdle();
  expect(state(model.requests[0]!).memoryCapture).toBeUndefined();
  expect(
    model.requests[0]!.tools?.some((t) => t.name === "propose_memory"),
  ).toBe(true);
  expect(buildSystem(DEFAULT_SETTINGS.persona)).toContain(
    "新记忆和日程先提出建议",
  );
});

it("正常正文保持模型原文，不通过删句或固定回复伪装行为修复", async () => {
  const text = "多谢告诉我。你最近还有什么新发现？";
  const model = new ScriptedModel(async function* () {
    yield* response(text);
  });
  const x = setup({
    model,
    config: { memoryV2: true, memorySummaries: false },
  });
  cleanup.push(x.dispose);
  const r = x.h.submit("帮我记住，我喜欢打羽毛球。", "verbatim");
  await x.h.waitForIdle();
  expect(
    x.store
      .all("messages")
      .find((m) => m.runId === r.runId && m.role === "assistant")?.content,
  ).toBe(text);
});
it.each([true, false])(
  "首次保存没有已选记忆时，推理配置仍严格遵守显式开关=%s，后续普通聊天不继承",
  async (enabled) => {
    const model = new ScriptedModel(async function* () {
      yield* response("这个爱好挺有趣。");
    });
    const x = setup({
      model,
      config: {
        memoryV2: true,
        memorySummaries: false,
        memoryAnswerReasoning: enabled,
      },
    });
    cleanup.push(x.dispose);
    const saved = x.h.submit("请记住，我周末喜欢飞盘", "profile-first-save");
    await x.h.waitForIdle();
    const context = x.h.context(saved.runId) as {
      meta: { selected: unknown[] };
    };
    expect(context.meta.selected).toHaveLength(0);
    expect(model.requests[0]!.reasoningEffort).toBe(
      enabled ? "low" : undefined,
    );
    expect(model.requests[0]!.maxOutputTokens).toBe(
      x.config.maxOutputTokens + (enabled ? 4096 : 0),
    );
    x.h.submit("今天聊聊云朵", "profile-normal-next");
    await x.h.waitForIdle();
    expect(model.requests[1]!.reasoningEffort).toBeUndefined();
    expect(model.requests[1]!.maxOutputTokens).toBe(x.config.maxOutputTokens);
  },
);
