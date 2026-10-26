// Complete only calls refused by the benchmark's local token reservation.
// Existing valid results and every semantic expectation remain unchanged.
import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import {
  ProviderModel,
  collect,
  parseJson,
  type ModelRequest,
} from "../src/model.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";
import {
  memoryReplyReview,
  memoryReplyReviewMessages,
  memoryReplyReviewOptions,
  parseMemoryReplyAssessment,
} from "../src/memory/reply-contract.js";
import {
  nameMentions,
  NAMING_REFERENCE_SYSTEM,
  NAMING_REFERENCE_OUTPUT_SCHEMA,
  namingReferenceMessages,
  parseNamingReferences,
  namingReferenceChecks,
} from "../src/memory/naming.js";
const out = resolve("test-results/memory-intake-review-latency");
if (existsSync(join(out, "review-completion.partial.json")))
  throw Error("already_started");
const save = (f: string, x: unknown) =>
  writeFileSync(join(out, f), JSON.stringify(x, null, 2), { mode: 0o600 });
const first = JSON.parse(readFileSync(join(out, "reviews.json"), "utf8"));
const prior = JSON.parse(readFileSync(join(out, "meter.json"), "utf8"));
const allowed = new Set(["Error: benchmark_budget_exceeded"]);
for (const row of first.reviews)
  for (const result of row.results)
    if (result.error && !allowed.has(result.error))
      throw Error("not_a_budget_only_completion");
const meter = new BenchmarkMeter(300000, () =>
  save("meter.json", {
    charged: meter.charged,
    cap: meter.cap,
    calls: meter.calls,
  }),
);
meter.charged = prior.charged;
meter.calls = prior.calls;
save("review-budget-extension.json", {
  reason:
    "original reservation cap interrupted remaining checks; replay only calls never sent because of that cap",
  initialCap: prior.cap,
  newCumulativeCap: meter.cap,
  priorCharged: meter.charged,
  expectationsUnchanged: true,
  modelAndPromptsUnchanged: true,
});
const config = stableMemoryConfig(
  loadConfig({ dataDir: out, model: "deepseek-flash", modelMode: "deepseek" }),
);
const provider = new ProviderModel(config, () => "deepseek-flash");
const old = resolve("test-results/companion-memory-cm3/address-perspective");
const cases = JSON.parse(readFileSync(join(old, "plan.json"), "utf8")).reviews;
const states = JSON.parse(
  readFileSync(join(old, "known-replay/state-projections.json"), "utf8"),
);
const rows: Record<string, unknown>[] = [];
save("review-completion.partial.json", { rows });
for (const test of cases) {
  const original = first.reviews.find((r: { id: string }) => r.id === test.id),
    state = states[test.state],
    read = structuredClone(state.read);
  if (test.speakerName) read.replyParticipants.speaker.name = test.speakerName;
  const results = [...original.results],
    model = new ReviewBenchmarkModel(
      provider,
      "parallel",
      meter,
      `budget-completion:${test.id}`,
    ),
    ctrl = new AbortController(),
    timeout = setTimeout(() => ctrl.abort(), 8000);
  const mentions = nameMentions(
    test.draft,
    read.criticalProfile ?? [],
    read.replyParticipants.speaker.name,
  );
  try {
    const jobs = results.map(async (result, index) => {
      if (!result.error) return result;
      let request: ModelRequest;
      if (index < 2) {
        const part = index === 0 ? "facts" : "operations",
          options = memoryReplyReviewOptions(part, true);
        request = {
          purpose: "judge",
          model: "deepseek-flash",
          system: memoryReplyReview(false, part, true, true),
          messages: memoryReplyReviewMessages(
            {
              contractPart: part,
              userInput: test.input,
              draft: test.draft,
              saveIntent: false,
              memoryReadData: read,
              memoryOperations: state.operations,
            },
            true,
          ),
          tools: [],
          signal: ctrl.signal,
          maxOutputTokens: options.maxOutputTokens,
          reasoningEffort: options.reasoningEffort,
          json: true,
        };
      } else
        request = {
          purpose: "judge",
          model: "deepseek-flash",
          system: NAMING_REFERENCE_SYSTEM,
          messages: namingReferenceMessages(test.draft, mentions),
          tools: [],
          signal: ctrl.signal,
          maxOutputTokens: 1500,
          json: true,
          outputSchema: NAMING_REFERENCE_OUTPUT_SCHEMA,
        };
      try {
        const response = await collect(model, request);
        return index < 2
          ? parseMemoryReplyAssessment(
              parseJson(response.text),
              test.draft,
              false,
              index === 0 ? "facts" : "operations",
              index === 1 ? test.input : undefined,
            )
          : {
              violations: namingReferenceChecks(
                test.draft,
                mentions,
                parseNamingReferences(parseJson(response.text), mentions),
              ),
            };
      } catch (error) {
        return { error: String(error) };
      }
    });
    const completed = await Promise.all(jobs),
      invalid = completed.some((c) => c.error),
      rejected = completed.some((c) => c.violations?.length > 0),
      pass = !invalid && rejected === test.reject;
    rows.push({
      id: test.id,
      expectedReject: test.reject,
      rejected,
      invalid,
      pass,
      replayedComponentIndexes: results.flatMap((r, i) => (r.error ? [i] : [])),
      results: completed,
    });
    console.log(`${test.id}: ${pass ? "PASS" : "FAIL"}`);
  } finally {
    clearTimeout(timeout);
  }
  save("review-completion.partial.json", { rows });
}
save("review-completion.json", { rows, charged: meter.charged });
