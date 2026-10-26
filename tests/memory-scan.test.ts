import { afterEach, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
function scanner() {
  const w = new Worker(
    new URL("../src/memory/scan-worker.mjs", import.meta.url),
  );
  cleanup.push(() => w.terminate());
  let serial = 0;
  return (data: Record<string, unknown>, transfer: ArrayBuffer[] = []) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = String(++serial),
        timer = setTimeout(() => {
          w.off("message", receive);
          reject(Error("timeout"));
        }, 3000),
        receive = (r: Record<string, unknown>) => {
          if (r.id !== id) return;
          clearTimeout(timer);
          w.off("message", receive);
          resolve(r);
        };
      w.on("message", receive);
      w.postMessage({ id, ...data }, transfer);
    });
}
it("整块矩阵与旧分行协议、穷举余弦排序一致，含掩码与相同分数", async () => {
  const request = scanner(),
    n = 257,
    dim = 384,
    matrix = new Float32Array(n * dim),
    ids = Array.from(
      { length: n },
      (_, i) => `row-${i.toString().padStart(4, "0")}`,
    ),
    q = new Float32Array(dim);
  q[0] = 1;
  let seed = 7122026;
  for (let i = 0; i < n; i++) {
    let norm = 0;
    for (let j = 0; j < dim; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = seed / 2 ** 32 - 0.5;
      matrix[i * dim + j] = value;
      norm += value * value;
    }
    for (let j = 0; j < dim; j++)
      matrix[i * dim + j] = matrix[i * dim + j]! / Math.sqrt(norm);
  }
  matrix.set(matrix.subarray(0, dim), dim);
  const expectedMatrix = matrix.slice();
  await request(
    {
      kind: "load",
      scope: "packed",
      generation: 1,
      ids,
      matrix: matrix.buffer,
    },
    [matrix.buffer],
  );
  expect(matrix.byteLength).toBe(0);
  const buffers = ids.map(
    (_, i) => expectedMatrix.slice(i * dim, (i + 1) * dim).buffer,
  );
  await request(
    {
      kind: "load",
      scope: "legacy",
      generation: 1,
      rows: buffers.map((buffer, i) => ({ id: ids[i], buffer })),
    },
    buffers,
  );
  for (const mask of [
    new Uint8Array(Math.ceil(n / 8)),
    new Uint8Array(Math.ceil(n / 8)).fill(255),
    Uint8Array.from({ length: Math.ceil(n / 8) }, (_, i) => (i % 2 ? 170 : 85)),
  ]) {
    const expected = ids
      .flatMap((id, i) =>
        mask[i >> 3]! & (1 << (i & 7))
          ? [{ id, score: expectedMatrix[i * dim] }]
          : [],
      )
      .sort((a, b) => b.score! - a.score! || a.id.localeCompare(b.id))
      .slice(0, 12);
    for (const scope of ["packed", "legacy"]) {
      const result = await request({
        kind: "query",
        scope,
        generation: 1,
        mask: mask.buffer,
        vector: q.buffer,
      });
      expect(result.hits).toEqual(expected);
    }
  }
});
it("错误的整块长度、资格位图或代数必须拒绝", async () => {
  const request = scanner();
  expect(
    (
      await request({
        kind: "load",
        scope: "a",
        generation: 1,
        ids: ["row"],
        matrix: new Float32Array(383).buffer,
      })
    ).error,
  ).toBe("scan_failed");
  await request({
    kind: "load",
    scope: "a",
    generation: 1,
    ids: ["row"],
    matrix: new Float32Array(384).buffer,
  });
  for (const data of [
    { scope: "a", generation: 2, mask: new Uint8Array(1).buffer },
    { scope: "b", generation: 1, mask: new Uint8Array(1).buffer },
    { scope: "a", generation: 1, mask: new Uint8Array(2).buffer },
  ])
    expect(
      (
        await request({
          kind: "query",
          vector: new Float32Array(384).buffer,
          ...data,
        })
      ).error,
    ).toBe("scan_failed");
});
