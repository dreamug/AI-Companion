import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { LocalEmbedding, IsolatedEmbedding } from "../src/memory/embedding.js";
import { until } from "./helpers.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
async function port() {
  const dir = mkdtempSync(join(tmpdir(), "memory-worker-test-"));
  mkdirSync(join(dir, "model"));
  writeFileSync(join(dir, "model", "model.safetensors"), "");
  const p = new LocalEmbedding(
    process.execPath,
    join(dir, "model"),
    new URL("./fixtures/embedding-fixture.mjs", import.meta.url),
  );
  cleanup.push(() => {
    p.close();
    rmSync(dir, { recursive: true, force: true });
  });
  p.warm();
  await until(() => p.ready);
  return p;
}
describe("本地编码与驻留扫描协议", () => {
  it("模型未就绪立即降级，冷启动不占用前台等待", async () => {
    const p = new LocalEmbedding("/not-found/python", "/not-found/model");
    cleanup.push(() => p.close());
    p.warm();
    await expect(
      p.encode("query", "query", "scope", new AbortController().signal),
    ).rejects.toThrow("embedding_not_ready");
  });
  it.each([
    "wrong-id",
    "wrong-scope",
    "wrong-model",
    "bad-dimension",
    "bad-norm",
    "crash",
  ])("拒绝 %s，不把错误向量作为有效结果", async (text) => {
    const p = await port();
    await expect(
      p.encode(text, "query", "scope", new AbortController().signal),
    ).rejects.toThrow();
    expect(p.ready).toBe(false);
  });
  it("查询超时及时释放调用者；迟到内核返回后队列仍可继续", async () => {
    const p = await port(),
      start = performance.now();
    await expect(
      p.encode("slow", "query", "scope", new AbortController().signal, 15),
    ).rejects.toThrow("embedding_timeout");
    expect(performance.now() - start).toBeLessThan(150);
    const next = await p.encode(
      "next",
      "query",
      "scope",
      new AbortController().signal,
      400,
    );
    expect(next[0]).toBe(1);
  });
  it("取消释放调用者，队列上限和每scope等待查询上限受控", async () => {
    const p = await port(),
      c = new AbortController();
    const running = p
      .encode("hang", "passage", "scope", c.signal, 5000)
      .catch((e) => e);
    const query = p
      .encode("next", "query", "same", new AbortController().signal, 5000)
      .catch((e) => e);
    await expect(
      p.encode(
        "duplicate",
        "query",
        "same",
        new AbortController().signal,
        5000,
      ),
    ).rejects.toThrow("embedding_busy");
    const queued = Array.from({ length: 15 }, (_, i) =>
      p
        .encode(
          "background",
          "passage",
          `bot-${i}`,
          new AbortController().signal,
          5000,
        )
        .catch((e) => e),
    );
    await expect(
      p.encode("overflow", "passage", "other", new AbortController().signal),
    ).rejects.toThrow("embedding_busy");
    c.abort();
    expect((await running).code).toBe("cancelled");
    p.close();
    await Promise.all([query, ...queued]);
  });
  it("后台单条结束后优先前台；应用关闭拒绝排队工作", async () => {
    const p = await port(),
      order: string[] = [];
    const a = p
      .encode("slow", "passage", "a", new AbortController().signal, 1000)
      .then(() => order.push("active"));
    const b = p
      .encode("background", "passage", "b", new AbortController().signal, 1000)
      .then(() => order.push("background"));
    const q = p
      .encode("query", "query", "c", new AbortController().signal, 1000)
      .then(() => order.push("query"));
    await Promise.all([a, b, q]);
    expect(order).toEqual(["active", "query", "background"]);
    p.close();
    await expect(
      p.encode("x", "query", "scope", new AbortController().signal),
    ).rejects.toThrow("cancelled");
  });
  it("25000 行矩阵驻留，连续查询只传向量和资格；错generation拒绝", async () => {
    const worker = new Worker(
      new URL("../src/memory/scan-worker.mjs", import.meta.url),
    );
    cleanup.push(() => void worker.terminate());
    let serial = 0;
    const request = (
      data: Record<string, unknown>,
      transfer: ArrayBuffer[] = [],
    ) =>
      new Promise<Record<string, unknown>>((ok, fail) => {
        const id = String(++serial),
          timer = setTimeout(() => fail(Error("timeout")), 3000);
        const listener = (r: Record<string, unknown>) => {
          if (r.id !== id) return;
          clearTimeout(timer);
          worker.off("message", listener);
          ok(r);
        };
        worker.on("message", listener);
        worker.postMessage({ id, ...data }, transfer);
      });
    const buffers = Array.from({ length: 25000 }, () => {
      const v = new Float32Array(384);
      v[0] = 1;
      return v.buffer;
    });
    await request(
      {
        kind: "load",
        scope: "a",
        generation: 1,
        rows: buffers.map((buffer, i) => ({ id: `row-${i}`, buffer })),
      },
      buffers,
    );
    expect(buffers[0]!.byteLength).toBe(0);
    const vector = new Float32Array(384),
      mask = new Uint8Array(Math.ceil(25000 / 8));
    mask[24999 >> 3]! |= 1 << (24999 & 7);
    vector[0] = 1;
    for (let i = 0; i < 10; i++) {
      const response = await request({
        kind: "query",
        scope: "a",
        generation: 1,
        mask: mask.buffer,
        vector: vector.buffer,
      });
      expect((response.hits as { id: string }[]).map((h) => h.id)).toEqual([
        "row-24999",
      ]);
    }
    expect(
      (
        await request({
          kind: "query",
          scope: "a",
          generation: 2,
          mask: mask.buffer,
          vector: vector.buffer,
        })
      ).error,
    ).toBe("scan_failed");
    expect(
      (
        await request({
          kind: "query",
          scope: "b",
          generation: 1,
          mask: mask.buffer,
          vector: vector.buffer,
        })
      ).error,
    ).toBe("scan_failed");
  });
});

// Two real protocol children, so a blocked passage cannot consume the query lane.
it("前后台编码隔离：后台挂起、超时或取消不堵住前台，也不污染其他 scope", async () => {
  const foreground = await port(),
    background = await port();
  const p = new IsolatedEmbedding(foreground, background);
  const c = new AbortController();
  const stuck = p
    .encode("hang", "passage", "a", c.signal, 1000)
    .catch((e) => e.code);
  const v = await p.encode(
    "next",
    "query",
    "b",
    new AbortController().signal,
    200,
  );
  expect(v[0]).toBe(1);
  c.abort();
  expect(await stuck).toBe("cancelled");
  const again = await p.encode(
    "next",
    "query",
    "c",
    new AbortController().signal,
    200,
  );
  expect(again[0]).toBe(1);
  p.close();
  await expect(
    p.encode("next", "query", "c", new AbortController().signal),
  ).rejects.toThrow("cancelled");
});
