import type { ModelRequest } from "../../src/model.js";

/** Experiment-only wire projection. Never mutates stored chat or the input. */
export function memoryAblationRequest(request: ModelRequest, memory: boolean) {
  if (request.purpose !== "chat") throw new Error("ablation_chat_only");
  const first = request.messages[0];
  const last = request.messages.at(-1);
  const open = "<当前状态与记忆数据>\n",
    close = "\n</当前状态与记忆数据>";
  if (
    !first?.content.startsWith(open) ||
    !first.content.endsWith(close) ||
    request.messages.length < 2 ||
    last?.role !== "user" ||
    last.toolCalls
  )
    throw new Error("ablation_unexpected_request");
  const state = JSON.parse(first.content.slice(open.length, -close.length));
  let repair = false;
  try {
    repair = JSON.parse(last.content).kind === "unpublished_reply_for_rewrite";
  } catch {
    /* ordinary question */
  }
  const question = repair ? request.messages.at(-2) : last;
  if (!question || question.role !== "user")
    throw new Error("ablation_unexpected_request");
  const facts = state.memories.filter(
    (m: { kind: string; certainty: string }) =>
      m.kind !== "episode" && m.certainty === "confirmed",
  );
  const projected = {
    instruction: state.instruction,
    currentTime: state.currentTime,
    timezone: state.timezone,
    work: state.work,
    explicitBoundaries: [],
    memories: memory ? facts : [],
    followUps: [],
    conversationSummaries: [],
    memoryRead: memory
      ? state.memoryRead
      : {
          mode: "unavailable",
          complete: false,
          reasons: ["experiment_withheld"],
        },
  };
  return {
    ...request,
    messages: [
      {
        role: "user" as const,
        content: open + JSON.stringify(projected) + close,
      },
      { role: "user" as const, content: question.content },
      ...(repair ? [{ role: "user" as const, content: last.content }] : []),
    ],
    tools: [],
  };
}
