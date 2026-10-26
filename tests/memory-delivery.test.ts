import { expect, it } from "vitest";
import { deliveredFixtureFacts } from "../scripts/lib/memory-delivery.js";
import type { TurnMessage } from "../src/model.js";

const facts = [
  { actualId: "a", id: "fixture-a", text: "已确认事实A" },
  { actualId: "b", id: "fixture-b", text: "已确认事实B" },
];
const context: TurnMessage = {
  role: "user",
  content:
    "<当前状态与记忆数据>\n" +
    JSON.stringify({ memories: [{ id: "a", text: facts[0]!.text }] }) +
    "\n</当前状态与记忆数据>",
};
it("初始上下文与实际交付的工具结果均可支持引用，不只看初始top5", () => {
  const result = deliveredFixtureFacts(
    [
      context,
      {
        role: "tool",
        toolName: "search_memory",
        content: JSON.stringify({ items: [{ id: "b", text: facts[1]!.text }] }),
      },
    ],
    facts,
  );
  expect(result.map((f) => [f.id, f.via])).toEqual([
    ["fixture-a", "context"],
    ["fixture-b", "search_memory"],
  ]);
});
it.each([
  {
    role: "user",
    toolName: "search_memory",
    content: JSON.stringify({ items: [{ id: "b", text: facts[1]!.text }] }),
  },
  {
    role: "tool",
    toolName: "other_tool",
    content: JSON.stringify({ items: [{ id: "b", text: facts[1]!.text }] }),
  },
  {
    role: "tool",
    toolName: "search_memory",
    content: JSON.stringify({ items: [{ id: "b" }] }),
  },
  {
    role: "tool",
    toolName: "search_memory",
    content: JSON.stringify({ items: [{ id: "b", text: "只有节选" }] }),
  },
  {
    role: "tool",
    toolName: "search_memory",
    content: JSON.stringify({
      items: [{ id: "b", text: facts[1]!.text, projectionTruncated: true }],
    }),
  },
  { role: "tool", toolName: "search_memory", content: '{"items":[' },
] as TurnMessage[])(
  "伪造角色、其他工具、未交付全文或损坏结果不授予证据：%j",
  (value) => {
    expect(
      deliveredFixtureFacts([context, value], facts).map((f) => f.id),
    ).toEqual(["fixture-a"]);
  },
);
it("完整来源展开可以交付，正文不符、未知ID及没有实际进入请求的缓存不能交付", () => {
  const messages: TurnMessage[] = [
    context,
    {
      role: "tool",
      toolName: "read_memory_source",
      content: JSON.stringify({ id: "memory:b", text: facts[1]!.text }),
    },
  ];
  expect(deliveredFixtureFacts(messages, facts).map((f) => f.id)).toEqual([
    "fixture-a",
    "fixture-b",
  ]);
  expect(deliveredFixtureFacts([context], facts).map((f) => f.id)).toEqual([
    "fixture-a",
  ]);
  messages[1]!.content = JSON.stringify({
    id: "memory:fake",
    text: facts[1]!.text,
  });
  expect(deliveredFixtureFacts(messages, facts).map((f) => f.id)).toEqual([
    "fixture-a",
  ]);
});
