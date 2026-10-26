import { z } from "zod";

export const MemoryAnswerSchema = z
  .object({
    answer: z
      .string()
      .min(1)
      .refine((text) => text.trim().length > 0),
    abstain: z.boolean(),
    memoryIds: z.array(z.string().min(1)),
  })
  .strict();
export type MemoryAnswer = z.infer<typeof MemoryAnswerSchema>;
/** Only translate storage IDs to fixture IDs. Never parse through a stripping
 * schema here: extra fields, invalid values, order and whitespace stay visible
 * to strict validation, including when replaying an older capture. */
export function canonicalMemoryAnswer(
  raw: unknown,
  aliases: ReadonlyMap<string, string>,
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  return {
    ...value,
    ...(Array.isArray(value.memoryIds)
      ? {
          memoryIds: value.memoryIds.map((id: unknown) =>
            typeof id === "string" ? (aliases.get(id) ?? id) : id,
          ),
        }
      : {}),
  };
}
export type AnswerRubric = {
  version: string;
  datasetHash: string;
  facts: {
    id: string;
    text: string;
    subject: string;
    primary: string[];
    supporting: string[];
    vocatives?: string[];
  }[];
  subjects: { subject: string; prefix: string }[];
  queries: Record<
    string,
    { subject: string; unknown?: string[]; requiredUnknown?: boolean }
  >;
};
export type AnswerScoreInput = {
  query: { id: string; expected: string[]; answer: string | null };
  answer: unknown;
  status: string;
  availableIds: string[];
  facts: { id: string; text: string }[];
  originalCitations?: { reported: unknown; delivered: string[] };
};
export function originalCitationsDelivered(input: AnswerScoreInput) {
  if (!input.originalCitations) return true;
  const { reported, delivered } = input.originalCitations;
  return (
    Array.isArray(reported) &&
    reported.every((id) => typeof id === "string" && delivered.includes(id))
  );
}
const normalized = (s: string) =>
  s.normalize("NFKC").replace(/[\s《》“”「」]/gu, "");
const matches = (s: string, patterns: string[]) =>
  patterns.some((p) => new RegExp(`^(?:${p})$`, "u").test(s));

/** A bounded, fixture-specific entailment rubric, not a general language judge.
 * Unrecognised wording stays reviewable; it never silently becomes a pass.
 * Every clause needs unchanged, delivered evidence and self-reported citations.
 * This is a frozen-fixture baseline; independent audits are required for live acceptance.
 */
export function scoreMemoryAnswer(
  input: AnswerScoreInput,
  rubric?: AnswerRubric,
) {
  const parsed = MemoryAnswerSchema.safeParse(input.answer);
  const reasons: string[] = [];
  const done = (
    verdict: "pass" | "fail" | "review",
    literalCorrect = false,
    claims: {
      clause: string;
      factId?: string;
      primary?: boolean;
      meta?: boolean;
    }[] = [],
  ) => ({
    version: rubric?.version ?? "literal-v1",
    verdict,
    literalCorrect,
    reasons,
    claims,
  });
  if (!parsed.success) {
    reasons.push("invalid_answer_schema");
    return done("fail");
  }
  const a = parsed.data,
    cited = new Set(a.memoryIds),
    expected = input.query.expected;
  // Preserve the previous metric, including its overly narrow citation rule.
  const literalCorrect = expected.length
    ? a.abstain === false &&
      cited.size > 0 &&
      [...cited].every((id) => expected.includes(id)) &&
      Boolean(
        input.query.answer &&
        normalized(a.answer).includes(normalized(input.query.answer)),
      )
    : a.abstain === true && cited.size === 0;
  if (input.status !== "completed") reasons.push("run_not_completed");
  if (cited.size !== a.memoryIds.length) reasons.push("duplicate_citation");
  if (
    !originalCitationsDelivered(input) ||
    [...cited].some((id) => !input.availableIds.includes(id))
  )
    reasons.push("citation_not_in_qualified_context");
  if (expected.length) {
    if (a.abstain) reasons.push("answerable_but_abstained");
    if (!expected.every((id) => cited.has(id)))
      reasons.push("missing_required_citation");
    if (!expected.every((id) => input.availableIds.includes(id)))
      reasons.push("required_evidence_not_delivered");
  } else if (!a.abstain) reasons.push("unknown_not_abstained");
  if (reasons.length) return done("fail", literalCorrect);
  const rule = rubric?.queries[input.query.id];
  if (!rubric || !rule) {
    reasons.push("no_semantic_rubric");
    return done("review", literalCorrect);
  }
  const facts = rubric.facts.filter((f) =>
    input.facts.some((actual) => actual.id === f.id && actual.text === f.text),
  );
  if (facts.length !== rubric.facts.length) {
    reasons.push("rubric_fact_changed");
    return done("fail", literalCorrect);
  }
  let subject = rule.subject,
    unknown = false;
  const claims: {
    clause: string;
    factId?: string;
    primary?: boolean;
    meta?: boolean;
  }[] = [];
  const clauses = normalized(a.answer)
    .split(/[，,。；;：:！!？?\n]+/u)
    .filter(Boolean);
  for (const [index, clause] of clauses.entries()) {
    const vocative =
      index === 0 &&
      clauses.length > 1 &&
      facts.find(
        (f) =>
          f.subject === "user" &&
          f.vocatives?.includes(clause) &&
          !expected.includes(f.id) &&
          input.availableIds.includes(f.id),
      );
    if (vocative) {
      claims.push({ clause, factId: vocative.id, primary: false, meta: true });
      if (!cited.has(vocative.id)) reasons.push("claim_missing_citation");
      continue;
    }
    if (matches(clause, rule.unknown ?? [])) {
      unknown = true;
      claims.push({ clause });
      continue;
    }
    let predicate = clause;
    for (const s of rubric.subjects) {
      const match = new RegExp(`^(?:${s.prefix})`, "u").exec(predicate);
      if (match) {
        subject = s.subject;
        predicate = predicate.slice(match[0].length);
        break;
      }
    }
    // A pronoun may only inherit an already established matching subject.
    predicate = predicate.replace(/^(?:他|她|它)(?:的)?/u, "");
    const fact = facts.find(
      (f) =>
        f.subject === subject &&
        matches(predicate, [...f.primary, ...f.supporting]),
    );
    if (!fact) {
      reasons.push("unrecognised_or_unsupported_clause");
      claims.push({ clause });
      continue;
    }
    claims.push({
      clause,
      factId: fact.id,
      primary: matches(predicate, fact.primary),
    });
    if (!input.availableIds.includes(fact.id))
      reasons.push("claim_evidence_not_delivered");
    if (!cited.has(fact.id)) reasons.push("claim_missing_citation");
  }
  if (expected.some((id) => !claims.some((c) => c.factId === id && c.primary)))
    reasons.push("required_answer_not_established");
  if ([...cited].some((id) => !claims.some((c) => c.factId === id)))
    reasons.push("citation_without_supported_claim");
  if ((!expected.length || rule.requiredUnknown) && !unknown)
    reasons.push("missing_explicit_unknown");
  return done(
    reasons.includes("claim_evidence_not_delivered")
      ? "fail"
      : reasons.length
        ? reasons.includes("unrecognised_or_unsupported_clause")
          ? "review"
          : "fail"
        : "pass",
    literalCorrect,
    claims,
  );
}
