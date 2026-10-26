import { afterEach, describe, expect, it } from "vitest";
import {
  setup,
  ScriptedModel,
  response,
  finish,
  deferred,
  until,
} from "./helpers.js";
import { DomainError } from "../src/domain.js";
import { classifyModelError } from "../src/model.js";

const cleanups: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

describe("M1 自有运行控制", () => {
  it("输入落盘后生成，公开消息与终态可恢复", async () => {
    const { h, store } = make();
    const receipt = h.submit("你好", "one");
    await h.waitForIdle();
    expect(store.require("runs", receipt.runId).status).toBe("completed");
    expect(
      store.require("messages", `assistant-${receipt.runId}`).content,
    ).toContain("你好");
    expect(store.events().some((e) => e.type === "message.completed")).toBe(
      true,
    );
  });
  it("相同幂等键不重复生成；不同正文冲突", async () => {
    const { h, store } = make();
    const a = h.submit("你好", "same"),
      b = h.submit("你好", "same");
    expect(b.runId).toBe(a.runId);
    expect(b.duplicate).toBe(true);
    expect(() => h.submit("另一句", "same")).toThrow("idempotency_conflict");
    await h.waitForIdle();
    expect(store.list("runs")).toHaveLength(1);
  });
  it("同一关系排队，当前运行不看见未来排队输入", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* (_r, index) {
      if (index === 0) await gate.promise;
      yield* response("收到");
    });
    const { h, store } = make({ model });
    const a = h.submit("第一条", "a");
    const b = h.submit("下一条机密占位符", "b");
    gate.resolve();
    await h.waitForIdle();
    expect(store.require("runs", a.runId).status).toBe("completed");
    expect(store.require("runs", b.runId).status).toBe("completed");
    expect(JSON.stringify(model.requests[0]?.messages)).not.toContain(
      "下一条机密占位符",
    );
  });
  it("取消立即提交；无视abort的模型迟到输出不能提交", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      yield { type: "text", text: "已提交" };
      await gate.promise;
      yield { type: "text", text: "不应出现" };
      yield finish;
    });
    const { h, store } = make({ model });
    const r = h.submit("继续说", "cancel");
    await until(
      () =>
        store.require("messages", `assistant-${r.runId}`).content === "已提交",
    );
    h.cancel(r.runId);
    await h.waitForIdle();
    gate.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(store.require("runs", r.runId).status).toBe("cancelled");
    expect(
      store.require("messages", `assistant-${r.runId}`).content,
    ).not.toContain("不应出现");
  });
  it("取消等待中的Run不会调用模型", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response();
    });
    const { h, store } = make({ model });
    h.submit("第一条", "q1");
    const queued = h.submit("排队", "q2");
    h.cancel(queued.runId);
    gate.resolve();
    await h.waitForIdle();
    expect(model.requests).toHaveLength(1);
    expect(store.require("runs", queued.runId).status).toBe("cancelled");
  });
  it("截止时间也能终止不响应abort的模型", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response();
    });
    const { h, store } = make({ model, config: { maxRunMs: 25 } });
    const r = h.submit("测试", "deadline");
    await h.waitForIdle();
    expect(store.require("runs", r.runId).reason).toBe("deadline_exceeded");
    gate.resolve();
  });
  it("已有部分文本的失败不自动整轮重跑", async () => {
    const model = new ScriptedModel(async function* () {
      yield { type: "text", text: "部分回复" };
      throw new DomainError("provider_unavailable", 503);
    });
    const { h, store } = make({ model });
    const r = h.submit("说一句", "partial");
    await h.waitForIdle();
    expect(model.requests).toHaveLength(1);
    expect(store.require("runs", r.runId).status).toBe("failed");
    expect(store.require("messages", `assistant-${r.runId}`).content).toBe(
      "部分回复",
    );
  });
  it("没有输出或副作用的暂时失败最多重试一次，并计入预算", async () => {
    const model = new ScriptedModel(async function* (_r, index) {
      if (index === 0) throw new DomainError("provider_unavailable", 503);
      yield* response("重试成功");
    });
    const { h, store } = make({ model });
    const r = h.submit("测试安全重试", "retry");
    await h.waitForIdle();
    expect(model.requests).toHaveLength(2);
    expect(store.require("runs", r.runId)).toMatchObject({
      status: "completed",
      steps: 2,
    });
    expect(store.usageRecords()).toHaveLength(2);
    expect(store.require("runs", r.runId).usage.estimated).toBe(true);
  });
  it("空输出与截断均不假报完成", async () => {
    for (const reason of ["stop", "length"]) {
      const model = new ScriptedModel(async function* () {
        yield { ...finish, reason };
      });
      const { h, store } = make({ model });
      const r = h.submit("测试", "empty");
      await h.waitForIdle();
      expect(store.require("runs", r.runId).status).toBe("failed");
    }
  });
  it("工具请求由自有执行器执行，结果回到续步", async () => {
    const model = new ScriptedModel(async function* (r, index) {
      if (index === 0) {
        yield {
          type: "tool",
          call: { id: "call1", name: "read_work_state", input: {} },
        };
        yield { ...finish, reason: "tool-calls" };
      } else {
        expect(
          r.messages.some(
            (m) => m.role === "tool" && m.content.includes("focused"),
          ),
        ).toBe(true);
        yield* response("你现在没有开启专注。");
      }
    });
    const { h, store } = make({ model });
    const r = h.submit("我正在专注吗", "tool");
    await h.waitForIdle();
    expect(store.require("runs", r.runId).status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(store.toolResult(r.runId, "call1")).toMatchObject({
      focused: false,
    });
  });
  it("未授权工具只返回拒绝，不执行外部副作用", async () => {
    const model = new ScriptedModel(async function* (_r, index) {
      if (index === 0) {
        yield {
          type: "tool",
          call: { id: "shell1", name: "shell", input: { command: "anything" } },
        };
        yield { ...finish, reason: "tool-calls" };
      } else yield* response();
    });
    const { h, store } = make({ model });
    const r = h.submit("测试", "denied");
    await h.waitForIdle();
    expect(store.toolResult(r.runId, "shell1")).toEqual({
      error: "tool_not_authorized",
    });
  });
  it("重复toolCallId只执行一次领域写入", async () => {
    const model = new ScriptedModel(async function* (_r, index) {
      if (index < 2) {
        yield {
          type: "tool",
          call: {
            id: "repeat",
            name: "propose_memory",
            input: { text: "测试偏好", category: "preference" },
          },
        };
        yield { ...finish, reason: "tool-calls" };
      } else yield* response();
    });
    const { h, store } = make({ model });
    h.submit("我喜欢测试", "repeattool");
    await h.waitForIdle();
    expect(store.list("memories")).toHaveLength(1);
  });
  it("工具续步有6次模型调用的硬上限", async () => {
    const model = new ScriptedModel(async function* (_r, index) {
      yield {
        type: "tool",
        call: { id: `call${index}`, name: "read_work_state", input: {} },
      };
      yield { ...finish, reason: "tool-calls" };
    });
    const { h, store } = make({ model });
    const r = h.submit("测试", "limit");
    await h.waitForIdle();
    expect(model.requests).toHaveLength(6);
    expect(store.require("runs", r.runId).reason).toBe("step_budget_exceeded");
  });
  it("预算不足时不请求模型，usage未知不写成零", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response();
    });
    const { h, store } = make({ model });
    const s = store.settings();
    store.saveSettings({ ...s, dailyTokenBudget: 1 });
    const r = h.submit("预算测试", "budget");
    await h.waitForIdle();
    expect(model.requests).toHaveLength(0);
    expect(store.require("runs", r.runId).reason).toBe("budget_exceeded");
    expect(store.require("runs", r.runId).usage.totalTokens).toBeUndefined();
  });
  it("前台已断开没有显式取消时仍完成，可从快照查看", async () => {
    const { h, store } = make();
    const r = h.submit("你好", "disconnect");
    await h.waitForIdle();
    expect(
      h
        .snapshot()
        .messages.some((m) => m.runId === r.runId && m.role === "assistant"),
    ).toBe(true);
    expect(store.require("runs", r.runId).status).toBe("completed");
  });
});

describe("M2 人格与安全", () => {
  it("人格更新只影响下一Run，活动Run固定版本", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* (_r, index) {
      if (index === 0) await gate.promise;
      yield* response();
    });
    const { h, store } = make({ model });
    const a = h.submit("第一条", "pa");
    const s = store.settings();
    h.publishPersona({ ...s.persona, name: "新名字" }, s.revision);
    gate.resolve();
    await h.waitForIdle();
    const b = h.submit("第二条", "pb");
    await h.waitForIdle();
    expect(store.require("runs", a.runId).personaRevision).toBe(1);
    expect(store.require("runs", b.runId).personaRevision).toBe(2);
    expect(model.requests[0]?.system).toContain("小野");
    expect(model.requests[1]?.system).toContain("新名字");
  });
  it("人格配置不接受安全策略字段或缺失核心字段", () => {
    const { h, store } = make();
    expect(() =>
      h.publishPersona({ name: "" }, store.settings().revision),
    ).toThrow();
    expect(store.settings().personaRevision).toBe(1);
  });
  it("明确称呼边界即时进入当前投影，不依赖后台提取", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response();
    });
    const { h } = make({ model });
    h.submit("不要叫我老板", "boundary");
    await h.waitForIdle();
    expect(JSON.stringify(model.requests[0]?.messages)).toContain(
      "不要叫我老板",
    );
  });
  it("新称呼边界到达时旧生成立即失效，下一轮使用新边界", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* (_r, index) {
      if (index === 0) await gate.promise;
      yield* response();
    });
    const { h, store } = make({ model });
    const old = h.submit("正在生成的旧回复", "old-boundary");
    const next = h.submit("不要叫我老板", "new-boundary");
    gate.resolve();
    await h.waitForIdle();
    expect(store.require("runs", old.runId).status).toBe("cancelled");
    expect(store.require("runs", next.runId).status).toBe("completed");
  });
  it("明确即时危机切认真支持路线，禁用工具", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response("我认真听着。你现在安全吗？能联系身边可信赖的人吗？");
    });
    const { h, store } = make({ model });
    const r = h.submit("我现在准备自杀", "risk");
    await h.waitForIdle();
    expect(store.require("runs", r.runId).config.crisis).toBe(true);
    expect(model.requests[0]?.tools).toEqual([]);
    expect(model.requests[0]?.system).toContain("保留熟悉语气");
  });
  it("普通疲惫不升级为危机", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response();
    });
    const { h, store } = make({ model });
    const r = h.submit("今天有点累", "tired");
    await h.waitForIdle();
    expect(store.require("runs", r.runId).config.crisis).toBe(false);
  });
  it("模型名配置只允许已声明候选，旧修订拒绝覆盖", () => {
    const { h, store } = make();
    const s = store.settings();
    expect(() =>
      h.updateSettings({ expectedRevision: s.revision, model: "unknown" }),
    ).toThrow();
    h.updateSettings({ expectedRevision: s.revision, focused: true });
    expect(() =>
      h.updateSettings({ expectedRevision: s.revision, muted: true }),
    ).toThrow("revision_conflict");
  });
});

describe("提供方限流与可观察版本变化", () => {
  it("Retry-After安全归一；等待超出Run期限时不会提前重试", async () => {
    const error = classifyModelError({
      statusCode: 429,
      responseHeaders: { "retry-after": "120", secret: "never-persist" },
    });
    expect(error.retryAfterMs).toBe(120000);
    expect(error.message).toBe("provider_rate_limited");
    const model = new ScriptedModel(async function* () {
      throw error;
    });
    const x = make({ model });
    const receipt = x.h.submit("合成限流", "rate-limit");
    await x.h.waitForIdle();
    expect(model.requests).toHaveLength(1);
    expect(x.store.require("runs", receipt.runId).status).toBe("failed");
  });
  it("响应身份变化暂停自发关心，普通交流保持可用，显式复核后解除", async () => {
    let version = "snapshot-1";
    const model = new ScriptedModel(async function* () {
      yield { type: "text", text: "合成固定回复" };
      yield { ...finish, providerModel: version };
    });
    const x = make({ model });
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      autoExtract: false,
    });
    x.h.submit("第一轮", "identity-1");
    await x.h.waitForIdle();
    expect(x.store.settings().modelReview).toBeUndefined();
    version = "snapshot-2";
    const second = x.h.submit("第二轮", "identity-2");
    await x.h.waitForIdle();
    expect(x.store.require("runs", second.runId).status).toBe("completed");
    expect(x.store.settings().modelReview?.previous).toBe("snapshot-1");
    const f = x.h.createFollowUp({
      kind: "candidate",
      text: "合成关心",
      dueAt: x.clock.now(),
      latestAt: x.clock.now() + 3600000,
    });
    await x.h.tick();
    expect(x.store.require("followups", f.id).reason).toBe(
      "model_review_required",
    );
    expect(x.store.list("deliveries")).toHaveLength(0);
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      acknowledgeModelReview: true,
    });
    expect(x.store.settings().modelReview).toBeUndefined();
  });
});

it("风险路由不被前半句虚构引用全局遮蔽，也不把明确否认当成行动", async () => {
  const { isImmediateRisk } = await import("../src/domain.js");
  expect(isImmediateRisk("这段小说里有人自杀，但是我现在准备自杀")).toBe(true);
  expect(isImmediateRisk("我今晚不想自杀，我现在是安全的")).toBe(false);
  expect(isImmediateRisk("我现在不想活了")).toBe(true);
});
