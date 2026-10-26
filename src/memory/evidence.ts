import { suppressedEvidence } from "./companion-v3.js";
import { createHash } from "node:crypto";
import { DomainError } from "../domain.js";
import type { Store } from "../store.js";
import type { EvidenceRef } from "./types.js";
export const textHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function utf16Boundary(text: string, n: number) {
  return (
    Number.isInteger(n) &&
    n >= 0 &&
    n <= text.length &&
    !(
      n > 0 &&
      n < text.length &&
      /[\uD800-\uDBFF]/u.test(text[n - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(text[n]!)
    )
  );
}
export function resolveEvidence(
  store: Store,
  ref: EvidenceRef,
  depth = 0,
): string | undefined {
  if (store.hasMemoryV3 && suppressedEvidence(store, ref)) return;
  const entity =
    ref.entityType === "source"
      ? store.get("sources", ref.id)
      : ref.entityType === "message"
        ? store.get("messages", ref.id)
        : ref.entityType === "memory"
          ? store.get("memories", ref.id)
          : store.hasMemoryV2
            ? store.get("conversation_summaries", ref.id)
            : undefined;
  if (
    !entity ||
    ("deleted" in entity && entity.deleted) ||
    ("status" in entity && ["deleted", "superseded"].includes(entity.status))
  )
    return;
  if (depth > 2) return;
  if (
    "inputRefs" in entity &&
    !entity.inputRefs.every(
      (r) => resolveEvidence(store, r, depth + 1) !== undefined,
    )
  )
    return;
  if ("sources" in entity && !store.sourcesValid(entity.sources)) return;
  if (
    "evidence" in entity &&
    entity.evidence?.some(
      (r) => resolveEvidence(store, r, depth + 1) === undefined,
    )
  )
    return;
  if (
    ref.entityType === "message" &&
    "role" in entity &&
    entity.role === "user"
  ) {
    const source = store.get("sources", ref.id);
    if (
      source &&
      (source.deleted ||
        source.revision !== (ref.sourceRevision ?? ref.revision) ||
        source.text !== entity.content)
    )
      return;
  }
  const text = "content" in entity ? entity.content : entity.text;
  if (
    !utf16Boundary(text, ref.startUtf16) ||
    !utf16Boundary(text, ref.endUtf16) ||
    ref.endUtf16 <= ref.startUtf16
  )
    return;
  if (ref.entityType !== "message" && entity.revision !== ref.revision) return;
  if (
    ref.entityType === "message" &&
    "displayed" in entity &&
    entity.role === "assistant" &&
    ref.endUtf16 > Math.min(entity.displayed, ref.visibleEndUtf16 ?? 0)
  )
    return;
  const slice = text.slice(ref.startUtf16, ref.endUtf16);
  return textHash(slice) === ref.sliceHash ? slice : undefined;
}
export function captureMessage(
  store: Store,
  id: string,
  start = 0,
  end?: number,
): EvidenceRef {
  const m = store.require("messages", id);
  let visible =
    m.role === "assistant"
      ? Math.min(m.displayed, m.content.length)
      : m.content.length;
  if (!utf16Boundary(m.content, visible)) visible--;
  const to = end ?? visible;
  if (
    m.deleted ||
    !utf16Boundary(m.content, start) ||
    !utf16Boundary(m.content, to) ||
    to > visible ||
    start >= to
  )
    throw new DomainError("invalid_evidence", 422);
  return {
    entityType: "message",
    id,
    revision: m.revision,
    startUtf16: start,
    endUtf16: to,
    visibleEndUtf16: visible,
    sourceRevision:
      m.role === "user" ? store.get("sources", id)?.revision : undefined,
    sliceHash: textHash(m.content.slice(start, to)),
  };
}
export const evidenceValid = (store: Store, refs: EvidenceRef[]) =>
  refs.length > 0 && refs.every((r) => resolveEvidence(store, r) !== undefined);
