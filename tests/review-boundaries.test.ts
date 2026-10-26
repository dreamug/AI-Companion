import { afterEach, describe, it, expect } from "vitest";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  setup,
  ScriptedModel,
  response,
  finish,
  deferred,
  until,
} from "./helpers.js";
import { FishAudioSpeech } from "../src/speech.js";
import { restoreBackup } from "../src/backup.js";
import { readDeletionLedger } from "../src/files.js";
import { LOCAL_SCOPE, tokenEstimate } from "../src/domain.js";
import { createApp } from "../src/server.js";

const cleanups: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanups.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
const follow = (x: ReturnType<typeof setup>, extras = {}) =>
  x.h.createFollowUp({
    text: "合成事项",
    dueAt: x.clock.now(),
    latestAt: x.clock.now() + 3600000,
    ...extras,
  });

describe("审查：投递事实与公平调度", () => {
  it("被专注阻塞的旧候选不能饿死允许打断的约定", async () => {
    const x = make();
    x.h.updateSettings({ expectedRevision: 1, focused: true });
    const first = follow(x);
    x.clock.advance(1);
    const second = follow(x, { allowInterrupt: true });
    await x.h.tick();
    expect(x.store.require("followups", first.id).reason).toBe("focused");
    expect(x.store.list("deliveries").map((d) => d.followUpId)).toEqual([
      second.id,
    ]);
  });
  it("明确约定的投递不占自发关心限额", async () => {
    const x = make();
    x.h.channel("page", "granted");
    for (let i = 0; i < 2; i++) {
      const f = follow(x);
      await x.h.tick();
      const d = x.store.list("deliveries").find((d) => d.followUpId === f.id)!;
      x.h.deliveryEvent(d.id, { event: "attempt", clientId: "page" });
    }
    const candidate = follow(x, { kind: "candidate" });
    await x.h.tick();
    expect(
      x.store.list("deliveries").some((d) => d.followUpId === candidate.id),
    ).toBe(true);
  });
  it("open_loop不能绕过自发关心的冷却规则", async () => {
    const x = make();
    x.h.channel("page", "granted");
    const first = follow(x, { kind: "candidate" });
    await x.h.tick();
    const d = x.store
      .list("deliveries")
      .find((d) => d.followUpId === first.id)!;
    x.h.deliveryEvent(d.id, { event: "attempt", clientId: "page" });
    const second = follow(x, { kind: "open_loop" });
    await x.h.tick();
    expect(x.store.require("followups", second.id).reason).toBe("cooldown");
    expect(x.store.list("deliveries")).toHaveLength(1);
  });
  it("正常取消之后迟到的点击仍记录事实，重复回执幂等", async () => {
    const x = make();
    x.h.channel("page", "granted");
    const f = follow(x);
    await x.h.tick();
    const d = x.store.list("deliveries")[0]!;
    const permit = x.h.deliveryEvent(d.id, {
      event: "attempt",
      clientId: "page",
    }) as { attemptId: string };
    x.h.updateFollowUp(f.id, 1, "cancel");
    const event = {
      event: "click",
      clientId: "page",
      attemptId: permit.attemptId,
    };
    expect(x.h.deliveryEvent(d.id, event)).toMatchObject({ recorded: true });
    const revision = x.store.require("deliveries", d.id).revision;
    expect(x.store.require("deliveries", d.id).clickedAt).toBe(x.clock.now());
    expect(x.h.deliveryEvent(d.id, event)).toMatchObject({ duplicate: true });
    expect(x.store.require("deliveries", d.id).revision).toBe(revision);
  });
  it("新页面不能认领只为旧在线页面生成的通知许可", async () => {
    const x = make();
    x.h.channel("original", "granted");
    follow(x);
    await x.h.tick();
    x.h.channel("new-page", "granted");
    const d = x.store.list("deliveries")[0]!;
    expect(() =>
      x.h.deliveryEvent(d.id, { event: "attempt", clientId: "new-page" }),
    ).toThrow("channel_unavailable");
  });
  it("未确认跟进超过有效窗口也会归档", async () => {
    const x = make();
    const f = x.h.createFollowUp(
      {
        text: "合成待确认",
        dueAt: x.clock.now(),
        latestAt: x.clock.now() + 1000,
      },
      false,
    );
    x.clock.advance(2000);
    await x.h.tick();
    expect(x.store.require("followups", f.id).status).toBe("expired");
  });
});

describe("审查：语音取消与来源元数据", () => {
  it("已经取消的请求不再发起收费调用", async () => {
    const x = make({ config: { fishAudioApiKey: "synthetic" } });
    let calls = 0;
    const port = new FishAudioSpeech(x.config, (async () => {
      calls++;
      return new Response("ID3-data", {
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch);
    const c = new AbortController();
    c.abort();
    await expect(port.synthesize("合成", c.signal)).rejects.toThrow(
      "speech_cancelled",
    );
    expect(calls).toBe(0);
  });
  it("自定义流不响应signal时，取消仍结束等待并回收reader", async () => {
    const x = make({ config: { fishAudioApiKey: "synthetic" } });
    let cancelled = false,
      started = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from("ID3-data"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const port = new FishAudioSpeech(x.config, (async () => {
      started = true;
      return new Response(stream, {
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch);
    const c = new AbortController();
    const result = port.synthesize("合成", c.signal);
    await until(() => started);
    await new Promise((r) => setTimeout(r, 10));
    c.abort();
    await expect(result).rejects.toThrow("speech_cancelled");
    expect(cancelled).toBe(true);
  });
  it("更新曝光反馈不会撤销正文没变的语音", async () => {
    const x = make();
    const gate = deferred();
    let started = false;
    const app = await createApp(x.h, {
      speech: {
        async *stream() {
          started = true;
          await gate.promise;
          yield Buffer.from("ID3-synthetic");
        },
      },
    });
    await app.ready();
    cleanups.unshift(() => app.close());
    const boot = await app.inject("/bootstrap");
    const headers = {
      cookie: `harness_session=${boot.cookies[0]!.value}`,
      "x-local-token": boot.json().csrfToken,
    };
    follow(x);
    await x.h.tick();
    const d = x.store.list("deliveries")[0]!;
    const pending = Promise.resolve(
      app.inject({
        method: "POST",
        url: "/v1/speech",
        headers,
        payload: {
          kind: "delivery",
          id: d.id,
          expectedEpoch: 1,
          expectedRevision: d.revision,
        },
      }),
    );
    await until(() => started);
    x.h.feedback(d.id, "liked");
    gate.resolve();
    expect((await pending).statusCode).toBe(200);
  });
});

describe("审查：删除、恢复与原子工具", () => {
  it("损坏删除清单拒绝恢复，目标目录没有半成品", async () => {
    const x = make();
    const backup = await x.h.backup();
    const ledger = join(x.dir, "bad-ledger.json");
    writeFileSync(ledger, "[{}]");
    const target = join(x.dir, "restored");
    expect(() => readDeletionLedger(ledger)).toThrow("deletion_ledger_invalid");
    expect(() =>
      restoreBackup(
        join(x.dir, "backups", `${backup.id}.sqlite`),
        target,
        LOCAL_SCOPE,
        [ledger],
      ),
    ).toThrow("deletion_ledger_invalid");
    expect(existsSync(target)).toBe(false);
  });
  it("损坏数据库不会作为可启动恢复目录交付", () => {
    const x = make();
    const broken = join(x.dir, "broken.sqlite");
    writeFileSync(broken, "not a database");
    const target = join(x.dir, "restored");
    expect(() => restoreBackup(broken, target, LOCAL_SCOPE, [])).toThrow();
    expect(existsSync(target)).toBe(false);
  });
  it("工具内层已提交后抛错，也不能留下与失败回执不一致的写入", async () => {
    let armed = true;
    const model = new ScriptedModel(async function* (_r, i) {
      if (i === 0) {
        yield {
          type: "tool",
          call: {
            id: "t",
            name: "propose_memory",
            input: { text: "不应残留", category: "fact" },
          },
        };
        yield { ...finish, reason: "tool-calls" };
      } else yield* response();
    });
    const x = make({
      model,
      faults: {
        hit(p) {
          if (armed && p === "memory.after_commit") {
            armed = false;
            throw new Error("synthetic_fault");
          }
        },
      },
    });
    const r = x.h.submit("合成", "atomic-tool");
    await x.h.waitForIdle();
    expect(x.store.list("memories")).toHaveLength(0);
    expect(x.store.toolResult(r.runId, "t")).toMatchObject({
      error: "invalid_tool_input",
    });
  });
  it("记忆预算包含来源元数据，不能只数正文", async () => {
    const x = make();
    const ids = Array.from(
      { length: 30 },
      (_, i) => `reference-${i}-` + "x".repeat(300),
    );
    for (const id of ids)
      x.store.put("sources", {
        id,
        text: "合成",
        revision: 1,
        kind: "manual",
        deleted: false,
        createdAt: x.clock.now(),
      });
    x.h.addMemory({ text: "短文本", pinned: true, sourceIds: ids });
    const r = x.h.submit("合成", "metadata-budget");
    await x.h.waitForIdle();
    const context = x.h.context(r.runId) as { messages: { content: string }[] };
    const json = context.messages[0]!.content.replace(
      "<当前状态与记忆数据>\n",
      "",
    ).replace("\n</当前状态与记忆数据>", "");
    expect(
      tokenEstimate(JSON.stringify(JSON.parse(json).memories)),
    ).toBeLessThanOrEqual(2000);
  });
  it("超过十万条之后遗忘仍覆盖最旧记录", () => {
    const x = make();
    const deleted = x.h.addMemory({ text: "必须清理的旧合成事实" });
    const base = {
      ...deleted,
      id: "placeholder",
      text: "保留的合成事实",
      sources: [],
    };
    x.store.db
      .prepare(
        `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<100001) INSERT INTO memories SELECT 'padding-'||v,?,?,?,json_set(?,'$.id','padding-'||v) FROM n`,
      )
      .run(
        LOCAL_SCOPE.ownerUserId,
        LOCAL_SCOPE.relationshipId,
        x.clock.now() + 1,
        JSON.stringify(base),
      );
    x.h.forget([], [deleted.id]);
    expect(x.store.require("memories", deleted.id).text).toBe("");
    expect(x.store.require("memories", deleted.id).status).toBe("deleted");
  });
  it("已下线的页面立即释放渠道名额，关闭未知页面不占用槽", () => {
    const x = make();
    for (let i = 0; i < 20; i++) x.h.channel(`page-${i}`, "granted");
    expect(() => x.h.channel("full", "granted")).toThrow("too_many_channels");
    expect(() => x.h.channel("never-online", "offline")).not.toThrow();
    x.h.channel("page-0", "offline");
    expect(() => x.h.channel("new", "granted")).not.toThrow();
  });
});
