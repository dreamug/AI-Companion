import { resolve, join } from "node:path";
import { mkdirSync, chmodSync, realpathSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { createApp } from "../src/server.js";
import { acquireInstance } from "../src/instance.js";
import { BotManager } from "../src/bots.js";
import { writePrivateJson } from "../src/files.js";

// This entry point alone opts into schema3. Never inherits a production data path/port.
const dataDir = resolve(
  import.meta.dirname,
  "../local-data/memory-cm3-2-trial",
);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (realpathSync(dataDir) !== dataDir)
  throw Error("isolated directory must not be a symlink");
chmodSync(dataDir, 0o700);
const config = loadConfig({
  dataDir,
  port: 4331,
  memoryV3: true,
  memoryV2: true,
  memoryVectors: false,
  memorySummaries: false,
  memoryReplyGuard: true,
  memoryFastPath: true,
  memoryAnswerReasoning: false,
  modelMode: "deepseek",
  trafficOrigin: "natural",
  maxOutputTokens: 800,
});
const release = acquireInstance(dataDir);
const store = new Store(dataDir, {
  ownerUserId: "local-owner",
  relationshipId: "cm3-2-isolated-trial",
});
// Explicit migration is limited to this new isolated database; old instances are never opened.
store.enableMemoryV3();
const settings = store.settings();
store.saveSettings({
  ...settings,
  proactiveEnabled: false,
  memoryFormationMode: settings.memoryFormationMode ?? "automatic",
  ...(!store.all("runs").length
    ? { persona: { ...settings.persona, name: "小野·CM3独立试聊" } }
    : {}),
});
for (const f of store.byStatus("followups", ["pending", "ready", "generating"]))
  store.put("followups", {
    ...f,
    status: "cancelled",
    revision: f.revision + 1,
    reason: "cm3_2_sending_disabled",
  });
for (const s of store.all("series"))
  if (s.status === "active")
    store.put("series", {
      ...s,
      status: "cancelled",
      revision: s.revision + 1,
    });
const h = new Harness(
  store,
  new ProviderModel(config, () => store.settings().model),
  config,
);
const bots = new BotManager(config, undefined, { original: h });
const app = await createApp(h, { bots });
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  try {
    await app.close();
    await bots.close();
  } finally {
    release();
  }
}
try {
  const address = await app.listen({ host: config.host, port: config.port });
  writePrivateJson(join(dataDir, "trial-status.json"), {
    address,
    pid: process.pid,
    dataDir,
    schema: 3,
    policy: "companion-memory-v3.4",
    stage: "CM3 0-2 + CM3 3 ordinary fast path",
    memoryFastPath: true,
    memoryVectors: false,
    proactiveEnabled: false,
    model: store.settings().model,
    factsReviewModel: config.memoryFactsModel ?? store.settings().model,
    existingServiceUnchanged: "4321 and 4317",
    limitations: [
      "restricted events, observation and proactive outreach disabled",
    ],
  });
  bots.start();
  console.log(`CM3独立试聊：${address}`);
  for (const event of ["SIGINT", "SIGTERM"] as const)
    process.once(event, () => void stop().then(() => process.exit(0)));
} catch {
  await stop();
  console.error("CM3独立试聊启动失败，请检查独立端口/目录。");
  process.exitCode = 1;
}
