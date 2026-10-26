import type { EvidenceRef } from "./types.js";
export type FormationMode = "automatic" | "explicit_only" | "off";
export type Admission = {
  policyVersion: "companion-memory-v3.4";
  state: "committed";
  origin:
    "explicit_user" | "automatic_user_statement" | "legacy_user_confirmed";
  mutationId: string;
  learnedAt: number;
  observedThroughSeq: number;
  subjectId: string;
  scopeKind: "relationship" | "segment" | "until";
  scopeId?: string;
  validUntil?: number;
  riskClass: "ordinary";
};
export type ProfileSlot = {
  id: string;
  key: string;
  memoryId: string;
  revision: number;
  createdAt: number;
  status: "active" | "deleted";
};
export type MemoryInbox = {
  id: string;
  inputId: string;
  inputRevision: number;
  status:
    | "queued"
    | "running"
    | "requires_sync"
    | "committed"
    | "noop"
    | "partial"
    | "failed"
    | "cancelled"
    | "quarantined";
  createdAt: number;
  deadlineAt: number;
  settledAt?: number;
  reason?: string;
  mutationId?: string;
  timezone?: string;
};
export type Mutation = {
  id: string;
  inputId: string;
  inputRevision: number;
  status: "committed" | "noop" | "partial" | "quarantined" | "failed";
  createdAt: number;
  committedAt?: number;
  operations: {
    action: string;
    id: string;
    revision: number;
    durability: "durable" | "segment" | "until";
  }[];
  rejected: { index: number; reason: string }[];
  planHash: string;
};
export type Suppression = {
  id: string;
  sourceId: string;
  startUtf16: number;
  endUtf16: number;
  sliceHash: string;
  factHash?: string;
  createdAt: number;
};
export type V3Deletion = {
  ranges: Suppression[];
  floorSeq: number;
  evidence: EvidenceRef[];
};
