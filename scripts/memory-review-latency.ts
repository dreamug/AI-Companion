import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import {
  ProviderModel,
  collect,
  parseJson,
  type ModelRequest,
} from "../src/model.js";
import { parseMemoryReplyAssessment } from "../src/memory/reply-contract.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";
const out = resolve("test-results/companion-memory-cm3/real-latency");
const bytes = readFileSync(join(out, "plan.json"));
if (
  createHash("sha256").update(bytes).digest("hex") !==
  readFileSync(join(out, "plan.sha256"), "utf8").trim()
)
  throw Error("frozen_plan_changed");
const plan = JSON.parse(bytes.toString()) as {
  frozenAt: number;
  ownerUserId: string;
  relationshipId: string;
  model: string;
  benchmarkTokenCap: number;
  fixedReviewPairs: number;
  cases: { id: string; input: string }[];
};
const ledgerPath = join(out, "benchmark-meter.json");
if (existsSync(ledgerPath))
  throw Error("benchmark_already_started_do_not_reset_budget");
const privateJson = (name: string, value: unknown) => {
  writeFileSync(join(out, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
};
const meter = new BenchmarkMeter(plan.benchmarkTokenCap, () =>
  privateJson("benchmark-meter.json", {
    cap: meter.cap,
    charged: meter.charged,
    calls: meter.calls,
  }),
);
const fixed = new Map<string, Omit<ModelRequest, "signal">>();
const rows: Record<string, unknown>[] = [];
const baseConfig = {
  memoryV3: true,
  memoryV2: true,
  memoryVectors: false,
  memorySummaries: false,
  memoryReplyGuard: true,
  memoryAnswerReasoning: false,
  modelMode: "deepseek" as const,
  model: plan.model,
  maxOutputTokens: 800,
  trafficOrigin: "synthetic" as const,
};
const cfg = loadConfig({ ...baseConfig, dataDir: out });
const provider = new ProviderModel(cfg, () => plan.model);
const scope = {
  ownerUserId: plan.ownerUserId,
  relationshipId: plan.relationshipId,
};
function checkpoint() {
  privateJson("results.partial.json", {
    planHash: createHash("sha256").update(bytes).digest("hex"),
    charged: meter.charged,
    rows,
  });
}
function order(index: number): ("serial" | "parallel")[] {
  return index % 2 === 0 ? ["serial", "parallel"] : ["parallel", "serial"];
}
for (const [index, test] of plan.cases.entries()) {
  for (const mode of order(index)) {
    const label = `${test.id}-${mode}`;
    const dir = join(out, label);
    mkdirSync(dir, { mode: 0o700 });
    copyFileSync(join(out, "baseline.sqlite"), join(dir, "companion.sqlite"));
    chmodSync(join(dir, "companion.sqlite"), 0o600);
    if (existsSync(join(out, "baseline-deletions.json")))
      copyFileSync(
        join(out, "baseline-deletions.json"),
        join(dir, "deletions.json"),
      );
    const store = new Store(dir, scope);
    store.enableMemoryV3();
    const config = loadConfig({ ...baseConfig, dataDir: dir });
    const beforeCalls = meter.calls.length;
    const model = new ReviewBenchmarkModel(
      provider,
      mode,
      meter,
      label,
      (r) => {
        if (index === 0 && mode === "serial") {
          const part = JSON.parse(r.messages[0]!.content)
            .contractPart as string;
          if (!fixed.has(part)) {
            const { signal, ...payload } = r;
            void signal;
            fixed.set(part, structuredClone(payload));
            privateJson(
              "frozen-review-requests.json",
              Object.fromEntries(fixed),
            );
          }
        }
      },
    );
    const h = new Harness(store, model, config, { now: () => plan.frozenAt });
    const submitted = performance.now();
    try {
      const result = h.submit(test.input, `latency-${label}`);
      while (
        ["queued", "running"].includes(
          store.require("runs", result.runId).status,
        )
      )
        await delay(15);
      // close drains late accounting and prevents cross-arm background work.
      const run = store.require("runs", result.runId);
      const checks = store
        .traces(run.id)
        .filter(
          (t) =>
            t.stage === "memory_reply" &&
            ["accepted", "rejected"].includes(t.reason),
        );
      rows.push({
        kind: "e2e",
        caseId: test.id,
        mode,
        runId: run.id,
        status: run.status,
        reason: run.reason,
        wallMs: performance.now() - submitted,
        timings: run.timings,
        usage: run.usage,
        checks: checks.map((c) => ({
          reason: c.reason,
          part: c.data.contractPart,
          review: c.data.review,
          violations: c.data.violations,
        })),
        providerCalls: meter.calls.slice(beforeCalls).map((c) => ({
          purpose: c.purpose,
          part: c.part,
          outcome: c.outcome,
          providerMs: c.providerMs,
          queueMs: c.queueMs,
          requestHash: c.requestHash,
          providerModel: c.providerModel,
          charged: c.charged,
        })),
        output: store.get("messages", `assistant-${run.id}`)?.content,
      });
    } catch (error) {
      rows.push({
        kind: "e2e",
        caseId: test.id,
        mode,
        status: "runner_failed",
        reason: error instanceof Error ? error.name : "unknown_error",
      });
    } finally {
      await h.close();
      checkpoint();
    }
    const row = rows.at(-1)!;
    console.log(
      JSON.stringify({
        kind: "e2e",
        caseId: test.id,
        mode,
        status: row.status,
        elapsedMs: Math.round(
          Number(
            (row.timings as { elapsedMs?: number })?.elapsedMs ??
              row.wallMs ??
              0,
          ),
        ),
        tokens: meter.charged,
      }),
    );
  }
}
// Identical frozen draft and review payloads remove generation/content variance.
if (fixed.size !== 2) {
  rows.push({
    kind: "fixed_review",
    status: "not_executed",
    reason: "first_case_did_not_supply_both_checks",
  });
  checkpoint();
} else
  for (let index = 0; index < plan.fixedReviewPairs; index++) {
    for (const mode of order(index)) {
      const label = `fixed-${index + 1}-${mode}`,
        model = new ReviewBenchmarkModel(provider, mode, meter, label),
        controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("deadline"), 60000);
      timeout.unref();
      const beforeCalls = meter.calls.length,
        start = performance.now();
      const settled = await Promise.allSettled(
        ["facts", "operations"].map(async (part) => {
          const request = fixed.get(part)!;
          const result = await collect(model, {
            ...structuredClone(request),
            signal: controller.signal,
          });
          const payload = JSON.parse(request.messages[0]!.content);
          return {
            part,
            ...parseMemoryReplyAssessment(
              parseJson(result.text),
              payload.draft,
              payload.saveIntent,
              part as "facts" | "operations",
            ),
          };
        }),
      );
      clearTimeout(timeout);
      const successful = settled.every((x) => x.status === "fulfilled");
      const checks = settled.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : {
              error:
                r.reason instanceof Error ? r.reason.name : "unknown_error",
            },
      );
      const row = {
        kind: "fixed_review",
        caseId: `f${index + 1}`,
        mode,
        status: successful ? "both_returned" : "failed",
        elapsedMs: performance.now() - start,
        checks,
        providerCalls: meter.calls.slice(beforeCalls),
      };
      rows.push(row);
      checkpoint();
      console.log(
        JSON.stringify({
          kind: "fixed_review",
          caseId: row.caseId,
          mode,
          status: row.status,
          elapsedMs: Math.round(row.elapsedMs),
          tokens: meter.charged,
        }),
      );
    }
  }
privateJson("results.json", {
  planHash: createHash("sha256").update(bytes).digest("hex"),
  budget: meter.cap,
  charged: meter.charged,
  model: plan.model,
  method:
    "serial judge RPC gate vs concurrent RPC; same current Harness; not old binary",
  rows,
});
console.log(
  JSON.stringify({
    finished: true,
    rows: rows.length,
    charged: meter.charged,
    budget: meter.cap,
  }),
);
