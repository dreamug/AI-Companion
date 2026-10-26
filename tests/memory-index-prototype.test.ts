import { afterEach, it, expect } from "vitest";
import { IndexPrototype } from "../scripts/memory-lab/index-prototype.js";
import { setup } from "./helpers.js";
import { LOCAL_SCOPE } from "../src/domain.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function fixture(relationshipId = LOCAL_SCOPE.relationshipId) {
  const x = setup({ scope: { ...LOCAL_SCOPE, relationshipId } });
  const index = new IndexPrototype(x.store, "test:2");
  cleanup.push(x.dispose, async () => index.close());
  return { ...x, index };
}
it("索引候选在读取时核验确认状态、来源与时间", () => {
  const x = fixture(),
    m = x.h.addMemory({ text: "虚构用户喜欢乌龙茶" });
  expect(x.index.commit(x.index.capture(m), [1, 0])).toBe(true);
  expect(x.index.candidates(x.clock.now())).toHaveLength(1);
  const s = x.store.require("sources", m.sources[0]!.id);
  x.store.put("sources", { ...s, revision: s.revision + 1 });
  expect(x.index.candidates(x.clock.now())).toHaveLength(0);
});
it("更正使旧向量失效，迟到任务不能替旧记录重新建索引", () => {
  const x = fixture(),
    m = x.h.addMemory({ text: "旧偏好喜欢咖啡" }),
    job = x.index.capture(m);
  x.index.commit(job, [1, 0]);
  x.h.reviseMemory(m.id, m.revision, { text: "现在改喝茶" });
  expect(x.index.candidates(x.clock.now())).toHaveLength(0);
  expect(x.index.commit(job, [1, 0])).toBe(false);
});
it("遗忘代数拒绝迟到写入，遗留向量也不能返回事实", () => {
  const x = fixture(),
    m = x.h.addMemory({ text: "合成待删除记忆" }),
    job = x.index.capture(m);
  x.index.commit(job, [1, 0]);
  x.h.forget([], [m.id]);
  expect(x.index.commit(job, [1, 0])).toBe(false);
  expect(x.index.candidates(x.clock.now())).toHaveLength(0);
  x.index.remove(m.id);
  expect(x.index.db.prepare("SELECT count(*) n FROM vectors").get()).toEqual({
    n: 0,
  });
});
it("跨角色任务不能写入，另一个角色的事实不能作为候选", () => {
  const a = fixture(),
    b = fixture("other-bot"),
    m = a.h.addMemory({ text: "A的秘密名字" });
  expect(b.index.commit(a.index.capture(m), [1, 0])).toBe(false);
  expect(b.index.candidates(b.clock.now())).toHaveLength(0);
});
it("取消能释放不响应signal的索引等待，迟到结果不写入", async () => {
  const x = fixture(),
    m = x.h.addMemory({ text: "合成取消任务" });
  let release!: (v: number[]) => void;
  const c = new AbortController();
  const pending = x.index.indexAsync(
    m,
    async () =>
      new Promise((r) => {
        release = r;
      }),
    c.signal,
  );
  c.abort();
  expect(await pending).toBe(false);
  release([1, 0]);
  expect(x.index.candidates(x.clock.now())).toHaveLength(0);
});
it("提供方失败不破坏关键词搜索，索引可从有效事实重建", async () => {
  const x = fixture(),
    m = x.h.addMemory({ text: "合成用户喜欢乌龙茶" });
  expect(
    await x.index.indexAsync(
      m,
      async () => {
        throw Error("synthetic failure");
      },
      new AbortController().signal,
    ),
  ).toBe(false);
  expect(
    x.store.search("乌龙茶", x.clock.now()).some((v) => v.id === m.id),
  ).toBe(true);
  const rebuilt = new IndexPrototype(x.store, "test:2");
  try {
    expect(rebuilt.commit(rebuilt.capture(m), [1, 0])).toBe(true);
    expect(rebuilt.candidates(x.clock.now())).toHaveLength(1);
  } finally {
    rebuilt.close();
  }
});
it("生成向量期间发生遗忘，任务完成也不能重新写入", async () => {
  const x = fixture(),
    m = x.h.addMemory({ text: "合成遗忘竞态" });
  let release!: (v: number[]) => void;
  const pending = x.index.indexAsync(
    m,
    async () =>
      new Promise((r) => {
        release = r;
      }),
    new AbortController().signal,
  );
  x.h.forget([], [m.id]);
  release([1, 0]);
  expect(await pending).toBe(false);
  expect(x.index.candidates(x.clock.now())).toHaveLength(0);
});
it("待确认、已过期和未到生效时间的事实不进入候选", () => {
  const x = fixture();
  for (const opts of [
    { automatic: true },
    { validTo: x.clock.now() - 1 },
    { validFrom: x.clock.now() + 10000 },
  ]) {
    const m = x.h.addMemory(
      {
        text: "合成时间或待确认事实",
        validTo: "validTo" in opts ? opts.validTo : undefined,
        validFrom: "validFrom" in opts ? opts.validFrom : undefined,
      },
      "automatic" in opts,
    );
    x.index.commit(x.index.capture(m), [1, 0]);
  }
  expect(x.index.candidates(x.clock.now())).toHaveLength(0);
});
it("错误版本、维度或数值的向量不能写入", () => {
  const x = fixture(),
    m = x.h.addMemory({ text: "合成记忆" }),
    job = x.index.capture(m);
  expect(x.index.commit({ ...job, model: "other:2" }, [1, 0])).toBe(false);
  expect(x.index.commit(job, [1])).toBe(false);
  expect(x.index.commit(job, [NaN, 0])).toBe(false);
});
