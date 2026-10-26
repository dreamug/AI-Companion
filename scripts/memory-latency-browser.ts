// Synthetic UI verification; never opens a user's bot database.
import { resolve } from "node:path";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import { createApp } from "../src/server.js";
const dataDir = resolve(
  "test-results/memory-intake-review-latency/address-after",
);
const config = {
  ...stableMemoryConfig(
    loadConfig({
      dataDir,
      port: 4332,
      modelMode: "deepseek",
      model: "deepseek-flash",
      maxOutputTokens: 800,
      trafficOrigin: "synthetic",
    }),
  ),
  conversationExperiment: true,
};
const store = new Store(dataDir, {
  ownerUserId: "synthetic-latency",
  relationshipId: "comparison",
});
const h = new Harness(
  store,
  new ProviderModel(config, () => store.settings().model),
  config,
);
const app = await createApp(h);
await app.listen({ host: config.host, port: config.port });
async function stop() {
  await app.close();
  await h.close();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
console.log("Latency verification on 4332");
