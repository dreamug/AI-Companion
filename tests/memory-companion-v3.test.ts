import { createApp } from "../src/server.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../src/harness.js";
import { BotManager } from "../src/bots.js";
import { Store, type Faults } from "../src/store.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import type { AppConfig } from "../src/config.js";
import {
  ScriptedModel,
  TestClock,
  response,
  until,
  deferred,
} from "./helpers.js";
import {
  companionProfile,
  CompanionPlan,
  commitCompanionPlan,
  companionOperations,
  projectCompanionText,
  type Plan,
} from "../src/memory/companion-v3.js";
import { readFacts } from "../src/memory/reading.js";
import { resolveAddress } from "../src/memory/address.js";
import type { ModelRequest } from "../src/model.js";

// Decode the facts draft from its actual assistant message, preserving raw requests for assertions.
const judgeData = (r: ModelRequest) => ({
  ...JSON.parse(r.messages[0]!.content),
  ...(r.messages[1]?.role === "assistant"
    ? { draft: r.messages[1].content }
    : {}),
});
type Item = Plan["items"][number];
function item(quote: string, changes: Partial<Item> = {}): Item {
  return {
    action: "add",
    text: quote,
    value: quote,
    quote,
    subject: "user",
    reality: "reality",
    retention: "durable",
    scope: "relationship",
    risk: "ordinary",
    category: "preference",
    targetId: null,
    expectedRevision: null,
    ...changes,
  };
}
const empty: Plan = { intent: "none", items: [] };
const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of dispose.splice(0)) await d();
});
function make(
  options: {
    faults?: Faults;
    judge?: (r: ModelRequest) => string | Promise<string>;
    chat?: (r: ModelRequest) => Promise<string> | string;
    extract?: (r: ModelRequest) => Promise<void>;
    scope?: typeof LOCAL_SCOPE;
    maxRunMs?: number;
    memoryFactsModel?: string;
    memoryFastPath?: boolean;
    memoryReviewTimeoutMs?: number;
    references?: (r: ModelRequest) => string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "cm3-test-")),
    clock = new TestClock(),
    store = new Store(dir, options.scope ?? LOCAL_SCOPE, options.faults);
  store.enableMemoryV3();
  store.saveSettings({
    ...store.settings(),
    remoteDisclosureAcknowledged: true,
    proactiveEnabled: false,
  });
  const plans = new Map<string, Plan>();
  const model = new ScriptedModel(async function* (r) {
    if (r.purpose === "extract") {
      await options.extract?.(r);
      const data = judgeData(r);
      yield* response(JSON.stringify(plans.get(data.input) ?? empty));
    } else if (r.purpose === "judge") {
      const data = JSON.parse(r.messages[0]!.content);
      if (data.task === "naming_references")
        yield* response(
          options.references?.(r) ??
            JSON.stringify({
              references: data.mentions.map((m: { id: number }) => ({
                id: m.id,
                bearer: "other",
                use: "not_name",
              })),
            }),
        );
      else
        yield* response(
          (await options.judge?.(r)) ??
            (options.memoryFastPath && data.contractPart === "operations"
              ? '{"checks":[],"requiredAction":"none","userEvidence":null}'
              : '{"checks":[]}'),
        );
    } else yield* response((await options.chat?.(r)) ?? "好，我明白了。");
  });
  const config: AppConfig = {
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    modelMode: "mock",
    baseURL: "http://unused.invalid",
    model: "deepseek-flash",
    maxRunMs: options.maxRunMs ?? 5000,
    maxOutputTokens: 500,
    schedulerMs: 100,
    memoryV3: true,
    memoryV2: true,
    memoryVectors: false,
    memorySummaries: false,
    memoryReplyGuard: true,
    memoryFactsModel: options.memoryFactsModel,
    memoryFastPath: options.memoryFastPath,
    memoryReviewTimeoutMs: options.memoryReviewTimeoutMs,
  };
  const h = new Harness(store, model, config, clock);
  dispose.push(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const say = async (text: string, plan: Plan = empty) => {
    plans.set(text, plan);
    const r = h.submit(text, crypto.randomUUID());
    await until(
      () =>
        !["queued", "running"].includes(store.require("runs", r.runId).status),
      6000,
    );
    const m = store.require("messages", `assistant-${r.runId}`);
    if (m.content) h.displayed(m.id, m.content.length);
    return { ...r, reply: m, run: store.require("runs", r.runId) };
  };
  return { h, store, clock, model, plans, say, dir, config };
}
it("explicit schema3 migration is required; legacy mode cannot silently open a schema3 bot", async () => {
  const x = make();
  expect(x.store.hasMemoryV3).toBe(true);
  expect(x.store.hasMemoryV2).toBe(true);
  expect(
    () => new Harness(x.store, x.model, { ...x.config, memoryV3: false }),
  ).toThrow("companion_policy_required");
});
it("schema3 migration rolls back every new table on transaction failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm3-schema-"));
  let fail = false;
  const store = new Store(dir, LOCAL_SCOPE, {
    hit(p) {
      if (fail && p === "companion_migration.before_commit")
        throw Error("injected");
    },
  });
  store.enableMemoryV2();
  fail = true;
  expect(() => store.enableMemoryV3()).toThrow("injected");
  expect(store.hasMemoryV3).toBe(false);
  expect(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE name='profile_slots'")
      .get(),
  ).toBeUndefined();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
it("ordinary statements become stated committed facts, never fake manual confirmation or pending cards", async () => {
  const x = make(),
    q = "平时我喜欢在河边骑车。";
  const r = await x.say(q, { intent: "none", items: [item(q)] });
  const m = x.store.all("memories")[0]!;
  expect(m).toMatchObject({
    certainty: "stated",
    status: "active",
    manual: false,
    admission: { state: "committed", origin: "automatic_user_statement" },
  });
  expect(r.run.status).toBe("completed");
  expect(r.run.config.memorySaveIntent).toBe(false);
  expect(x.store.all("memory_inbox")[0]?.status).toBe("committed");
  expect(readFacts(x.store, "", x.clock.now()).selected).toHaveLength(1);
  expect(x.h.snapshot().candidateOffer).toBeUndefined();
  expect(x.store.all("jobs")).toHaveLength(0);
});
it("automatic formation retains its receipt without turning ordinary chat into an operation announcement", async () => {
  const x = make({
    chat: () => "已经存好了。听起来很舒服。",
    judge: (r) => {
      const data = judgeData(r);
      expect(data.saveIntent).toBe(false);
      expect(data.memoryOperations.receipt.status).toBe("committed");
      if (data.contractPart === "operations") {
        expect(r.system).toContain("即使真实保存成功");
        if (data.draft.includes("已经存好了。"))
          return JSON.stringify({
            checks: [
              {
                quote: "已经存好了。",
                scope: "save_workflow",
                reason: "普通分享未询问办理",
                violation: "workflow_narration",
              },
            ],
          });
      }
      return '{"checks":[]}';
    },
  });
  const q = "我喜欢在阳台看云。";
  const r = await x.say(q, { intent: "none", items: [item(q)] });
  expect(r.run.status).toBe("completed");
  expect(r.reply.content).toBe("听起来很舒服。");
  expect(x.store.all("memories")).toHaveLength(1);
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(4);
});
it("explicit_only accepts explicit save, ordinary statements do not bypass it, off reports unavailable", async () => {
  const x = make();
  x.store.saveSettings({
    ...x.store.settings(),
    memoryFormationMode: "explicit_only",
  });
  await x.say("我喜欢木工。", {
    intent: "none",
    items: [item("我喜欢木工。")],
  });
  expect(x.store.all("memories")).toHaveLength(0);
  await x.say("请记住我喜欢木工。", {
    intent: "save",
    items: [item("请记住我喜欢木工。")],
  });
  expect(x.store.all("memories")).toHaveLength(1);
  x.store.saveSettings({ ...x.store.settings(), memoryFormationMode: "off" });
  const stopped = await x.say("记住我喜欢素描。", {
    intent: "save",
    items: [item("记住我喜欢素描。")],
  });
  expect(x.store.all("memories")).toHaveLength(1);
  expect(
    x.store.require(
      "memory_mutations",
      String(stopped.run.config.companionMutationId),
    ).rejected[0]?.reason,
  ).toBe("formation_disabled");
});
it.each(["other", "unspecified"] as const)(
  "%s subjects cannot become the current user's fact",
  async (subject) => {
    const x = make();
    await x.say("有人喜欢骑马。", {
      intent: "none",
      items: [item("有人喜欢骑马。", { subject })],
    });
    expect(readFacts(x.store, "", x.clock.now()).selected).toHaveLength(0);
  },
);
it.each(["restricted", "secret", "uncertain"] as const)(
  "%s data does not enter early memory",
  async (risk) => {
    const x = make();
    await x.say("这是一段私人资料。", {
      intent: "save",
      items: [item("这是一段私人资料。", { risk })],
    });
    expect(x.store.all("memories")).toHaveLength(0);
  },
);
it("secret signatures cannot be accepted by a model labelling the quote ordinary", async () => {
  const x = make(),
    q = "记住，我的验证码是 471905。";
  await x.say(q, { intent: "save", items: [item(q)] });
  expect(x.store.all("memories")).toHaveLength(0);
});
it("roleplay assertions never update the real profile", async () => {
  const x = make();
  await x.say("故事里叫我安珀。", {
    intent: "address",
    items: [
      item("故事里叫我安珀。", {
        action: "set_address",
        value: "安珀",
        reality: "roleplay",
      }),
    ],
  });
  expect(companionProfile(x.store, x.clock.now())).toHaveLength(0);
});
it.each(["问题？", "假设某天如此。", "引用了朋友的说法。"])(
  "no qualifying assertion in %s produces no write",
  async (text) => {
    const x = make();
    await x.say(text);
    expect(x.store.all("memories")).toHaveLength(0);
    expect(x.store.all("memory_mutations")[0]?.status).toBe("noop");
  },
);
it("critical address survives a model-history reset and restart; originals stay in the UI", async () => {
  const x = make(),
    q = "以后称呼我知夏。";
  const r = await x.say(q, {
    intent: "address",
    items: [
      item(q, {
        action: "set_address",
        value: "知夏",
        text: "用户希望被叫知夏",
      }),
    ],
  });
  x.h.resetCompanionContext();
  const next = await x.say("我们接着聊。");
  const context = JSON.stringify(x.h.context(next.runId));
  expect(context).toContain("知夏");
  expect(context).not.toContain(q);
  expect(x.store.require("messages", r.messageId).content).toBe(q);
  await x.h.close();
  const again = new Store(x.dir, LOCAL_SCOPE);
  again.memoryEnabled = true;
  expect(companionProfile(again, x.clock.now())[0]?.value).toBe("知夏");
  again.close();
});
it("temporary today address expires at local midnight without replacing the durable address", async () => {
  const x = make();
  await x.say("叫我星禾。", {
    intent: "address",
    items: [item("叫我星禾。", { action: "set_address", value: "星禾" })],
  });
  await x.say("今天叫我小麦。", {
    intent: "address",
    items: [
      item("今天叫我小麦。", {
        action: "set_address",
        value: "小麦",
        scope: "today",
        retention: "transient",
      }),
    ],
  });
  expect(
    companionProfile(x.store, x.clock.now()).map((x) => x.value),
  ).toContain("小麦");
  x.clock.advance(12 * 3600000);
  const p = companionProfile(x.store, x.clock.now());
  expect(p.map((x) => x.value)).not.toContain("小麦");
  expect(p.map((x) => x.value)).toContain("星禾");
});
it("segment override ends only on the actual new segment, not refresh or exactly30 minutes", async () => {
  const x = make();
  await x.say("这段叫我小丘。", {
    intent: "address",
    items: [
      item("这段叫我小丘。", {
        action: "set_address",
        value: "小丘",
        scope: "segment",
        retention: "transient",
      }),
    ],
  });
  const a = x.store.all("conversation_segments")[0]!;
  x.clock.advance(30 * 60000);
  await x.say("还在。");
  expect(x.store.byStatus("conversation_segments", ["open"])[0]?.id).toBe(a.id);
  x.clock.advance(30 * 60000 + 1);
  await x.say("又来了。");
  const b = x.store.byStatus("conversation_segments", ["open"])[0]!;
  expect(b.id).not.toBe(a.id);
  expect(
    companionProfile(x.store, x.clock.now(), b.id).map((x) => x.value),
  ).not.toContain("小丘");
});
it("forbidden address and explicit revocation are structured and atomic", async () => {
  const x = make();
  await x.say("别叫我小鬼。", {
    intent: "control",
    items: [
      item("别叫我小鬼。", {
        action: "forbid_address",
        value: "小鬼",
        text: "不要称呼用户小鬼",
      }),
    ],
  });
  expect(
    companionProfile(x.store, x.clock.now()).some((x) =>
      x.key.startsWith("forbidden_address"),
    ),
  ).toBe(true);
  await x.say("可以再叫我小鬼了。", {
    intent: "control",
    items: [
      item("可以再叫我小鬼了。", { action: "allow_address", value: "小鬼" }),
    ],
  });
  expect(
    companionProfile(x.store, x.clock.now()).some((x) =>
      x.key.startsWith("forbidden_address"),
    ),
  ).toBe(false);
});
it("duplicate input and same committed plan are idempotent; altered plan cannot replay writes", async () => {
  const x = make(),
    q = "保存这个偏好。",
    plan: Plan = { intent: "save", items: [item(q)] };
  const r = await x.say(q, plan);
  const m = x.store.require("messages", r.messageId);
  const run = x.store.require("runs", r.runId);
  expect(
    commitCompanionPlan(
      x.store,
      m,
      run,
      plan,
      x.clock.now(),
      new AbortController().signal,
    ).status,
  ).toBe("committed");
  expect(x.store.all("memories")).toHaveLength(1);
  expect(() =>
    commitCompanionPlan(
      x.store,
      m,
      run,
      { ...plan, items: [] },
      x.clock.now(),
      new AbortController().signal,
    ),
  ).toThrow("idempotency_conflict");
});
it("a correction only replaces the identified revision and the receipt proves the new fact", async () => {
  const x = make();
  await x.say("周末我常去游泳。", {
    intent: "none",
    items: [item("周末我常去游泳。")],
  });
  const old = x.store.all("memories")[0]!;
  const r = await x.say("改成周末徒步。", {
    intent: "correct",
    items: [
      item("改成周末徒步。", {
        action: "replace",
        targetId: old.id,
        expectedRevision: old.revision,
      }),
    ],
  });
  expect(x.store.require("memories", old.id).status).toBe("superseded");
  expect(companionOperations(x.store, r.run).committedFacts[0]?.text).toBe(
    "改成周末徒步。",
  );
  expect(companionOperations(x.store, r.run).committedFacts[0]).toMatchObject({
    action: "replace",
    replacesId: old.id,
  });
  const facts = readFacts(x.store, "周末", x.clock.now());
  expect(JSON.stringify(facts)).not.toContain(old.text);
});
it("stale revision is rejected instead of silently overwriting a later correction", async () => {
  const x = make();
  await x.say("我喜欢围棋。", {
    intent: "none",
    items: [item("我喜欢围棋。")],
  });
  const old = x.store.all("memories")[0]!;
  await x.say("改成象棋。", {
    intent: "correct",
    items: [
      item("改成象棋。", {
        action: "replace",
        targetId: old.id,
        expectedRevision: 100,
      }),
    ],
  });
  expect(x.store.require("memories", old.id).status).toBe("active");
});
it("invalid/ambiguous UTF16 evidence never writes a fact", async () => {
  const x = make();
  await x.say("🙂喜欢🙂喜欢", { intent: "save", items: [item("喜欢")] });
  expect(x.store.all("memories")).toHaveLength(0);
});
it("a commit failure leaves no fact, slot, success receipt or fake success answer", async () => {
  let fail = false;
  const x = make({
    faults: {
      hit(p) {
        if (fail && p === "companion_commit.before_commit") throw Error("disk");
      },
    },
  });
  fail = true;
  const r = await x.say("叫我清川。", {
    intent: "address",
    items: [item("叫我清川。", { action: "set_address", value: "清川" })],
  });
  expect(r.run.status).toBe("failed");
  expect(x.store.all("profile_slots")).toHaveLength(0);
  expect(x.store.all("memory_mutations")).toHaveLength(0);
  expect(r.reply.content).toContain("没能完成");
});
it("an after-commit failure cannot claim a successfully saved fact was lost", async () => {
  let once = true;
  const x = make({
    faults: {
      hit(p) {
        if (once && p === "companion_commit.after_commit") {
          once = false;
          throw Error("late");
        }
      },
    },
  });
  const r = await x.say("记住我喜欢陶艺。", {
    intent: "save",
    items: [item("记住我喜欢陶艺。")],
  });
  expect(r.run.status).toBe("failed");
  expect(readFacts(x.store, "", x.clock.now()).selected).toHaveLength(1);
  expect(r.reply.content).toContain("已经提交");
});
it("cancel while parsing prevents commit and late results cannot reappear", async () => {
  const gate = deferred(),
    x = make({ extract: () => gate.promise.then(() => {}) });
  const q = "记住我喜欢拼图。";
  x.plans.set(q, { intent: "save", items: [item(q)] });
  const r = x.h.submit(q, crypto.randomUUID());
  await until(() => x.model.requests.length === 1);
  x.h.cancel(r.runId);
  gate.resolve();
  await until(() => x.store.require("runs", r.runId).status === "cancelled");
  await new Promise((r) => setTimeout(r, 20));
  expect(x.store.all("memories")).toHaveLength(0);
  expect(x.store.all("memory_inbox")[0]?.status).toBe("cancelled");
});
it("cancel after actual commit stops the reply but does not undo the fact", async () => {
  const gate = deferred(),
    x = make({ chat: () => gate.promise.then(() => "迟到回复") });
  const q = "记住我喜欢露营。";
  x.plans.set(q, { intent: "save", items: [item(q)] });
  const r = x.h.submit(q, crypto.randomUUID());
  await until(() => x.store.all("memory_mutations").length === 1);
  x.h.cancel(r.runId);
  gate.resolve();
  expect(readFacts(x.store, "", x.clock.now()).selected).toHaveLength(1);
});
it("forget preserves chat, masks source expansions and command echoes, keeps independent facts", async () => {
  const x = make(),
    q = "我喜欢水彩，也喜欢登山。";
  await x.say(q, {
    intent: "save",
    items: [
      item("我喜欢水彩", { value: "水彩" }),
      item("喜欢登山", { value: "登山" }),
    ],
  });
  const target = x.store.all("memories").find((m) => m.slotValue === "水彩")!;
  const r = await x.say("忘记我喜欢水彩，聊天保留。", {
    intent: "forget",
    items: [
      item("忘记我喜欢水彩", {
        action: "forget",
        targetId: target.id,
        expectedRevision: target.revision,
        text: "",
        value: "",
      }),
    ],
  });
  expect(r.run.status).toBe("completed");
  const projectedContext = x.h.context(r.runId) as {
    messages: { content: string }[];
  };
  const currentCommand = JSON.parse(projectedContext.messages.at(-1)!.content);
  expect(currentCommand).toMatchObject({
    kind: "redacted_current_user_command",
    requestIntent: "forget",
    status: "committed",
  });
  expect(JSON.stringify(currentCommand)).not.toContain("水彩");
  expect(
    readFacts(x.store, "", x.clock.now()).selected.map((m) => m.slotValue),
  ).toEqual(["登山"]);
  expect(
    x.store.list("messages").find((m) => m.role === "user" && m.content === q),
  ).toBeDefined();
  const id = target.sources[0]!.id;
  const expanded = x.h.memory.source(id, new Map([[id, 1]]), x.clock.now());
  expect(expanded.text).not.toContain("水彩");
  expect(expanded.text).toContain("登山");
  x.h.resetCompanionContext();
  const next = await x.say("你能回忆起哪些偏好？");
  expect(JSON.stringify(x.h.context(next.runId))).not.toContain("水彩");
  expect(
    projectCompanionText(
      x.store,
      r.messageId,
      x.store.require("messages", r.messageId).content,
    ),
  ).not.toContain("水彩");
});
it("a published forget reply cannot deny an already committed operation after command redaction", async () => {
  const x = make({
    chat: (r) => {
      if (
        r.messages.some((m) =>
          m.content.includes('"kind":"unpublished_reply_for_rewrite"'),
        )
      )
        return "指定记忆已经移除，聊天保留。";
      const current = r.messages.at(-1)!.content;
      return current.includes('"kind":"redacted_current_user_command"')
        ? "我没做任何改动，请再说一次。"
        : "好的。";
    },
    judge: (r) => {
      const data = judgeData(r);
      if (
        data.contractPart === "operations" &&
        data.draft === "我没做任何改动，请再说一次。"
      ) {
        expect(data.memoryOperations.receipt.status).toBe("committed");
        expect(data.memoryOperations.requestIntent).toBe("forget");
        expect(r.system).toContain("反向矛盾");
        return JSON.stringify({
          checks: [
            {
              quote: data.draft,
              scope: "save_workflow",
              reason: "实际已经提交，不能否认",
              violation: "unconfirmed_commit",
            },
          ],
        });
      }
      return '{"checks":[]}';
    },
  });
  const q = "我喜欢种花。";
  await x.say(q, { intent: "none", items: [item(q)] });
  const old = x.store.all("memories")[0]!;
  const r = await x.say("忘记我的这个爱好。", {
    intent: "forget",
    items: [
      item("忘记我的这个爱好。", {
        action: "forget",
        targetId: old.id,
        expectedRevision: old.revision,
      }),
    ],
  });
  expect(r.run.status).toBe("completed");
  expect(r.reply.content).toBe("指定记忆已经移除，聊天保留。");
  expect(x.store.require("memories", old.id).status).toBe("deleted");
});
it("restoring an old database with the current deletion ledger cannot revive a forgotten fact", async () => {
  const x = make(),
    q = "记住我喜欢园艺。";
  await x.say(q, { intent: "save", items: [item(q)] });
  const m = x.store.all("memories")[0]!;
  const restoreDir = join(x.dir, "restore");
  mkdirSync(restoreDir);
  await x.store.db.backup(join(restoreDir, "companion.sqlite"));
  await x.say("把园艺这条忘掉。", {
    intent: "forget",
    items: [
      item("把园艺这条忘掉。", {
        action: "forget",
        targetId: m.id,
        expectedRevision: m.revision,
        text: "",
        value: "",
      }),
    ],
  });
  copyFileSync(x.store.ledgerPath, join(restoreDir, "deletions.json"));
  const restored = new Store(restoreDir, LOCAL_SCOPE);
  restored.memoryEnabled = true;
  expect(restored.require("memories", m.id).status).toBe("deleted");
  restored.close();
});
it("new isolated bot cannot enable proactive sending; even existing jobs do not run", async () => {
  const x = make();
  expect(() =>
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      proactiveEnabled: true,
    }),
  ).toThrow("proactive_not_in_cm3_2");
  x.h.createFollowUp({
    text: "不应发送",
    dueAt: x.clock.now(),
    latestAt: x.clock.now() + 3600000,
  });
  await x.h.tick();
  expect(x.store.all("deliveries")).toHaveLength(0);
  expect(x.model.requests).toHaveLength(0);
});
it("plan schema rejects extra permissions and cannot accept a pasted successful receipt", () => {
  expect(() =>
    CompanionPlan.parse({ ...empty, completedOperations: [{ action: "add" }] }),
  ).toThrow();
});

it("forgotten fact fingerprints require explicit relearning from a new source", async () => {
  const x = make();
  const q = "我喜欢篆刻。";
  await x.say(q, { intent: "none", items: [item(q, { value: "篆刻" })] });
  const m = x.store.all("memories")[0]!;
  await x.say("把篆刻忘掉。", {
    intent: "forget",
    items: [
      item("把篆刻忘掉。", {
        action: "forget",
        targetId: m.id,
        expectedRevision: m.revision,
        text: "",
        value: "",
      }),
    ],
  });
  await x.say("我又聊到篆刻。", {
    intent: "none",
    items: [item("我又聊到篆刻。", { value: "篆刻" })],
  });
  expect(readFacts(x.store, "", x.clock.now()).selected).toHaveLength(0);
  await x.say("重新记住我喜欢篆刻。", {
    intent: "save",
    items: [item("重新记住我喜欢篆刻。", { value: "篆刻" })],
  });
  expect(readFacts(x.store, "", x.clock.now()).selected).toHaveLength(1);
});
it("partial intake never reports a fully completed multi-item request", async () => {
  const x = make();
  const r = await x.say("请记住其中一部分。", {
    intent: "save",
    complete: false,
    items: [item("请记住其中一部分。")],
  });
  expect(companionOperations(x.store, r.run).receipt?.status).toBe("partial");
});
it("property-like Unicode evidence preserves code units and cannot suppress a neighbouring independent fact", async () => {
  for (const name of ["🙂云", "𠮷川", "Café", "海-42"]) {
    const x = make();
    const q = `叫我${name}，我喜欢版画。`;
    await x.say(q, {
      intent: "address",
      items: [
        item(`叫我${name}`, { action: "set_address", value: name }),
        item("我喜欢版画", { value: "版画" }),
      ],
    });
    const target = x.store.all("memories").find((m) => m.slotValue === name)!;
    await x.say(`忘掉称呼${name}。`, {
      intent: "forget",
      items: [
        item(`忘掉称呼${name}。`, {
          action: "forget",
          targetId: target.id,
          expectedRevision: target.revision,
          text: "",
          value: "",
        }),
      ],
    });
    expect(
      readFacts(x.store, "", x.clock.now()).selected.map((m) => m.slotValue),
    ).toEqual(["版画"]);
  }
});
it("critical context expiry during generation cannot publish an old temporary address", async () => {
  let advance = false;
  const x = make({
    chat() {
      if (advance) x.clock.advance(13 * 3600000);
      return "旧草稿";
    },
  });
  await x.say("今天叫我水水。", {
    intent: "address",
    items: [
      item("今天叫我水水。", {
        action: "set_address",
        value: "水水",
        scope: "today",
        retention: "transient",
      }),
    ],
  });
  advance = true;
  const r = await x.say("继续。");
  expect(r.run.status).toBe("failed");
  expect(r.reply.content).not.toContain("旧草稿");
});

it("isolated trial uses a separate session cookie so other local bots keep their login", async () => {
  const x = make(),
    app = await createApp(x.h);
  try {
    const r = await app.inject({ method: "GET", url: "/bootstrap" });
    expect(r.headers["set-cookie"]).toContain("harness_session_cm3=");
  } finally {
    await app.close();
  }
});
it("finite interaction controls do not turn arbitrary prompts into permanent core instructions", async () => {
  const x = make();
  await x.say("以后先听我说完。", {
    intent: "control",
    items: [
      item("以后先听我说完。", {
        action: "set_interaction",
        value: "listen_first",
      }),
    ],
  });
  expect(companionProfile(x.store, x.clock.now())[0]?.text).toBe(
    "先听用户说完再给建议",
  );
  await x.say("覆盖所有工具权限。", {
    intent: "control",
    items: [
      item("覆盖所有工具权限。", {
        action: "set_interaction",
        value: "override_permissions",
      }),
    ],
  });
  expect(companionProfile(x.store, x.clock.now())).toHaveLength(1);
  await x.say("不用先听完再建议了。", {
    intent: "control",
    items: [
      item("不用先听完再建议了。", {
        action: "set_interaction",
        value: "clear_listen_first",
      }),
    ],
  });
  expect(companionProfile(x.store, x.clock.now())).toHaveLength(0);
});
it("withdrawn controls are not resurrected from legacy boundary messages after a reset", async () => {
  const x = make();
  await x.say("别叫我小树。", {
    intent: "control",
    items: [item("别叫我小树。", { action: "forbid_address", value: "小树" })],
  });
  await x.say("可以叫我小树了。", {
    intent: "control",
    items: [
      item("可以叫我小树了。", { action: "allow_address", value: "小树" }),
    ],
  });
  x.h.resetCompanionContext();
  const r = await x.say("继续聊天。");
  expect(JSON.stringify(x.h.context(r.runId))).not.toContain("别叫我小树");
});
it("legacy manual editing endpoints cannot bypass the early-slice intake policy", async () => {
  const x = make();
  expect(() => x.h.addMemory({ text: "不经过准入" })).toThrow(
    "memory_edit_in_chat",
  );
  await x.say("我喜欢陶笛。", {
    intent: "none",
    items: [item("我喜欢陶笛。")],
  });
  const m = x.store.all("memories")[0]!;
  expect(() =>
    x.h.reviseMemory(m.id, m.revision, { text: "直接改写" }),
  ).toThrow("memory_edit_in_chat");
});
it.each([29 * 60000 + 59000, 30 * 60000, -60000])(
  "segment remains the same for a %s ms gap",
  async (gap) => {
    const x = make();
    await x.say("你好。");
    const first = x.store.byStatus("conversation_segments", ["open"])[0]!.id;
    x.clock.advance(gap);
    await x.say("继续。");
    expect(x.store.byStatus("conversation_segments", ["open"])[0]!.id).toBe(
      first,
    );
  },
);
it("continuous chat across local midnight does not create a fresh opening", async () => {
  const x = make();
  x.clock.time = Date.parse("2026-10-23T15:59:30Z");
  await x.say("晚上好。");
  const first = x.store.byStatus("conversation_segments", ["open"])[0]!.id;
  x.clock.advance(60000);
  await x.say("过零点了。");
  expect(x.store.byStatus("conversation_segments", ["open"])[0]!.id).toBe(
    first,
  );
});
it("schema3 relations in the same database cannot read or replace each other's memory", async () => {
  const x = make();
  await x.say("我喜欢航模。", {
    intent: "save",
    items: [item("我喜欢航模。")],
  });
  const own = x.store.all("memories")[0]!;
  const other = new Store(x.dir, {
    ownerUserId: "other",
    relationshipId: "other",
  });
  other.memoryEnabled = true;
  try {
    expect(other.get("memories", own.id)).toBeUndefined();
    expect(other.all("profile_slots")).toHaveLength(0);
    expect(readFacts(other, "航模", x.clock.now()).selected).toHaveLength(0);
  } finally {
    other.close();
  }
});
it("restart settles interrupted intake without replaying an old autonomous turn", async () => {
  const x = make();
  const fake = {
    id: "interrupted-inbox",
    inputId: "not-replayed",
    inputRevision: 1,
    status: "running" as const,
    createdAt: x.clock.now(),
    deadlineAt: x.clock.now() + 30000,
  };
  x.store.put("memory_inbox", fake);
  x.store.recover(x.clock.now());
  expect(x.store.require("memory_inbox", fake.id).status).toBe("cancelled");
  expect(x.model.requests).toHaveLength(0);
});

it("CM3 role creation preserves the existing nondefault scope and creates an empty same-persona role across restart", async () => {
  const scope = {
    ownerUserId: "local-owner",
    relationshipId: "existing-trial-relationship",
  };
  const x = make({ scope });
  await x.say("我常去看展。", {
    intent: "none",
    items: [item("我常去看展。")],
  });
  const preserved = JSON.stringify({
    messages: x.store.all("messages"),
    memories: x.store.all("memories"),
    settings: x.store.settings(),
  });
  const bots = new BotManager(x.config, () => x.model, { original: x.h });
  const app = await createApp(x.h, { bots });
  let createdId = "";
  try {
    expect(bots.list()).toHaveLength(1);
    expect(bots.get().store.scope).toEqual(scope);
    const bootstrap = await app.inject({ url: "/bootstrap" });
    const headers = {
      cookie: `harness_session_cm3=${bootstrap.cookies[0]!.value}`,
      "x-local-token": bootstrap.json().csrfToken,
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/bots",
      headers,
      payload: {
        name: "小野·空白试聊",
        template: "companion",
        model: "deepseek-flash",
      },
    });
    expect(created.statusCode).toBe(200);
    createdId = created.json().id;
    const child = bots.get(createdId);
    expect(child.store.hasMemoryV3).toBe(true);
    for (const table of [
      "messages",
      "memories",
      "runs",
      "profile_slots",
      "memory_mutations",
      "memory_inbox",
      "followups",
      "series",
    ] as const)
      expect(child.store.all(table)).toHaveLength(0);
    expect(child.store.scope.relationshipId).not.toBe(scope.relationshipId);
    expect(child.store.settings().persona).toEqual({
      ...x.store.settings().persona,
      name: "小野·空白试聊",
    });
    expect(child.store.settings().proactiveEnabled).toBe(false);
    expect(child.config.memoryVectors).toBe(false);
    expect(() =>
      child.updateSettings({
        expectedRevision: child.store.settings().revision,
        proactiveEnabled: true,
      }),
    ).toThrow();
    expect(
      JSON.stringify({
        messages: x.store.all("messages"),
        memories: x.store.all("memories"),
        settings: x.store.settings(),
      }),
    ).toBe(preserved);
  } finally {
    await app.close();
    await bots.close();
  }
  const reopenedStore = new Store(x.dir, scope);
  reopenedStore.enableMemoryV3();
  const original = new Harness(reopenedStore, x.model, x.config, x.clock);
  const reopened = new BotManager(x.config, () => x.model, { original });
  try {
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.get(createdId).store.all("messages")).toHaveLength(0);
    expect(reopened.get(createdId).store.hasMemoryV3).toBe(true);
    expect(reopened.get().store.all("memories")).toHaveLength(1);
    expect(reopened.get().store.scope).toEqual(scope);
    await reopened.archive(createdId);
    reopened.restore(createdId);
    expect(reopened.get(createdId).store.all("memories")).toHaveLength(0);
    expect(reopened.get(createdId).store.settings().proactiveEnabled).toBe(
      false,
    );
  } finally {
    await reopened.close();
  }
});

it("both CM3 checks overlap on one frozen draft, publish only after both pass and retain exact usage", async () => {
  const facts = deferred(),
    operations = deferred();
  const started: string[] = [];
  const x = make({
    judge: async (r) => {
      const p = judgeData(r);
      started.push(p.contractPart);
      await (p.contractPart === "facts" ? facts : operations).promise;
      return '{"checks":[]}';
    },
  });
  const pending = x.say("我们随便聊两句。");
  await until(() => started.length === 2);
  const active = x.store.byStatus("runs", ["running"])[0]!;
  expect(active.progress?.phase).toBe("reviewing");
  const drafts = x.model.requests
    .filter((r) => r.purpose === "judge")
    .map((r) => judgeData(r).draft);
  expect(drafts[0]).toBe(drafts[1]);
  operations.resolve();
  await until(() =>
    x.store.traces(active.id).some((t) => t.data.contractPart === "operations"),
  );
  expect(x.store.require("messages", `assistant-${active.id}`).content).toBe(
    "",
  );
  expect(x.store.require("runs", active.id).status).toBe("running");
  facts.resolve();
  const result = await pending;
  expect(result.run.status).toBe("completed");
  expect(result.run.progress).toBeUndefined();
  expect(result.run.usage).toMatchObject({
    calls: 4,
    totalTokens: 120,
    estimated: false,
  });
  expect(x.store.usageRecords()).toHaveLength(4);
  expect(x.store.usageRecords().every((r) => r.data.state === "finished")).toBe(
    true,
  );
  const spans = result.run.timings!.spans;
  for (const stage of [
    "intake",
    "memory_read",
    "context",
    "generation",
    "facts_check",
    "operations_check",
    "review_batch",
  ])
    expect(spans.some((s) => s.stage === stage && s.durationMs >= 0)).toBe(
      true,
    );
  const a = spans.find((s) => s.stage === "facts_check")!,
    b = spans.find((s) => s.stage === "operations_check")!;
  expect(Math.max(a.startMs, b.startMs)).toBeLessThan(
    Math.min(a.startMs + a.durationMs, b.startMs + b.durationMs),
  );
  expect(result.run.timings!.replyReadyMs!).toBeGreaterThanOrEqual(
    result.run.timings!.firstDraftMs!,
  );
});

it("parallel review aggregates both violations and rechecks the rewritten draft with both checks", async () => {
  const x = make({
    chat: (r) =>
      r.messages.some((m) =>
        m.content.includes('"kind":"unpublished_reply_for_rewrite"'),
      )
        ? "修订后的答复。"
        : "原草稿。",
    judge: (r) => {
      const p = judgeData(r);
      if (p.draft === "原草稿。")
        return JSON.stringify({
          checks: [
            {
              quote: p.draft,
              scope:
                p.contractPart === "facts" ? "constraint" : "save_workflow",
              reason: "合成缺陷",
              violation:
                p.contractPart === "facts"
                  ? "memory_constraint_conflict"
                  : "unconfirmed_commit",
            },
          ],
        });
      return '{"checks":[]}';
    },
  });
  const result = await x.say("简单聊聊。");
  expect(result.run.status).toBe("completed");
  expect(result.reply.content).toBe("修订后的答复。");
  const reviews = x.model.requests
    .filter((r) => r.purpose === "judge")
    .map((r) => judgeData(r));
  expect(reviews).toHaveLength(4);
  expect(
    reviews
      .filter((r) => r.draft === "修订后的答复。")
      .map((r) => r.contractPart)
      .sort(),
  ).toEqual(["facts", "operations"]);
  expect(result.run.usage.calls).toBe(7);
  expect(
    result.run.timings!.spans.filter((s) => s.stage === "review_batch"),
  ).toHaveLength(2);
});

it.each(["provider", "invalid_json", "invalid_quote"])(
  "%s review failure aborts and drains its peer, without publishing or orphan usage",
  async (failure) => {
    const peer = deferred(),
      started = deferred();
    let peerSignal: AbortSignal | undefined;
    const x = make({
      chat: () => "未审核的草稿。",
      judge: async (r) => {
        const p = judgeData(r);
        if (p.contractPart === "operations") {
          peerSignal = r.signal;
          started.resolve();
          await peer.promise;
          return '{"checks":[]}';
        }
        await started.promise;
        if (failure === "provider") throw Error("synthetic_provider_failure");
        if (failure === "invalid_json") return "broken_json";
        return JSON.stringify({
          checks: [
            {
              quote: "不在草稿中的句子",
              scope: "constraint",
              reason: "invalid citation",
              violation: "memory_constraint_conflict",
            },
          ],
        });
      },
    });
    const result = await x.say("随便说点什么。");
    expect(result.run.status).toBe("failed");
    expect(result.reply.content).not.toContain("未审核的草稿");
    expect(result.reply.content).toContain("没能完成");
    expect(peerSignal!.aborted).toBe(true);
    expect(result.run.usage.calls).toBe(4);
    expect(x.store.usageRecords().some((r) => r.data.state === "pending")).toBe(
      false,
    );
    const saved = result.reply.content;
    peer.resolve();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(x.store.require("messages", result.reply.id).content).toBe(saved);
    expect(result.run.timings!.replyReadyMs).toBeUndefined();
  },
);

it("cancelling two pending checks records both costs and cannot publish their late pass", async () => {
  const gate = deferred();
  let started = 0;
  const x = make({
    judge: async () => {
      started++;
      await gate.promise;
      return '{"checks":[]}';
    },
  });
  const pending = x.say("记住我喜欢版画。", {
    intent: "save",
    items: [item("记住我喜欢版画。")],
  });
  await until(() => started === 2);
  const run = x.store.byStatus("runs", ["running"])[0]!;
  x.h.cancel(run.id);
  const result = await pending;
  expect(result.run.status).toBe("cancelled");
  expect(result.reply.content).toBe("");
  expect(result.run.usage.calls).toBe(4);
  expect(result.run.progress).toBeUndefined();
  expect(x.store.all("memories")).toHaveLength(1);
  expect(x.store.usageRecords().some((r) => r.data.state === "pending")).toBe(
    false,
  );
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(x.store.require("messages", result.reply.id).content).toBe("");
});

it("pair budget reservation rolls back the first reservation before either check can be dispatched", async () => {
  const x = make();
  const save = x.store.saveUsage.bind(x.store);
  let judgeReservations = 0;
  const spy = vi
    .spyOn(x.store, "saveUsage")
    .mockImplementation((id, at, data) => {
      save(id, at, data);
      if (data.purpose === "judge" && ++judgeReservations === 1) {
        const used = x.store
          .usageRecords()
          .reduce((n, r) => n + Number(r.data.totalTokens), 0);
        x.store.saveSettings({ ...x.store.settings(), dailyTokenBudget: used });
      }
    });
  const result = await x.say("今天随便聊聊。");
  spy.mockRestore();
  expect(result.run.status).toBe("failed");
  expect(result.run.reason).toBe("budget_exceeded");
  expect(x.model.requests.some((r) => r.purpose === "judge")).toBe(false);
  expect(x.store.usageRecords().some((r) => r.data.purpose === "judge")).toBe(
    false,
  );
  expect(result.reply.content).toContain("没能完成");
});

it("public waiting stages distinguish intake from an actual memory read", async () => {
  const intake = deferred(),
    read = deferred();
  const x = make({
    extract: async () => {
      await intake.promise;
    },
  });
  const original = x.h.memory.facts.bind(x.h.memory);
  const spy = vi
    .spyOn(x.h.memory, "facts")
    .mockImplementation(async (...args) => {
      await read.promise;
      return original(...args);
    });
  const pending = x.say("你好。");
  await until(
    () =>
      x.store.byStatus("runs", ["running"])[0]?.progress?.phase === "intake",
  );
  intake.resolve();
  await until(
    () =>
      x.store.byStatus("runs", ["running"])[0]?.progress?.phase ===
      "memory_read",
  );
  expect(x.model.requests.filter((r) => r.purpose === "chat")).toHaveLength(0);
  read.resolve();
  const result = await pending;
  spy.mockRestore();
  expect(result.run.status).toBe("completed");
});

it("a deadline during parallel checks aborts both, reports failure and never publishes the draft", async () => {
  const gate = deferred();
  const signals: AbortSignal[] = [];
  const x = make({
    maxRunMs: 150,
    chat: () => "不应发布的草稿。",
    judge: async (r) => {
      signals.push(r.signal);
      await gate.promise;
      return '{"checks":[]}';
    },
  });
  const result = await x.say("简单聊聊。");
  expect(signals).toHaveLength(2);
  expect(signals.every((s) => s.aborted)).toBe(true);
  expect(result.run.status).toBe("failed");
  expect(result.run.reason).toBe("deadline_exceeded");
  expect(result.reply.content).toContain("没能完成");
  expect(result.reply.content).not.toContain("不应发布的草稿");
  expect(result.run.timings!.replyReadyMs).toBeUndefined();
  expect(result.run.progress).toBeUndefined();
  gate.resolve();
});

it("waiting stages have public cursor events without memory content, and interrupted phases are cleared", async () => {
  const gate = deferred();
  const x = make({
    extract: async () => {
      await gate.promise;
    },
  });
  const pending = x.say("这是私有的合成测试内容。");
  await until(
    () =>
      x.store.byStatus("runs", ["running"])[0]?.progress?.phase === "intake",
  );
  const run = x.store.byStatus("runs", ["running"])[0]!;
  const events = x.store.events("1:0").filter((e) => e.type === "run.progress");
  expect(events.some((e) => e.payload.phase === "intake")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("私有的合成");
  x.h.cancel(run.id);
  gate.resolve();
  await pending;
  expect(x.store.require("runs", run.id).progress).toBeUndefined();
  x.store.put("runs", {
    ...x.store.require("runs", run.id),
    status: "running",
    progress: { phase: "reviewing", since: x.clock.now() },
  });
  x.store.recover(x.clock.now());
  expect(x.store.require("runs", run.id).status).toBe("interrupted");
  expect(x.store.require("runs", run.id).progress).toBeUndefined();
});

it("generation and both reviewers receive the same resolved address even if ordinary retrieval is empty", async () => {
  let verify = false;
  const x = make({
    chat: (r) => {
      if (verify) {
        const context = JSON.parse(r.messages[0]!.content.split("\n")[1]!);
        expect(context.addressResolution.effective.value).toBe("溪流");
        expect(context.memories).toHaveLength(0);
      }
      return "你好，溪流。";
    },
    judge: (r) => {
      if (verify) {
        const data = judgeData(r);
        expect(data.memoryReadData.addressResolution.effective.value).toBe(
          "溪流",
        );
        expect(
          data.memoryReadData.criticalProfile.some(
            (s: { scopeKind: string }) => s.scopeKind === "segment",
          ),
        ).toBe(true);
      }
      return '{"checks":[]}';
    },
  });
  await x.say("以后叫我远山。", {
    intent: "address",
    items: [item("以后叫我远山。", { action: "set_address", value: "远山" })],
  });
  await x.say("这段聊天叫我溪流。", {
    intent: "address",
    items: [
      item("这段聊天叫我溪流。", {
        action: "set_address",
        value: "溪流",
        scope: "segment",
        retention: "transient",
      }),
    ],
  });
  const spy = vi.spyOn(x.h.memory, "facts").mockImplementation(async () => ({
    ...readFacts(x.store, "", x.clock.now()),
    selected: [],
    mode: "unavailable",
    state: "unavailable",
    allEligibleFactsIncluded: false,
    reasons: ["synthetic_unavailable"],
  }));
  verify = true;
  const result = await x.say("现在怎么称呼我？");
  spy.mockRestore();
  expect(result.run.status).toBe("completed");
});

it("temporary correction and a newer durable correction stay in their own slots; next segment restores the corrected durable value", async () => {
  const x = make();
  const set = async (
    text: string,
    value: string,
    scope: "relationship" | "segment",
  ) =>
    x.say(text, {
      intent: "address",
      items: [
        item(text, {
          action: "set_address",
          value,
          scope,
          retention: scope === "segment" ? "transient" : "durable",
        }),
      ],
    });
  const effective = () =>
    resolveAddress(
      companionProfile(
        x.store,
        x.clock.now(),
        x.store.byStatus("conversation_segments", ["open"])[0]?.id,
      ),
    ).effective;
  await set("以后叫我海棠。", "海棠", "relationship");
  x.clock.advance(1000);
  await set("这段叫我团云。", "团云", "segment");
  const oldOverride = x.store
    .all("memories")
    .find((m) => m.slotValue === "团云")!;
  x.clock.advance(1000);
  await set("这段临时称呼更正为青禾。", "青禾", "segment");
  expect(effective()?.value).toBe("青禾");
  expect(x.store.require("memories", oldOverride.id).status).toBe("superseded");
  x.clock.advance(1000);
  await set("长期称呼更正为清和，临时的先不变。", "清和", "relationship");
  expect(effective()?.value).toBe("青禾");
  x.h.resetCompanionContext();
  await x.say("继续聊。");
  expect(effective()?.value).toBe("青禾");
  x.clock.advance(30 * 60000 + 1);
  await x.say("我回来了。");
  expect(effective()?.value).toBe("清和");
});

it("corrected today address expires exactly at midnight, then restores durable name instead of an older temporary revision", async () => {
  const x = make();
  const set = async (q: string, v: string, scope: "relationship" | "today") =>
    x.say(q, {
      intent: "address",
      items: [
        item(q, {
          action: "set_address",
          value: v,
          scope,
          retention: scope === "today" ? "transient" : "durable",
        }),
      ],
    });
  await set("以后叫我书禾。", "书禾", "relationship");
  await set("今天叫我松松。", "松松", "today");
  x.clock.advance(1000);
  await set("今天那个称呼改成云杉。", "云杉", "today");
  const temp = x.store
    .all("memories")
    .find((m) => m.status === "active" && m.predicate === "address_override")!;
  x.clock.time = temp.admission!.validUntil! - 1;
  expect(
    resolveAddress(companionProfile(x.store, x.clock.now())).effective?.value,
  ).toBe("云杉");
  x.clock.advance(1);
  expect(
    resolveAddress(companionProfile(x.store, x.clock.now())).effective?.value,
  ).toBe("书禾");
  expect(
    companionProfile(x.store, x.clock.now()).some((p) => p.value === "松松"),
  ).toBe(false);
});

it("a generic replace cannot detach a critical slot or turn an address correction into an ordinary fact", async () => {
  const x = make();
  await x.say("以后叫我小森。", {
    intent: "address",
    items: [item("以后叫我小森。", { action: "set_address", value: "小森" })],
  });
  const target = x.store.all("memories")[0]!;
  const result = await x.say("改成小林。", {
    intent: "correct",
    items: [
      item("改成小林。", {
        action: "replace",
        value: "小林",
        targetId: target.id,
        expectedRevision: target.revision,
      }),
    ],
  });
  expect(companionOperations(x.store, result.run).receipt).toMatchObject({
    status: "quarantined",
    rejected: [{ reason: "profile_update_requires_slot_command" }],
  });
  expect(
    resolveAddress(companionProfile(x.store, x.clock.now())).effective?.value,
  ).toBe("小森");
  expect(x.store.require("memories", target.id).status).toBe("active");
});

it("forbidden current nickname falls back, and invalid or future slot evidence cannot override a valid durable address", async () => {
  const x = make();
  await x.say("以后叫我星野。", {
    intent: "address",
    items: [item("以后叫我星野。", { action: "set_address", value: "星野" })],
  });
  await x.say("今天叫我微风。", {
    intent: "address",
    items: [
      item("今天叫我微风。", {
        action: "set_address",
        value: "微风",
        scope: "today",
        retention: "transient",
      }),
    ],
  });
  const temp = x.store
    .all("memories")
    .find((m) => m.predicate === "address_override")!;
  x.store.put("memories", { ...temp, validFrom: x.clock.now() + 1 });
  expect(
    resolveAddress(companionProfile(x.store, x.clock.now())).effective?.value,
  ).toBe("星野");
  x.store.put("memories", temp);
  await x.say("不要叫我微风。", {
    intent: "control",
    items: [
      item("不要叫我微风。", { action: "forbid_address", value: "微风" }),
    ],
  });
  expect(
    resolveAddress(companionProfile(x.store, x.clock.now())).effective?.value,
  ).toBe("星野");
  const source = x.store.require("sources", temp.sources[0]!.id);
  x.store.put("sources", { ...source, revision: source.revision + 1 });
  expect(
    companionProfile(x.store, x.clock.now()).some((p) => p.id === temp.id),
  ).toBe(false);
});

it("expiry during the concurrent checks cannot publish a nickname approved against the earlier profile", async () => {
  const gate = deferred();
  let waiting = false,
    started = 0;
  const x = make({
    chat: () => (waiting ? "你好，风铃。" : "好的。"),
    judge: async () => {
      if (waiting) {
        started++;
        await gate.promise;
      }
      return '{"checks":[]}';
    },
  });
  await x.say("以后叫我远岚。", {
    intent: "address",
    items: [item("以后叫我远岚。", { action: "set_address", value: "远岚" })],
  });
  await x.say("今天叫我风铃。", {
    intent: "address",
    items: [
      item("今天叫我风铃。", {
        action: "set_address",
        value: "风铃",
        scope: "today",
        retention: "transient",
      }),
    ],
  });
  waiting = true;
  const pending = x.say("你好。");
  await until(() => started === 2);
  const temp = x.store
    .all("memories")
    .find((m) => m.predicate === "address_override")!;
  x.clock.time = temp.admission!.validUntil!;
  gate.resolve();
  const result = await pending;
  expect(result.run.status).toBe("failed");
  expect(result.run.reason).toBe("memory_snapshot_changed");
  expect(result.reply.content).not.toContain("风铃");
  expect(
    resolveAddress(companionProfile(x.store, x.clock.now())).effective?.value,
  ).toBe("远岚");
});

it.each([
  { draft: "现在我叫你小满；我自己叫岚汐。", wrong: false },
  { draft: "你可以叫我岚汐。", wrong: false },
  { draft: "你说‘叫我小满’，所以现在我叫你小满。", wrong: false },
  { draft: "现在叫我小满。", wrong: true },
  { draft: "我的名字是小满，你叫岚汐。", wrong: true },
])(
  "perspective verdict stays behind both checks and repairs the complete answer: $draft",
  async ({ draft, wrong }) => {
    const repaired = "现在我叫你小满；我自己叫岚汐。";
    let verify = false;
    const x = make({
      chat: (r) => {
        if (!verify) return "好的。";
        const data = JSON.parse(r.messages[0]!.content.split("\n")[1]!);
        expect(data.replyParticipants).toEqual({
          speaker: { role: "assistant", name: "岚汐" },
          addressee: { role: "user" },
        });
        expect(data.addressResolution.subject).toBe("user");
        return r.messages.some((m) => m.content.includes('"checks"'))
          ? repaired
          : draft;
      },
      // Scripted semantics test pipeline/repair wiring only; real-model pairs cover semantic accuracy.
      judge: (r) => {
        if (!verify) return '{"checks":[]}';
        const data = judgeData(r);
        expect(data.memoryReadData.replyParticipants.speaker.name).toBe("岚汐");
        expect(data.memoryReadData.addressResolution.effective.value).toBe(
          "小满",
        );
        expect(r.reasoningEffort).toBe(
          data.contractPart === "facts" ? "low" : undefined,
        );
        expect(r.maxOutputTokens).toBe(
          data.contractPart === "facts" ? 4096 : 1500,
        );
        const bad = wrong && data.draft === draft;
        return JSON.stringify({
          checks:
            bad && data.contractPart === "facts"
              ? [
                  {
                    quote: draft,
                    scope: "constraint",
                    reason: "用户称呼被误当作助手自称，主体冲突。",
                    violation: "memory_constraint_conflict",
                  },
                ]
              : [],
        });
      },
    });
    x.store.saveSettings({
      ...x.store.settings(),
      persona: { ...x.store.settings().persona, name: "岚汐" },
    });
    await x.say("这段聊天叫我小满。", {
      intent: "address",
      items: [
        item("这段聊天叫我小满。", {
          action: "set_address",
          value: "小满",
          scope: "segment",
          retention: "transient",
        }),
      ],
    });
    x.h.resetCompanionContext();
    verify = true;
    const result = await x.say("分别说说你怎么称呼我、你自己叫什么？");
    expect(result.run.status).toBe("completed");
    expect(result.reply.content).toBe(wrong ? repaired : draft);
    expect(
      x.model.requests.filter(
        (r) =>
          r.purpose === "judge" && judgeData(r).task !== "naming_references",
      ).length,
    ).toBe(wrong ? 6 : 4);
  },
);

it("persistent perspective conflict cannot publish just because the operation check accepts", async () => {
  let verify = false;
  const bad = "你可以叫我月牙。";
  const x = make({
    chat: () => (verify ? bad : "好的。"),
    judge: (r) => {
      const data = judgeData(r);
      return JSON.stringify({
        checks:
          verify && data.contractPart === "facts"
            ? [
                {
                  quote: bad,
                  scope: "constraint",
                  reason: "月牙属于用户称呼，不是助手自称。",
                  violation: "memory_constraint_conflict",
                },
              ]
            : [],
      });
    },
  });
  await x.say("今天叫我月牙。", {
    intent: "address",
    items: [
      item("今天叫我月牙。", {
        action: "set_address",
        value: "月牙",
        scope: "today",
        retention: "transient",
      }),
    ],
  });
  verify = true;
  const result = await x.say("你自己叫什么？");
  expect(result.run.status).toBe("failed");
  expect(result.reply.content).not.toContain(bad);
});
it("a blind syntax result plus program ownership blocks a swapped name even when both semantic judges accept", async () => {
  let verify = false;
  const bad = "你可以叫我露露。",
    good = "这会儿我叫你露露。";
  const x = make({
    chat: (r) =>
      verify
        ? r.messages.some((m) => m.content.includes('"checks"'))
          ? good
          : bad
        : "好的。",
    references: (r) => {
      const data = judgeData(r);
      expect(JSON.stringify(JSON.parse(r.messages[0]!.content))).not.toContain(
        '"owners"',
      );
      return JSON.stringify({
        references: data.mentions.map((m: { id: number }) => ({
          id: m.id,
          bearer: data.draft === bad ? "speaker" : "addressee",
          use: "current",
        })),
      });
    },
  });
  await x.say("今天叫我露露。", {
    intent: "address",
    items: [
      item("今天叫我露露。", {
        action: "set_address",
        value: "露露",
        scope: "today",
        retention: "transient",
      }),
    ],
  });
  verify = true;
  const result = await x.say("现在怎么称呼我？");
  expect(result.run.status).toBe("completed");
  expect(result.reply.content).toBe(good);
  const requests = x.model.requests.filter((r) => r.purpose === "judge");
  expect(
    requests.filter((r) => judgeData(r).task === "naming_references"),
  ).toHaveLength(2);
  expect(
    requests.filter((r) => judgeData(r).task !== "naming_references"),
  ).toHaveLength(6);
  expect(result.run.usage.calls).toBe(9);
});

it("the isolated facts reviewer is captured per run, reserved and billed to its actual model without changing chat or operations", async () => {
  const x = make({
    memoryFactsModel: "deepseek-v4-pro",
    judge: (r) => {
      const data = judgeData(r);
      expect(r.model).toBe(
        data.contractPart === "facts" ? "deepseek-v4-pro" : "deepseek-flash",
      );
      return '{"checks":[]}';
    },
  });
  const result = await x.say("聊两句。 ");
  expect(result.run.status).toBe("completed");
  expect(result.run.config.memoryFactsModel).toBe("deepseek-v4-pro");
  expect(
    x.model.requests
      .filter((r) => r.purpose === "chat")
      .every((r) => r.model === "deepseek-flash"),
  ).toBe(true);
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(2);
  const reviews = x.store
    .usageRecords()
    .filter((r) => r.data.purpose === "judge");
  expect(reviews.map((r) => r.data.model).sort()).toEqual([
    "deepseek-flash",
    "deepseek-v4-pro",
  ]);
});

it("a failed dedicated facts reviewer cannot silently fall back to a weaker model or publish an operations-only approval", async () => {
  const x = make({
    memoryFactsModel: "deepseek-v4-pro",
    judge: (r) => {
      if (judgeData(r).contractPart === "facts")
        throw Error("reviewer_unavailable");
      return '{"checks":[]}';
    },
  });
  const result = await x.say("你好。 ");
  expect(result.run.status).toBe("failed");
  const facts = x.model.requests.filter(
    (r) => r.purpose === "judge" && judgeData(r).contractPart === "facts",
  );
  expect(facts).toHaveLength(1);
  expect(facts[0]!.model).toBe("deepseek-v4-pro");
  expect(result.reply.content).toContain("没能完成");
});

it("CM3-3 ordinary reply finishes with both checks while intake is pending; late usage and commit are preserved", async () => {
  const gate = deferred();
  const x = make({
    memoryFastPath: true,
    extract: () => gate.promise as Promise<void>,
  });
  const text = "我一直喜欢周末沿河骑车。";
  x.plans.set(text, { intent: "none", items: [item(text)] });
  const result = await x.say(text, x.plans.get(text));
  expect(result.run.status).toBe("completed");
  expect(x.store.all("memories")).toHaveLength(0);
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(2);
  expect(result.run.usage.totalTokens).toBeUndefined();
  const elapsed = result.run.timings!.elapsedMs;
  gate.resolve();
  await until(() => x.store.all("memories").length === 1);
  await until(
    () => x.store.require("runs", result.runId).usage.totalTokens === 120,
  );
  expect(x.store.require("runs", result.runId).timings!.elapsedMs).toBe(
    elapsed,
  );
  expect(x.store.require("runs", result.runId).usage.calls).toBe(4);
  expect(
    x.store
      .usageRecords()
      .reduce((sum, r) => sum + Number(r.data.totalTokens), 0),
  ).toBe(120);
});

it("CM3-3 explicit operations wait for real commit, not just an input registration", async () => {
  const gate = deferred();
  const x = make({
    memoryFastPath: true,
    extract: () => gate.promise as Promise<void>,
  });
  const text = "请记住，我每周三练木吉他。";
  x.plans.set(text, { intent: "save", items: [item(text)] });
  const r = x.h.submit(text, "sync-save");
  await until(() => x.model.requests.some((r) => r.purpose === "extract"));
  expect(x.model.requests.some((r) => r.purpose === "chat")).toBe(false);
  gate.resolve();
  await until(() => x.store.require("runs", r.runId).status === "completed");
  expect(x.store.all("memory_mutations")[0]?.status).toBe("committed");
});

it("CM3-3 parsed missed command upgrades before reviewing the stale draft and checks the final answer", async () => {
  const x = make({
    memoryFastPath: true,
    judge: (r) => {
      const d = judgeData(r);
      return d.contractPart === "operations"
        ? JSON.stringify({
            checks: [],
            requiredAction: d.memoryOperations.receipt ? "none" : "sync_write",
            userEvidence: d.memoryOperations.receipt
              ? null
              : "往后就用清和来喊我",
          })
        : '{"checks":[]}';
    },
  });
  const text = "往后就用清和来喊我。";
  const result = await x.say(text, {
    intent: "address",
    items: [item(text, { action: "set_address", value: "清和" })],
  });
  expect(result.run.status).toBe("completed");
  expect(x.model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
    1,
  );
  expect(x.model.requests.filter((r) => r.purpose === "chat")).toHaveLength(2);
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(2);
  expect(
    companionProfile(x.store, x.clock.now()).some((m) => m.value === "清和"),
  ).toBe(true);
});

it("CM3-3 ordinary hallucinated save promise never authorizes a write", async () => {
  let calls = 0;
  const x = make({
    memoryFastPath: true,
    chat: () => "今晚的风很舒服。以后我永远记得。",
    judge: (r) => {
      const d = judgeData(r);
      if (d.contractPart !== "operations") return '{"checks":[]}';
      calls++;
      return JSON.stringify({
        checks:
          calls === 1
            ? [
                {
                  quote: "以后我永远记得。",
                  scope: "save_workflow",
                  reason: "无成功回执的保证",
                  violation: "unconfirmed_commit",
                },
              ]
            : [],
        requiredAction: "none",
        userEvidence: null,
      });
    },
  });
  const result = await x.say("今晚有风呀。");
  expect(result.run.status).toBe("completed");
  expect(result.reply.content).toBe("今晚的风很舒服。");
  expect(x.store.all("memories")).toHaveLength(0);
  expect(x.model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
    1,
  );
});

it("CM3-3 source ordering settles automatic fact before parsing a later correction", async () => {
  const gate = deferred();
  let first = true,
    target: string | undefined;
  const x = make({
    memoryFastPath: true,
    extract: async (r) => {
      if (first) {
        first = false;
        await gate.promise;
        return;
      }
      const d = judgeData(r);
      target = d.existing[0].id;
      x.plans.set(d.input, {
        intent: "correct",
        items: [
          item(d.input, {
            action: "replace",
            targetId: target!,
            expectedRevision: d.existing[0].revision,
          }),
        ],
      });
    },
  });
  await x.say("我一直更喜欢温热的饮料。", {
    intent: "none",
    items: [item("我一直更喜欢温热的饮料。")],
  });
  const second = x.h.submit("更正一下，我现在更喜欢冰饮。", "later-correction");
  await new Promise((r) => setTimeout(r, 20));
  expect(x.model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
    1,
  );
  gate.resolve();
  await until(
    () => x.store.require("runs", second.runId).status === "completed",
  );
  expect(target).toBeTruthy();
  expect(
    x.store
      .all("memories")
      .filter((m) => m.status === "active")
      .map((m) => m.text),
  ).toEqual(["更正一下，我现在更喜欢冰饮。"]);
});

it.each(["cancel", "formation-off", "forget", "persona", "deadline"])(
  "CM3-3 %s prevents delayed intake from committing",
  async (kind) => {
    const gate = deferred();
    const x = make({
      memoryFastPath: true,
      extract: () => gate.promise as Promise<void>,
    });
    const text = "我平时喜欢在阳台种薄荷。";
    const result = await x.say(text, { intent: "none", items: [item(text)] });
    if (kind === "cancel") x.h.cancel(result.runId);
    if (kind === "formation-off")
      x.h.updateSettings({
        expectedRevision: x.store.settings().revision,
        memoryFormationMode: "off",
      });
    if (kind === "forget") x.h.forget([result.messageId], []);
    if (kind === "persona")
      x.h.publishPersona(
        { ...x.store.settings().persona, name: "新角色" },
        x.store.settings().revision,
      );
    if (kind === "deadline") x.clock.advance(30001);
    gate.resolve();
    await until(() =>
      ["failed", "cancelled"].includes(x.store.all("memory_inbox")[0]!.status),
    );
    expect(x.store.all("memories")).toHaveLength(0);
    expect(x.store.require("runs", result.runId).status).toBe("completed");
  },
);

it("CM3-3 session close aborts and drains intake before disposing store", async () => {
  let aborted = false;
  const x = make({
    memoryFastPath: true,
    extract: (r) =>
      new Promise<void>((_, reject) => {
        r.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  await x.say("我常在清晨散步。");
  await x.h.close();
  expect(aborted).toBe(true);
});

it("CM3-3 a late critical parse is diagnosed instead of silently changing a slot", async () => {
  const gate = deferred();
  const x = make({
    memoryFastPath: true,
    extract: () => gate.promise as Promise<void>,
  });
  const text = "往后就用言川来喊我。";
  await x.say(text, {
    intent: "address",
    items: [item(text, { action: "set_address", value: "言川" })],
  });
  gate.resolve();
  await until(() => x.store.all("memory_inbox")[0]!.status === "failed");
  expect(x.store.all("memory_inbox")[0]!.reason).toBe("late_requires_sync");
  expect(x.store.all("profile_slots")).toHaveLength(0);
});

it("CM3-3 disabled automatic formation still upgrades a semantically detected explicit command", async () => {
  const x = make({
    memoryFastPath: true,
    judge: (r) =>
      judgeData(r).contractPart === "operations"
        ? '{"checks":[],"requiredAction":"sync_write","userEvidence":"往后就用"}'
        : '{"checks":[]}',
  });
  x.h.updateSettings({
    expectedRevision: x.store.settings().revision,
    memoryFormationMode: "explicit_only",
  });
  const text = "往后就用晴原来喊我。";
  await x.say(text, {
    intent: "address",
    items: [item(text, { action: "set_address", value: "晴原" })],
  });
  expect(x.model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
    1,
  );
  expect(x.store.all("memory_mutations")[0]?.status).toBe("committed");
});

it("CM3-3 failed extraction does not cancel an otherwise valid ordinary reply", async () => {
  const x = make({
    memoryFastPath: true,
    extract: async () => {
      throw Error("unavailable");
    },
  });
  const r = await x.say("今天阳光真好。");
  expect(r.run.status).toBe("completed");
  expect(x.store.all("memory_inbox")[0]!.status).toBe("failed");
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(2);
  expect(r.run.usage.estimated).toBe(true);
});

it("CM3-3 pending sources share the history budget; ablation excludes them and stops late capture", async () => {
  const gate = deferred();
  const x = make({
    memoryFastPath: true,
    extract: () => gate.promise as Promise<void>,
  });
  for (let i = 0; i < 5; i++)
    await x.say(
      `普通输入${i}：${"这是仅用于占用近期上下文的用户原文。".repeat(90)}`,
    );
  const r = await x.say("刚才聊了什么？");
  const context = x.h.context(r.runId) as {
    messages: { content: string }[];
    meta: {
      pendingSourceIds: string[];
      historyIds: string[];
      budget: { history: number };
    };
  };
  expect(context.meta.pendingSourceIds.length).toBeGreaterThan(0);
  expect(context.meta.pendingSourceIds.length).toBeLessThanOrEqual(8);
  expect(
    context.meta.pendingSourceIds.every(
      (id) => !context.meta.historyIds.includes(id),
    ),
  ).toBe(true);
  expect(context.messages[0]!.content).toContain("user_stated_recent_source");
  x.h.resetCompanionContext();
  const next = await x.say("现在呢？");
  const reset = x.h.context(next.runId) as {
    meta: { pendingSourceIds: string[]; historyIds: string[] };
  };
  expect(reset.meta.pendingSourceIds).toEqual([]);
  expect(reset.meta.historyIds).toEqual([]);
  gate.resolve();
});

it("CM3-3 ordinary background additions during generation do not force a re-read or duplicate reply", async () => {
  const gate = deferred();
  const x = make({
    memoryFastPath: true,
    extract: () => gate.promise as Promise<void>,
    chat: async () => {
      gate.resolve();
      await new Promise((r) => setTimeout(r, 20));
      return "这听起来很惬意。";
    },
  });
  const q = "平日我喜欢傍晚看云。";
  const result = await x.say(q, { intent: "none", items: [item(q)] });
  expect(result.run.status).toBe("completed");
  expect(x.model.requests.filter((r) => r.purpose === "chat")).toHaveLength(1);
  expect(
    result.run.timings!.spans.filter((s) => s.stage === "memory_read"),
  ).toHaveLength(1);
  expect(x.store.all("memories")).toHaveLength(1);
});

it("CM3-3 partial committed commands are not retried or advertised as fully successful", async () => {
  const x = make({ memoryFastPath: true });
  const q = "请记住我喜欢木工，但别存不存在的证据。";
  const r = await x.say(q, {
    intent: "save",
    items: [item("我喜欢木工"), item("没有在用户原话里")],
  });
  expect(r.run.status).toBe("completed");
  expect(companionOperations(x.store, r.run).receipt?.status).toBe("partial");
  expect(x.store.all("memories")).toHaveLength(1);
  expect(x.model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
    1,
  );
});

it.each(["explicit_only", "off"] as const)(
  "CM3-3 %s ordinary chat does not enqueue a legacy extraction or request a model intake",
  async (mode) => {
    const x = make({ memoryFastPath: true });
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      memoryFormationMode: mode,
    });
    const result = await x.say("今天的云很好看。");
    expect(result.run.status).toBe("completed");
    expect(
      x.model.requests.filter((r) => r.purpose === "extract"),
    ).toHaveLength(0);
    expect(x.store.all("memory_inbox")).toHaveLength(0);
    expect(
      x.store.all("jobs").filter((j) => j.kind === "extract"),
    ).toHaveLength(0);
  },
);

it.each(["address", "correct", "forget"] as const)(
  "known %s intent upgrades before either obsolete review, without a second parser",
  async (intent) => {
    let extracts = 0;
    const x = make({
      memoryFastPath: true,
      extract: async () => {
        extracts++;
      },
      chat: () => "先按实际内容回答。",
      judge: (r) => {
        const d = judgeData(r);
        expect(d.memoryOperations.receipt).toBeTruthy();
        return d.contractPart === "operations"
          ? '{"checks":[],"requiredAction":"none","userEvidence":null}'
          : '{"checks":[]}';
      },
    });
    const text = "换一种相处方式就好。";
    const plan: Plan =
      intent === "address"
        ? {
            intent,
            items: [
              item(text, {
                action: "set_interaction",
                value: "concise_replies",
              }),
            ],
          }
        : { intent, items: [] };
    const r = await x.say(text, plan);
    expect(r.run.status).toBe("completed");
    expect(extracts).toBe(1);
    expect(x.model.requests.filter((r) => r.purpose === "chat")).toHaveLength(
      2,
    );
    expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(
      2,
    );
    expect(
      x.store
        .traces(r.runId)
        .some(
          (t) =>
            t.reason === "intake_upgrade" && t.data.reason === "before_review",
        ),
    ).toBe(true);
  },
);

it("critical intake discovered during slow reviews cancels and drains them, then runs both checks on the new profile", async () => {
  const intake = deferred();
  let aborted = 0,
    generation = 0;
  const x = make({
    memoryFastPath: true,
    extract: () => intake.promise as Promise<void>,
    chat: () => (++generation === 1 ? "旧的未发布草稿。" : "新的已办理答复。"),
    judge: async (r) => {
      const d = judgeData(r);
      if (!d.memoryOperations.receipt) {
        if (d.contractPart === "operations") intake.resolve();
        await new Promise<void>((_, reject) => {
          const stop = () => {
            aborted++;
            reject(Error("cancelled obsolete review"));
          };
          if (r.signal.aborted) stop();
          else r.signal.addEventListener("abort", stop, { once: true });
        });
      }
      return d.contractPart === "operations"
        ? '{"checks":[],"requiredAction":"none","userEvidence":null}'
        : '{"checks":[]}';
    },
  });
  const q = "往后就用栖月来喊我。";
  const r = await x.say(q, {
    intent: "address",
    items: [item(q, { action: "set_address", value: "栖月" })],
  });
  expect(r.run.status).toBe("completed");
  expect(r.reply.content).toBe("新的已办理答复。");
  expect(aborted).toBe(2);
  expect(x.model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
    1,
  );
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(4);
  expect(
    x.store
      .traces(r.runId)
      .some(
        (t) =>
          t.reason === "intake_upgrade" && t.data.reason === "during_review",
      ),
  ).toBe(true);
  expect(x.store.usageRecords()).toHaveLength(7);
  expect(
    x.store
      .usageRecords()
      .filter((r) => r.data.state === "failed_usage_unknown"),
  ).toHaveLength(2);
  expect(x.store.usageRecords().some((r) => r.data.state === "pending")).toBe(
    false,
  );
  expect(r.run.usage.estimated).toBe(true);
});

it("operations-only semantic escalation still joins its existing pending parser once", async () => {
  const intake = deferred();
  const x = make({
    memoryFastPath: true,
    extract: () => intake.promise as Promise<void>,
    judge: (r) => {
      const d = judgeData(r);
      if (d.contractPart === "operations" && !d.memoryOperations.receipt) {
        setTimeout(() => intake.resolve(), 10);
        return '{"checks":[],"requiredAction":"clarify","userEvidence":"换一种相处方式"}';
      }
      return d.contractPart === "operations"
        ? '{"checks":[],"requiredAction":"none","userEvidence":null}'
        : '{"checks":[]}';
    },
  });
  const r = await x.say("换一种相处方式吧。");
  expect(r.run.status).toBe("completed");
  expect(x.model.requests.filter((r) => r.purpose === "extract")).toHaveLength(
    1,
  );
  expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(4);
});

it("publication check deadline fails honestly, aborts its peer and never publishes an unchecked draft", async () => {
  let aborted = 0;
  const x = make({
    memoryFastPath: true,
    memoryReviewTimeoutMs: 35,
    chat: () => "这份草稿不能发布。",
    judge: (r) =>
      new Promise<string>((_, reject) => {
        r.signal.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(Error("slow provider"));
          },
          { once: true },
        );
      }),
  });
  const r = await x.say("聊两句吧。");
  expect(r.run.status).toBe("failed");
  expect(r.run.reason).toBe("memory_review_timeout");
  expect(r.reply.content).not.toContain("这份草稿");
  expect(r.reply.content).toContain("没能完成");
  expect(aborted).toBe(2);
  expect(
    x.store
      .usageRecords()
      .filter((r) => r.data.state === "failed_usage_unknown"),
  ).toHaveLength(2);
  expect(x.store.usageRecords().some((r) => r.data.state === "pending")).toBe(
    false,
  );
});

it("cancel during an obsolete review prevents late critical commit and all regeneration", async () => {
  const gate = deferred();
  const x = make({
    memoryFastPath: true,
    extract: () => gate.promise as Promise<void>,
    judge: (r) =>
      new Promise<string>((_, reject) =>
        r.signal.addEventListener("abort", () => reject(Error("stopped")), {
          once: true,
        }),
      ),
  });
  const q = "往后就用清棠来喊我。";
  x.plans.set(q, {
    intent: "address",
    items: [item(q, { action: "set_address", value: "清棠" })],
  });
  const r = x.h.submit(q, "cancel-upgrade");
  await until(
    () => x.model.requests.filter((r) => r.purpose === "judge").length === 2,
  );
  x.h.cancel(r.runId);
  gate.resolve();
  await x.h.waitForIdle();
  expect(x.store.require("runs", r.runId).status).toBe("cancelled");
  expect(x.store.all("profile_slots")).toHaveLength(0);
  expect(x.model.requests.filter((r) => r.purpose === "chat")).toHaveLength(1);
});

it.each(["before_commit", "after_commit"])(
  "a %s fault while promoting a late command never revives the discarded draft",
  async (point) => {
    const gate = deferred();
    let generation = 0;
    const x = make({
      memoryFastPath: true,
      extract: () => gate.promise as Promise<void>,
      faults: {
        hit(p) {
          if (p === `companion_commit.${point}`)
            throw Error("injected commit failure");
        },
      },
      chat: () => {
        generation++;
        return "旧草稿绝对不可发布。";
      },
      judge: (r) =>
        new Promise<string>((_, reject) => {
          if (judgeData(r).contractPart === "operations") gate.resolve();
          r.signal.addEventListener("abort", () => reject(Error("obsolete")), {
            once: true,
          });
        }),
    });
    const q = "往后就用临川来喊我。";
    const r = await x.say(q, {
      intent: "address",
      items: [item(q, { action: "set_address", value: "临川" })],
    });
    expect(r.run.status).toBe("failed");
    expect(r.reply.content).not.toContain("旧草稿");
    expect(generation).toBe(1);
    expect(
      x.model.requests.filter((r) => r.purpose === "extract"),
    ).toHaveLength(1);
    expect(x.store.all("profile_slots")).toHaveLength(
      point === "after_commit" ? 1 : 0,
    );
    if (point === "after_commit") expect(r.reply.content).toContain("已经提交");
  },
);

it.each(["correct", "forget"] as const)(
  "late %s commits its actual target and rebuilds the read set before final checks",
  async (intent) => {
    const gate = deferred();
    let late = false;
    const x = make({
      memoryFastPath: true,
      extract: async () => {
        if (late) await gate.promise;
      },
      judge: (r) => {
        const d = judgeData(r);
        if (late && !d.memoryOperations.receipt) {
          if (d.contractPart === "operations") gate.resolve();
          return new Promise<string>((_, reject) =>
            r.signal.addEventListener(
              "abort",
              () => reject(Error("obsolete")),
              { once: true },
            ),
          );
        }
        return d.contractPart === "operations"
          ? '{"checks":[],"requiredAction":"none","userEvidence":null}'
          : '{"checks":[]}';
      },
    });
    const seed = "记住我喜欢编织。";
    await x.say(seed, { intent: "save", items: [item(seed)] });
    const target = x.store.all("memories")[0]!;
    late = true;
    const q =
      intent === "correct"
        ? "那项爱好现在是折纸。"
        : "那条偏好别留在长期资料里了，聊天留下。";
    const r = await x.say(q, {
      intent,
      items: [
        item(q, {
          action: intent === "correct" ? "replace" : "forget",
          targetId: target.id,
          expectedRevision: target.revision,
        }),
      ],
    });
    expect(r.run.status).toBe("completed");
    expect(x.store.require("memories", target.id).status).not.toBe("active");
    const context = x.h.context(r.runId) as {
      meta: { selected: { id: string }[] };
    };
    expect(context.meta.selected.some((m) => m.id === target.id)).toBe(false);
    expect(
      companionOperations(x.store, r.run).completedOperations[0]?.action,
    ).toBe(intent === "correct" ? "replace" : "forget");
    expect(
      x.store.require(
        "messages",
        x.store.all("messages").find((m) => m.content === seed)!.id,
      ).deleted,
    ).toBe(false);
  },
);

it("default publication review permits a valid result after eight seconds and still waits for it", async () => {
  vi.useFakeTimers();
  const gate = deferred();
  let factsSignal: AbortSignal | undefined;
  try {
    const x = make({
      memoryFastPath: true,
      maxRunMs: 45000,
      judge: async (r) => {
        if (judgeData(r).contractPart === "facts") {
          factsSignal = r.signal;
          await gate.promise;
          return '{"checks":[]}';
        }
        return '{"checks":[],"requiredAction":"none","userEvidence":null}';
      },
    });
    const r = x.h.submit("慢慢聊两句。", "valid-late-review");
    await vi.advanceTimersByTimeAsync(0);
    expect(factsSignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(8100);
    expect(factsSignal!.aborted).toBe(false);
    expect(x.store.require("runs", r.runId).status).toBe("running");
    expect(x.store.require("messages", `assistant-${r.runId}`).content).toBe(
      "",
    );
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(x.store.require("runs", r.runId).status).toBe("completed");
    expect(x.model.requests.filter((r) => r.purpose === "judge")).toHaveLength(
      2,
    );
  } finally {
    gate.resolve();
    vi.useRealTimers();
  }
});
