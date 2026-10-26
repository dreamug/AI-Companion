// Ephemeral UI verification of synthetic benchmark data; never opens any user's bot database.
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { createApp } from "../src/server.js";
const config = loadConfig({ dataDir: resolve("test-results/companion-memory-cm3/fast-path/fast"), port: 4332, memoryV3: true, memoryV2: true, memoryFastPath: true, memoryReplyGuard: true, memoryVectors: false, memorySummaries: false, memoryAnswerReasoning: false, trafficOrigin: "synthetic", maxOutputTokens: 800 });
const store = new Store(config.dataDir, { ownerUserId: "synthetic-fast-path", relationshipId: "comparison" });
const h = new Harness(store, new ProviderModel(config, () => store.settings().model), config);
const app = await createApp(h);
await app.listen({ port: config.port, host: config.host });
console.log("Synthetic browser verification: http://127.0.0.1:4332/");
async function stop() { await app.close(); await h.close(); process.exit(0); }
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
