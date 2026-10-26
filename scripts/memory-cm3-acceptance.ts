import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { ProviderModel, collect, parseJson } from "../src/model.js";
import {
  CompanionPlan,
  INTAKE_INSTRUCTION,
  registerCompanionInput,
  companionInputContext,
  commitCompanionPlan,
} from "../src/memory/companion-v3.js";
import { assignSegment } from "../src/memory/conversations.js";
import { tokenEstimate, type Run } from "../src/domain.js";

const root = resolve(import.meta.dirname, ".."),
  out = join(root, "test-results/companion-memory-cm3");
const fixturePath = join(root, "tests/fixtures/memory-cm3-heldout.json"),
  bytes = readFileSync(fixturePath);
const frozen = JSON.parse(
  readFileSync(join(out, "fixture-freeze.json"), "utf8"),
);
if (createHash("sha256").update(bytes).digest("hex") !== frozen.sha256)
  throw Error("frozen_fixture_changed");
const fixture = JSON.parse(bytes.toString()) as {
  cases: { id: string; input: string; expect: string }[];
};
const dir = mkdtempSync(join(out, "live-intake-"));
chmodSync(dir, 0o700);
const config = loadConfig({
  dataDir: dir,
  memoryV3: true,
  memoryV2: true,
  memoryVectors: false,
  memorySummaries: false,
  memoryReplyGuard: true,
  modelMode: "deepseek",
});
const store = new Store(dir, {
  ownerUserId: "synthetic-owner",
  relationshipId: "cm3-heldout",
});
store.enableMemoryV3();
store.saveSettings({
  ...store.settings(),
  remoteDisclosureAcknowledged: true,
  proactiveEnabled: false,
});
const model = new ProviderModel(config, () => store.settings().model);
const ledgerPath = join(out, "intake-budget.json");
let priorUsed = 0;
try {
  priorUsed = JSON.parse(readFileSync(ledgerPath, "utf8")).chargedTokens;
} catch {
  try {
    priorUsed = JSON.parse(
      readFileSync(join(out, "frozen-intake-first-run.json"), "utf8"),
    ).usedTokensOrReserved;
  } catch {
    /* First ever run has no prior evidence. */
  }
}
if (!Number.isFinite(priorUsed) || priorUsed < 0)
  throw Error("invalid_budget_ledger");
let used = 0;
const cap = 48000,
  rows: Record<string, unknown>[] = [];
function charge(tokens: number) {
  used += tokens;
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      chargedTokens: priorUsed + used,
      cap,
      scope: "intake_benchmark_runs_only; interactive_trial_metered_separately",
    }),
    { mode: 0o600 },
  );
}
function judge(
  id: string,
  before: string[],
  operations: { action: string; id: string }[],
) {
  const active = store.all("memories").filter((m) => m.status === "active"),
    newFacts = active.filter((m) => !before.includes(m.id));
  switch (id) {
    case "h1":
      return newFacts.some(
        (m) => m.predicate === "preferred_address" && m.slotValue === "南枝",
      );
    case "h2":
      return newFacts.some((m) => m.text.includes("观鸟"));
    case "h3":
      return newFacts.some((m) => m.text.includes("纸屿-7306"));
    case "h4":
      return newFacts.some(
        (m) =>
          m.predicate === "address_override" &&
          m.admission?.scopeKind === "until" &&
          m.slotValue === "团团",
      );
    case "h5":
      return newFacts.some(
        (m) => m.predicate === "forbidden_address" && m.slotValue === "小朋友",
      );
    case "h6":
      return (
        newFacts.some((m) => m.text.includes("攀岩")) &&
        !newFacts.some((m) => m.text.includes("滑雪"))
      );
    case "h7":
    case "h8":
    case "h11":
    case "h12":
      return operations.length === 0 && newFacts.length === 0;
    case "h9":
      return (
        newFacts.some((m) => m.text.includes("散步")) &&
        !active.some((m) => m.text.includes("观鸟"))
      );
    case "h10":
      return (
        operations.some((o) => o.action === "forget") &&
        !active.some((m) => m.text.includes("纸屿-7306"))
      );
    default:
      return false;
  }
}
try {
  for (const test of fixture.cases) {
    const id = randomUUID(),
      inputId = randomUUID(),
      now = Date.now();
    const message = {
      id: inputId,
      threadId: "synthetic",
      role: "user" as const,
      content: test.input,
      revision: 1,
      status: "complete",
      runId: id,
      createdAt: now,
      deleted: false,
      displayed: test.input.length,
      trafficOrigin: "synthetic" as const,
    };
    store.put("messages", message);
    store.put("sources", {
      id: inputId,
      revision: 1,
      text: test.input,
      kind: "message",
      deleted: false,
      createdAt: now,
    });
    const seq = store.event("run.accepted", { inputId }, now, id).seq;
    const run: Run = {
      id,
      inputId,
      status: "running",
      generation: 1,
      epoch: store.settings().epoch,
      personaRevision: 1,
      model: config.model,
      createdAt: now,
      updatedAt: now,
      steps: 0,
      usage: { calls: 0, estimated: true },
      config: { enqueueSeq: seq, persona: store.settings().persona },
    };
    store.put("runs", run);
    assignSegment(store, run, now);
    registerCompanionInput(store, message, now);
    const request = JSON.stringify(
      companionInputContext(store, message, store.require("runs", id), now),
    );
    const reserved = tokenEstimate(INTAKE_INSTRUCTION + request) + 1800;
    if (priorUsed + used + reserved > cap) {
      rows.push({
        id: test.id,
        status: "not_executed",
        reason: "evaluation_budget",
      });
      break;
    }
    const before = store
        .all("memories")
        .filter((m) => m.status === "active")
        .map((m) => m.id),
      start = Date.now();
    // Reserve before the provider call so an interrupted run cannot reset its cost.
    charge(reserved);
    try {
      const result = await collect(model, {
        purpose: "extract",
        model: config.model,
        system: INTAKE_INSTRUCTION,
        messages: [{ role: "user", content: request }],
        tools: [],
        json: true,
        maxOutputTokens: 1800,
        temperature: 0,
        signal: AbortSignal.timeout(25000),
      });
      charge((result.usage.totalTokens ?? reserved) - reserved);
      const plan = CompanionPlan.parse(parseJson(result.text));
      const receipt = commitCompanionPlan(
        store,
        message,
        store.require("runs", id),
        plan,
        Date.now(),
        new AbortController().signal,
      );
      const pass = judge(test.id, before, receipt.operations);
      rows.push({
        id: test.id,
        pass,
        status: receipt.status,
        elapsedMs: Date.now() - start,
        usage: result.usage,
        providerModel: result.providerModel,
        plan,
        receipt,
      });
      console.log(
        JSON.stringify({ id: test.id, pass, status: receipt.status }),
      );
    } catch (error) {
      rows.push({
        id: test.id,
        pass: false,
        status: "failed",
        reason: error instanceof Error ? error.name : "failed",
      });
      console.log(JSON.stringify({ id: test.id, pass: false }));
    }
    store.put("runs", {
      ...store.require("runs", id),
      status: "completed",
      updatedAt: Date.now(),
    });
  }
  const report = {
    date: "2026-10-26",
    fixtureHash: frozen.sha256,
    kind: "real_model_intake_only_not_answer_benchmark",
    model: config.model,
    passed: rows.filter((r) => r.pass === true).length,
    total: fixture.cases.length,
    executed: rows.length,
    usedTokensOrReserved: used,
    priorTokensOrReserved: priorUsed,
    cumulativeTokensOrReserved: priorUsed + used,
    runKind: priorUsed ? "known_set_regression_replay" : "first_frozen_run",
    budget: cap,
    memoryVectors: false,
    rows,
  };
  const path = join(out, "frozen-intake-results.json");
  writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: report.passed,
      total: report.total,
      tokens: used,
      budget: cap,
      report: path,
    }),
  );
  if (report.passed !== report.total) process.exitCode = 1;
} finally {
  store.close();
}
