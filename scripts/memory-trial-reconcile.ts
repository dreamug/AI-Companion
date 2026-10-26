import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { acquireInstance } from "../src/instance.js";
import { writePrivateJson } from "../src/files.js";
import { closeLifecycle } from "../src/memory/candidates.js";

// Deliberately restricted to the trial. Requires the trial service to be stopped.
// Old unhandled automatic candidates are replayed from their original sources;
// confirmed, deferred, edited, manual and discarded choices are preserved.
const dir = resolve(import.meta.dirname, "../local-data/memory-trial");
assert(existsSync(join(dir, "companion.sqlite")), "trial_database_missing");
assert.equal(realpathSync(dir), dir, "trial_path_must_not_be_symlink");
const release = acquireInstance(dir);
let store: Store | undefined;
try {
  store = new Store(dir, LOCAL_SCOPE);
  assert(store.hasMemoryV2, "trial_requires_v2");
  const backupDir = join(dir, "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, `pre-capture-fix-${randomUUID()}.sqlite`);
  store.db.prepare("VACUUM INTO ?").run(backup);
  chmodSync(backup, 0o600);
  const hash = (data: unknown) =>
    createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const preserved = () => ({
    messages: store!.all("messages").sort((a, b) => a.id.localeCompare(b.id)),
    confirmed: store!
      .all("memories")
      .filter((m) => m.certainty === "confirmed")
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  const beforeHash = hash(preserved());
  const old = store
    .byStatus("memories", ["pending"])
    .filter(
      (m) =>
        !m.manual &&
        !m.capturePolicy &&
        m.revision === 1 &&
        !m.lifecycleMetadata?.deferredCount &&
        !m.lifecycleMetadata?.lastDecision &&
        store!.sourcesValid(m.sources),
    );
  const jobs = store
    .all("jobs")
    .filter(
      (j) =>
        j.kind === "extract" &&
        j.status === "completed" &&
        store!.sourcesValid(j.sources) &&
        old.some((m) =>
          m.sources.every((ref) =>
            j.sources.some(
              (s) => s.id === ref.id && s.revision === ref.revision,
            ),
          ),
        ),
    );
  const replaced = old.filter((m) =>
    jobs.some((j) =>
      m.sources.every((ref) =>
        j.sources.some((s) => s.id === ref.id && s.revision === ref.revision),
      ),
    ),
  );
  store.tx("trial_capture_reconcile", () => {
    for (const memory of replaced)
      store!.put("memories", {
        ...memory,
        status: "superseded",
        revision: memory.revision + 1,
        lifecycleMetadata: closeLifecycle(memory, "replaced", Date.now()),
      });
    for (const job of jobs)
      store!.put("jobs", {
        ...job,
        status: "pending",
        attempts: 0,
        nextAt: Date.now(),
        reason: undefined,
      });
    const settings = store!.settings();
    if (
      replaced.some((m) => m.id === settings.memoryCandidateOffer?.candidateId)
    )
      store!.saveSettings({ ...settings, memoryCandidateOffer: undefined });
    store!.event(
      "memory.updated",
      {
        reason: "trial_capture_policy_replay",
        replaced: replaced.length,
        jobs: jobs.length,
      },
      Date.now(),
    );
  });
  assert.equal(
    hash(preserved()),
    beforeHash,
    "chat_or_confirmed_record_changed",
  );
  const report = {
    trialOnly: true,
    backup,
    replacedPending: replaced.length,
    requeuedSources: jobs.length,
    preservedContentHash: beforeHash,
    chatsAndConfirmedMemoriesUnchanged: true,
    vectorsEnabled: false,
  };
  writePrivateJson(join(dir, "capture-reconcile.json"), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  store?.close();
  release();
}
