import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import {
  ProviderModel,
  collect,
  parseJson,
  type TurnMessage,
} from "../src/model.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";
import {
  memoryReplyReview,
  memoryReplyReviewMessages,
  parseMemoryReplyAssessment,
} from "../src/memory/reply-contract.js";
import { memoryReadScope } from "../src/memory/read-scope.js";
import { memoryOperationState } from "../src/memory/operations.js";
import {
  nameMentions,
  NAMING_REFERENCE_SYSTEM,
  NAMING_REFERENCE_OUTPUT_SCHEMA,
  namingReferenceMessages,
  parseNamingReferences,
  namingReferenceChecks,
} from "../src/memory/naming.js";
const out = resolve("test-results/memory-review-availability");
const bytes = readFileSync(join(out, "fast-review-plan.json"));
if (
  createHash("sha256").update(bytes).digest("hex") !==
  readFileSync(join(out, "fast-review-plan.sha256"), "utf8")
)
  throw Error("plan_changed");
if (existsSync(join(out, "fast-meter.json"))) throw Error("already_started");
const plan = JSON.parse(bytes.toString());
const save = (f: string, x: unknown) =>
  writeFileSync(join(out, f), JSON.stringify(x, null, 2), { mode: 0o600 });
const meter = new BenchmarkMeter(plan.cap, () =>
  save("fast-meter.json", {
    charged: meter.charged,
    cap: meter.cap,
    calls: meter.calls,
  }),
);
const config = stableMemoryConfig(
  loadConfig({ dataDir: out, model: plan.model, modelMode: "deepseek" }),
);
const provider = new ProviderModel(config, () => plan.model);
const rows: Record<string, unknown>[] = [];
const review = async (
  label: string,
  userInput: string,
  draft: string,
  read: unknown,
  operations: unknown,
  fast: boolean,
  part: "facts" | "operations" = "facts",
) => {
  const model = new ReviewBenchmarkModel(provider, "parallel", meter, label),
    start = performance.now();
  const reasoning = !fast && part === "facts";
  const response = await collect(model, {
    purpose: "judge",
    model: plan.model,
    system: memoryReplyReview(false, part, true, true),
    messages: memoryReplyReviewMessages(
      {
        contractPart: part,
        userInput,
        draft,
        saveIntent: false,
        memoryReadData: read,
        memoryOperations: operations,
      },
      true,
    ),
    tools: [],
    signal: AbortSignal.timeout(30000),
    maxOutputTokens: reasoning ? 4096 : 1500,
    reasoningEffort: reasoning ? "low" : undefined,
    json: true,
    temperature: reasoning ? undefined : 0,
  });
  return {
    ...parseMemoryReplyAssessment(
      parseJson(response.text),
      draft,
      false,
      part,
      part === "operations" ? userInput : undefined,
    ),
    ms: performance.now() - start,
  };
};
for (const [i, test] of plan.cases.entries()) {
  const read = {
    reads: [
      memoryReadScope(
        { mode: test.mode, complete: test.complete },
        test.evidence.length,
      ),
    ],
    evidence: test.evidence,
    confirmedFacts: test.evidence.map((e: object) => ({
      ...e,
      revision: 1,
      certainty: "confirmed",
    })),
    ...(test.time ? { time: test.time } : {}),
  };
  for (const fast of i % 2 ? [true, false] : [false, true]) {
    try {
      const result = await review(
        `${test.id}:${fast ? "fast" : "reasoned"}`,
        test.userInput,
        test.draft,
        read,
        memoryOperationState(),
        fast,
      );
      const rejected = result.violations.length > 0;
      rows.push({ id: test.id, fast, pass: rejected === test.reject, result });
      console.log(
        `${test.id} ${fast ? "fast" : "reasoned"}: ${rejected === test.reject ? "PASS" : "FAIL"}`,
      );
    } catch (error) {
      rows.push({ id: test.id, fast, pass: false, error: String(error) });
    }
    save("fast-results.partial.json", { rows });
  }
}
const tests = JSON.parse(readFileSync(plan.namingPlan, "utf8")).reviews,
  states = JSON.parse(readFileSync(plan.namingStates, "utf8"));
const naming: Record<string, unknown>[] = [];
for (const test of tests) {
  const state = states[test.state],
    read = structuredClone(state.read);
  if (test.speakerName) read.replyParticipants.speaker.name = test.speakerName;
  const mentions = nameMentions(
      test.draft,
      read.criticalProfile ?? [],
      read.replyParticipants.speaker.name,
    ),
    model = new ReviewBenchmarkModel(
      provider,
      "parallel",
      meter,
      `naming:${test.id}`,
    );
  try {
    const assessments = await Promise.all([
      review(
        `naming-facts:${test.id}`,
        test.input,
        test.draft,
        read,
        state.operations,
        true,
      ),
      review(
        `naming-operations:${test.id}`,
        test.input,
        test.draft,
        read,
        state.operations,
        true,
        "operations",
      ),
      ...(mentions.length
        ? [
            collect(model, {
              purpose: "judge",
              model: plan.model,
              system: NAMING_REFERENCE_SYSTEM,
              messages: namingReferenceMessages(
                test.draft,
                mentions,
              ) as TurnMessage[],
              signal: AbortSignal.timeout(30000),
              maxOutputTokens: 1500,
              json: true,
              outputSchema: NAMING_REFERENCE_OUTPUT_SCHEMA,
            }).then((r) => ({
              violations: namingReferenceChecks(
                test.draft,
                mentions,
                parseNamingReferences(parseJson(r.text), mentions),
              ),
            })),
          ]
        : []),
    ]);
    const rejected = assessments.some((a) => a.violations.length > 0);
    naming.push({
      id: test.id,
      pass: rejected === test.reject,
      expectedReject: test.reject,
      rejected,
      assessments,
    });
    console.log(`${test.id}: ${rejected === test.reject ? "PASS" : "FAIL"}`);
  } catch (error) {
    naming.push({ id: test.id, pass: false, error: String(error) });
  }
  save("fast-results.partial.json", { rows, naming });
}
save("fast-results.json", {
  rows,
  naming,
  gate:
    rows.filter((r) => r.fast).every((r) => r.pass) &&
    naming.every((r) => r.pass),
  charged: meter.charged,
});
