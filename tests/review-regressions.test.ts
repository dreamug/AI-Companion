import { afterEach, describe, it, expect } from "vitest";
import {
  setup,
  ScriptedModel,
  response,
  finish,
  deferred,
  until,
} from "./helpers.js";
import { buildContext } from "../src/context.js";
import { collect } from "../src/model.js";
import { tokenEstimate, DEFAULT_SETTINGS } from "../src/domain.js";

const cleanups: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

describe("审查：异步判断不能覆盖新的权威状态", () => {
  for (const decision of ["skip", "defer", "send"] as const)
    it(`判断${decision}返回时用户已取消，不能复活或再生成`, async () => {
      const gate = deferred();
      const model = new ScriptedModel(async function* (r) {
        if (r.purpose === "judge") {
          await gate.promise;
          yield* response(JSON.stringify({ decision, reason: "synthetic" }));
        } else yield* response("合成草稿");
      });
      const x = make({ model });
      const f = x.h.createFollowUp({
        text: "合成事项",
        kind: "candidate",
        dueAt: x.clock.now(),
        latestAt: x.clock.now() + 3600000,
      });
      const pending = x.h.tick();
      await until(() => model.requests.length === 1);
      x.h.updateFollowUp(f.id, 1, "cancel");
      gate.resolve();
      await pending;
      expect(x.store.require("followups", f.id).status).toBe("cancelled");
      expect(model.requests).toHaveLength(1);
      expect(x.store.list("deliveries")).toHaveLength(0);
    });
  it("不允许把已取消、过期或已解决的同一跟进确认成新一轮", () => {
    const x = make();
    const f = x.h.createFollowUp({
      text: "合成",
      dueAt: x.clock.now(),
      latestAt: x.clock.now() + 1000,
    });
    const cancelled = x.h.updateFollowUp(f.id, 1, "cancel");
    expect(() =>
      x.h.updateFollowUp(f.id, cancelled.revision, "confirm"),
    ).toThrow("follow_up_terminal");
  });
  it("关闭自动整理后，已有提取不继续外发", async () => {
    const model = new ScriptedModel(async function* (r) {
      yield* response(
        r.purpose === "extract"
          ? JSON.stringify({ assertions: [], openLoops: [] })
          : "合成回复",
      );
    });
    const x = make({ model });
    x.h.submit("合成偏好", "extract-switch");
    await x.h.waitForIdle();
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      autoExtract: false,
    });
    x.clock.advance(2000);
    await x.h.tick();
    expect(model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
      0,
    );
  });
  it("关闭自动整理使正在执行的提取失效", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response(
        JSON.stringify({
          assertions: [
            {
              text: "旧建议",
              category: "fact",
              certainty: "stated",
              sourceIds: ["src"],
            },
          ],
          openLoops: [],
        }),
      );
    });
    const x = make({ model });
    x.store.put("sources", {
      id: "src",
      text: "合成",
      kind: "message",
      revision: 1,
      deleted: false,
      createdAt: x.clock.now(),
    });
    x.store.put("jobs", {
      id: "job",
      kind: "extract",
      sources: [{ id: "src", revision: 1 }],
      epoch: 1,
      status: "pending",
      attempts: 0,
      createdAt: x.clock.now(),
      nextAt: x.clock.now(),
    });
    const pending = x.h.tick();
    await until(() => model.requests.length === 1);
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      autoExtract: false,
    });
    gate.resolve();
    await pending;
    expect(x.store.list("memories")).toHaveLength(0);
    expect(x.store.require("jobs", "job").status).toBe("cancelled");
  });
  it("撤回模型外发许可停止当前与排队请求", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response();
    });
    const x = make({ model });
    const first = x.h.submit("合成一", "consent-1");
    const second = x.h.submit("合成二", "consent-2");
    await until(() => model.requests.length === 1);
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      remoteDisclosureAcknowledged: false,
    });
    gate.resolve();
    await x.h.waitForIdle();
    expect(model.requests).toHaveLength(1);
    for (const r of [first, second])
      expect(x.store.require("runs", r.runId).status).toBe("cancelled");
  });
});

describe("审查：模型和工具协议不能假报成功", () => {
  for (const reason of ["content-filter", "error", "unknown"])
    it(`后台${reason}不能作为完整结果`, async () => {
      const model = new ScriptedModel(async function* () {
        yield { type: "text", text: "部分输出" };
        yield { ...finish, reason };
      });
      await expect(
        collect(model, {
          purpose: "summary",
          model: "synthetic",
          system: "合成",
          messages: [{ role: "user", content: "合成" }],
          maxOutputTokens: 100,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("model_incomplete");
    });
  it("前台未知finish不能假报完成", async () => {
    const model = new ScriptedModel(async function* () {
      yield { type: "text", text: "部分输出" };
      yield { ...finish, reason: "error" };
    });
    const x = make({ model });
    const r = x.h.submit("合成", "bad-finish");
    await x.h.waitForIdle();
    expect(x.store.require("runs", r.runId).status).toBe("failed");
  });
  it("stop终态夹带工具请求不能执行写入", async () => {
    const model = new ScriptedModel(async function* () {
      yield {
        type: "tool",
        call: {
          id: "bad",
          name: "propose_memory",
          input: { text: "不应写入", category: "fact" },
        },
      };
      yield finish;
    });
    const x = make({ model });
    x.h.submit("合成", "bad-tool-finish");
    await x.h.waitForIdle();
    expect(x.store.list("memories")).toHaveLength(0);
  });
  it("同call ID换参数不能把旧结果冒充新操作", async () => {
    const model = new ScriptedModel(async function* (_r, index) {
      if (index < 2) {
        yield {
          type: "tool",
          call: {
            id: "same-id",
            name: "propose_memory",
            input: {
              text: index === 0 ? "第一条" : "第二条",
              category: "fact",
            },
          },
        };
        yield { ...finish, reason: "tool-calls" };
      } else yield* response();
    });
    const x = make({ model });
    const r = x.h.submit("合成", "changed-tool");
    await x.h.waitForIdle();
    expect(x.store.require("runs", r.runId).reason).toBe("tool_call_conflict");
    expect(x.store.list("memories")).toHaveLength(1);
  });
  it("危机Trace必须反映实际发送的system", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response();
    });
    const x = make({ model });
    const r = x.h.submit("我现在准备自杀", "crisis-context");
    await x.h.waitForIdle();
    expect((x.h.context(r.runId) as { system: string }).system).toBe(
      model.requests[0]!.system,
    );
  });
  it("发布时就拒绝装不下核心上下文的人格", () => {
    const x = make();
    expect(() =>
      x.h.publishPersona(
        {
          ...DEFAULT_SETTINGS.persona,
          identity: "字".repeat(2000),
          style: "字".repeat(2000),
          examples: "字".repeat(4000),
        },
        1,
      ),
    ).toThrow("core_context_too_large");
  });
});

describe("审查：上下文与历史窗口", () => {
  it("相同毫秒的多轮消息按接受顺序和user/assistant排序", async () => {
    const x = make();
    for (let i = 0; i < 8; i++) {
      x.h.submit(`合成${i}`, `order-${i}`);
      await x.h.waitForIdle();
    }
    expect(x.h.snapshot().messages.map((m) => m.role)).toEqual(
      Array.from({ length: 8 }, () => ["user", "assistant"]).flat(),
    );
    expect(x.h.snapshot().runs.map((r) => r.config.enqueueSeq)).toEqual(
      x.h
        .snapshot()
        .runs.map((r) => r.config.enqueueSeq)
        .sort((a, b) => Number(b) - Number(a)),
    );
  });
  it("长历史整轮裁剪且Trace历史ID与真实投影一致", async () => {
    const x = make();
    for (let i = 0; i < 3; i++) {
      x.h.submit("长".repeat(7000), `long-${i}`);
      await x.h.waitForIdle();
    }
    const r = x.store.require("runs", x.h.snapshot().runs[0]!.id);
    const c = buildContext(
      x.store,
      x.store.require("messages", r.inputId),
      r,
      x.clock.now(),
    );
    expect(
      tokenEstimate(
        c.messages
          .slice(1, -1)
          .map((m) => m.content)
          .join(""),
      ),
    ).toBeLessThanOrEqual(8000);
    expect(c.meta.historyIds).toHaveLength(c.messages.length - 2);
  });
  it("自动候选和失效来源不能撑爆followUp动态上下文", async () => {
    const x = make();
    for (let i = 0; i < 30; i++)
      x.h.createFollowUp(
        {
          text: "长".repeat(900),
          dueAt: x.clock.now() + 1000,
          latestAt: x.clock.now() + 3600000,
        },
        false,
      );
    const r = x.h.submit("合成", "follow-context");
    await x.h.waitForIdle();
    const context = x.h.context(r.runId) as { messages: { content: string }[] };
    expect(tokenEstimate(context.messages[0]!.content)).toBeLessThan(6000);
  });
  it("旧排队任务不应因为最近100个完成项而永久饿死", async () => {
    const x = make();
    const r = x.h.submit("旧输入", "old-queue");
    await x.h.waitForIdle();
    const old = x.store.require("runs", r.runId);
    x.store.put("runs", { ...old, status: "queued" });
    for (let i = 0; i < 110; i++)
      x.store.put("runs", {
        ...old,
        id: `done-${i}`,
        status: "completed",
        createdAt: x.clock.now() + 1000 + i,
        config: { ...old.config, enqueueSeq: 1000 + i },
      });
    x.h.start();
    await until(() => x.store.require("runs", r.runId).status !== "queued");
  });
});

it("多个事项存在时，泛泛的完成表达不能结束另一件事", async () => {
  let target = "";
  const model = new ScriptedModel(async function* (_r, i) {
    if (i === 0) {
      yield {
        type: "tool",
        call: {
          id: "resolve",
          name: "resolve_follow_up",
          input: { id: target },
        },
      };
      yield { ...finish, reason: "tool-calls" };
    } else yield* response();
  });
  const x = make({ model });
  x.h.createFollowUp({
    text: "事项甲",
    dueAt: x.clock.now() + 1000,
    latestAt: x.clock.now() + 3600000,
  });
  const second = x.h.createFollowUp({
    text: "事项乙",
    dueAt: x.clock.now() + 1000,
    latestAt: x.clock.now() + 3600000,
  });
  target = second.id;
  const receipt = x.h.submit("事项甲已经完成了", "ambiguous-resolution");
  await x.h.waitForIdle();
  expect(x.store.toolResult(receipt.runId, "resolve")).toEqual({
    error: "explicit_target_required",
  });
  expect(x.store.require("followups", second.id).status).toBe("pending");
});

it("已过期或来源失效的旧文本不能阻止新来源重新提出建议", async () => {
  const model = new ScriptedModel(async function* () {
    yield* response(
      JSON.stringify({
        assertions: [
          {
            text: "重复合成事实",
            category: "fact",
            certainty: "stated",
            sourceIds: ["fresh"],
          },
        ],
        openLoops: [],
      }),
    );
  });
  const x = make({ model });
  const old = x.h.addMemory({ text: "重复合成事实" });
  x.store.put("memories", { ...old, status: "superseded" });
  x.store.put("sources", {
    id: "fresh",
    text: "合成新来源",
    kind: "message",
    revision: 1,
    createdAt: x.clock.now(),
    deleted: false,
  });
  x.store.put("jobs", {
    id: "fresh-job",
    kind: "extract",
    sources: [{ id: "fresh", revision: 1 }],
    epoch: 1,
    status: "pending",
    attempts: 0,
    createdAt: x.clock.now(),
    nextAt: x.clock.now(),
  });
  await x.h.tick();
  expect(
    x.store
      .list("memories")
      .some(
        (m) =>
          m.status === "pending" && m.sources.some((s) => s.id === "fresh"),
      ),
  ).toBe(true);
});

it("后台调用失败后用量状态结束为未知，不永远挂在pending", async () => {
  const model = new ScriptedModel(async function* () {
    throw new Error("synthetic_failure");
  });
  const x = make({ model });
  x.h.createFollowUp({
    text: "合成",
    dueAt: x.clock.now(),
    latestAt: x.clock.now() + 3600000,
  });
  await x.h.tick();
  expect(x.store.usageRecords()[0]?.data.state).toBe("failed_usage_unknown");
  expect(x.store.usageRecords()[0]?.data.estimated).toBe(true);
});

it("确认后的事实不再受待确认七天时限影响，重复来源不制造新建议", async () => {
  const model = new ScriptedModel(async function* () {
    yield* response(
      JSON.stringify({
        assertions: [
          {
            text: "确认的长期偏好",
            category: "preference",
            certainty: "stated",
            sourceIds: ["repeated"],
          },
        ],
        openLoops: [],
      }),
    );
  });
  const x = make({ model });
  const pending = x.h.addMemory(
    { text: "确认的长期偏好", category: "preference" },
    true,
  );
  x.h.reviseMemory(pending.id, pending.revision, { decision: "confirm" });
  x.clock.advance(8 * 86400000);
  x.store.put("sources", {
    id: "repeated",
    text: "合成再次提及",
    kind: "message",
    revision: 1,
    createdAt: x.clock.now(),
    deleted: false,
  });
  x.store.put("jobs", {
    id: "repeat-job",
    kind: "extract",
    sources: [{ id: "repeated", revision: 1 }],
    epoch: 1,
    status: "pending",
    attempts: 0,
    createdAt: x.clock.now(),
    nextAt: x.clock.now(),
  });
  await x.h.tick();
  expect(
    x.store.list("memories").filter((m) => m.status === "active"),
  ).toHaveLength(1);
  expect(
    x.store.list("memories").filter((m) => m.status === "pending"),
  ).toHaveLength(0);
  expect(x.store.search("长期偏好", x.clock.now())).toHaveLength(1);
});
