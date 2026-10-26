// Two synthetic turns verify the other model provider used by existing main roles.
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import { ProviderModel } from "../src/model.js";
import { ModelCredentials } from "../src/model-config.js";
import { BenchmarkMeter, ReviewBenchmarkModel } from "./lib/review-benchmark-model.js";
const dir = resolve("test-results/companion-memory-release/provider-smoke");
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (existsSync(join(dir, "meter.json"))) throw Error("already_started");
const base = loadConfig({ dataDir: resolve("data") });
const key = new ModelCredentials(base).key("grok");
const config = stableMemoryConfig({ ...base, dataDir: dir, model: "grok-4.3", grokApiKey: key, maxOutputTokens: 800, trafficOrigin: "synthetic" });
const meter = new BenchmarkMeter(90000, () => writeFileSync(join(dir, "meter.json"), JSON.stringify({ cap: meter.cap, charged: meter.charged, calls: meter.calls }, null, 2), { mode: 0o600 }));
const store = new Store(dir, { ownerUserId: "synthetic-release", relationshipId: "provider-smoke" });store.enableMemoryV3();
store.saveSettings({ ...store.settings(), model: "grok-4.3", proactiveEnabled: false, remoteDisclosureAcknowledged: true, dailyTokenBudget: 1000000 });
const model = new ReviewBenchmarkModel(new ProviderModel(config, () => "grok-4.3"), "parallel", meter, "grok-portability");
const h = new Harness(store, model, config); const rows: unknown[] = [];
try {
 for (const [index, text] of ["以后叫我舟禾吧。", "这会儿你该怎么称呼我？"].entries()) {
  if (index) h.resetCompanionContext();
  const r = h.submit(text, String(index));
  while (["queued", "running"].includes(store.require("runs", r.runId).status)) await delay(10);
  const run = store.require("runs", r.runId), reply = store.require("messages", `assistant-${r.runId}`);
  while (store.byStatus("memory_inbox", ["queued", "running", "requires_sync"]).length) await delay(10);
  rows.push({ input: text, run, reply });
  writeFileSync(join(dir, "results.json"), JSON.stringify({ rows, charged: meter.charged }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: run.status, reason: run.reason, reply: reply.content, elapsedMs: run.timings?.elapsedMs }));
  if (run.status !== "completed") break;
 }
} finally { await h.close(); }
