import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { Store } from "../store.js";
import { LOCAL_SCOPE, DomainError } from "../domain.js";
import { acquireInstance, runningInstance } from "../instance.js";
import { writePrivateJson } from "../files.js";

const Manifest = z.object({
  version: z.literal(1),
  bots: z
    .array(
      z
        .object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) })
        .passthrough(),
    )
    .min(1)
    .max(24),
});
const tables = [
  "messages",
  "memories",
  "sources",
  "runs",
  "input_keys",
  "persona_history",
  "followups",
  "series",
  "deliveries",
] as const;
export function releaseSnapshot(db: Database.Database) {
  return Object.fromEntries(
    tables.map((table) => {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
      return [
        table,
        {
          count: rows.length,
          sha256: createHash("sha256")
            .update(JSON.stringify(rows))
            .digest("hex"),
        },
      ];
    }),
  );
}
function inventory(root: string) {
  const manifest = Manifest.parse(
    JSON.parse(readFileSync(join(root, "bots.json"), "utf8")),
  );
  if (
    new Set(manifest.bots.map((b) => b.id)).size !== manifest.bots.length ||
    !manifest.bots.some((b) => b.id === "xiaoye")
  )
    throw new DomainError("bot_manifest_invalid");
  return manifest.bots.map((b) => {
    const dir = b.id === "xiaoye" ? root : join(root, "bots", b.id);
    if (realpathSync(dir) !== dir)
      throw new DomainError("release_symlink_forbidden");
    if (!existsSync(join(dir, "companion.sqlite")))
      throw new DomainError("database_missing");
    return {
      id: b.id,
      dir,
      scope:
        b.id === "xiaoye"
          ? LOCAL_SCOPE
          : {
              ownerUserId: LOCAL_SCOPE.ownerUserId,
              relationshipId: `bot-${b.id}`,
            },
    };
  });
}

/** Copy verification is the default; --apply is an explicit stopped-service operation.
 * All source databases are backed up and validated before any in-place migration starts. */
export async function releaseMemory(
  rootPath: string,
  artifactPath: string,
  apply = false,
) {
  const root = realpathSync(rootPath),
    artifact = resolve(artifactPath);
  if (artifact === root || artifact.startsWith(root + "/"))
    throw new DomainError("release_artifacts_must_be_separate");
  if (existsSync(join(artifact, "release.json")))
    throw new DomainError("release_already_started");
  if (apply && runningInstance(root))
    throw new DomainError("stop_service_before_migration", 409);
  mkdirSync(artifact, { recursive: true, mode: 0o700 });
  const entries = inventory(root);
  const release = apply ? acquireInstance(root) : () => {};
  const report = {
    version: "cm3-stable-20261026",
    apply,
    status: "preparing",
    bots: [] as {
      id: string;
      beforeSchema: number;
      preserved: boolean;
      before: ReturnType<typeof releaseSnapshot>;
      after?: ReturnType<typeof releaseSnapshot>;
    }[],
    embeddingPerformed: false,
    modelCalls: 0,
  };
  const checkpoint = () =>
    writePrivateJson(join(artifact, "release.json"), report);
  try {
    checkpoint();
    copyFileSync(join(root, "bots.json"), join(artifact, "bots.json"));
    for (const e of entries) {
      const source = new Database(join(e.dir, "companion.sqlite"), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        if (
          source
            .prepare(
              "SELECT 1 FROM runs WHERE json_extract(data,'$.status') IN ('running','queued') LIMIT 1",
            )
            .get()
        )
          throw new DomainError("run_in_progress", 409);
        const scopes = source
          .prepare("SELECT owner,relationship FROM settings")
          .all() as { owner: string; relationship: string }[];
        if (
          scopes.length !== 1 ||
          scopes[0]!.owner !== e.scope.ownerUserId ||
          scopes[0]!.relationship !== e.scope.relationshipId
        )
          throw new DomainError("release_scope_mismatch", 409);
        const backup = join(artifact, "backups", e.id);
        mkdirSync(backup, { recursive: true, mode: 0o700 });
        await source.backup(join(backup, "companion.sqlite"));
        chmodSync(join(backup, "companion.sqlite"), 0o600);
        if (existsSync(join(e.dir, "deletions.json")))
          copyFileSync(
            join(e.dir, "deletions.json"),
            join(backup, "deletions.json"),
          );
        report.bots.push({
          id: e.id,
          beforeSchema: source.pragma("user_version", {
            simple: true,
          }) as number,
          preserved: false,
          before: releaseSnapshot(source),
        });
      } finally {
        source.close();
      }
    }
    // Verify every role on a consistent private copy, including archived roles.
    for (const e of entries) {
      const target = join(artifact, "verified", e.id);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      copyFileSync(
        join(artifact, "backups", e.id, "companion.sqlite"),
        join(target, "companion.sqlite"),
      );
      const ledger = join(artifact, "backups", e.id, "deletions.json");
      if (existsSync(ledger))
        copyFileSync(ledger, join(target, "deletions.json"));
      const store = new Store(target, e.scope);
      try {
        store.enableMemoryV3();
        store.saveSettings({ ...store.settings(), proactiveEnabled: false });
        const row = report.bots.find((b) => b.id === e.id)!;
        row.after = releaseSnapshot(store.db);
        row.preserved =
          JSON.stringify(row.before) === JSON.stringify(row.after);
        if (
          !row.preserved ||
          store.db.pragma("integrity_check", { simple: true }) !== "ok"
        )
          throw new DomainError("migration_validation_failed");
      } finally {
        store.close();
      }
    }
    report.status = "copy_verified";
    checkpoint();
    if (apply) {
      // Refuse a stale backup before the first mutation. No automatic restore or schema downgrade.
      for (const e of entries) {
        const db = new Database(join(e.dir, "companion.sqlite"), {
          readonly: true,
        });
        try {
          if (
            JSON.stringify(releaseSnapshot(db)) !==
            JSON.stringify(report.bots.find((b) => b.id === e.id)!.before)
          )
            throw new DomainError("source_changed_during_release");
        } finally {
          db.close();
        }
      }
      for (const e of entries) {
        const store = new Store(e.dir, e.scope);
        try {
          store.enableMemoryV3();
          const s = store.settings();
          store.saveSettings({
            ...s,
            proactiveEnabled: false,
            revision: s.revision + (s.proactiveEnabled ? 1 : 0),
          });
          if (
            JSON.stringify(releaseSnapshot(store.db)) !==
            JSON.stringify(report.bots.find((b) => b.id === e.id)!.before)
          )
            throw new DomainError("migration_validation_failed");
        } finally {
          store.close();
        }
      }
      report.status = "applied";
      checkpoint();
    }
    return report;
  } catch (error) {
    report.status = "failed_requires_inspection";
    checkpoint();
    throw error;
  } finally {
    release();
  }
}
