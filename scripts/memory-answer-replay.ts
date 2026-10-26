import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { textHash } from "../src/memory/evidence.js";
import {
  scoreMemoryAnswer,
  canonicalMemoryAnswer,
  type AnswerRubric,
  type AnswerScoreInput,
} from "./lib/memory-answer-score.js";
import {
  validateClaimAudit,
  claimAuditVerdict,
} from "./lib/memory-claim-audit.js";
import { ProviderModel, parseJson } from "../src/model.js";
import { loadConfig } from "../src/config.js";
import { adjudicateMemoryAnswer } from "./lib/memory-answer-judge.js";
import { memoryBenchmarkDiagnostics } from "./lib/memory-benchmark-contract.js";

// Strict replay of immutable responses. Legacy single-pass judgments do not
// establish atomic coverage; --rejudge reviews text, never regenerates it.
const option = process.argv.indexOf("--input"),
  inputPath = process.argv[option + 1];
if (option < 0 || !inputPath) throw Error("replay_input_required");
const source = readFileSync(resolve(inputPath), "utf8");
const original = JSON.parse(source) as {
  syntheticOnly: boolean;
  liveAnswerGate?: unknown;
  datasets: { file: string; datasetHash: string }[];
  live: {
    id: string;
    file: string;
    repeat: number;
    answer: unknown;
    raw?: string;
    delivery?: { actualId: string; id: string }[];
    adjudication?: { inventory?: unknown; proof?: unknown };
    protocolInput?: AnswerScoreInput;
  }[];
};
if (
  !original.syntheticOnly ||
  !original.liveAnswerGate ||
  !original.live.length
)
  throw Error("replay_requires_complete_synthetic_run");
const out = resolve(
  process.env.MEMORY_EVAL_OUT ?? "test-results/memory-answer-replay",
);
const rejudge = process.argv.includes("--rejudge"),
  config = rejudge
    ? loadConfig({ modelMode: "deepseek", trafficOrigin: "synthetic" })
    : undefined;
const model = config
  ? new ProviderModel(config, () => config.model)
  : undefined;
const auditOption = process.argv.indexOf("--audits");
const auditSource =
  auditOption >= 0
    ? readFileSync(resolve(process.argv[auditOption + 1]!), "utf8")
    : undefined;
if (auditSource && rejudge) throw Error("choose_saved_audits_or_rejudge");
const savedAudits = auditSource
  ? (JSON.parse(auditSource) as {
      sourceHash: string;
      rows: {
        file: string;
        id: string;
        repeat: number;
        audit?: {
          inventory?: unknown;
          proof?: unknown;
          error?: string;
        };
      }[];
    })
  : undefined;
if (savedAudits && savedAudits.sourceHash !== textHash(source))
  throw Error("saved_audits_source_mismatch");
const auditKey = (row: { file: string; id: string; repeat: number }) =>
  JSON.stringify([row.file, row.id, row.repeat]);
const auditByKey = new Map(
  savedAudits?.rows.map((r) => [auditKey(r), r.audit]),
);
if (savedAudits && auditByKey.size !== savedAudits.rows.length)
  throw Error("duplicate_saved_audit");
const tasks: (() => Promise<void>)[] = [];
const rows: {
  id: string;
  file: string;
  verdict: string;
  [key: string]: unknown;
}[] = [];
mkdirSync(out, { recursive: true });
const report = {
  evaluationVersion: "memory-answer-replay-v7-diagnostic-axes",
  at: new Date().toISOString(),
  syntheticOnly: true,
  regeneratedAnswers: false,
  reranJudge: rejudge,
  source: resolve(inputPath),
  sourceHash: textHash(source),
  savedAuditHash: auditSource ? textHash(auditSource) : undefined,
  rows,
  gate: { passed: false, failures: [] as unknown[] },
};
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
for (const d of original.datasets) {
  const name = (
    {
      "query-regression.json": "memory-query-regression",
      "answer-boundaries.json": "memory-answer-boundaries",
      "open-world.json": "memory-open-world",
      "positive-attributes.json": "memory-positive-attributes",
      "citation-generalization.json": "memory-citation-generalization",
      "acceptance-v1.json": "memory-acceptance-v1",
    } as Record<string, string>
  )[d.file];
  if (!name) throw Error("unsupported_replay_dataset");
  const raw = readFileSync(resolve("tests/fixtures", `${name}.json`), "utf8");
  const dataset = JSON.parse(raw) as {
    queries: (AnswerScoreInput["query"] & {
      query: string;
      requiredUnknown?: boolean;
    })[];
  };
  if (textHash(raw) !== d.datasetHash) throw Error("replay_fixture_changed");
  const rubric =
    name === "memory-citation-generalization" || name === "memory-acceptance-v1"
      ? undefined
      : (JSON.parse(
          readFileSync(
            resolve(
              "tests/fixtures",
              name === "memory-query-regression"
                ? "memory-answer-rubric.json"
                : `${name}-rubric.json`,
            ),
            "utf8",
          ),
        ) as AnswerRubric);
  if (rubric && rubric.datasetHash !== d.datasetHash)
    throw Error("replay_rubric_changed");
  for (const row of original.live.filter((r) => r.file === d.file)) {
    const q = dataset.queries.find((q) => q.id === row.id);
    if (
      !q ||
      !row.protocolInput ||
      typeof row.raw !== "string" ||
      !row.delivery
    )
      throw Error("replay_requires_original_protocol_and_delivery");
    let rawAnswer: unknown = {};
    try {
      rawAnswer = parseJson(row.raw);
    } catch {
      /* invalid raw remains a failure */
    }
    if (JSON.stringify(rawAnswer) !== JSON.stringify(row.answer))
      throw Error("replay_answer_raw_mismatch");
    const input = {
      ...row.protocolInput,
      query: q,
      originalCitations: {
        reported:
          rawAnswer && typeof rawAnswer === "object"
            ? (rawAnswer as Record<string, unknown>).memoryIds
            : undefined,
        delivered: row.delivery.map((d) => d.actualId),
      },
      answer: canonicalMemoryAnswer(
        rawAnswer,
        new Map(row.delivery.map((d) => [d.actualId, d.id])),
      ),
    };
    const saved = auditByKey.get(auditKey(row)) ?? row.adjudication;
    // Scoring always receives the raw abstain and the actually reported IDs.
    const initial = scoreMemoryAnswer(input, rubric);
    tasks.push(async () => {
      let verdict = initial.verdict,
        audit: unknown;
      if (initial.verdict === "fail") {
        audit = { reason: "original_protocol_rejected", initial };
      } else if (model && config) {
        const checked = await adjudicateMemoryAnswer(
          input,
          initial,
          model,
          process.env.MEMORY_JUDGE_MODEL ?? config.model,
          q.requiredUnknown ?? rubric?.queries[q.id]?.requiredUnknown,
          { auditAll: true },
        );
        verdict = checked.verdict;
        audit = checked;
      } else if (saved?.inventory && saved.proof) {
        const checked = validateClaimAudit(
          input,
          saved.inventory,
          saved.proof,
          q.requiredUnknown ?? rubric?.queries[q.id]?.requiredUnknown,
        );
        verdict = claimAuditVerdict(checked);
        audit = checked;
      } else {
        verdict = "review";
        audit = {
          reason:
            saved && "error" in saved && saved.error
              ? saved.error
              : "legacy_judgment_has_no_independent_atomic_coverage",
        };
      }
      rows.push({
        id: row.id,
        file: row.file,
        repeat: row.repeat,
        answer: row.answer,
        originalProtocol: input,
        verdict,
        initial,
        dimensions: memoryBenchmarkDiagnostics(input),
        audit,
      });
      persist();
      console.log(`${rows.length} ${row.file}/${row.id}: ${verdict}`);
    });
  }
}
// Reviews are independent of one another and never mutate source responses.
// Bounded concurrency reduces wall time without grading until a target score.
let nextTask = 0;
const workers = await Promise.allSettled(
  Array.from({ length: Math.min(2, tasks.length) }, async () => {
    while (nextTask < tasks.length) await tasks[nextTask++]!();
  }),
);
const workerErrors = workers.filter((r) => r.status === "rejected");
if (workerErrors.length) throw Error("replay_worker_failed_results_incomplete");

report.gate = {
  passed: rows.length > 0 && rows.every((r) => r.verdict === "pass"),
  failures: rows.filter((r) => r.verdict !== "pass"),
};
persist();
console.log(
  JSON.stringify({
    samples: rows.length,
    passed: rows.filter((r) => r.verdict === "pass").length,
  }),
);
if (!report.gate.passed) process.exitCode = 1;
