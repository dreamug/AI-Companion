import { join } from "node:path";
import { loadConfig } from "./config.js";
import { BotManager, ORIGINAL_BOT_ID } from "./bots.js";
import { createApp } from "./server.js";
import { acquireInstance } from "./instance.js";
import { writePrivateJson } from "./files.js";
import { stableMemoryConfig } from "./memory/stable-config.js";

let release: (() => void) | undefined,
  bots: BotManager | undefined,
  app: Awaited<ReturnType<typeof createApp>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await app?.close();
  } finally {
    await bots?.close();
    release?.();
  }
}
try {
  const config = stableMemoryConfig(loadConfig());
  release = acquireInstance(config.dataDir);
  bots = new BotManager(config);
  const harness = bots.get(ORIGINAL_BOT_ID);
  app = await createApp(harness, { bots });
  const address = await app.listen({ host: config.host, port: config.port });
  writePrivateJson(join(config.dataDir, "daemon.lock"), {
    pid: process.pid,
    startedAt: Date.now(),
    address,
  });
  bots.start();
  console.log(`陪伴 Harness 已启动：${address}`);
  console.log(
    `模型：${harness.model.name}；数据保存在本地私有目录。按 Ctrl+C 停止。`,
  );
  const shutdown = () =>
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  try {
    await stop();
  } catch {}
  console.error("启动失败，请检查端口、运行版本、数据目录或是否已有实例。");
  process.exitCode = 1;
}
