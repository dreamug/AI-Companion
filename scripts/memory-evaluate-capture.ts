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

// Paid, opt-in real-provider smoke. Each row uses a fresh disposable database;
// expected labels never enter the model. No writes to the trial or formal bots.
const raw = readFileSync(
  new URL("../tests/fixtures/memory-capture-natural-v1.json", import.meta.url),
  "utf8",
);
const fixture = JSON.parse(raw) as {
  provenance: string;
  cases: { id: string; input: string; expected: string[][] }[];
};
const out = resolve(
  process.env.MEMORY_EVAL_OUT ?? "test-results/memory-capture-natural-v1",
);
mkdirSync(out, { recursive: true, mode: 0o700 });
const rows: unknown[] = [];
const report = {
  provenance: fixture.provenance,
  fixtureHash: createHash("sha256").update(raw).digest("hex"),
  vectors: false,
  syntheticOnly: true,
  passed: 0,
  failed: 0,
  rows,
};
const persist = () =>
  writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
for (const test of fixture.cases) {
  const dir = mkdtempSync(join(tmpdir(), "memory-capture-natural-"));
  let shift = 0;
  const clock = { now: () => Date.now() + shift };
  const config = loadConfig({
    dataDir: dir,
    modelMode: "deepseek",
    memoryV2: true,
    memoryVectors: false,
    memorySummaries: false,
    trafficOrigin: "synthetic",
    maxOutputTokens: 700,
  });
  const store = new Store(dir, LOCAL_SCOPE);
  const h = new Harness(
    store,
    new ProviderModel(config, () => store.settings().model),
    config,
    clock,
  );
  const start = performance.now();
  let result: Record<string, unknown> = {
    id: test.id,
    input: test.input,
    expected: test.expected,
  };
  try {
    store.saveSettings({
      ...store.settings(),
      remoteDisclosureAcknowledged: true,
      proactiveEnabled: false,
    });
    const run = h.submit(test.input, crypto.randomUUID());
    await h.waitForIdle(70000);
    assert.equal(store.require("runs", run.runId).status, "completed");
    shift += 2000;
    await h.tick();
    await h.waitForIdle(35000);
    const jobs = store.all("jobs");
    const memories = store.byStatus("memories", ["pending", "active"]);
    const offer = h.snapshot().candidateOffer;
    const answer = h
      .snapshot()
      .messages.filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join("\n");
    const noMemoryNarration =
      !/(?:待确认|确认后.{0,8}(?:保存|存下)|记成|记为).{0,10}/u.test(answer);
    result = {
      ...result,
      answer,
      memories,
      offerKind: offer?.kind ?? null,
      jobs,
      elapsedMs: performance.now() - start,
      noMemoryNarration,
    };
    assert(
      jobs.every((j) => j.status === "completed"),
      "extraction_not_completed",
    );
    assert.equal(memories.length, test.expected.length, "candidate_count");
    assert(
      test.expected.every((keywords) =>
        memories.some((m) => keywords.every((k) => m.text.includes(k))),
      ),
      "candidate_keywords",
    );
    assert(
      memories.every(
        (m) =>
          m.status === "pending" &&
          m.sources.length === 1 &&
          m.sources[0]!.id === run.messageId,
      ),
      "not_pending_or_wrong_source",
    );
    assert.equal(
      Boolean(offer),
      Boolean(test.expected.length),
      "inline_confirmation",
    );
    assert(noMemoryNarration, "confirmation_narration_in_reply");
    report.passed++;
    result.passed = true;
  } catch (error) {
    report.failed++;
    result = {
      ...result,
      passed: false,
      error: error instanceof Error ? error.message : "failed",
    };
  } finally {
    rows.push(result);
    persist();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${test.id}: ${result.passed ? "passed" : "failed"}`);
}
console.log(
  JSON.stringify({ passed: report.passed, failed: report.failed, out }),
);
if (report.failed) process.exitCode = 1;
