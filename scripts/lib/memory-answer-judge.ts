import type { ModelPort } from "../../src/model.js";
import {
  auditMemoryClaims,
  type ClaimAuditResult,
} from "./memory-claim-audit.js";
import type {
  AnswerScoreInput,
  scoreMemoryAnswer,
} from "./memory-answer-score.js";

export async function adjudicateMemoryAnswer(
  input: AnswerScoreInput & {
    query: AnswerScoreInput["query"] & { query: string };
  },
  initial: ReturnType<typeof scoreMemoryAnswer>,
  model: ModelPort,
  modelName: string,
  requireUnknown = false,
  options: { auditAll?: boolean } = {},
): Promise<ClaimAuditResult> {
  if (
    initial.verdict === "fail" ||
    (initial.verdict === "pass" && !options.auditAll)
  )
    return { verdict: initial.verdict };
  return auditMemoryClaims(input, model, modelName, requireUnknown);
}
