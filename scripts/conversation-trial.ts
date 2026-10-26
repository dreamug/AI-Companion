// New empty trial. Only persona configuration is inherited; no user messages or memories are copied.
import { resolve, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import { BotManager } from "../src/bots.js";
import { createApp } from "../src/server.js";
import { acquireInstance } from "../src/instance.js";
import { writePrivateJson } from "../src/files.js";
const dataDir = resolve("local-data/conversation-turn-v1");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const fresh = !existsSync(join(dataDir, "companion.sqlite"));
const config = {
  ...stableMemoryConfig(
    loadConfig({
      dataDir,
      port: 4341,
      modelMode: "deepseek",
      model: "deepseek-flash",
      maxOutputTokens: 800,
      trafficOrigin: "natural",
    }),
  ),
  conversationExperiment: true,
};
const release = acquireInstance(dataDir);
const bots = new BotManager(config);
const h = bots.get();
if (fresh) {
  const source = new Database(
    resolve(
      "local-data/memory-cm3-2-trial/bots/9f8ad26a-6800-46e0-af11-0e689f388c36/companion.sqlite",
    ),
    { readonly: true },
  );
  const persona = JSON.parse(
    (source.prepare("SELECT data FROM settings").get() as { data: string })
      .data,
  ).persona;
  source.close();
  h.store.saveSettings({
    ...h.store.settings(),
    persona: { ...persona, name: "小野·接话试聊" },
    splitReplies: true,
    messagePacing: true,
    proactiveEnabled: false,
    remoteDisclosureAcknowledged: false,
    dailyTokenBudget: 1000000,
  });
  h.publishPersona(h.store.settings().persona, h.store.settings().revision);
}
const app = await createApp(h, { bots });
await app.listen({ host: config.host, port: config.port });
bots.start();
writePrivateJson(join(dataDir, "trial-status.json"), {
  pid: process.pid,
  address: "http://127.0.0.1:4341",
  memoryBaseline: "cm3-stable-20261026",
  conversationExperiment: true,
  splitReplies: true,
  messagePacing: true,
  memoryVectors: false,
  proactiveEnabled: false,
});
console.log("Conversation trial: http://127.0.0.1:4341/");
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
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
