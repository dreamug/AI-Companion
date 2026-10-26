import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { Harness } from "../src/harness.js";
import { Store } from "../src/store.js";
import { join } from "node:path";
import { setup, ScriptedModel, response, deferred, until } from "./helpers.js";
import { createApp } from "../src/server.js";
import { candidateMetrics } from "../src/memory/metrics.js";
import {
  currentCandidateOffer,
  prepareCandidateOffer,
} from "../src/memory/candidates.js";
import { readFacts } from "../src/memory/reading.js";
import type { Memory } from "../src/domain.js";
const cleanup: (() => Promise<void>)[] = [];
function make(...args: Parameters<typeof setup>) {
  const x = setup(...args);
  cleanup.push(x.dispose);
  return x;
}
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
async function pending(
  x: ReturnType<typeof setup>,
  text = "我喜欢乌龙茶",
  input = "请记住，我喜欢乌龙茶",
) {
  const r = x.h.submit(input, crypto.randomUUID());
  await x.h.waitForIdle();
  const m = x.h.addMemory({ text, sourceIds: [r.messageId] }, true);
  await x.h.tick();
  return { m, r };
}
function get(x: ReturnType<typeof setup>, m: Memory) {
  return x.store.require("memories", m.id);
}

describe("MEM-G0 / MEM-C 候选漏斗和确认", () => {
  it("读取快照不制造机会或展示，客户端回执去重；旧记录保持 unknown", async () => {
    const x = make();
    const { m } = await pending(x);
    const offer = currentCandidateOffer(x.store, x.clock.now())!;
    const before = get(x, m).lifecycleMetadata;
    expect(before).toMatchObject({
      origin: "automatic",
      trafficOrigin: "synthetic",
      opportunityCount: 1,
    });
    for (let i = 0; i < 5; i++) x.h.snapshot();
    expect(get(x, m).lifecycleMetadata).toEqual(before);
    expect(x.h.memoryMetrics("synthetic").displayed).toBe(0);
    x.h.candidateExposure(m.id, offer.offerId);
    x.clock.advance(10);
    x.h.candidateExposure(m.id, offer.offerId);
    expect(get(x, m).lifecycleMetadata!.firstOfferedAt).toBe(
      x.clock.now() - 10,
    );
    expect(x.h.memoryMetrics("synthetic").displayed).toBe(1);
    expect(x.h.memoryMetrics("natural").produced).toBe(0);
    const legacy = { ...m, id: "legacy", lifecycleMetadata: undefined };
    x.store.put("memories", legacy);
    x.h.reviseMemory(legacy.id, 1, { decision: "confirm" }, "legacy-command");
    expect(get(x, legacy).lifecycleMetadata?.origin).toBe("unknown");
    expect(x.h.memoryMetrics("synthetic").produced).toBe(1);
  });
  it("双入口同 revision 重放幂等；冲突 key 拒绝，普通‘对’不确认", async () => {
    const x = make();
    const { m } = await pending(x);
    const first = x.h.reviseMemory(
      m.id,
      m.revision,
      { decision: "confirm" },
      "command",
    );
    const second = x.h.reviseMemory(
      m.id,
      m.revision,
      { decision: "confirm" },
      "command",
    );
    expect(second).toEqual(first);
    expect(
      x.h.reviseMemory(
        m.id,
        m.revision,
        { decision: "confirm" },
        "other-entry",
      ),
    ).toEqual(first);
    expect(first.sources).toHaveLength(2);
    expect(first.lifecycleMetadata).toMatchObject({
      origin: "automatic",
      terminalReason: "confirmed",
    });
    expect(() =>
      x.h.reviseMemory(m.id, m.revision, { decision: "later" }, "command"),
    ).toThrow("idempotency_conflict");
    const next = await pending(x, "喜欢爬山");
    x.h.submit("对", "yes");
    await x.h.waitForIdle();
    expect(get(x, next.m).status).toBe("pending");
    expect(
      readFacts(x.store, "想喝什么", x.clock.now()).selected.map((m) => m.id),
    ).toContain(first.id);
  });
  it("不保存只退出候选、擦除候选正文；不删除来源，不推进 epoch，不取消无关 Run", async () => {
    const gate = deferred();
    const model = new ScriptedModel(async function* (r) {
      if (r.purpose === "chat" && r.messages.at(-1)?.content === "无关工作")
        await gate.promise;
      yield* response();
    });
    const x = make({ model });
    const { m, r } = await pending(x);
    const epoch = x.store.settings().epoch;
    const unrelated = x.h.submit("无关工作", "unrelated");
    await until(
      () => x.store.require("runs", unrelated.runId).status === "running",
    );
    const result = x.h.reviseMemory(
      m.id,
      1,
      { decision: "discard" },
      "discard",
    );
    expect(result).toMatchObject({
      status: "deleted",
      text: "",
      lifecycleMetadata: { terminalReason: "discarded" },
    });
    expect(x.store.settings().epoch).toBe(epoch);
    expect(x.store.require("sources", r.messageId).deleted).toBe(false);
    expect(x.store.require("runs", unrelated.runId).status).toBe("running");
    expect(
      x.h.reviseMemory(m.id, 1, { decision: "discard" }, "discard"),
    ).toEqual(result);
    gate.resolve();
    await x.h.waitForIdle();
  });
  it("暂缓延长期限但不确认、不重复主动展示；更正后记住只产生一个新事实", async () => {
    const x = make();
    const { m } = await pending(x);
    x.clock.advance(1000);
    const later = x.h.reviseMemory(m.id, 1, { decision: "later" }, "later");
    expect(later.status).toBe("pending");
    expect(later.expiresAt).toBeGreaterThan(m.expiresAt!);
    await x.h.tick();
    expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
    const corrected = x.h.reviseMemory(
      m.id,
      later.revision,
      { text: "更准确：喜欢绿茶", decision: "confirm" },
      "correct",
    );
    expect(corrected).toMatchObject({
      text: "更准确：喜欢绿茶",
      status: "active",
      certainty: "confirmed",
      previousId: m.id,
      lifecycleMetadata: { corrected: true, deferredCount: 1 },
    });
    expect(
      x.h.reviseMemory(
        m.id,
        later.revision,
        { text: "更准确：喜欢绿茶", decision: "confirm" },
        "correct",
      ),
    ).toEqual(corrected);
    const metrics = x.h.memoryMetrics("synthetic");
    expect(metrics.produced).toBe(1);
    expect(metrics.confirmed).toBe(1);
    expect(metrics.corrected).toBe(1);
  });
  it("过期、来源修订与旧 revision 在命令端复核", async () => {
    const x = make();
    const { m } = await pending(x);
    x.clock.advance(7 * 86400000 + 1);
    expect(() => x.h.reviseMemory(m.id, 1, { decision: "confirm" })).toThrow(
      "candidate_unavailable",
    );
    await x.h.tick();
    expect(get(x, m).lifecycleMetadata?.terminalReason).toBe("expired");
    expect(() =>
      x.h.reviseMemory(m.id, get(x, m).revision, { decision: "confirm" }),
    ).toThrow("candidate_unavailable");
    const next = await pending(x);
    const source = x.store.require("sources", next.r.messageId);
    x.store.put("sources", { ...source, revision: 2 });
    expect(() =>
      x.h.reviseMemory(next.m.id, 1, { decision: "confirm" }),
    ).toThrow("candidate_unavailable");
    await x.h.tick();
    expect(get(x, next.m).lifecycleMetadata?.terminalReason).toBe(
      "source_invalidated",
    );
    const valid = await pending(x);
    x.h.reviseMemory(valid.m.id, 1, { pinned: true });
    expect(() =>
      x.h.reviseMemory(valid.m.id, 1, { decision: "confirm" }),
    ).toThrow("revision_conflict");
  });
  it("新候选保留上限20，过期不挤占名额，所有退出原因可统计", () => {
    const x = make();
    for (let i = 0; i < 22; i++) {
      x.clock.advance(1);
      x.h.addMemory({ text: `待确认${i}` }, true);
    }
    expect(x.store.byStatus("memories", ["pending"])).toHaveLength(20);
    expect(x.h.memoryMetrics("synthetic").overflow).toBe(2);
    x.clock.advance(7 * 86400000 + 1);
    x.h.addMemory({ text: "新候选" }, true);
    expect(x.store.byStatus("memories", ["pending"])).toHaveLength(1);
    expect(x.h.memoryMetrics("synthetic").expired).toBe(20);
  });
  it("主动配额每日一张；无关、专注、免打扰、危机、运行中不展示；明确目标不占配额", async () => {
    const x = make();
    const first = await pending(x, "偏爱乌龙茶", "聊聊乌龙茶");
    expect(currentCandidateOffer(x.store, x.clock.now())?.kind).toBe("related");
    x.h.reviseMemory(first.m.id, 1, { decision: "discard" });
    const second = await pending(x, "更喜欢红茶", "红茶的滋味");
    expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
    const explicit = await pending(
      x,
      "请记住爬山这个爱好",
      "请记住爬山这个爱好",
    );
    expect(currentCandidateOffer(x.store, x.clock.now())?.memory.id).toBe(
      explicit.m.id,
    );
    for (const flag of ["focused", "muted"] as const) {
      x.store.saveSettings({ ...x.store.settings(), [flag]: true });
      expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
      x.store.saveSettings({ ...x.store.settings(), [flag]: false });
    }
    x.h.reviseMemory(explicit.m.id, 1, { decision: "later" });
    x.clock.advance(86400000);
    const unrelated = x.h.submit("现在讨论量子计算", "unrelated");
    await x.h.waitForIdle();
    expect(prepareCandidateOffer(x.store, x.clock.now())).toBe(false);
    expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
    const msg = x.store.require("messages", unrelated.messageId);
    x.store.put("messages", { ...msg, content: "我现在想自杀，红茶" });
    expect(prepareCandidateOffer(x.store, x.clock.now())).toBe(false);
    expect(get(x, second.m).status).toBe("pending");
  });
  it("自然/合成/未知分离，7天未成熟不算失败；只读SQL不读取正文和迁移", async () => {
    const x = make({ config: { trafficOrigin: "natural" } });
    const schema = x.store.db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    const { m } = await pending(x);
    const offer = currentCandidateOffer(x.store, x.clock.now())!;
    x.h.candidateExposure(m.id, offer.offerId);
    x.h.reviseMemory(m.id, 1, { decision: "confirm" });
    const early = x.h.memoryMetrics("natural");
    expect(early).toMatchObject({
      produced: 1,
      displayed: 1,
      confirmed: 1,
      inputs: 1,
      assessment: "insufficient_natural_sample",
      rates: { maturedConfirmation: null },
      denominators: { maturedCohort: 0 },
    });
    x.clock.advance(7 * 86400000);
    const readonly = new Database(join(x.dir, "companion.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const report = candidateMetrics(
        readonly,
        x.store.scope,
        x.clock.now(),
        "natural",
      );
      expect(report.rates.maturedConfirmation).toBeNull();
      expect(report.cohorts[0]?.producedPer100Inputs).toBeNull();
      expect(report.denominators.maturedCohort).toBe(1);
      expect(JSON.stringify(report)).not.toContain(m.text);
      expect(report.censoredCount).toBeNull();
      expect(readonly.pragma("user_version", { simple: true })).toBe(1);
      expect(
        readonly
          .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
          .all(),
      ).toEqual(schema);
    } finally {
      readonly.close();
    }
  });
  it("遗忘清除关联 lifecycle 和卡片；更正根记录不保留可回放确认收据", async () => {
    const x = make();
    const { m, r } = await pending(x);
    const corrected = x.h.reviseMemory(
      m.id,
      1,
      { text: "修正后的资料", decision: "confirm" },
      "fix",
    );
    x.h.forget([], [corrected.id]);
    expect(get(x, m).lifecycleMetadata).toBeUndefined();
    expect(get(x, corrected).lifecycleMetadata).toBeUndefined();
    expect(x.store.settings().memoryCandidateOffer).toBeUndefined();
    expect(x.store.require("sources", r.messageId).deleted).toBe(false);
    expect(x.h.memoryMetrics("synthetic").produced).toBe(0);
  });
  it("真实受保护 API 的展示、确认和维护入口共用命令；不能由请求伪造流量来源", async () => {
    const x = make();
    const app = await createApp(x.h);
    await app.ready();
    cleanup.unshift(() => app.close());
    const b = await app.inject({ url: "/bootstrap" });
    const headers = {
      cookie: `harness_session=${b.cookies[0]!.value}`,
      "x-local-token": b.json().csrfToken,
    };
    const { m } = await pending(x);
    const offer = currentCandidateOffer(x.store, x.clock.now())!;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/memory/${m.id}/exposure`,
          headers,
          payload: { offerId: offer.offerId },
        })
      ).statusCode,
    ).toBe(200);
    const payload = {
      id: m.id,
      expectedRevision: m.revision,
      changes: { decision: "confirm" },
      idempotencyKey: "api",
    };
    const a = await app.inject({
      method: "POST",
      url: "/v1/memory/corrections",
      headers,
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/memory/corrections",
      headers,
      payload,
    });
    expect(a.statusCode).toBe(200);
    expect(replay.json()).toEqual(a.json());
    expect(
      (
        await app.inject({
          url: "/v1/memory/metrics?traffic=synthetic",
          headers,
        })
      ).json(),
    ).toMatchObject({ produced: 1, displayed: 1, confirmed: 1 });
    expect((await app.inject({ url: "/v1/memory/metrics" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/memory",
          headers,
          payload: { text: "不能伪造", trafficOrigin: "natural" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("进程重建后同一确认仍幂等，只读 CLI 输出元数据且旧库版本不变", async () => {
    const x = make();
    const { m } = await pending(x);
    const saved = x.h.reviseMemory(m.id, 1, { decision: "confirm" }, "durable");
    const reopened = new Store(x.dir, x.store.scope),
      restarted = new Harness(reopened, x.h.model, x.config, x.clock);
    try {
      expect(
        restarted.reviseMemory(m.id, 1, { decision: "confirm" }, "durable"),
      ).toEqual(saved);
    } finally {
      await restarted.close();
    }
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/memory-metrics.ts",
        "--data-dir",
        x.dir,
        "--traffic",
        "synthetic",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(m.text);
    expect(JSON.parse(result.stdout).reports[0]).toMatchObject({
      botId: "xiaoye",
      produced: 1,
      confirmed: 1,
    });
    expect(x.store.db.pragma("user_version", { simple: true })).toBe(1);
  });
  it("十个自然展示且 cohort 满七天后仅开放评审，仍不自动通过 MEM-G1", async () => {
    const x = make({ config: { trafficOrigin: "natural" } });
    for (let i = 0; i < 10; i++) {
      const { m } = await pending(
        x,
        `请记住合成资料${i}`,
        `请记住合成资料${i}`,
      );
      const offer = currentCandidateOffer(x.store, x.clock.now())!;
      x.h.candidateExposure(m.id, offer.offerId);
      x.h.reviseMemory(m.id, 1, { decision: "confirm" });
      x.clock.advance(1);
    }
    expect(
      x.h.memoryMetrics("natural").rates.confirmationAfterDisplay,
    ).toBeNull();
    x.clock.advance(7 * 86400000);
    expect(x.h.memoryMetrics("natural")).toMatchObject({
      assessment: "review_required",
      produced: 10,
      displayed: 10,
      confirmed: 10,
      rates: { maturedConfirmation: 1 },
      denominators: { maturedCohort: 10 },
    });
  });
  it("明确保存当前来源不被旧相关候选抢占，负向保存指令不显示卡片", async () => {
    const x = make();
    const seed = x.h.submit("旧茶偏好", "old-tea");
    await x.h.waitForIdle();
    const old = x.h.addMemory(
      { text: "旧茶偏好", sourceIds: [seed.messageId] },
      true,
    );
    const current = x.h.submit("请记住这次的新茶偏好", "current-tea");
    await x.h.waitForIdle();
    expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
    const newer = x.h.addMemory(
      { text: "居住城市是京城", sourceIds: [current.messageId] },
      true,
    );
    await x.h.tick();
    expect(currentCandidateOffer(x.store, x.clock.now())?.memory.id).toBe(
      newer.id,
    );
    expect(get(x, old).status).toBe("pending");
    const refused = await pending(x, "不要记住这条", "不要记住这条");
    expect(currentCandidateOffer(x.store, x.clock.now())).toBeNull();
    expect(get(x, refused.m).status).toBe("pending");
  });
  it("不保存后，同来源的迟到提取和重复工具不能重新产生同一候选", async () => {
    let sourceId = "";
    const model = new ScriptedModel(async function* (r) {
      yield* response(
        r.purpose === "extract"
          ? JSON.stringify({
              assertions: [
                {
                  text: "我喜欢乌龙茶",
                  category: "preference",
                  certainty: "stated",
                  sourceIds: [sourceId],
                },
              ],
              openLoops: [],
            })
          : "合成回复",
      );
    });
    const x = make({ model });
    const { m, r } = await pending(x);
    sourceId = r.messageId;
    x.h.reviseMemory(m.id, 1, { decision: "discard" });
    expect(() =>
      x.h.addMemory({ text: m.text, sourceIds: [sourceId] }, true),
    ).toThrow("candidate_previously_discarded");
    x.clock.advance(2000);
    await x.h.tick();
    await x.h.waitForIdle();
    expect(x.store.byStatus("memories", ["pending"])).toHaveLength(0);
    expect(x.h.memoryMetrics("synthetic").produced).toBe(1);
    const newer = x.h.submit("请记住，我喜欢乌龙茶", "reconsider");
    await x.h.waitForIdle();
    expect(
      x.h.addMemory({ text: m.text, sourceIds: [newer.messageId] }, true)
        .status,
    ).toBe("pending");
  });
});
