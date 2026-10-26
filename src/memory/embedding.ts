import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { DomainError } from "../domain.js";
export const E5_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
export const E5_KEY = `e5-small:${E5_REVISION}:384:f32:mean:l2:prefix-v1:utf16-conservative-v1`;
export interface EmbeddingPort {
  readonly modelKey: string;
  readonly ready: boolean;
  warm(): void;
  encode(
    text: string,
    kind: "query" | "passage",
    scope: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<number[]>;
  close(): void;
}
export function validateVector(vector: unknown): number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== 384 ||
    vector.some((v) => typeof v !== "number" || !Number.isFinite(v))
  )
    throw new DomainError("invalid_embedding", 502);
  const norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0));
  if (Math.abs(norm - 1) > 0.02)
    throw new DomainError("invalid_embedding_norm", 502);
  return vector;
}
export function validatePackedVector(vector: Float32Array) {
  if (vector.length !== 384) throw new DomainError("invalid_embedding", 502);
  let sum = 0;
  for (const value of vector) {
    if (!Number.isFinite(value))
      throw new DomainError("invalid_embedding", 502);
    sum += value * value;
  }
  if (Math.abs(Math.sqrt(sum) - 1) > 0.02)
    throw new DomainError("invalid_embedding_norm", 502);
}
type Task = {
  id: string;
  text: string;
  kind: "query" | "passage";
  scope: string;
  signal: AbortSignal;
  resolve: (v: number[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  started?: number;
};
export class LocalEmbedding implements EmbeddingPort {
  readonly modelKey = E5_KEY;
  ready = false;
  private child?: ChildProcessWithoutNullStreams;
  private queue: Task[] = [];
  private active?: Task;
  private stopped = false;
  private failures: number[] = [];
  private pauseUntil = 0;
  constructor(
    private python = resolve(".venv-memory-lab/bin/python"),
    private modelPath = join(
      homedir(),
      ".cache/huggingface/hub/models--intfloat--multilingual-e5-small/snapshots",
      E5_REVISION,
    ),
    private workerPath: URL = new URL("embedding-worker.py", import.meta.url),
  ) {}
  warm() {
    if (
      this.child ||
      this.stopped ||
      Date.now() < this.pauseUntil ||
      !existsSync(this.python) ||
      !existsSync(join(this.modelPath, "model.safetensors"))
    )
      return;
    const child = spawn(
      this.python,
      [this.workerPath.pathname, this.modelPath],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HF_HUB_OFFLINE: "1" },
      },
    );
    this.child = child;
    const watchdog = setTimeout(() => this.fail(), 30000);
    watchdog.unref();
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    lines.on("line", (line) => {
      if (this.child !== child) return;
      try {
        const r = JSON.parse(line);
        if (r.ready === true) {
          if (r.dimension !== 384) throw Error();
          clearTimeout(watchdog);
          this.ready = true;
          this.pump();
          return;
        }
        const task = this.active;
        if (
          !task ||
          r.id !== task.id ||
          r.scope !== task.scope ||
          r.modelKey !== this.modelKey ||
          r.error
        )
          throw Error();
        const vector = validateVector(r.vector);
        this.active = undefined;
        task.cleanup();
        if (!task.signal.aborted) task.resolve(vector);
        this.pump();
      } catch {
        this.fail();
      }
    });
    child.once("error", () => {
      if (this.child === child) this.fail();
    });
    child.once("exit", () => {
      clearTimeout(watchdog);
      if (this.child === child) this.fail();
    });
  }
  encode(
    text: string,
    kind: "query" | "passage",
    scope: string,
    signal: AbortSignal,
    timeoutMs = 250,
  ) {
    if (this.stopped || signal.aborted)
      return Promise.reject(new DomainError("cancelled", 409));
    if (!this.ready)
      return Promise.reject(new DomainError("embedding_not_ready", 503));
    if (
      this.queue.length >= 16 ||
      (kind === "query" &&
        this.queue.some((t) => t.scope === scope && t.kind === "query"))
    )
      return Promise.reject(new DomainError("embedding_busy", 503));
    return new Promise<number[]>((resolveTask, reject) => {
      const id = randomUUID();
      let task: Task;
      const cancel = () => {
        const i = this.queue.indexOf(task);
        if (i >= 0) this.queue.splice(i, 1);
        if (this.active === task) {
          clearTimeout(task.timer);
          signal.removeEventListener("abort", cancel);
        } else task.cleanup();
        reject(
          new DomainError(
            signal.aborted ? "cancelled" : "embedding_timeout",
            409,
          ),
        );
      };
      const timer = setTimeout(cancel, timeoutMs);
      timer.unref();
      task = {
        id,
        text,
        kind,
        scope,
        signal,
        resolve: resolveTask,
        reject,
        timer,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
        },
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.queue.push(task);
      this.queue.sort(
        (a, b) => Number(b.kind === "query") - Number(a.kind === "query"),
      );
      this.pump();
    });
  }
  private pump() {
    if (this.active || !this.ready || !this.child) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    task.started = Date.now();
    const watchdog = setTimeout(() => {
      if (this.active === task) this.fail();
    }, 5000);
    watchdog.unref();
    const cleanup = task.cleanup;
    task.cleanup = () => {
      clearTimeout(watchdog);
      cleanup();
    };
    this.child.stdin.write(
      JSON.stringify({
        id: task.id,
        text: task.text,
        kind: task.kind,
        scope: task.scope,
        modelKey: this.modelKey,
      }) + "\n",
    );
  }
  private fail() {
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    child?.kill();
    for (const t of [...this.queue, ...(this.active ? [this.active] : [])]) {
      t.cleanup();
      t.reject(new DomainError("embedding_unavailable", 503));
    }
    this.queue = [];
    this.active = undefined;
    this.failures = this.failures.filter((t) => Date.now() - t < 600000);
    this.failures.push(Date.now());
    if (this.failures.length >= 3) this.pauseUntil = Date.now() + 60000;
  }
  close() {
    this.stopped = true;
    this.fail();
  }
}
/** A foreground request must never wait for a non-preemptible passage.
 * Workers own their models; only small text/vector messages cross the boundary.
 * This costs a second resident model, but keeps indexing off the query queue.
 */
export class IsolatedEmbedding implements EmbeddingPort {
  readonly modelKey: string;
  constructor(
    private query: EmbeddingPort = new LocalEmbedding(),
    private passage: EmbeddingPort = new LocalEmbedding(),
  ) {
    if (query.modelKey !== passage.modelKey)
      throw new DomainError("embedding_model_mismatch", 500);
    this.modelKey = query.modelKey;
  }
  get ready() {
    return this.query.ready && this.passage.ready;
  }
  warm() {
    this.query.warm();
    this.passage.warm();
  }
  encode(
    text: string,
    kind: "query" | "passage",
    scope: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ) {
    return (kind === "query" ? this.query : this.passage).encode(
      text,
      kind,
      scope,
      signal,
      timeoutMs,
    );
  }
  close() {
    this.query.close();
    this.passage.close();
  }
}
const shared = new Map<string, { port: EmbeddingPort; refs: number }>();
export function acquireEmbedding(
  python?: string,
  path?: string,
): EmbeddingPort {
  const key = JSON.stringify([python, path]);
  let item = shared.get(key);
  if (!item) {
    item = {
      port: new IsolatedEmbedding(
        new LocalEmbedding(python, path),
        new LocalEmbedding(python, path),
      ),
      refs: 0,
    };
    shared.set(key, item);
  }
  item.refs++;
  const entry = item;
  let closed = false;
  return {
    modelKey: entry.port.modelKey,
    get ready() {
      return entry.port.ready;
    },
    warm: () => entry.port.warm(),
    encode: (...args) => entry.port.encode(...args),
    close: () => {
      if (closed) return;
      closed = true;
      if (--entry.refs === 0) {
        entry.port.close();
        shared.delete(key);
      }
    },
  };
}
