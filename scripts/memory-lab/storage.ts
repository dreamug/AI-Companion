import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { writePrivateJson } from "../../src/files.js";
const out = resolve("data/reports/memory-lab");
const selection = JSON.parse(
  readFileSync(join(out, "frozen-selection.json"), "utf8"),
) as { method: string };
const [, selectedKey, selectedDimensions] = selection.method.split("-");
const key = process.argv[2] ?? selectedKey,
  dimensions = process.argv[3] ?? selectedDimensions;
const dim = Number(dimensions);
const payload = JSON.parse(
  readFileSync(join(out, `${key}-vectors.json`), "utf8"),
) as { facts: number[][]; queries: number[][] };
const normalize = (a: number[]) => {
  const n = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  return new Float32Array(a.map((v) => v / n));
};
const vectors = payload.facts.map((a) => normalize(a.slice(0, dim))),
  query = normalize(payload.queries[0]!.slice(0, dim));
const extension = execFileSync(
  resolve(".venv-memory-lab/bin/python"),
  ["-c", "import sqlite_vec; print(sqlite_vec.loadable_path())"],
  { encoding: "utf8" },
).trim();
const blob = Buffer.from(query.buffer);
function timed<T>(fn: () => T, n = 25) {
  for (let i = 0; i < 3; i++) fn();
  const values: number[] = [];
  let result: T | undefined;
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    result = fn();
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return {
    stats: {
      p50: values[Math.floor(n * 0.5)],
      p95: values[Math.floor(n * 0.95)],
      n,
    },
    result,
  };
}
const results = [];
for (const count of [100, 1000, 10000, 50000]) {
  const dir = mkdtempSync(join(tmpdir(), "aic-memory-storage-")),
    path = join(dir, "vectors.sqlite"),
    db = new Database(path);
  try {
    db.loadExtension(extension);
    db.exec(
      `CREATE TABLE vectors(id INTEGER PRIMARY KEY,bot TEXT,v BLOB); CREATE VIRTUAL TABLE knn USING vec0(embedding float[${dim}] distance_metric=cosine,bot text partition key)`,
    );
    const insert = db.prepare("INSERT INTO vectors VALUES(?,?,?)"),
      insertKnn = db.prepare(
        "INSERT INTO knn(rowid,embedding,bot) VALUES(?,?,?)",
      );
    const matrix = new Float32Array(count * dim);
    let seed = 74621;
    for (let i = 0; i < count; i++) {
      const v = vectors[i % vectors.length]!;
      let n = 0;
      for (let j = 0; j < dim; j++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        const x = v[j]! + (seed / 2 ** 32 - 0.5) * 0.001;
        matrix[i * dim + j] = x;
        n += x * x;
      }
      n = Math.sqrt(n);
      for (let j = 0; j < dim; j++)
        matrix[i * dim + j] = matrix[i * dim + j]! / n;
    }
    let begin = performance.now();
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const b = Buffer.from(matrix.buffer, i * dim * 4, dim * 4),
          bot = i % 2 === 0 ? "a" : "b";
        insert.run(i, bot, b);
        insertKnn.run(BigInt(i), b, bot);
      }
    })();
    const buildMs = performance.now() - begin;
    const scalar = db.prepare(
      "SELECT id,vec_distance_cosine(v,?) distance FROM vectors WHERE bot='a' ORDER BY distance,id LIMIT 5",
    );
    const knn = db.prepare(
      "SELECT rowid id,distance FROM knn WHERE embedding MATCH ? AND k=5 AND bot='a' ORDER BY distance",
    );
    function scan(values: Float32Array, step: number) {
      let best: { id: number; score: number }[] = [];
      for (let i = 0; i < values.length / dim; i += step) {
        let score = 0;
        for (let j = 0; j < dim; j++) score += values[i * dim + j]! * query[j]!;
        if (best.length < 5 || score > best[best.length - 1]!.score) {
          best.push({ id: i, score });
          best.sort((a, b) => b.score - a.score);
          best = best.slice(0, 5);
        }
      }
      return best;
    }
    const load = db.prepare("SELECT id,v FROM vectors WHERE bot='a'");
    const a = timed(() => scalar.all(blob) as { id: number }[]),
      b = timed(() => knn.all(blob) as { id: number }[]),
      c = timed(() => scan(matrix, 2));
    const d = timed(() => {
      const rows = load.all() as { id: number; v: Buffer }[];
      const packed = Buffer.concat(rows.map((r) => r.v));
      const copy = new Float32Array(rows.length * dim);
      Buffer.from(copy.buffer).set(packed);
      return scan(copy, 1);
    });
    results.push({
      totalRows: count,
      rowsInSelectedBot: count / 2,
      dimensions: dim,
      sqliteVersion: (
        db.prepare("SELECT sqlite_version() v").get() as { v: string }
      ).v,
      sqliteVecVersion: (
        db.prepare("SELECT vec_version() v").get() as { v: string }
      ).v,
      buildTwoTablesMs: buildMs,
      twoTablesDiskMiB: statSync(path).size / 2 ** 20,
      residentAllBotsMatrixMiB: matrix.byteLength / 2 ** 20,
      methods: {
        sqliteScalarExact: a.stats,
        sqliteVec0Exact: b.stats,
        nodeResidentExact: c.stats,
        sqliteReadNodeExact: d.stats,
      },
      top5ExactAgreement:
        a.result!.map((r) => r.id).join(",") ===
        b.result!.map((r) => r.id).join(","),
    });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
writePrivateJson(
  join(
    out,
    process.argv[2] ? `storage-${key}-results.json` : "storage-results.json",
  ),
  {
    scope:
      "synthetic repeated and jittered actual embeddings, performance only; no private memory",
    results,
  },
);
