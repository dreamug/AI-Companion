import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { loadConfig } from "../src/config.js";
import { ProviderModel, collect, parseJson } from "../src/model.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";
import {
  memoryReplyReview,
  memoryReplyReviewOptions,
  memoryReplyReviewMessages,
  parseMemoryReplyAssessment,
} from "../src/memory/reply-contract.js";
import {
  nameMentions,
  NAMING_REFERENCE_SYSTEM,
  NAMING_REFERENCE_OUTPUT_SCHEMA,
  namingReferenceMessages,
  parseNamingReferences,
  namingReferenceChecks,
} from "../src/memory/naming.js";
import { companionOperations } from "../src/memory/companion-v3.js";
import { resolveAddress } from "../src/memory/address.js";

const out = resolve("test-results/companion-memory-cm3/fast-path");
mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFileSync(join(out, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const proposed = {
  frozenAt: new Date().toISOString(),
  model: "deepseek-flash",
  cap: 550000,
  comparison:
    "both branches retain parallel independent checks; only intake scheduling differs",
  acceptance:
    "all replies complete, both checks retained; correct storage/recall/temporary precedence/forget; report every attempt and latency, no percentile claims from tiny sample",
  steps: [
    {
      id: "greeting",
      input: "下午好，刚泡好一杯茶，想歇一会儿。",
      ordinary: true,
    },
    {
      id: "automatic",
      input: "我平时最喜欢在清晨去散步，街上很安静。",
      ordinary: true,
    },
    {
      id: "recall",
      input: "我平常喜欢在什么时候活动来着？",
      ordinary: true,
      reset: true,
    },
    {
      id: "save",
      input: "请记住，我每个月最后一个周日会整理照片。",
      ordinary: false,
    },
    { id: "temporary", input: "这段聊天先叫我千帆吧。", ordinary: false },
    {
      id: "durable",
      input: "以后长期叫我岑远，刚才的临时称呼这段里先保留。",
      ordinary: false,
    },
    {
      id: "forget",
      input: "忘掉我每个月整理照片这件事，原聊天保留。",
      ordinary: false,
    },
    {
      id: "address-recall",
      input: "你现在怎么称呼我？也说说你自己的名字。",
      ordinary: true,
      reset: true,
    },
  ],
  reviewPlan: "test-results/companion-memory-cm3/address-perspective/plan.json",
  reviewStates:
    "test-results/companion-memory-cm3/address-perspective/known-replay/state-projections.json",
};
if (process.argv.includes("--freeze")) {
  if (existsSync(join(out, "plan.json"))) throw Error("plan_already_frozen");
  save("plan.json", proposed);
  writeFileSync(
    join(out, "plan.sha256"),
    hash(readFileSync(join(out, "plan.json"))),
  );
  console.log(
    "Frozen 8 paired end-to-end turns + unchanged 24 polarity reviews.",
  );
  process.exit(0);
}
if (!process.argv.includes("--run")) throw Error("freeze_then_run");
if (existsSync(join(out, "meter.json")))
  throw Error("run_already_started_no_reset");
const bytes = readFileSync(join(out, "plan.json"));
if (hash(bytes) !== readFileSync(join(out, "plan.sha256"), "utf8"))
  throw Error("frozen_plan_changed");
const plan = JSON.parse(bytes.toString()) as typeof proposed;
let meter: BenchmarkMeter;
meter = new BenchmarkMeter(plan.cap, () =>
  save("meter.json", {
    charged: meter.charged,
    cap: meter.cap,
    calls: meter.calls,
  }),
);
const config = loadConfig({
  dataDir: out,
  model: plan.model,
  modelMode: "deepseek",
  memoryV3: true,
  memoryV2: true,
  memoryFastPath: true,
  memoryVectors: false,
  memorySummaries: false,
  memoryReplyGuard: true,
  memoryAnswerReasoning: false,
  trafficOrigin: "synthetic",
  maxOutputTokens: 800,
});
const provider = new ProviderModel(config, () => plan.model);
const db = new Database(
  resolve(
    "local-data/memory-cm3-2-trial/bots/9f8ad26a-6800-46e0-af11-0e689f388c36/companion.sqlite",
  ),
  { readonly: true },
);
const persona = JSON.parse(
  (db.prepare("select data from settings").get() as { data: string }).data,
).persona;
db.close();
const rows: Record<string, unknown>[] = [],
  reviews: Record<string, unknown>[] = [];
const checkpoint = () =>
  save("results.partial.json", { rows, reviews, charged: meter.charged });
save(
  "source-sha256.json",
  Object.fromEntries(
    [
      "src/harness.ts",
      "src/context.ts",
      "src/memory/intake-queue.ts",
      "src/memory/reply-contract.ts",
      "src/memory/companion-v3.ts",
      "src/model-pool.ts",
      "scripts/memory-fast-path.ts",
    ].map((f) => [f, hash(readFileSync(f))]),
  ),
);
const branches = [false, true].map((fast) => {
  const dir = join(out, fast ? "fast" : "serial");
  const store = new Store(dir, {
    ownerUserId: "synthetic-fast-path",
    relationshipId: "comparison",
  });
  store.enableMemoryV3();
  store.saveSettings({
    ...store.settings(),
    model: plan.model,
    persona,
    proactiveEnabled: false,
    remoteDisclosureAcknowledged: true,
    dailyTokenBudget: 1000000,
  });
  const model = new ReviewBenchmarkModel(
    provider,
    "parallel",
    meter,
    fast ? "fast" : "serial",
  );
  return {
    fast,
    store,
    h: new Harness(store, model, {
      ...config,
      dataDir: dir,
      memoryFastPath: fast,
    }),
  };
});
try {
  for (const [index, step] of plan.steps.entries()) {
    for (const b of index % 2 ? [...branches].reverse() : branches) {
      if (step.reset) b.h.resetCompanionContext();
      const start = performance.now();
      const submitted = b.h.submit(step.input, step.id);
      while (
        ["queued", "running"].includes(
          b.store.require("runs", submitted.runId).status,
        )
      )
        await delay(10);
      const replyMs = performance.now() - start;
      const reply = b.store.require("messages", `assistant-${submitted.runId}`);
      if (reply.content) b.h.displayed(reply.id, reply.content.length);
      while (
        b.store.byStatus("memory_inbox", ["queued", "running", "requires_sync"])
          .length
      )
        await delay(10);
      const run = b.store.require("runs", submitted.runId),
        context = b.h.context(run.id) as {
          meta?: { historyIds?: string[]; pendingSourceIds?: string[] };
        };
      const active = b.store
        .all("memories")
        .filter((m) => m.status === "active")
        .map((m) => ({
          text: m.text,
          predicate: m.predicate,
          scope: m.admission?.scopeKind,
        }));
      rows.push({
        branch: b.fast ? "fast" : "serial",
        id: step.id,
        ordinary: step.ordinary,
        reset: !!step.reset,
        replyMs,
        intakeSettledMs: performance.now() - start,
        status: run.status,
        reason: run.reason,
        reply: reply.content,
        usage: run.usage,
        timings: run.timings,
        operations: companionOperations(b.store, run),
        active,
        context: context.meta,
      });
      console.log(
        `${b.fast ? "fast" : "serial"} ${step.id}: ${run.status}, ${(replyMs / 1000).toFixed(2)}s`,
      );
      checkpoint();
    }
  }
  const cases = JSON.parse(readFileSync(plan.reviewPlan, "utf8")).reviews as {
    id: string;
    state: string;
    input: string;
    draft: string;
    reject: boolean;
    speakerName?: string;
  }[];
  const states = JSON.parse(readFileSync(plan.reviewStates, "utf8"));
  for (const test of cases) {
    const state = states[test.state];
    const read = structuredClone(state.read);
    if (test.speakerName)
      read.replyParticipants.speaker.name = test.speakerName;
    // Program-derived address resolution is rebuilt from the frozen profile, never from expected verdicts.
    read.addressResolution = resolveAddress(read.criticalProfile ?? []);
    const model = new ReviewBenchmarkModel(
      provider,
      "parallel",
      meter,
      `frozen-review:${test.id}`,
    );
    const definitions = (["facts", "operations"] as const).map((part) => {
      const messages = memoryReplyReviewMessages(
        {
          contractPart: part,
          userInput: test.input,
          draft: test.draft,
          saveIntent: false,
          memoryReadData: read,
          memoryOperations: state.operations,
        },
        true,
      );
      return {
        part,
        messages,
        system: memoryReplyReview(false, part, true, true),
        ...memoryReplyReviewOptions(part, true),
      };
    });
    const outcomes = await Promise.all(
      definitions.map(async (d) => {
        const result = await collect(model, {
          purpose: "judge",
          model: plan.model,
          system: d.system,
          messages: d.messages,
          signal: AbortSignal.timeout(30000),
          tools: [],
          maxOutputTokens: d.maxOutputTokens,
          reasoningEffort: d.reasoningEffort,
          json: true,
        });
        return parseMemoryReplyAssessment(
          parseJson(result.text),
          test.draft,
          false,
          d.part,
          d.part === "operations" ? test.input : undefined,
        );
      }),
    );
    const mentions = nameMentions(
      test.draft,
      read.criticalProfile ?? [],
      read.replyParticipants.speaker.name,
    );
    let referenceChecks: unknown[] = [];
    if (mentions.length) {
      const result = await collect(model, {
        purpose: "judge",
        model: plan.model,
        system: NAMING_REFERENCE_SYSTEM,
        messages: namingReferenceMessages(test.draft, mentions),
        signal: AbortSignal.timeout(30000),
        tools: [],
        maxOutputTokens: 1500,
        json: true,
        outputSchema: NAMING_REFERENCE_OUTPUT_SCHEMA,
      });
      referenceChecks = namingReferenceChecks(
        test.draft,
        mentions,
        parseNamingReferences(parseJson(result.text), mentions),
      );
    }
    const rejected =
      outcomes.some((o) => o.violations.length) || referenceChecks.length > 0;
    reviews.push({
      id: test.id,
      expectedReject: test.reject,
      rejected,
      pass: rejected === test.reject,
      outcomes,
      referenceChecks,
    });
    checkpoint();
    console.log(
      `review ${test.id}: ${rejected === test.reject ? "PASS" : "FAIL"}`,
    );
  }
  save("results.json", { rows, reviews, charged: meter.charged });
} finally {
  for (const b of branches) await b.h.close();
}
