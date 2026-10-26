import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { MockModel, ProviderModel, parseJson } from "../src/model.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { textHash } from "../src/memory/evidence.js";
import {
  MemoryAnswerSchema,
  canonicalMemoryAnswer,
  scoreMemoryAnswer,
  type AnswerRubric,
} from "./lib/memory-answer-score.js";
import { adjudicateMemoryAnswer } from "./lib/memory-answer-judge.js";
import { deliveredFixtureFacts } from "./lib/memory-delivery.js";
import type { ModelPort, TurnMessage } from "../src/model.js";
import {
  MEMORY_BENCHMARK_OUTPUT_INSTRUCTION,
  summarizeMemoryRetrieval,
} from "./lib/memory-benchmark-contract.js";

type Fact = {
  id: string;
  text: string;
  bot: string;
  status: string;
  sourceValid?: boolean;
  realityScope?: "reality" | "roleplay" | "unspecified";
  validTo?: number | string;
  validFrom?: number | string;
};
type Query = {
  id: string;
  query: string;
  expected: string[];
  answer: string | null;
  kind: string;
  split: string;
  requiredUnknown?: boolean;
};
const live = process.argv.includes("--live"),
  independent = process.argv.includes("--independent"),
  dir = mkdtempSync(join(tmpdir(), "memory-evaluation-")),
  out = resolve(
    process.env.MEMORY_EVAL_OUT ?? "test-results/memory-evaluation",
  );
mkdirSync(out, { recursive: true });
const config = loadConfig({
  dataDir: dir,
  modelMode: live ? "deepseek" : "mock",
  memoryV2: true,
  memoryVectors: true,
  memoryAnswerReasoning: process.argv.includes("--grounded-reasoning"),
  memorySummaries: false,
  maxRunMs: 60000,
  maxOutputTokens: 500,
  trafficOrigin: "synthetic",
});
const store = new Store(dir, LOCAL_SCOPE),
  provider = live
    ? new ProviderModel(config, () => config.model)
    : new MockModel(),
  // The synthetic protocol requires JSON, so request that format from the
  // provider as well as in the persona. No parsing repair or answer retries.
  // Ordinary product chat and the separate plain-chat test remain unchanged.
  model: ModelPort = {
    get name() {
      return provider.name;
    },
    stream(request) {
      return provider.stream({
        ...request,
        json: request.purpose === "chat" ? true : request.json,
      });
    },
  },
  h = new Harness(store, model, config);
const basePersonaStyle = store.settings().persona.style;
store.saveSettings({
  ...store.settings(),
  autoExtract: false,
  remoteDisclosureAcknowledged: true,
  dailyTokenBudget: 2000000,
});
const report: {
  at: string;
  syntheticOnly: boolean;
  datasets: unknown[];
  live: unknown[];
  limitations: string[];
  failures: unknown[];
  sourceRecallGate?: { passed: boolean; failures: unknown[] };
  liveAnswerGate?: { passed: boolean; failures: unknown[] };
  liveProtocolGate?: { passed: boolean; failures: unknown[] };
  independent: boolean;
  evaluationVersion: string;
  provider: string;
  answerProfile: string;
} = {
  at: new Date().toISOString(),
  syntheticOnly: true,
  independent,
  evaluationVersion: "memory-answer-evaluation-v7-diagnostic-axes",
  provider: config.model,
  answerProfile: config.memoryAnswerReasoning ? "grounded-low-v1" : "fast",
  datasets: [],
  live: [],
  failures: [],
  limitations: [
    "finite_synthetic_suite_not_all_natural_language",
    "historical_datasets_are_regression_not_fresh_holdout",
    "mock_answers_not_scored_as_semantic_accuracy",
    "literal_metric_preserved_but_not_a_semantic_judge",
    "bounded_fixture_rubric_unrecognised_wording_requires_review",
    "optional_judge_uses_same_provider_and_is_not_infallible_ground_truth",
  ],
};
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  if (
    (process.argv.includes("--assert-live") ||
      process.argv.includes("--assert-protocol")) &&
    !live
  )
    throw Error("live_assertion_requires_live");
  if (
    process.argv.includes("--assert-live") &&
    !process.argv.includes("--judge")
  )
    throw Error("strict_live_assertion_requires_independent_judge");
  h.memory.embedding!.warm();
  for (let i = 0; i < 300 && !h.memory.embedding!.ready; i++) await delay(100);
  if (!h.memory.embedding!.ready) throw Error("local_embedding_not_ready");
  const liveOption = process.argv.indexOf("--live-ids"),
    liveIds =
      liveOption < 0
        ? undefined
        : (process.argv[liveOption + 1] ?? "").split(",");
  const allDatasets = [
      "dataset.json",
      "dataset-challenge.json",
      "holdout.json",
      "query-regression.json",
      "answer-boundaries.json",
      "open-world.json",
      "positive-attributes.json",
      "citation-generalization.json",
      "acceptance-v1.json",
    ],
    option = process.argv.indexOf("--dataset"),
    requested = option < 0 ? undefined : process.argv[option + 1];
  const selectedDatasets = requested?.split(",") ?? allDatasets;
  if (
    option >= 0 &&
    (!selectedDatasets.length ||
      selectedDatasets.some((f) => !allDatasets.includes(f)) ||
      new Set(selectedDatasets).size !== selectedDatasets.length)
  )
    throw Error("invalid_dataset");
  for (const file of selectedDatasets) {
    const raw = readFileSync(
        file === "holdout.json" ||
          file === "query-regression.json" ||
          file === "answer-boundaries.json" ||
          file === "open-world.json" ||
          file === "positive-attributes.json" ||
          file === "citation-generalization.json" ||
          file === "acceptance-v1.json"
          ? resolve(
              "tests/fixtures",
              file === "holdout.json"
                ? "memory-holdout.json"
                : file === "query-regression.json"
                  ? "memory-query-regression.json"
                  : file === "answer-boundaries.json"
                    ? "memory-answer-boundaries.json"
                    : file === "open-world.json"
                      ? "memory-open-world.json"
                      : file === "positive-attributes.json"
                        ? "memory-positive-attributes.json"
                        : file === "acceptance-v1.json"
                          ? "memory-acceptance-v1.json"
                          : "memory-citation-generalization.json",
            )
          : resolve("scripts/memory-lab", file),
        "utf8",
      ),
      dataset = JSON.parse(raw) as { facts: Fact[]; queries: Query[] };
    const rubricFile =
      file === "query-regression.json"
        ? "memory-answer-rubric.json"
        : file === "answer-boundaries.json"
          ? "memory-answer-boundaries-rubric.json"
          : file === "open-world.json"
            ? "memory-open-world-rubric.json"
            : file === "positive-attributes.json"
              ? "memory-positive-attributes-rubric.json"
              : undefined;
    const rubric = rubricFile
      ? (JSON.parse(
          readFileSync(resolve("tests/fixtures", rubricFile), "utf8"),
        ) as AnswerRubric)
      : undefined;
    if (rubric && rubric.datasetHash !== textHash(raw))
      throw Error("rubric_dataset_changed");
    // Reset only this run's isolated fixture, never connect to a real bot database.
    for (const m of store.all("memories"))
      store.put("memories", { ...m, status: "deleted" });
    const aliases = new Map<string, string>(),
      ids = new Map<string, string>();
    for (const f of dataset.facts) {
      if (f.bot !== "a" || f.status !== "active") continue;
      const m = h.addMemory({
        text: f.text,
        validTo:
          typeof f.validTo === "string" ? Date.parse(f.validTo) : f.validTo,
        validFrom:
          typeof f.validFrom === "string"
            ? Date.parse(f.validFrom)
            : f.validFrom,
        realityScope: f.realityScope ?? "reality",
      });
      aliases.set(m.id, f.id);
      ids.set(f.id, m.id);
      if (f.sourceValid === false) {
        const source = store.require("sources", m.sources[0]!.id);
        store.put("sources", { ...source, revision: source.revision + 1 });
      }
    }
    const count = store
      .all("memories")
      .filter((m) => m.status === "active").length;
    for (let i = 0; i < count + 2; i++)
      await h.memory.indexOne(new AbortController().signal, Date.now());
    const rows = [];
    for (const q of dataset.queries) {
      const start = performance.now(),
        r = await h.memory.facts(q.query, Date.now());
      const actual = r.selected.map((m) => aliases.get(m.id) ?? "unknown");
      rows.push({
        id: q.id,
        kind: q.kind,
        split: q.split,
        expected: q.expected,
        actual,
        hit: q.expected.length
          ? q.expected.some((id) => actual.includes(id))
          : null,
        allExpected: q.expected.every((id) => actual.includes(id)),
        mode: r.mode,
        reasons: r.reasons,
        diagnostic: r.diagnostic
          ? {
              semantic: r.diagnostic.semanticIds.map((id) => aliases.get(id)),
              keyword: r.diagnostic.keywordIds.map((id) => aliases.get(id)),
            }
          : undefined,
        elapsedMs: performance.now() - start,
      });
    }
    const sorted = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const summary = {
      file,
      datasetHash: textHash(raw),
      rubricHash: rubric ? textHash(JSON.stringify(rubric)) : undefined,
      rubricVersion: rubric?.version,
      n: rows.length,
      ...summarizeMemoryRetrieval(rows),
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      rows,
    };
    report.datasets.push(summary);
    persist();
    console.log(
      JSON.stringify({
        file,
        n: rows.length,
        completeSourceRecall: summary.completeRecall,
        rankedRecallAt5: summary.rankedRecallAt5,
        p95Ms: summary.p95Ms,
      }),
    );
    if (
      (live &&
        (liveIds ||
          file === "dataset-challenge.json" ||
          file === "holdout.json" ||
          file === "query-regression.json")) ||
      (live &&
        (file === "answer-boundaries.json" ||
          file === "open-world.json" ||
          file === "positive-attributes.json" ||
          file === "citation-generalization.json" ||
          file === "acceptance-v1.json"))
    ) {
      const settings = store.settings();
      store.saveSettings({
        ...settings,
        persona: {
          ...settings.persona,
          style: basePersonaStyle + "。" + MEMORY_BENCHMARK_OUTPUT_INSTRUCTION,
        },
      });
      const queries = dataset.queries
        .filter((q) => (liveIds ? liveIds.includes(q.id) : q.split === "test"))
        .slice(0, file === "holdout.json" ? 36 : 24);
      const repeatOption = process.argv.indexOf("--repeat"),
        repeats = repeatOption < 0 ? 1 : Number(process.argv[repeatOption + 1]);
      if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5)
        throw Error("invalid_repeat");
      for (let repeat = 0; repeat < repeats; repeat++)
        for (const q of queries) {
          if (independent)
            for (const m of store.all("messages")) {
              if (!m.deleted) store.put("messages", { ...m, deleted: true });
            }
          const start = performance.now(),
            result = h.submit(q.query, crypto.randomUUID());
          await h.waitForIdle(70000);
          const run = store.require("runs", result.runId),
            message = store
              .all("messages")
              .find((m) => m.runId === result.runId && m.role === "assistant");
          let answer: unknown = {};
          try {
            answer = parseJson(message?.content ?? "") as typeof answer;
          } catch {
            /* malformed output is a failure, never dropped */
          }
          const snapshot = h.context(result.runId) as {
              messages: TurnMessage[];
              meta: { selected?: { id: string }[]; historyIds?: string[] };
            },
            meta = snapshot.meta;
          if (independent && meta.historyIds?.length)
            throw Error("independent_history_leaked");
          const parsed = MemoryAnswerSchema.safeParse(answer),
            delivery = deliveredFixtureFacts(
              snapshot.messages,
              dataset.facts.flatMap((f) => {
                const actualId = ids.get(f.id);
                return actualId ? [{ actualId, id: f.id, text: f.text }] : [];
              }),
            ),
            scoreInput = {
              query: q,
              answer: canonicalMemoryAnswer(answer, aliases),
              originalCitations: {
                reported:
                  answer && typeof answer === "object"
                    ? (answer as Record<string, unknown>).memoryIds
                    : undefined,
                delivered: delivery.map((d) => d.actualId),
              },
              status: run.status,
              availableIds: delivery.map((m) => m.id),
              facts: dataset.facts,
            },
            score = scoreMemoryAnswer(scoreInput, rubric),
            adjudication = process.argv.includes("--judge")
              ? await adjudicateMemoryAnswer(
                  scoreInput,
                  score,
                  model,
                  process.env.MEMORY_JUDGE_MODEL ?? config.model,
                  q.requiredUnknown ?? rubric?.queries[q.id]?.requiredUnknown,
                  { auditAll: true },
                )
              : undefined,
            verdict = adjudication?.verdict ?? score.verdict,
            judgedCitation =
              adjudication &&
              "validation" in adjudication &&
              adjudication.validation
                ? adjudication.validation.citationComplete
                : undefined,
            protocolMatches =
              verdict === "pass" &&
              (judgedCitation ?? score.verdict === "pass"),
            expected = q.expected.map((id) => ids.get(id)).filter(Boolean),
            correct = score.literalCorrect;
          report.live.push({
            id: q.id,
            file,
            repeat,
            query: q.query,
            expected: q.answer,
            expectedIds: expected,
            answer,
            raw: message?.content,
            correct,
            score,
            delivery,
            scoringInput: scoreInput,
            protocolInput: scoreInput,
            protocolMatches,
            reportedAbstainMatches:
              parsed.success &&
              parsed.data.abstain === (q.expected.length === 0),
            protocolScore: score,
            adjudication,
            verdict,
            status: run.status,
            reason: run.reason,
            elapsedMs: performance.now() - start,
            context: meta,
          });
          persist();
          console.log(
            `live ${report.live.length} ${q.id}: ${verdict} (rubric=${score.verdict},literal=${correct})`,
          );
          if (message) h.displayed(message.id, message.content.length);
        }
    }
  }
  const summaries = report.datasets as {
    file: string;
    known: number;
    hits: number;
    completeHits: number;
  }[];
  const misses = summaries
    .filter((s) => s.known !== s.completeHits)
    .map((s) => ({ file: s.file, expected: s.known, actual: s.completeHits }));
  report.sourceRecallGate = { passed: misses.length === 0, failures: misses };
  if (live) {
    const failures = (
      report.live as {
        id: string;
        file: string;
        repeat: number;
        verdict: string;
        adjudication?: unknown;
        score: { verdict: string; reasons: string[] };
      }[]
    )
      .filter((r) => r.verdict !== "pass")
      .map((r) => ({
        id: r.id,
        file: r.file,
        repeat: r.repeat,
        verdict: r.verdict,
        score: r.score,
        adjudication: r.adjudication,
      }));
    if (!report.live.length)
      failures.push({
        id: "no_live_samples",
        file: "",
        repeat: 0,
        verdict: "fail",
        score: { verdict: "fail", reasons: ["no_live_samples"] },
        adjudication: undefined,
      });
    report.liveAnswerGate = { passed: failures.length === 0, failures };
    const protocolFailures = (
      report.live as {
        id: string;
        file: string;
        repeat: number;
        protocolMatches: boolean;
      }[]
    )
      .filter((r) => !r.protocolMatches)
      .map((r) => ({
        id: r.id,
        file: r.file,
        repeat: r.repeat,
        reason: "reported_marker_or_citation_closure_not_verified",
      }));
    report.liveProtocolGate = {
      passed: protocolFailures.length === 0 && report.live.length > 0,
      failures: protocolFailures,
    };
    if (process.argv.includes("--assert-live") && failures.length)
      throw Error("memory_live_answer_regression");
    if (
      process.argv.includes("--assert-protocol") &&
      !report.liveProtocolGate.passed
    )
      throw Error("memory_live_protocol_regression");
  }
  if (process.argv.includes("--assert") && misses.length)
    throw Error("memory_recall_regression");
} catch (e) {
  report.failures.push({
    error: e instanceof Error ? e.message : "evaluation_failed",
  });
  persist();
  process.exitCode = 1;
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
  persist();
}
