import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setup, ScriptedModel, response, deferred, until } from "./helpers.js";
import { buildContext } from "../src/context.js";
import type { Memory } from "../src/domain.js";

const cleanups: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
function source(
  x: ReturnType<typeof setup>,
  id = "source-one",
  text = "我喜欢喝咖啡",
  at = x.clock.now(),
) {
  x.store.put("sources", {
    id,
    text,
    revision: 1,
    kind: "message",
    deleted: false,
    createdAt: at,
  });
  return { id, revision: 1 };
}
function extraction(x: ReturnType<typeof setup>, id = "source-one") {
  x.store.put("jobs", {
    id: "extract-test",
    kind: "extract",
    sources: [{ id, revision: 1 }],
    epoch: x.store.settings().epoch,
    status: "pending",
    attempts: 0,
    createdAt: x.clock.now(),
    nextAt: x.clock.now(),
  });
}

describe("M3 证据、修订与遗忘", () => {
  it("共同经历区分发生时间与得知时间，不把未来计划当已发生", () => {
    const x = make();
    const occurred = Date.parse("2025-06-01T02:00:00Z");
    const m = x.h.addMemory({
      text: "去年一起讨论过一次合成旅行",
      kind: "episode",
      occurredAt: occurred,
      pinned: true,
    });
    expect(m.kind).toBe("episode");
    expect(m.occurredAt).toBeLessThan(m.createdAt);
    expect(() =>
      x.h.addMemory({
        text: "未来计划",
        kind: "episode",
        occurredAt: x.clock.now() + 86400000,
      }),
    ).toThrow("future_plan_is_not_episode");
  });
  it("事实有效期到达前不作为当前事实，过期后不召回", () => {
    const x = make();
    x.h.addMemory({
      text: "未来生效的测试偏好",
      validFrom: x.clock.now() + 1000,
      validTo: x.clock.now() + 2000,
    });
    expect(x.store.search("测试偏好", x.clock.now())).toHaveLength(0);
    x.clock.advance(1500);
    expect(x.store.search("测试偏好", x.clock.now())).toHaveLength(1);
    x.clock.advance(1000);
    expect(x.store.search("测试偏好", x.clock.now())).toHaveLength(0);
  });
  it("确认冲突主题时旧事实失效，确认行为也有来源", () => {
    const x = make();
    const old = x.h.addMemory({ text: "以前喜欢咖啡" });
    x.store.put("memories", { ...old, topic: "饮料" });
    const next = x.h.addMemory(
      {
        text: "现在喜欢茶",
        certainty: "inferred",
        sourceIds: old.sources.map((s) => s.id),
      },
      true,
    );
    x.store.put("memories", { ...next, topic: "饮料" });
    x.h.reviseMemory(next.id, next.revision, { decision: "confirm" });
    expect(x.store.require("memories", old.id).status).toBe("superseded");
    expect(x.store.require("memories", next.id).sources.length).toBeGreaterThan(
      1,
    );
  });
  it("手工确认记忆有独立来源，检索能查中文两字和LIKE特殊字符", () => {
    const { h, store, clock } = make();
    h.addMemory({ text: "小明喜欢100%_纯咖啡", pinned: true });
    expect(store.search("小明", clock.now())).toHaveLength(1);
    expect(store.search("%_", clock.now())).toHaveLength(1);
    expect(store.search("不存在", clock.now())).toHaveLength(0);
  });
  it("删除、过期与源失效结果不进入上下文", () => {
    const x = make();
    const m = x.h.addMemory({ text: "旧偏好", validTo: x.clock.now() + 1 });
    x.clock.advance(2);
    expect(x.store.search("旧偏好", x.clock.now())).toHaveLength(0);
    x.h.forget([], [m.id]);
    expect(x.h.snapshot().memories).toHaveLength(0);
  });
  it("提取只是待确认建议，不能自行提升为偏好事实", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(
        JSON.stringify({
          assertions: [
            {
              text: "用户喜欢咖啡",
              topic: "饮料",
              category: "preference",
              certainty: "stated",
              sourceIds: ["source-one"],
            },
          ],
          openLoops: [],
        }),
      );
    });
    const x = make({ model });
    source(x);
    extraction(x);
    await x.h.tick();
    expect(x.store.list("memories")[0]).toMatchObject({
      status: "pending",
      certainty: "stated",
    });
    const m = x.store.list("memories")[0]!;
    x.h.reviseMemory(m.id, m.revision, { decision: "confirm" });
    expect(x.store.require("memories", m.id).status).toBe("active");
  });
  it("提取引用不存在或不属于当前源范围的ID时整批拒绝", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(
        JSON.stringify({
          assertions: [
            {
              text: "合法候选",
              category: "fact",
              certainty: "stated",
              sourceIds: ["source-one"],
            },
            {
              text: "非法候选",
              category: "fact",
              certainty: "stated",
              sourceIds: ["invented"],
            },
          ],
          openLoops: [],
        }),
      );
    });
    const x = make({ model });
    source(x);
    extraction(x);
    await x.h.tick();
    expect(x.store.list("memories")).toHaveLength(0);
    expect(x.store.require("jobs", "extract-test").status).toBe("failed");
  });
  it.each(["", "not json", '{"assertions":{}}'])(
    "空或无效结构不会推进归纳进度：%s",
    async (output) => {
      const model = new ScriptedModel(async function* () {
        yield* response(output);
      });
      const x = make({ model });
      source(x);
      extraction(x);
      await x.h.tick();
      expect(x.store.require("jobs", "extract-test").status).toBe("failed");
      expect(x.store.list("memories")).toHaveLength(0);
    },
  );
  it("提取途中遗忘，迟到结果不能复活来源", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response(
        JSON.stringify({
          assertions: [
            {
              text: "应被遗忘",
              category: "fact",
              certainty: "stated",
              sourceIds: ["source-one"],
            },
          ],
          openLoops: [],
        }),
      );
    });
    const x = make({ model });
    source(x);
    extraction(x);
    const task = x.h.tick();
    await until(() => model.requests.length === 1);
    x.h.forget(["source-one"], []);
    gate.resolve();
    await task;
    expect(
      x.store.list("memories").filter((m) => m.status !== "deleted"),
    ).toHaveLength(0);
    expect(x.store.require("sources", "source-one").text).toBe("");
  });
  it("提取途中更正源，旧快照不能写入", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response(
        JSON.stringify({
          assertions: [
            {
              text: "旧结论",
              category: "fact",
              certainty: "stated",
              sourceIds: ["source-one"],
            },
          ],
          openLoops: [],
        }),
      );
    });
    const x = make({ model });
    source(x);
    const old = x.h.addMemory({ text: "旧结论", sourceIds: ["source-one"] });
    extraction(x);
    const task = x.h.tick();
    await until(() => model.requests.length === 1);
    x.h.reviseMemory(old.id, old.revision, { text: "更正后的结论" });
    gate.resolve();
    await task;
    expect(
      x.h
        .snapshot()
        .memories.filter((m) => m.status === "active")
        .map((m) => m.text),
    ).toEqual(["更正后的结论"]);
  });
  it("待确认超过20条或到期，归档而不提升事实", () => {
    const x = make();
    source(x);
    for (let i = 0; i < 24; i++)
      x.h.addMemory(
        { text: `建议${i}`, certainty: "inferred", sourceIds: ["source-one"] },
        true,
      );
    expect(
      x.store.list("memories").filter((m) => m.status === "pending"),
    ).toHaveLength(20);
    x.clock.advance(8 * 86400000);
    x.h.addMemory(
      { text: "新建议", certainty: "inferred", sourceIds: ["source-one"] },
      true,
    );
    expect(
      x.store.list("memories").filter((m) => m.status === "pending"),
    ).toHaveLength(1);
  });
  it("更正保留修订关系，旧版本与衍生摘要失效", () => {
    const x = make();
    const ref = source(x);
    const m = x.h.addMemory({ text: "旧偏好", sourceIds: [ref.id] });
    x.store.put("memories", {
      ...m,
      id: "derived",
      kind: "episode",
      day: "2026-10-22",
    });
    const current = x.h.reviseMemory(m.id, m.revision, {
      text: "新的偏好",
    }) as Memory;
    expect(current.previousId).toBe(m.id);
    expect(x.store.require("memories", m.id).status).toBe("superseded");
    expect(x.store.require("memories", "derived").status).toBe("superseded");
    expect(() => x.h.reviseMemory(m.id, 1, { pinned: true })).toThrow(
      "revision_conflict",
    );
  });
  it("遗忘清理原始来源、衍生物、公开事件、Trace与导出", async () => {
    const x = make();
    const r = x.h.submit("我的合成秘密是紫色月亮", "secret");
    await x.h.waitForIdle();
    const m = x.h.addMemory({ text: "紫色月亮", sourceIds: [r.messageId] });
    const exported = x.h.exportData();
    expect(existsSync(join(x.store.exportDir, `${exported.id}.json`))).toBe(
      true,
    );
    x.h.forget([r.messageId], []);
    expect(x.store.require("sources", r.messageId).deleted).toBe(true);
    expect(x.store.require("memories", m.id).text).toBe("");
    expect(x.store.traces()).toHaveLength(0);
    expect(JSON.stringify(x.store.events())).not.toContain("紫色月亮");
    expect(() => x.h.readExport(exported.id)).toThrow("not_found");
    expect(() => x.h.submit("我的合成秘密是紫色月亮", "secret")).toThrow(
      "input_revoked",
    );
  });
  it("仅移除日摘要不删除原始来源，但禁止自动重建", () => {
    const x = make();
    const ref = source(x, "old", "昨天的合成对话", x.clock.now() - 86400000);
    const m: Memory = {
      id: "summary-old",
      kind: "episode",
      day: "2026-10-22",
      category: "fact",
      certainty: "stated",
      text: "昨天的摘要",
      sources: [ref],
      revision: 1,
      status: "active",
      pinned: false,
      manual: false,
      createdAt: x.clock.now(),
    };
    x.store.put("memories", m);
    x.h.forget([], [m.id]);
    expect(x.store.require("sources", "old").deleted).toBe(false);
    expect(x.h.queueSummary()).toMatchObject({
      queued: false,
      reason: "manually_deleted",
    });
  });
  it("同文不同来源不会跨作用域共享缓存或记忆", () => {
    const x = make();
    x.h.addMemory({ text: "相同文本" });
    const other = make({
      scope: { ownerUserId: "other", relationshipId: "other-relationship" },
      dir: x.dir,
    });
    expect(other.store.list("memories")).toHaveLength(0);
    expect(other.store.search("相同文本", other.clock.now())).toHaveLength(0);
    expect(() =>
      other.store.require("memories", x.store.list("memories")[0]!.id),
    ).toThrow("not_found");
  });
  it("删除台账不含原文，恢复时可重复应用且不递增多次epoch", () => {
    const x = make();
    const ref = source(x, "ledger-source", "绝不写入台账的合成文本");
    x.h.forget([ref.id], []);
    const epoch = x.store.settings().epoch;
    x.store.applyLedger();
    expect(x.store.settings().epoch).toBe(epoch);
    expect(readFileSync(x.store.ledgerPath, "utf8")).not.toContain(
      "绝不写入台账",
    );
  });
});

describe("M0 日摘要与固定上下文", () => {
  it("关机漏多天只排最近一个有消息的已结束日，不补空日", () => {
    const x = make();
    source(x, "d1", "较早消息", x.clock.now() - 5 * 86400000);
    source(x, "d2", "最近消息", x.clock.now() - 86400000);
    source(x, "today", "今天消息");
    const queued = x.h.queueSummary();
    expect(queued).toMatchObject({ queued: true, day: "2026-10-22" });
    expect(
      x.store.list("jobs").filter((j) => j.kind === "summary"),
    ).toHaveLength(1);
    expect(x.h.queueSummary()).toMatchObject({ queued: false });
  });
  it("没有历史来源不会为了在场生成摘要", () => {
    const x = make();
    expect(x.h.queueSummary()).toEqual({ queued: false });
    expect(x.store.list("jobs")).toHaveLength(0);
  });
  it("摘要和进度共同提交；写失败时旧摘要回滚", async () => {
    let injected = false;
    const model = new ScriptedModel(async function* () {
      yield* response('{"summary":"新的摘要"}');
    });
    const x = make({
      model,
      faults: {
        hit(p) {
          if (p === "memory_consolidation.before_commit" && !injected) {
            injected = true;
            throw new Error("injected");
          }
        },
      },
    });
    const ref = source(
      x,
      "summary-src",
      "昨天的对话",
      x.clock.now() - 86400000,
    );
    x.store.put("memories", {
      id: "previous",
      kind: "episode",
      day: "2026-10-22",
      text: "旧摘要",
      sources: [ref],
      revision: 1,
      status: "active",
      pinned: false,
      manual: false,
      category: "fact",
      certainty: "stated",
      createdAt: x.clock.now(),
    });
    x.h.queueSummary("2026-10-22");
    await x.h.tick();
    expect(x.store.require("memories", "previous").status).toBe("active");
    expect(x.store.list("memories").some((m) => m.text === "新的摘要")).toBe(
      false,
    );
    expect(x.store.list("jobs")[0]?.status).toBe("failed");
  });
  it("固定顺序选择置顶与最近3自然日，缺失日不向前补", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* () {
      await gate.promise;
      yield* response();
    });
    const x = make({ model });
    const pinned = x.h.addMemory({ text: "置顶确认", pinned: true });
    for (const day of ["2026-10-19", "2026-10-20", "2026-10-22"]) {
      const ref = source(x, `s-${day}`, day);
      x.store.put("memories", {
        id: day,
        kind: "episode",
        day,
        text: `摘要${day}`,
        sources: [ref],
        revision: 1,
        status: "active",
        category: "fact",
        certainty: "stated",
        pinned: false,
        manual: false,
        createdAt: x.clock.now(),
      });
    }
    const receipt = x.h.submit("普通聊天", "ctx");
    await until(() => model.requests.length === 1);
    const data = x.h.context(receipt.runId) as {
      meta: { selected: { id: string }[] };
    };
    expect(data.meta.selected.map((m) => m.id)).toEqual([
      pinned.id,
      "2026-10-20",
      "2026-10-22",
    ]);
    gate.resolve();
    await x.h.waitForIdle();
  });
  it("稳定前缀不含时间，动态时间变化不改变前缀hash", async () => {
    const x = make();
    const r = x.h.submit("你好", "prefix1");
    await x.h.waitForIdle();
    const run = x.store.require("runs", r.runId),
      input = x.store.require("messages", r.messageId);
    const a = buildContext(x.store, input, run, x.clock.now());
    x.clock.advance(10000);
    const b = buildContext(x.store, input, run, x.clock.now());
    expect(a.meta.prefixHash).toBe(b.meta.prefixHash);
    expect(a.messages[0]?.content).not.toBe(b.messages[0]?.content);
  });
  it("只有角色扮演记忆范围会提取虚构偏好，其他角色仍只提取现实事实", async () => {
    const model = new ScriptedModel(async function* () {
      yield* response(JSON.stringify({ assertions: [], openLoops: [] }));
    });
    const x = make({ model });
    source(x, "real-source");
    extraction(x, "real-source");
    await x.h.tick();
    expect(model.requests[0]?.system).toContain("现实事实");
    expect(model.requests[0]?.system).not.toContain("角色扮演中的偏好");
    const s = x.store.settings();
    x.h.publishPersona({ ...s.persona, memoryScope: "roleplay" }, s.revision);
    x.store.put("jobs", {
      id: "extract-roleplay",
      kind: "extract",
      sources: [{ id: "real-source", revision: 1 }],
      epoch: x.store.settings().epoch,
      status: "pending",
      attempts: 0,
      createdAt: x.clock.now(),
      nextAt: x.clock.now(),
    });
    await x.h.tick();
    const roleplay = model.requests.find((r) => r.system.includes("角色扮演"));
    expect(roleplay?.system).toContain("角色扮演中的偏好");
    expect(roleplay?.system).not.toContain("现实事实");
    expect(x.store.settings().persona.memoryScope).toBe("roleplay");
  });
});
