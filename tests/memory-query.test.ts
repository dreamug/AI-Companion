import { afterEach, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { memoryQuery } from "../src/memory/query.js";
import { readFacts } from "../src/memory/reading.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
it.each([
  ["我的职业是做什么的？", "从事"],
  ["我现在做什么工作？", "职业"],
  ["我现在干哪一行？", "任职"],
  ["你该怎么叫我才合我心意？", "称呼"],
  ["我的昵称是什么？", "昵称"],
  ["姐姐想让别人怎么称呼她？", "称呼"],
])("通用问法 %s 在语义未就绪时也能经别名找到有依据记录", (question, anchor) => {
  const x = setup({ config: { memoryV2: true, memorySummaries: false } });
  cleanup.push(x.dispose);
  for (let i = 0; i < 40; i++)
    x.h.addMemory({ text: `合成无关资料${i}：仅用于达到混合模式阈值` });
  const work = x.h.addMemory({ text: "用户从事锔瓷修复，职业是文物修复师。" }),
    name = x.h.addMemory({
      text: "用户希望被称呼为小栖；姐姐希望被称呼为蓝老师。",
    });
  const r = readFacts(x.store, question, x.clock.now());
  expect(r.selected.map((m) => m.id)).toContain(
    ["从事", "职业", "任职"].includes(anchor) ? work.id : name.id,
  );
  expect(r.allEligibleFactsIncluded).toBe(false);
});
it("别名扩展不放宽确认、来源、域和时态资格", () => {
  const x = setup({ config: { memoryV2: true, memorySummaries: false } });
  cleanup.push(x.dispose);
  for (let i = 0; i < 40; i++)
    x.h.addMemory({ text: `合成背景${i}：达到混合检索规模` });
  const pending = x.h.addMemory(
      { text: "用户希望被称呼为错误待确认昵称" },
      true,
    ),
    role = x.h.addMemory({ text: "虚构称呼是长官", realityScope: "roleplay" }),
    expired = x.h.addMemory({ text: "旧称呼是旧名字", validTo: x.clock.now() }),
    stale = x.h.addMemory({ text: "失效称呼是错误名字" }),
    valid = x.h.addMemory({ text: "希望被称呼为小栖" });
  const source = x.store.require("sources", stale.sources[0]!.id);
  x.store.put("sources", { ...source, revision: source.revision + 1 });
  const r = readFacts(x.store, "你该怎么叫我才合我心意？", x.clock.now());
  expect(r.selected.map((m) => m.id)).toEqual([valid.id]);
  expect(r.selected.map((m) => m.id)).not.toEqual(
    expect.arrayContaining([pending.id, role.id, expired.id, stale.id]),
  );
});
it.each([
  "姐姐以前不从事什么工作？",
  "角色阿青现在的昵称，别和姐姐混淆。",
  "前天说的工作岗位，尚未入职。",
  "😀𠮷".repeat(20) + "职业不是医生，尚未入职。",
])("保留原问题里的主体、否定和时间：%s", (query) => {
  expect(
    memoryQuery(query).embeddingText.startsWith(query.normalize("NFKC")),
  ).toBe(true);
});
it.each(["今天吃什么？", "周末去哪里？", "这家饭店的叫号是什么？"])(
  "无明确职业或称呼意图时不添词：%s",
  (query) => {
    expect(memoryQuery(query)).toEqual({
      embeddingText: query.normalize("NFKC"),
      keywords: [],
    });
  },
);

it("上下文候选缓存不能被调用者篡改或被回滚事务污染", () => {
  const x = setup({ config: { memoryV2: true, memorySummaries: false } });
  cleanup.push(x.dispose);
  const memory = x.h.addMemory({ text: "原始置顶事实", pinned: true });
  const view = x.store.contextMemories();
  view[0]!.text = "不能写回";
  view[0]!.sources[0]!.id = "fake";
  expect(x.store.contextMemories()[0]).toEqual(memory);
  expect(() =>
    x.store.tx("context-cache-rollback", () => {
      x.store.put("memories", { ...memory, pinned: false, revision: 2 });
      expect(x.store.contextMemories()).toEqual([]);
      throw Error("rollback");
    }),
  ).toThrow("rollback");
  expect(x.store.contextMemories()).toEqual([memory]);
  x.h.forget([], [memory.id]);
  expect(x.store.contextMemories()).toEqual([]);
});
