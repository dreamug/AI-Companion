import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Harness } from "../src/harness.js";
import { ProviderModel } from "../src/model.js";
import { Store } from "../src/store.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { memorySaveReplyDiagnostics } from "./lib/memory-save-diagnostics.js";

const raw = readFileSync(
  new URL("../tests/fixtures/memory-save-intent-live-v1.json", import.meta.url),
  "utf8",
);
const fixture = JSON.parse(raw) as {
  provenance: string;
  cases: {
    id: string;
    input: string;
    autoExtract: boolean;
    explicit: boolean;
    expected: string[];
  }[];
};
const out = resolve(
  process.env.MEMORY_EVAL_OUT ?? "test-results/memory-save-intent-live-v1",
);
mkdirSync(out, { recursive: true, mode: 0o700 });
const report = {
  provenance: fixture.provenance,
  fixtureHash: createHash("sha256").update(raw).digest("hex"),
  vectors: false,
  passed: 0,
  failed: 0,
  rows: [] as Record<string, unknown>[],
};
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
for (const test of fixture.cases) {
  const dir = mkdtempSync(join(tmpdir(), "memory-save-intent-"));
  let shift = 0;
  const clock = { now: () => Date.now() + shift };
  const config = loadConfig({
    dataDir: dir,
    modelMode: "deepseek",
    memoryV2: true,
    memoryVectors: false,
    memorySummaries: false,
    memoryAnswerReasoning: true,
    trafficOrigin: "synthetic",
    maxOutputTokens: 1000,
  });
  const store = new Store(dir, LOCAL_SCOPE);
  const calls: Record<string, unknown>[] = [];
  const provider = new ProviderModel(config, () => store.settings().model);
  const h = new Harness(
    store,
    {
      name: provider.name,
      async *stream(request) {
        const call: Record<string, unknown> = {
          purpose: request.purpose,
          text: "",
          system: request.system,
        };
        calls.push(call);
        try {
          for await (const event of provider.stream(request)) {
            if (event.type === "text")
              call.text = String(call.text) + event.text;
            yield event;
          }
        } catch (error) {
          call.error = error instanceof Error ? error.name : "error";
          throw error;
        }
      },
    },
    config,
    clock,
  );
  let row: Record<string, unknown> = { ...test };
  try {
    store.saveSettings({
      ...store.settings(),
      autoExtract: test.autoExtract,
      proactiveEnabled: false,
      remoteDisclosureAcknowledged: true,
    });
    const run = h.submit(test.input, crypto.randomUUID());
    const admittedJobs = store.all("jobs");
    await h.waitForIdle(70000);
    row.run = store.require("runs", run.runId);
    row.contractTrace = store
      .traces(run.runId)
      .filter((t) => t.stage === "memory_reply");
    assert.equal(store.require("runs", run.runId).status, "completed");
    const answer = h
      .snapshot()
      .messages.filter((m) => m.runId === run.runId && m.role === "assistant")
      .map((m) => m.content)
      .join("\n");
    const context = h.context(run.runId) as {
      messages: { content: string }[];
      system: string;
      meta: unknown;
    };
    const state = JSON.parse(
      context.messages[0]!.content.split(">\n")[1]!.split("\n<")[0]!,
    );
    const diagnostics = memorySaveReplyDiagnostics(answer);
    shift += 2000;
    await h.tick();
    await h.waitForIdle(35000);
    const memories = store.byStatus("memories", ["pending", "active"]);
    row = {
      ...row,
      answer,
      diagnostics,
      admittedJobs,
      context,
      memories,
      jobs: store.all("jobs"),
    };
    assert.equal(
      state.memoryCapture?.saveIntent ?? "none",
      test.explicit ? "explicit" : "none",
    );
    assert.equal(
      admittedJobs.length,
      test.explicit || test.autoExtract ? 1 : 0,
    );
    assert(store.all("jobs").every((j) => j.status === "completed"));
    if (test.explicit) {
      assert(
        !Object.values(diagnostics).some(Boolean),
        "save_reply_workflow_violation",
      );
      assert(
        test.expected.every((k) => memories.some((m) => m.text.includes(k))),
        "missing_expected_candidate",
      );
      assert(
        memories.every(
          (m) => m.status === "pending" && m.certainty !== "confirmed",
        ),
      );
      assert(h.snapshot().candidateOffer, "missing_confirmation_ui");
    } else assert.equal(memories.length, 0);
    row.passed = true;
    report.passed++;
  } catch (error) {
    row = {
      ...row,
      passed: false,
      error: error instanceof Error ? error.message : "failed",
    };
    report.failed++;
  } finally {
    row.calls = calls;
    report.rows.push(row);
    persist();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${test.id}: ${row.passed ? "passed" : "failed"}`);
}
console.log(
  JSON.stringify({ passed: report.passed, failed: report.failed, out }),
);
if (report.failed) process.exitCode = 1;
