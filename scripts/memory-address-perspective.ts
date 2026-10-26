import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
import { memoryReplyReadData } from "../src/memory/read-scope.js";
import {
  memoryReplyReview,
  memoryReplyReviewOptions,
  memoryReplyReviewMessages,
  parseMemoryReplyAssessment,
} from "../src/memory/reply-contract.js";
import { replyParticipants } from "../src/memory/address.js";
import {
  nameMentions,
  NAMING_REFERENCE_SYSTEM,
  NAMING_REFERENCE_OUTPUT_SCHEMA,
  namingReferenceMessages,
  parseNamingReferences,
  namingReferenceChecks,
} from "../src/memory/naming.js";

const baseOut = resolve(
  "test-results/companion-memory-cm3/address-perspective",
);
const replay = process.argv.includes("--known-set-replay");
const nativeFinal = process.argv.includes("--native-final");
const proFinal = process.argv.includes("--pro-final");
const fastFinal = process.argv.includes("--fast-final");
const finalReview =
  process.argv.includes("--final-review") ||
  nativeFinal ||
  proFinal ||
  fastFinal;
const holdout = process.argv.includes("--holdout");
if ([replay, finalReview, holdout].filter(Boolean).length > 1)
  throw Error("choose_one_stage");
const stage = holdout
  ? "holdout"
  : fastFinal
    ? "fast-final"
    : proFinal
      ? "pro-final"
      : nativeFinal
        ? "native-final"
        : finalReview
          ? "final-review"
          : replay
            ? "known-replay"
            : "first";
const out = stage === "first" ? baseOut : join(baseOut, stage);
if (replay || finalReview) {
  if (!existsSync(join(baseOut, "results.json"))) throw Error("no_first_run");
  mkdirSync(out, { mode: 0o700 });
} else if (holdout) {
  if (!existsSync(join(baseOut, "pro-final/results.json")))
    throw Error("no_final_review");
  if (existsSync(join(out, "results.partial.json")))
    throw Error("holdout_already_started");
} else mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) =>
  writeFileSync(join(out, name), JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
type Step = {
  id: string;
  input: string;
  userAddress: string;
  reset?: boolean;
  advance?: "segment" | "midnight";
  question?: "user" | "assistant" | "both";
};
type Review = {
  id: string;
  state: string;
  input: string;
  draft: string;
  reject: boolean;
  speakerName?: string;
  known?: boolean;
};
type Plan = {
  model: string;
  budget: number;
  frozenAt: number;
  cohorts: { name: string; steps: Step[] }[];
  reviews: Review[];
};
const proposed: Plan = {
  model: "deepseek-flash",
  budget: 350000,
  frozenAt: Date.now(),
  cohorts: [
    {
      name: "岚汐",
      steps: [
        { id: "a1", input: "以后叫我北屿吧。", userAddress: "北屿" },
        { id: "a2", input: "这段聊天先叫我小满。", userAddress: "小满" },
        {
          id: "a3",
          input: "现在你该怎么称呼我？",
          userAddress: "小满",
          reset: true,
          question: "user",
        },
        {
          id: "a4",
          input: "那你自己叫什么？",
          userAddress: "小满",
          reset: true,
          question: "assistant",
        },
        {
          id: "a5",
          input: "用一句话分别说清楚你怎么称呼我、你自己叫什么。",
          userAddress: "小满",
          reset: true,
          question: "both",
        },
        {
          id: "a6",
          input: "这段聊天的临时称呼改成松露。",
          userAddress: "松露",
        },
        {
          id: "a7",
          input: "这段聊天里，你怎么叫我，我又该怎么叫你？",
          userAddress: "松露",
          reset: true,
          question: "both",
        },
        {
          id: "a8",
          input: "隔了一阵子回来啦，现在你怎么叫我、你自己叫什么？",
          userAddress: "北屿",
          reset: true,
          advance: "segment",
          question: "both",
        },
      ],
    },
    {
      name: "Nova",
      steps: [
        { id: "b1", input: "以后请叫我 River。", userAddress: "River" },
        { id: "b2", input: "今天先称呼我 Lumi。", userAddress: "Lumi" },
        {
          id: "b3",
          input: "说说此刻你怎么称呼我。",
          userAddress: "Lumi",
          reset: true,
          question: "user",
        },
        {
          id: "b4",
          input: "我应该用什么名字称呼你呢？",
          userAddress: "Lumi",
          reset: true,
          question: "assistant",
        },
        {
          id: "b5",
          input:
            "Please introduce yourself, then tell me what you call me today.",
          userAddress: "Lumi",
          reset: true,
          question: "both",
        },
        {
          id: "b6",
          input: "今天那个临时叫法到期以后，我们各叫什么？",
          userAddress: "River",
          reset: true,
          advance: "midnight",
          question: "both",
        },
      ],
    },
  ],
  reviews: [
    {
      id: "r01",
      state: "a3",
      input: "现在你怎么称呼我？",
      draft: "现在我叫你小满。",
      reject: false,
    },
    {
      id: "r02",
      state: "a3",
      input: "现在你怎么称呼我？",
      draft: "现在你叫我小满。",
      reject: true,
    },
    {
      id: "r03",
      state: "a4",
      input: "你自己叫什么？",
      draft: "我叫岚汐。",
      reject: false,
    },
    {
      id: "r04",
      state: "a4",
      input: "你自己叫什么？",
      draft: "我叫小满。",
      reject: true,
    },
    {
      id: "r05",
      state: "a5",
      input: "分别说说双方的称呼。",
      draft: "你是小满，我是岚汐。",
      reject: false,
    },
    {
      id: "r06",
      state: "a5",
      input: "分别说说双方的称呼。",
      draft: "你是岚汐，我是小满。",
      reject: true,
    },
    {
      id: "r07",
      state: "a3",
      input: "我刚才希望你怎么称呼我？",
      draft: "你刚才说‘这段聊天先叫我小满’，所以现在我叫你小满。",
      reject: false,
    },
    {
      id: "r08",
      state: "a3",
      input: "别把咱俩弄反了。",
      draft: "我并不叫小满，那是我称呼你的叫法；我自己叫岚汐。",
      reject: false,
    },
    {
      id: "r09",
      state: "a3",
      input: "写一句故事对白，用‘小满’当角色名。",
      draft: "故事里的旅人说：‘我叫小满。’",
      reject: false,
    },
    {
      id: "r10",
      state: "a3",
      input: "解释一下‘叫我小满’是谁对谁说的。",
      draft: "‘叫我小满’是你对我说的，其中‘我’指你。",
      reject: false,
    },
    {
      id: "r11",
      state: "a4",
      input: "你自己叫什么？",
      draft: "我的名字是小满。",
      reject: true,
    },
    {
      id: "r12",
      state: "a5",
      input: "这段聊天里咱俩互相怎么叫？",
      draft: "这段聊天里，你可以叫我岚汐，我叫你小满。",
      reject: false,
    },
    {
      id: "r13",
      state: "a7",
      input: "现在你怎么称呼我？",
      draft: "我会叫你小满。",
      reject: true,
    },
    {
      id: "r14",
      state: "a7",
      input: "现在你怎么称呼我？",
      draft: "现在我叫你松露。",
      reject: false,
    },
    {
      id: "r15",
      state: "a8",
      input: "现在你自己叫什么？",
      draft: "我的名字是松露。",
      reject: true,
    },
    {
      id: "r16",
      state: "a8",
      input: "现在你怎么叫我？",
      draft: "现在我叫你北屿。",
      reject: false,
    },
    {
      id: "r17",
      state: "b5",
      input: "What do you call me?",
      draft: "I call you Lumi.",
      reject: false,
    },
    {
      id: "r18",
      state: "b5",
      input: "What do you call me?",
      draft: "You can call me Lumi.",
      reject: true,
    },
    {
      id: "r19",
      state: "b5",
      input: "Please introduce yourself.",
      draft: "I am Nova.",
      reject: false,
    },
    {
      id: "r20",
      state: "b5",
      input: "Please introduce yourself.",
      draft: "I am Lumi.",
      reject: true,
    },
    {
      id: "r21",
      state: "b3",
      input: "分别说一下双方的称呼。",
      draft: "我叫 Lumi，也会称呼你为 Lumi。",
      reject: false,
      speakerName: "Lumi",
    },
    {
      id: "r22",
      state: "b6",
      input: "现在分别说说咱俩怎么叫。",
      draft: "你可以叫我 Nova，我称呼你为 River。",
      reject: false,
    },
    {
      id: "r23",
      state: "b6",
      input: "现在怎么称呼我？",
      draft: "我称呼你为 Lumi。",
      reject: true,
    },
    {
      id: "historical-form",
      state: "a3",
      input: "这一会儿你会怎么叫我？",
      draft: "这会儿就叫我“小满”吧，这段聊天里用这个称呼。",
      reject: true,
      known: true,
    },
  ],
};
if (process.argv.includes("--freeze")) {
  if (existsSync(join(out, "plan.json"))) throw Error("plan_already_frozen");
  save("plan.json", proposed);
  writeFileSync(
    join(out, "plan.sha256"),
    hash(readFileSync(join(out, "plan.json"))),
    { mode: 0o600 },
  );
  console.log("frozen: 14 pipeline turns, 24 paired reviews; 350000 token cap");
  process.exit(0);
}
if (!process.argv.includes("--run") && !replay && !finalReview && !holdout)
  throw Error("use_freeze_then_run");
const planDir = holdout ? out : baseOut;
const bytes = readFileSync(join(planDir, "plan.json"));
if (hash(bytes) !== readFileSync(join(planDir, "plan.sha256"), "utf8"))
  throw Error("frozen_plan_changed");
if (stage === "first" && existsSync(join(baseOut, "meter.json")))
  throw Error("run_already_started_no_reset");
const plan = JSON.parse(bytes.toString()) as Plan;
save(
  "source-sha256.json",
  Object.fromEntries(
    [
      "src/memory/address.ts",
      "src/context.ts",
      "src/memory/read-scope.ts",
      "src/memory/reply-contract.ts",
      "src/harness.ts",
      "src/memory/naming.ts",
      "scripts/memory-address-perspective.ts",
    ].map((f) => [f, hash(readFileSync(f))]),
  ),
);
const prior =
  stage !== "first"
    ? JSON.parse(readFileSync(join(baseOut, "meter.json"), "utf8"))
    : undefined;
const cap = fastFinal
  ? 1500000
  : proFinal || holdout
    ? 1250000
    : nativeFinal
      ? 1100000
      : finalReview
        ? 950000
        : replay
          ? 650000
          : plan.budget;
const meter = new BenchmarkMeter(cap, () =>
  writeFileSync(
    join(baseOut, "meter.json"),
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
    kind: stage,
    originalPlanHash: hash(bytes),
    factsModel: proFinal || holdout ? "deepseek-v4-pro" : plan.model,
    inputsUnchanged: true,
    priorCharged: prior.charged,
    cap,
  });
}
const config = loadConfig({
  dataDir: out,
  memoryV3: true,
  memoryV2: true,
  memoryVectors: false,
  memorySummaries: false,
  memoryReplyGuard: true,
  memoryAnswerReasoning: false,
  memoryFactsModel: proFinal || holdout ? "deepseek-v4-pro" : undefined,
  modelMode: "deepseek",
  model: plan.model,
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
type State = {
  read: ReturnType<typeof memoryReplyReadData>;
  operations: unknown;
  expected: string;
  correct: boolean;
};
const states = new Map<string, State>();
if (finalReview) {
  const previous = JSON.parse(
    readFileSync(join(baseOut, "known-replay/state-projections.json"), "utf8"),
  );
  for (const [key, value] of Object.entries(previous))
    states.set(key, value as State);
}
const rows: Record<string, unknown>[] = [];
const checkpoint = () => {
  save("results.partial.json", { charged: meter.charged, rows });
  save("state-projections.json", Object.fromEntries(states));
};
for (const [i, cohort] of (finalReview ? [] : plan.cohorts).entries()) {
  const dir = join(out, `pipeline-${i}`);
  mkdirSync(dir, { mode: 0o700 });
  const store = new Store(dir, {
    ownerUserId: "synthetic-owner",
    relationshipId: `perspective-${i}`,
  });
  store.enableMemoryV3();
  store.saveSettings({
    ...store.settings(),
    persona: { ...persona, name: cohort.name },
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
  const h = new Harness(
    store,
    new ReviewBenchmarkModel(
      provider,
      "parallel",
      meter,
      `${stage}-pipeline-${i}`,
    ),
    { ...config, dataDir: dir },
    clock,
  );
  try {
    for (const step of cohort.steps) {
      clock.time += step.advance === "segment" ? 30 * 60000 + 1 : 1000;
      if (step.advance === "midnight") {
        const temp = store
          .all("memories")
          .find(
            (m) => m.status === "active" && m.predicate === "address_override",
          );
        if (!temp?.admission?.validUntil) throw Error("no_real_expiry");
        clock.time = temp.admission.validUntil;
      }
      if (step.reset) h.resetCompanionContext();
      const result = h.submit(step.input, `perspective-${step.id}`);
      while (
        ["queued", "running"].includes(
          store.require("runs", result.runId).status,
        )
      )
        await delay(15);
      const run = store.require("runs", result.runId);
      const context = h.context(run.id) as { messages?: TurnMessage[] };
      const read = context.messages
        ? memoryReplyReadData(context.messages)
        : undefined;
      const operations = context.messages
        ? JSON.parse(context.messages[0]!.content.split("\n")[1]!)
            .memoryOperations
        : undefined;
      const correct =
        read?.addressResolution?.effective?.value === step.userAddress &&
        read?.addressResolution?.subject === "user" &&
        read?.replyParticipants?.speaker.name === cohort.name;
      if (read)
        states.set(step.id, {
          read,
          operations,
          expected: step.userAddress,
          correct,
        });
      rows.push({
        kind: "pipeline",
        id: step.id,
        input: step.input,
        question: step.question,
        status: run.status,
        reason: run.reason,
        stateCorrect: correct,
        userAddress: step.userAddress,
        speakerName: cohort.name,
        answer: store.get("messages", `assistant-${run.id}`)?.content,
        runId: run.id,
        usage: run.usage,
        checks: store
          .traces(run.id)
          .filter(
            (t) =>
              t.stage === "memory_reply" &&
              ["accepted", "rejected"].includes(t.reason),
          )
          .map((t) => ({ result: t.reason, ...t.data })),
      });
      checkpoint();
      console.log(
        JSON.stringify({
          id: step.id,
          status: run.status,
          correct,
          charged: meter.charged,
        }),
      );
    }
  } catch (e) {
    rows.push({
      kind: "pipeline_error",
      cohort: i,
      reason: e instanceof Error ? e.message : "unknown",
    });
    checkpoint();
  } finally {
    await h.close();
  }
}
async function runReview(test: Review) {
  const state = states.get(test.state);
  if (!state?.correct) {
    rows.push({
      kind: "review",
      id: test.id,
      pass: false,
      reason: "invalid_source_state",
    });
    checkpoint();
    return;
  }
  const read = test.speakerName
    ? { ...state.read, replyParticipants: replyParticipants(test.speakerName) }
    : state.read;
  const model = new ReviewBenchmarkModel(
    provider,
    "parallel",
    meter,
    `${stage}-${test.id}`,
  );
  const mentions = fastFinal
    ? nameMentions(
        test.draft,
        read.criticalProfile ?? [],
        read.replyParticipants?.speaker.name ?? "",
      )
    : [];
  const naming = mentions.length
    ? (async () => {
        const result = await collect(
          new ReviewBenchmarkModel(
            provider,
            "parallel",
            meter,
            `${stage}-${test.id}-binding`,
          ),
          {
            purpose: "judge",
            model: plan.model,
            system: NAMING_REFERENCE_SYSTEM,
            messages: namingReferenceMessages(test.draft, mentions),
            tools: [],
            signal: AbortSignal.timeout(60000),
            maxOutputTokens: 1500,
            json: true,
            temperature: 0,
            outputSchema: NAMING_REFERENCE_OUTPUT_SCHEMA,
          },
        );
        const references = parseNamingReferences(
          parseJson(result.text),
          mentions,
        );
        const checks = namingReferenceChecks(test.draft, mentions, references);
        return {
          part: "name_binding",
          checks,
          references,
          violations: checks.length ? ["memory_constraint_conflict"] : [],
        };
      })()
    : undefined;
  const settled = await Promise.allSettled([
    ...(["facts", "operations"] as const).map(async (part) => {
      const result = await collect(model, {
        purpose: "judge",
        model:
          (proFinal || holdout) && part === "facts"
            ? "deepseek-v4-pro"
            : plan.model,
        system: memoryReplyReview(false, part, true),
        messages: memoryReplyReviewMessages(
          {
            contractPart: part,
            userInput: test.input,
            draft: test.draft,
            saveIntent: false,
            memoryReadData: read,
            memoryOperations: state.operations,
          },
          true,
        ),
        tools: [],
        signal: AbortSignal.timeout(60000),
        ...memoryReplyReviewOptions(part, true),
        json: true,
        temperature: part === "facts" ? undefined : 0,
      });
      return {
        part,
        ...parseMemoryReplyAssessment(
          parseJson(result.text),
          test.draft,
          false,
          part,
        ),
      };
    }),
    ...(naming ? [naming] : []),
  ]);
  const allReturned = settled.every((x) => x.status === "fulfilled");
  const assessments = settled.map((x) =>
    x.status === "fulfilled"
      ? x.value
      : { error: x.reason instanceof Error ? x.reason.message : "unknown" },
  );
  const facts =
    settled[0]?.status === "fulfilled" ? settled[0].value : undefined;
  const operations =
    settled[1]?.status === "fulfilled" ? settled[1].value : undefined;
  const binding =
    settled[2]?.status === "fulfilled" ? settled[2].value : undefined;
  const pass =
    allReturned &&
    (test.reject
      ? (facts?.violations.includes("memory_constraint_conflict") ||
          binding?.violations.includes("memory_constraint_conflict")) &&
        operations?.violations.length === 0
      : facts?.violations.length === 0 &&
        operations?.violations.length === 0 &&
        (!binding || binding.violations.length === 0));
  rows.push({
    kind: "review",
    id: test.id,
    known: test.known ?? false,
    draft: test.draft,
    shouldReject: test.reject,
    allReturned,
    pass,
    assessments,
  });
  checkpoint();
  console.log(JSON.stringify({ id: test.id, pass, charged: meter.charged }));
}
// Frozen states are read-only. Two independent pairs may share the experiment meter.
for (let offset = 0; offset < plan.reviews.length; offset += 2)
  await Promise.all(plan.reviews.slice(offset, offset + 2).map(runReview));
save("results.json", {
  planHash: hash(bytes),
  charged: meter.charged,
  cap: meter.cap,
  rows,
});
console.log(
  JSON.stringify({
    done: true,
    charged: meter.charged,
    reviewsPassed: rows.filter((r) => r.kind === "review" && r.pass).length,
    reviewsTotal: plan.reviews.length,
  }),
);
