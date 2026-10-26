import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { LOCAL_SCOPE, DomainError } from "../src/domain.js";

const dir = mkdtempSync(join(tmpdir(), "companion-live-"));
const config = loadConfig({
  dataDir: dir,
  maxRunMs: 45000,
  maxOutputTokens: 350,
});
const store = new Store(dir, LOCAL_SCOPE);
const h = new Harness(
  store,
  new ProviderModel(config, () => store.settings().model),
  config,
);
const report: {
  at: string;
  scope: string;
  checks: { name: string; passed: boolean; detail?: unknown }[];
} = {
  at: new Date().toISOString(),
  scope: "isolated_synthetic_harness",
  checks: [],
};
try {
  const s = store.settings();
  h.updateSettings({
    expectedRevision: s.revision,
    remoteDisclosureAcknowledged: true,
    autoExtract: true,
  });
  const r = h.submit(
    "这是一组虚构测试资料：测试用户甲喜欢咖啡。请只用一句话回应，不要调用工具。",
    "live-integration",
  );
  await h.waitForIdle(50000);
  report.checks.push({
    name: "real_model_through_harness",
    passed: store.require("runs", r.runId).status === "completed",
    detail: {
      status: store.require("runs", r.runId).status,
      usage: store.require("runs", r.runId).usage,
    },
  });
  h.addMemory({
    text: "合成确认记忆：测试用户甲喜欢咖啡",
    sourceIds: [r.messageId],
    pinned: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await h.tick();
  await h.waitForIdle(30000);
  report.checks.push({
    name: "real_background_extraction_contract",
    passed: store
      .list("jobs")
      .some((j) => j.kind === "extract" && j.status === "completed"),
    detail: store
      .list("jobs")
      .map((j) => ({ kind: j.kind, status: j.status, reason: j.reason })),
  });
  h.channel("synthetic-adapter", "granted");
  const f = h.createFollowUp({
    text: "这是一次合成跟进，轻声问测试事项是否有进展。",
    dueAt: Date.now(),
    latestAt: Date.now() + 60000,
    allowInterrupt: true,
  });
  await h.tick();
  await h.waitForIdle(30000);
  const d = store.list("deliveries").find((d) => d.followUpId === f.id);
  report.checks.push({
    name: "real_concern_draft_to_outbox",
    passed: !!d?.text,
    detail: { status: d?.status, externalNotificationSent: false },
  });
  const receipt = await h.backup();
  report.checks.push({ name: "backup_created", passed: !!receipt.id });
  h.forget([r.messageId], []);
  report.checks.push({
    name: "forget_after_live_run",
    passed:
      store.require("sources", r.messageId).deleted &&
      h.snapshot().memories.length === 0,
  });
} catch (error) {
  report.checks.push({
    name: "integration_error",
    passed: false,
    detail: {
      code: error instanceof DomainError ? error.code : "integration_failed",
    },
  });
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
}
const out = join(process.cwd(), "data", "reports");
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(
  join(out, "integration-live.json"),
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report, null, 2));
if (report.checks.some((c) => !c.passed)) process.exitCode = 1;
