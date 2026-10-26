// Test-only injected model: prove a VALID review finishing after 8s is awaited.
// No real user data, no external model calls; not a chatbot fallback.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import { createApp } from "../src/server.js";
import type { ModelPort, ModelRequest, ModelEvent } from "../src/model.js";
import { writePrivateJson } from "../src/files.js";
const dir = mkdtempSync(join(tmpdir(), "memory-review-deadline-demo-"));
const config = stableMemoryConfig(
  loadConfig({
    dataDir: dir,
    port: 4332,
    modelMode: "mock",
    trafficOrigin: "synthetic",
    memorySummaries: false,
  }),
);
const model: ModelPort = {
  name: "mock",
  async *stream(r: ModelRequest): AsyncGenerator<ModelEvent> {
    let text = "收到，我们接着聊。";
    if (r.purpose === "extract") text = '{"intent":"none","items":[]}';
    if (r.purpose === "judge") {
      const d = JSON.parse(r.messages[0]!.content);
      if (d.contractPart === "facts")
        await delay(9100, undefined, { signal: r.signal });
      text =
        d.contractPart === "operations"
          ? '{"checks":[],"requiredAction":"none","userEvidence":null}'
          : '{"checks":[]}';
    }
    yield { type: "text", text };
    yield {
      type: "finish",
      reason: "stop",
      usage: {
        calls: 1,
        estimated: true,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    };
  },
};
const store = new Store(dir, {
  ownerUserId: "synthetic-timeout",
  relationshipId: "deadline-demo",
});
store.enableMemoryV3();
store.saveSettings({
  ...store.settings(),
  persona: { ...store.settings().persona, name: "慢检查自动化验证" },
  proactiveEnabled: false,
  remoteDisclosureAcknowledged: true,
});
const h = new Harness(store, model, config),
  app = await createApp(h);
await app.listen({ host: config.host, port: config.port });
writePrivateJson(
  "test-results/memory-review-availability/deadline-demo-location.json",
  {
    dataDir: dir,
    pid: process.pid,
    artificialDelayMs: 9100,
    realProvider: false,
  },
);
async function stop() {
  await app.close();
  await h.close();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
console.log("Synthetic delayed-check verification on 4332");
