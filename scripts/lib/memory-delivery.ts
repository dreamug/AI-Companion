import type { TurnMessage } from "../../src/model.js";

/** Only full fixture facts actually present in the final model request count.
 * Tool cache rows, user-pasted JSON and IDs without text are not delivery proof.
 */
export function deliveredFixtureFacts(
  messages: TurnMessage[],
  facts: { actualId: string; id: string; text: string }[],
) {
  const delivered = new Map<
    string,
    { id: string; actualId: string; text: string; via: string }
  >();
  const accept = (value: unknown, via: string) => {
    if (!value || typeof value !== "object") return;
    const item = value as {
      id?: unknown;
      text?: unknown;
      projectionTruncated?: unknown;
    };
    if (
      typeof item.id !== "string" ||
      typeof item.text !== "string" ||
      item.projectionTruncated
    )
      return;
    const actualId = item.id.replace(/^memory:/u, ""),
      fact = facts.find((f) => f.actualId === actualId && f.text === item.text);
    if (fact) delivered.set(fact.id, { ...fact, via });
  };
  for (const [index, m] of messages.entries()) {
    try {
      if (
        index === 0 &&
        m.role === "user" &&
        m.content.startsWith("<当前状态与记忆数据>\n")
      ) {
        const value = JSON.parse(m.content.split("\n")[1]!) as {
          memories?: unknown[];
        };
        for (const item of value.memories ?? []) accept(item, "context");
      }
      if (
        m.role === "tool" &&
        (m.toolName === "search_memory" || m.toolName === "read_memory_source")
      ) {
        const value = JSON.parse(m.content) as { items?: unknown[] };
        if (m.toolName === "search_memory")
          for (const item of value.items ?? []) accept(item, "search_memory");
        else accept(value, "read_memory_source");
      }
    } catch {
      /* Truncated or malformed data does not grant evidence. */
    }
  }
  return [...delivered.values()];
}
