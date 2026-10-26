/** Presentation only: no extra model call and no rewriting of the reply. */
export const SPLIT_REPLY_INSTRUCTION =
  "\n本轮已开启分条回复：日常聊天可按自然语义，用空行分成1到4条适合逐条发送的短消息。简短回应只需一条，不必凑条数；代码、列表和需要连贯阅读的长解释保持完整。不输出消息编号、JSON或发送时间。";

export function splitReply(text: string): string[] {
  const body = text.trim();
  // Structured and long-form answers are easier to read intact.
  if (
    body.length > 600 ||
    /`|~~~|https?:\/\/|^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s)|^\s*\|/m.test(body)
  )
    return [body];

  const parts: string[] = [];
  const pairs: Record<string, string> = {
    "（": "）",
    "(": ")",
    "[": "]",
    "【": "】",
    "{": "}",
    "“": "”",
    "‘": "’",
    "「": "」",
    "『": "』",
    '"': '"',
  };
  const stack: string[] = [];
  // Prefer the model's semantic blank-line boundaries. Otherwise use complete
  // sentences, without splitting a quote, bracket, URL, or decimal number.
  const paragraphs = /\n[ \t]*\r?\n/.test(body);
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (stack.at(-1) === char) stack.pop();
    else if (pairs[char]) stack.push(pairs[char]!);
    if (stack.length) continue;
    let end = i + 1;
    if (paragraphs) {
      if (char !== "\n") continue;
      const gap = body.slice(i).match(/^\n[ \t]*\r?\n[\s]*/);
      if (!gap) continue;
      end = i + gap[0].length;
    } else {
      if (!/[。！？!?]/u.test(char)) continue;
      while (end < body.length && /[。！？!?]/u.test(body[end]!)) end++;
    }
    const part = body.slice(start, end).trim();
    if (part) parts.push(part);
    start = end;
    i = end - 1;
    if (parts.length === 3) break;
  }
  const tail = body.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [body];
}

export function replyDelayMs(text: string): number {
  return Math.min(1500, Math.max(800, text.length * 35));
}
