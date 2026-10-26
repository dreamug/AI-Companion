import type { TurnMessage } from "../model.js";
import {
  ADDRESS_POLICY,
  type AddressResolution,
  type CriticalProfileEntry,
  type ReplyParticipants,
} from "./address.js";

export const MEMORY_READ_SCOPE_INSTRUCTION =
  "记忆读取状态只描述本轮实际交付范围。readScope.status=unavailable表示本轮读取不可用；no_match表示本次检索未命中；partial表示只交付部分结果或节选。三者都不能推出存储里没有记录、你从未说过或某事不存在。complete也只表示本轮范围内的合格记录完整，不包含全部历史、失效记录或未确认资料。回答已知部分，未知部分只说明本轮依据不足；不把技术原因编成用户经历，不承诺未来一定记得。只在问题需要时简短说明限制，不向普通聊天播报检索流程。";

export function memoryReadScope(
  read: {
    mode?: unknown;
    complete?: unknown;
    reasons?: unknown;
    error?: unknown;
    partial?: unknown;
    projectionTruncated?: unknown;
    nextCursor?: unknown;
  },
  count: number,
  target = "facts",
) {
  const unavailable =
    read.mode === "unavailable" || typeof read.error === "string";
  const complete =
    !unavailable && read.complete === true && read.partial !== true;
  const limited =
    read.mode === "budget_limited" ||
    read.partial === true ||
    read.projectionTruncated === true ||
    typeof read.nextCursor === "string";
  return {
    status: unavailable
      ? ("unavailable" as const)
      : complete
        ? ("complete" as const)
        : count === 0 && !limited
          ? ("no_match" as const)
          : ("partial" as const),
    target,
    scope: "eligible_records_in_this_read" as const,
    resultCount: count,
    storageAbsenceProven: false as const,
  };
}

/** Only program-generated context and memory tool receipts grant read coverage.
 * User messages, prior assistant claims and pasted JSON are never receipts. */
export function memoryReplyReadData(messages: TurnMessage[]) {
  let time:
    { currentTime: string; timezone: string; localHour: number } | undefined;
  const reads: ReturnType<typeof memoryReadScope>[] = [];
  const confirmedFacts = new Map<
    string,
    { id: string; revision: number; text: string; certainty: "confirmed" }
  >();
  const addConfirmed = (items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      if (
        m.kind !== "episode" &&
        m.certainty === "confirmed" &&
        typeof m.id === "string" &&
        typeof m.text === "string" &&
        Number.isInteger(m.revision) &&
        Number(m.revision) > 0
      )
        confirmedFacts.set(m.id, {
          id: m.id,
          revision: Number(m.revision),
          text: m.text,
          certainty: "confirmed",
        });
    }
  };
  const existingFacts: unknown[] = [];
  let criticalProfile: CriticalProfileEntry[] | undefined;
  let addressResolution: AddressResolution | undefined;
  let replyParticipants: ReplyParticipants | undefined;
  const evidence: { text: string; id?: string }[] = [];
  const addEvidence = (items: unknown[]) => {
    for (const item of items) {
      if (
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof item.text === "string"
      )
        evidence.push({
          text: item.text,
          ...("id" in item && typeof item.id === "string"
            ? { id: item.id }
            : {}),
        });
    }
  };
  for (const [index, message] of messages.entries()) {
    const context =
      index === 0 &&
      message.role === "user" &&
      message.content.startsWith("<当前状态与记忆数据>\n");
    const tool =
      message.role === "tool" &&
      ["search_memory", "read_memory_source"].includes(message.toolName ?? "");
    if (!context && !tool) continue;
    try {
      const value = JSON.parse(
        context ? message.content.split("\n")[1]! : message.content,
      );
      if (context) {
        if (
          value.replyParticipants?.speaker?.role === "assistant" &&
          typeof value.replyParticipants.speaker.name === "string" &&
          value.replyParticipants.addressee?.role === "user"
        )
          replyParticipants = {
            speaker: {
              role: "assistant",
              name: value.replyParticipants.speaker.name,
            },
            addressee: { role: "user" },
          };
        if (
          typeof value.currentTime === "string" &&
          typeof value.timezone === "string" &&
          Number.isInteger(value.localHour)
        )
          time = {
            currentTime: value.currentTime,
            timezone: value.timezone,
            localHour: value.localHour,
          };
        const facts = (value.memories ?? []).filter(
          (m: { kind: string }) => m.kind !== "episode",
        );
        reads.push(memoryReadScope(value.memoryRead ?? {}, facts.length));
        addEvidence(value.memories ?? []);
        addConfirmed(facts);
        if (Array.isArray(value.criticalProfile)) {
          criticalProfile = value.criticalProfile;
          addEvidence(value.criticalProfile);
          if (value.addressResolution?.policy === ADDRESS_POLICY)
            addressResolution = value.addressResolution;
        }
        existingFacts.push(
          ...facts.filter(
            (m: { admission?: { state?: string } }) =>
              m.admission?.state === "committed",
          ),
        );
        addEvidence(value.conversationSummaries ?? []);
      } else {
        const source = message.toolName === "read_memory_source";
        const items = source
          ? typeof value.text === "string"
            ? [value]
            : []
          : (value.items ?? []);
        reads.push(
          memoryReadScope(
            value,
            items.length,
            source ? "source" : (value.readScope?.target ?? "search"),
          ),
        );
        addEvidence(items);
        if (!source) addConfirmed(items);
      }
    } catch {
      reads.push(
        memoryReadScope({ mode: "unavailable" }, 0, context ? "facts" : "tool"),
      );
    }
  }
  return {
    reads,
    evidence,
    ...(criticalProfile ? { criticalProfile } : {}),
    ...(addressResolution ? { addressResolution } : {}),
    ...(replyParticipants ? { replyParticipants } : {}),
    ...(existingFacts.length ? { existingFacts } : {}),
    ...(time ? { time } : {}),
    ...(confirmedFacts.size
      ? { confirmedFacts: [...confirmedFacts.values()] }
      : {}),
  };
}
