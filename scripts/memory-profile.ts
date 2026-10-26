import { Store } from "../src/store.js";
import { MemoryRetrieval } from "../src/memory/retrieval.js";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const stages: Record<
  string,
  { calls: number; totalMs: number; maxMs: number }
> = {};
function record(name: string, start: number) {
  const d = performance.now() - start,
    s = (stages[name] ??= { calls: 0, totalMs: 0, maxMs: 0 });
  s.calls++;
  s.totalMs += d;
  s.maxMs = Math.max(s.maxMs, d);
}
for (const [prototype, names] of [
  [Store.prototype, ["search", "contextMemories", "sourcesValid"]],
  [MemoryRetrieval.prototype, ["loadIndex", "eligiblePool"]],
] as const) {
  for (const name of names) {
    const original = Reflect.get(prototype, name) as (
      ...args: unknown[]
    ) => unknown;
    Reflect.set(prototype, name, function (this: unknown, ...args: unknown[]) {
      const start = performance.now(),
        r = Reflect.apply(original, this, args);
      if (r instanceof Promise) return r.finally(() => record(name, start));
      record(name, start);
      return r;
    });
  }
}
const qualified = Store.prototype.qualifiedFacts;
Store.prototype.qualifiedFacts = function* (
  ...args: Parameters<Store["qualifiedFacts"]>
) {
  const iterator = qualified.apply(this, args);
  try {
    while (true) {
      const start = performance.now(),
        r = iterator.next();
      record("qualifiedFacts_next_CPU", start);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    iterator.return(undefined);
  }
};
await import("./memory-performance.js");
writeFileSync(
  join(
    resolve(process.env.MEMORY_PERF_OUT ?? "test-results/memory-performance"),
    "profile.json",
  ),
  JSON.stringify(stages, null, 2),
);
console.log(JSON.stringify(stages));
