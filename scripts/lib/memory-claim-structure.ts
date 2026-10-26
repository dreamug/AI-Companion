export type CompoundScope = {
  relation: "additive" | "concessive";
  arms: { start: number; end: number; quote: string }[];
};
// A short polarity reply asserts the queried predicate; it cannot be hidden
// as a polite filler while the rest of an answer admits that predicate unknown.
export function isPolarityReply(segment: string) {
  return /^(?:会|不会|能|不能|是|不是|对|不对)(?:的|呀|啊|呢|哦|哟|啦|哒)?$/u.test(
    segment.replace(/[\s，,。；;：:！!？?]/gu, ""),
  );
}
const quotePairs: Record<string, string> = {
  "《": "》",
  "「": "」",
  "『": "』",
  "“": "”",
  "‘": "’",
  "（": "）",
  "(": ")",
  "[": "]",
  '"': '"',
};
function quoteRanges(text: string) {
  const stack: { end: string; start: number }[] = [],
    ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (const char of text) {
    if (char === stack.at(-1)?.end) {
      const open = stack.pop()!;
      ranges.push({ start: open.start, end: offset + char.length });
    } else if (quotePairs[char])
      stack.push({ end: quotePairs[char], start: offset });
    offset += char.length;
  }
  return ranges;
}

/** A statement about all prior disclosures needs historical evidence. It is
 * not the same as being unable to answer from this delivery. No topic/ID rules. */
export function historicalDisclosureScopes(text: string) {
  const quoted = quoteRanges(text);
  const spans: { start: number; end: number; quote: string }[] = [];
  const patterns = [
    /(?:从来没(?:有)?|从未|从没)(?:(?:向|对|跟|和)[^。；;！？!?，,]{1,8})?(?:说过|提(?:起|过|及|到)|谈(?:起|过|及|到)|聊(?:起|过|到)|告知|告诉|记载|记录)[^。；;！？!?，,]*/gu,
    /(?:之前|以前|过去)[^。；;！？!?，,]{0,15}(?:没(?:有)?|未)(?:曾)?(?:说过|提(?:起|过|及|到)|谈(?:起|过|及|到)|聊(?:起|过|到)|告知|告诉|记载|记录)[^。；;！？!?，,]*/gu,
    /(?:全库|全部历史|所有历史)[^。；;！？!?，,]{0,15}(?:没有|不存在|未记录|无记录)[^。；;！？!?，,]*/gu,
  ];
  for (const pattern of patterns)
    for (const m of text.matchAll(pattern)) {
      if (quoted.some((q) => m.index >= q.start && m.index < q.end)) continue;
      const before =
        text
          .slice(0, m.index)
          .split(/[。；;！？!?，,]/u)
          .at(-1) ?? "";
      if (
        /(?:不知道|不确定|是否|有没有|可能|也许|不能说|不代表|无法断言|不能断言|并非|不是说)/u.test(
          before,
        )
      )
        continue;
      if (
        !spans.some(
          (s) => s.start === m.index && s.end === m.index + m[0].length,
        )
      )
        spans.push({ start: m.index, end: m.index + m[0].length, quote: m[0] });
    }
  return spans;
}

/** Syntactic coverage obligations, not an entailment scorer. These productive
 * paired constructions assert both arms even when one is backgrounded. Offsets
 * use JS UTF-16. Unknown constructions still require semantic decomposition.
 * No entity, attribute, fixture ID or expected answer appears in these rules.
 */
export function compoundScopes(text: string): CompoundScope[] {
  const scopes: CompoundScope[] = [];
  const quoted = quoteRanges(text);
  const patterns: [CompoundScope["relation"], RegExp][] = [
    [
      "additive",
      /除了(?<left>[^。；;！？!?]+?)(?:之外|以外)[，,\s]*(?<right>(?:也|还)[^。；;！？!?]+)/dgu,
    ],
    [
      "additive",
      /(?:不但|不仅)(?<left>[^。；;！？!?]+?)[，,\s]*(?<right>(?:而且|还|也)[^。；;！？!?]+)/dgu,
    ],
    [
      "additive",
      /既(?<left>[^。；;！？!?]+?)[，,\s]*(?<right>又[^。；;！？!?]+)/dgu,
    ],
    [
      "concessive",
      /虽然(?<left>[^。；;！？!?]+?)[，,\s]*(?<right>(?:但是|但)[^。；;！？!?]+)/dgu,
    ],
  ];
  for (const [relation, pattern] of patterns) {
    for (const m of text.matchAll(pattern)) {
      if (quoted.some((range) => m.index >= range.start && m.index < range.end))
        continue;
      const arms = ["left", "right"].map((key) => {
        const [start, end] = m.indices!.groups![key]!;
        return { start, end, quote: text.slice(start, end) };
      });
      scopes.push({ relation, arms });
    }
  }
  return scopes;
}

/** Preserve every character while making punctuation clauses and both arms
 * visible independently. Quoted names/titles containing punctuation stay whole.
 * This does not classify any segment as true or as a fact.
 */
export function answerSegments(text: string): string[] {
  const boundaries = new Set([0, text.length]);
  const quoted = quoteRanges(text);
  let offset = 0;
  let introChecked = false;
  for (const char of text) {
    offset += char.length;
    if (quoted.some((range) => offset > range.start && offset < range.end))
      continue;
    if (/[。；;！!？?\n]/u.test(char)) boundaries.add(offset);
    if (!introChecked && /[，,：:]/u.test(char)) {
      introChecked = true;
      const intro = text.slice(0, offset - char.length).trim();
      // Keep a short opening call/acknowledgment visible; do not split every
      // comma in an otherwise single unknown/conditional proposition.
      if (
        Array.from(intro).length <= 8 &&
        /^[\p{L}\p{N}\p{Extended_Pictographic}]+$/u.test(intro)
      )
        boundaries.add(offset);
    }
  }
  for (const scope of compoundScopes(text))
    boundaries.add(scope.arms[1]!.start);
  const sorted = [...boundaries].sort((a, b) => a - b);
  return sorted
    .slice(1)
    .map((end, i) => text.slice(sorted[i], end))
    .filter(Boolean);
}
