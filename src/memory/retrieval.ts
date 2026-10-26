import {
  projectCompanionText,
  companionVisibleMessage,
} from "./companion-v3.js";
import { memoryQuery } from "./query.js";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { DomainError, tokenEstimate, dayKey, type Memory } from "../domain.js";
import type { Store } from "../store.js";
import {
  eligibleFact,
  validMemory,
  inDomain,
  readFacts,
  projectMemory,
  type FactRead,
} from "./reading.js";
import {
  evidenceValid,
  textHash,
  utf16Boundary,
  resolveEvidence,
} from "./evidence.js";
import { readConversations } from "./conversations.js";
import { memoryChunks, excerpt } from "./chunks.js";
import {
  validateVector,
  validatePackedVector,
  type EmbeddingPort,
} from "./embedding.js";

export type MemoryTarget = "facts" | "conversation" | "episodes";
const scopeKey = (store: Store) => JSON.stringify(store.scope);
const fingerprint = (m: Memory) =>
  textHash(
    JSON.stringify([
      m.id,
      m.revision,
      m.text,
      m.sources,
      m.realityScope,
      m.validFrom,
      m.validTo,
    ]),
  );
class Scan {
  private worker = new Worker(new URL("scan-worker.mjs", import.meta.url));
  private pending = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      cleanup: () => void;
    }
  >();
  constructor() {
    this.worker.unref();
    this.worker.on("message", (r) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      p.cleanup();
      if (r.error) p.reject(new DomainError("scan_failed", 503));
      else p.resolve(r);
    });
    this.worker.on("error", () => this.fail("scan_failed"));
  }
  request(
    data: Record<string, unknown>,
    transfer: ArrayBuffer[] = [],
    timeoutMs = 250,
    signal?: AbortSignal,
  ) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DomainError("cancelled", 409));
        return;
      }
      const id = randomUUID(),
        abort = () => {
          this.pending.delete(id);
          cleanup();
          reject(new DomainError("cancelled", 409));
        };
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          cleanup();
          reject(new DomainError("scan_timeout", 503));
        },
        Math.max(1, timeoutMs),
      );
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      this.worker.postMessage({ id, ...data }, transfer);
    });
  }
  private fail(code: string) {
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(new DomainError(code, 503));
    }
    this.pending.clear();
  }
  close() {
    this.fail("cancelled");
    void this.worker.terminate();
  }
}
export class MemoryRetrieval {
  private scan?: Scan;
  private reads = new Set<AbortController>();
  private loaded = -1;
  private indexRows: {
    id: string;
    memoryId: string;
    revision: number;
    hash: string;
    start: number;
    end: number;
    signature: string;
  }[] = [];
  private loadTask?: { generation: number; promise: Promise<void> };
  private loadToken = 0;
  private indexLoadSerial = 0;
  private indexLookup = new Map<string, (typeof this.indexRows)[number]>();
  private async loadIndex(generation: number) {
    const token = this.loadToken,
      serial = ++this.indexLoadSerial,
      epoch = this.store.settings().epoch;
    // Set the caller deadline before any cold-cache I/O. Every page yields.
    await new Promise<void>((r) => setImmediate(r));
    const check = () => {
      if (token !== this.loadToken || serial !== this.indexLoadSerial)
        throw new DomainError("cancelled", 409);
    };
    check();
    const args = [
      this.store.scope.ownerUserId,
      this.store.scope.relationshipId,
      this.embedding!.modelKey,
    ];
    const { n } = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM memory_embeddings WHERE owner=? AND relationship=? AND modelKey=?",
      )
      .get(...args) as { n: number };
    const matrix = new Float32Array(n * 384),
      indexRows: typeof this.indexRows = [];
    const page = this.store.db.prepare(
      "SELECT memoryId,memoryRevision,chunkId,textHash,spanStartUtf16,spanEndUtf16,sourceFingerprint,vector FROM memory_embeddings WHERE owner=? AND relationship=? AND modelKey=? AND (memoryId,chunkId)>(?,?) ORDER BY memoryId,chunkId LIMIT 128",
    );
    let afterId = "",
      afterChunk = "";
    while (true) {
      check();
      const rows = page.all(...args, afterId, afterChunk) as {
        memoryId: string;
        memoryRevision: number;
        chunkId: string;
        textHash: string;
        spanStartUtf16: number;
        spanEndUtf16: number;
        sourceFingerprint: string;
        vector: Buffer;
      }[];
      for (const row of rows) {
        if (indexRows.length >= n)
          throw new DomainError("index_snapshot_changed", 503);
        const bytes = row.vector,
          buffer = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes),
          vector = new Float32Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength / 4,
          );
        validatePackedVector(vector);
        matrix.set(vector, indexRows.length * 384);
        indexRows.push({
          id: `${row.memoryId}/${row.chunkId}`,
          memoryId: row.memoryId,
          revision: row.memoryRevision,
          hash: row.textHash,
          start: row.spanStartUtf16,
          end: row.spanEndUtf16,
          signature: row.sourceFingerprint,
        });
      }
      if (rows.length < 128) break;
      const last = rows.at(-1)!;
      afterId = last.memoryId;
      afterChunk = last.chunkId;
      await new Promise<void>((r) => setImmediate(r));
    }
    check();
    if (indexRows.length !== n)
      throw new DomainError("index_snapshot_changed", 503);
    this.scan ??= new Scan();
    const scan = this.scan;
    await scan.request(
      {
        kind: "load",
        scope: scopeKey(this.store),
        generation,
        ids: indexRows.map((r) => r.id),
        matrix: matrix.buffer,
      },
      [matrix.buffer],
      5000,
    );
    if (
      token !== this.loadToken ||
      serial !== this.indexLoadSerial ||
      this.scan !== scan ||
      this.store.settings().epoch !== epoch
    )
      throw new DomainError("cancelled", 409);
    if (this.store.memoryState().indexVersion !== generation)
      throw new DomainError("index_snapshot_changed", 503);
    this.indexRows = indexRows;
    this.indexLookup = new Map(indexRows.map((r) => [r.id, r]));
    this.loaded = generation;
  }
  private indexSnapshot(generation: number) {
    if (!this.loadTask || this.loadTask.generation !== generation) {
      const task = { generation, promise: this.loadIndex(generation) };
      this.loadTask = task;
      void task.promise.then(
        () => {
          if (this.loadTask === task) this.loadTask = undefined;
        },
        () => {
          if (this.loadTask === task) this.loadTask = undefined;
        },
      );
    }
    return this.loadTask.promise;
  }
  private indexCount?: { generation: number; count: number };
  private largeIndex(generation: number) {
    if (this.indexCount?.generation !== generation) {
      const row = this.store.db
        .prepare(
          "SELECT count(*) AS n FROM memory_embeddings WHERE owner=? AND relationship=? AND modelKey=?",
        )
        .get(
          this.store.scope.ownerUserId,
          this.store.scope.relationshipId,
          this.embedding!.modelKey,
        ) as { n: number };
      this.indexCount = { generation, count: row.n };
    }
    return this.indexCount.count > 4096;
  }
  private waitSnapshot<T>(
    promise: Promise<T>,
    timeout: number,
    signal: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        },
        abort = () => {
          cleanup();
          reject(new DomainError("cancelled", 409));
        },
        timer = setTimeout(
          () => {
            cleanup();
            reject(new DomainError("retrieval_timeout", 503));
          },
          Math.max(1, timeout),
        );
      timer.unref();
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (e) => {
          cleanup();
          reject(e);
        },
      );
    });
  }
  private pool?: {
    key: string;
    at: number;
    until: number;
    values: Map<string, Memory>;
    signatures: Map<string, string>;
    sequences: Map<string, number>;
    proofVersion: number;
    proven: Map<string, Memory>;
  };
  private poolTask?: {
    key: string;
    at: number;
    promise: Promise<NonNullable<MemoryRetrieval["pool"]>>;
  };
  private async buildPool(
    now: number,
    domain: "reality" | "roleplay",
    strict: boolean,
    key: string,
  ) {
    const token = this.loadToken,
      version = this.store.memoryState().memoryVersion;
    await new Promise<void>((r) => setImmediate(r));
    const check = () => {
      if (token !== this.loadToken) throw new DomainError("cancelled", 409);
      if (version !== this.store.memoryState().memoryVersion)
        throw new DomainError("memory_snapshot_changed", 409);
    };
    check();
    const values = new Map<string, Memory>(),
      signatures = new Map<string, string>(),
      sequences = new Map<string, number>(),
      sourceSeq = new Map<string, number>();
    for (const m of this.store.qualifiedFacts(now, Infinity, domain, strict)) {
      values.set(m.id, m);
      signatures.set(m.id, fingerprint(m));
      let max = 0;
      for (const ref of m.sources) {
        let seq = sourceSeq.get(ref.id);
        if (seq === undefined) {
          const msg = this.store.get("messages", ref.id);
          seq = msg
            ? Number(this.store.get("runs", msg.runId)?.config.enqueueSeq ?? 0)
            : 0;
          sourceSeq.set(ref.id, seq);
        }
        max = Math.max(max, seq);
      }
      sequences.set(m.id, max);
      if (values.size % 64 === 0) {
        await new Promise<void>((r) => setImmediate(r));
        check();
      }
    }
    const args = [
      this.store.scope.ownerUserId,
      this.store.scope.relationshipId,
    ];
    const next = this.store.db
      .prepare(
        `SELECT MIN(MIN(CASE WHEN json_extract(data,'$.validFrom')>? THEN json_extract(data,'$.validFrom') ELSE 1e308 END,CASE WHEN json_extract(data,'$.validTo')>? THEN json_extract(data,'$.validTo') ELSE 1e308 END,CASE WHEN json_extract(data,'$.expiresAt')>? THEN json_extract(data,'$.expiresAt') ELSE 1e308 END)) AS at FROM memories WHERE owner=? AND relationship=?`,
      )
      .get(now, now, now, ...args) as { at: number | null };
    check();
    return {
      key,
      at: now,
      until: next.at ?? Infinity,
      values,
      signatures,
      sequences,
      proofVersion: -1,
      proven: new Map<string, Memory>(),
    };
  }
  private async eligiblePool(
    now: number,
    cutoff: number,
    domain: "reality" | "roleplay" | undefined,
    strict: boolean,
  ) {
    const requested =
        domain ??
        (this.store.settings().persona.memoryScope === "roleplay"
          ? "roleplay"
          : "reality"),
      state = this.store.memoryState(),
      key = JSON.stringify([state.memoryVersion, requested, strict]);
    let pool = this.pool;
    if (!pool || pool.key !== key || now < pool.at || now >= pool.until) {
      if (
        !this.poolTask ||
        this.poolTask.key !== key ||
        now < this.poolTask.at
      ) {
        const task = {
          key,
          at: now,
          promise: this.buildPool(now, requested, strict, key),
        };
        this.poolTask = task;
        void task.promise.then(
          (value) => {
            if (this.poolTask === task) {
              this.pool = value;
              this.poolTask = undefined;
            }
          },
          () => {
            if (this.poolTask === task) this.poolTask = undefined;
          },
        );
      }
      pool = await this.poolTask.promise;
    }
    const token = this.loadToken;
    if (pool.proofVersion !== state.contextVersion) {
      const proven = new Map<string, Memory>();
      let count = 0;
      for (const [id, m] of pool.values) {
        if (!m.evidence || evidenceValid(this.store, m.evidence))
          proven.set(id, m);
        if (++count % 128 === 0) {
          await new Promise<void>((r) => setImmediate(r));
          if (token !== this.loadToken) throw new DomainError("cancelled", 409);
        }
      }
      if (this.store.memoryState().contextVersion !== state.contextVersion)
        throw new DomainError("proof_snapshot_changed", 503);
      pool.proven = proven;
      pool.proofVersion = state.contextVersion;
    }
    return {
      allowed: Number.isFinite(cutoff)
        ? new Map(
            [...pool.proven].filter(
              ([id]) => pool.sequences.get(id)! <= cutoff,
            ),
          )
        : pool.proven,
      signatures: pool.signatures,
    };
  }
  private cachedKeywords(
    query: string,
    now: number,
    cutoff: number,
    domain?: "reality" | "roleplay",
  ) {
    const pool = this.pool;
    if (!pool) return;
    const state = this.store.memoryState(),
      requested =
        domain ??
        (this.store.settings().persona.memoryScope === "roleplay"
          ? "roleplay"
          : "reality"),
      key = JSON.stringify([
        state.memoryVersion,
        requested,
        /(?:现实|线下|真实).{0,10}(?:经历|履历|发生)/u.test(query),
      ]);
    if (
      pool.key !== key ||
      pool.proofVersion !== state.contextVersion ||
      now < pool.at ||
      now >= pool.until
    )
      return;
    const q = query.trim().slice(0, 100),
      aliases = memoryQuery(q).keywords,
      pairs = [
        ...new Set([...q.matchAll(/[\u3400-\u9fff]{2}/gu)].map((m) => m[0])),
      ];
    if (!q) return [];
    const best: { m: Memory; score: number }[] = [];
    for (const m of pool.proven.values()) {
      if (pool.sequences.get(m.id)! > cutoff) continue;
      const literal = m.text.includes(q);
      let pair = 0,
        alias = 0;
      for (const term of pairs) if (m.text.includes(term)) pair++;
      for (const term of aliases) if (m.text.includes(term)) alias++;
      if (!literal && !pair && !alias) continue;
      const score =
          100 * Number(literal) + pair + alias * 2 + Number(m.pinned) * 2,
        last = best[best.length - 1];
      if (
        best.length === 5 &&
        (score < last!.score ||
          (score === last!.score && m.id.localeCompare(last!.m.id) >= 0))
      )
        continue;
      let at = 0;
      while (
        at < best.length &&
        (score < best[at]!.score ||
          (score === best[at]!.score &&
            m.id.localeCompare(best[at]!.m.id) >= 0))
      )
        at++;
      if (at < 5) {
        best.splice(at, 0, { m, score });
        if (best.length > 5) best.pop();
      }
    }
    return best.map((v) => v.m);
  }
  constructor(
    readonly store: Store,
    readonly embedding?: EmbeddingPort,
    private clockNow: () => number = Date.now,
  ) {}
  async prewarm(now: number) {
    if (!this.embedding || !this.store.memoryEnabled) return;
    this.embedding.warm();
    const generation = this.store.memoryState().indexVersion;
    await Promise.all([
      this.loaded === generation
        ? Promise.resolve()
        : this.indexSnapshot(generation),
      this.eligiblePool(now, Infinity, undefined, false),
    ]);
  }
  shouldWarm(now: number) {
    return (
      this.store.memoryEnabled &&
      readFacts(this.store, "", now).factTokensAtLeast >= 1500
    );
  }
  diagnostic() {
    const enabled = Boolean(this.embedding),
      s = this.store.hasMemoryV2
        ? this.store.db
            .prepare(
              "SELECT status,count(*) AS count FROM memory_index_state WHERE owner=? AND relationship=? GROUP BY status",
            )
            .all(this.store.scope.ownerUserId, this.store.scope.relationshipId)
        : [];
    return { enabled, ready: this.embedding?.ready ?? false, index: s };
  }
  async indexOne(signal: AbortSignal, now: number) {
    const embedding = this.embedding;
    if (!embedding || !this.store.memoryEnabled) return false;
    if (!embedding.ready) {
      embedding.warm();
      return false;
    }
    const args = [
      this.store.scope.ownerUserId,
      this.store.scope.relationshipId,
    ];
    let found: Memory | undefined;
    for (const m of this.store.qualifiedFacts(
      now,
      Infinity,
      undefined,
      false,
      embedding.modelKey,
    )) {
      if (!m.evidence || evidenceValid(this.store, m.evidence)) {
        found = m;
        break;
      }
    }
    if (!found) return false;
    const epoch = this.store.settings().epoch,
      signature = fingerprint(found),
      chunks = memoryChunks(found.text);
    this.store.db
      .prepare(
        "INSERT INTO memory_index_state VALUES(?,?,?,?,?,'dirty',0,0,NULL) ON CONFLICT(owner,relationship,memoryId,modelKey) DO UPDATE SET wantedRevision=excluded.wantedRevision,status='dirty'",
      )
      .run(...args, found.id, found.revision, embedding.modelKey);
    const vectors: number[][] = [];
    try {
      for (const chunk of chunks) {
        if (signal.aborted) throw new DomainError("cancelled", 409);
        vectors.push(
          validateVector(
            await embedding.encode(
              chunk.text,
              "passage",
              scopeKey(this.store),
              signal,
              5000,
            ),
          ),
        );
      }
      const current = this.store.get("memories", found.id);
      if (
        signal.aborted ||
        this.store.settings().epoch !== epoch ||
        !current ||
        fingerprint(current) !== signature ||
        !eligibleFact(this.store, current, Math.max(now, this.clockNow()))
      )
        return false;
      this.store.tx("memory_index", () => {
        const m = this.store.require("memories", found.id);
        if (
          fingerprint(m) !== signature ||
          !eligibleFact(this.store, m, Math.max(now, this.clockNow()))
        )
          throw new DomainError("stale_source", 409);
        this.store.db
          .prepare(
            "DELETE FROM memory_embeddings WHERE owner=? AND relationship=? AND memoryId=?",
          )
          .run(...args, m.id);
        const insert = this.store.db.prepare(
          "INSERT INTO memory_embeddings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        chunks.forEach((chunk, i) =>
          insert.run(
            ...args,
            m.id,
            m.revision,
            String(i),
            chunk.start,
            chunk.end,
            chunk.hash,
            signature,
            embedding.modelKey,
            384,
            Buffer.from(new Float32Array(vectors[i]!).buffer),
            now,
          ),
        );
        this.store.db
          .prepare(
            "UPDATE memory_index_state SET status='ready',attempts=0,reason=NULL WHERE owner=? AND relationship=? AND memoryId=? AND modelKey=?",
          )
          .run(...args, m.id, embedding.modelKey);
        this.store.bumpMemoryVersion("indexVersion");
      });
      return true;
    } catch (error) {
      if (!signal.aborted)
        this.store.db
          .prepare(
            "UPDATE memory_index_state SET status='failed',attempts=attempts+1,nextAt=?,reason='encoding_failed' WHERE owner=? AND relationship=? AND memoryId=? AND modelKey=?",
          )
          .run(now + 30000, ...args, found.id, embedding.modelKey);
      if (signal.aborted) throw error;
      return false;
    }
  }
  async facts(
    query: string,
    now: number,
    cutoff = Infinity,
    budget = 2000,
    domain?: "reality" | "roleplay",
    signal: AbortSignal = new AbortController().signal,
  ): Promise<FactRead> {
    const controller = new AbortController();
    this.reads.add(controller);
    const version = this.store.memoryState().memoryVersion,
      epoch = this.store.settings().epoch;
    try {
      const result = await this.readFactsInner(
        query,
        now,
        cutoff,
        budget,
        domain,
        AbortSignal.any([signal, controller.signal]),
      );
      if (
        signal.aborted ||
        controller.signal.aborted ||
        epoch !== this.store.settings().epoch
      )
        throw new DomainError("cancelled", 409);
      if (version !== this.store.memoryState().memoryVersion)
        throw new DomainError("memory_snapshot_changed", 409);
      const current = Math.max(now, this.clockNow());
      if (
        result.selected.some(
          (m) => !eligibleFact(this.store, m, current, cutoff),
        )
      )
        return readFacts(this.store, query, current, cutoff, budget, domain);
      return result;
    } finally {
      controller.abort(); // Release any concurrent encoder after snapshot failure.
      this.reads.delete(controller);
    }
  }
  private async readFactsInner(
    query: string,
    now: number,
    cutoff = Infinity,
    budget = 2000,
    domain?: "reality" | "roleplay",
    signal: AbortSignal = new AbortController().signal,
  ): Promise<FactRead> {
    const start = performance.now(),
      base = readFacts(
        this.store,
        query,
        now,
        cutoff,
        budget,
        domain,
        false,
        this.cachedKeywords(query, now, cutoff, domain),
      );
    if (signal.aborted) throw new DomainError("cancelled", 409);
    if (
      base.routeState === "all" ||
      !this.embedding ||
      !this.store.memoryEnabled
    )
      return base;
    if (!this.embedding.ready) {
      this.embedding.warm();
      return { ...base, reasons: ["embedding_not_ready"] };
    }
    const before = this.store.settings().epoch,
      memoryVersion = this.store.memoryState().memoryVersion;
    try {
      const remaining = () => Math.max(1, 220 - (performance.now() - start));
      // Encode while cold snapshots load; both share the original deadline.
      // Settled wrapping observes an early encoder rejection before snapshots finish.
      const encoded = this.embedding
        .encode(
          memoryQuery(query).embeddingText,
          "query",
          scopeKey(this.store),
          signal,
          remaining(),
        )
        .then(
          (vector) => ({ vector }),
          (error) => ({ error }),
        );
      const generation = this.store.memoryState().indexVersion,
        readNow = Math.max(now, this.clockNow());
      // Large cold snapshots get a short foreground wait, then continue warming.
      // The caller receives explicit keyword/loading coverage, never fake readiness.
      const large = this.largeIndex(generation),
        snapshots = Promise.all([
          this.loaded === generation
            ? Promise.resolve()
            : this.indexSnapshot(generation),
          this.eligiblePool(
            readNow,
            cutoff,
            domain,
            /(?:现实|线下|真实).{0,10}(?:经历|履历|发生)/u.test(query),
          ),
        ]);
      let snapshot: Awaited<typeof snapshots>;
      try {
        snapshot = await this.waitSnapshot(
          snapshots,
          Math.min(large ? 25 : 220, remaining()),
          signal,
        );
      } catch (error) {
        if (
          large &&
          error instanceof DomainError &&
          error.code === "retrieval_timeout"
        )
          throw new DomainError("memory_snapshot_loading", 503);
        throw error;
      }
      const { allowed, signatures } = snapshot[1];
      const encoding = await encoded;
      if ("error" in encoding) throw encoding.error;
      const vector = encoding.vector;
      if (signal.aborted || this.store.settings().epoch !== before)
        throw new DomainError("cancelled", 409);
      if (this.store.memoryState().memoryVersion !== memoryVersion)
        throw new DomainError("memory_snapshot_changed", 409);
      const indexed = new Set<string>();
      const mask = new Uint8Array(Math.ceil(this.indexRows.length / 8));
      this.indexRows.forEach((r, i) => {
        if (
          allowed.get(r.memoryId)?.revision === r.revision &&
          signatures.get(r.memoryId) === r.signature
        ) {
          mask[i >> 3]! |= 1 << (i & 7);
          indexed.add(r.memoryId);
        }
      });
      this.scan ??= new Scan();
      const result = await this.scan.request(
        {
          kind: "query",
          scope: scopeKey(this.store),
          generation,
          mask: mask.buffer,
          vector: new Float32Array(vector).buffer,
        },
        [],
        remaining(),
        signal,
      );
      if (
        result.generation !== generation ||
        result.scope !== scopeKey(this.store)
      )
        throw new DomainError("scan_response_mismatch", 503);
      if (signal.aborted || this.store.settings().epoch !== before)
        throw new DomainError("cancelled", 409);
      if (performance.now() - start > 250)
        return { ...base, reasons: ["retrieval_timeout"] };
      if (this.store.memoryState().memoryVersion !== memoryVersion)
        throw new DomainError("memory_snapshot_changed", 409);
      const hits = result.hits as { id: string; score: number }[];
      const semantic = hits.flatMap((h) => {
        const row = this.indexLookup.get(h.id),
          m = row && this.store.get("memories", row.memoryId);
        return m &&
          row &&
          m.revision === row.revision &&
          fingerprint(m) === row.signature &&
          textHash(m.text.slice(row.start, row.end)) === row.hash &&
          eligibleFact(this.store, m, Math.max(now, this.clockNow()), cutoff)
          ? [m]
          : [];
      });
      const lexical = base.keywordIds
        .map((id) => this.store.get("memories", id))
        .filter((m): m is Memory => !!m && allowed.has(m.id));
      const delta = [...allowed.values()]
        .filter((m) => !indexed.has(m.id))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 8);
      const scores = new Map<string, number>();
      for (const [rows, weight] of [
        [semantic, 1],
        [lexical, 0.35],
      ] as const) {
        const unique = [...new Map(rows.map((m) => [m.id, m])).values()];
        unique.forEach((m, i) =>
          scores.set(m.id, (scores.get(m.id) ?? 0) + weight / (60 + i + 1)),
        );
      }
      const normalize = (s: string) =>
        s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
      const q = normalize(query);
      const literal = (m: Memory) =>
        [...q].length >= 2 && normalize(m.text).includes(q);
      const selected = [
        ...new Map(
          [...semantic, ...lexical, ...delta, ...base.selected]
            .filter((m) => allowed.has(m.id))
            .map((m) => [m.id, m]),
        ).values(),
      ]
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            Number(literal(b)) - Number(literal(a)) ||
            (literal(a) && literal(b)
              ? (lexical.findIndex((m) => m.id === a.id) < 0
                  ? 999
                  : lexical.findIndex((m) => m.id === a.id)) -
                (lexical.findIndex((m) => m.id === b.id) < 0
                  ? 999
                  : lexical.findIndex((m) => m.id === b.id))
              : 0) ||
            (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 5)
        .map((m) => {
          const hit = hits
            .map((h) => this.indexLookup.get(h.id))
            .find((r) => r?.memoryId === m.id);
          const e = excerpt(m.text, query, 700, hit);
          return {
            ...m,
            text: e.text,
            excerpt: e.partial,
            excerptSpan: e.partial
              ? { startUtf16: e.start!, endUtf16: e.end! }
              : undefined,
          };
        });
      while (
        selected.length &&
        tokenEstimate(JSON.stringify(selected.map(projectMemory))) > budget
      )
        selected.pop();
      const coverage = allowed.size ? indexed.size / allowed.size : 1;
      return {
        ...base,
        selected,
        diagnostic: {
          semanticIds: semantic.map((m) => m.id),
          keywordIds: lexical.map((m) => m.id),
          deltaIds: delta.map((m) => m.id),
        },
        mode: "hybrid",
        state: coverage === 1 ? "ok" : "degraded",
        reasons: coverage === 1 ? [] : ["partial_index"],
        allEligibleFactsIncluded: false,
      };
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof DomainError &&
          ["cancelled", "memory_snapshot_changed"].includes(error.code))
      )
        throw error;
      return {
        ...base,
        reasons: [
          error instanceof DomainError ? error.code : "semantic_unavailable",
        ],
      };
    }
  }
  async search(
    query: string,
    target: MemoryTarget,
    now: number,
    cutoff = Infinity,
    signal?: AbortSignal,
    page?: { cursor?: string; limit?: number },
    domain?: "reality" | "roleplay",
  ) {
    if (
      target === "facts" &&
      (page?.cursor || page?.limit || /全部|所有|列出|一共/u.test(query))
    ) {
      const state = this.store.memoryState(),
        epoch = this.store.settings().epoch;
      let after = "";
      if (page?.cursor) {
        try {
          const cursor = JSON.parse(
            Buffer.from(page.cursor, "base64url").toString(),
          );
          if (
            cursor.scope !== scopeKey(this.store) ||
            cursor.version !== state.memoryVersion ||
            cursor.epoch !== epoch ||
            typeof cursor.after !== "string"
          )
            throw Error();
          after = cursor.after;
        } catch {
          throw new DomainError("memory_cursor_invalidated", 409);
        }
      }
      const limit = Math.min(20, Math.max(1, page?.limit ?? 10)),
        items: ReturnType<typeof projectMemory>[] = [],
        omitted: string[] = [];
      let hasMore = false,
        last = after;
      for (const m of this.store.factCandidates(now)) {
        if (
          m.id <= after ||
          !eligibleFact(this.store, m, now, cutoff) ||
          !inDomain(this.store, m, query, domain)
        )
          continue;
        const e = excerpt(m.text, query, 600),
          value = projectMemory({
            ...m,
            text: e.text,
            excerpt: e.partial,
            excerptSpan: e.partial
              ? { startUtf16: e.start!, endUtf16: e.end! }
              : undefined,
          });
        if (
          items.length >= limit ||
          (items.length &&
            tokenEstimate(JSON.stringify([...items, value])) > 1000)
        ) {
          hasMore = true;
          break;
        }
        last = m.id;
        if (tokenEstimate(JSON.stringify([value])) > 1000) {
          omitted.push(m.id);
          continue;
        }
        items.push(value);
      }
      const nextCursor = hasMore
        ? Buffer.from(
            JSON.stringify({
              scope: scopeKey(this.store),
              after: last,
              version: state.memoryVersion,
              epoch,
            }),
          ).toString("base64url")
        : undefined;
      return {
        items,
        mode: "page",
        complete:
          !page?.cursor &&
          !hasMore &&
          !omitted.length &&
          !items.some((m) => m.excerpt),
        pageComplete: !hasMore,
        nextCursor,
        reasons: omitted.length ? ["oversize_records_omitted"] : [],
        omitted,
      };
    }
    if (target === "facts") {
      const r = await this.facts(query, now, cutoff, 1000, domain, signal);
      return {
        items: r.selected.map(projectMemory),
        mode: r.mode,
        complete: r.allEligibleFactsIncluded,
        reasons: r.reasons,
      };
    }
    if (target === "conversation")
      return {
        items: readConversations(this.store, query, cutoff, false, domain).map(
          (s) => {
            const value = excerpt(s.text, query, 400);
            const chars = [...query.normalize("NFKC")],
              terms = chars
                .map((_, i) => chars.slice(i, i + 2).join(""))
                .filter((t) => [...t].length === 2);
            const refs = s.inputRefs
              .map((r, i) => {
                const raw =
                  resolveEvidence(this.store, r)?.normalize("NFKC") ?? "";
                return {
                  r,
                  i,
                  score: terms.filter((t) => raw.includes(t)).length,
                };
              })
              .sort((a, b) => b.score - a.score || a.i - b.i)
              .slice(0, 4)
              .map((v) => v.r);
            return {
              id: s.id,
              revision: s.revision,
              expandId: `summary:${s.id}`,
              text: value.text,
              excerpt: value.partial,
              kind: "conversation",
              sources: refs.map((r) => ({
                id: r.id,
                revision:
                  this.store.get("sources", r.id)?.revision ??
                  this.store.get("messages", r.id)?.revision ??
                  r.revision,
              })),
              coverage: {
                firstSeq: s.coverage.firstSeq,
                lastSeq: s.coverage.lastSeq,
                partial: s.coverage.partial,
              },
            };
          },
        ),
        mode: "keyword",
        complete: false,
        reasons: [],
      };
    const date = query.match(/\d{4}-\d{2}-\d{2}/u)?.[0];
    return {
      items: (date
        ? this.store.byStatus("memories", ["active"])
        : this.store.search(query, now, 80)
      )
        .filter(
          (m) =>
            m.kind === "episode" &&
            inDomain(this.store, m, query, domain) &&
            (!date ||
              (m.day ??
                dayKey(
                  m.occurredAt ?? m.createdAt,
                  this.store.settings().timezone,
                )) === date) &&
            validMemory(this.store, m, now, cutoff) &&
            (!m.evidence || evidenceValid(this.store, m.evidence)),
        )
        .slice(0, 5)
        .map((m) => {
          const e = excerpt(m.text, query, 400);
          return projectMemory({
            ...m,
            text: e.text,
            excerpt: e.partial,
            excerptSpan: e.partial
              ? { startUtf16: e.start!, endUtf16: e.end! }
              : undefined,
          });
        }),
      mode: "keyword",
      complete: false,
      reasons: [],
    };
  }
  source(id: string, allowed: Map<string, number>, now: number, start = 0) {
    if (!allowed.has(id)) throw new DomainError("source_not_authorized", 403);
    const prefix = id.match(/^(memory|summary):(.+)$/u),
      entityType = prefix?.[1] ?? "source",
      recordId = prefix?.[2] ?? id;
    const source =
      entityType === "source" ? this.store.get("sources", recordId) : undefined;
    const message =
      entityType === "source"
        ? this.store.get("messages", recordId)
        : undefined;
    const memory =
      entityType === "memory"
        ? this.store.get("memories", recordId)
        : undefined;
    const summary =
      entityType === "summary" && this.store.hasMemoryV2
        ? this.store.get("conversation_summaries", recordId)
        : undefined;
    const record = source ?? message ?? memory ?? summary;
    if (
      !record ||
      (this.store.hasMemoryV3 &&
        message &&
        !companionVisibleMessage(this.store, message)) ||
      source?.deleted ||
      message?.deleted ||
      (memory && !validMemory(this.store, memory, now)) ||
      (summary &&
        (summary.status !== "active" ||
          !evidenceValid(this.store, summary.inputRefs)))
    )
      throw new DomainError("stale_source", 409);
    if (allowed.get(id) !== record.revision)
      throw new DomainError("stale_source", 409);
    const content = "content" in record ? record.content : record.text,
      visible =
        message?.role === "assistant" ? message.displayed : content.length,
      raw =
        this.store.hasMemoryV3 && entityType === "source"
          ? projectCompanionText(
              this.store,
              recordId,
              content.slice(0, visible),
            )
          : content.slice(0, visible);
    if (!utf16Boundary(raw, start) || start >= raw.length)
      throw new DomainError("invalid_source_offset", 422);
    let end = start;
    while (end < raw.length && tokenEstimate(raw.slice(start, end + 1)) < 850)
      end++;
    if (/[\uD800-\uDBFF]/u.test(raw[end - 1] ?? "")) end--;
    return {
      id,
      recordId,
      entityType,
      revision: record.revision,
      text: raw.slice(start, end),
      startUtf16: start,
      endUtf16: end,
      partial: end < raw.length,
      at: now,
    };
  }
  invalidate() {
    for (const controller of this.reads) controller.abort();
    this.reads.clear();
    this.scan?.close();
    this.scan = undefined;
    this.indexRows = [];
    this.loaded = -1;
    this.indexCount = undefined;
    this.pool = undefined;
    this.poolTask = undefined;
    this.indexLookup.clear();
    this.loadToken++;
    this.loadTask = undefined;
  }
  close() {
    this.invalidate();
    this.embedding?.close();
  }
}
