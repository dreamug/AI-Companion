import { tokenEstimate } from "../domain.js";
import { textHash, utf16Boundary } from "./evidence.js";
export function memoryChunks(text: string) {
  const chunks: { start: number; end: number; text: string; hash: string }[] =
    [];
  let start = 0;
  // At most 120 Unicode scalars: even byte-fallback tokenizers stay under 512,
  // and the encoder additionally rejects overlong input instead of truncating.
  while (start < text.length) {
    let end = start,
      count = 0;
    while (end < text.length && count < 120) {
      end += text.codePointAt(end)! > 0xffff ? 2 : 1;
      count++;
    }
    if (end < text.length) {
      const part = text.slice(start, end);
      const split = Math.max(
        part.lastIndexOf("。"),
        part.lastIndexOf("\n"),
        part.lastIndexOf("；"),
      );
      if (split > part.length / 2) end = start + split + 1;
    }
    const value = text.slice(start, end);
    chunks.push({ start, end, text: value, hash: textHash(value) });
    if (end === text.length) break;
    let next = Math.max(start + 1, end - 24);
    while (!utf16Boundary(text, next)) next++;
    start = next;
  }
  return chunks;
}
export function excerpt(
  text: string,
  query: string,
  budget = 700,
  preferred?: { start: number; end: number },
) {
  if (tokenEstimate(text) <= budget) return { text, partial: false };
  const terms = Array.from(query.normalize("NFKC"))
    .map((_, i) => query.slice(i, i + 2))
    .filter((t) => t.length === 2);
  let best = memoryChunks(text)
    .map((c) => ({
      ...c,
      score: terms.filter((t) => c.text.includes(t)).length,
    }))
    .sort((a, b) => b.score - a.score || a.start - b.start)[0]!;
  if (preferred && best.score === 0)
    best = {
      ...best,
      ...preferred,
      text: text.slice(preferred.start, preferred.end),
    };
  let start = Math.max(0, best.start - 100),
    end = Math.min(text.length, best.end + 100);
  while (!utf16Boundary(text, start)) start--;
  while (!utf16Boundary(text, end)) end--;
  return {
    text: `[长记录节选，不能据此枚举全部属性；必要时展开来源]\n${start > 0 ? "[记录开头限定] " + text.slice(0, 80) + "\n" : ""}${text.slice(start, end)}`,
    partial: true,
    start,
    end,
  };
}
