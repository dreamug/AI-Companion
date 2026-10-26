import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setup, deferred, ScriptedModel, response } from "./helpers.js";
import {
  backfillSegments,
  readConversations,
  queueConversationSummary,
} from "../src/memory/conversations.js";
import { captureMessage, textHash } from "../src/memory/evidence.js";
import { MemoryRetrieval } from "../src/memory/retrieval.js";
import { restoreBackup } from "../src/backup.js";
import { writePrivateJson } from "../src/files.js";
import { DomainError } from "../src/domain.js";
import type { EmbeddingPort } from "../src/memory/embedding.js";
const cleanup: (() => Promise<void>)[] = [];
function make(v2 = true) {
  const x = setup({ config: { memoryV2: v2, memorySummaries: false } });
  cleanup.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
async function summary(x: ReturnType<typeof make>, id = "release-summary") {
  const r = x.h.submit("早期决定：项目代号用白榆。", crypto.randomUUID());
  await x.h.waitForIdle();
  const ref = captureMessage(x.store, r.messageId);
  const s = {
    id,
    segmentId: "segment",
    rangeKey: id,
    inputRefs: [ref],
    inputHash: textHash(id),
    policyVersion: "raw-block-v1",
    text: "早期决定采用白榆。",
    coverage: {
      messageIds: [r.messageId],
      firstSeq: 1,
      lastSeq: 1,
      partial: false,
    },
    status: "active" as const,
    rebuildBlocked: false,
    revision: 1,
    createdAt: x.clock.now(),
    sources: [{ id: r.messageId, revision: 1 }],
    realityScope: "reality" as const,
  };
  x.store.put("conversation_summaries", s);
  return s;
}
it("历史元数据回填可重复，不改变消息内容、Run状态或重跑模型", async () => {
  const x = make(false);
  x.h.submit("旧段第一句", "one");
  await x.h.waitForIdle();
  x.clock.advance(30 * 60000 + 1);
  x.h.submit("旧段第二句", "two");
  await x.h.waitForIdle();
  const before = x.store
      .all("messages")
      .map((m) => [m.id, m.content, m.status]),
    runs = x.store.all("runs").map((r) => [r.id, r.status]);
  x.store.enableMemoryV2();
  backfillSegments(x.store);
  const ids = x.store.all("conversation_segments").map((s) => s.id);
  backfillSegments(x.store);
  expect(ids).toHaveLength(2);
  expect(x.store.all("conversation_segments").map((s) => s.id)).toEqual(ids);
  expect(
    x.store.all("messages").map((m) => [m.id, m.content, m.status]),
  ).toEqual(before);
  expect(x.store.all("runs").map((r) => [r.id, r.status])).toEqual(runs);
  expect(x.store.all("messages").every((m) => m.segmentId)).toBe(true);
});
it("长事实和旧摘要的展开需要各自授权，过时或删除后拒绝", async () => {
  const x = make(),
    m = x.h.addMemory({
      text: "头部限定。" + "合成描述".repeat(800) + "尾部答案是白榆。",
    }),
    id = `memory:${m.id}`;
  const page = await x.h.memory.search(
    "全部",
    "facts",
    x.clock.now(),
    Infinity,
    undefined,
    { limit: 1 },
  );
  expect(page.complete).toBe(false);
  expect(page.items[0]?.expandId).toBe(id);
  expect(() => x.h.memory.source(id, new Map(), x.clock.now())).toThrow(
    "source_not_authorized",
  );
  const grant = new Map([[id, m.revision]]);
  let start = 0,
    output = "";
  for (let i = 0; i < 20; i++) {
    const part = x.h.memory.source(id, grant, x.clock.now(), start);
    output += part.text;
    start = part.endUtf16;
    if (!part.partial) break;
  }
  expect(output).toBe(m.text);
  x.h.reviseMemory(m.id, m.revision, { text: "更正为紫藤" });
  expect(() => x.h.memory.source(id, grant, x.clock.now())).toThrow(
    "stale_source",
  );
  const s = await summary(x),
    sid = `summary:${s.id}`,
    sg = new Map([[sid, s.revision]]);
  expect(x.h.memory.source(sid, sg, x.clock.now()).text).toContain("白榆");
  x.h.forget([], [], [s.id]);
  expect(() => x.h.memory.source(sid, sg, x.clock.now())).toThrow(
    "stale_source",
  );
});
it("日期路径找回旧事件，现实与虚构在摘要和事件中均隔离", async () => {
  const x = make(),
    s = await summary(x),
    day = "2026-10-23",
    m = x.h.addMemory({
      text: "shared：已完成陶艺课",
      realityScope: "reality",
    });
  x.store.put("memories", {
    ...m,
    kind: "episode",
    episodeType: "shared",
    day,
  });
  const rp = x.h.addMemory({
    text: "reported：虚构的陶艺课",
    realityScope: "roleplay",
  });
  x.store.put("memories", {
    ...rp,
    kind: "episode",
    episodeType: "reported",
    day,
  });
  const r = await x.h.memory.search(day, "episodes", x.clock.now());
  expect(r.items.map((m) => m.id)).toContain(m.id);
  expect(r.items.map((m) => m.id)).not.toContain(rp.id);
  expect(readConversations(x.store, "2026-10-23").map((s) => s.id)).toContain(
    s.id,
  );
  expect(
    readConversations(x.store, "白榆", Infinity, false, "roleplay"),
  ).toEqual([]);
  x.store.put("conversation_summaries", { ...s, realityScope: "unspecified" });
  expect(readConversations(x.store, "现实发生的经历白榆")).toEqual([]);
});
it("等待编码期间事实到期，即使清理未运行也不能回到结果", async () => {
  const x = make(),
    gate = deferred();
  for (let i = 0; i < 35; i++)
    x.h.addMemory({ text: `合成长条目${i}：用于达到混合检索阈值` });
  const m = x.h.addMemory({
    text: "限时的银杏灯",
    validTo: x.clock.now() + 10,
  });
  const port: EmbeddingPort = {
    modelKey: "release",
    ready: true,
    warm() {},
    close() {},
    async encode() {
      await gate.promise;
      return Array.from({ length: 384 }, (_, i) => Number(i === 0));
    },
  };
  const service = new MemoryRetrieval(x.store, port, () => x.clock.now());
  cleanup.unshift(async () => service.close());
  const pending = service.facts("银杏灯", x.clock.now());
  x.clock.advance(11);
  gate.resolve();
  const r = await pending;
  expect(r.selected.map((m) => m.id)).not.toContain(m.id);
});
it("v1备份接收v2摘要遗忘台账，后续升级仍保持禁止自动重建", async () => {
  const x = make(false),
    backup = join(x.dir, "v1.sqlite"),
    ledger = join(x.dir, "external-ledger.json"),
    target = join(x.dir, "restored");
  await x.store.backup(backup);
  writePrivateJson(ledger, [
    {
      id: "forget-summary",
      at: x.clock.now(),
      scope: x.store.scope,
      sourceIds: [],
      memoryIds: [],
      schemaVersion: 2,
      summaryIds: ["gone"],
      summaryBlocks: [
        {
          id: "gone",
          messageIds: ["old-message"],
          policyVersion: "raw-block-v1",
        },
      ],
    },
  ]);
  const restored = restoreBackup(backup, target, x.store.scope, [ledger]);
  try {
    expect(restored.hasMemoryV2).toBe(false);
    expect(restored.settings().memorySummaryBlocks?.[0]?.messageIds).toContain(
      "old-message",
    );
    restored.enableMemoryV2();
    const s = restored.require("conversation_summaries", "gone");
    expect(s.rebuildBlocked).toBe(true);
    expect(s.text).toBe("");
    expect(s.coverage.messageIds).toContain("old-message");
  } finally {
    restored.close();
  }
});
it("同一删除记录的多个副本合并全部摘要阻止范围", async () => {
  const x = make(false),
    backup = join(x.dir, "v1.sqlite"),
    ledgers = [join(x.dir, "a.json"), join(x.dir, "b.json")];
  await x.store.backup(backup);
  for (const [i, p] of ledgers.entries())
    writePrivateJson(p, [
      {
        id: "same-deletion",
        at: x.clock.now(),
        scope: x.store.scope,
        sourceIds: [],
        memoryIds: [],
        schemaVersion: 2,
        summaryIds: ["gone"],
        summaryBlocks: [
          {
            id: "gone",
            messageIds: [`message-${i}`],
            policyVersion: "raw-block-v1",
          },
        ],
      },
    ]);
  const restored = restoreBackup(
    backup,
    join(x.dir, "merged"),
    x.store.scope,
    ledgers,
  );
  try {
    restored.enableMemoryV2();
    expect(
      restored
        .require("conversation_summaries", "gone")
        .coverage.messageIds.sort(),
    ).toEqual(["message-0", "message-1"]);
  } finally {
    restored.close();
  }
});
it("迁移CLI默认验证副本，原库schema、正文和删除台账不变", () => {
  const x = make(false);
  x.h.addMemory({ text: "迁移前必须保留" });
  writePrivateJson(join(x.dir, "deletions.json"), []);
  const before = x.store.all("memories"),
    ledger = readFileSync(join(x.dir, "deletions.json"), "utf8");
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/memory-migrate.ts", "--data-dir", x.dir],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(JSON.parse(output).mode).toBe("isolated_copy_verified");
  expect(x.store.hasMemoryV2).toBe(false);
  expect(x.store.all("memories")).toEqual(before);
  expect(readFileSync(join(x.dir, "deletions.json"), "utf8")).toBe(ledger);
});
it("资格缓存遵守未来生效时间、排队截点和来源失效", async () => {
  const x = make();
  for (let i = 0; i < 35; i++)
    x.h.addMemory({ text: `缓存合成条目${i}：独立背景文字` });
  const input = x.h.submit("星槐偏好", "queued-source");
  await x.h.waitForIdle();
  const target = x.h.addMemory({
    text: "星槐偏好",
    validFrom: x.clock.now() + 10,
  });
  x.store.put("memories", {
    ...target,
    sources: [{ id: input.messageId, revision: 1 }],
  });
  const service = new MemoryRetrieval(
    x.store,
    {
      modelKey: "cached",
      ready: true,
      warm() {},
      close() {},
      async encode() {
        return Array.from({ length: 384 }, (_, i) => Number(i === 0));
      },
    },
    () => x.clock.now(),
  );
  cleanup.unshift(async () => service.close());
  expect(
    (await service.facts("星槐", x.clock.now())).selected.map((m) => m.id),
  ).not.toContain(target.id);
  x.clock.advance(10);
  expect(
    (await service.facts("星槐", x.clock.now(), 0)).selected.map((m) => m.id),
  ).not.toContain(target.id);
  expect(
    (await service.facts("星槐", x.clock.now())).selected.map((m) => m.id),
  ).toContain(target.id);
  const source = x.store.require("sources", input.messageId);
  x.store.put("sources", { ...source, revision: 2 });
  expect(
    (await service.facts("星槐", x.clock.now())).selected.map((m) => m.id),
  ).not.toContain(target.id);
});
it("仅展示回执变更也重验缓存证据，固定置顶不被前五排序挤掉", async () => {
  const x = make();
  for (let i = 0; i < 35; i++)
    x.h.addMemory({ text: `背景条目${i}：缓存过滤` });
  const input = x.h.submit("展示测试", "visible");
  await x.h.waitForIdle();
  const assistant = x.store
    .all("messages")
    .find((m) => m.runId === input.runId && m.role === "assistant")!;
  x.h.displayed(assistant.id, assistant.content.length);
  const ref = captureMessage(x.store, assistant.id);
  const target = x.h.addMemory({ text: "置顶泽兰", pinned: true });
  x.store.put("memories", { ...target, evidence: [ref] });
  const service = new MemoryRetrieval(
    x.store,
    {
      modelKey: "cached",
      ready: true,
      warm() {},
      close() {},
      async encode() {
        return Array.from({ length: 384 }, (_, i) => Number(i === 0));
      },
    },
    () => x.clock.now(),
  );
  cleanup.unshift(async () => service.close());
  expect((await service.facts("条目", x.clock.now())).selected[0]?.id).toBe(
    target.id,
  );
  const version = x.store.memoryState().memoryVersion;
  x.store.put("messages", {
    ...x.store.require("messages", assistant.id),
    displayed: 0,
  });
  expect(x.store.memoryState().memoryVersion).toBe(version);
  expect(
    (await service.facts("条目", x.clock.now())).selected.map((m) => m.id),
  ).not.toContain(target.id);
});
it("底层资格字段和类型变化也使缓存版本失效，不依赖调用者另改revision", () => {
  const x = make(),
    m = x.h.addMemory({ text: "资格测试" }),
    v = x.store.memoryState();
  x.store.put("memories", { ...m, category: "interpretation" });
  expect(x.store.memoryState().memoryVersion).toBe(v.memoryVersion + 1);
  x.store.put("memories", m);
  const before = x.store.memoryState();
  x.store.put("memories", { ...m, kind: "episode" });
  expect(x.store.memoryState().memoryVersion).toBe(before.memoryVersion + 1);
  expect(x.store.memoryState().contextVersion).toBe(before.contextVersion + 1);
});
it("滚动摘要的软触发只计算未覆盖原文，不在长聊后每轮请求摘要", async () => {
  const x = setup({ config: { memoryV2: true, memorySummaries: true } });
  cleanup.push(x.dispose);
  for (let i = 0; i < 30; i++) {
    const r = x.h.submit(`合成普通闲聊${i}`, crypto.randomUUID());
    await x.h.waitForIdle();
    const a = x.store
      .all("messages")
      .find((m) => m.runId === r.runId && m.role === "assistant")!;
    x.h.displayed(a.id, a.content.length);
    x.clock.advance(1000);
    await x.h.tick();
    await x.h.waitForIdle();
  }
  const jobs = x.store.all("jobs").filter((j) => j.kind === "segment_summary");
  expect(jobs.length).toBeGreaterThan(0);
  expect(jobs.length).toBeLessThanOrEqual(10);
  expect(jobs.every((j) => j.status === "completed")).toBe(true);
});
it("摘要临时网络故障最多重试两次，延迟推进且不重跑聊天", async () => {
  let calls = 0;
  const model = new ScriptedModel(async function* (r) {
    if (r.purpose === "summary") {
      if (++calls < 3) throw new DomainError("provider_unavailable", 503);
      yield* response(
        '```json\n{"summary":"合成交流摘要","sourceIds":[]}\n```',
      );
    } else yield* response("收到合成交流。");
  });
  const x = setup({
    model,
    config: { memoryV2: true, memorySummaries: false },
  });
  cleanup.push(x.dispose);
  for (let i = 0; i < 10; i++) {
    const r = x.h.submit(`合成原始发言${i}`, crypto.randomUUID());
    await x.h.waitForIdle();
    const a = x.store
      .all("messages")
      .find((m) => m.runId === r.runId && m.role === "assistant")!;
    x.h.displayed(a.id, a.content.length);
  }
  queueConversationSummary(x.store, x.clock.now());
  const job = x.store.all("jobs").find((j) => j.kind === "segment_summary")!;
  await x.h.tick();
  expect(x.store.require("jobs", job.id)).toMatchObject({
    status: "pending",
    attempts: 1,
  });
  expect(x.store.all("conversation_summaries")).toHaveLength(0);
  await x.h.tick();
  expect(calls).toBe(1);
  x.clock.advance(5000);
  await x.h.tick();
  expect(x.store.require("jobs", job.id)).toMatchObject({
    status: "pending",
    attempts: 2,
  });
  x.clock.advance(30000);
  await x.h.tick();
  expect(x.store.require("jobs", job.id)).toMatchObject({
    status: "completed",
    attempts: 3,
  });
  expect(x.store.all("conversation_summaries")).toHaveLength(1);
  expect(model.requests.filter((r) => r.purpose === "chat")).toHaveLength(10);
});
it("摘要Schema错误不自动重试或推进覆盖", async () => {
  const model = new ScriptedModel(async function* (r) {
    yield* response(r.purpose === "summary" ? "not json" : "收到合成交流。");
  });
  const x = setup({
    model,
    config: { memoryV2: true, memorySummaries: false },
  });
  cleanup.push(x.dispose);
  for (let i = 0; i < 10; i++) {
    x.h.submit(`合成原文${i}`, crypto.randomUUID());
    await x.h.waitForIdle();
  }
  queueConversationSummary(x.store, x.clock.now());
  const job = x.store.all("jobs").find((j) => j.kind === "segment_summary")!;
  await x.h.tick();
  x.clock.advance(60000);
  await x.h.tick();
  expect(x.store.require("jobs", job.id)).toMatchObject({
    status: "failed",
    attempts: 1,
  });
  expect(x.store.all("conversation_summaries")).toHaveLength(0);
  expect(model.requests.filter((r) => r.purpose === "summary")).toHaveLength(1);
});

it("矩阵装载中只有index ready变化时只降级，不误报事实快照失效", async () => {
  const x = make();
  for (let i = 0; i < 35; i++)
    x.h.addMemory({ text: `已确认背景资料${i}，达到混合检索规模` });
  const service = new MemoryRetrieval(
    x.store,
    {
      modelKey: "index-race",
      ready: true,
      warm() {},
      close() {},
      async encode() {
        return Array.from({ length: 384 }, (_, i) => Number(i === 0));
      },
    },
    () => x.clock.now(),
  );
  cleanup.unshift(async () => service.close());
  const version = x.store.memoryState().memoryVersion,
    pending = service.facts("背景", x.clock.now());
  queueMicrotask(() => x.store.bumpMemoryVersion("indexVersion"));
  const result = await pending;
  expect(x.store.memoryState().memoryVersion).toBe(version);
  expect(result.reasons).toContain("index_snapshot_changed");
});
