import { randomUUID, createHash } from "node:crypto";
import {
  dayKey,
  isImmediateRisk,
  type Memory,
  type TrafficOrigin,
  type CandidateLifecycle,
} from "../domain.js";
import type { Store } from "../store.js";

export function candidateLifecycle(
  id: string,
  now: number,
  traffic: TrafficOrigin,
): CandidateLifecycle {
  return {
    candidateId: id,
    origin: "automatic",
    trafficOrigin: traffic,
    proposedAt: now,
  };
}
export function pendingEligible(store: Store, m: Memory, now: number) {
  return (
    m.kind === "assertion" &&
    m.status === "pending" &&
    m.sources.length > 0 &&
    store.sourcesValid(m.sources) &&
    (m.expiresAt === undefined || m.expiresAt > now) &&
    (m.validFrom === undefined || m.validFrom <= now) &&
    (m.validTo === undefined || m.validTo > now)
  );
}
export function closeLifecycle(
  m: Memory,
  reason: NonNullable<CandidateLifecycle["terminalReason"]>,
  now: number,
) {
  return m.lifecycleMetadata
    ? { ...m.lifecycleMetadata, terminalReason: reason, decidedAt: now }
    : undefined;
}
export function relatedText(query: string, m: Memory) {
  if (m.topic && query.includes(m.topic)) return true;
  const terms = [...query.matchAll(/[\p{Script=Han}]{2,}|[a-z0-9]{3,}/giu)].map(
    (x) => x[0].toLowerCase(),
  );
  return terms.some((term) => {
    if (m.text.toLowerCase().includes(term)) return true;
    return (
      /\p{Script=Han}/u.test(term) &&
      Array.from(term).some((_, i) => {
        const pair = Array.from(term)
          .slice(i, i + 2)
          .join("");
        return (
          pair.length >= 2 &&
          ![
            "记住",
            "喜欢",
            "什么",
            "我的",
            "这个",
            "那个",
            "以后",
            "我们",
            "今天",
            "用户",
            "希望",
          ].includes(pair) &&
          m.text.includes(pair)
        );
      })
    );
  });
}
/** Called only at committed domain boundaries; snapshots never create offers. */
export function prepareCandidateOffer(store: Store, now: number) {
  const s = store.settings();
  if (
    s.focused ||
    s.muted ||
    store.byStatus("runs", ["queued", "running"]).length
  )
    return false;
  const latest = store
    .list("messages", 200)
    .find((m) => m.role === "user" && !m.deleted);
  if (
    !latest ||
    isImmediateRisk(latest.content) ||
    refusesMemory(latest.content)
  )
    return false;
  const existing = s.memoryCandidateOffer;
  if (existing?.inputId === latest.id) {
    const m = store.get("memories", existing.candidateId);
    if (m && pendingEligible(store, m, now)) return false;
  }
  const day = dayKey(now, s.timezone),
    explicit = explicitlyRequestsMemory(latest.content);
  const candidates = store
    .byStatus("memories", ["pending"])
    .filter(
      (m) =>
        pendingEligible(store, m, now) &&
        m.category !== "interpretation" &&
        m.certainty !== "disputed",
    )
    .filter(
      (m) =>
        ((explicit || store.memoryEnabled) &&
          m.sources.some((r) => r.id === latest.id)) ||
        relatedText(latest.content, m),
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  let changed = false;
  for (const m of candidates) {
    if (explicit && !m.sources.some((r) => r.id === latest.id)) continue;
    const life = m.lifecycleMetadata ?? {
      candidateId: m.id,
      origin: "unknown" as const,
      trafficOrigin: "unknown" as const,
      proposedAt: m.createdAt,
    };
    // Legacy candidates may be offered, but never relabelled as measured production.
    if (life.terminalReason) continue;
    if (life.lastOpportunityInputId !== latest.id) {
      store.put("memories", {
        ...m,
        lifecycleMetadata: {
          ...life,
          firstOpportunityAt: life.firstOpportunityAt ?? now,
          opportunityCount: (life.opportunityCount ?? 0) + 1,
          lastOpportunityInputId: latest.id,
        },
      });
    }
    if (
      life.firstOfferedAt !== undefined ||
      life.deferredCount ||
      s.memoryCandidateOffer?.candidateId === m.id
    )
      continue;
    const ownSource = m.sources.some((r) => r.id === latest.id);
    // Inline decisions for a fresh statement are separate from reminders to
    // revisit older candidates. Neither consumes the other's daily allowance.
    const fresh = store.memoryEnabled && ownSource;
    if (fresh && s.lastInlineMemoryOfferInputId === latest.id) continue;
    if (
      (explicit && ownSource) ||
      fresh ||
      s.lastProactiveMemoryOfferDay !== day
    ) {
      const kind =
        explicit && ownSource
          ? ("explicit" as const)
          : fresh
            ? ("new" as const)
            : ("related" as const);
      store.saveSettings({
        ...store.settings(),
        memoryCandidateOffer: {
          candidateId: m.id,
          offerId: randomUUID(),
          inputId: latest.id,
          day,
          kind,
        },
        ...(fresh ? { lastInlineMemoryOfferInputId: latest.id } : {}),
        ...(kind === "related" ? { lastProactiveMemoryOfferDay: day } : {}),
      });
      changed = true;
      break;
    }
  }
  return changed;
}
export function currentCandidateOffer(store: Store, now: number) {
  const s = store.settings(),
    offer = s.memoryCandidateOffer;
  if (
    !offer ||
    s.focused ||
    s.muted ||
    store.byStatus("runs", ["queued", "running"]).length
  )
    return null;
  const m = store.get("memories", offer.candidateId);
  const latest = store
    .list("messages", 200)
    .find((x) => x.role === "user" && !x.deleted);
  if (
    !m ||
    !pendingEligible(store, m, now) ||
    latest?.id !== offer.inputId ||
    isImmediateRisk(latest.content) ||
    refusesMemory(latest.content)
  )
    return null;
  return { offerId: offer.offerId, kind: offer.kind, memory: m };
}

export function explicitlyRequestsMemory(text: string) {
  // Commands quoted as examples or discussed as past speech are not consent.
  // Keep quoted payloads intact in storage; only inspect prose for routing.
  const prose = text.replace(
    /```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"/gu,
    "",
  );
  return (
    !refusesMemory(prose) &&
    /(?:^|[。！？!?，,；;：:\n])\s*(?:(?:请(?:你)?|麻烦(?:你)?)\s*)?(?:(?:你)?(?:能不能|能否|可不可以|可以|能)\s*(?:帮我|替我|给我)\s*|(?:帮我|替我|给我|帮忙)\s*)?(?:(?:把|将)[^。！？!?\n]{1,80}?(?:记下来|记住|保存|存(?:下来|下|一下|一份|好))|(?:记住|记下|记一下|记下来|保存|存(?:下来|下|一下|一份|好)|记录下来)(?!了|过|没|多少|什么|哪些)|以后都)/u.test(
      prose,
    )
  );
}

export function refusesMemory(text: string) {
  return /(?:不要|别|不必|不用|不想|无需|不需要).{0,8}(?:记住|记录|保存|存(?:下来|下|一下|一份|好))/u.test(
    text,
  );
}

export function candidateTextHash(text: string) {
  return createHash("sha256")
    .update(text.normalize("NFKC").trim())
    .digest("hex");
}
