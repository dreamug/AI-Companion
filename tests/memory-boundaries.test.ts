import { afterEach, describe, it, expect } from "vitest";
import { setup, deferred } from "./helpers.js";
import { readFacts, eligibleFact } from "../src/memory/reading.js";
import { MemoryRetrieval } from "../src/memory/retrieval.js";
import type { EmbeddingPort } from "../src/memory/embedding.js";
import { type Memory } from "../src/domain.js";
import { captureMessage, textHash } from "../src/memory/evidence.js";
const cleanup: (() => Promise<void>)[] = [];
function make() {
  const x = setup({ config: { memoryV2: true, memorySummaries: false } });
  cleanup.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
const combinations = (
  ["active", "pending", "deleted", "superseded"] as const
).flatMap((status) =>
  (["confirmed", "stated", "inferred", "disputed"] as const).flatMap(
    (certainty) =>
      (["fact", "preference", "interpretation"] as const).map((category) => ({
        status,
        certainty,
        category,
      })),
  ),
);
describe("记忆资格与状态组合", () => {
  it.each(combinations)(
    "$status / $certainty / $category，叠加来源、时间和域边界",
    (c) => {
      const x = make(),
        base = x.h.addMemory({ text: "边界测试", realityScope: "reality" });
      const now = x.clock.now();
      for (const refs of [base.sources, [], [{ id: "missing", revision: 1 }]])
        for (const span of [
          { validFrom: now - 1, validTo: now + 1 },
          { validFrom: now, validTo: now + 1 },
          { validFrom: now + 1, validTo: now + 2 },
          { validFrom: now - 1, validTo: now },
          { validFrom: now - 2, validTo: now - 1 },
        ]) {
          const m: Memory = { ...base, ...c, sources: refs, ...span };
          x.store.put("memories", m);
          const valid =
            c.status === "active" &&
            c.certainty === "confirmed" &&
            c.category !== "interpretation" &&
            refs.length > 0 &&
            refs[0]?.id !== "missing" &&
            span.validFrom <= now &&
            span.validTo > now;
          expect(eligibleFact(x.store, m, now)).toBe(valid);
          expect(
            [...x.store.qualifiedFacts(now)].some((f) => f.id === m.id),
          ).toBe(valid);
          expect(
            readFacts(x.store, "测试", now).selected.some((f) => f.id === m.id),
          ).toBe(valid);
          x.store.put("memories", { ...m, realityScope: "roleplay" });
          expect(
            readFacts(x.store, "测试", now).selected.some((f) => f.id === m.id),
          ).toBe(false);
        }
    },
  );
  it("分页真正读完全部合格事实，快照变更和跨scope游标拒绝", async () => {
    const x = make();
    for (let i = 0; i < 35; i++) x.h.addMemory({ text: `偏好${i}：合成内容` });
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 40; i++) {
      const page = await x.h.memory.search(
        "列出全部偏好",
        "facts",
        x.clock.now(),
        Infinity,
        undefined,
        { cursor, limit: 3 },
      );
      for (const m of page.items) seen.add(m.id);
      cursor = "nextCursor" in page ? page.nextCursor : undefined;
      if (!cursor) break;
    }
    expect(seen.size).toBe(35);
    const page = await x.h.memory.search(
      "全部",
      "facts",
      x.clock.now(),
      Infinity,
      undefined,
      { limit: 2 },
    );
    const first = "nextCursor" in page ? page.nextCursor : undefined;
    expect(first).toBeTruthy();
    x.h.addMemory({ text: "变更快照" });
    await expect(
      x.h.memory.search("全部", "facts", x.clock.now(), Infinity, undefined, {
        cursor: first,
      }),
    ).rejects.toThrow("memory_cursor_invalidated");
  });
  it("查询取消及遗忘不等待慢编码；pending和索引版本不造成事实快照失效", async () => {
    const x = make();
    for (let i = 0; i < 35; i++)
      x.h.addMemory({ text: `已确认${i}：独立资料` });
    const gate = deferred();
    const port: EmbeddingPort = {
      modelKey: "gate",
      ready: true,
      warm() {},
      async encode(_t, _k, _s, signal) {
        await Promise.race([
          gate.promise,
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(Error("cancelled")), {
              once: true,
            }),
          ),
        ]);
        return Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
      },
      close() {},
    };
    const service = new MemoryRetrieval(x.store, port, () => x.clock.now());
    cleanup.unshift(async () => service.close());
    const promise = service.facts("资料", x.clock.now());
    x.h.addMemory({ text: "未确认" }, true);
    expect(x.store.memoryState().memoryVersion).toBe(35);
    service.invalidate();
    await expect(promise).rejects.toThrow();
    gate.resolve();
  });
  it("单个超长事实返回有标记的头尾节选，原文未被截断覆盖", () => {
    const x = make(),
      text =
        "限定：以下仅为虚构设定。" +
        "合成背景".repeat(600) +
        "角色的暗号是凌霄，不是紫藤。";
    const m = x.h.addMemory({ text, realityScope: "reality", pinned: true });
    const r = readFacts(x.store, "暗号", x.clock.now());
    expect(
      r.selected.some(
        (f) =>
          f.id === m.id &&
          f.excerpt &&
          f.text.includes("凌霄") &&
          f.text.includes("不是紫藤"),
      ),
    ).toBe(true);
    expect(x.store.require("memories", m.id).text).toBe(text);
    expect(r.allEligibleFactsIncluded).toBe(false);
    expect(r.reasons).toContain("memory_excerpt");
  });
  it("摘要重建必须是显式命令，原始来源被删后不能重建", async () => {
    const x = make();
    const r = x.h.submit("决定使用木槿", "source");
    await x.h.waitForIdle();
    const ref = captureMessage(x.store, r.messageId);
    x.store.put("conversation_summaries", {
      id: "summary",
      segmentId: "segment",
      rangeKey: "range",
      inputRefs: [ref],
      inputHash: textHash("range"),
      policyVersion: "raw-block-v1",
      text: "木槿",
      coverage: {
        messageIds: [r.messageId],
        firstSeq: 1,
        lastSeq: 1,
        partial: false,
      },
      status: "active",
      rebuildBlocked: false,
      revision: 1,
      createdAt: x.clock.now(),
      sources: [{ id: r.messageId, revision: 1 }],
    });
    x.h.forget([], [], ["summary"]);
    const s = x.store.require("conversation_summaries", "summary");
    const job = x.h.rebuildConversationSummary(s.id, s.revision);
    expect(job.requested).toBe(true);
    x.h.forget([r.messageId], []);
    expect(() =>
      x.h.rebuildConversationSummary(
        s.id,
        x.store.require("conversation_summaries", s.id).revision,
      ),
    ).toThrow("invalid_evidence");
  });
});
