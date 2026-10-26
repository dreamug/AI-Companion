import type Database from "better-sqlite3";
import {
  dayKey,
  type CandidateLifecycle,
  type Scope,
  type TrafficOrigin,
} from "../domain.js";

/** Metadata-only SQL; safe on a read-only connection, without constructing Store. */
export function candidateMetrics(
  db: Database.Database,
  scope: Scope,
  now: number,
  traffic?: TrafficOrigin,
) {
  const rows = db
    .prepare(
      `SELECT id,json_extract(data,'$.lifecycleMetadata') AS lifecycle,
    json_extract(data,'$.status') AS status,json_extract(data,'$.expiresAt') AS expires
    FROM memories WHERE owner=? AND relationship=? AND json_extract(data,'$.kind')='assertion'`,
    )
    .all(scope.ownerUserId, scope.relationshipId) as {
    id: string;
    lifecycle: string | null;
    status: string;
    expires: number | null;
  }[];
  const settings = db
    .prepare(
      "SELECT json_extract(data,'$.timezone') AS timezone FROM settings WHERE owner=? AND relationship=?",
    )
    .get(scope.ownerUserId, scope.relationshipId) as
    { timezone: string } | undefined;
  const timezone = settings?.timezone ?? "Asia/Shanghai";
  const inputs = db
    .prepare(
      `SELECT created_at AS at,json_extract(data,'$.trafficOrigin') AS traffic
    FROM messages WHERE owner=? AND relationship=? AND json_extract(data,'$.role')='user'
    AND json_extract(data,'$.deleted')=0 AND json_extract(data,'$.trafficOrigin') IS NOT NULL`,
    )
    .all(scope.ownerUserId, scope.relationshipId) as {
    at: number;
    traffic: TrafficOrigin;
  }[];
  const known = rows.flatMap((r) => {
    const life = r.lifecycle
      ? (JSON.parse(r.lifecycle) as CandidateLifecycle)
      : undefined;
    return life?.origin === "automatic" &&
      life.candidateId === r.id &&
      (!traffic || life.trafficOrigin === traffic)
      ? [{ ...r, life }]
      : [];
  });
  const matchingInputs = inputs.filter(
    (i) => !traffic || i.traffic === traffic,
  );
  const publishRates =
    traffic !== "natural" ||
    (known.filter((r) => r.life.firstOfferedAt !== undefined).length >= 10 &&
      known.some((r) => r.life.proposedAt + 7 * 86400000 <= now));
  const rate = (n: number, d: number) => (publishRates && d ? n / d : null);
  const counts = (cohort: typeof known) => {
    const count = (reason: CandidateLifecycle["terminalReason"]) =>
      cohort.filter((r) => r.life.terminalReason === reason).length;
    const exposed = cohort.filter((r) => r.life.firstOfferedAt !== undefined);
    const mature = cohort.filter(
      (r) => r.life.proposedAt + 7 * 86400000 <= now,
    );
    const opportunities = cohort.filter(
      (r) => r.life.firstOpportunityAt !== undefined,
    ).length;
    return {
      produced: cohort.length,
      opportunities: cohort.reduce(
        (n, r) => n + (r.life.opportunityCount ?? 0),
        0,
      ),
      opportunityCandidates: opportunities,
      displayed: exposed.length,
      confirmed: count("confirmed"),
      corrected: cohort.filter((r) => r.life.corrected).length,
      deferred: cohort.filter((r) => r.life.deferredCount).length,
      discarded: count("discarded"),
      expired: count("expired"),
      overflow: count("overflow"),
      replaced: count("replaced"),
      sourceInvalidated: count("source_invalidated"),
      pending: cohort.filter((r) => r.status === "pending").length,
      pendingOverdue: cohort.filter(
        (r) => r.status === "pending" && r.expires !== null && r.expires <= now,
      ).length,
      rates: {
        displayPerOpportunityCandidate: rate(exposed.length, opportunities),
        confirmationAfterDisplay: rate(
          exposed.filter((r) => r.life.terminalReason === "confirmed").length,
          exposed.length,
        ),
        maturedConfirmation: rate(
          mature.filter(
            (r) =>
              r.life.terminalReason === "confirmed" &&
              r.life.decidedAt !== undefined &&
              r.life.decidedAt <= r.life.proposedAt + 7 * 86400000,
          ).length,
          mature.length,
        ),
        maturedExpiry: rate(
          mature.filter((r) => r.life.terminalReason === "expired").length,
          mature.length,
        ),
        overflow: rate(count("overflow"), cohort.length),
        discard: rate(count("discarded"), cohort.length),
        correction: rate(
          cohort.filter((r) => r.life.corrected).length,
          cohort.length,
        ),
      },
      denominators: { displayed: exposed.length, maturedCohort: mature.length },
    };
  };
  const totals = counts(known);
  const days = [
    ...new Set([
      ...known.map((r) => dayKey(r.life.proposedAt, timezone)),
      ...matchingInputs.map((i) => dayKey(i.at, timezone)),
    ]),
  ].sort();
  return {
    schemaVersion: 1,
    at: now,
    traffic: traffic ?? "all",
    scope,
    timezone,
    qualification:
      "retained_instrumented_candidates_and_inputs_not_lifetime_totals",
    legacyUnknownAssertions: rows.filter(
      (r) =>
        r.status !== "deleted" &&
        (!r.lifecycle || JSON.parse(r.lifecycle).origin === "unknown"),
    ).length,
    censoredCount: null,
    censoring:
      "forgotten_or_missing_metadata_cannot_be_counted_from_surviving_rows",
    ...totals,
    inputs: matchingInputs.length,
    producedPer100Inputs: rate(known.length * 100, matchingInputs.length),
    pendingAges: [1, 3, 7, Infinity].map((upper, i) => ({
      fromDays: i ? [1, 3, 7][i - 1] : 0,
      toDays: Number.isFinite(upper) ? upper : null,
      count: known.filter(
        (r) =>
          r.status === "pending" &&
          (now - r.life.proposedAt) / 86400000 >= (i ? [1, 3, 7][i - 1]! : 0) &&
          (now - r.life.proposedAt) / 86400000 < upper,
      ).length,
    })),
    cohorts: days.map((day) => {
      const cohort = known.filter(
        (r) => dayKey(r.life.proposedAt, timezone) === day,
      );
      const inputCount = matchingInputs.filter(
        (i) => dayKey(i.at, timezone) === day,
      ).length;
      return {
        day,
        ...counts(cohort),
        inputs: inputCount,
        producedPer100Inputs: rate(cohort.length * 100, inputCount),
      };
    }),
    assessment:
      traffic === "natural" &&
      totals.displayed >= 10 &&
      totals.denominators.maturedCohort > 0
        ? "review_required"
        : "insufficient_natural_sample",
    limitations: [
      "legacy_origin_and_exit_reason_unknown",
      "display_receipt_is_not_read_proof",
      "rates_apply_only_to_declared_traffic_and_retained_cohorts",
      "natural_sample_requires_seven_day_observation_review",
    ],
  };
}
