// One bounded replay of the unchanged polarity set after reconciling quote/person instructions.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { ProviderModel, collect, parseJson } from "../src/model.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";
import {
  nameMentions,
  NAMING_REFERENCE_SYSTEM,
  NAMING_REFERENCE_OUTPUT_SCHEMA,
  namingReferenceMessages,
  parseNamingReferences,
  namingReferenceChecks,
} from "../src/memory/naming.js";
const out = resolve("test-results/companion-memory-cm3/fast-path");
if (existsSync(join(out, "references-final.partial.json")))
  throw Error("replay_already_started");
const first = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
const prior = JSON.parse(readFileSync(join(out, "meter.json"), "utf8"));
const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
const states = JSON.parse(readFileSync(plan.reviewStates, "utf8"));
const tests = JSON.parse(readFileSync(plan.reviewPlan, "utf8")).reviews;
const rows: unknown[] = [];
const save = () =>
  writeFileSync(
    join(out, "references-final.partial.json"),
    JSON.stringify({ rows, charged: meter.charged }, null, 2),
  );
const meter = new BenchmarkMeter(plan.cap, () =>
  writeFileSync(
    join(out, "meter.json"),
    JSON.stringify(
      { charged: meter.charged, cap: meter.cap, calls: meter.calls },
      null,
      2,
    ),
  ),
);
meter.charged = prior.charged;
meter.calls = prior.calls;
save();
const config = loadConfig({
  dataDir: out,
  model: plan.model,
  modelMode: "deepseek",
  memoryFastPath: true,
});
const provider = new ProviderModel(config, () => plan.model);
for (const test of tests) {
  const read = states[test.state].read;
  const mentions = nameMentions(
    test.draft,
    read.criticalProfile ?? [],
    test.speakerName ?? read.replyParticipants.speaker.name,
  );
  const model = new ReviewBenchmarkModel(
    provider,
    "parallel",
    meter,
    `final-reference:${test.id}`,
  );
  let references: unknown[] = [],
    checks: unknown[] = [];
  if (mentions.length) {
    const result = await collect(model, {
      purpose: "judge",
      model: plan.model,
      system: NAMING_REFERENCE_SYSTEM,
      messages: namingReferenceMessages(test.draft, mentions),
      signal: AbortSignal.timeout(30000),
      maxOutputTokens: 1500,
      json: true,
      outputSchema: NAMING_REFERENCE_OUTPUT_SCHEMA,
    });
    const refs = parseNamingReferences(parseJson(result.text), mentions);
    references = refs;
    checks = namingReferenceChecks(test.draft, mentions, refs);
  }
  const original = first.reviews.find((r: { id: string }) => r.id === test.id);
  const rejected =
    original.outcomes.some(
      (o: { violations: unknown[] }) => o.violations.length,
    ) || checks.length > 0;
  const row = {
    id: test.id,
    expectedReject: test.reject,
    rejected,
    pass: rejected === test.reject,
    references,
    checks,
    unchangedIndependentChecks: original.outcomes,
  };
  rows.push(row);
  save();
  console.log(`${test.id}: ${row.pass ? "PASS" : "FAIL"}`);
}
writeFileSync(
  join(out, "references-final.json"),
  JSON.stringify(
    {
      rows,
      charged: meter.charged,
      originalFirstPass: first.reviews.filter((r: { pass: boolean }) => r.pass)
        .length,
      changeHash: createHash("sha256")
        .update(readFileSync("src/memory/naming.ts"))
        .digest("hex"),
    },
    null,
    2,
  ),
);
