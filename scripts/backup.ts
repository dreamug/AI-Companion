import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { runningInstance, acquireInstance } from "../src/instance.js";
import { restoreBackup } from "../src/backup.js";

const config = loadConfig();
const args = process.argv.slice(2),
  restore = args.indexOf("--restore");
if (restore >= 0) {
  if (runningInstance(config.dataDir))
    throw new Error("请先停止当前实例，再执行备份恢复。");
  const id = args[restore + 1],
    to = args[args.indexOf("--to") + 1];
  if (!id || !to || !args.includes("--to") || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error(
      "用法：npm run backup -- --restore <备份ID> --to <新的空目录>",
    );
  const dir = join(config.dataDir, "backups");
  const release = acquireInstance(config.dataDir);
  try {
    const store = restoreBackup(
      join(dir, `${id}.sqlite`),
      resolve(to),
      LOCAL_SCOPE,
      [
        join(dir, `${id}.deletions.json`),
        join(config.dataDir, "deletions.json"),
      ],
    );
    console.log(
      JSON.stringify(
        {
          restoredTo: resolve(to),
          epoch: store.settings().epoch,
          latestDeletionLedgerApplied: true,
        },
        null,
        2,
      ),
    );
    store.close();
  } finally {
    release();
  }
} else {
  const running = runningInstance(config.dataDir);
  if (running) {
    const base = running.address ?? `http://127.0.0.1:${config.port}`;
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base))
      throw new Error("invalid_daemon_address");
    const bootResponse = await fetch(base + "/bootstrap", {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const boot = (await bootResponse.json()) as { csrfToken: string };
    const cookie = bootResponse.headers.get("set-cookie")?.split(";")[0];
    if (!bootResponse.ok || !cookie || !/^[a-f0-9]{64}$/.test(boot.csrfToken))
      throw new Error("backup_daemon_unavailable");
    const response = await fetch(base + "/v1/backups", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        cookie,
        "x-local-token": boot.csrfToken,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error("backup_daemon_failed");
    const receipt = (await response.json()) as {
      id: string;
      at: number;
      schemaVersion: number;
      epoch: number;
    };
    console.log(
      JSON.stringify(
        {
          id: receipt.id,
          at: receipt.at,
          schemaVersion: receipt.schemaVersion,
          epoch: receipt.epoch,
        },
        null,
        2,
      ),
    );
  } else {
    const release = acquireInstance(config.dataDir);
    try {
      const store = new Store(config.dataDir, LOCAL_SCOPE),
        id = randomUUID(),
        dir = join(config.dataDir, "backups");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await store.backup(join(dir, `${id}.sqlite`));
      if (existsSync(store.ledgerPath))
        copyFileSync(store.ledgerPath, join(dir, `${id}.deletions.json`));
      const manifest = {
        id,
        at: new Date().toISOString(),
        schemaVersion: store.hasMemoryV2 ? 2 : 1,
        epoch: store.settings().epoch,
      };
      writeFileSync(
        join(dir, `${id}.manifest.json`),
        JSON.stringify(manifest),
        {
          mode: 0o600,
        },
      );
      console.log(JSON.stringify(manifest, null, 2));
      store.close();
    } finally {
      release();
    }
  }
}
