import { afterEach, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { MemoryRetrieval } from "../src/memory/retrieval.js";
import { textHash } from "../src/memory/evidence.js";
import type { EmbeddingPort } from "../src/memory/embedding.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
const unit = (axis: number) =>
  Float32Array.from({ length: 384 }, (_, i) => Number(i === axis));
it("25000条：冷读有界、热读真实扫描命中、取消释放；来源失效后缓存不得复活", async () => {
  const x = setup({ config: { memoryV2: true, memorySummaries: false } });
  cleanup.push(x.dispose);
  const template = x.h.addMemory({
      text: "容量回归：合成资料",
      realityScope: "reality",
    }),
    scope = [x.store.scope.ownerUserId, x.store.scope.relationshipId],
    modelKey = "scale-unit-v1",
    n = 25000,
    target = "scale-24999";
  const insert = x.store.db.prepare(
      "INSERT INTO memories(id,owner,relationship,created_at,data) VALUES(?,?,?,?,?)",
    ),
    vectors = x.store.db.prepare(
      "INSERT INTO memory_embeddings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
  x.store.db.transaction(() => {
    x.store.db.prepare("DELETE FROM memories WHERE id=?").run(template.id);
    for (let i = 0; i < n; i++) {
      const m = {
        ...template,
        id: `scale-${String(i).padStart(5, "0")}`,
        text: `合成条目${i}，与查询没有字面重合。`,
      };
      insert.run(m.id, ...scope, m.createdAt, JSON.stringify(m));
      const fp = textHash(
        JSON.stringify([
          m.id,
          m.revision,
          m.text,
          m.sources,
          m.realityScope,
          m.validFrom,
          m.validTo,
        ]),
      );
      vectors.run(
        ...scope,
        m.id,
        m.revision,
        "0",
        0,
        m.text.length,
        textHash(m.text),
        fp,
        modelKey,
        384,
        Buffer.from(unit(i === n - 1 ? 0 : 1).buffer),
        m.createdAt,
      );
    }
  })();
  x.store.bumpMemoryVersion("memoryVersion");
  x.store.bumpMemoryVersion("indexVersion");
  let modelReady = true;
  const port: EmbeddingPort = {
      modelKey,
      get ready() {
        return modelReady;
      },
      warm() {},
      close() {},
      async encode() {
        return [...unit(0)];
      },
    },
    service = new MemoryRetrieval(x.store, port, () => x.clock.now());
  cleanup.unshift(async () => service.close());
  const times: number[] = [],
    start = performance.now();
  const cold = await service.facts("未知线索", x.clock.now());
  expect(performance.now() - start).toBeLessThan(300);
  let ready = cold.mode === "hybrid";
  const history: unknown[] = [],
    warming = performance.now();
  while (performance.now() - warming < 5000 && !ready) {
    const t = performance.now(),
      r = await service.facts("未知线索", x.clock.now());
    history.push({
      ms: performance.now() - t,
      mode: r.mode,
      reasons: r.reasons,
    });
    ready = r.mode === "hybrid";
  }
  expect(ready, JSON.stringify(history)).toBe(true);
  for (let i = 0; i < 12; i++) {
    const t = performance.now(),
      r = await service.facts("未知线索", x.clock.now());
    times.push(performance.now() - t);
    expect(r.mode).toBe("hybrid");
    expect(r.selected[0]?.id).toBe(target);
    expect(r.reasons).toEqual([]);
  }
  expect(Math.max(...times)).toBeLessThan(250);
  service.invalidate();
  modelReady = false;
  const version = x.store.memoryState();
  await service.prewarm(x.clock.now());
  expect(x.store.memoryState()).toEqual(version);
  modelReady = true;
  const prewarmed = await service.facts("未知线索", x.clock.now());
  expect(prewarmed.mode).toBe("hybrid");
  expect(prewarmed.selected[0]?.id).toBe(target);
  expect(prewarmed.reasons).toEqual([]);
  service.invalidate();
  const abort = new AbortController(),
    pending = service.facts(
      "未知线索",
      x.clock.now(),
      Infinity,
      2000,
      undefined,
      abort.signal,
    );
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  const source = x.store.require("sources", template.sources[0]!.id);
  x.store.put("sources", { ...source, revision: source.revision + 1 });
  const r = await service.facts("未知线索", x.clock.now());
  expect(r.selected).toEqual([]);
  expect(r.allEligibleFactsIncluded).toBe(true);
}, 12000);
