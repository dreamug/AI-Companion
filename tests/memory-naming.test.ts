import { it, expect } from "vitest";
import {
  nameMentions,
  namingReferenceMessages,
  parseNamingReferences,
  namingReferenceChecks,
} from "../src/memory/naming.js";
import type { CriticalProfileEntry } from "../src/memory/address.js";
const profile = (value: string): CriticalProfileEntry[] => [
  {
    key: "preferred_address",
    value,
    text: value,
    id: "slot",
    revision: 1,
    sources: [{ id: "source", revision: 1 }],
    learnedAt: 1,
  },
];
const references = (
  bearer: "speaker" | "addressee",
  use: "current" | "reference" = "current",
) => [{ id: 0, bearer, use }];
it.each([
  ["我称呼你为晨星。", "addressee", false],
  ["你称呼我为晨星。", "speaker", true],
  ["我的名字是晨星。", "speaker", true],
] as const)(
  "binds %s to its parsed bearer without rewriting the text",
  (draft, bearer, reject) => {
    const mentions = nameMentions(draft, profile("晨星"), "知舟");
    const refs = parseNamingReferences(
      { references: references(bearer) },
      mentions,
    );
    expect(namingReferenceChecks(draft, mentions, refs).length > 0).toBe(
      reject,
    );
  },
);
it("accepts the character's own name and legitimate equal names", () => {
  for (const userName of ["晨星", "知舟", "知舟"]) {
    const draft = "我叫知舟。",
      ms = nameMentions(draft, profile(userName), "知舟");
    expect(namingReferenceChecks(draft, ms, references("speaker"))).toEqual([]);
  }
});
it("quotation, negation and other references do not turn a user's name into an assistant self-claim", () => {
  for (const draft of [
    "你说‘叫我晨星’。",
    "我并不叫晨星。",
    "故事里的人说：我叫晨星。",
  ]) {
    const ms = nameMentions(draft, profile("晨星"), "知舟");
    expect(
      namingReferenceChecks(draft, ms, references("speaker", "reference")),
    ).toEqual([]);
  }
});
it("the syntax request contains the native assistant draft once and never exposes expected name ownership", () => {
  const draft = "你是晨星，我是知舟。",
    ms = nameMentions(draft, profile("晨星"), "知舟");
  const messages = namingReferenceMessages(draft, ms),
    data = JSON.parse(messages[0]!.content);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(messages[1]!.content).toBe(draft);
  expect(data.draft).toBeUndefined();
  expect(
    data.mentions.every((m: Record<string, unknown>) => !("owners" in m)),
  ).toBe(true);
  expect(Object.keys(data)).toEqual(["contractPart", "task", "mentions"]);
});
it.each([
  { references: [] },
  { references: [{ id: 7, bearer: "speaker", use: "current" }] },
  {
    references: [
      { id: 0, bearer: "speaker", use: "current" },
      { id: 0, bearer: "speaker", use: "current" },
    ],
  },
])("rejects incomplete, unknown or duplicate positions: %j", (value) => {
  expect(() =>
    parseNamingReferences(value, nameMentions("晨星", profile("晨星"), "知舟")),
  ).toThrow();
});
it("keeps UTF-16 source positions, handles repeated names separately and shares normalized ownership", () => {
  const draft = "🌙知舟，你说‘知舟’。",
    ms = nameMentions(draft, profile("知舟"), "知舟");
  expect(ms.map((m) => [m.start, m.end])).toEqual([
    [2, 4],
    [8, 10],
  ]);
  expect(ms.every((m) => m.owners.length === 2)).toBe(true);
  const wide = nameMentions("我叫ＡＢ。", profile("ＡＢ"), "AB");
  expect(
    namingReferenceChecks("我叫ＡＢ。", wide, references("speaker")),
  ).toEqual([]);
});
it("does not silently drop a tail when the bounded source table is exceeded", () => {
  expect(() =>
    nameMentions("晨星".repeat(65), profile("晨星"), "知舟"),
  ).toThrow("naming_reference_limit");
});
