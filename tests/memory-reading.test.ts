import { afterEach, describe, expect, it } from "vitest";
import { setup, ScriptedModel, response, finish } from "./helpers.js";
import { buildContext, requestTokens } from "../src/context.js";
import {
  nextRoute,
  prepareMemoryRouting,
  readFacts,
  projectedTokens,
} from "../src/memory/reading.js";
import { Store } from "../src/store.js";
import { tokenEstimate, type Memory } from "../src/domain.js";
import type { TurnMessage } from "../src/model.js";

const cleanup: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanup.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
async function context(
  x: ReturnType<typeof setup>,
  text = "有没有适合我的饮品？",
) {
  const r = x.h.submit(text, crypto.randomUUID());
  await x.h.waitForIdle();
  return buildContext(
    x.store,
    x.store.require("messages", r.messageId),
    x.store.require("runs", r.runId),
    x.clock.now(),
  );
}
function data(c: ReturnType<typeof buildContext>) {
  return JSON.parse(c.messages[0]!.content.split("\n")[1]!);
}

describe("MEM-0 / MEM-1 事实读取和上下文合同", () => {
  it("记忆指令不随是否类问法追加贴题提示，交付记忆的用户指代明确", async () => {
    const x = make();
    x.store.saveSettings({ ...x.store.settings(), autoExtract: false });
    const a = await context(x, "我的同伴住在哪里？");
    const b = await context(x, "我是否也住在那个地方？");
    expect(a.system).toBe(b.system);
    expect(data(a)).not.toHaveProperty("answerGuidance");
    expect(data(b)).not.toHaveProperty("answerGuidance");
    expect(a.system).toContain("当前对话用户");
    for (const fixtureValue of ["陶瓷", "蓝老师", "小栖", "航天", "松子"])
      expect(a.system).not.toContain(fixtureValue);
  });
  it("十条少量事实不依赖查询字面重合，未知属性仍然缺失", async () => {
    const x = make();
    const facts = Array.from({ length: 10 }, (_, i) =>
      x.h.addMemory({ text: `合成资料${i}：偏爱乌龙茶` }),
    );
    const c = await context(x, "午后准备点什么解渴比较好？");
    expect(c.meta.memoryRead).toMatchObject({
      mode: "all",
      routeState: "all",
      allEligibleFactsIncluded: true,
    });
    expect(new Set(c.meta.selected.map((m) => m.id))).toEqual(
      new Set(facts.map((m) => m.id)),
    );
    expect(data(c).memories.some((m: Memory) => m.text.includes("生日"))).toBe(
      false,
    );
    expect(c.meta.budget.steps).toEqual([]);
  });
  it("过滤未确认、解释、期限、失效来源、无来源和现实域；兼容 unspecified", async () => {
    const x = make();
    const legacy = x.h.addMemory({ text: "旧偏好是爬山" });
    const reality = x.h.addMemory({
      text: "线下参加过合成登山赛",
      realityScope: "reality",
    });
    const roleplay = x.h.addMemory({
      text: "虚构登上月球",
      realityScope: "roleplay",
    });
    const interpretation = x.h.addMemory({
      text: "解释",
      category: "interpretation",
    });
    const pending = x.h.addMemory({ text: "未确认" }, true);
    const future = x.h.addMemory({
      text: "未来",
      validFrom: x.clock.now() + 1000,
    });
    const expired = x.h.addMemory({ text: "过去", validTo: x.clock.now() - 1 });
    const sourceless = x.h.addMemory({ text: "无来源" });
    x.store.put("memories", { ...sourceless, sources: [] });
    const stale = x.h.addMemory({ text: "来源变化" });
    const source = x.store.require("sources", stale.sources[0]!.id);
    x.store.put("sources", { ...source, revision: 2 });
    const read = readFacts(x.store, "喜欢什么", x.clock.now());
    expect(read.selected.map((m) => m.id).sort()).toEqual(
      [legacy.id, reality.id].sort(),
    );
    expect(
      readFacts(x.store, "现实履历", x.clock.now()).selected.map((m) => m.id),
    ).toEqual([reality.id]);
    for (const m of [
      roleplay,
      interpretation,
      pending,
      future,
      expired,
      sourceless,
      stale,
    ])
      expect(read.selected.map((f) => f.id)).not.toContain(m.id);
  });
  it.each([1699, 1700, 1701, 1999, 2000, 2001])(
    "固定阈值 %i 及滞后",
    (tokens) => {
      expect(nextRoute("all", tokens)).toBe(tokens > 2000 ? "hybrid" : "all");
      expect(nextRoute("hybrid", tokens)).toBe(
        tokens <= 1700 ? "all" : "hybrid",
      );
    },
  );
  it("真实分流持久化、日摘要独立、不安装语义模型、重启恢复滞后", async () => {
    const x = make();
    while (projectedTokens(x.store.all("memories")) <= 2000)
      x.h.addMemory({ text: "稳定事实".repeat(20) });
    expect(prepareMemoryRouting(x.store, x.clock.now())).toBe("hybrid");
    expect(readFacts(x.store, "毫不相干的检索", x.clock.now())).toMatchObject({
      mode: "keyword",
      state: "degraded",
      allEligibleFactsIncluded: false,
      reasons: ["semantic_not_enabled"],
    });
    const another = new Store(x.dir, x.store.scope);
    try {
      expect(another.settings().memoryReadState?.routeState).toBe("hybrid");
    } finally {
      another.close();
    }
    const all = x.store.all("memories");
    while (projectedTokens(all) > 1950) {
      const m = all.pop()!;
      x.store.put("memories", { ...m, status: "superseded" });
    }
    expect(projectedTokens(all)).toBeGreaterThan(1700);
    x.h.addMemory({
      text: "日摘要".repeat(100),
      kind: "episode",
      pinned: true,
    });
    expect(prepareMemoryRouting(x.store, x.clock.now())).toBe("hybrid");
    while (projectedTokens(all) > 1700) {
      const m = all.pop()!;
      x.store.put("memories", { ...m, status: "superseded" });
    }
    expect(prepareMemoryRouting(x.store, x.clock.now())).toBe("all");
  });
  it("全量扫描不被管理页的 500 / 2000 条上限截断", () => {
    const x = make();
    const template = x.h.addMemory({ text: "最后一条合格事实" });
    x.store.put("memories", { ...template, id: "zz-last" });
    x.store.put("memories", { ...template, status: "superseded" });
    x.store.tx("fixture", () => {
      for (let i = 0; i < 2100; i++)
        x.store.put("memories", {
          ...template,
          id: `invalid-${i.toString().padStart(5, "0")}`,
          sources: [],
        });
    });
    const read = readFacts(x.store, "换说法", x.clock.now());
    expect(read.selected.map((m) => m.id)).toEqual(["zz-last"]);
    expect(read.allEligibleFactsIncluded).toBe(true);
  });
  it("角色严格隔离，不读取未来排队输入产生的事实", async () => {
    const x = make();
    const first = x.h.submit("先输入", "first");
    await x.h.waitForIdle();
    const next = x.h.submit("后输入", "next");
    await x.h.waitForIdle();
    const m = x.h.addMemory({
      text: "未来才告知的事实",
      sourceIds: [next.messageId],
    });
    const r = x.store.require("runs", first.runId);
    expect(
      readFacts(
        x.store,
        "事实",
        x.clock.now(),
        Number(r.config.enqueueSeq),
      ).selected.map((f) => f.id),
    ).not.toContain(m.id);
    const other = new Store(x.dir, {
      ...x.store.scope,
      relationshipId: "other",
    });
    try {
      expect(readFacts(other, "事实", x.clock.now()).selected).toEqual([]);
    } finally {
      other.close();
    }
  });
  it("固定 200 条长聊 fixture：保留原文，近期窗口按完整 Run 裁剪；旧主题找回留给 MEM-3", async () => {
    const x = make();
    const base = x.h.submit("seed", "seed");
    await x.h.waitForIdle();
    const run = x.store.require("runs", base.runId),
      msg = x.store.require("messages", base.messageId);
    x.store.tx("fixture", () => {
      for (let i = 1; i <= 100; i++) {
        const id = `run-${i}`;
        x.store.put("runs", {
          ...run,
          id,
          inputId: `u-${i}`,
          config: { ...run.config, enqueueSeq: i + 1 },
        });
        x.store.put("messages", {
          ...msg,
          id: `u-${i}`,
          runId: id,
          content: `合成话题${i}`,
        });
        x.store.put("messages", {
          ...msg,
          id: `a-${i}`,
          runId: id,
          role: "assistant",
          content: `合成答复${i}`,
          displayed: 20,
        });
      }
    });
    const c = await context(x, "回问第15组决定");
    expect(c.meta.historyIds.length).toBeLessThanOrEqual(24);
    expect(c.meta.budget.history).toBeLessThanOrEqual(4000);
    expect(x.store.require("messages", "u-15").content).toBe("合成话题15");
    expect(c.messages.some((m) => m.content === "合成话题15")).toBe(false);
    for (let i = 0; i < c.meta.historyIds.length; i += 2) {
      expect(x.store.require("messages", c.meta.historyIds[i]!).role).toBe(
        "user",
      );
      expect(x.store.require("messages", c.meta.historyIds[i + 1]!).runId).toBe(
        x.store.require("messages", c.meta.historyIds[i]!).runId,
      );
    }
  });
  it("只投影已展示 UTF-16 前缀，不切断 emoji 或改写原文", async () => {
    const x = make();
    const r = x.h.submit("合成问题", "unicode");
    await x.h.waitForIdle();
    const m = x.store
      .list("messages")
      .find((m) => m.runId === r.runId && m.role === "assistant")!;
    x.store.put("messages", { ...m, content: "好😀秘密尾段", displayed: 2 });
    const c = await context(x);
    const shown = c.messages.find((m) => m.role === "assistant")!;
    expect(shown.content).toBe("好");
    expect(x.store.require("messages", m.id).content).toBe("好😀秘密尾段");
  });
  it("同一快照裁剪确定，预算覆盖包装与工具 Schema；必选超限明确失败", async () => {
    const x = make();
    for (let i = 0; i < 10; i++)
      x.h.addMemory({ text: `条目${i}` + "茶".repeat(30) });
    const base = await context(x);
    const last = x.store.list("runs")[0]!,
      input = x.store.require("messages", last.inputId);
    const options = {
      requestInputBudget: base.meta.estimatedTokens - 300,
      tools: [
        { name: "small", description: "测试", schema: { type: "object" } },
      ],
    };
    const a = buildContext(x.store, input, last, x.clock.now(), options),
      b = buildContext(x.store, input, last, x.clock.now(), options);
    expect(a.meta.budget.steps).toEqual(b.meta.budget.steps);
    expect(a.messages).toEqual(b.messages);
    expect(a.meta.memoryRead.mode).toBe("budget_limited");
    expect(a.meta.memoryRead.routeState).toBe("all");
    expect(
      requestTokens(a.system, a.messages, options.tools),
    ).toBeLessThanOrEqual(options.requestInputBudget);
    expect(a.meta.budget.facts).toBeLessThanOrEqual(2000);
    expect(() =>
      buildContext(x.store, input, last, x.clock.now(), {
        requestInputBudget: 1,
      }),
    ).toThrow("context_budget_exceeded");
  });
  it("工具增长裁剪完整旧交换，保留最新完整组，必选组过大则失败", async () => {
    const x = make();
    const c = await context(x);
    const group = (id: string, size = 700): TurnMessage[] => [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id, name: "read_work_state", input: {} }],
      },
      {
        role: "tool",
        callId: id,
        toolName: "read_work_state",
        content: "x".repeat(size),
      },
    ];
    const fitted = c.fit([...group("a", 3000), ...group("b", 3000)]);
    expect(
      fitted.filter((m) => m.role === "tool").map((m) => m.callId),
    ).toEqual(["b"]);
    expect(c.fit(group("large", 15000)).some((m) => m.callId === "large")).toBe(
      true,
    );
    expect(c.meta.budget.activeToolException).toBe(true);
    expect(() => c.fit(group("huge", 70000))).toThrow(
      "context_budget_exceeded",
    );
    expect(() =>
      c.fit([{ role: "tool", callId: "orphan", content: "x" }]),
    ).toThrow("invalid_tool_transcript");
    expect(requestTokens(c.system, fitted)).toBeLessThanOrEqual(24000);
  });
  it("search_memory 工具与自动上下文共享资格，不回传 pending", async () => {
    const model = new ScriptedModel(async function* (r, i) {
      if (r.purpose === "chat" && i === 0) {
        yield {
          type: "tool",
          call: {
            id: "read",
            name: "search_memory",
            input: { query: "毫不相关" },
          },
        };
        yield { ...finish, reason: "tool-calls" };
      } else yield* response("根据确认资料回答。");
    });
    const x = make({ model });
    const m = x.h.addMemory({ text: "偏爱乌龙茶" });
    x.h.addMemory({ text: "秘密候选" }, true);
    await context(x);
    const result = x.store.all("runs")[0]!;
    const receipt = x.store.toolResult(result.id, "read") as {
      items: { id: string }[];
      mode: string;
    };
    expect(receipt.mode).toBe("all");
    expect(receipt.items.map((m) => m.id)).toEqual([m.id]);
    expect(tokenEstimate(JSON.stringify(receipt))).toBeLessThanOrEqual(1000);
  });
  it("日摘要、跟进、历史按确定顺序退出，低于台阶的空块跳过", async () => {
    const x = make();
    x.h.addMemory({ text: "已确认偏好：茶" });
    x.h.addMemory({ text: "日摘要".repeat(50), kind: "episode", pinned: true });
    x.h.createFollowUp({
      text: "待办".repeat(40),
      dueAt: x.clock.now() + 1000,
      latestAt: x.clock.now() + 100000,
    });
    for (let i = 0; i < 3; i++) {
      const r = x.h.submit("h".repeat(2000), `history-${i}`);
      await x.h.waitForIdle();
      const a = x.store
        .list("messages")
        .find((m) => m.runId === r.runId && m.role === "assistant")!;
      x.h.displayed(a.id, a.content.length);
    }
    const normal = await context(x);
    const last = x.store.list("runs")[0]!,
      input = x.store.require("messages", last.inputId);
    const shrink = (less: number) =>
      buildContext(x.store, input, last, x.clock.now(), {
        requestInputBudget: normal.meta.estimatedTokens - less,
      });
    expect(shrink(50).meta.budget.steps).toEqual(["daily:0"]);
    const more = shrink(normal.meta.budget.daily + 50);
    expect(more.meta.budget.steps).toEqual(["daily:0", "followups:0"]);
    const history = shrink(normal.meta.budget.daily + 500);
    expect(history.meta.budget.steps.slice(0, 3)).toEqual([
      "daily:0",
      "followups:0",
      "history:2000",
    ]);
    expect(normal.meta.budget.steps).toEqual([]);
  });
  it("排队 Run 使用自身现实域快照；未来来源跟进不进入旧 Run", async () => {
    const x = make();
    const reality = x.h.addMemory({
      text: "合成现实资料",
      realityScope: "reality",
    });
    const roleplay = x.h.addMemory({
      text: "合成虚构资料",
      realityScope: "roleplay",
    });
    const first = x.h.submit("现实问法", "scope-first");
    await x.h.waitForIdle();
    const next = x.h.submit("未来输入", "scope-next");
    await x.h.waitForIdle();
    const future = x.h.createFollowUp({
      text: "未来输入生成的提醒",
      sourceIds: [next.messageId],
      dueAt: x.clock.now() + 1000,
      latestAt: x.clock.now() + 10000,
    });
    const settings = x.store.settings();
    x.store.saveSettings({
      ...settings,
      persona: { ...settings.persona, memoryScope: "roleplay" },
    });
    const c = buildContext(
      x.store,
      x.store.require("messages", first.messageId),
      x.store.require("runs", first.runId),
      x.clock.now(),
    );
    expect(c.meta.selected.map((m) => m.id)).toContain(reality.id);
    expect(c.meta.selected.map((m) => m.id)).not.toContain(roleplay.id);
    expect(data(c).followUps.map((f: { id: string }) => f.id)).not.toContain(
      future.id,
    );
  });
});
