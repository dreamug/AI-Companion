import { createCompanionSchema } from "./memory/companion-schema.js";
import type {
  MemoryInbox,
  Mutation,
  ProfileSlot,
  Suppression,
} from "./memory/companion-types.js";
import {
  applyCompanionDeletion,
  companionDeletion,
} from "./memory/companion-v3.js";
import { createMemorySchema } from "./memory/schema.js";
import type {
  ConversationSummary,
  Segment,
  MemoryState,
  EvidenceRef,
} from "./memory/types.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  readDeletionLedger,
  writePrivateJson,
  type Deletion,
} from "./files.js";
import {
  DEFAULT_SETTINGS,
  DomainError,
  type Scope,
  type Settings,
  type Message,
  type Run,
  type Memory,
  type FollowUp,
  type Delivery,
  type PublicEvent,
  type Trace,
  type SourceRef,
  type Series,
} from "./domain.js";

export type Source = {
  id: string;
  revision: number;
  text: string;
  kind: "message" | "manual";
  deleted: boolean;
  createdAt: number;
};
export type Job = {
  id: string;
  kind: "extract" | "summary" | "segment_summary";
  evidence?: EvidenceRef[];
  explicitMemoryRequest?: boolean;
  segmentId?: string;
  partial?: boolean;
  sourceTotal?: number;
  realityScope?: "reality" | "roleplay" | "unspecified";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  sources: SourceRef[];
  epoch: number;
  attempts: number;
  createdAt: number;
  nextAt: number;
  day?: string;
  reason?: string;
};
type Tables = {
  messages: Message;
  runs: Run;
  memories: Memory;
  followups: FollowUp;
  deliveries: Delivery;
  sources: Source;
  jobs: Job;
  series: Series;
  conversation_segments: Segment;
  conversation_summaries: ConversationSummary;
  memory_inbox: MemoryInbox;
  profile_slots: ProfileSlot;
  memory_mutations: Mutation;
  memory_suppressions: Suppression;
};
type Table = keyof Tables;
const TABLES: Table[] = [
  "messages",
  "runs",
  "memories",
  "followups",
  "deliveries",
  "sources",
  "jobs",
  "series",
];
export type Faults = { hit(point: string): void };

export class Store {
  memoryEnabled = false;
  private txDepth = 0;
  private scopedReaders = new Map<Table, Database.Statement>();
  private contextCache?: { key: string; values: Memory[] };
  private versionChanges = new Set<keyof MemoryState>();
  get hasMemoryV2() {
    return [2, 3].includes(
      this.db.pragma("user_version", { simple: true }) as number,
    );
  }
  get hasMemoryV3() {
    return this.db.pragma("user_version", { simple: true }) === 3;
  }
  readonly db: Database.Database;
  readonly ledgerPath: string;
  readonly exportDir: string;
  constructor(
    readonly dir: string,
    readonly scope: Scope,
    readonly faults: Faults = { hit() {} },
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.ledgerPath = join(dir, "deletions.json");
    this.exportDir = join(dir, "exports");
    mkdirSync(this.exportDir, { recursive: true, mode: 0o700 });
    const path = join(dir, "companion.sqlite");
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 3000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 3) {
      this.db.close();
      throw new DomainError("unsupported_schema", 500);
    }
    this.db.transaction(() => {
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS settings(owner TEXT NOT NULL, relationship TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(owner,relationship));
      CREATE TABLE IF NOT EXISTS input_keys(owner TEXT NOT NULL, relationship TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(owner,relationship,key));
      CREATE TABLE IF NOT EXISTS public_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, relationship TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, type TEXT NOT NULL, run_id TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_scope ON public_events(owner,relationship,seq);
      CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY,owner TEXT NOT NULL,relationship TEXT NOT NULL,run_id TEXT NOT NULL,at INTEGER NOT NULL,stage TEXT NOT NULL,reason TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS traces_scope ON traces(owner,relationship,run_id,at);
      CREATE TABLE IF NOT EXISTS tool_results(owner TEXT NOT NULL,relationship TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,result TEXT NOT NULL, PRIMARY KEY(owner,relationship,run_id,call_id));
      CREATE TABLE IF NOT EXISTS persona_history(owner TEXT NOT NULL,relationship TEXT NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,relationship,revision));
      CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,owner TEXT NOT NULL,relationship TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, owner UNINDEXED, relationship UNINDEXED, text, tokenize='trigram');`);
      for (const table of TABLES)
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,owner TEXT NOT NULL,relationship TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS ${table}_scope ON ${table}(owner,relationship,created_at);`);
      this.db
        .prepare("INSERT OR IGNORE INTO settings VALUES(?,?,?)")
        .run(
          scope.ownerUserId,
          scope.relationshipId,
          JSON.stringify(DEFAULT_SETTINGS),
        );
      if (version < 1) this.db.pragma("user_version = 1");
    })();
    if (this.hasMemoryV2)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO memory_state(owner,relationship) VALUES(?,?)",
        )
        .run(...this.args());
    // A durable deletion ledger is applied before any reads or recovery, including restored backups.
    try {
      this.applyLedger();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private args(): [string, string] {
    return [this.scope.ownerUserId, this.scope.relationshipId];
  }
  tx<T>(name: string, operation: () => T): T {
    this.faults.hit(`${name}.before`);
    const before = new Set(this.versionChanges),
      outer = this.txDepth === 0;
    this.txDepth++;
    let value: T;
    try {
      value = this.db.transaction(() => {
        const result = operation();
        if (outer) {
          for (const key of this.versionChanges)
            this.db
              .prepare(
                `UPDATE memory_state SET ${key}=${key}+1 WHERE owner=? AND relationship=?`,
              )
              .run(...this.args());
          this.versionChanges.clear();
        }
        this.faults.hit(`${name}.before_commit`);
        return result;
      })();
    } catch (error) {
      this.versionChanges = before;
      throw error;
    } finally {
      this.txDepth--;
    }
    this.faults.hit(`${name}.after_commit`);
    return value;
  }
  bumpMemoryVersion(key: keyof MemoryState) {
    if (!this.hasMemoryV2) return;
    if (this.txDepth) this.versionChanges.add(key);
    else
      this.db
        .prepare(
          `UPDATE memory_state SET ${key}=${key}+1 WHERE owner=? AND relationship=?`,
        )
        .run(...this.args());
  }
  memoryState(): MemoryState {
    if (!this.hasMemoryV2)
      return { memoryVersion: 0, contextVersion: 0, indexVersion: 0 };
    return this.db
      .prepare(
        "SELECT memoryVersion,contextVersion,indexVersion FROM memory_state WHERE owner=? AND relationship=?",
      )
      .get(...this.args()) as MemoryState;
  }
  enableMemoryV2() {
    if (!this.hasMemoryV2) {
      const backupDir = join(this.dir, "backups");
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const path = join(backupDir, `pre-memory-v2-${randomUUID()}.sqlite`);
      this.db.prepare("VACUUM INTO ?").run(path);
      chmodSync(path, 0o600);
      this.tx("memory_migration", () => createMemorySchema(this.db));
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memory_state(owner,relationship) VALUES(?,?)",
      )
      .run(...this.args());
    this.memoryEnabled = true;
    const settings = this.settings();
    if (settings.memorySummaryBlocks?.length)
      this.tx("restore_summary_blocks", () => {
        for (const b of settings.memorySummaryBlocks!) {
          const existing = this.get("conversation_summaries", b.id);
          this.put("conversation_summaries", {
            id: b.id,
            segmentId: existing?.segmentId ?? "forgotten",
            rangeKey: existing?.rangeKey ?? `blocked:${b.id}`,
            inputHash: existing?.inputHash ?? b.id,
            policyVersion: b.policyVersion,
            text: "",
            inputRefs: [],
            sources: [],
            status: "deleted",
            rebuildBlocked: true,
            revision: (existing?.revision ?? 0) + 1,
            createdAt: b.at,
            coverage: {
              messageIds: [
                ...new Set([
                  ...(existing?.coverage.messageIds ?? []),
                  ...b.messageIds,
                ]),
              ],
              firstSeq: 0,
              lastSeq: 0,
              partial: true,
            },
          });
        }
        this.saveSettings({ ...settings, memorySummaryBlocks: undefined });
      });
  }
  enableMemoryV3() {
    if (this.hasMemoryV3) {
      this.memoryEnabled = true;
      return;
    }
    this.enableMemoryV2();
    const backupDir = join(this.dir, "backups");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const before = join(backupDir, `pre-companion-v3-${randomUUID()}.sqlite`);
    this.db.prepare("VACUUM INTO ?").run(before);
    chmodSync(before, 0o600);
    this.tx("companion_migration", () => {
      createCompanionSchema(this.db);
      const settings = this.settings();
      this.saveSettings({
        ...settings,
        memoryFormationMode: settings.autoExtract
          ? "automatic"
          : "explicit_only",
      });
    });
  }
  dependencies(type: string, id: string, refs: EvidenceRef[]) {
    if (!this.hasMemoryV2) return;
    this.db
      .prepare(
        "DELETE FROM memory_dependencies WHERE owner=? AND relationship=? AND dependentType=? AND dependentId=?",
      )
      .run(...this.args(), type, id);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO memory_dependencies VALUES(?,?,?,?,?,?)",
    );
    for (const ref of refs)
      insert.run(...this.args(), type, id, ref.entityType, ref.id);
  }
  settings(): Settings {
    const settings = JSON.parse(
      (
        this.db
          .prepare("SELECT data FROM settings WHERE owner=? AND relationship=?")
          .get(...this.args()) as { data: string }
      ).data,
    );
    // Older bot databases predate these opt-in presentation settings.
    return { splitReplies: false, messagePacing: false, ...settings };
  }
  saveSettings(settings: Settings): void {
    this.db
      .prepare("UPDATE settings SET data=? WHERE owner=? AND relationship=?")
      .run(JSON.stringify(settings), ...this.args());
  }
  get<K extends Table>(table: K, id: string): Tables[K] | undefined {
    let statement = this.scopedReaders.get(table);
    if (!statement) {
      statement = this.db.prepare(
        `SELECT data FROM ${table} WHERE owner=? AND relationship=? AND id=?`,
      );
      this.scopedReaders.set(table, statement);
    }
    const row = statement.get(...this.args(), id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Tables[K]) : undefined;
  }
  list<K extends Table>(table: K, limit = 2000): Tables[K][] {
    if (table === "messages") {
      return (
        this.db
          .prepare(
            `SELECT m.data FROM messages m LEFT JOIN runs r ON r.id=json_extract(m.data,'$.runId') AND r.owner=m.owner AND r.relationship=m.relationship WHERE m.owner=? AND m.relationship=? ORDER BY COALESCE(json_extract(r.data,'$.config.enqueueSeq'),0) DESC,CASE json_extract(m.data,'$.role') WHEN 'assistant' THEN 1 ELSE 0 END DESC,COALESCE(json_extract(m.data,'$.replyIndex'),0) DESC,m.created_at DESC,m.id DESC LIMIT ?`,
          )
          .all(...this.args(), limit) as { data: string }[]
      ).map((row) => JSON.parse(row.data) as Tables[K]);
    }
    const order =
      table === "runs"
        ? "COALESCE(json_extract(data,'$.config.enqueueSeq'),0) DESC,created_at DESC,id DESC"
        : "created_at DESC,id DESC";
    return (
      this.db
        .prepare(
          `SELECT data FROM ${table} WHERE owner=? AND relationship=? ORDER BY ${order} LIMIT ?`,
        )
        .all(...this.args(), limit) as { data: string }[]
    ).map((x) => JSON.parse(x.data) as Tables[K]);
  }
  all<K extends Table>(table: K): Tables[K][] {
    return this.list(table, -1);
  }
  byStatus<K extends Table>(table: K, statuses: string[]): Tables[K][] {
    if (!statuses.length) return [];
    return (
      this.db
        .prepare(
          `SELECT data FROM ${table} WHERE owner=? AND relationship=? AND json_extract(data,'$.status') IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at DESC,id DESC`,
        )
        .all(...this.args(), ...statuses) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Tables[K]);
  }
  put<K extends Table>(table: K, value: Tables[K]): void {
    if (table === "memories") this.contextCache = undefined;
    const previous = this.hasMemoryV2 ? this.get(table, value.id) : undefined;
    const existing = this.db
      .prepare(`SELECT owner,relationship FROM ${table} WHERE id=?`)
      .get(value.id) as { owner: string; relationship: string } | undefined;
    if (
      existing &&
      (existing.owner !== this.scope.ownerUserId ||
        existing.relationship !== this.scope.relationshipId)
    )
      throw new DomainError("scope_conflict", 403);
    this.db
      .prepare(
        `INSERT INTO ${table}(id,owner,relationship,created_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE owner=excluded.owner AND relationship=excluded.relationship`,
      )
      .run(value.id, ...this.args(), value.createdAt, JSON.stringify(value));
    if (table === "memories") {
      const m = value as Memory;
      if (existing)
        this.db
          .prepare(
            "DELETE FROM memory_fts WHERE memory_id=? AND owner=? AND relationship=?",
          )
          .run(m.id, ...this.args());
      if (m.status === "active")
        this.db
          .prepare("INSERT INTO memory_fts VALUES(?,?,?,?)")
          .run(m.id, ...this.args(), m.text);
    }
    if (this.hasMemoryV2) {
      if (table === "memories") {
        const m = value as Memory,
          p = previous as Memory | undefined;
        const eligible = (x: Memory | undefined) =>
          x?.status === "active" &&
          (x.kind === "episode" ||
            ((x.certainty === "confirmed" ||
              (this.hasMemoryV3 && x.admission?.state === "committed")) &&
              x.category !== "interpretation"));
        const signature = (x: Memory | undefined) =>
          x &&
          JSON.stringify([
            x.text,
            x.kind,
            x.category,
            x.sources,
            x.status,
            x.certainty,
            x.pinned,
            x.validFrom,
            x.validTo,
            x.expiresAt,
            x.realityScope,
            x.subject,
            x.topic,
            x.revision,
            x.predicate,
            x.episodeType,
            x.evidence,
            x.admission,
          ]);
        if ((eligible(m) || eligible(p)) && signature(m) !== signature(p)) {
          this.bumpMemoryVersion(
            m.kind === "episode" ? "contextVersion" : "memoryVersion",
          );
          if (p && p.kind !== m.kind)
            this.bumpMemoryVersion(
              p.kind === "episode" ? "contextVersion" : "memoryVersion",
            );
          this.bumpMemoryVersion("indexVersion");
          this.db
            .prepare(
              "DELETE FROM memory_embeddings WHERE owner=? AND relationship=? AND memoryId=?",
            )
            .run(...this.args(), m.id);
          this.db
            .prepare(
              "DELETE FROM memory_index_state WHERE owner=? AND relationship=? AND memoryId=?",
            )
            .run(...this.args(), m.id);
        }
        if (m.evidence) this.dependencies("memory", m.id, m.evidence);
      } else if (table === "conversation_summaries") {
        const summary = value as ConversationSummary;
        this.db
          .prepare(
            "DELETE FROM conversation_summary_fts WHERE owner=? AND relationship=? AND summary_id=?",
          )
          .run(...this.args(), summary.id);
        if (summary.status === "active")
          this.db
            .prepare("INSERT INTO conversation_summary_fts VALUES(?,?,?,?)")
            .run(summary.id, ...this.args(), summary.text);
        this.dependencies("summary", summary.id, summary.inputRefs);
        this.bumpMemoryVersion("contextVersion");
      } else if (
        table === "sources" &&
        previous &&
        JSON.stringify(previous) !== JSON.stringify(value)
      ) {
        this.bumpMemoryVersion("memoryVersion");
        this.bumpMemoryVersion("contextVersion");
      } else if (
        table === "messages" &&
        previous &&
        "displayed" in previous &&
        "displayed" in value &&
        (previous.displayed !== value.displayed ||
          previous.content !== value.content)
      )
        this.bumpMemoryVersion("contextVersion");
    }
  }
  require<K extends Table>(table: K, id: string): Tables[K] {
    const v = this.get(table, id);
    if (!v) throw new DomainError("not_found", 404);
    return v;
  }
  sourcesValid(refs: SourceRef[]): boolean {
    return refs.every((r) => {
      const s = this.get("sources", r.id);
      return s && !s.deleted && s.revision === r.revision;
    });
  }
  sourceRefs(ids: string[]): SourceRef[] {
    return ids.map((id) => {
      const s = this.require("sources", id);
      if (s.deleted) throw new DomainError("source_deleted", 409);
      return { id, revision: s.revision };
    });
  }
  inputKey(key: string): { digest: string; runId: string } | undefined {
    const r = this.db
      .prepare(
        "SELECT digest,run_id FROM input_keys WHERE owner=? AND relationship=? AND key=?",
      )
      .get(...this.args(), key) as
      { digest: string; run_id: string } | undefined;
    return r ? { digest: r.digest, runId: r.run_id } : undefined;
  }
  saveInputKey(key: string, digest: string, runId: string): void {
    this.db
      .prepare("INSERT INTO input_keys VALUES(?,?,?,?,?)")
      .run(...this.args(), key, digest, runId);
  }
  event(
    type: string,
    payload: Record<string, unknown>,
    at: number,
    runId?: string,
  ): PublicEvent {
    const id = randomUUID();
    const r = this.db
      .prepare(
        "INSERT INTO public_events(owner,relationship,event_id,at,type,run_id,payload) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        ...this.args(),
        id,
        at,
        type,
        runId ?? null,
        JSON.stringify(payload),
      );
    if (Number(r.lastInsertRowid) % 100 === 0)
      this.db
        .prepare(
          "DELETE FROM public_events WHERE owner=? AND relationship=? AND seq < (SELECT seq FROM public_events WHERE owner=? AND relationship=? ORDER BY seq DESC LIMIT 1 OFFSET 3999)",
        )
        .run(...this.args(), ...this.args());
    return {
      schemaVersion: 1,
      eventId: id,
      seq: Number(r.lastInsertRowid),
      type,
      at,
      runId,
      payload,
    };
  }
  cursor(): string {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM public_events WHERE owner=? AND relationship=?",
      )
      .get(...this.args()) as { seq: number };
    return `${this.settings().epoch}:${row.seq}`;
  }
  events(cursor?: string): PublicEvent[] {
    let seq = 0;
    if (cursor) {
      const m = /^(\d+):(\d+)$/.exec(cursor);
      if (!m || Number(m[1]) !== this.settings().epoch)
        throw new DomainError("resync_required", 409);
      seq = Number(m[2]);
      const range = this.db
        .prepare(
          "SELECT MIN(seq) AS min,MAX(seq) AS max FROM public_events WHERE owner=? AND relationship=?",
        )
        .get(...this.args()) as { min: number | null; max: number | null };
      if (seq > (range.max ?? 0) || (range.min !== null && seq < range.min - 1))
        throw new DomainError("resync_required", 409);
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM public_events WHERE owner=? AND relationship=? AND seq>? ORDER BY seq LIMIT 500",
      )
      .all(...this.args(), seq) as {
      seq: number;
      event_id: string;
      at: number;
      type: string;
      run_id: string | null;
      payload: string;
    }[];
    return rows.map((r) => ({
      schemaVersion: 1,
      eventId: r.event_id,
      seq: r.seq,
      at: r.at,
      type: r.type,
      runId: r.run_id ?? undefined,
      payload: JSON.parse(r.payload),
    }));
  }
  trace(
    runId: string,
    stage: string,
    reason: string,
    data: Record<string, unknown>,
    at: number,
  ): void {
    this.db
      .prepare("INSERT INTO traces VALUES(?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        ...this.args(),
        runId,
        at,
        stage,
        reason,
        JSON.stringify(data),
      );
  }
  traces(runId?: string): Trace[] {
    const rows = (
      runId
        ? this.db
            .prepare(
              "SELECT * FROM traces WHERE owner=? AND relationship=? AND run_id=? ORDER BY at,id LIMIT 500",
            )
            .all(...this.args(), runId)
        : this.db
            .prepare(
              "SELECT * FROM traces WHERE owner=? AND relationship=? ORDER BY at DESC LIMIT 300",
            )
            .all(...this.args())
    ) as {
      id: string;
      run_id: string;
      at: number;
      stage: string;
      reason: string;
      data: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      at: r.at,
      stage: r.stage,
      reason: r.reason,
      data: JSON.parse(r.data),
    }));
  }
  toolResult(runId: string, callId: string): unknown {
    return this.toolRecord(runId, callId)?.result;
  }
  toolRecord(
    runId: string,
    callId: string,
  ): { result: unknown; fingerprint?: string } | undefined {
    const r = this.db
      .prepare(
        "SELECT result FROM tool_results WHERE owner=? AND relationship=? AND run_id=? AND call_id=?",
      )
      .get(...this.args(), runId, callId) as { result: string } | undefined;
    if (!r) return undefined;
    const value = JSON.parse(r.result);
    return value?.recordVersion === 1 ? value : { result: value };
  }
  saveToolResult(
    runId: string,
    callId: string,
    result: unknown,
    fingerprint?: string,
  ): void {
    this.db
      .prepare("INSERT INTO tool_results VALUES(?,?,?,?,?)")
      .run(
        ...this.args(),
        runId,
        callId,
        JSON.stringify({ recordVersion: 1, result, fingerprint }),
      );
  }
  personaHistory(): unknown[] {
    return (
      this.db
        .prepare(
          "SELECT revision,at,data FROM persona_history WHERE owner=? AND relationship=? ORDER BY revision DESC",
        )
        .all(...this.args()) as { revision: number; at: number; data: string }[]
    ).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  savePersona(at: number): void {
    const s = this.settings();
    this.db
      .prepare("INSERT OR IGNORE INTO persona_history VALUES(?,?,?,?,?)")
      .run(...this.args(), s.personaRevision, at, JSON.stringify(s.persona));
  }
  usageRecords(): { id: string; at: number; data: Record<string, unknown> }[] {
    return (
      this.db
        .prepare(
          "SELECT id,at,data FROM model_usage WHERE owner=? AND relationship=? ORDER BY at DESC LIMIT 20000",
        )
        .all(...this.args()) as { id: string; at: number; data: string }[]
    ).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  saveUsage(id: string, at: number, data: Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO model_usage VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(id, ...this.args(), at, JSON.stringify(data));
  }
  contextMemories(): Memory[] {
    const state = this.memoryState(),
      key = JSON.stringify([state.memoryVersion, state.contextVersion]);
    if (this.memoryEnabled && !this.txDepth && this.contextCache?.key === key)
      return structuredClone(this.contextCache.values);
    const values = (
      this.db
        .prepare(
          "SELECT data FROM memories WHERE owner=? AND relationship=? AND json_extract(data,'$.status')='active' AND (json_extract(data,'$.pinned')=1 OR json_extract(data,'$.kind')='episode') ORDER BY created_at ASC",
        )
        .all(...this.args()) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Memory);
    if (this.memoryEnabled && !this.txDepth)
      this.contextCache = { key, values };
    return structuredClone(values);
  }
  *qualifiedFacts(
    at: number,
    cutoff = Number.MAX_SAFE_INTEGER,
    domain: "reality" | "roleplay" = this.settings().persona.memoryScope ===
    "roleplay"
      ? "roleplay"
      : "reality",
    strict = false,
    missingIndexKey?: string,
  ): Generator<Memory> {
    let after = "";
    while (true) {
      const rows = this.db
        .prepare(
          `SELECT m.id,m.data FROM memories m WHERE m.owner=? AND m.relationship=? AND m.id>?
        AND json_extract(m.data,'$.kind')='assertion' AND json_extract(m.data,'$.status')='active'
        AND (json_extract(m.data,'$.certainty')='confirmed' ${this.hasMemoryV3 ? "OR json_extract(m.data,'$.admission.state')='committed'" : ""}) AND json_extract(m.data,'$.category')!='interpretation'
        AND COALESCE(json_extract(m.data,'$.validFrom'),0)<=? AND COALESCE(json_extract(m.data,'$.validTo'),1e308)>? AND COALESCE(json_extract(m.data,'$.expiresAt'),1e308)>?
        AND COALESCE(json_extract(m.data,'$.realityScope'),'unspecified') IN (?,'unspecified')
        AND (?=0 OR COALESCE(json_extract(m.data,'$.realityScope'),'unspecified')!='unspecified')
        AND json_array_length(json_extract(m.data,'$.sources'))>0
        AND NOT EXISTS(SELECT 1 FROM json_each(m.data,'$.sources') ref LEFT JOIN sources s ON s.owner=m.owner AND s.relationship=m.relationship AND s.id=json_extract(ref.value,'$.id') WHERE s.id IS NULL OR json_extract(s.data,'$.deleted')!=0 OR json_extract(s.data,'$.revision')!=json_extract(ref.value,'$.revision'))
        AND NOT EXISTS(SELECT 1 FROM json_each(m.data,'$.sources') ref JOIN messages msg ON msg.owner=m.owner AND msg.relationship=m.relationship AND msg.id=json_extract(ref.value,'$.id') JOIN runs r ON r.owner=m.owner AND r.relationship=m.relationship AND r.id=json_extract(msg.data,'$.runId') WHERE COALESCE(json_extract(r.data,'$.config.enqueueSeq'),0)>?)
        ${missingIndexKey ? "AND NOT EXISTS(SELECT 1 FROM memory_index_state i WHERE i.owner=m.owner AND i.relationship=m.relationship AND i.memoryId=m.id AND i.wantedRevision=json_extract(m.data,'$.revision') AND i.modelKey=? AND (i.status='ready' OR i.nextAt>?))" : ""}
        ORDER BY m.id LIMIT 100`,
        )
        .all(
          ...this.args(),
          after,
          at,
          at,
          at,
          domain,
          strict ? 1 : 0,
          Number.isFinite(cutoff) ? cutoff : Number.MAX_SAFE_INTEGER,
          ...(missingIndexKey ? [missingIndexKey, at] : []),
        ) as { id: string; data: string }[];
      for (const r of rows) yield JSON.parse(r.data) as Memory;
      if (rows.length < 100) break;
      after = rows.at(-1)!.id;
    }
  }
  *factCandidates(at: number): Generator<Memory> {
    let after = "";
    while (true) {
      const rows = this.db
        .prepare(
          "SELECT id,data FROM memories WHERE owner=? AND relationship=? AND id>? AND json_extract(data,'$.kind')='assertion' AND json_extract(data,'$.status')='active' AND json_extract(data,'$.certainty')='confirmed' AND COALESCE(json_extract(data,'$.validFrom'),0)<=? AND COALESCE(json_extract(data,'$.validTo'),9223372036854775807)>? AND COALESCE(json_extract(data,'$.expiresAt'),9223372036854775807)>? ORDER BY id LIMIT 100",
        )
        .all(...this.args(), after, at, at, at) as {
        id: string;
        data: string;
      }[];
      for (const row of rows) yield JSON.parse(row.data) as Memory;
      if (rows.length < 100) break;
      after = rows.at(-1)!.id;
    }
  }
  candidateWasDiscarded(textHash: string, refs: SourceRef[]) {
    const rows = this.db
      .prepare(
        `SELECT json_extract(data,'$.sources') AS refs FROM memories
      WHERE owner=? AND relationship=? AND json_extract(data,'$.lifecycleMetadata.terminalReason')='discarded'
      AND json_extract(data,'$.lifecycleMetadata.rejectedTextHash')=?`,
      )
      .all(...this.args(), textHash) as { refs: string }[];
    return rows.some((row) => {
      const prior = JSON.parse(row.refs) as SourceRef[];
      return (
        prior.length === refs.length &&
        prior.every((r) =>
          refs.some((x) => x.id === r.id && x.revision === r.revision),
        )
      );
    });
  }
  search(
    query: string,
    at: number,
    limit = 12,
    aliases: string[] = [],
    accept?: (memory: Memory) => boolean,
  ): Memory[] {
    const q = query.trim().slice(0, 100);
    if (!q) return [];
    let ids: string[] = [];
    const fetched = new Map<string, Memory>();
    if ([...q].length >= 3) {
      const chars = [...q];
      const terms = [
        q,
        ...aliases.filter((t) => [...t].length >= 3),
        ...chars
          .slice(0, 24)
          .map((_, i) => chars.slice(i, i + 3).join(""))
          .filter((x) => [...x].length === 3 && !/\s/.test(x)),
      ];
      const fts = [...new Set(terms)]
        .map((t) => `"${t.replaceAll('"', '""')}"`)
        .join(" OR ");
      ids = (
        this.db
          .prepare(
            "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? AND owner=? AND relationship=? LIMIT 80",
          )
          .all(fts, ...this.args()) as { memory_id: string }[]
      ).map((x) => x.memory_id);
    }
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    const fallback = this.db
      .prepare(
        `SELECT id FROM memories WHERE owner=? AND relationship=? AND json_extract(data,'$.status')='active' AND (${[q, ...aliases].map(() => "json_extract(data,'$.text') LIKE ? ESCAPE '\\'").join(" OR ")}) ORDER BY created_at DESC LIMIT 80`,
      )
      .all(
        ...this.args(),
        `%${escaped}%`,
        ...aliases.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`),
      ) as { id: string }[];
    ids = [...new Set([...ids, ...fallback.map((x) => x.id)])];
    const pairs = [
      ...new Set([...q.matchAll(/[\u3400-\u9fff]{2}/gu)].map((x) => x[0])),
    ];
    if (!ids.length && pairs.length) {
      const recent = this.list("memories", 300).filter(
        (m) => m.status === "active" && pairs.some((p) => m.text.includes(p)),
      );
      ids = recent.map((m) => m.id);
      for (const m of recent) fetched.set(m.id, m);
    }
    const score = (m: Memory) =>
      100 * Number(m.text.includes(q)) +
      pairs.filter((p) => m.text.includes(p)).length +
      aliases.filter((t) => m.text.includes(t)).length * 2 +
      Number(m.pinned) * 2;
    const ranked = ids
      .map((id) => fetched.get(id) ?? this.get("memories", id))
      .filter(
        (m): m is Memory =>
          !!m &&
          m.status === "active" &&
          (!m.validFrom || m.validFrom <= at) &&
          (!m.validTo || m.validTo > at),
      )
      .sort((a, b) => score(b) - score(a));
    const selected: Memory[] = [];
    for (const m of ranked) {
      if (!this.sourcesValid(m.sources) || (accept && !accept(m))) continue;
      selected.push(m);
      if (selected.length >= limit) break;
    }
    return selected;
  }
  forget(
    sourceIds: string[],
    memoryIds: string[],
    at: number,
    summaryIds: string[] = [],
    extraRanges: Suppression[] = [],
  ): void {
    if (this.hasMemoryV3) {
      const entry = companionDeletion(this, sourceIds, memoryIds, at);
      entry.v3!.ranges.push(...extraRanges);
      writePrivateJson(this.ledgerPath, [...this.readLedger(), entry]);
      this.applyDeletion(entry);
      for (const f of readdirSync(this.exportDir))
        if (f.endsWith(".json")) unlinkSync(join(this.exportDir, f));
      return;
    }
    // Write the non-content tombstone first. A crash before the DB transaction is safe: startup applies it.
    const ledger = this.readLedger();
    const blocks = this.hasMemoryV2
      ? this.all("conversation_summaries").filter(
          (s) =>
            summaryIds.includes(s.id) ||
            sourceIds.length > 0 ||
            s.inputRefs.some((r) => memoryIds.includes(r.id)),
        )
      : [];
    const entry: Deletion = {
      ...(summaryIds.length || blocks.length
        ? {
            schemaVersion: 2 as const,
            summaryIds,
            summaryBlocks: blocks.map((s) => ({
              id: s.id,
              messageIds: s.coverage.messageIds,
              policyVersion: s.policyVersion,
            })),
          }
        : {}),
      id: randomUUID(),
      at,
      scope: this.scope,
      sourceIds: [...new Set(sourceIds)],
      memoryIds: [...new Set(memoryIds)],
    };
    writePrivateJson(this.ledgerPath, [...ledger, entry]);
    this.applyDeletion(entry);
    for (const f of readdirSync(this.exportDir))
      if (f.endsWith(".json")) unlinkSync(join(this.exportDir, f));
  }
  private readLedger(): Deletion[] {
    return readDeletionLedger(this.ledgerPath);
  }
  private applyDeletion(entry: Deletion): void {
    if (
      entry.scope.ownerUserId !== this.scope.ownerUserId ||
      entry.scope.relationshipId !== this.scope.relationshipId
    )
      return;
    if (entry.v3 && this.hasMemoryV3) {
      applyCompanionDeletion(this, entry);
      return;
    }
    this.tx("forget", () => {
      const s = this.settings();
      const applied =
        (s as Settings & { appliedDeletions?: string[] }).appliedDeletions ??
        [];
      if (applied.includes(entry.id)) return;
      const ids = new Set(entry.sourceIds);
      for (const id of ids) {
        const source = this.get("sources", id);
        if (source)
          this.put("sources", {
            ...source,
            text: "",
            deleted: true,
            revision: source.revision + 1,
          });
        const msg = this.get("messages", id);
        if (msg)
          this.put("messages", {
            ...msg,
            content: "",
            deleted: true,
            revision: msg.revision + 1,
          });
      }
      const memories = this.all("memories");
      const erasedRoots = new Set(
        memories
          .filter(
            (m) =>
              entry.memoryIds.includes(m.id) ||
              m.sources.some((r) => ids.has(r.id)),
          )
          .map((m) => m.lifecycleMetadata?.candidateId ?? m.id),
      );
      for (const memory of memories)
        if (
          entry.memoryIds.includes(memory.id) ||
          memory.sources.some((r) => ids.has(r.id))
        ) {
          if (memory.day && !s.summaryBlockedDays.includes(memory.day))
            s.summaryBlockedDays.push(memory.day);
          this.put("memories", {
            ...memory,
            text: "",
            status: "deleted",
            lifecycleMetadata: undefined,
            revision: memory.revision + 1,
          });
        }
      // Metadata has no FTS projection. Clear it in one scoped SQL update rather
      // than rewriting unchanged text/index rows for every derived revision.
      if (erasedRoots.size)
        this.db
          .prepare(
            `UPDATE memories SET data=json_remove(data,'$.lifecycleMetadata')
        WHERE owner=? AND relationship=? AND json_extract(data,'$.lifecycleMetadata.candidateId')
        IN (SELECT value FROM json_each(?))`,
          )
          .run(...this.args(), JSON.stringify([...erasedRoots]));
      s.memoryCandidateOffer = undefined;
      s.lastInlineMemoryOfferInputId = undefined;
      s.memoryReadState = undefined;
      // Assistant continuations may quote the forgotten source. Conservatively clear scoped assistant text.
      if (ids.size)
        for (const msg of this.all("messages"))
          if (msg.role === "assistant")
            this.put("messages", {
              ...msg,
              content: "",
              deleted: true,
              revision: msg.revision + 1,
            });
      for (const run of this.all("runs")) {
        const config = {
          enqueueSeq: run.config.enqueueSeq,
          sdkVersion: run.config.sdkVersion,
          promptVersion: run.config.promptVersion,
          safetyRevision: run.config.safetyRevision,
          redacted: true,
        };
        this.put(
          "runs",
          run.status === "queued" || run.status === "running"
            ? {
                ...run,
                config,
                status: "cancelled",
                generation: run.generation + 1,
                updatedAt: entry.at,
                reason: "forgotten",
              }
            : { ...run, config },
        );
      }
      for (const f of this.all("followups"))
        if (f.sources.some((r) => ids.has(r.id)))
          this.put("followups", {
            ...f,
            text: "",
            status: "cancelled",
            revision: f.revision + 1,
            reason: "forgotten",
          });
      for (const series of this.all("series"))
        if (series.sources.some((r) => ids.has(r.id)))
          this.put("series", {
            ...series,
            text: "",
            status: "cancelled",
            revision: series.revision + 1,
          });
      for (const d of this.all("deliveries"))
        this.put("deliveries", {
          ...d,
          text: "",
          status: "cancelled",
          revision: d.revision + 1,
          reason: "forgotten",
        });
      for (const job of this.all("jobs"))
        if (job.sources.some((r) => ids.has(r.id)))
          this.put("jobs", {
            ...job,
            status: "cancelled",
            reason: "forgotten",
          });
      this.db
        .prepare("DELETE FROM traces WHERE owner=? AND relationship=?")
        .run(...this.args());
      this.db
        .prepare("DELETE FROM tool_results WHERE owner=? AND relationship=?")
        .run(...this.args());
      this.db
        .prepare("DELETE FROM public_events WHERE owner=? AND relationship=?")
        .run(...this.args());
      this.db
        .prepare(
          "UPDATE input_keys SET digest='' WHERE owner=? AND relationship=?",
        )
        .run(...this.args());
      if (this.hasMemoryV2) {
        const blocks = new Map(
          (entry.summaryBlocks ?? []).map((b) => [b.id, b]),
        );
        for (const summary of this.all("conversation_summaries"))
          if (
            entry.summaryIds?.includes(summary.id) ||
            blocks.has(summary.id) ||
            summary.inputRefs.some(
              (r) => ids.has(r.id) || entry.memoryIds.includes(r.id),
            )
          ) {
            this.put("conversation_summaries", {
              ...summary,
              coverage: {
                ...summary.coverage,
                messageIds: [
                  ...new Set([
                    ...summary.coverage.messageIds,
                    ...(blocks.get(summary.id)?.messageIds ?? []),
                  ]),
                ],
              },
              text: "",
              inputRefs: [],
              sources: [],
              status: "deleted",
              rebuildBlocked: true,
              revision: summary.revision + 1,
            });
            blocks.delete(summary.id);
          }
        for (const b of blocks.values())
          this.put("conversation_summaries", {
            id: b.id,
            segmentId: "forgotten",
            rangeKey: `blocked:${b.id}`,
            inputHash: b.id,
            policyVersion: b.policyVersion,
            text: "",
            inputRefs: [],
            sources: [],
            status: "deleted",
            rebuildBlocked: true,
            revision: 1,
            createdAt: entry.at,
            coverage: {
              messageIds: b.messageIds,
              firstSeq: 0,
              lastSeq: 0,
              partial: true,
            },
          });
        this.db
          .prepare(
            "DELETE FROM memory_embeddings WHERE owner=? AND relationship=?",
          )
          .run(...this.args());
        this.db
          .prepare(
            "DELETE FROM memory_index_state WHERE owner=? AND relationship=?",
          )
          .run(...this.args());
        this.db
          .prepare(
            "DELETE FROM memory_dependencies WHERE owner=? AND relationship=?",
          )
          .run(...this.args());
        for (const key of [
          "memoryVersion",
          "contextVersion",
          "indexVersion",
        ] as const)
          this.bumpMemoryVersion(key);
      }
      if (!this.hasMemoryV2 && entry.summaryBlocks?.length) {
        const blocks = new Map(
          (s.memorySummaryBlocks ?? []).map((b) => [b.id, b]),
        );
        for (const b of entry.summaryBlocks) {
          const old = blocks.get(b.id);
          blocks.set(b.id, {
            ...b,
            messageIds: [
              ...new Set([...(old?.messageIds ?? []), ...b.messageIds]),
            ],
            at: entry.at,
          });
        }
        s.memorySummaryBlocks = [...blocks.values()];
      }
      s.epoch++;
      s.revision++;
      (s as Settings & { appliedDeletions: string[] }).appliedDeletions = [
        ...applied,
        entry.id,
      ];
      this.saveSettings(s);
      this.event(
        "memory.invalidated",
        { sourceIds: entry.sourceIds, memoryIds: entry.memoryIds },
        entry.at,
      );
    });
  }
  applyLedger(): void {
    for (const entry of this.readLedger()) this.applyDeletion(entry);
    for (const file of readdirSync(this.exportDir))
      if (file.endsWith(".json")) {
        try {
          const data = JSON.parse(
            readFileSync(join(this.exportDir, file), "utf8"),
          ) as { epoch?: number };
          if (data.epoch !== this.settings().epoch)
            unlinkSync(join(this.exportDir, file));
        } catch {
          unlinkSync(join(this.exportDir, file));
        }
      }
  }
  recover(at: number): void {
    this.tx("recovery", () => {
      if (this.hasMemoryV3) {
        for (const r of this.byStatus("runs", ["queued"]))
          this.put("runs", {
            ...r,
            status: "cancelled",
            generation: r.generation + 1,
            reason: "process_restart",
            progress: undefined,
            updatedAt: at,
          });
        for (const inbox of this.byStatus("memory_inbox", [
          "queued",
          "running",
          "requires_sync",
        ]))
          this.put("memory_inbox", {
            ...inbox,
            status: "cancelled",
            reason: "process_restart",
            settledAt: at,
          });
      }
      for (const r of this.byStatus("runs", ["running"]))
        if (r.status === "running") {
          this.put("runs", {
            ...r,
            status: "interrupted",
            progress: undefined,
            generation: r.generation + 1,
            updatedAt: at,
            reason: "process_restart",
            config: r.config.splitReplies
              ? { ...r.config, replyPhase: "interrupted" }
              : r.config,
          });
          this.event("run.interrupted", { runId: r.id }, at, r.id);
        }
      for (const m of this.byStatus("messages", ["streaming"]))
        if (m.role === "assistant" && m.status === "streaming")
          this.put("messages", { ...m, status: "interrupted" });
      for (const j of this.byStatus("jobs", ["running"]))
        if (j.status === "running")
          this.put("jobs", {
            ...j,
            status: "pending",
            reason: "process_restart",
          });
      for (const f of this.byStatus("followups", ["generating"]))
        if (f.status === "generating")
          this.put("followups", {
            ...f,
            status: f.latestAt > at ? "pending" : "expired",
            reason: "process_restart",
          });
      for (const d of this.byStatus("deliveries", ["attempt_started"]))
        if (d.status === "attempt_started")
          this.put("deliveries", {
            ...d,
            status: "unknown",
            reason: "receipt_lost",
          });
    });
  }
  async backup(destination: string): Promise<void> {
    await this.db.backup(destination);
    chmodSync(destination, 0o600);
  }
  close(): void {
    this.contextCache = undefined;
    this.scopedReaders.clear();
    this.db.close();
  }
}
