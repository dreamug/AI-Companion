import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { createApp } from "../src/server.js";
import { acquireInstance } from "../src/instance.js";
import { writePrivateJson } from "../src/files.js";
import { LOCAL_SCOPE } from "../src/domain.js";

// An experiment-only read projection. Raw messages and source eligibility stay
// intact; only the chat history view and optional memory reads are withheld.
// No flag, endpoint or reset operation is added to the product runtime.
const dir = resolve(
  import.meta.dirname,
  "../test-results/memory-context-lab/data",
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const controlPath = join(dir, "experiment-control.json");
const control = existsSync(controlPath)
  ? (JSON.parse(readFileSync(controlPath, "utf8")) as {
      hiddenMessageIds: string[];
      memory: boolean;
      phase: string;
    })
  : { hiddenMessageIds: [], memory: true, phase: "capture" };
const hidden = new Set(control.hiddenMessageIds);
const config = loadConfig({
  dataDir: dir,
  port: 4322,
  modelMode: "deepseek",
  memoryV2: true,
  memoryVectors: false,
  memorySummaries: false,
  // Keep model options equal between the memory-on and memory-off controls.
  memoryAnswerReasoning: false,
  trafficOrigin: "synthetic",
});
const release = acquireInstance(dir);
const store = new Store(dir, LOCAL_SCOPE);
const initial = store.settings();
store.saveSettings({
  ...initial,
  persona: { ...initial.persona, name: "小野·断上下文实验" },
  proactiveEnabled: false,
  autoExtract: control.phase === "capture",
});
const list = store.list.bind(store);
store.list = ((table, limit) => {
  const rows = list(table, limit);
  return table === "messages"
    ? rows.filter((row) => !hidden.has(row.id))
    : rows;
}) as typeof store.list;
if (!control.memory) {
  store.qualifiedFacts = function* () {
    /* withheld in the negative control */
  };
  store.contextMemories = () => [];
  store.search = () => [];
}
const h = new Harness(
  store,
  new ProviderModel(config, () => store.settings().model),
  config,
);
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
  writePrivateJson(join(dir, "experiment-status.json"), {
    pid: process.pid,
    address,
    phase: control.phase,
    hiddenMessageCount: hidden.size,
    memory: control.memory,
    vectors: false,
    summaries: false,
    model: config.model,
    answerReasoning: false,
  });
  h.start();
  console.log(`断上下文实验已启动：${address}；阶段 ${control.phase}`);
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
