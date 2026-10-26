import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus, arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { MemoryRetrieval } from "../src/memory/retrieval.js";
import { acquireEmbedding } from "../src/memory/embedding.js";
import { Harness } from "../src/harness.js";
import { MockModel } from "../src/model.js";
import { textHash } from "../src/memory/evidence.js";
import { LOCAL_SCOPE } from "../src/domain.js";
const dir = mkdtempSync(join(tmpdir(), "memory-perf-")),
  out = resolve(
    process.env.MEMORY_PERF_OUT ?? "test-results/memory-performance",
  );
mkdirSync(out, { recursive: true });
const config = loadConfig({
  dataDir: dir,
  modelMode: "mock",
  memoryV2: true,
  memoryVectors: true,
  memorySummaries: false,
});
const store = new Store(dir, LOCAL_SCOPE),
  h = new Harness(store, new MockModel(), config);
const percentile = (a: number[], p: number) =>
  [...a].sort((a, b) => a - b)[Math.floor((a.length - 1) * p)];
const result: Record<string, unknown> = {
  device: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  syntheticOnly: true,
  vectorQualityNotMeasuredByScaleTest: true,
};
try {
  for (let i = 0; i < 100; i++)
    h.addMemory({
      text:
        `合成资料${i}。` +
        "记录中的背景仅用于性能测试，不代表真实用户资料。".repeat(10),
    });
  const start = performance.now();
  h.memory.embedding!.warm();
  const coldReadStart = performance.now(),
    coldRead = await h.memory.facts("资料", Date.now());
  result.modelColdForeground = {
    ms: performance.now() - coldReadStart,
    mode: coldRead.mode,
    reasons: coldRead.reasons,
  };
  for (let i = 0; i < 300 && !h.memory.embedding!.ready; i++)
    await new Promise((r) => setTimeout(r, 100));
  if (!h.memory.embedding!.ready) throw Error("model_not_ready");
  result.loadMs = performance.now() - start;
  const concurrent: number[] = [],
    reasons: string[][] = [];
  for (let i = 0; i < 100; i++) {
    const indexing = h.memory.indexOne(
      new AbortController().signal,
      Date.now(),
    );
    const t = performance.now();
    const r = await h.memory.facts("资料", Date.now());
    concurrent.push(performance.now() - t);
    reasons.push(r.reasons);
    await indexing;
    if (i % 20 === 19) console.log(`background_queries ${i + 1}/100`);
  }
  const idle: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    await h.memory.facts("资料", Date.now());
    idle.push(performance.now() - t);
  }
  result.underIndexing = {
    n: 100,
    p50Ms: percentile(concurrent, 0.5),
    p95Ms: percentile(concurrent, 0.95),
    p99Ms: percentile(concurrent, 0.99),
    deadlineFallbacks: reasons.filter((rs) =>
      rs.some((r) => /timeout|busy/.test(r)),
    ).length,
  };
  result.idle = {
    n: 100,
    p50Ms: percentile(idle, 0.5),
    p95Ms: percentile(idle, 0.95),
    p99Ms: percentile(idle, 0.99),
  };
  const worker = new Worker(
    new URL("../src/memory/scan-worker.mjs", import.meta.url),
  );
  let serial = 0;
  const request = (
    data: Record<string, unknown>,
    transfer: ArrayBuffer[] = [],
  ) =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      const id = String(++serial),
        timer = setTimeout(() => fail(Error("scan_timeout")), 5000);
      const receive = (r: Record<string, unknown>) => {
        if (r.id !== id) return;
        clearTimeout(timer);
        worker.off("message", receive);
        ok(r);
      };
      worker.on("message", receive);
      worker.postMessage({ id, ...data }, transfer);
    });
  const scales = [];
  try {
    for (const n of [50, 500, 5000, 25000]) {
      const buffers = Array.from({ length: n }, () => {
        const v = new Float32Array(384);
        v[0] = 1;
        return v.buffer;
      });
      await request(
        {
          kind: "load",
          scope: "benchmark",
          generation: n,
          rows: buffers.map((buffer, i) => ({ id: String(i), buffer })),
        },
        buffers,
      );
      const timings: number[] = [],
        mask = new Uint8Array(Math.ceil(n / 8)).fill(255),
        q = new Float32Array(384);
      q[0] = 1;
      for (let i = 0; i < 100; i++) {
        const t = performance.now();
        await request({
          kind: "query",
          scope: "benchmark",
          generation: n,
          mask: mask.buffer,
          vector: q.buffer,
        });
        timings.push(performance.now() - t);
      }
      scales.push({
        rows: n,
        n: 100,
        p50Ms: percentile(timings, 0.5),
        p95Ms: percentile(timings, 0.95),
        p99Ms: percentile(timings, 0.99),
      });
    }
  } finally {
    await worker.terminate();
  }
  result.residentScanWithIPC = scales;
  const hydrated = [];
  const template = h.addMemory({ text: "容量测试", realityScope: "reality" });
  for (const n of [50, 500, 5000, 25000]) {
    h.memory.invalidate();
    const values = store.db.prepare(
        "INSERT INTO memories(id,owner,relationship,created_at,data) VALUES(?,?,?,?,?)",
      ),
      vectors = store.db.prepare(
        "INSERT INTO memory_embeddings(owner,relationship,memoryId,memoryRevision,chunkId,spanStartUtf16,spanEndUtf16,textHash,sourceFingerprint,modelKey,dimension,vector,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ),
      scope = [store.scope.ownerUserId, store.scope.relationshipId],
      modelKey = h.memory.embedding!.modelKey,
      vector = new Float32Array(384);
    vector[0] = 1;
    store.db.transaction(() => {
      for (const table of [
        "memory_embeddings",
        "memory_index_state",
        "memory_fts",
        "memories",
      ])
        store.db
          .prepare(`DELETE FROM ${table} WHERE owner=? AND relationship=?`)
          .run(...scope);
      for (let i = 0; i < n; i++) {
        const m = {
          ...template,
          id: `capacity-${String(i).padStart(6, "0")}`,
          text: `容量合成条目${i}。` + "背景占位文字不代表用户资料。".repeat(5),
        };
        values.run(m.id, ...scope, m.createdAt, JSON.stringify(m));
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
          Buffer.from(vector.buffer),
          m.createdAt,
        );
      }
    })();
    store.bumpMemoryVersion("memoryVersion");
    store.bumpMemoryVersion("indexVersion");
    const lag: number[] = [];
    let expected = performance.now() + 5;
    const timer = setInterval(() => {
      const current = performance.now();
      lag.push(Math.max(0, current - expected));
      expected = current + 5;
    }, 5);
    const t = performance.now(),
      cold = await h.memory.facts("用户偏好线索", Date.now()),
      coldMs = performance.now() - t;
    const timings: number[] = [],
      fallbacks: string[][] = [],
      modes: string[] = [];
    let firstHybridMs: number | undefined =
      cold.mode === "hybrid" ? coldMs : undefined;
    for (let i = 0; i < 100; i++) {
      const start = performance.now(),
        r = await h.memory.facts("用户偏好线索", Date.now());
      timings.push(performance.now() - start);
      fallbacks.push(r.reasons);
      modes.push(r.mode);
      if (r.mode === "hybrid" && firstHybridMs === undefined)
        firstHybridMs = performance.now() - t;
    }
    clearInterval(timer);
    hydrated.push({
      eventLoopMaxLagMs: Math.max(0, ...lag),
      facts: n,
      n: 100,
      coldMs,
      coldMode: cold.mode,
      coldReasons: cold.reasons,
      startupLoadingReads: [cold.reasons, ...fallbacks].filter((rs) =>
        rs.includes("memory_snapshot_loading"),
      ).length,
      hybridReads: modes.filter((mode) => mode === "hybrid").length,
      firstHybridMs,
      steadyFallbacks: modes
        .slice(Math.max(0, modes.indexOf("hybrid")))
        .filter((mode) => mode !== "hybrid").length,
      maxMs: Math.max(...timings),
      over250ms: timings.filter((t) => t > 250).length,
      timingsMs: timings,
      reasons: fallbacks,
      modes,
      p50Ms: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      p99Ms: percentile(timings, 0.99),
      deadlineFallbacks: fallbacks.filter((rs) =>
        rs.some((r) => /timeout|busy/.test(r)),
      ).length,
    });
    console.log(`hydrated_capacity ${n}`);
  }
  result.fullRuntimeWithSyntheticResidentVectors = hydrated;
  const repeated = [];
  for (let trial = 0; trial < 3; trial++) {
    const reopened = new Store(dir, LOCAL_SCOPE);
    reopened.enableMemoryV2();
    const memory = new MemoryRetrieval(
      reopened,
      acquireEmbedding(config.memoryPython, config.memoryModelPath),
    );
    try {
      const start = performance.now(),
        cold = await memory.facts("用户偏好线索", Date.now()),
        coldMs = performance.now() - start,
        rows = [];
      for (let i = 0; i < 100; i++) {
        const t = performance.now(),
          r = await memory.facts("用户偏好线索", Date.now());
        rows.push({
          ms: performance.now() - t,
          mode: r.mode,
          reasons: r.reasons,
        });
      }
      const times = rows.map((r) => r.ms),
        first = rows.findIndex((r) => r.mode === "hybrid");
      repeated.push({
        trial,
        coldMs,
        coldMode: cold.mode,
        coldReasons: cold.reasons,
        n: rows.length,
        p50Ms: percentile(times, 0.5),
        p95Ms: percentile(times, 0.95),
        p99Ms: percentile(times, 0.99),
        maxMs: Math.max(...times),
        over250ms: times.filter((t) => t > 250).length,
        hybridReads: rows.filter((r) => r.mode === "hybrid").length,
        steadyFallbacks:
          first < 0
            ? rows.length
            : rows.slice(first).filter((r) => r.mode !== "hybrid").length,
        startupLoadingReads: rows.filter((r) =>
          r.reasons.includes("memory_snapshot_loading"),
        ).length,
        deadlineFallbacks: rows.filter((r) =>
          r.reasons.some((reason) => /timeout|busy/.test(reason)),
        ).length,
        rows,
      });
      console.log(`reopened_25000 ${trial + 1}/3`);
    } finally {
      memory.close();
      reopened.close();
    }
  }
  result.reopened25000 = repeated;
  const gateFailures = [...hydrated, ...repeated]
    .filter(
      (r) =>
        r.coldMs > 250 ||
        r.over250ms > 0 ||
        r.deadlineFallbacks > 0 ||
        r.hybridReads === 0 ||
        r.steadyFallbacks > 0,
    )
    .map((r) => ({
      facts: "facts" in r ? r.facts : 25000,
      ...("trial" in r ? { trial: r.trial } : {}),
      coldMs: r.coldMs,
      over250ms: r.over250ms,
      deadlineFallbacks: r.deadlineFallbacks,
      hybridReads: r.hybridReads,
      steadyFallbacks: r.steadyFallbacks,
    }));
  result.gate = {
    budgetMs: 250,
    includesColdAndAllSamples: true,
    allowsExplicitStartupLoading: true,
    passed:
      gateFailures.length === 0 &&
      (result.modelColdForeground as { ms: number }).ms <= 250,
    failures: gateFailures,
  };
  if (
    process.argv.includes("--assert") &&
    !(result.gate as { passed: boolean }).passed
  )
    throw Error("memory_latency_gate_failed");
} catch (e) {
  result.error = e instanceof Error ? e.message : "failed";
  process.exitCode = 1;
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
