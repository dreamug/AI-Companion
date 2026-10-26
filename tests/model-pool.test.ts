import { expect, it } from "vitest";
import { ModelRequestPool, accountModelPool } from "../src/model-pool.js";
import { until } from "./helpers.js";

it("account pool caps four active and one background request, prioritizing queued foreground", async () => {
  const pool = new ModelRequestPool(),
    signal = new AbortController().signal;
  const background = await pool.acquire(true, signal);
  const foreground = await Promise.all(
    [1, 2, 3].map(() => pool.acquire(false, signal)),
  );
  const started: string[] = [];
  const bg = pool.acquire(true, signal).then((release) => {
    started.push("background");
    return release;
  });
  const fg = pool.acquire(false, signal).then((release) => {
    started.push("foreground");
    return release;
  });
  await Promise.resolve();
  expect(started).toEqual([]);
  foreground[0]!();
  const releaseFg = await fg;
  expect(started).toEqual(["foreground"]);
  releaseFg();
  await Promise.resolve();
  expect(started).toEqual(["foreground"]);
  background();
  const releaseBg = await bg;
  expect(started).toEqual(["foreground", "background"]);
  releaseBg();
  for (const release of foreground) release(); // idempotent release
});

it("queued cancellation cannot consume capacity or delay following work", async () => {
  const pool = new ModelRequestPool(),
    controller = new AbortController();
  const active = await pool.acquire(true, controller.signal);
  const cancelled = pool.acquire(true, controller.signal);
  const rejected = expect(cancelled).rejects.toThrow("cancelled");
  controller.abort();
  await rejected;
  active();
  let granted = false;
  const pending = pool
    .acquire(true, new AbortController().signal)
    .then((release) => {
      granted = true;
      release();
    });
  await until(() => granted);
  await pending;
});

it("account queues are shared by identity and bounded", async () => {
  expect(accountModelPool("same")).toBe(accountModelPool("same"));
  expect(accountModelPool("same")).not.toBe(accountModelPool("different"));
  const pool = new ModelRequestPool(),
    active = await pool.acquire(true, new AbortController().signal);
  const c = new AbortController();
  const pending = Array.from({ length: 16 }, () =>
    pool.acquire(true, c.signal).catch(() => {}),
  );
  await expect(pool.acquire(true, c.signal)).rejects.toThrow(
    "model_queue_full",
  );
  c.abort();
  active();
  await Promise.all(pending);
});
