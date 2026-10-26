import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BotManager } from "../src/bots.js";
import { Store } from "../src/store.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import { releaseMemory, releaseSnapshot } from "../src/memory/release.js";
import { writePrivateJson } from "../src/files.js";
import { acquireInstance, runningInstance } from "../src/instance.js";
import { setup } from "./helpers.js";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of dispose.splice(0).reverse()) await d();
});
function fixture() {
  const x = setup();
  dispose.push(async () => {
    await x.h.close();
    rmSync(x.dir, { recursive: true, force: true });
  });
  const artifacts = mkdtempSync(join(tmpdir(), "memory-release-test-"));
  dispose.push(async () => rmSync(artifacts, { recursive: true, force: true }));
  return { ...x, artifacts };
}
it("stable entry point selects the accepted baseline, never the conversation experiment or vectors", () => {
  const x = fixture();
  expect(
    stableMemoryConfig({
      ...x.config,
      memoryVectors: true,
      memoryReplyGuard: false,
      conversationExperiment: true,
      memoryFactsModel: "deepseek-v4-pro",
    }),
  ).toMatchObject({
    memoryV3: true,
    memoryFastPath: true,
    memoryReplyGuard: true,
    memoryVectors: false,
    memorySummaries: false,
    memoryAnswerReasoning: false,
    conversationExperiment: false,
    memoryFactsModel: undefined,
  });
});
it("standard bot can initialize an empty database, create a clean role, and restart without migration", async () => {
  const x = fixture();
  await x.h.close();
  const fresh = join(x.artifacts, "new-app");
  mkdirSync(fresh);
  const config = stableMemoryConfig({ ...x.config, dataDir: fresh });
  const bots = new BotManager(config);
  expect(bots.get().store.hasMemoryV3).toBe(true);
  expect(bots.list()).toHaveLength(1);
  expect(bots.get().store.settings().proactiveEnabled).toBe(false);
  const created = bots.create({ name: "另一个角色" });
  expect(bots.get(created.id).store.all("memories")).toHaveLength(0);
  await bots.close();
  const again = new BotManager(config);
  expect(again.list()).toHaveLength(2);
  expect(again.get(created.id).store.hasMemoryV3).toBe(true);
  await again.close();
});
it("existing v1 databases still require an explicit migration instead of silently upgrading at startup", async () => {
  const x = fixture();
  await x.h.close();
  expect(() => new BotManager(stableMemoryConfig(x.config))).toThrow(
    "companion_migration_required",
  );
  const db = new Database(join(x.dir, "companion.sqlite"));
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  db.close();
});
it("copy verification preserves originals, then stopped-service apply preserves history, memories, models and personas", async () => {
  const x = fixture();
  const memory = x.h.addMemory({ text: "legacy manual fact", pinned: true });
  x.h.submit("原始聊天", "original");
  await x.h.waitForIdle();
  const before = releaseSnapshot(x.store.db),
    settings = x.store.settings();
  await x.h.close();
  writePrivateJson(join(x.dir, "bots.json"), {
    version: 1,
    bots: [{ id: "xiaoye", name: "旧角色", createdAt: 1 }],
  });
  const checked = await releaseMemory(x.dir, join(x.artifacts, "check"));
  expect(checked.status).toBe("copy_verified");
  let db = new Database(join(x.dir, "companion.sqlite"));
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(releaseSnapshot(db)).toEqual(before);
  db.close();
  const applied = await releaseMemory(x.dir, join(x.artifacts, "apply"), true);
  expect(applied.status).toBe("applied");
  expect(applied.modelCalls).toBe(0);
  const store = new Store(x.dir, LOCAL_SCOPE);
  expect(store.hasMemoryV3).toBe(true);
  expect(releaseSnapshot(store.db)).toEqual(before);
  expect(store.settings().persona).toEqual(settings.persona);
  expect(store.settings().model).toBe(settings.model);
  expect(store.settings().proactiveEnabled).toBe(false);
  expect(store.require("memories", memory.id).certainty).toBe("confirmed");
  store.close();
  db = new Database(join(x.artifacts, "apply/backups/xiaoye/companion.sqlite"));
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(releaseSnapshot(db)).toEqual(before);
  db.close();
});
it("running service refuses in-place migration, and invalid inventory does not leave a root instance lock", async () => {
  const x = fixture();
  await x.h.close();
  writePrivateJson(join(x.dir, "bots.json"), {
    version: 1,
    bots: [{ id: "xiaoye", createdAt: 1 }],
  });
  const unlock = acquireInstance(x.dir);
  await expect(
    releaseMemory(x.dir, join(x.artifacts, "apply"), true),
  ).rejects.toThrow("stop_service_before_migration");
  unlock();
  writePrivateJson(join(x.dir, "bots.json"), {
    version: 1,
    bots: [{ id: "../escape", createdAt: 1 }],
  });
  await expect(
    releaseMemory(x.dir, join(x.artifacts, "invalid"), true),
  ).rejects.toThrow();
  expect(runningInstance(x.dir)).toBeUndefined();
});
