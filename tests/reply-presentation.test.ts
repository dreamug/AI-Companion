import { afterEach, describe, expect, it } from "vitest";
import { splitReply } from "../src/reply-presentation.js";
import { setup, ScriptedModel, response, deferred, until } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanups.push(x.dispose);
  x.h.updateSettings({
    expectedRevision: x.store.settings().revision,
    autoExtract: false,
  });
  return x;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function configure(
  x: ReturnType<typeof setup>,
  changes = { splitReplies: true, messagePacing: false },
) {
  x.h.updateSettings({
    expectedRevision: x.store.settings().revision,
    ...changes,
  });
}
function replies(x: ReturnType<typeof setup>, runId: string) {
  return x.h
    .snapshot()
    .messages.filter(
      (m) => m.runId === runId && m.role === "assistant" && m.content,
    );
}
const text = "先告诉你第一件事。\n\n第二件事稍后再说。\n\n最后是第三件事。";

describe("每个bot可选的分条回复与发送间隔", () => {
  it("旧设置缺少新字段时默认关闭，不改写原有设置", () => {
    const x = make();
    const old = { ...x.store.settings() } as Record<string, unknown>;
    delete old.splitReplies;
    delete old.messagePacing;
    x.store.db.prepare("UPDATE settings SET data=?").run(JSON.stringify(old));
    expect(x.store.settings()).toMatchObject({
      splitReplies: false,
      messagePacing: false,
      persona: old.persona,
    });
    const raw = x.store.db.prepare("SELECT data FROM settings").get() as {
      data: string;
    };
    expect(JSON.parse(raw.data).splitReplies).toBeUndefined();
  });

  it("全部关闭时保留单气泡流式正文与原来的提示词；仅开间隔也不改变回复", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(text);
    });
    const x = make({ model });
    expect(x.store.settings()).toMatchObject({
      splitReplies: false,
      messagePacing: false,
    });
    for (const messagePacing of [false, true]) {
      configure(x, { splitReplies: false, messagePacing });
      const r = x.h.submit("照常聊天", String(messagePacing));
      await x.h.waitForIdle();
      expect(replies(x, r.runId).map((m) => m.content)).toEqual([text]);
      expect(replies(x, r.runId)[0]?.replyIndex).toBeUndefined();
      expect(
        x.store
          .events()
          .some((e) => e.runId === r.runId && e.type === "message.segment"),
      ).toBe(true);
    }
    expect(model.requests[0]?.system).toBe(model.requests[1]?.system);
    expect(model.requests[0]?.system).not.toContain("本轮已开启分条回复");
  });

  it("一次生成产生有稳定身份与序号的多个气泡，同一时间戳也按发送顺序恢复", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(text);
    });
    const x = make({ model });
    configure(x);
    const r = x.h.submit("请聊聊", "group");
    await x.h.waitForIdle();
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.system).toContain("本轮已开启分条回复");
    const messages = replies(x, r.runId);
    expect(messages.map((m) => m.content)).toEqual(text.split("\n\n"));
    expect(messages.map((m) => m.replyIndex)).toEqual([0, 1, 2]);
    expect(new Set(messages.map((m) => m.id)).size).toBe(3);
    expect(x.store.require("runs", r.runId)).toMatchObject({
      status: "completed",
      config: { replyCount: 3, replySent: 3, replyPhase: "completed" },
    });
    expect(
      x.store
        .events()
        .filter((e) => e.runId === r.runId && e.type === "message.completed"),
    ).toHaveLength(3);
  });

  it("第一条发布后可插话，取消剩余内容，新上下文只包含已展示部分", async () => {
    const model = new ScriptedModel(async function* (_r, index) {
      yield* response(index ? "按你的新安排来" : text);
    });
    const x = make({ model });
    configure(x, { splitReplies: true, messagePacing: true });
    const a = x.h.submit("开始说吧", "a");
    await until(() => replies(x, a.runId).length === 1);
    const first = replies(x, a.runId)[0]!;
    x.h.displayed(first.id, first.content.length);
    expect(JSON.stringify(x.h.snapshot())).not.toContain("第二件事稍后再说");
    const b = x.h.submit("我改主意了", "b");
    await x.h.waitForIdle();
    expect(x.store.require("runs", a.runId)).toMatchObject({
      status: "cancelled",
      reason: "user_interrupted",
    });
    expect(replies(x, a.runId).map((m) => m.content)).toEqual([
      text.split("\n\n")[0],
    ]);
    expect(first.status).toBe("completed");
    expect(x.store.require("messages", first.id).status).toBe("completed");
    expect(replies(x, b.runId)[0]?.content).toBe("按你的新安排来");
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(
      first.content,
    );
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(
      "第二件事稍后再说",
    );
  });

  it("停止立即取消等待且保留已经发送的气泡，多次停止不重复发事件", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(text);
    });
    const x = make({ model });
    configure(x, { splitReplies: true, messagePacing: true });
    const r = x.h.submit("开始", "stop");
    await until(() => replies(x, r.runId).length === 1);
    x.h.cancel(r.runId);
    x.h.cancel(r.runId);
    await x.h.waitForIdle();
    expect(replies(x, r.runId)).toHaveLength(1);
    expect(replies(x, r.runId)[0]?.status).toBe("completed");
    expect(
      x.store
        .events()
        .filter((e) => e.type === "run.cancelled" && e.runId === r.runId),
    ).toHaveLength(1);
    expect(JSON.stringify(x.h.snapshot())).not.toContain("最后是第三件事");
  });

  it("发送期间重复读取快照与游标只观察进度，不重新生成或重复发布", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(text);
    });
    const x = make({ model });
    configure(x, { splitReplies: true, messagePacing: true });
    const r = x.h.submit("刷新中继续发送", "refresh");
    await until(() => replies(x, r.runId).length === 1);
    const id = replies(x, r.runId)[0]!.id;
    for (let i = 0; i < 10; i++) {
      expect(replies(x, r.runId)[0]!.id).toBe(id);
      x.store.events(x.h.snapshot().cursor);
    }
    await x.h.waitForIdle();
    expect(replies(x, r.runId).map((m) => m.content)).toEqual(
      text.split("\n\n"),
    );
    expect(model.requests).toHaveLength(1);
    const ids = x.store
      .events()
      .filter((e) => e.type === "message.completed" && e.runId === r.runId)
      .map((e) => e.payload.messageId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toHaveLength(3);
  });

  it("开关修改不打断当前普通生成，从下一轮生效", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* (_r, index) {
      if (!index) await gate.promise;
      yield* response(text);
    });
    const x = make({ model });
    const a = x.h.submit("普通回复", "before");
    configure(x);
    expect(x.store.require("runs", a.runId).status).toBe("running");
    gate.resolve();
    await x.h.waitForIdle();
    expect(replies(x, a.runId).map((m) => m.content)).toEqual([text]);
    const b = x.h.submit("下一轮分条", "after");
    await x.h.waitForIdle();
    expect(replies(x, b.runId)).toHaveLength(3);
  });

  it("关闭开关不改变已开始消息组的节奏，下一轮恢复原流程", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(text);
    });
    const x = make({ model });
    configure(x, { splitReplies: true, messagePacing: true });
    const a = x.h.submit("正在分条", "a");
    await until(() => replies(x, a.runId).length === 1);
    configure(x, { splitReplies: false, messagePacing: false });
    expect(x.store.require("runs", a.runId).status).toBe("running");
    expect(replies(x, a.runId)).toHaveLength(1);
    await x.h.waitForIdle();
    expect(replies(x, a.runId)).toHaveLength(3);
    const b = x.h.submit("普通回复", "b");
    await x.h.waitForIdle();
    expect(replies(x, b.runId).map((m) => m.content)).toEqual([text]);
  });

  it("生成途中插话也会丢弃旧草稿，迟到模型输出不会进入消息", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* (_r, index) {
      if (!index) {
        yield { type: "text", text: "秘密草稿" };
        await gate.promise;
        yield* response("迟到内容");
      } else yield* response("新回复");
    });
    const x = make({ model });
    configure(x);
    const a = x.h.submit("开始生成", "a");
    await until(() => model.requests.length === 1);
    x.h.submit("插话", "b");
    await x.h.waitForIdle();
    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(replies(x, a.runId)).toHaveLength(0);
    expect(JSON.stringify(x.h.snapshot().messages)).not.toMatch(
      /秘密草稿|迟到内容/,
    );
  });

  it("遗忘与来源代数变化后不发布旧消息组的尾段", async () => {
    const x = make({
      model: new ScriptedModel(async function* () {
        yield* response(text);
      }),
    });
    configure(x, { splitReplies: true, messagePacing: true });
    const r = x.h.submit("待遗忘来源", "forget");
    await until(() => replies(x, r.runId).length === 1);
    x.h.forget([r.messageId], []);
    await x.h.waitForIdle();
    expect(replies(x, r.runId)).toHaveLength(0);
    expect(JSON.stringify(x.h.snapshot().messages)).not.toContain("第二件事");
  });

  it("恢复中断的发送组只保留已提交消息，重启不重放剩余草稿", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(text);
    });
    const x = make({ model });
    configure(x, { splitReplies: true, messagePacing: true });
    const r = x.h.submit("进程重启", "restart");
    await until(() => replies(x, r.runId).length === 1);
    x.store.recover(x.clock.now());
    await x.h.close();
    const reopened = make({ dir: x.dir });
    reopened.h.start();
    await reopened.h.waitForIdle();
    expect(reopened.store.require("runs", r.runId).status).toBe("interrupted");
    expect(replies(reopened, r.runId).map((m) => m.content)).toEqual([
      text.split("\n\n")[0],
    ]);
    expect(reopened.store.settings()).toMatchObject({
      splitReplies: true,
      messagePacing: true,
    });
  });

  it("发布事务回滚或已提交后故障，都不泄露草稿或重发已发布气泡", async () => {
    for (const point of [
      "reply_publish.before_commit",
      "reply_publish.after_commit",
    ]) {
      let fired = false;
      const x = make({
        model: new ScriptedModel(async function* () {
          yield* response(text);
        }),
        faults: {
          hit(name) {
            if (!fired && name === point) {
              fired = true;
              throw new Error("synthetic crash");
            }
          },
        },
      });
      configure(x);
      const r = x.h.submit("故障提交", point);
      await x.h.waitForIdle();
      expect(x.store.require("runs", r.runId).status).toBe("failed");
      expect(replies(x, r.runId)).toHaveLength(
        point.endsWith("after_commit") ? 1 : 0,
      );
      expect(JSON.stringify(x.h.snapshot().messages)).not.toContain("第二件事");
    }
  });
});

describe("自然分段与完整内容保护", () => {
  it("按空行或完整句子切分，并保留引号中的句子", () => {
    expect(splitReply("你好呀。今天怎么样？等你慢慢说。")).toEqual([
      "你好呀。",
      "今天怎么样？",
      "等你慢慢说。",
    ]);
    expect(splitReply("她说“你好。别急！”然后笑了。\n\n我也笑了。")).toEqual([
      "她说“你好。别急！”然后笑了。",
      "我也笑了。",
    ]);
    expect(splitReply("很短的一句")).toEqual(["很短的一句"]);
    expect(splitReply("一。二。三。四。五。")).toEqual([
      "一。",
      "二。",
      "三。",
      "四。五。",
    ]);
  });
  it("代码、链接、列表和长解释保持整体可读", () => {
    for (const body of [
      "```ts\nconst a = 1;\n```\n\n说明。",
      "看这里：https://example.com/?a=1\n\n这是说明。",
      "步骤：\n1. 第一件事。\n2. 第二件事。",
      "长解释。".repeat(200),
    ])
      expect(splitReply(body)).toEqual([body]);
  });
});

it("natural pauses are 0.8–1.5 seconds and remain deterministic for short, medium and long messages", async () => {
  const { replyDelayMs } = await import("../src/reply-presentation.js");
  expect(replyDelayMs("短句")).toBe(800);
  expect(replyDelayMs("中".repeat(30))).toBe(1050);
  expect(replyDelayMs("长".repeat(200))).toBe(1500);
});
