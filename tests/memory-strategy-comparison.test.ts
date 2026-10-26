import { afterEach, expect, it } from "vitest";
import { setup } from "./helpers.js";
import { readFacts, projectedTokens } from "../src/memory/reading.js";
import {
  installStrategy,
  comparisonWireRequest,
  actualDelivery,
  sourceRecall,
} from "../scripts/lib/memory-strategy-comparison.js";
import type { ModelRequest } from "../src/model.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
it("complete recall requires every supporting record; no-answer cases have no recall score", () => {
  expect(sourceRecall(["a", "b"], ["a"])).toEqual({
    matched: 1,
    required: 2,
    complete: false,
  });
  expect(sourceRecall(["a", "b"], ["b", "a", "noise"])).toMatchObject({
    complete: true,
  });
  expect(sourceRecall([], ["noise"])).toEqual({
    matched: 0,
    required: 0,
    complete: null,
  });
});
it("full reference reads all qualified facts, keyword keeps the native top-five budget", async () => {
  const x = setup({
    config: { memoryV2: true, memoryVectors: false, memorySummaries: false },
  });
  cleanup.push(x.dispose);
  for (let i = 0; i < 32; i++)
    x.h.addMemory({
      text: `资料${i}：合成用户的独立事实，不能据此推断任何其他属性。`,
    });
  const excluded = x.h.addMemory({ text: "资料：失效来源控制" });
  const src = x.store.require("sources", excluded.sources[0]!.id);
  x.store.put("sources", { ...src, deleted: true });
  x.h.addMemory({ text: "资料：未确认控制", certainty: "stated" }, true);
  installStrategy(x.h, "all");
  const full = await x.h.memory.facts("资料", x.clock.now());
  expect(full.mode).toBe("all");
  expect(full.selected).toHaveLength(32);
  expect(full.selected.some((m) => m.id === excluded.id)).toBe(false);
  expect(projectedTokens(full.selected)).toBeGreaterThan(2000);
  installStrategy(x.h, "keyword");
  const keyword = await x.h.memory.facts("资料", x.clock.now());
  expect(keyword.mode).toBe("keyword");
  expect(keyword.selected.length).toBeLessThanOrEqual(5);
  expect(keyword.allEligibleFactsIncluded).toBe(false);
});
it("E5 strategy delegates to the real retrieval boundary with a fixed 2000 budget", async () => {
  const x = setup();
  cleanup.push(x.dispose);
  const received: unknown[][] = [];
  x.h.memory.facts = async (...args) => {
    received.push(args);
    return readFacts(x.store, args[0], args[1]);
  };
  installStrategy(x.h, "e5");
  const signal = new AbortController().signal;
  await x.h.memory.facts(
    "原始自然问题",
    x.clock.now(),
    5,
    999,
    "reality",
    signal,
  );
  expect(received).toEqual([
    ["原始自然问题", x.clock.now(), 5, 2000, "reality", signal],
  ]);
});
function request(): ModelRequest {
  return {
    purpose: "chat",
    model: "same",
    system: "same system",
    signal: new AbortController().signal,
    maxOutputTokens: 200,
    messages: [
      {
        role: "user",
        content: `<当前状态与记忆数据>\n${JSON.stringify({ instruction: "data", memories: [{ id: "uuid", text: "事实原文", kind: "assertion", certainty: "confirmed" }], conversationSummaries: [{ text: "摘要秘密" }], followUps: [], explicitBoundaries: [], memoryRead: { mode: "all", complete: true } })}\n</当前状态与记忆数据>`,
      },
      { role: "user", content: "过去的聊天秘密" },
      { role: "assistant", content: "过去的回答秘密" },
      { role: "user", content: "现在的自然问题" },
    ],
    tools: [{ name: "search_memory", description: "read", schema: {} }],
  };
}
it("wire projection fixes model options and removes history/summaries/tools without altering the stored request", () => {
  const r = request(),
    before = JSON.stringify(r),
    actual = comparisonWireRequest(r);
  expect(actual).toMatchObject({
    model: "same",
    system: "same system",
    tools: [],
    reasoningEffort: "low",
    maxOutputTokens: 1500,
  });
  expect(actual.messages).toHaveLength(2);
  expect(actual.messages[1]?.content).toBe("现在的自然问题");
  expect(JSON.stringify(actual)).not.toContain("秘密");
  expect(JSON.stringify(r)).toBe(before);
  expect(actualDelivery(actual).memories).toEqual([
    { id: "uuid", text: "事实原文", kind: "assertion", certainty: "confirmed" },
  ]);
});
it("delivery proof refuses hidden history and additional evidence channels", () => {
  expect(() => actualDelivery(request())).toThrow("comparison_extra_evidence");
  const r = comparisonWireRequest(request());
  r.messages.push(
    { role: "assistant", content: "hidden" },
    { role: "user", content: "hidden" },
  );
  expect(() => actualDelivery(r)).toThrow("comparison_history_leak");
});
