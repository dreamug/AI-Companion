import type { SourceRef } from "../domain.js";
export type EvidenceRef = {
  entityType: "source" | "message" | "memory" | "summary";
  id: string;
  revision: number;
  startUtf16: number;
  endUtf16: number;
  visibleEndUtf16?: number;
  sourceRevision?: number;
  sliceHash: string;
};
export type Segment = {
  id: string;
  firstSeq: number;
  lastSeq: number;
  startedAt: number;
  lastUserAt: number;
  status: "open" | "closed";
  createdAt: number;
};
export type ConversationSummary = {
  id: string;
  segmentId: string;
  realityScope?: "reality" | "roleplay" | "unspecified";
  rangeKey: string;
  inputRefs: EvidenceRef[];
  inputHash: string;
  policyVersion: string;
  text: string;
  coverage: {
    messageIds: string[];
    firstSeq: number;
    lastSeq: number;
    partial: boolean;
  };
  status: "active" | "superseded" | "deleted";
  rebuildBlocked: boolean;
  revision: number;
  createdAt: number;
  sources: SourceRef[];
};
export type MemoryState = {
  memoryVersion: number;
  contextVersion: number;
  indexVersion: number;
};
