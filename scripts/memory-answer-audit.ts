import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  scoreMemoryAnswer,
  type AnswerRubric,
  type AnswerScoreInput,
} from "./lib/memory-answer-score.js";
import { adjudicateMemoryAnswer } from "./lib/memory-answer-judge.js";
import { ProviderModel } from "../src/model.js";
import { loadConfig } from "../src/config.js";
import { textHash } from "../src/memory/evidence.js";

const read = (name: string) =>
  readFileSync(resolve("tests/fixtures", name), "utf8");
const raw = read("memory-query-regression.json"),
  data = JSON.parse(raw),
  rubric = JSON.parse(read("memory-answer-rubric.json")) as AnswerRubric,
  recorded = JSON.parse(read("memory-answer-recorded.json")) as {
    rows: (Omit<AnswerScoreInput, "facts"> & { oldCorrect: boolean })[];
  },
  out = resolve(
    process.env.MEMORY_EVAL_OUT ?? "test-results/memory-answer-audit",
  );
if (textHash(raw) !== rubric.datasetHash) throw Error("rubric_dataset_changed");
mkdirSync(out, { recursive: true });
const rows = recorded.rows.map((r) => ({
  ...r,
  score: scoreMemoryAnswer({ ...r, facts: data.facts }, rubric),
}));
const report: {
  at: string;
  syntheticOnly: boolean;
  rows: typeof rows;
  controls: unknown[];
  controlGate?: { passed: boolean; failures: string[] };
} = {
  at: new Date().toISOString(),
  syntheticOnly: true,
  rows,
  controls: [],
};
const persist = () =>
  writeFileSync(resolve(out, "results.json"), JSON.stringify(report, null, 2));
persist();
console.log(
  JSON.stringify({
    literal: rows.filter((r) => r.score.literalCorrect).length,
    reviewed: rows.filter((r) => r.score.verdict === "pass").length,
    total: rows.length,
  }),
);
if (process.argv.includes("--live-controls")) {
  const config = loadConfig({
      modelMode: "deepseek",
      trafficOrigin: "synthetic",
    }),
    model = new ProviderModel(config, () => config.model);
  const controls = JSON.parse(read("memory-answer-judge-controls.json")) as {
    id: string;
    queryId: string;
    text: string;
    cited: string[];
    abstain: boolean;
    expected: "pass" | "fail";
    question?: string;
    availableIds?: string[];
  }[];
  const failures: string[] = [];
  for (const c of controls) {
    const origin = recorded.rows.find((r) => r.query.id === c.queryId)!;
    const input = {
      ...origin,
      query: {
        ...data.queries.find((q: { id: string }) => q.id === c.queryId),
        ...(c.question ? { query: c.question } : {}),
      },
      availableIds: c.availableIds ?? origin.availableIds,
      facts: data.facts,
      answer: { answer: c.text, abstain: c.abstain, memoryIds: c.cited },
    };
    const initial = scoreMemoryAnswer(input, rubric),
      adjudication = await adjudicateMemoryAnswer(
        input,
        initial,
        model,
        process.env.MEMORY_JUDGE_MODEL ?? config.model,
        false,
        { auditAll: true },
      ),
      actual = adjudication.verdict;
    const pass = actual === c.expected;
    report.controls.push({ ...c, initial, adjudication, actual, pass });
    if (!pass) failures.push(c.id);
    persist();
    console.log(`${c.id}: ${pass ? "pass" : "FAIL"} (${actual})`);
  }
  report.controlGate = { passed: failures.length === 0, failures };
  persist();
  if (failures.length) process.exitCode = 1;
}
