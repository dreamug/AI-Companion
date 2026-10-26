import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BotManager,
  GIRLFRIEND_BOT_ID,
  EROTIC_BOT_ID,
  EROTIC_PERSONA,
  ORIGINAL_BOT_ID,
  GIRLFRIEND_PERSONA,
} from "../src/bots.js";
import { createApp } from "../src/server.js";
import { buildSystem } from "../src/context.js";
import { setup, ScriptedModel, response, until } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { SpeechPort } from "../src/speech.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function manager(factory?: ConstructorParameters<typeof BotManager>[1]) {
  const dir = mkdtempSync(join(tmpdir(), "companion-bots-"));
  const config: AppConfig = {
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
    modelMode: "mock",
    maxRunMs: 3000,
    maxOutputTokens: 300,
    schedulerMs: 50,
  };
  const bots = new BotManager(config, factory);
  cleanups.push(async () => {
    await bots.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { bots, config, dir };
}
async function server(speech?: SpeechPort) {
  const x = manager();
  const app = await createApp(x.bots.get(), { bots: x.bots, speech });
  await app.ready();
  cleanups.push(() => app.close());
  const r = await app.inject({ url: "/bootstrap" });
  const headers = {
    cookie: `harness_session=${r.cookies[0]!.value}`,
    "x-local-token": r.json().csrfToken,
  };
  return { ...x, app, headers };
}
function allow(h: ReturnType<BotManager["get"]>) {
  const s = h.store.settings();
  h.updateSettings({
    expectedRevision: s.revision,
    remoteDisclosureAcknowledged: true,
    autoExtract: false,
  });
}

describe("多bot管理与角色作用域", () => {
  it.each(["grok-4.3", "deepseek-v4-pro"])(
    "创建时选择 %s，未聊天前重启及归档恢复都保留选择",
    async (model) => {
      const { bots, config } = manager();
      const current = bots.get();
      current.updateModelKey("grok", "current-role-only-key");
      const created = bots.create({ name: "自选模型角色", model });
      expect(bots.get(created.id).store.settings().model).toBe(model);
      expect(bots.get(created.id).credentials.status("grok").hasByok).toBe(
        false,
      );
      expect(current.store.settings().model).toBe("deepseek-flash");
      await bots.close();
      const reopened = new BotManager(config);
      cleanups.push(() => reopened.close());
      expect(reopened.get(created.id).store.settings().model).toBe(model);
      await reopened.archive(created.id);
      reopened.restore(created.id);
      expect(reopened.get(created.id).store.settings().model).toBe(model);
    },
  );
  it("创建 API 接受模型选择，非法模型不创建角色，旧客户端省略模型继续使用默认值", async () => {
    const x = await server();
    const before = x.bots.list().length;
    const invalid = await x.app.inject({
      method: "POST",
      url: "/v1/bots",
      headers: x.headers,
      payload: { name: "非法模型角色", model: "unknown" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(x.bots.list()).toHaveLength(before);
    const created = await x.app.inject({
      method: "POST",
      url: "/v1/bots",
      headers: x.headers,
      payload: { name: "Grok角色", model: "grok-4.3" },
    });
    expect(created.statusCode).toBe(200);
    expect(x.bots.get(created.json().id).store.settings().model).toBe(
      "grok-4.3",
    );
    const legacy = x.bots.create({ name: "默认角色" });
    expect(x.bots.get(legacy.id).store.settings().model).toBe(x.config.model);
  });
  it("分条与间隔开关按角色保存，重启保留选择，新建角色仍默认关闭", async () => {
    const { bots, config } = manager();
    const a = bots.get();
    expect(bots.get(GIRLFRIEND_BOT_ID).store.settings()).toMatchObject({
      splitReplies: false,
      messagePacing: false,
    });
    a.updateSettings({
      expectedRevision: a.store.settings().revision,
      splitReplies: true,
      messagePacing: true,
    });
    const fresh = bots.create({ name: "新角色" });
    expect(bots.get(fresh.id).store.settings()).toMatchObject({
      splitReplies: false,
      messagePacing: false,
    });
    await bots.close();
    const reopened = new BotManager(config);
    cleanups.push(() => reopened.close());
    expect(reopened.get().store.settings()).toMatchObject({
      splitReplies: true,
      messagePacing: true,
    });
    expect(reopened.get(GIRLFRIEND_BOT_ID).store.settings()).toMatchObject({
      splitReplies: false,
      messagePacing: false,
    });
    expect(reopened.get(fresh.id).store.settings()).toMatchObject({
      splitReplies: false,
      messagePacing: false,
    });
  });
  it("原数据库的聊天、人格和记忆原样保留，初始女友只创建一次", async () => {
    const legacy = setup();
    const m = legacy.h.addMemory({ text: "原角色独有记忆", pinned: true });
    legacy.h.submit("原角色的聊天", "legacy");
    await legacy.h.waitForIdle();
    const before = legacy.h.snapshot();
    await legacy.h.close();
    const bots = new BotManager(legacy.config);
    cleanups.push(async () => {
      await bots.close();
      rmSync(legacy.dir, { recursive: true, force: true });
    });
    expect(bots.get().store.settings().persona).toEqual(
      before.settings.persona,
    );
    expect(bots.get().snapshot().messages).toEqual(before.messages);
    expect(bots.get().store.require("memories", m.id).text).toBe(m.text);
    expect(bots.get(GIRLFRIEND_BOT_ID).snapshot().messages).toEqual([]);
    expect(bots.get(GIRLFRIEND_BOT_ID).snapshot().memories).toEqual([]);
    await bots.close();
    const reopened = new BotManager(legacy.config);
    cleanups.push(() => reopened.close());
    expect(reopened.list().map((b) => b.id)).toEqual([
      ORIGINAL_BOT_ID,
      GIRLFRIEND_BOT_ID,
      EROTIC_BOT_ID,
    ]);
    expect(reopened.get(EROTIC_BOT_ID).store.settings()).toMatchObject({
      model: "grok-4.3",
      persona: EROTIC_PERSONA,
    });
  });
  it("聊天、输入幂等、记忆、遗忘和跟进互不串用", async () => {
    const { bots } = manager();
    const a = bots.get(),
      b = bots.get(GIRLFRIEND_BOT_ID);
    allow(a);
    allow(b);
    const am = a.addMemory({ text: "小野空间的记忆", pinned: true });
    const bm = b.addMemory({ text: "小棠空间的记忆", pinned: true });
    const ar = a.submit("小野空间消息", "same-client-key");
    const br = b.submit("小棠空间消息", "same-client-key");
    await Promise.all([a.waitForIdle(), b.waitForIdle()]);
    expect(ar.runId).not.toBe(br.runId);
    expect(
      a.snapshot().messages.some((m) => m.content.includes("小棠空间")),
    ).toBe(false);
    expect(
      b.snapshot().messages.some((m) => m.content.includes("小野空间")),
    ).toBe(false);
    expect(a.store.get("memories", bm.id)).toBeUndefined();
    expect(b.store.get("memories", am.id)).toBeUndefined();
    const f = a.createFollowUp({
      text: "原角色事项",
      dueAt: Date.now() + 10000,
      latestAt: Date.now() + 20000,
    });
    expect(b.store.get("followups", f.id)).toBeUndefined();
    a.forget(
      am.sources.map((s) => s.id),
      [],
    );
    expect(b.store.require("memories", bm.id).status).toBe("active");
  });
  it("五轮上下文携带相处设定和已展示历史，绝不带入另一角色的内容", async () => {
    const requests: string[] = [];
    const { bots } = manager(
      () =>
        new ScriptedModel(async function* (r) {
          requests.push(JSON.stringify(r));
          yield* response("小棠：我在呀，阿宇。");
        }),
    );
    const a = bots.get(),
      b = bots.get(GIRLFRIEND_BOT_ID);
    allow(a);
    allow(b);
    a.addMemory({ text: "仅原角色可见的保密代号ORIGINAL_ONLY", pinned: true });
    for (const [i, text] of [
      "做我的AI小女友好吗",
      "叫我阿宇",
      "我今天有点累",
      "我们聊聊电影",
      "我要和朋友出门了",
    ].entries()) {
      const receipt = b.submit(text, `round-${i}`);
      await b.waitForIdle();
      const reply = b
        .snapshot()
        .messages.find(
          (m) => m.runId === receipt.runId && m.role === "assistant",
        )!;
      b.displayed(reply.id, reply.content.length);
    }
    expect(requests).toHaveLength(5);
    expect(
      requests.every(
        (r) => r.includes("虚拟恋爱陪伴") && !r.includes("ORIGINAL_ONLY"),
      ),
    ).toBe(true);
    expect(requests[4]).toContain("叫我阿宇");
    expect(b.snapshot().messages).toHaveLength(10);
  });
  it("角色发布对下一轮生效，已接受运行保留原相处设定", async () => {
    const { bots } = manager();
    const h = bots.get(GIRLFRIEND_BOT_ID);
    allow(h);
    const run = h.submit("你好", "frozen");
    h.publishPersona(
      {
        ...GIRLFRIEND_PERSONA,
        relationship: {
          ...GIRLFRIEND_PERSONA.relationship!,
          mode: "companion",
        },
      },
      h.store.settings().revision,
    );
    await h.waitForIdle();
    expect(
      (
        h.store.require("runs", run.runId).config
          .persona as typeof GIRLFRIEND_PERSONA
      ).relationship?.mode,
    ).toBe("romantic");
    expect(h.store.settings().persona.relationship?.mode).toBe("companion");
  });
  it("归档暂停运行、拒绝访问，可恢复并跨重启保留；原角色受保护", async () => {
    const { bots, config } = manager();
    const h = bots.get(GIRLFRIEND_BOT_ID);
    allow(h);
    const memory = h.addMemory({ text: "归档后仍保留" });
    const r = h.submit("归档中的输入", "archive");
    await expect(bots.archive(ORIGINAL_BOT_ID)).rejects.toThrow(
      "original_bot_protected",
    );
    await bots.archive(GIRLFRIEND_BOT_ID);
    expect(() => bots.get(GIRLFRIEND_BOT_ID)).toThrow("bot_archived");
    await bots.close();
    const re = new BotManager(config);
    cleanups.push(() => re.close());
    expect(re.list()).toHaveLength(3);
    expect(() => re.get(GIRLFRIEND_BOT_ID)).toThrow("bot_archived");
    re.restore(GIRLFRIEND_BOT_ID);
    expect(
      re.get(GIRLFRIEND_BOT_ID).store.require("memories", memory.id).text,
    ).toBe(memory.text);
    expect(
      re.get(GIRLFRIEND_BOT_ID).store.require("runs", r.runId).status,
    ).toBe("cancelled");
  });
  it("损坏或含路径穿越的角色清单拒绝启动", async () => {
    const { bots, dir, config } = manager();
    await bots.close();
    const manifest = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8"));
    manifest.bots[1].id = "../../elsewhere";
    writeFileSync(join(dir, "bots.json"), JSON.stringify(manifest));
    expect(() => new BotManager(config)).toThrow();
  });
  it("API按显式角色选择隔离来源、运行、导出和语音，不回落到原角色", async () => {
    const x = await server();
    const h = x.bots.get();
    allow(h);
    const m = h.addMemory({ text: "原角色的私有资料" });
    const r = h.submit("原角色私有聊天", "private");
    await h.waitForIdle();
    const reply = h.snapshot().messages.find((m) => m.role === "assistant")!;
    const exp = h.exportData();
    const other = { ...x.headers, "x-bot-id": GIRLFRIEND_BOT_ID };
    for (const url of [
      `/v1/memory/${m.id}`,
      `/v1/sources/${m.sources[0]!.id}`,
      `/v1/runs/${r.runId}`,
      `/v1/exports/${exp.id}`,
    ])
      expect((await x.app.inject({ url, headers: other })).statusCode).toBe(
        404,
      );
    const speech = await x.app.inject({
      method: "POST",
      url: "/v1/speech",
      headers: other,
      payload: {
        kind: "message",
        id: reply.id,
        expectedEpoch: 1,
        expectedRevision: reply.revision,
      },
    });
    expect(speech.statusCode).toBe(404);
    expect(
      (
        await x.app.inject({
          url: "/v1/health",
          headers: { ...x.headers, "x-bot-id": "unknown" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await x.app.inject({
          url: "/bootstrap?botId=xiaotang",
          headers: { "x-bot-id": "xiaoye" },
        })
      ).statusCode,
    ).toBe(400);
    const boot = await x.app.inject({ url: "/bootstrap", headers: other });
    expect(boot.json().relationshipId).toBe(`bot-${GIRLFRIEND_BOT_ID}`);
    expect(boot.json().botId).toBe(GIRLFRIEND_BOT_ID);
  });
  it("角色管理写操作仍需身份与CSRF，支持创建、归档、恢复", async () => {
    const x = await server();
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/bots",
          payload: { name: "新角色" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/bots",
          headers: { cookie: x.headers.cookie },
          payload: { name: "新角色" },
        })
      ).statusCode,
    ).toBe(403);
    const created = await x.app.inject({
      method: "POST",
      url: "/v1/bots",
      headers: x.headers,
      payload: { name: "小雨", template: "romantic" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect(x.bots.get(id).store.settings().persona.name).toBe("小雨");
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: `/v1/bots/${id}/archive`,
          headers: x.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: `/v1/bots/${id}/restore`,
          headers: x.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });
  it("归档会中止此角色在途语音，其他角色仍可聊天", async () => {
    let started = false;
    const x = await server({
      stream: async function* (_text, signal) {
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        if (!signal.aborted) yield Buffer.from("audio");
      },
    });
    const request = x.app.inject({
      method: "POST",
      url: "/v1/speech",
      headers: { ...x.headers, "x-bot-id": GIRLFRIEND_BOT_ID },
      payload: { kind: "preview", expectedEpoch: 1 },
    });
    const pending = request.then((r) => r);
    await until(() => started);
    await x.bots.archive(GIRLFRIEND_BOT_ID);
    expect((await pending).statusCode).toBe(409);
    expect(x.bots.get().snapshot().settings.persona.name).toBe("小野");
  });
  it("相处设定输入长度、枚举及总预算会在发布前验证", () => {
    const { bots } = manager();
    const h = bots.get(GIRLFRIEND_BOT_ID);
    const revision = h.store.settings().revision;
    expect(() =>
      h.publishPersona(
        {
          ...GIRLFRIEND_PERSONA,
          relationship: { ...GIRLFRIEND_PERSONA.relationship, mode: "invalid" },
        },
        revision,
      ),
    ).toThrow();
    expect(() =>
      h.publishPersona(
        { ...GIRLFRIEND_PERSONA, background: "x".repeat(2001) },
        revision,
      ),
    ).toThrow();
    expect(buildSystem(GIRLFRIEND_PERSONA)).toContain("成人情色");
    expect(buildSystem(GIRLFRIEND_PERSONA)).not.toContain(
      "不能声称真实人类感情",
    );
    expect(buildSystem(EROTIC_PERSONA)).toContain("给男朋友舔脚");
    expect(buildSystem(EROTIC_PERSONA)).toContain("颜射");
    expect(EROTIC_PERSONA.memoryScope).toBe("roleplay");
    expect(GIRLFRIEND_PERSONA.memoryScope).toBeUndefined();
    expect(EROTIC_PERSONA.examples).not.toContain("小澪：");
    expect(EROTIC_PERSONA.background).not.toContain("送进对方嘴里");
    expect(buildSystem(GIRLFRIEND_PERSONA, true)).toContain("不调用工具");
    expect(h.store.settings().revision).toBe(revision);
  });
});
