import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { createApp } from "../src/server.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { acquireInstance } from "../src/instance.js";
import { writePrivateJson } from "../src/files.js";
import { memoryAblationRequest } from "./lib/memory-ablation.js";
import type { FactRead } from "../src/memory/reading.js";

// Real Web + provider, synthetic input only. Optional, experiment-only wire
// ablation keeps the UI/database intact; never rewrites model replies.
const dir = resolve(
  import.meta.dirname,
  "../test-results/memory-save-browser-demo/data",
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const controlPath = join(dir, "ablation-control.json");
const ablation = existsSync(controlPath)
  ? (JSON.parse(readFileSync(controlPath, "utf8")) as {
      phase: string;
      memory: boolean;
      coverage?: "unavailable" | "no_match" | "partial";
    })
  : undefined;
const wireDir = resolve(dir, "../ablation-wire");
if (ablation) mkdirSync(wireDir, { recursive: true, mode: 0o700 });
const config = loadConfig({
  dataDir: dir,
  port: 4323,
  modelMode: "deepseek",
  memoryV2: true,
  memorySummaries: !ablation,
  memoryVectors: false,
  memoryAnswerReasoning: true,
  memoryReplyGuard: true,
  trafficOrigin: "synthetic",
});
const release = acquireInstance(dir);
const store = new Store(dir, LOCAL_SCOPE);
if (ablation) {
  // Keep both the generation and contract reviewer free of derived summaries.
  // Durable rows and the message/confirmation views remain intact.
  const contextMemories = store.contextMemories.bind(store);
  store.contextMemories = () =>
    contextMemories().filter((m) => m.kind !== "episode");
  const byStatus = store.byStatus.bind(store);
  store.byStatus = ((table, statuses) =>
    table === "conversation_summaries"
      ? []
      : byStatus(table, statuses)) as typeof store.byStatus;
}
if (store.settings().revision === 1 && store.list("runs", 1).length === 0)
  store.saveSettings({
    ...store.settings(),
    persona: { ...store.settings().persona, name: "小野·保存意愿验证" },
    proactiveEnabled: false,
  });
const provider = new ProviderModel(config, () => store.settings().model);
const h = new Harness(
  store,
  ablation
    ? {
        get name() {
          return provider.name;
        },
        async *stream(request) {
          // Review requests contain only the unpublished draft, current input
          // and actual coverage/evidence, so pass them through without replay.
          const actual =
            request.purpose === "judge"
              ? request
              : memoryAblationRequest(request, ablation.memory);
          const { signal: _signal, ...safeRequest } = actual;
          const file = join(wireDir, `${Date.now()}-${randomUUID()}.json`);
          const record = {
            phase: ablation.phase,
            request: safeRequest,
            answer: "",
            finished: false,
          };
          writePrivateJson(file, record);
          try {
            for await (const event of provider.stream(actual)) {
              if (event.type === "text") record.answer += event.text;
              if (event.type === "finish") record.finished = true;
              yield event;
            }
          } finally {
            writePrivateJson(file, record);
          }
        },
      }
    : provider,
  config,
);
if (ablation?.coverage) {
  const facts = h.memory.facts.bind(h.memory);
  h.memory.facts = async (...args) => {
    const original = await facts(...args);
    return {
      ...original,
      selected:
        ablation.coverage === "partial" ? original.selected.slice(0, 1) : [],
      mode: ablation.coverage === "unavailable" ? "unavailable" : "keyword",
      state: ablation.coverage === "unavailable" ? "unavailable" : "degraded",
      allEligibleFactsIncluded: false,
      reasons: [
        ablation.coverage === "unavailable"
          ? "experiment_read_unavailable"
          : "experiment_search_projection",
      ],
    } as FactRead;
  };
}
const app = await createApp(h);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
  } finally {
    await h.close();
    release();
  }
}
try {
  const address = await app.listen({ host: config.host, port: config.port });
  writePrivateJson(join(dir, "daemon.lock"), { pid: process.pid, address });
  writePrivateJson(join(dir, "demo-status.json"), {
    pid: process.pid,
    address,
    memoryV2: true,
    vectors: false,
    model: config.model,
    summaries: config.memorySummaries,
    memoryAnswerReasoning: true,
    syntheticOnly: true,
    ablation: ablation ?? null,
  });
  h.start();
  console.log(`保存意愿验证已启动：${address}`);
  const shutdown = () =>
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  await stop();
  process.exitCode = 1;
}
