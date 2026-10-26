import {
  closeSync,
  openSync,
  fsyncSync,
  renameSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, ScopeSchema } from "./domain.js";

const DeletionSchema = z
  .object({
    id: z.string().min(1),
    at: z.number().int().nonnegative(),
    scope: ScopeSchema,
    sourceIds: z.array(z.string().min(1)),
    memoryIds: z.array(z.string().min(1)),
    v3: z
      .object({
        ranges: z.array(
          z.object({
            id: z.string(),
            sourceId: z.string(),
            startUtf16: z.number().int().nonnegative(),
            endUtf16: z.number().int().positive(),
            sliceHash: z.string(),
            factHash: z.string().optional(),
            createdAt: z.number(),
          }),
        ),
        floorSeq: z.number().int().nonnegative(),
      })
      .optional(),
    schemaVersion: z.literal(2).optional(),
    summaryIds: z.array(z.string().min(1)).optional(),
    summaryBlocks: z
      .array(
        z.object({
          id: z.string(),
          messageIds: z.array(z.string()),
          policyVersion: z.string(),
        }),
      )
      .optional(),
  })
  .strict();
export type Deletion = z.infer<typeof DeletionSchema>;
export function readDeletionLedger(path: string): Deletion[] {
  if (!existsSync(path)) return [];
  try {
    return z
      .array(DeletionSchema)
      .parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new DomainError("deletion_ledger_invalid", 500);
  }
}
/** Flush data before rename and flush the parent directory before claiming durability. */
export function writePrivateJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(temp, path);
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
