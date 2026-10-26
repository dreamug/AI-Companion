import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store } from "./store.js";
import { DomainError, type Scope } from "./domain.js";
import {
  readDeletionLedger,
  writePrivateJson,
  type Deletion,
} from "./files.js";

/** Validate in a private staging directory; publish only a complete, redacted restore. */
export function restoreBackup(
  backupFile: string,
  targetDir: string,
  scope: Scope,
  ledgerFiles: string[],
): Store {
  if (!existsSync(backupFile)) throw new DomainError("backup_not_found", 404);
  if (resolve(backupFile) === resolve(join(targetDir, "companion.sqlite")))
    throw new DomainError("invalid_restore_target");
  if (existsSync(targetDir) && readdirSync(targetDir).length)
    throw new DomainError("restore_target_not_empty", 409);
  const entries = new Map<string, Deletion>();
  for (const file of ledgerFiles)
    for (const entry of readDeletionLedger(file)) {
      const previous = entries.get(entry.id);
      if (
        previous &&
        (previous.scope.ownerUserId !== entry.scope.ownerUserId ||
          previous.scope.relationshipId !== entry.scope.relationshipId)
      )
        throw new DomainError("deletion_ledger_conflict", 500);
      entries.set(
        entry.id,
        previous
          ? {
              ...entry,
              ...(previous.summaryIds || entry.summaryIds
                ? {
                    schemaVersion: 2 as const,
                    summaryIds: [
                      ...new Set([
                        ...(previous.summaryIds ?? []),
                        ...(entry.summaryIds ?? []),
                      ]),
                    ],
                    summaryBlocks: [
                      ...[
                        ...(previous.summaryBlocks ?? []),
                        ...(entry.summaryBlocks ?? []),
                      ]
                        .reduce((blocks, b) => {
                          const old = blocks.get(b.id);
                          blocks.set(b.id, {
                            ...b,
                            messageIds: [
                              ...new Set([
                                ...(old?.messageIds ?? []),
                                ...b.messageIds,
                              ]),
                            ],
                          });
                          return blocks;
                        }, new Map<string, NonNullable<Deletion["summaryBlocks"]>[number]>())
                        .values(),
                    ],
                  }
                : {}),
              sourceIds: [
                ...new Set([...previous.sourceIds, ...entry.sourceIds]),
              ],
              memoryIds: [
                ...new Set([...previous.memoryIds, ...entry.memoryIds]),
              ],
            }
          : entry,
      );
    }
  mkdirSync(dirname(targetDir), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(dirname(targetDir), ".companion-restore-"));
  let staged: Store | undefined;
  try {
    writePrivateJson(join(stage, "deletions.json"), [...entries.values()]);
    copyFileSync(backupFile, join(stage, "companion.sqlite"));
    staged = new Store(stage, scope);
    if (staged.hasMemoryV2) {
      staged.db
        .prepare(
          "DELETE FROM memory_embeddings WHERE owner=? AND relationship=?",
        )
        .run(scope.ownerUserId, scope.relationshipId);
      staged.db
        .prepare(
          "DELETE FROM memory_index_state WHERE owner=? AND relationship=?",
        )
        .run(scope.ownerUserId, scope.relationshipId);
      staged.bumpMemoryVersion("indexVersion");
    }
    staged.recover(Date.now());
    staged.close();
    staged = undefined;
    // Never overwrite data created by somebody else while the staging validation ran.
    if (existsSync(targetDir) && readdirSync(targetDir).length)
      throw new DomainError("restore_target_not_empty", 409);
    renameSync(stage, targetDir);
    return new Store(targetDir, scope);
  } finally {
    staged?.close();
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}
