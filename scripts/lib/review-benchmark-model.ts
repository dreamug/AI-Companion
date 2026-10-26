import { createHash } from "node:crypto";
import { requestTokens } from "../../src/context.js";
import { DomainError, type Usage } from "../../src/domain.js";
import type { ModelPort, ModelRequest, ModelEvent } from "../../src/model.js";

export type BenchCall = {
  label: string;
  purpose: string;
  part?: string;
  requestHash: string;
  queuedAtMs: number;
  dispatchedAtMs?: number;
  endedAtMs?: number;
  providerMs?: number;
  queueMs?: number;
  reserved?: number;
  charged?: number;
  usage?: Usage;
  providerModel?: string;
  requestId?: string;
  error?: string;
  outcome: "queued" | "running" | "ok" | "failed";
};
export class BenchmarkMeter {
  charged = 0;
  calls: BenchCall[] = [];
  constructor(
    readonly cap: number,
    private persist: () => void = () => {},
  ) {}
  record(call: BenchCall) {
    this.calls.push(call);
    this.persist();
  }
  reserve(call: BenchCall, tokens: number) {
    if (this.charged + tokens > this.cap)
      throw new DomainError("benchmark_budget_exceeded", 429);
    call.reserved = call.charged = tokens;
    this.charged += tokens;
    this.persist();
  }
  finish(call: BenchCall, usage: Usage) {
    const actual = usage.totalTokens ?? call.reserved!;
    this.charged += actual - call.charged!;
    call.charged = actual;
    call.usage = usage;
    this.persist();
  }
  flush() {
    this.persist();
  }
}
async function waitForTurn(previous: Promise<void>, signal: AbortSignal) {
  if (signal.aborted) throw new DomainError("cancelled", 409);
  let stop = () => {};
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        const abort = () => reject(new DomainError("cancelled", 409));
        signal.addEventListener("abort", abort, { once: true });
        stop = () => signal.removeEventListener("abort", abort);
      }),
    ]);
    if (signal.aborted) throw new DomainError("cancelled", 409);
  } finally {
    stop();
  }
}
/** Benchmark-only scheduling at the actual provider boundary; never changes prompts or checks. */
export class ReviewBenchmarkModel implements ModelPort {
  readonly name: string;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private provider: ModelPort,
    private mode: "serial" | "parallel",
    private meter: BenchmarkMeter,
    private label: string,
    private capture?: (r: ModelRequest) => void,
  ) {
    this.name = provider.name;
  }
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const { signal, ...payload } = request;
    const call: BenchCall = {
      label: this.label,
      purpose: request.purpose,
      requestHash: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
      queuedAtMs: performance.now(),
      outcome: "queued",
    };
    if (request.purpose === "judge") {
      call.part = JSON.parse(request.messages[0]!.content).contractPart;
      this.capture?.(request);
    }
    this.meter.record(call);
    let release = () => {};
    const prior = this.tail;
    if (this.mode === "serial" && request.purpose === "judge")
      this.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
    let finished = false;
    try {
      if (this.mode === "serial" && request.purpose === "judge")
        await waitForTurn(prior, signal);
      if (signal.aborted) throw new DomainError("cancelled", 409);
      this.meter.reserve(
        call,
        requestTokens(
          request.system,
          request.messages,
          request.tools,
          request.outputSchema,
        ) + request.maxOutputTokens,
      );
      call.dispatchedAtMs = performance.now();
      call.queueMs = call.dispatchedAtMs - call.queuedAtMs;
      call.outcome = "running";
      this.meter.flush();
      for await (const event of this.provider.stream(request)) {
        if (event.type === "finish") {
          this.meter.finish(call, event.usage);
          call.providerModel = event.providerModel;
          call.requestId = event.requestId;
          finished = event.reason === "stop" || event.reason === "tool-calls";
        }
        yield event;
      }
      call.outcome = finished ? "ok" : "failed";
    } catch (error) {
      call.outcome = "failed";
      call.error =
        error instanceof DomainError
          ? error.code
          : error instanceof Error
            ? error.name
            : "unknown_error";
      throw error;
    } finally {
      if (call.outcome === "queued" || call.outcome === "running")
        call.outcome = "failed";
      call.endedAtMs = performance.now();
      if (call.dispatchedAtMs !== undefined)
        call.providerMs = call.endedAtMs - call.dispatchedAtMs;
      release();
      this.meter.flush();
    }
  }
}
