import { readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Store } from "../../src/store.js";
import { Harness } from "../../src/harness.js";
import { MockModel } from "../../src/model.js";
import { LOCAL_SCOPE, tokenEstimate, type Memory } from "../../src/domain.js";
import { loadConfig } from "../../src/config.js";
import { writePrivateJson } from "../../src/files.js";
import type { Dataset } from "./lexical.js";
const original = JSON.parse(
  readFileSync("scripts/memory-lab/dataset.json", "utf8"),
) as Dataset;
const out = resolve("data/reports/memory-lab/small");
mkdirSync(out, { recursive: true, mode: 0o700 });
const eligible = original.facts
  .filter(
    (f) =>
      !f.id.startsWith("distractor-") &&
      f.bot === "a" &&
      f.status === "active" &&
      !f.validTo &&
      !f.validFrom &&
      f.sourceValid !== false,
  )
  .slice(0, 8);
const ids = new Set(eligible.map((f) => f.id));
const facts = [
  ...eligible,
  ...original.facts.filter((f) => f.id.startsWith("distractor-")).slice(0, 2),
];
const queries = original.queries
  .filter(
    (q) =>
      ids.has(q.id.split("-")[0]!) && ["natural", "unknown"].includes(q.kind),
  )
  .map((q) => ({ ...q, split: "test" }));
const data = {
  ...original,
  facts,
  queries,
  protocol: {
    scope: "10-fact small-memory alternative; no vectors",
    candidate:
      "all valid confirmed facts if entire projection fits current 2000-token budget",
  },
};
const path = resolve("scripts/memory-lab/dataset-small.json");
writePrivateJson(path, data);
const budgets = [];
const project = (m: Memory) => ({
  id: m.id,
  text: m.text,
  kind: m.kind,
  certainty: m.certainty,
  sources: m.sources,
  day: m.day,
  occurredAt: m.occurredAt,
  learnedAt: m.createdAt,
  validFrom: m.validFrom,
  validTo: m.validTo,
});
for (const n of [10, 20, 50, 200, 1000]) {
  const dir = mkdtempSync(join(tmpdir(), "aic-memory-small-")),
    config = loadConfig({ dataDir: dir, modelMode: "mock" });
  const store = new Store(dir, LOCAL_SCOPE),
    h = new Harness(store, new MockModel(), config, {
      now: () => Date.parse(original.at),
    });
  try {
    const memories = [];
    for (let i = 0; i < n; i++)
      memories.push(h.addMemory({ text: facts[i % facts.length]!.text }));
    const estimate = tokenEstimate(
      JSON.stringify([]) + JSON.stringify(memories.map(project)),
    );
    budgets.push({
      records: n,
      estimatedProjectedTokens: estimate,
      budget: 2000,
      fitsWithoutTrimming: estimate <= 2000,
    });
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const lists = Object.fromEntries(
  queries.map((q) => [q.id, facts.map((f) => f.id)]),
);
writePrivateJson(join(out, "full-memory-lists.json"), {
  datasetSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  rankings: { "full-memory": lists },
  budgets,
});
console.log(
  JSON.stringify({ facts: facts.length, queries: queries.length, budgets }),
);
