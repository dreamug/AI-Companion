// Experiment only. Not connected to production Harness or its data directory.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Store } from "../../src/store.js";
import type { Memory } from "../../src/domain.js";
import { abortable } from "../../src/async.js";

export class IndexPrototype {
  readonly db: Database.Database = new Database(":memory:");
  constructor(
    readonly store: Store,
    readonly model = "pinned-model:384",
  ) {
    this.db.exec(
      "CREATE TABLE vectors(bot TEXT,id TEXT,revision INTEGER,hash TEXT,model TEXT,vector BLOB,PRIMARY KEY(bot,id))",
    );
  }
  fingerprint(memory: Memory) {
    return createHash("sha256")
      .update(JSON.stringify([memory.text, memory.sources]))
      .digest("hex");
  }
  capture(memory: Memory) {
    return {
      bot: this.store.scope.relationshipId,
      id: memory.id,
      revision: memory.revision,
      hash: this.fingerprint(memory),
      epoch: this.store.settings().epoch,
      model: this.model,
    };
  }
  commit(job: ReturnType<IndexPrototype["capture"]>, vector: number[]) {
    const memory = this.store.get("memories", job.id);
    if (
      job.bot !== this.store.scope.relationshipId ||
      job.epoch !== this.store.settings().epoch ||
      job.model !== this.model ||
      !memory ||
      memory.status !== "active" ||
      memory.certainty !== "confirmed" ||
      !this.store.sourcesValid(memory.sources) ||
      memory.revision !== job.revision ||
      this.fingerprint(memory) !== job.hash
    )
      return false;
    if (
      vector.length !== Number(this.model.split(":").at(-1)) ||
      vector.some((v) => !Number.isFinite(v))
    )
      return false;
    this.db
      .prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?)")
      .run(
        job.bot,
        job.id,
        job.revision,
        job.hash,
        job.model,
        Buffer.from(new Float32Array(vector).buffer),
      );
    return true;
  }
  candidates(now: number) {
    const rows = this.db
      .prepare("SELECT * FROM vectors WHERE bot=? AND model=?")
      .all(this.store.scope.relationshipId, this.model) as {
      id: string;
      revision: number;
      hash: string;
    }[];
    return rows
      .map((row) => ({ row, memory: this.store.get("memories", row.id) }))
      .filter(
        ({ row, memory: m }) =>
          m &&
          m.status === "active" &&
          m.certainty === "confirmed" &&
          m.revision === row.revision &&
          this.fingerprint(m) === row.hash &&
          this.store.sourcesValid(m.sources) &&
          (!m.validFrom || m.validFrom <= now) &&
          (!m.validTo || m.validTo > now),
      )
      .map(({ memory }) => memory!);
  }
  remove(id: string) {
    this.db
      .prepare("DELETE FROM vectors WHERE bot=? AND id=?")
      .run(this.store.scope.relationshipId, id);
  }
  async indexAsync(
    memory: Memory,
    encode: (text: string, signal: AbortSignal) => Promise<number[]>,
    signal: AbortSignal,
  ) {
    const job = this.capture(memory);
    try {
      if (signal.aborted) return false;
      const vector = await abortable(encode(memory.text, signal), signal);
      return !signal.aborted && this.commit(job, vector);
    } catch {
      return false;
    }
  }
  close() {
    this.db.close();
  }
}
