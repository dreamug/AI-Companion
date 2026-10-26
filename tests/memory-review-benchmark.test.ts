import { expect, it } from "vitest";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "../scripts/lib/review-benchmark-model.js";
import { ScriptedModel, deferred, response, until } from "./helpers.js";
import { requestTokens } from "../src/context.js";
import { collect, type ModelRequest } from "../src/model.js";
function req(part: string): ModelRequest {
  return {
    purpose: "judge",
    model: "deepseek-flash",
    system: "unchanged",
    messages: [
      {
        role: "user",
        content: JSON.stringify({ contractPart: part, draft: "same draft" }),
      },
    ],
    tools: [],
    json: true,
    temperature: 0,
    maxOutputTokens: 50,
    signal: new AbortController().signal,
  };
}
it.each(["serial", "parallel"] as const)(
  "%s schedules real calls correctly without altering either payload",
  async (mode) => {
    const gate = deferred();
    const started: string[] = [];
    const provider = new ScriptedModel(async function* (r) {
      started.push(JSON.parse(r.messages[0]!.content).contractPart);
      if (started.length === 1) await gate.promise;
      yield* response('{"checks":[]}');
    });
    const meter = new BenchmarkMeter(10000);
    const model = new ReviewBenchmarkModel(provider, mode, meter, "case");
    const a = req("facts"),
      b = req("operations");
    const pa = collect(model, a),
      pb = collect(model, b);
    await until(() => started.length === (mode === "serial" ? 1 : 2));
    if (mode === "serial") expect(provider.requests).toHaveLength(1);
    gate.resolve();
    await Promise.all([pa, pb]);
    expect(provider.requests).toEqual([a, b]);
    expect(meter.charged).toBe(60);
    expect(meter.calls).toHaveLength(2);
    expect(meter.calls.every((c) => c.outcome === "ok")).toBe(true);
    if (mode === "serial")
      expect(meter.calls[1]!.dispatchedAtMs!).toBeGreaterThanOrEqual(
        meter.calls[0]!.endedAtMs!,
      );
    else
      expect(meter.calls[1]!.dispatchedAtMs!).toBeLessThan(
        meter.calls[0]!.endedAtMs!,
      );
  },
);
it("one shared meter enforces a cumulative cap across new copied runtimes", async () => {
  const provider = new ScriptedModel(async function* () {
    yield* response('{"checks":[]}');
  });
  const r = req("facts");
  const reservation =
    requestTokens(r.system, r.messages, r.tools) + r.maxOutputTokens;
  const meter = new BenchmarkMeter(reservation + 15);
  await collect(
    new ReviewBenchmarkModel(provider, "parallel", meter, "copy1"),
    req("facts"),
  );
  await expect(
    collect(
      new ReviewBenchmarkModel(provider, "serial", meter, "copy2"),
      req("operations"),
    ),
  ).rejects.toThrow("benchmark_budget_exceeded");
  expect(provider.requests).toHaveLength(1);
});
it("a queued serial check aborts before provider dispatch and is not charged as a sent call", async () => {
  const gate = deferred();
  const provider = new ScriptedModel(async function* () {
    await gate.promise;
    yield* response('{"checks":[]}');
  });
  const meter = new BenchmarkMeter(10000),
    model = new ReviewBenchmarkModel(provider, "serial", meter, "cancel");
  const a = collect(model, req("facts"));
  const ctrl = new AbortController();
  const b = collect(model, { ...req("operations"), signal: ctrl.signal });
  ctrl.abort();
  await expect(b).rejects.toThrow("cancelled");
  gate.resolve();
  await a;
  expect(provider.requests).toHaveLength(1);
  expect(meter.charged).toBe(30);
  expect(meter.calls[1]!.charged).toBeUndefined();
});
