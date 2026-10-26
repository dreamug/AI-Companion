import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../../src/config.js";
import { writePrivateJson } from "../../src/files.js";
import type { Dataset } from "./lexical.js";

const out = resolve(process.env.MEMORY_LAB_OUT ?? "data/reports/memory-lab");
mkdirSync(out, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(tmpdir(), "aic-memory-reader-"));
const config = loadConfig({ dataDir: dir, modelMode: "mock" });
if (!config.apiKey) throw Error("reader_key_missing");
const data = JSON.parse(
  readFileSync(
    process.env.MEMORY_LAB_DATASET ?? "scripts/memory-lab/dataset.json",
    "utf8",
  ),
) as Dataset;
const testCount = data.queries.filter((q) => q.split === "test").length;
const retrieval = JSON.parse(
  readFileSync(join(out, "retrieval-results.json"), "utf8"),
) as {
  datasetSha256: string;
  rankings: Record<string, Record<string, string[]>>;
};
type Answer = {
  id: string;
  answer: string;
  abstain: boolean;
  memoryIds: string[];
};
type Row = Answer & {
  method: string;
  correct: boolean;
  answerGrounded: boolean;
  expected: string | null;
  kind: string;
};
type Report = {
  datasetSha256: string;
  rows: Row[];
  batches: {
    method: string;
    queries: number;
    elapsedMs: number;
    usage: unknown;
  }[];
};
const path = join(out, "reader-results.json");
const methods = process.env.MEMORY_LAB_METHODS?.split(",") ?? [
  "keyword",
  "rewrite",
  "selected-hybrid",
  "hybrid-e5-384",
  "hybrid-qwen-512",
];
let report: Report = {
  datasetSha256: retrieval.datasetSha256,
  rows: [],
  batches: [],
};
if (existsSync(path)) {
  const old = JSON.parse(readFileSync(path, "utf8")) as Report;
  if (old.datasetSha256 === report.datasetSha256) report = old;
}
try {
  for (const method of methods) {
    const queries = data.queries.filter(
      (q) =>
        q.split === "test" &&
        !report.rows.some((r) => r.method === method && r.id === q.id),
    );
    for (let i = 0; i < queries.length; i += 4) {
      const block = queries.slice(i, i + 4);
      const inputs = block.map((q) => ({
        id: q.id,
        question: q.query,
        candidates: retrieval.rankings[method]![q.id]!.map((id) => ({
          id,
          text: data.facts.find((f) => f.id === id)!.text,
        })),
      }));
      const t = performance.now();
      const r = await fetch(
        `${config.baseURL.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "deepseek-flash",
            temperature: 0,
            max_tokens: 1800,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  '你是记忆问答实验的阅读器。对每个问题，仅使用它自己的candidates，不能跨问题借用内容。相似主题不代表有答案，缺少问题所问的属性必须明确不知道，abstain=true，answer="不知道"，memoryIds=[]。尊重否定、关系主体、现在/计划/过去，不能把计划当作已发生。用简短中文回答并引用支持答案的候选id。输出JSON {"items":[{"id":"问题id","answer":"回答","abstain":false,"memoryIds":["id"]}]}。当前日期2026-10-23。',
              },
              { role: "user", content: JSON.stringify(inputs) },
            ],
          }),
          signal: AbortSignal.timeout(60000),
        },
      );
      if (!r.ok) throw Error(`reader_http_${r.status}`);
      const body = (await r.json()) as {
        choices: { message: { content: string } }[];
        usage: unknown;
      };
      const parsed = JSON.parse(body.choices[0]!.message.content) as {
        items: Answer[];
      };
      for (const q of block) {
        const answer = parsed.items.find((a) => a.id === q.id);
        if (
          !answer ||
          typeof answer.abstain !== "boolean" ||
          !Array.isArray(answer.memoryIds)
        )
          throw Error("reader_invalid_response");
        const ids = retrieval.rankings[method]![q.id]!;
        const grounded =
          answer.memoryIds.length > 0 &&
          answer.memoryIds.every((id) => ids.includes(id)) &&
          q.expected.some((id) => answer.memoryIds.includes(id));
        const correct =
          q.expected.length === 0
            ? answer.abstain
            : !answer.abstain &&
              grounded &&
              answer.answer.replace(/\s/g, "").includes(q.answer!);
        report.rows.push({
          ...answer,
          method,
          correct,
          answerGrounded: grounded,
          expected: q.answer,
          kind: q.kind,
        });
      }
      report.batches.push({
        method,
        queries: block.length,
        elapsedMs: performance.now() - t,
        usage: body.usage,
      });
      writePrivateJson(path, report);
      console.log(
        `reader ${method}: ${report.rows.filter((r) => r.method === method).length}/${testCount}`,
      );
    }
  }
  const summary = Object.fromEntries(
    methods.map((method) => {
      const rows = report.rows.filter((r) => r.method === method),
        known = rows.filter((r) => r.expected !== null),
        unknown = rows.filter((r) => r.expected === null);
      return [
        method,
        {
          n: rows.length,
          correct: rows.filter((r) => r.correct).length,
          accuracy: rows.filter((r) => r.correct).length / rows.length,
          knownCorrect: known.filter((r) => r.correct).length,
          knownN: known.length,
          unknownAbstained: unknown.filter((r) => r.correct).length,
          unknownN: unknown.length,
          unsupportedAnswers: rows.filter(
            (r) => !r.abstain && !r.answerGrounded,
          ).length,
        },
      ];
    }),
  );
  writePrivateJson(join(out, "reader-summary.json"), summary);
  console.log(JSON.stringify(summary));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
