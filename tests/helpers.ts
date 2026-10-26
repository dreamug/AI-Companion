import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../src/harness.js";
import { Store, type Faults } from "../src/store.js";
import { LOCAL_SCOPE, type Clock, type Scope } from "../src/domain.js";
import {
  MockModel,
  type ModelPort,
  type ModelRequest,
  type ModelEvent,
} from "../src/model.js";
import type { AppConfig } from "../src/config.js";

export class TestClock implements Clock {
  constructor(public time = Date.parse("2026-10-23T04:00:00Z")) {}
  now() {
    return this.time;
  }
  advance(ms: number) {
    this.time += ms;
  }
}
export class ScriptedModel implements ModelPort {
  name = "scripted";
  requests: ModelRequest[] = [];
  constructor(
    private script: (
      request: ModelRequest,
      index: number,
    ) => AsyncIterable<ModelEvent>,
  ) {}
  stream(request: ModelRequest) {
    this.requests.push(request);
    return this.script(request, this.requests.length - 1);
  }
}
export const finish: ModelEvent = {
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    calls: 1,
    estimated: false,
  },
};
export async function* response(text = "好的，我记下了。") {
  yield { type: "text" as const, text };
  yield finish;
}
export function deferred() {
  let resolve!: (v?: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function setup(
  options: {
    model?: ModelPort;
    clock?: TestClock;
    faults?: Faults;
    scope?: Scope;
    dir?: string;
    config?: Partial<AppConfig>;
  } = {},
) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "companion-test-"));
  const config: AppConfig = {
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
    modelMode: "mock",
    maxRunMs: 1000,
    maxOutputTokens: 300,
    schedulerMs: 50,
    ...options.config,
  };
  const clock = options.clock ?? new TestClock(),
    store = new Store(dir, options.scope ?? LOCAL_SCOPE, options.faults);
  const s = store.settings();
  store.saveSettings({ ...s, remoteDisclosureAcknowledged: true });
  const model = options.model ?? new MockModel();
  const h = new Harness(store, model, config, clock);
  return {
    h,
    store,
    clock,
    dir,
    config,
    async dispose() {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
