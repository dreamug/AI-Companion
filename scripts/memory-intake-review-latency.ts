import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { Harness } from "../src/harness.js";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import { ProviderModel, collect, parseJson } from "../src/model.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";
import {
  memoryReplyReview,
  memoryReplyReviewMessages,
  memoryReplyReviewOptions,
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
const out = resolve("test-results/memory-intake-review-latency");
const save = (name: string, value: unknown) =>
  writeFileSync(join(out, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
const bytes = readFileSync(join(out, "plan.json"));
if (
  createHash("sha256").update(bytes).digest("hex") !==
  readFileSync(join(out, "plan.sha256"), "utf8")
)
  throw Error("frozen_plan_changed");
if (existsSync(join(out, "meter.json"))) throw Error("already_started");
const plan = JSON.parse(bytes.toString());
const config = {
  ...stableMemoryConfig(
    loadConfig({
      dataDir: out,
      model: plan.model,
      modelMode: "deepseek",
      maxOutputTokens: 800,
      trafficOrigin: "synthetic",
    }),
  ),
  conversationExperiment: true,
};
const provider = new ProviderModel(config, () => plan.model);
const meter = new BenchmarkMeter(plan.cap, () =>
  save("meter.json", {
    charged: meter.charged,
    cap: meter.cap,
    calls: meter.calls,
  }),
);
const { Harness: BeforeHarness } = await import(
  pathToFileURL(join(out, "before-app/dist/harness.js")).href
);
const source = new Database(
  resolve("local-data/conversation-turn-v1/companion.sqlite"),
  { readonly: true },
);
const persona = JSON.parse(
  (source.prepare("SELECT data FROM settings").get() as { data: string }).data,
).persona;
source.close();
const rows: Record<string, unknown>[] = [];
for (const [index, test] of plan.pairedCases.entries()) {
  for (const after of index % 2 ? [true, false] : [false, true]) {
    const label = after ? "after" : "before",
      dir = join(out, `${test.id}-${label}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = new Store(dir, {
      ownerUserId: "synthetic-latency",
      relationshipId: "comparison",
    });
    store.enableMemoryV3();
    store.saveSettings({
      ...store.settings(),
      persona,
      model: plan.model,
      splitReplies: true,
      messagePacing: true,
      proactiveEnabled: false,
      remoteDisclosureAcknowledged: true,
      dailyTokenBudget: 1000000,
    });
    const model = new ReviewBenchmarkModel(
      provider,
      "parallel",
      meter,
      `${test.id}:${label}`,
    );
    const h = new (after ? Harness : BeforeHarness)(store, model, {
      ...config,
      dataDir: dir,
    });
    try {
      const began = performance.now(),
        r = h.submit(test.input, test.id);
      while (
        ["queued", "running"].includes(store.require("runs", r.runId).status)
      )
        await delay(10);
      while (
        store.byStatus("memory_inbox", ["queued", "running", "requires_sync"])
          .length
      )
        await delay(10);
      const run = store.require("runs", r.runId),
        messages = store
          .all("messages")
          .filter(
            (m) => m.role === "assistant" && m.runId === r.runId && m.content,
          )
          .sort((a, b) => (a.replyIndex ?? 0) - (b.replyIndex ?? 0));
      rows.push({
        id: test.id,
        label,
        status: run.status,
        reason: run.reason,
        replyReadyMs: run.timings?.replyReadyMs,
        totalMs: performance.now() - began,
        messages: messages.map((m) => ({
          text: m.content,
          createdAt: m.createdAt,
        })),
        timings: run.timings,
        usage: run.usage,
        intake: store
          .all("memory_inbox")
          .map((x) => ({ status: x.status, reason: x.reason })),
        upgrades: store
          .traces(run.id)
          .filter((t) => t.reason === "intake_upgrade")
          .map((t) => t.data),
      });
      save("results.partial.json", { rows });
      console.log(
        JSON.stringify({
          id: test.id,
          label,
          status: run.status,
          firstSeconds: (run.timings?.replyReadyMs ?? 0) / 1000,
        }),
      );
    } finally {
      await h.close();
    }
  }
}
save("results.json", { rows });
// Reuse the unchanged frozen polarity set. The same 8s batch deadline applies;
// any timeout/invalid schema is a failed case, never a successful rejection.
const old = resolve("test-results/companion-memory-cm3/address-perspective");
const cases = JSON.parse(readFileSync(join(old, "plan.json"), "utf8")).reviews;
const states = JSON.parse(
  readFileSync(join(old, "known-replay/state-projections.json"), "utf8"),
);
const reviews: Record<string, unknown>[] = [];
for (const test of cases) {
  const state = states[test.state],
    read = structuredClone(state.read);
  if (test.speakerName) read.replyParticipants.speaker.name = test.speakerName;
  const model = new ReviewBenchmarkModel(
      provider,
      "parallel",
      meter,
      `review:${test.id}`,
    ),
    ctrl = new AbortController(),
    timeout = setTimeout(() => ctrl.abort(), 8000);
  const mentions = nameMentions(
    test.draft,
    read.criticalProfile ?? [],
    read.replyParticipants.speaker.name,
  );
  try {
    const settled = await Promise.allSettled([
      ...(["facts", "operations"] as const).map(async (part) => {
        const options = memoryReplyReviewOptions(part, true),
          result = await collect(model, {
            purpose: "judge",
            model: plan.model,
            system: memoryReplyReview(false, part, true, true),
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
            signal: ctrl.signal,
            maxOutputTokens: options.maxOutputTokens,
            reasoningEffort: options.reasoningEffort,
            json: true,
          });
        return parseMemoryReplyAssessment(
          parseJson(result.text),
          test.draft,
          false,
          part,
          part === "operations" ? test.input : undefined,
        );
      }),
      ...(mentions.length
        ? [
            collect(model, {
              purpose: "judge",
              model: plan.model,
              system: NAMING_REFERENCE_SYSTEM,
              messages: namingReferenceMessages(test.draft, mentions),
              tools: [],
              signal: ctrl.signal,
              maxOutputTokens: 1500,
              json: true,
              outputSchema: NAMING_REFERENCE_OUTPUT_SCHEMA,
            }).then((result) => ({
              violations: namingReferenceChecks(
                test.draft,
                mentions,
                parseNamingReferences(parseJson(result.text), mentions),
              ),
            })),
          ]
        : []),
    ]);
    const invalid = settled.some((x) => x.status === "rejected");
    const rejected = settled.some(
      (x) => x.status === "fulfilled" && x.value.violations.length > 0,
    );
    const pass = !invalid && rejected === test.reject;
    reviews.push({
      id: test.id,
      expectedReject: test.reject,
      rejected,
      invalid,
      pass,
      results: settled.map((x) =>
        x.status === "fulfilled" ? x.value : { error: String(x.reason) },
      ),
    });
    console.log(`${test.id}: ${pass ? "PASS" : "FAIL"}`);
  } finally {
    clearTimeout(timeout);
  }
  save("reviews.partial.json", { reviews });
}
save("reviews.json", { reviews, charged: meter.charged });
