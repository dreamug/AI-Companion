/** Synthetic evaluation only. No entities, attributes, query IDs or gold labels. */
export const MEMORY_BENCHMARK_OUTPUT_INSTRUCTION =
  "本次为合成记忆测试。输出恰好包含answer、abstain、memoryIds三个键的JSON对象；不要输出API参数、type字段或其他键。answer是面向用户的简短回答字符串。abstain是布尔值，表示所问主要属性是否未知：单个目标未知为true，多项目标有已知部分为false，并说明未知部分；已陈述的前提不算所问目标。memoryIds是实际交付记录的id字符串数组，覆盖回答每项事实及必要的关系、别名、称呼依据。每个引用都须有实际作用，一条记录可支持多项事实，多项记录也可共同支持一项事实。只说明未知且未陈述个人事实时数组为空。不要复述不需要的背景或无关检索资料。输出前逐句核对证据与引用，保留全部必需依据，删除无关引用；不得编造未提供的id。";

export const MEMORY_BENCHMARK_VERSION = "memory-benchmark-v1";

export function summarizeMemoryRetrieval(
  rows: { expected: string[]; actual: string[]; mode: string }[],
) {
  const known = rows.filter((r) => r.expected.length > 0);
  const ranked = known.filter((r) => r.mode !== "all");
  return {
    known: known.length,
    unknownExcluded: rows.length - known.length,
    hits: known.filter((r) => r.expected.some((id) => r.actual.includes(id)))
      .length,
    completeHits: known.filter((r) =>
      r.expected.every((id) => r.actual.includes(id)),
    ).length,
    sourceHitRate: known.length
      ? known.filter((r) => r.expected.some((id) => r.actual.includes(id)))
          .length / known.length
      : null,
    completeRecall: known.length
      ? known.filter((r) => r.expected.every((id) => r.actual.includes(id)))
          .length / known.length
      : null,
    rankedQuestions: ranked.length,
    allModeQuestions: known.length - ranked.length,
    rankedRecallAt5: ranked.length
      ? ranked.reduce(
          (n, r) =>
            n +
            r.expected.filter((id) => r.actual.slice(0, 5).includes(id))
              .length /
              r.expected.length,
          0,
        ) / ranked.length
      : null,
  };
}

import {
  MemoryAnswerSchema,
  originalCitationsDelivered,
  type AnswerScoreInput,
} from "./memory-answer-score.js";

/** Diagnostic axes never replace the strict verdict or rewrite a response. */
export function memoryBenchmarkDiagnostics(input: AnswerScoreInput) {
  const parsed = MemoryAnswerSchema.safeParse(input.answer);
  const raw =
    input.answer && typeof input.answer === "object"
      ? (input.answer as Record<string, unknown>)
      : {};
  const ids = raw.memoryIds;
  return {
    version: MEMORY_BENCHMARK_VERSION,
    protocol: parsed.success ? "pass" : "fail",
    protocolIssues: parsed.success
      ? []
      : parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
    answerabilityFlag:
      typeof raw.abstain !== "boolean"
        ? "not_assessed"
        : raw.abstain === (input.query.expected.length === 0)
          ? "pass"
          : "fail",
    citationDelivery:
      !Array.isArray(ids) || ids.some((id) => typeof id !== "string")
        ? "not_assessed"
        : originalCitationsDelivered(input) &&
            ids.every((id) => input.availableIds.includes(id))
          ? "pass"
          : "fail",
    duplicateCitations: Array.isArray(ids)
      ? new Set(ids).size !== ids.length
      : null,
    // Delivery is not citation relevance; an LLM verdict is not ground truth.
    semanticAccuracy: "requires_validated_review",
  };
}
