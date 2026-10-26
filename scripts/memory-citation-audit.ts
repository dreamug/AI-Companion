import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditMemoryClaims,
  validateClaimAudit,
} from "./lib/memory-claim-audit.js";
import type { AnswerScoreInput } from "./lib/memory-answer-score.js";
import { loadConfig } from "../src/config.js";
import { ProviderModel } from "../src/model.js";
import { textHash } from "../src/memory/evidence.js";

// Frozen responses only. No Store is opened; no responses or citations repaired.
const live = process.argv.includes("--live");
const fixtureOption = process.argv.indexOf("--fixture");
if (fixtureOption >= 0 && !live)
  throw Error("custom_controls_require_live_review");
const fixture = readFileSync(
  fixtureOption >= 0
    ? resolve(process.argv[fixtureOption + 1]!)
    : "tests/fixtures/memory-citation-controls.json",
  "utf8",
);
const incidents = JSON.parse(
  readFileSync("tests/fixtures/memory-citation-incidents.json", "utf8"),
);
const controls = JSON.parse(fixture) as {
  cases: {
    id: string;
    input: AnswerScoreInput & {
      query: AnswerScoreInput["query"] & { query: string };
    };
    expected: string;
  }[];
};
const config = live
  ? loadConfig({ modelMode: "deepseek", trafficOrigin: "synthetic" })
  : undefined;
const model = config
  ? new ProviderModel(config, () => config.model)
  : undefined;
const out = resolve(
  process.env.MEMORY_EVAL_OUT ?? "test-results/memory-citation-audit",
);
mkdirSync(out, { recursive: true });
const report = {
  evaluationVersion: "memory-citation-audit-v6-strict",
  at: new Date().toISOString(),
  syntheticOnly: true,
  live,
  regeneratedAnswers: false,
  fixtureHash: textHash(fixture),
  rows: [] as unknown[],
  gate: { passed: false, failures: [] as string[] },
};
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
for (const c of controls.cases) {
  if (!live && !incidents.some((r: { id: string }) => r.id === c.id)) continue;
  const frozen = incidents.find((r: { id: string }) => r.id === c.id);
  const audit =
    model && config
      ? await auditMemoryClaims(
          c.input,
          model,
          process.env.MEMORY_JUDGE_MODEL ?? config.model,
        )
      : {
          validation: validateClaimAudit(
            c.input,
            frozen.inventory,
            frozen.proof,
          ),
        };
  const actual =
    "verdict" in audit
      ? audit.verdict
      : audit.validation?.passed
        ? "pass"
        : "fail";
  // A reviewer failure is never evidence that an invalid answer was rejected.
  const validReview =
    "validation" in audit &&
    audit.validation &&
    [
      "strict_atomic_evidence_closure",
      "unsupported_or_misclassified_claim",
      "citation_closure_mismatch",
      "answer_target_or_marker_mismatch",
      "citation_not_delivered",
      "duplicate_citation",
      "run_not_completed",
      "historical_scope_without_evidence",
    ].includes(audit.validation.reason);
  const passed =
    actual === c.expected && (c.expected === "pass" || Boolean(validReview));
  report.rows.push({ ...c, actual, passed, audit });
  if (!passed) report.gate.failures.push(c.id);
  persist();
  console.log(
    `${c.id}: ${passed ? "pass" : "FAIL"} (expected=${c.expected}, actual=${actual})`,
  );
}
report.gate.passed =
  report.rows.length > 0 && report.gate.failures.length === 0;
persist();
if (!report.gate.passed) process.exitCode = 1;
