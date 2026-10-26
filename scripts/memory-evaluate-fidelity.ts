import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { Harness } from "../src/harness.js";
import { Store } from "../src/store.js";
import { ProviderModel, type ModelRequest } from "../src/model.js";
import { LOCAL_SCOPE } from "../src/domain.js";
import { writePrivateJson } from "../src/files.js";

// Freeze inputs before any requests. Oracles are evaluated after generation;
// neither expected text nor topic-dependent instructions enter the runtime.
const out = resolve(
  process.env.MEMORY_EVAL_OUT ?? "test-results/memory-hybrid-release/fidelity",
);
mkdirSync(out, { recursive: true, mode: 0o700 });
const cases = [
  {
    id: "original-coffee",
    fact: "用户下午两点后喝咖啡只喝不含咖啡因的",
    input: "下午我挑咖啡要遵守什么要求？",
  },
  {
    id: "new-budget",
    fact: "用户买耳机的预算不超过350元",
    input: "我耳机预算的上限是什么？推荐时怎么筛？",
  },
  {
    id: "new-minimum",
    fact: "用户选保温杯要求容量至少600毫升",
    input: "选杯子时容量怎么考虑？",
  },
  {
    id: "new-exclusion",
    fact: "用户不喜欢薰衣草香味",
    input: "按我的喜好选香薰，什么味道要避开？",
  },
  {
    id: "new-condition",
    fact: "用户夜间睡觉不播放人声，白天午休可以放播客",
    input: "晚上准备睡觉，声音怎么安排好？",
  },
  {
    id: "new-time",
    fact: "用户周末的活动不安排在上午11点以前",
    input: "周六跟朋友碰面，时间怎么选？",
  },
  {
    id: "new-exclusive",
    fact: "用户买笔记本电脑只考虑有实体键盘的，不接受只有触屏的",
    input: "我挑电脑最不能妥协的要求是什么？",
  },
  {
    id: "current-update",
    fact: "用户买耳机的预算不超过350元",
    input: "我现在把耳机预算上限改成500元了，450元是否在新预算内？",
  },
  {
    id: "hypothesis",
    fact: "用户只用无香型洗发水",
    input: "假如别人用淡香的，那我原本的偏好是什么？",
  },
  {
    id: "other-person",
    fact: "用户妹妹偏爱红色，用户自己只选蓝色运动鞋",
    input: "给我妹妹挑运动鞋，她喜欢什么颜色？",
  },
  {
    id: "known-unknown",
    fact: "用户养了一只猫，名叫芝麻",
    input: "芝麻叫什么、今年几岁了？",
  },
  {
    id: "unrelated",
    fact: "用户买保温杯至少600毫升",
    input: "今天想和你聊聊窗外的雨。",
  },
  {
    id: "repair-budget",
    fact: "用户单次午餐预算最多40元",
    input: "午餐推荐要怎么符合我的预算？",
    injectedDraft: "你午餐预算最多40元，35元或50元的套餐都可以选。",
  },
  {
    id: "repair-exclusive",
    fact: "用户只选择没有人声的睡眠音频",
    input: "睡觉时选什么音频？",
    injectedDraft: "你只要没有人声的，轻声朗读或纯音乐都可以。",
  },
];
const raw = JSON.stringify(cases);
writePrivateJson(join(out, "frozen-inputs.json"), {
  cases,
  hash: createHash("sha256").update(raw).digest("hex"),
  sameAuthorSynthetic: true,
  injectedDraftIsFaultInjection: true,
});
const report: { rows: Record<string, unknown>[] } = { rows: [] };
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), "memory-fidelity-"));
  const config = loadConfig({
    dataDir: dir,
    modelMode: "deepseek",
    memoryV2: true,
    memoryVectors: false,
    memorySummaries: false,
    memoryAnswerReasoning: true,
    memoryReplyGuard: true,
    trafficOrigin: "synthetic",
  });
  const store = new Store(dir, LOCAL_SCOPE);
  store.saveSettings({
    ...store.settings(),
    remoteDisclosureAcknowledged: true,
    autoExtract: false,
    proactiveEnabled: false,
    dailyTokenBudget: 2000000,
  });
  const provider = new ProviderModel(config, () => store.settings().model);
  const calls: Record<string, unknown>[] = [];
  let injected = false;
  const h = new Harness(
    store,
    {
      name: provider.name,
      async *stream(request: ModelRequest) {
        const { signal: _s, ...safe } = request;
        const call: Record<string, unknown> = { request: safe, text: "" };
        calls.push(call);
        if (c.injectedDraft && request.purpose === "chat" && !injected) {
          injected = true;
          call.injected = true;
          call.text = c.injectedDraft;
          yield { type: "text", text: c.injectedDraft };
          yield {
            type: "finish",
            reason: "stop",
            usage: {
              calls: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimated: true,
            },
          };
          return;
        }
        for await (const e of provider.stream(request)) {
          if (e.type === "text") call.text = String(call.text) + e.text;
          yield e;
        }
      },
    },
    config,
    { now: () => Date.parse("2026-10-24T16:32:00Z") },
  );
  try {
    h.addMemory({ text: c.fact, realityScope: "reality" });
    const r = h.submit(c.input, randomUUID());
    await h.waitForIdle(70000);
    report.rows.push({
      test: c,
      run: store.require("runs", r.runId),
      answer: store
        .all("messages")
        .filter((m) => m.runId === r.runId && m.role === "assistant")
        .map((m) => m.content)
        .join("\n"),
      calls,
      trace: store.traces(r.runId),
      context: h.context(r.runId),
    });
    writePrivateJson(join(out, "results.json"), report);
    console.log(c.id, store.require("runs", r.runId).status);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
