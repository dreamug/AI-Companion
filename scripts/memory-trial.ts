import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Harness } from "../src/harness.js";
import { Store } from "../src/store.js";
import { ProviderModel } from "../src/model.js";
import { createApp } from "../src/server.js";
import { acquireInstance } from "../src/instance.js";
import { writePrivateJson } from "../src/files.js";
import { LOCAL_SCOPE } from "../src/domain.js";

// A separate, persistent trial. Never inherit the formal service's data path,
// port or memory flags. Uses the same Harness, provider and Web as the product.
const dataDir = resolve(import.meta.dirname, "../local-data/memory-trial");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (realpathSync(dataDir) !== dataDir)
  throw new Error("试用数据目录不能通过符号链接指向其他目录。");
chmodSync(dataDir, 0o700);
const config = loadConfig({
  dataDir,
  port: 4321,
  modelMode: "deepseek",
  memoryV2: true,
  memorySummaries: true,
  memoryVectors: true,
  memoryAnswerReasoning: true,
  memoryReplyGuard: true,
  trafficOrigin: "natural",
});
let release: (() => void) | undefined;
let store: Store | undefined;
let harness: Harness | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await app?.close();
  } finally {
    try {
      if (harness) await harness.close();
      else store?.close();
    } finally {
      release?.();
    }
  }
}
try {
  release = acquireInstance(dataDir);
  store = new Store(dataDir, LOCAL_SCOPE);
  if (store.settings().revision === 1 && store.list("runs", 1).length === 0) {
    const initial = store.settings();
    store.saveSettings({
      ...initial,
      persona: { ...initial.persona, name: "小野·记忆试用" },
      proactiveEnabled: false,
      autoExtract: true,
    });
  }
  const selectedStore = store;
  harness = new Harness(
    store,
    new ProviderModel(config, () => selectedStore.settings().model),
    config,
  );
  // The normal adaptive policy remains intact: all when facts fit, hybrid
  // above the budget. Warm and index the existing trial facts before admission;
  // no fixture records, history ablation or retrieval overrides enter this bot.
  const warmStart = Date.now();
  harness.memory.embedding!.warm();
  while (!harness.memory.embedding!.ready && Date.now() - warmStart < 30000)
    await new Promise((r) => setTimeout(r, 50));
  if (!harness.memory.embedding!.ready) throw new Error("试用编码器未就绪");
  while (
    await harness.memory.indexOne(new AbortController().signal, Date.now())
  ) {}
  await harness.memory.prewarm(Date.now());
  app = await createApp(harness);
  const address = await app.listen({ host: config.host, port: config.port });
  writePrivateJson(join(dataDir, "daemon.lock"), {
    pid: process.pid,
    startedAt: Date.now(),
    address,
  });
  writePrivateJson(join(dataDir, "trial-status.json"), {
    address,
    pid: process.pid,
    dataDir,
    memoryV2: store.memoryEnabled,
    memorySummaries: config.memorySummaries,
    memoryVectors: config.memoryVectors,
    retrievalPolicy: "adaptive-all-or-hybrid",
    embedding: harness.memory.diagnostic(),
    memoryAnswerReasoning: config.memoryAnswerReasoning,
    memoryReplyGuard: config.memoryReplyGuard,
    memoryReplyChecks: ["facts", "operations"],
    model: store.settings().model,
  });
  harness.start();
  console.log(`小野·记忆试用已启动：${address}`);
  console.log(
    "独立数据目录；新版记忆和 E5 混合召回开启；原有聊天与记忆保留；首次聊天需确认外发说明。",
  );
  const shutdown = () =>
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  await stop();
  console.error("试用启动失败，请检查 4321 端口和独立试用目录的实例锁。");
  process.exitCode = 1;
}
