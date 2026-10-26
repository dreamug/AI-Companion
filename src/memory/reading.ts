import { companionCurrent } from "./companion-v3.js";
import { memoryQuery } from "./query.js";
import { tokenEstimate, type Memory } from "../domain.js";
import { evidenceValid } from "./evidence.js";
import { excerpt } from "./chunks.js";
import type { Store } from "../store.js";

export const MEMORY_POLICY_VERSION = "memory-read-v1.1";
export const FACT_BUDGET = 2000;
export function nextRoute(
  previous: "all" | "hybrid" | undefined,
  tokens: number,
) {
  return previous === "hybrid"
    ? tokens <= 1700
      ? ("all" as const)
      : ("hybrid" as const)
    : tokens > FACT_BUDGET
      ? ("hybrid" as const)
      : ("all" as const);
}
export function projectMemory(m: Memory) {
  return {
    id: m.id,
    revision: m.revision,
    text: m.text,
    kind: m.kind,
    certainty: m.certainty,
    ...(m.admission ? { admission: m.admission } : {}),
    sources: m.sources,
    day: m.day,
    occurredAt: m.occurredAt,
    learnedAt: m.createdAt,
    validFrom: m.validFrom,
    validTo: m.validTo,
    realityScope: m.realityScope ?? "unspecified",
    subject: m.subject,
    episodeType: m.episodeType,
    excerpt: m.excerpt,
    excerptSpan: m.excerptSpan,
    expandId: m.excerpt ? `memory:${m.id}` : undefined,
    coverage: m.coverage,
  };
}
export const projectedTokens = (memories: Memory[]) =>
  tokenEstimate(JSON.stringify(memories.map(projectMemory)));

export function validMemory(
  store: Store,
  m: Memory,
  now: number,
  cutoff = Infinity,
) {
  return (
    (!store.hasMemoryV3 ||
      companionCurrent(
        store,
        m,
        now,
        store.byStatus("conversation_segments", ["open"])[0]?.id,
      )) &&
    m.status === "active" &&
    (!m.evidence || evidenceValid(store, m.evidence)) &&
    m.sources.length > 0 &&
    store.sourcesValid(m.sources) &&
    (m.validFrom === undefined || m.validFrom <= now) &&
    (m.validTo === undefined || m.validTo > now) &&
    (m.expiresAt === undefined || m.expiresAt > now) &&
    m.sources.every((ref) => {
      const msg = store.get("messages", ref.id);
      return (
        !msg ||
        Number(store.get("runs", msg.runId)?.config.enqueueSeq ?? 0) <= cutoff
      );
    })
  );
}
export function eligibleFact(
  store: Store,
  m: Memory,
  now: number,
  cutoff = Infinity,
) {
  return (
    m.kind === "assertion" &&
    (m.certainty === "confirmed" ||
      (store.hasMemoryV3 && m.admission?.state === "committed")) &&
    m.category !== "interpretation" &&
    validMemory(store, m, now, cutoff)
  );
}
export function inDomain(
  store: Store,
  m: Memory,
  query = "",
  requestedDomain?: "reality" | "roleplay",
) {
  const domain =
    requestedDomain ??
    (store.settings().persona.memoryScope === "roleplay"
      ? "roleplay"
      : "reality");
  const reality = m.realityScope ?? "unspecified";
  if (reality !== "unspecified" && reality !== domain) return false;
  return !(
    reality === "unspecified" &&
    /(?:现实|线下|真实).{0,10}(?:经历|履历|发生)/u.test(query)
  );
}
/** Bounded probe: reaching EOF, not a UI list limit, proves all facts were read. */
function probeFacts(
  store: Store,
  now: number,
  domain?: "reality" | "roleplay",
) {
  const facts: Memory[] = [];
  let tokens = 2;
  for (const m of store.memoryEnabled
    ? store.qualifiedFacts(now, Infinity, domain)
    : store.factCandidates(now)) {
    if (!eligibleFact(store, m, now) || !inDomain(store, m, "", domain))
      continue;
    facts.push(m);
    tokens = projectedTokens(facts);
    if (tokens > FACT_BUDGET) return { facts, tokens, complete: false };
  }
  return { facts, tokens, complete: true };
}
export function prepareMemoryRouting(store: Store, now: number) {
  const s = store.settings(),
    probe = probeFacts(store, now);
  const previous =
    s.memoryReadState?.policyVersion === MEMORY_POLICY_VERSION
      ? s.memoryReadState.routeState
      : undefined;
  const routeState = nextRoute(previous, probe.tokens);
  if (previous !== routeState || !s.memoryReadState)
    store.saveSettings({
      ...s,
      memoryReadState: { routeState, policyVersion: MEMORY_POLICY_VERSION },
    });
  return routeState;
}
export function readFacts(
  store: Store,
  query: string,
  now: number,
  cutoff = Infinity,
  budget = FACT_BUDGET,
  domain?: "reality" | "roleplay",
  forceAll = false,
  keywordCandidates?: Memory[],
) {
  const s = store.settings(),
    defaultProbe = probeFacts(store, now),
    defaultDomain =
      s.persona.memoryScope === "roleplay" ? "roleplay" : "reality",
    probe =
      domain && domain !== defaultDomain
        ? probeFacts(store, now, domain)
        : defaultProbe;
  const previous =
    s.memoryReadState?.policyVersion === MEMORY_POLICY_VERSION
      ? s.memoryReadState.routeState
      : undefined;
  const routeState = nextRoute(previous, defaultProbe.tokens);
  const qualifies = (m: Memory) =>
    eligibleFact(store, m, now, cutoff) && inDomain(store, m, query, domain);
  const all = forceAll || (routeState === "all" && probe.complete);
  const pinned = store
    .contextMemories()
    .filter((m) => m.pinned && qualifies(m));
  const keywords = all
    ? []
    : (keywordCandidates?.filter(qualifies).slice(0, 5) ??
      store.search(
        query,
        now,
        5,
        store.memoryEnabled ? memoryQuery(query).keywords : [],
        qualifies,
      ));
  const candidates = all
    ? (forceAll ? [...store.factCandidates(now)] : probe.facts).filter(
        qualifies,
      )
    : [...pinned, ...keywords];
  const selected = [...new Map(candidates.map((m) => [m.id, m])).values()].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (all ? a.id.localeCompare(b.id) : 0),
  );
  if (store.memoryEnabled && !forceAll)
    for (let i = 0; i < selected.length; i++) {
      const m = selected[i]!;
      if (projectedTokens([m]) > budget) {
        const e = excerpt(m.text, query, Math.max(150, budget - 200));
        selected[i] = {
          ...m,
          text: e.text,
          excerpt: e.partial,
          excerptSpan: e.partial
            ? { startUtf16: e.start!, endUtf16: e.end! }
            : undefined,
        };
      }
    }
  const excluded: { id: string; reason: string }[] = [];
  while (selected.length && projectedTokens(selected) > budget) {
    const nonPinned = selected.findLastIndex((m) => !m.pinned);
    const index =
      nonPinned >= 0
        ? nonPinned
        : selected.reduce(
            (best, m, i) =>
              m.createdAt < selected[best]!.createdAt ? i : best,
            0,
          );
    const [m] = selected.splice(index, 1);
    excluded.push({ id: m!.id, reason: "memory_budget" });
  }
  return {
    selected,
    keywordIds: keywords.map((m) => m.id),
    excluded,
    routeState,
    mode:
      excluded.length || selected.some((m) => m.excerpt)
        ? "budget_limited"
        : all
          ? "all"
          : "keyword",
    allEligibleFactsIncluded:
      all && excluded.length === 0 && !selected.some((m) => m.excerpt),
    state:
      all && !excluded.length && !selected.some((m) => m.excerpt)
        ? "ok"
        : "degraded",
    reasons: [
      ...(all ? [] : ["semantic_not_enabled"]),
      ...(excluded.length ? ["memory_budget"] : []),
      ...(selected.some((m) => m.excerpt) ? ["memory_excerpt"] : []),
    ],
    factTokensAtLeast: probe.tokens,
    policyVersion: MEMORY_POLICY_VERSION,
  };
}

export type FactRead = Omit<ReturnType<typeof readFacts>, "mode" | "state"> & {
  mode: ReturnType<typeof readFacts>["mode"] | "unavailable";
  state: ReturnType<typeof readFacts>["state"] | "unavailable";
  diagnostic?: {
    semanticIds: string[];
    keywordIds: string[];
    deltaIds: string[];
  };
};
