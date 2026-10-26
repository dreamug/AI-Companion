import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { runningInstance, acquireInstance } from "../src/instance.js";
const args = process.argv.slice(2),
  index = args.indexOf("--data-dir");
if (index < 0 || !args[index + 1])
  throw Error("--data-dir 必填；默认只验证副本，--apply 才原地迁移。");
const root = resolve(args[index + 1]!),
  botIndex = args.indexOf("--bot"),
  bot = botIndex < 0 ? "xiaoye" : args[botIndex + 1]!;
if (!/^[a-z0-9-]+$/.test(bot)) throw Error("invalid_bot");
const dir = bot === "xiaoye" ? root : join(root, "bots", bot),
  path = join(dir, "companion.sqlite");
if (!existsSync(path)) throw Error("database_missing");
const apply = args.includes("--apply");
if (apply && runningInstance(root))
  throw Error("请先停止运行实例；迁移会先生成一致性备份。");
const stage = apply
  ? dir
  : mkdtempSync(join(tmpdir(), "memory-migration-check-"));
let store: Store | undefined;
const release = apply ? acquireInstance(root) : () => {};
try {
  if (!apply) {
    const source = new Database(path, { readonly: true, fileMustExist: true });
    try {
      await source.backup(join(stage, "companion.sqlite"));
    } finally {
      source.close();
    }
    if (existsSync(join(dir, "deletions.json")))
      copyFileSync(join(dir, "deletions.json"), join(stage, "deletions.json"));
  }
  store = new Store(
    stage,
    bot === "xiaoye"
      ? LOCAL_SCOPE
      : { ownerUserId: LOCAL_SCOPE.ownerUserId, relationshipId: `bot-${bot}` },
  );
  const before = Object.fromEntries(
    ["messages", "memories", "sources", "runs"].map((table) => [
      table,
      (
        store!.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
  store.enableMemoryV2();
  const after = Object.fromEntries(
    ["messages", "memories", "sources", "runs"].map((table) => [
      table,
      (
        store!.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    store.db.pragma("integrity_check", { simple: true }) !== "ok"
  )
    throw Error("migration_validation_failed");
  console.log(
    JSON.stringify({
      bot,
      mode: apply ? "applied" : "isolated_copy_verified",
      schemaVersion: 2,
      rowCountsPreserved: true,
      before,
      after,
      embeddingPerformed: false,
    }),
  );
} finally {
  store?.close();
  release();
  if (!apply) rmSync(stage, { recursive: true, force: true });
}
