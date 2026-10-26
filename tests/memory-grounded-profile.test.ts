import { it, expect } from "vitest";
import { setup, ScriptedModel, response } from "./helpers.js";

it.each([
  { enabled: false, v2: true, facts: true, reasoned: false },
  { enabled: true, v2: true, facts: true, reasoned: true },
  { enabled: true, v2: true, facts: false, reasoned: false },
  { enabled: true, v2: false, facts: true, reasoned: false },
])(
  "记忆推理按显式开关、资格及本轮证据选择，不按问题词语分支：%j",
  async ({ enabled, v2, facts, reasoned }) => {
    const model = new ScriptedModel(() => response("本轮回答。"));
    const x = setup({
      model,
      config: {
        memoryV2: v2,
        memoryAnswerReasoning: enabled,
        memorySummaries: false,
      },
    });
    try {
      x.store.saveSettings({
        ...x.store.settings(),
        autoExtract: false,
        dailyTokenBudget: 100000,
      });
      if (facts)
        x.h.addMemory({
          text: "用户希望平时称呼自己为阿遥。",
          realityScope: "reality",
        });
      x.h.submit("打个招呼。", crypto.randomUUID());
      await x.h.waitForIdle();
      const request = model.requests.find((r) => r.purpose === "chat")!;
      expect(request.reasoningEffort).toBe(reasoned ? "low" : undefined);
      expect(request.maxOutputTokens).toBe(300 + (reasoned ? 4096 : 0));
      expect(
        x.store.usageRecords().find((r) => r.data.purpose === "chat")!.data
          .reserved,
      ).toBeGreaterThan(request.maxOutputTokens);
    } finally {
      await x.dispose();
    }
  },
);

it("推理选项在接受Run时捕获，之后修改配置不影响已接受请求", async () => {
  const model = new ScriptedModel(() => response());
  const x = setup({
    model,
    config: {
      memoryV2: true,
      memoryAnswerReasoning: true,
      memorySummaries: false,
    },
  });
  try {
    x.store.saveSettings({
      ...x.store.settings(),
      autoExtract: false,
      dailyTokenBudget: 100000,
    });
    x.h.addMemory({ text: "用户喜欢安静的环境。", realityScope: "reality" });
    const r = x.h.submit("你好。", crypto.randomUUID());
    x.config.memoryAnswerReasoning = false;
    await x.h.waitForIdle();
    expect(x.store.require("runs", r.runId).config.memoryAnswerReasoning).toBe(
      true,
    );
    expect(model.requests[0]!.reasoningEffort).toBe("low");
    x.h.submit("再见。", crypto.randomUUID());
    await x.h.waitForIdle();
    expect(model.requests.at(-1)!.reasoningEffort).toBeUndefined();
  } finally {
    await x.dispose();
  }
});

it("推理预留必须先通过预算检查，不能在普通输出预算之外偷用token", async () => {
  const model = new ScriptedModel(() => response());
  const x = setup({
    model,
    config: {
      memoryV2: true,
      memoryAnswerReasoning: true,
      memorySummaries: false,
    },
  });
  try {
    x.store.saveSettings({
      ...x.store.settings(),
      autoExtract: false,
      dailyTokenBudget: 4096,
    });
    x.h.addMemory({ text: "用户喜欢安静的环境。", realityScope: "reality" });
    const r = x.h.submit("你好。", crypto.randomUUID());
    await x.h.waitForIdle();
    expect(model.requests.filter((r) => r.purpose === "chat")).toHaveLength(0);
    expect(x.store.require("runs", r.runId).reason).toBe("budget_exceeded");
  } finally {
    await x.dispose();
  }
});
