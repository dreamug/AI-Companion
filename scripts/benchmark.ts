import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { MockModel } from "../src/model.js";
import { LOCAL_SCOPE, type Memory } from "../src/domain.js";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/context.js";

const dir = mkdtempSync(join(tmpdir(), "companion-benchmark-"));
const config = loadConfig({
  dataDir: dir,
  modelMode: "mock",
  maxOutputTokens: 100,
});
const store = new Store(dir, LOCAL_SCOPE),
  h = new Harness(store, new MockModel(), config);
const ms = () => performance.now();
const start = ms();
store.put("sources", {
  id: "bench-source",
  text: "合成基准数据",
  kind: "manual",
  revision: 1,
  deleted: false,
  createdAt: Date.now(),
});
store.tx("seed_benchmark", () => {
  for (let i = 0; i < 10000; i++) {
    const m: Memory = {
      id: `bench-${i}`,
      kind: "assertion",
      category: "fact",
      certainty: "confirmed",
      text: `合成基准事项${i}，偏好茶和安静工作。`,
      sources: [{ id: "bench-source", revision: 1 }],
      revision: 1,
      status: "active",
      pinned: i === 0,
      manual: true,
      createdAt: Date.now() + i,
    };
    store.put("memories", m);
  }
});
const seedMs = ms() - start;
const settings = store.settings();
store.saveSettings({ ...settings, autoExtract: false });
const accepted: number[] = [],
  context: number[] = [],
  cancel: number[] = [];
for (let i = 0; i < 30; i++) {
  let t = ms();
  const receipt = h.submit("查询合成基准事项9999", `bench-request-${i}`);
  accepted.push(ms() - t);
  await h.waitForIdle();
  const run = store.require("runs", receipt.runId),
    input = store.require("messages", receipt.messageId);
  t = ms();
  buildContext(store, input, run, Date.now());
  context.push(ms() - t);
  t = ms();
  h.cancel(receipt.runId);
  cancel.push(ms() - t);
}
function stats(a: number[]) {
  const s = [...a].sort((a, b) => a - b);
  return {
    p50Ms: s[Math.floor(s.length * 0.5)],
    p95Ms: s[Math.ceil(s.length * 0.95) - 1],
    samples: s.length,
  };
}
const report = {
  at: new Date().toISOString(),
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: cpus()[0]?.model,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  memories: 10000,
  seedMs,
  remoteModelIncluded: false,
  scope: "single_user_local_mock",
  accepted: stats(accepted),
  context: stats(context),
  cancelCommand: stats(cancel),
  targets: { acceptedP95Ms: 200, contextP95Ms: 300, cancelP95Ms: 200 },
  note: "cancelCommand测量已完成Run的幂等控制命令；活跃生成取消另由确定性和浏览器测试验证。不代表公网并发容量。",
};
await h.close();
rmSync(dir, { recursive: true, force: true });
const out = join(process.cwd(), "data", "reports");
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(join(out, "benchmark.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));
