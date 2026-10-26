import { DomainError, type Message, type Run } from "../domain.js";
import type { Store } from "../store.js";
import {
  CompanionPlan,
  commitCompanionPlan,
  inboxId,
  registerCompanionInput,
  settledCompanionInput,
  type Plan,
} from "./companion-v3.js";

/** Routing hints only. The independent operations review supplies the semantic backstop. */
export function needsSynchronousIntake(text: string) {
  return /(?:记住|记着|记下|保存|忘掉|忘记|删掉|删除|更正|改成|改叫|不再|不喜欢了|以前.{0,20}现在|以后.{0,12}(?:叫|称呼)|今天.{0,12}(?:叫|称呼)|这段.{0,12}(?:叫|称呼)|(?:叫我|称呼我|喊我).{1,64}(?:吧|就好|就行)|我叫.{1,64}|我的名字是|(?:不要|别|不许).{0,12}(?:叫|称呼|追问|建议|主动|打扰)|(?:先听|少问|简短点))/u.test(
    text,
  );
}
export type IntakeFlight = {
  input: Message;
  run: Run;
  controller: AbortController;
  synchronous: boolean;
  foregroundDone: boolean;
  requiresSync: boolean;
  result: Promise<{ plan?: Plan; error?: unknown }>;
};

/** One parser per source revision; source ordering makes replacement targets stable.
 * No new persistence queue: inbox + mutation remain the durable authority. */
export class CompanionIntakeQueue {
  private flights = new Map<string, IntakeFlight>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private now: () => number,
  ) {}
  start(
    input: Message,
    run: Run,
    synchronous: boolean,
    parse: (signal: AbortSignal) => Promise<unknown>,
  ) {
    const key = inboxId(input.id, input.revision);
    const prior = this.flights.get(key);
    if (prior) return prior;
    if (this.flights.size >= 16)
      throw new DomainError("intake_queue_full", 429);
    registerCompanionInput(this.store, input, this.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("intake_deadline"), 30000);
    timer.unref();
    const flight: IntakeFlight = {
      input,
      run,
      controller,
      synchronous,
      foregroundDone: false,
      requiresSync: false,
      result: undefined!,
    };
    const work = this.tail.then(async () => {
      try {
        if (controller.signal.aborted) throw new DomainError("cancelled", 409);
        const current = this.store.require("runs", run.id);
        if (
          current.generation !== run.generation ||
          current.personaRevision !== this.store.settings().personaRevision
        )
          throw new DomainError("cancelled", 409);
        const row = this.store.require("memory_inbox", key);
        this.store.put("memory_inbox", { ...row, status: "running" });
        const plan = CompanionPlan.parse(await parse(controller.signal));
        if (controller.signal.aborted) throw new DomainError("cancelled", 409);
        flight.requiresSync =
          plan.intent !== "none" || plan.items.some((i) => i.action !== "add");
        if (flight.synchronous || !flight.requiresSync) {
          commitCompanionPlan(
            this.store,
            input,
            run,
            plan,
            this.now(),
            controller.signal,
            { background: !flight.synchronous },
          );
        } else if (flight.foregroundDone) {
          settledCompanionInput(
            this.store,
            input,
            "failed",
            "late_requires_sync",
            this.now(),
          );
        } else {
          this.store.put("memory_inbox", {
            ...this.store.require("memory_inbox", key),
            status: "requires_sync",
          });
        }
        return { plan };
      } catch (error) {
        settledCompanionInput(
          this.store,
          input,
          controller.signal.aborted ? "cancelled" : "failed",
          error instanceof DomainError ? error.code : "intake_failed",
          this.now(),
        );
        return { error };
      } finally {
        clearTimeout(timer);
      }
    });
    flight.result = work;
    this.flights.set(key, flight);
    this.tail = work;
    void work.then(() => {
      if (flight.foregroundDone) this.flights.delete(key);
    });
    return flight;
  }
  async promote(flight: IntakeFlight, signal: AbortSignal) {
    flight.synchronous = true;
    const cancel = () => flight.controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const result = await flight.result;
      if (result.error) throw result.error;
      commitCompanionPlan(
        this.store,
        flight.input,
        flight.run,
        result.plan,
        this.now(),
        signal,
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  finish(flight: IntakeFlight) {
    flight.foregroundDone = true;
    const key = inboxId(flight.input.id, flight.input.revision);
    if (this.store.get("memory_inbox", key)?.status === "requires_sync")
      settledCompanionInput(
        this.store,
        flight.input,
        "failed",
        "late_requires_sync",
        this.now(),
      );
    void flight.result.then(() => this.flights.delete(key));
  }
  cancel(predicate: (f: IntakeFlight) => boolean, reason: string) {
    for (const f of this.flights.values())
      if (predicate(f)) f.controller.abort(reason);
  }
  async close() {
    this.cancel(() => true, "session_closed");
    await Promise.allSettled([...this.flights.values()].map((f) => f.result));
  }
}
