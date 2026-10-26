import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { Store } from "../../src/store.js";
import { Harness } from "../../src/harness.js";
import { MockModel } from "../../src/model.js";
import { LOCAL_SCOPE } from "../../src/domain.js";
import { loadConfig } from "../../src/config.js";
import { writePrivateJson } from "../../src/files.js";

export type Fact = {
  id: string;
  text: string;
  bot: string;
  status: string;
  revision: number;
  validFrom?: string;
  validTo?: string;
  sourceValid?: boolean;
};
export type Query = {
  id: string;
  query: string;
  expected: string[];
  answer: string | null;
  kind: string;
  split: string;
  bot: string;
};
export type Dataset = { facts: Fact[]; queries: Query[]; at: string };
const root = resolve(process.env.MEMORY_LAB_OUT ?? "data/reports/memory-lab");
mkdirSync(root, { recursive: true, mode: 0o700 });
const raw = readFileSync(
  process.env.MEMORY_LAB_DATASET ?? "scripts/memory-lab/dataset.json",
  "utf8",
);
const data = JSON.parse(raw) as Dataset;
const dir = mkdtempSync(join(tmpdir(), "aic-memory-lab-"));
const config = loadConfig({ dataDir: dir, modelMode: "mock" });
const store = new Store(dir, LOCAL_SCOPE),
  h = new Harness(store, new MockModel(), config, {
    now: () => Date.parse(data.at),
  });
const keyById = new Map<string, string>();
const timings: number[] = [];
const hitLists: Record<string, string[]> = {};
const rewriteLists: Record<string, string[]> = {};
const rewritePath = join(root, "query-expansions.json");
type Expansions = {
  datasetSha256: string;
  items: Record<string, string[]>;
  batches: { elapsedMs: number; queries: number; usage: unknown }[];
};
let expansions: Expansions = {
  datasetSha256: createHash("sha256").update(raw).digest("hex"),
  items: {},
  batches: [],
};
if (process.argv.includes("--rewrite") && !config.apiKey)
  throw new Error("synthetic_rewrite_requires_configured_key");
if (process.argv.includes("--rewrite")) {
  try {
    const cached = JSON.parse(readFileSync(rewritePath, "utf8")) as Expansions;
    if (cached.datasetSha256 === expansions.datasetSha256) expansions = cached;
  } catch {}
  for (let i = 0; i < data.queries.length; i += 8) {
    const rows = data.queries
      .slice(i, i + 8)
      .filter((q) => !expansions.items[q.id]);
    if (!rows.length) continue;
    const started = performance.now();
    const r = await fetch(
      `${config.baseURL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-flash",
          temperature: 0,
          max_tokens: 1800,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                '把每个检索问题改写成最多5个短搜索词，包含原词和常见同义表达。仅根据问题，不猜答案、不添加未知的人名、日期、地点。输出JSON {"items":[{"id":"输入id","terms":["词"]}]}。',
            },
            {
              role: "user",
              content: JSON.stringify(
                rows.map((q) => ({ id: q.id, query: q.query })),
              ),
            },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!r.ok) throw new Error(`rewrite_http_${r.status}`);
    const body = (await r.json()) as {
      choices: { message: { content: string } }[];
      usage: unknown;
    };
    const parsed = JSON.parse(body.choices[0]!.message.content) as {
      items: { id: string; terms: string[] }[];
    };
    for (const row of rows) {
      const entry = parsed.items.find((x) => x.id === row.id);
      if (!entry || !Array.isArray(entry.terms)) throw Error("rewrite_invalid");
      expansions.items[row.id] = entry.terms
        .filter((t) => typeof t === "string" && t.length > 0 && t.length <= 40)
        .slice(0, 5);
    }
    expansions.batches.push({
      elapsedMs: performance.now() - started,
      queries: rows.length,
      usage: body.usage,
    });
    writePrivateJson(rewritePath, expansions);
    console.log(
      `rewrites ${Object.keys(expansions.items).length}/${data.queries.length}`,
    );
  }
}
try {
  for (const f of data.facts) {
    if (f.bot !== "a") continue;
    const memory = h.addMemory(
      {
        text: f.text,
        validFrom: f.validFrom ? Date.parse(f.validFrom) : undefined,
        validTo: f.validTo ? Date.parse(f.validTo) : undefined,
      },
      f.status === "pending",
    );
    keyById.set(memory.id, f.id);
    if (f.status === "deleted") h.forget([], [memory.id]);
    if (f.status === "superseded")
      store.put("memories", { ...memory, status: "superseded" });
    if (f.sourceValid === false) {
      const source = store.require("sources", memory.sources[0]!.id);
      store.put("sources", { ...source, revision: source.revision + 1 });
    }
  }
  for (const q of data.queries) {
    const start = performance.now();
    hitLists[q.id] = store
      .search(q.query, Date.parse(data.at), 5)
      .map((m) => keyById.get(m.id)!);
    timings.push(performance.now() - start);
    const scores = new Map<string, number>();
    for (const phrase of [q.query, ...(expansions.items[q.id] ?? [])])
      store.search(phrase, Date.parse(data.at), 20).forEach((m, i) => {
        const id = keyById.get(m.id)!;
        scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1));
      });
    rewriteLists[q.id] = [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map((x) => x[0]);
  }
  timings.sort((a, b) => a - b);
  writePrivateJson(join(root, "lexical.json"), {
    datasetSha256: expansions.datasetSha256,
    hitLists,
    rewriteLists,
    keywordMs: {
      p50: timings[Math.floor(timings.length * 0.5)],
      p95: timings[Math.floor(timings.length * 0.95)],
    },
    rewriteMeasured:
      Object.keys(expansions.items).length === data.queries.length,
  });
  console.log(
    JSON.stringify({
      keywordQueries: Object.keys(hitLists).length,
      rewrites: Object.keys(expansions.items).length,
    }),
  );
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
}
