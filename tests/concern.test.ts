import { afterEach, describe, expect, it } from "vitest";
import { setup, ScriptedModel, response, deferred, until } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
function follow(x: ReturnType<typeof setup>, extras = {}) {
  return x.h.createFollowUp({
    text: "合成汇报结束后问问进展",
    dueAt: x.clock.now(),
    latestAt: x.clock.now() + 3600000,
    ...extras,
  });
}

describe("M4 主动关心、准入与真实回执语义", () => {
  it("同一occurrence只创建一份Outbox，重复唤醒不重发", async () => {
    const x = make();
    follow(x);
    await x.h.tick();
    await x.h.tick();
    expect(x.store.list("deliveries")).toHaveLength(1);
    expect(x.store.list("followups")[0]?.status).toBe("ready");
  });
  it("未确认候选不自动获得投递资格", async () => {
    const x = make();
    x.h.createFollowUp(
      {
        text: "推测的习惯",
        dueAt: x.clock.now(),
        latestAt: x.clock.now() + 3600000,
        kind: "candidate",
      },
      false,
    );
    await x.h.tick();
    expect(x.store.list("deliveries")).toHaveLength(0);
  });
  it.each(["focused", "muted", "proactiveEnabled"] as const)(
    "%s限制下不调用模型或创建投递",
    async (key) => {
      const model = new ScriptedModel(async function* () {
        yield* response();
      });
      const x = make({ model });
      const s = x.store.settings();
      x.h.updateSettings({
        expectedRevision: s.revision,
        [key]: key === "proactiveEnabled" ? false : true,
      });
      follow(x);
      await x.h.tick();
      expect(model.requests).toHaveLength(0);
      expect(x.store.list("deliveries")).toHaveLength(0);
    },
  );
  it("当地静默时段默认延期，明确授权打断才例外", async () => {
    const x = make();
    x.clock.advance(12 * 3600000);
    follow(x);
    await x.h.tick();
    expect(x.store.list("deliveries")).toHaveLength(0);
    const y = make();
    y.clock.advance(12 * 3600000);
    follow(y, { allowInterrupt: true });
    await y.h.tick();
    expect(y.store.list("deliveries")).toHaveLength(1);
  });
  it("无在线页面时为offline且未尝试，回来不补弹", async () => {
    const x = make();
    follow(x);
    await x.h.tick();
    const d = x.store.list("deliveries")[0]!;
    expect(d).toMatchObject({ status: "ready", availability: "offline" });
    expect(d.attemptId).toBeUndefined();
    x.h.channel("browser", "granted");
    expect(() =>
      x.h.deliveryEvent(d.id, { event: "attempt", clientId: "browser" }),
    ).toThrow("in_app_only");
  });
  it("浏览器attempt原子认领，构造与点击不冒充已读", async () => {
    const x = make();
    x.h.channel("browser", "granted");
    follow(x);
    await x.h.tick();
    const d = x.store.list("deliveries")[0]!;
    const permit = x.h.deliveryEvent(d.id, {
      event: "attempt",
      clientId: "browser",
    }) as { attemptId: string };
    expect(() =>
      x.h.deliveryEvent(d.id, { event: "attempt", clientId: "browser" }),
    ).toThrow("delivery_already_attempted");
    x.h.deliveryEvent(d.id, {
      event: "constructed",
      clientId: "browser",
      attemptId: permit.attemptId,
    });
    x.h.deliveryEvent(d.id, {
      event: "show",
      clientId: "browser",
      attemptId: permit.attemptId,
    });
    expect(x.store.require("deliveries", d.id).exposure).toBe("unknown");
    x.h.deliveryEvent(d.id, {
      event: "click",
      clientId: "browser",
      attemptId: permit.attemptId,
    });
    expect(x.store.require("deliveries", d.id).clickedAt).toBeDefined();
    expect(x.store.require("deliveries", d.id).exposure).toBe("unknown");
  });
  it("权限拒绝、过期页面与不属于当前attempt的回执不能发送", async () => {
    const x = make();
    x.h.channel("browser", "denied");
    follow(x);
    await x.h.tick();
    const d = x.store.list("deliveries")[0]!;
    expect(d.availability).toBe("permission_denied");
    expect(() =>
      x.h.deliveryEvent(d.id, { event: "attempt", clientId: "browser" }),
    ).toThrow("channel_unavailable");
    expect(() =>
      x.h.deliveryEvent(d.id, {
        event: "click",
        clientId: "browser",
        attemptId: "made-up",
      }),
    ).toThrow("invalid_attempt");
  });
  it("取消先提交则发送被拒；发送已开始则返回inFlight", async () => {
    const x = make();
    x.h.channel("browser", "granted");
    const f = follow(x);
    await x.h.tick();
    const d = x.store.list("deliveries")[0]!;
    x.h.updateFollowUp(f.id, f.revision, "cancel");
    expect(() =>
      x.h.deliveryEvent(d.id, { event: "attempt", clientId: "browser" }),
    ).toThrow("delivery_already_attempted");
    const y = make();
    y.h.channel("browser", "granted");
    const f2 = follow(y);
    await y.h.tick();
    const d2 = y.store.list("deliveries")[0]!;
    y.h.deliveryEvent(d2.id, { event: "attempt", clientId: "browser" });
    expect(y.h.updateFollowUp(f2.id, f2.revision, "cancel").inFlight).toBe(
      true,
    );
  });
  it("生成途中免打扰，发送前重新检查，不投递旧草稿", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response("关心草稿");
    });
    const x = make({ model });
    follow(x);
    const task = x.h.tick();
    await until(() => model.requests.length === 1);
    const s = x.store.settings();
    x.h.updateSettings({ expectedRevision: s.revision, muted: true });
    gate.resolve();
    await task;
    expect(x.store.list("deliveries")).toHaveLength(0);
  });
  it("生成途中取消跟进，迟到草稿不能进Outbox", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response("旧草稿");
    });
    const x = make({ model });
    const f = follow(x);
    const task = x.h.tick();
    await until(() => model.requests.length === 1);
    x.h.updateFollowUp(f.id, f.revision, "cancel");
    gate.resolve();
    await task;
    expect(x.store.list("deliveries")).toHaveLength(0);
  });
  it("页面无回应不追发，也不记录关系变化", async () => {
    const x = make();
    follow(x);
    await x.h.tick();
    x.clock.advance(3600000);
    await x.h.tick();
    expect(x.store.list("deliveries")).toHaveLength(1);
    expect(x.store.list("memories")).toHaveLength(0);
  });
  it("明确反馈才记录曝光，未看到不进入喜欢分母", async () => {
    const x = make();
    follow(x);
    await x.h.tick();
    const d = x.store.list("deliveries")[0]!;
    x.h.feedback(d.id, "not_seen");
    expect(x.store.require("deliveries", d.id).exposure).toBe("unknown");
    x.h.feedback(d.id, "liked");
    expect(x.store.require("deliveries", d.id).exposure).toBe("reported");
  });
  it("超过有效窗口直接过期，不补发陈旧关心", async () => {
    const x = make();
    follow(x);
    x.clock.advance(2 * 3600000);
    await x.h.tick();
    expect(x.store.list("followups")[0]?.status).toBe("expired");
    expect(x.store.list("deliveries")).toHaveLength(0);
  });
  it("虚拟30天：每个一次性事项独立身份，重复tick不重复投递", async () => {
    const x = make();
    for (let day = 0; day < 30; day++) {
      x.h.channel("page", "granted");
      const f = follow(x, { text: `第${day}天的合成事项` });
      await x.h.tick();
      await x.h.tick();
      const deliveries = x.store
        .list("deliveries")
        .filter((d) => d.followUpId === f.id);
      expect(deliveries).toHaveLength(1);
      const d = deliveries[0]!;
      x.h.deliveryEvent(d.id, { event: "attempt", clientId: "page" });
      x.clock.advance(86400000);
    }
    expect(x.store.list("deliveries")).toHaveLength(30);
  });
});
