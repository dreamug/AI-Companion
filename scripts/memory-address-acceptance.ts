import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { loadConfig } from "../src/config.js";
import {
  ProviderModel,
  collect,
  parseJson,
  type TurnMessage,
} from "../src/model.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";
import { resolveAddress } from "../src/memory/address.js";
import { companionProfile } from "../src/memory/companion-v3.js";
import { memoryReplyReadData } from "../src/memory/read-scope.js";
import {
  memoryReplyReview,
  parseMemoryReplyAssessment,
} from "../src/memory/reply-contract.js";
const baseOut = resolve("test-results/companion-memory-cm3/address-priority");
const replay = process.argv.includes("--known-set-replay");
const out = replay ? join(baseOut, "known-replay") : baseOut;
if (replay) {
  if (!existsSync(join(baseOut, "live-results.json")))
    throw Error("no_first_run_to_replay");
  mkdirSync(out, { mode: 0o700 });
}
const bytes = readFileSync(join(baseOut, "live-plan.json"));
if (
  createHash("sha256").update(bytes).digest("hex") !==
  readFileSync(join(baseOut, "live-plan.sha256"), "utf8").trim()
)
  throw Error("frozen_plan_changed");
type Step = {
  id: string;
  input: string;
  effective: string | null;
  question: boolean;
  advance: string | null;
};
const plan = JSON.parse(bytes.toString()) as {
  model: string;
  budget: number;
  frozenAt: number;
  cohorts: Record<string, Step[]>;
  reviews: {
    id: string;
    state: string;
    draft: string;
    shouldReject: boolean;
  }[];
  historicalReplay: { source: string; repeats: number };
};
if (!replay && existsSync(join(baseOut, "live-meter.json")))
  throw Error("real_run_already_started_no_budget_reset");
const save = (name: string, value: unknown) =>
  writeFileSync(join(out, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
const prior = replay
  ? JSON.parse(readFileSync(join(baseOut, "live-meter.json"), "utf8"))
  : undefined;
const cap = replay ? 630000 : plan.budget;
const meter = new BenchmarkMeter(cap, () =>
  writeFileSync(
    join(baseOut, "live-meter.json"),
    JSON.stringify(
      {
        charged: meter.charged,
        cap: meter.cap,
        calls: meter.calls,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  ),
);
if (prior) {
  meter.charged = prior.charged;
  meter.calls = prior.calls;
  save("replay-plan.json", {
    originalPlanHash: createHash("sha256").update(bytes).digest("hex"),
    cap,
    priorCharged: prior.charged,
    kind: "known_set_full_regression_replay",
    inputsUnchanged: true,
  });
}
const source = new Database(
  resolve(
    "local-data/memory-cm3-2-trial/bots/9f8ad26a-6800-46e0-af11-0e689f388c36/companion.sqlite",
  ),
  { readonly: true },
);
const persona = JSON.parse(
  (source.prepare("select data from settings").get() as { data: string }).data,
).persona;
source.close();
const base = {
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
const config = loadConfig({ ...base, dataDir: out });
const provider = new ProviderModel(config, () => plan.model);
const rows: Record<string, unknown>[] = [];
type State = {
  read: ReturnType<typeof memoryReplyReadData>;
  operations: unknown;
  input: string;
  expected: string | null;
  stateMatches: boolean;
};
const states = new Map<string, State>();
const checkpoint = () => {
  save("live-results.partial.json", { charged: meter.charged, rows });
  save("state-projections.json", Object.fromEntries(states));
};
for (const [cohort, steps] of Object.entries(plan.cohorts)) {
  const dir = join(out, `live-${cohort}`);
  mkdirSync(dir, { mode: 0o700 });
  const store = new Store(dir, {
    ownerUserId: "synthetic-owner",
    relationshipId: `address-validation-${cohort}`,
  });
  store.enableMemoryV3();
  store.saveSettings({
    ...store.settings(),
    persona: { ...persona, name: "小野·称呼验证" },
    proactiveEnabled: false,
    remoteDisclosureAcknowledged: true,
    dailyTokenBudget: 1000000,
  });
  const clock = {
    time: plan.frozenAt,
    now() {
      return this.time;
    },
  };
  let label = "";
  const metered = new ReviewBenchmarkModel(
    provider,
    "parallel",
    meter,
    `${replay ? "known-" : ""}pipeline-${cohort}`,
  );
  const h = new Harness(
    store,
    metered,
    loadConfig({ ...base, dataDir: dir }),
    clock,
  );
  try {
    for (const step of steps) {
      label = step.id;
      if (step.advance === "exact_30m") clock.time += 30 * 60000;
      else if (step.advance === "new_segment") clock.time += 30 * 60000 + 1;
      else clock.time += 1000;
      if (step.advance === "midnight") {
        const temporary = store
          .all("memories")
          .find(
            (m) => m.status === "active" && m.predicate === "address_override",
          );
        if (!temporary?.admission?.validUntil)
          throw Error("missing_real_midnight_expiry");
        clock.time = temporary.admission.validUntil;
      }
      if (["reset", "midnight", "new_segment"].includes(step.advance ?? ""))
        h.resetCompanionContext();
      const result = h.submit(step.input, `address-validation-${step.id}`);
      while (
        ["queued", "running"].includes(
          store.require("runs", result.runId).status,
        )
      )
        await delay(15);
      const run = store.require("runs", result.runId),
        segmentId = run.config.segmentId as string | undefined;
      const profile = companionProfile(store, clock.now(), segmentId),
        resolution = resolveAddress(profile);
      const context = h.context(run.id) as { messages?: TurnMessage[] };
      let read: ReturnType<typeof memoryReplyReadData> | undefined,
        operations: unknown;
      if (context.messages) {
        read = memoryReplyReadData(context.messages);
        operations = JSON.parse(
          context.messages[0]!.content.split("\n")[1]!,
        ).memoryOperations;
      }
      const stateMatches =
        (resolution.effective?.value ?? null) === step.effective;
      if (read)
        states.set(step.id, {
          read,
          operations,
          input: step.input,
          expected: step.effective,
          stateMatches,
        });
      const row = {
        kind: "pipeline",
        id: step.id,
        status: run.status,
        reason: run.reason,
        stateMatches,
        expected: step.effective,
        effective: resolution.effective,
        answer: store.get("messages", `assistant-${run.id}`)?.content,
        question: step.question,
        runId: run.id,
        usage: run.usage,
        checks: store
          .traces(run.id)
          .filter(
            (x) =>
              x.stage === "memory_reply" &&
              ["accepted", "rejected"].includes(x.reason),
          )
          .map((x) => ({ result: x.reason, ...x.data })),
      };
      rows.push(row);
      checkpoint();
      console.log(
        JSON.stringify({
          kind: row.kind,
          id: step.id,
          status: run.status,
          stateMatches,
          calls: run.usage.calls,
          charged: meter.charged,
        }),
      );
    }
  } catch (error) {
    rows.push({
      kind: "pipeline_runner_failed",
      cohort,
      lastStep: label,
      reason: error instanceof Error ? error.message : "unknown",
    });
    checkpoint();
  } finally {
    await h.close();
  }
}
async function review(
  id: string,
  read: State["read"],
  operations: unknown,
  input: string,
  draft: string,
  shouldReject: boolean,
) {
  const model = new ReviewBenchmarkModel(
    provider,
    "parallel",
    meter,
    `${replay ? "known-" : ""}${id}`,
  );
  const settled = await Promise.allSettled(
    (["facts", "operations"] as const).map(async (part) => {
      const result = await collect(model, {
        purpose: "judge",
        model: plan.model,
        system: memoryReplyReview(false, part, true),
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              contractPart: part,
              userInput: input,
              draft,
              saveIntent: false,
              memoryReadData: read,
              memoryOperations: operations,
            }),
          },
        ],
        tools: [],
        signal: AbortSignal.timeout(60000),
        maxOutputTokens: 1500,
        json: true,
        temperature: 0,
      });
      return {
        part,
        ...parseMemoryReplyAssessment(
          parseJson(result.text),
          draft,
          false,
          part,
        ),
      };
    }),
  );
  const assessments = settled.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { error: r.reason instanceof Error ? r.reason.name : "unknown" },
  );
  const allReturned = settled.every((r) => r.status === "fulfilled");
  const facts =
    settled[0]?.status === "fulfilled" ? settled[0].value : undefined;
  const violations = settled.flatMap((r) =>
    r.status === "fulfilled" ? r.value.violations : [],
  );
  const pass =
    allReturned &&
    (shouldReject
      ? facts?.violations.includes("memory_constraint_conflict")
      : violations.length === 0);
  const row = {
    kind: "review",
    id,
    shouldReject,
    pass,
    allReturned,
    draft,
    assessments,
  };
  rows.push(row);
  checkpoint();
  console.log(
    JSON.stringify({
      kind: "review",
      id,
      shouldReject,
      pass,
      charged: meter.charged,
    }),
  );
}
for (const test of plan.reviews) {
  const state = states.get(test.state);
  if (!state?.stateMatches) {
    rows.push({
      kind: "review",
      id: test.id,
      pass: false,
      reason: "source_state_did_not_match_expected",
    });
    checkpoint();
    continue;
  }
  await review(
    test.id,
    state.read,
    state.operations,
    state.input,
    test.draft,
    test.shouldReject,
  );
}
// Replay the historical frozen draft using a freshly qualified projection of its exact original snapshot/time.
const historical = JSON.parse(
  readFileSync(resolve(plan.historicalReplay.source), "utf8"),
);
const oldPlan = JSON.parse(
  readFileSync(
    resolve("test-results/companion-memory-cm3/real-latency/plan.json"),
    "utf8",
  ),
);
const historicalDir = join(out, "historical-state");
mkdirSync(historicalDir, { mode: 0o700 });
copyFileSync(
  resolve("test-results/companion-memory-cm3/real-latency/baseline.sqlite"),
  join(historicalDir, "companion.sqlite"),
);
chmodSync(join(historicalDir, "companion.sqlite"), 0o600);
const historicalStore = new Store(historicalDir, {
  ownerUserId: oldPlan.ownerUserId,
  relationshipId: oldPlan.relationshipId,
});
historicalStore.enableMemoryV3();
const profile = companionProfile(
  historicalStore,
  oldPlan.frozenAt,
  historicalStore.byStatus("conversation_segments", ["open"])[0]?.id,
);
const original = JSON.parse(historical.facts.messages[0].content);
const value = {
  ...original.memoryReadData.time,
  criticalProfile: profile,
  addressResolution: resolveAddress(profile),
  memories: original.memoryReadData.existingFacts.filter(
    (m: { kind?: string }) => m.kind === "assertion",
  ),
  memoryRead: { mode: "all", complete: true },
};
const read = memoryReplyReadData([
  {
    role: "user",
    content: `<当前状态与记忆数据>\n${JSON.stringify(value)}\n</当前状态与记忆数据>`,
  },
]);
for (let i = 0; i < plan.historicalReplay.repeats; i++)
  await review(
    `historical-${i + 1}`,
    read,
    original.memoryOperations,
    original.userInput,
    original.draft,
    false,
  );
historicalStore.close();
save("live-results.json", {
  planHash: createHash("sha256").update(bytes).digest("hex"),
  charged: meter.charged,
  budget: meter.cap,
  rows,
});
console.log(
  JSON.stringify({
    finished: true,
    charged: meter.charged,
    pipelineRows: rows.filter((r) => r.kind === "pipeline").length,
    reviewPassed: rows.filter((r) => r.kind === "review" && r.pass).length,
    reviewTotal: rows.filter((r) => r.kind === "review").length,
  }),
);
