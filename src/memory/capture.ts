import type { Store } from "../store.js";
import type { Memory } from "../domain.js";
import type { Message, Run } from "../domain.js";
import { explicitlyRequestsMemory, refusesMemory } from "./candidates.js";

export const MEMORY_CAPTURE_INSTRUCTION =
  "记忆操作由应用处理。聊天正文围绕用户实际谈到的内容或问题展开，不主动解释记忆操作。只有用户主动询问保存状态或流程，才依据真实记录回答。待确认候选不能说成已经确认保存，不承诺未来一定记得。";

export const EXPLICIT_SAVE_REPLY_INSTRUCTION =
  "本轮明确的保存指令已交给应用，memoryCapture仅供内部核对，不向用户复述。你的回复任务是回应消息里的具体内容或回答同时提出的问题。不要回应保存操作本身，不说已收到保存意愿、已记下、已记住或已保存，不谈后台、提取、候选、界面、确认、入库等办理步骤，也不再次询问要不要保存。简短自然地聊内容即可，不能用一段操作回执代替用户要求的解答。";

/** Only factual workflow state enters the request. No suggested answer or
 * user-specific content is inserted, and the intent is owned by this Run. */
export function memoryCaptureState(store: Store, input: Message, run: Run) {
  const explicit =
    typeof run.config.memorySaveIntent === "boolean"
      ? run.config.memorySaveIntent
      : explicitlyRequestsMemory(input.content);
  if (!explicit) return undefined;
  const source = store.get("sources", input.id);
  const job = source
    ? store.get("jobs", `extract:${source.id}:${source.revision}:v2`)
    : undefined;
  return {
    saveIntent: explicit ? ("explicit" as const) : ("none" as const),
    extractionStatus: job?.status ?? "not_queued",
    confirmationOwner: "interface" as const,
    registrationConfirmsMemory: false,
  };
}

export const RETENTION_INSTRUCTION =
  "每条assertion必须包含retention：durable、transient或uncertain。先判断未来跨次聊天是否仍有用，再生成候选：稳定身份、明确偏好、持续习惯、长期约束和重要持续事项可为durable；当前聊天意愿、即时动作、短期忙闲、当下情绪为transient，不因为属于fact或preference就成为长期资料；粒度或持续性不明为uncertain。近期形成但明确的偏好可以是durable，不能仅凭时间词过滤。保留原有时间、否定、主体与范围，不把愿望或假设当事实。用户明确要求保存的短期事实仍标transient，由程序核验保存意图；否则不需要输出临时状态。一个原子事实只输出一次，不用不同措辞重复。同一来源的不同偏好、不同主体、肯定和否定必须分开。";

export function retainAssertion(
  retention: "durable" | "transient" | "uncertain" | undefined,
  sources: string[],
) {
  if (sources.some(refusesMemory)) return false;
  return (
    retention === "durable" ||
    (retention === "transient" && sources.some(explicitlyRequestsMemory))
  );
}

/** Exact normalization only. Semantic ownership, not fuzzy matching, prevents
 * foreground/background paraphrases from becoming two candidates. */
export function duplicateCandidate(
  store: Store,
  candidate: Pick<Memory, "text" | "category" | "subject" | "realityScope">,
  now: number,
) {
  const normalized = (text: string) => text.normalize("NFKC").trim();
  return store
    .all("memories")
    .find(
      (m) =>
        m.kind === "assertion" &&
        (m.status === "pending" || m.status === "active") &&
        m.category === candidate.category &&
        (m.subject ?? "unspecified") === (candidate.subject ?? "unspecified") &&
        (m.realityScope ?? "unspecified") === candidate.realityScope &&
        normalized(m.text) === normalized(candidate.text) &&
        store.sourcesValid(m.sources) &&
        (m.validTo === undefined || m.validTo > now) &&
        (m.status !== "pending" ||
          m.expiresAt === undefined ||
          m.expiresAt > now),
    );
}
