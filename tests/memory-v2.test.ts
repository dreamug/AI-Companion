import { afterEach, describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { setup, ScriptedModel, response, deferred } from "./helpers.js";
import { Store } from "../src/store.js";
import { restoreBackup } from "../src/backup.js";
import {
  captureMessage,
  resolveEvidence,
  utf16Boundary,
  evidenceValid,
} from "../src/memory/evidence.js";
import {
  assignSegment,
  queueConversationSummary,
  processConversationSummary,
  readConversations,
} from "../src/memory/conversations.js";
import { MemoryRetrieval } from "../src/memory/retrieval.js";
import { validateVector, type EmbeddingPort } from "../src/memory/embedding.js";
import { readFacts } from "../src/memory/reading.js";
import { memoryChunks } from "../src/memory/chunks.js";
import { DomainError, type Memory } from "../src/domain.js";
const cleanups: (() => Promise<void>)[] = [];
function make(options: Parameters<typeof setup>[0] = {}) {
  const x = setup({
    ...options,
    config: { ...options.config, memoryV2: true, memorySummaries: false },
  });
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
async function turn(x: ReturnType<typeof setup>, text = "合成输入") {
  const r = x.h.submit(text, crypto.randomUUID());
  await x.h.waitForIdle();
  const a = x.store
    .all("messages")
    .find((m) => m.runId === r.runId && m.role === "assistant");
  if (a) x.h.displayed(a.id, a.content.length);
  return r;
}
const vector = (n = 0): number[] =>
  Array.from({ length: 384 }, (_, i) => (i === n ? 1 : 0));
function fake(overrides: Partial<EmbeddingPort> = {}): EmbeddingPort {
  return {
    modelKey: "test-vector-v1",
    ready: true,
    warm() {},
    async encode() {
      return vector();
    },
    close() {},
    ...overrides,
  };
}
async function fill(x: ReturnType<typeof setup>, n = 35) {
  const facts: Memory[] = [];
  for (let i = 0; i < n; i++)
    facts.push(
      x.h.addMemory({
        text: `独立事实${i}：合成偏好${i}`,
        realityScope: "reality",
      }),
    );
  return facts;
}

describe("MEM-2–6 迁移、证据、摘要、索引和异步合同", () => {
  it("v1→v2 有迁移前备份，旧 JSON 可读；关闭功能不降低版本", () => {
    const x = make();
    expect(x.store.hasMemoryV2).toBe(true);
    expect(
      readdirSync(join(x.dir, "backups")).some((f) =>
        f.startsWith("pre-memory-v2"),
      ),
    ).toBe(true);
    const other = new Store(x.dir, x.store.scope);
    try {
      expect(other.hasMemoryV2).toBe(true);
      expect(other.memoryEnabled).toBe(false);
      expect(other.settings().persona.name).toBeTruthy();
    } finally {
      other.close();
    }
  });
  it("迁移提交故障全部回滚，不留下半张新表或调低版本", () => {
    let fail = false;
    const x = setup({
      faults: {
        hit(point) {
          if (fail && point === "memory_migration.before_commit")
            throw Error("injected");
        },
      },
    });
    cleanups.push(x.dispose);
    fail = true;
    expect(() => x.store.enableMemoryV2()).toThrow("injected");
    expect(x.store.hasMemoryV2).toBe(false);
    expect(
      x.store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='memory_embeddings'",
        )
        .get(),
    ).toBeUndefined();
  });
  it("三个版本分离，pending 元数据不改变事实版本，同一事务只加一次", () => {
    const x = make(),
      start = x.store.memoryState();
    const p = x.h.addMemory({ text: "候选" }, true);
    expect(x.store.memoryState()).toEqual(start);
    x.h.reviseMemory(p.id, 1, { decision: "confirm" });
    expect(x.store.memoryState().memoryVersion).toBe(start.memoryVersion + 1);
    x.store.tx("group", () => {
      x.h.addMemory({ text: "并发一" });
      x.h.addMemory({ text: "并发二" });
    });
    expect(x.store.memoryState().memoryVersion).toBe(start.memoryVersion + 2);
    const old = x.store.memoryState();
    expect(() =>
      x.store.tx("abort", () => {
        x.h.addMemory({ text: "不能提交" });
        throw Error("rollback");
      }),
    ).toThrow();
    expect(x.store.memoryState()).toEqual(old);
  });
  it("Unicode 所有合法端点可引用，代理对中间不合法；展示增长不失效旧切片", async () => {
    const x = make();
    const r = await turn(x);
    const m = x.store
      .all("messages")
      .find((m) => m.runId === r.runId && m.role === "assistant")!;
    const text = "A😀𠮷B\ne\u0301";
    x.store.put("messages", { ...m, content: text, displayed: text.length });
    const boundaries = Array.from(
      { length: text.length + 1 },
      (_, i) => i,
    ).filter((i) => utf16Boundary(text, i));
    expect(boundaries).not.toContain(2);
    expect(boundaries).not.toContain(4);
    for (const start of boundaries)
      for (const end of boundaries.filter((n) => n > start)) {
        const ref = captureMessage(x.store, m.id, start, end);
        expect(resolveEvidence(x.store, ref)).toBe(text.slice(start, end));
      }
    expect(() => captureMessage(x.store, m.id, 2, 3)).toThrow(
      "invalid_evidence",
    );
    const ref = captureMessage(x.store, m.id, 0, 3);
    x.store.put("messages", {
      ...x.store.require("messages", m.id),
      content: text + "更多",
      displayed: text.length + 2,
      revision: m.revision + 2,
    });
    expect(resolveEvidence(x.store, ref)).toBe("A😀");
    x.store.put("messages", {
      ...x.store.require("messages", m.id),
      content: "不同" + text,
    });
    expect(resolveEvidence(x.store, ref)).toBeUndefined();
  });
  it("分段在30分钟之后且无其他 Run 时创建，重启保留 open 段", async () => {
    const x = make();
    const a = await turn(x);
    const first = x.store.require("runs", a.runId).config.segmentId;
    x.clock.advance(30 * 60000);
    const b = await turn(x);
    expect(x.store.require("runs", b.runId).config.segmentId).toBe(first);
    x.clock.advance(30 * 60000 + 1);
    const c = await turn(x);
    expect(x.store.require("runs", c.runId).config.segmentId).not.toBe(first);
    expect(x.store.byStatus("conversation_segments", ["open"])).toHaveLength(1);
    const r = x.store.require("runs", c.runId);
    assignSegment(x.store, r, x.clock.now());
    expect(x.store.byStatus("conversation_segments", ["open"])).toHaveLength(1);
  });
  it("200条后早期决定可由摘要找回，摘要只读已展示原文，重复提交不复制", async () => {
    const x = make();
    for (let i = 0; i < 100; i++)
      await turn(
        x,
        (i === 14 ? "我们决定给项目使用海棠这个代号" : `合成闲聊${i}`) +
          "。合成补充背景".repeat(30),
      );
    queueConversationSummary(x.store, x.clock.now());
    let processed = 0;
    for (let round = 0; round < 30; round++) {
      const jobs = x.store
        .byStatus("jobs", ["pending"])
        .filter((j) => j.kind === "segment_summary");
      if (!jobs.length) {
        queueConversationSummary(x.store, x.clock.now());
        if (
          !x.store
            .byStatus("jobs", ["pending"])
            .some((j) => j.kind === "segment_summary")
        )
          break;
        continue;
      }
      for (const job of jobs) {
        await processConversationSummary(
          x.store,
          job,
          () => x.clock.now(),
          new AbortController().signal,
          async (_sys, input) =>
            JSON.stringify({
              summary: JSON.parse(input)
                .filter((v: { role: string }) => v.role === "user")
                .map((v: { text: string }) => v.text.slice(0, 40))
                .join("；"),
            }),
        );
        processed++;
      }
      queueConversationSummary(x.store, x.clock.now());
    }
    expect(processed).toBeGreaterThan(2);
    const hits = readConversations(x.store, "海棠");
    expect(hits.some((s) => s.text.includes("海棠"))).toBe(true);
    expect(hits.every((s) => evidenceValid(x.store, s.inputRefs))).toBe(true);
    const old = x.store.all("conversation_summaries").length;
    queueConversationSummary(x.store, x.clock.now());
    expect(x.store.all("conversation_summaries")).toHaveLength(old);
  });
  it("摘要生成期间撤销来源，迟到结果不能提交", async () => {
    const x = make();
    for (let i = 0; i < 10; i++) await turn(x, `旧讨论${i}`);
    queueConversationSummary(x.store, x.clock.now());
    const job = x.store
      .byStatus("jobs", ["pending"])
      .find((j) => j.kind === "segment_summary")!;
    const gate = deferred();
    const result = processConversationSummary(
      x.store,
      job,
      () => x.clock.now(),
      new AbortController().signal,
      async () => {
        await gate.promise;
        return JSON.stringify({ summary: "不应保存" });
      },
    );
    x.h.forget([job.sources[0]!.id], []);
    gate.resolve();
    await expect(result).rejects.toThrow("stale_source");
    expect(
      x.store.all("conversation_summaries").some((s) => s.text === "不应保存"),
    ).toBe(false);
  });
  it("只删摘要的禁重建标记跟随台账恢复到旧备份", async () => {
    const x = make();
    for (let i = 0; i < 10; i++) await turn(x, `项目决定${i}`);
    queueConversationSummary(x.store, x.clock.now());
    const job = x.store
      .byStatus("jobs", ["pending"])
      .find((j) => j.kind === "segment_summary")!;
    await processConversationSummary(
      x.store,
      job,
      () => x.clock.now(),
      new AbortController().signal,
      async () => JSON.stringify({ summary: "项目采用海棠" }),
    );
    const summary = x.store.all("conversation_summaries")[0]!;
    const backup = join(x.dir, "old.sqlite");
    await x.store.backup(backup);
    x.h.forget([], [], [summary.id]);
    expect(x.store.require("conversation_summaries", summary.id)).toMatchObject(
      { text: "", status: "deleted", rebuildBlocked: true },
    );
    const restored = restoreBackup(
      backup,
      join(x.dir, "restored"),
      x.store.scope,
      [x.store.ledgerPath],
    );
    try {
      expect(restored.require("conversation_summaries", summary.id).text).toBe(
        "",
      );
    } finally {
      restored.close();
    }
  });
  it.each([NaN, Infinity, -Infinity])("非法向量数值 %s 被拒绝", (bad) => {
    const v = vector();
    v[7] = bad;
    expect(() => validateVector(v)).toThrow("invalid_embedding");
  });
  it("维度和归一化校验，Unicode分块不丢尾部或切坏字符", () => {
    expect(() => validateVector([1])).toThrow();
    expect(() => validateVector(Array(384).fill(1))).toThrow(
      "invalid_embedding_norm",
    );
    const text =
      "😀𠮷这是合成长记录，不喜欢咖啡。".repeat(200) + "尾部项目代号海棠";
    const chunks = memoryChunks(text);
    expect(chunks.at(-1)!.text).toContain("尾部项目代号海棠");
    for (const c of chunks) {
      expect(utf16Boundary(text, c.start)).toBe(true);
      expect(utf16Boundary(text, c.end)).toBe(true);
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
  });
  it("索引 ready 只改 indexVersion，确认的新事实不用等索引，精确词不被向量挤掉", async () => {
    const x = make();
    const facts = await fill(x);
    const service = new MemoryRetrieval(x.store, fake());
    cleanups.unshift(async () => service.close());
    const before = x.store.memoryState();
    for (let i = 0; i < facts.length; i++)
      await service.indexOne(new AbortController().signal, x.clock.now());
    expect(x.store.memoryState().memoryVersion).toBe(before.memoryVersion);
    expect(x.store.memoryState().indexVersion).toBeGreaterThan(
      before.indexVersion,
    );
    const target = x.h.addMemory({
      text: "唯一关键词银杏灯",
      realityScope: "reality",
    });
    const result = await service.facts("银杏灯", x.clock.now());
    expect(result.mode).toBe("hybrid");
    expect(result.selected[0]!.id).toBe(target.id);
  });
  it("编码期间更正或遗忘，旧向量不得落库", async () => {
    const x = make();
    const m = x.h.addMemory({ text: "旧资料" });
    const gate = deferred();
    const service = new MemoryRetrieval(
      x.store,
      fake({
        async encode() {
          await gate.promise;
          return vector();
        },
      }),
    );
    cleanups.unshift(async () => service.close());
    const task = service.indexOne(new AbortController().signal, x.clock.now());
    x.h.reviseMemory(m.id, 1, { text: "新资料" });
    gate.resolve();
    await task;
    expect(
      x.store.db
        .prepare("SELECT count(*) AS n FROM memory_embeddings WHERE memoryId=?")
        .get(m.id),
    ).toEqual({ n: 0 });
  });
  it("关键词降级保留资格；模型缺失、错误、取消不得混淆空结果", async () => {
    const x = make();
    await fill(x);
    const target = x.h.addMemory({ text: "精确金合欢" });
    const service = new MemoryRetrieval(
      x.store,
      fake({
        async encode() {
          throw new DomainError("embedding_timeout", 503);
        },
      }),
    );
    cleanups.unshift(async () => service.close());
    const result = await service.facts("金合欢", x.clock.now());
    expect(result.selected.map((m) => m.id)).toContain(target.id);
    expect(result.reasons).toContain("embedding_timeout");
    const c = new AbortController();
    c.abort();
    await expect(
      service.facts(
        "金合欢",
        x.clock.now(),
        Infinity,
        2000,
        undefined,
        c.signal,
      ),
    ).rejects.toThrow("cancelled");
  });
  it("来源展开拒绝任意ID、过时修订、未展示尾段和代理对中间偏移", async () => {
    const x = make();
    const r = await turn(x);
    const source = x.store.require("sources", r.messageId);
    const allowed = new Map([[source.id, source.revision]]);
    expect(() =>
      x.h.memory.source(source.id, new Map(), x.clock.now()),
    ).toThrow("source_not_authorized");
    expect(x.h.memory.source(source.id, allowed, x.clock.now()).text).toBe(
      source.text,
    );
    x.store.put("sources", { ...source, text: "😀测试", revision: 2 });
    expect(() => x.h.memory.source(source.id, allowed, x.clock.now())).toThrow(
      "stale_source",
    );
    expect(() =>
      x.h.memory.source(source.id, new Map([[source.id, 2]]), x.clock.now(), 1),
    ).toThrow("invalid_source_offset");
  });
  it("相同topic的不同主体与并存偏好不被确认动作粗暴覆盖", () => {
    const x = make();
    const a = x.h.addMemory({ text: "用户喜欢茶", subject: "user" }),
      b = x.h.addMemory({ text: "姐姐喜欢咖啡", subject: "sister" });
    x.store.put("memories", { ...a, topic: "drink" });
    x.store.put("memories", { ...b, topic: "drink" });
    const pending = x.h.addMemory(
      { text: "用户也喜欢果汁", subject: "user" },
      true,
    );
    x.store.put("memories", { ...pending, topic: "drink" });
    x.h.reviseMemory(pending.id, 1, { decision: "confirm" });
    expect(
      readFacts(x.store, "饮品", x.clock.now()).selected.map((m) => m.id),
    ).toEqual(expect.arrayContaining([a.id, b.id, pending.id]));
  });
  it("提取登记不依赖回答成功，上一条已展示助手只作语境来源", async () => {
    const model = new ScriptedModel(async function* (r) {
      if (r.purpose === "extract") {
        const v = JSON.parse(r.messages[0]!.content);
        yield* response(
          JSON.stringify({
            assertions: [
              {
                text: "用户周末爬山",
                retention: "durable",
                category: "preference",
                certainty: "stated",
                sourceIds: [v.userSources[0].id],
              },
            ],
            openLoops: [],
          }),
        );
      } else yield* response("周末一般做什么？");
    });
    const x = make({ model });
    await turn(x);
    const answer = await turn(x, "爬山");
    const job = x.store
      .all("jobs")
      .find((j) => j.sources.some((s) => s.id === answer.messageId))!;
    expect(job.evidence?.length).toBe(1);
    expect(job.sources.map((r) => r.id)).toEqual([answer.messageId]);
    x.clock.advance(2000);
    await x.h.tick();
    await x.h.tick();
    expect(
      model.requests
        .filter((r) => r.purpose === "extract")
        .some((r) => r.messages[0]!.content.includes("contextOnly")),
    ).toBe(true);
  });
});

it("冷快照加载与查询编码并行，共用原截止时间而非逐步吃掉编码预算", async () => {
  const x = make();
  await fill(x);
  let delay = false;
  const events: string[] = [];
  const service = new MemoryRetrieval(
    x.store,
    fake({
      async encode(_text, kind) {
        if (delay && kind === "query") {
          events.push("encode-start");
          await new Promise((r) => setTimeout(r, 100));
          events.push("encode-done");
        }
        return vector();
      },
    }),
  );
  cleanups.unshift(async () => service.close());
  while (await service.indexOne(new AbortController().signal, x.clock.now())) {}
  // Delay the actual first snapshot without changing its scope/generation checks.
  const internals = service as unknown as {
    indexSnapshot: (g: number) => Promise<void>;
  };
  const native = internals.indexSnapshot.bind(service);
  internals.indexSnapshot = async (g) => {
    events.push("snapshot-start");
    await new Promise((r) => setTimeout(r, 130));
    await native(g);
    events.push("snapshot-done");
  };
  delay = true;
  const result = await service.facts("改述", x.clock.now());
  expect(events.indexOf("encode-start")).toBeLessThan(
    events.indexOf("snapshot-done"),
  );
  expect(events.indexOf("encode-done")).toBeLessThan(
    events.indexOf("snapshot-done"),
  );
  expect(result.mode).toBe("hybrid");
});
