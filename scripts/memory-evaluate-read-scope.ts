import { memoryOperationState } from "../src/memory/operations.js";
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { collect, ProviderModel } from "../src/model.js";
import {
  memoryReplyReview,
  parseMemoryReplyAssessment,
} from "../src/memory/reply-contract.js";
import { memoryReadScope } from "../src/memory/read-scope.js";
import { writePrivateJson } from "../src/files.js";

// Frozen, same-author synthetic cases. Labels never enter the judge request.
// This measures the narrow contract reviewer, not end-to-end recall accuracy.
const raw = readFileSync(
  process.env.MEMORY_EVAL_FIXTURE ??
    new URL(
      "../tests/fixtures/memory-read-scope-live-v7.json",
      import.meta.url,
    ),
  "utf8",
);
const fixture = JSON.parse(raw) as {
  cases: {
    id: string;
    mode: string;
    complete: boolean;
    userInput: string;
    draft: string;
    evidence: { id: string; text: string }[];
    reject: boolean;
    saveIntent?: boolean;
    time?: { currentTime: string; timezone: string; localHour: number };
    expectedViolation?: string;
    expectedViolations?: string[];
  }[];
};
const out = resolve(
  process.env.MEMORY_EVAL_OUT ??
    "test-results/memory-read-scope-live-v7-contract",
);
mkdirSync(out, { recursive: true, mode: 0o700 });
const config = loadConfig({
  dataDir: join(out, "config"),
  memoryVectors: false,
});
const provider = new ProviderModel(config, () => config.model);
const report = {
  fixtureHash: createHash("sha256").update(raw).digest("hex"),
  sameAuthorSynthetic: true,
  passed: 0,
  failed: 0,
  rows: [] as unknown[],
};
const concurrency = Math.min(
  4,
  Math.max(1, Number(process.env.MEMORY_EVAL_CONCURRENCY ?? 1)),
);
const order = new Map(fixture.cases.map((c, i) => [c.id, i]));
async function evaluateCase(c: (typeof fixture.cases)[number]) {
  const request = {
    userInput: c.userInput,
    draft: c.draft,
    saveIntent: c.saveIntent ?? false,
    memoryOperations: memoryOperationState(),
    memoryReadData: {
      reads: [
        memoryReadScope(
          { mode: c.mode, complete: c.complete },
          c.evidence.length,
        ),
      ],
      evidence: c.evidence,
      confirmedFacts: c.evidence.map((e) => ({
        ...e,
        revision: 1,
        certainty: "confirmed",
      })),
      ...(c.time ? { time: c.time } : {}),
    },
  };
  let verdict: { checks: unknown[]; violations: string[] } | undefined,
    error: string | undefined;
  const parts: unknown[] = [];
  try {
    const assessments = [];
    for (const contractPart of ["facts", "operations"] as const) {
      const system = memoryReplyReview(c.saveIntent ?? false, contractPart);
      const actual = { ...request, contractPart };
      const row: Record<string, unknown> = {
        contractPart,
        system,
        request: actual,
      };
      parts.push(row);
      const result = await collect(provider, {
        purpose: "judge",
        model: config.model,
        system,
        messages: [{ role: "user", content: JSON.stringify(actual) }],
        tools: [],
        signal: AbortSignal.timeout(30000),
        maxOutputTokens: 4096,
        json: true,
        reasoningEffort: "low",
      });
      row.rawResult = result.text;
      row.usage = result.usage;
      const assessment = parseMemoryReplyAssessment(
        JSON.parse(result.text),
        c.draft,
        c.saveIntent ?? false,
        contractPart,
      );
      row.verdict = assessment;
      assessments.push(assessment);
    }
    verdict = {
      checks: assessments.flatMap((v) => v.checks),
      violations: [...new Set(assessments.flatMap((v) => v.violations))],
    };
  } catch (e) {
    error = e instanceof Error ? e.message : "error";
  }
  const violations = (verdict as { violations?: string[] } | undefined)
    ?.violations;
  const expected = c.reject
    ? (c.expectedViolations ?? [
        c.expectedViolation ?? "unsupported_memory_absence",
      ])
    : [];
  const passed =
    !error &&
    Array.isArray(violations) &&
    JSON.stringify([...violations].sort()) === JSON.stringify(expected.sort());
  report[passed ? "passed" : "failed"]++;
  report.rows.push({
    test: c,
    request,
    parts,
    verdict,
    error,
    passed,
  });
  report.rows.sort(
    (a, b) =>
      order.get((a as { test: { id: string } }).test.id)! -
      order.get((b as { test: { id: string } }).test.id)!,
  );
  writePrivateJson(join(out, "results.json"), { ...report, concurrency });
  console.log(`${c.id}: ${passed ? "pass" : "FAIL"}`);
}
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < fixture.cases.length) {
      const c = fixture.cases[next++]!;
      await evaluateCase(c);
    }
  }),
);
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
if (report.failed) process.exitCode = 1;
