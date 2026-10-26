import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { loadConfig } from "../src/config.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import { ProviderModel } from "../src/model.js";
import {
  BenchmarkMeter,
  ReviewBenchmarkModel,
} from "./lib/review-benchmark-model.js";

const out = resolve("test-results/conversation-turn-v1");
const save = (name: string, data: unknown) =>
  writeFileSync(join(out, name), JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
const bytes = readFileSync(join(out, "plan.json"));
if (
  createHash("sha256").update(bytes).digest("hex") !==
  readFileSync(join(out, "plan.sha256"), "utf8")
)
  throw Error("frozen_plan_changed");
const final = process.argv.includes("--candidate-final");
if (
  final &&
  (!existsSync(join(out, "results.json")) ||
    existsSync(join(out, "candidate-final.partial.json")))
)
  throw Error("invalid_final_replay");
if (!final && existsSync(join(out, "meter.json")))
  throw Error("benchmark_already_started");
const plan = JSON.parse(bytes.toString()) as {
  cap: number;
  model: string;
  cases: { id: string; input: string; rubric: string }[];
};
const db = new Database(
  resolve(
    "local-data/memory-cm3-2-trial/bots/9f8ad26a-6800-46e0-af11-0e689f388c36/companion.sqlite",
  ),
  { readonly: true },
);
const persona = JSON.parse(
  (db.prepare("SELECT data FROM settings").get() as { data: string }).data,
).persona;
db.close();
const config = stableMemoryConfig(
  loadConfig({
    dataDir: out,
    modelMode: "deepseek",
    model: plan.model,
    trafficOrigin: "synthetic",
    maxOutputTokens: 800,
  }),
);
const provider = new ProviderModel(config, () => plan.model);
const meter = new BenchmarkMeter(plan.cap, () =>
  save("meter.json", {
    cap: meter.cap,
    charged: meter.charged,
    calls: meter.calls,
  }),
);
if (final) {
  const prior = JSON.parse(readFileSync(join(out, "meter.json"), "utf8"));
  meter.charged = prior.charged;
  meter.calls = prior.calls;
  save("candidate-final.partial.json", { rows: [], charged: meter.charged });
}
const rows: Record<string, unknown>[] = [];
save(
  final ? "source-manifest-final.json" : "source-manifest.json",
  Object.fromEntries(
    [
      "src/conversation-style.ts",
      "src/reply-presentation.ts",
      "src/context.ts",
      "src/harness.ts",
    ].map((p) => [
      p,
      createHash("sha256").update(readFileSync(p)).digest("hex"),
    ]),
  ),
);
for (const [index, test] of plan.cases.entries()) {
  for (const candidate of final
    ? [true]
    : index % 2
      ? [true, false]
      : [false, true]) {
    const branch = candidate ? "candidate" : "baseline",
      dir = join(out, `${test.id}-${branch}${final ? "-final" : ""}`);
    const store = new Store(dir, {
      ownerUserId: "synthetic-turn",
      relationshipId: "turn-benchmark",
    });
    store.enableMemoryV3();
    store.saveSettings({
      ...store.settings(),
      persona,
      model: plan.model,
      splitReplies: true,
      messagePacing: candidate,
      proactiveEnabled: false,
      remoteDisclosureAcknowledged: true,
      dailyTokenBudget: 1000000,
    });
    const model = new ReviewBenchmarkModel(
      provider,
      "parallel",
      meter,
      `${test.id}:${branch}`,
    );
    const h = new Harness(store, model, {
      ...config,
      dataDir: dir,
      conversationExperiment: candidate,
    });
    try {
      const started = performance.now(),
        accepted = h.submit(test.input, test.id);
      while (
        ["queued", "running"].includes(
          store.require("runs", accepted.runId).status,
        )
      )
        await delay(10);
      while (
        store.byStatus("memory_inbox", ["queued", "running", "requires_sync"])
          .length
      )
        await delay(10);
      const run = store.require("runs", accepted.runId);
      const replies = store
        .all("messages")
        .filter(
          (m) => m.role === "assistant" && m.runId === run.id && m.content,
        )
        .sort((a, b) => (a.replyIndex ?? 0) - (b.replyIndex ?? 0));
      rows.push({
        id: test.id,
        branch,
        input: test.input,
        rubric: test.rubric,
        status: run.status,
        reason: run.reason,
        elapsedMs: performance.now() - started,
        replies: replies.map((m) => ({
          content: m.content,
          createdAt: m.createdAt,
          index: m.replyIndex,
        })),
        usage: run.usage,
        timings: run.timings,
        trace: store
          .traces(run.id)
          .filter((t) => t.stage === "memory_reply")
          .map((t) => ({ reason: t.reason, data: t.data })),
      });
      save(final ? "candidate-final.partial.json" : "results.partial.json", {
        rows,
        charged: meter.charged,
      });
      console.log(
        `${test.id} ${branch}: ${run.status}, ${replies.length} bubbles`,
      );
    } finally {
      await h.close();
    }
  }
}
save(final ? "candidate-final.json" : "results.json", {
  rows,
  charged: meter.charged,
});
