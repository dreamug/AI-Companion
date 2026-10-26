import { describe, expect, it } from "vitest";
import { memoryAblationRequest } from "../scripts/lib/memory-ablation.js";
import type { ModelRequest } from "../src/model.js";

function request(): ModelRequest {
  return {
    purpose: "chat",
    model: "test",
    system: "unchanged",
    signal: new AbortController().signal,
    maxOutputTokens: 100,
    messages: [
      {
        role: "user",
        content: `<当前状态与记忆数据>\n${JSON.stringify({
          instruction: "data",
          memories: [
            { kind: "fact", certainty: "confirmed", text: "confirmed fact" },
            { kind: "episode", certainty: "confirmed", text: "daily summary" },
            { kind: "fact", certainty: "pending", text: "pending guess" },
          ],
          conversationSummaries: ["old summary"],
          followUps: ["old followup"],
          explicitBoundaries: ["old boundary"],
          unknownField: "hidden text",
          memoryRead: { mode: "all", complete: true },
        })}\n</当前状态与记忆数据>`,
      },
      { role: "user", content: "old user text" },
      { role: "assistant", content: "old assistant text" },
      { role: "user", content: "current question" },
    ],
    tools: [{ name: "read_memory_source", description: "expand", schema: {} }],
  };
}
describe("experiment wire ablation", () => {
  it("removes history, summaries, other text channels and tools without mutating input", () => {
    const original = request(),
      before = JSON.stringify(original);
    const actual = memoryAblationRequest(original, true),
      text = JSON.stringify(actual);
    expect(actual.messages).toHaveLength(2);
    expect(actual.messages[1]?.content).toBe("current question");
    expect(actual.tools).toEqual([]);
    expect(actual.system).toBe(original.system);
    expect(text).toContain("confirmed fact");
    for (const s of [
      "old user text",
      "old assistant text",
      "old summary",
      "daily summary",
      "pending guess",
      "old followup",
      "old boundary",
      "hidden text",
    ])
      expect(text).not.toContain(s);
    expect(JSON.stringify(original)).toBe(before);
  });
  it("withholds all facts in the negative control and marks coverage incomplete", () => {
    const actual = memoryAblationRequest(request(), false);
    expect(JSON.stringify(actual)).not.toContain("confirmed fact");
    expect(actual.messages[0]?.content).toContain('"complete":false');
  });
  it("refuses unexpected request shapes instead of passing through leaked history", () => {
    const r = request();
    r.messages[0]!.content = "different format";
    expect(() => memoryAblationRequest(r, true)).toThrow(
      "ablation_unexpected_request",
    );
  });
  it("refuses background and tool continuation requests", () => {
    const r = request();
    r.purpose = "summary";
    expect(() => memoryAblationRequest(r, true)).toThrow("ablation_chat_only");
    const t = request();
    t.messages.push({ role: "tool", content: "old source" });
    expect(() => memoryAblationRequest(t, true)).toThrow(
      "ablation_unexpected_request",
    );
  });
  it("keeps the unpublished repair data and current question, excluding old history", () => {
    const r = request();
    r.messages.push({
      role: "user",
      content: JSON.stringify({
        kind: "unpublished_reply_for_rewrite",
        draft: "draft data",
      }),
    });
    const actual = memoryAblationRequest(r, true);
    expect(actual.messages).toHaveLength(3);
    expect(actual.messages[1]?.content).toBe("current question");
    expect(actual.messages[2]?.content).toContain("draft data");
    expect(JSON.stringify(actual.messages)).not.toContain("old user text");
  });
});
