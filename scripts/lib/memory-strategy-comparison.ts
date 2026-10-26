import type { Harness } from "../../src/harness.js";
import { readFacts } from "../../src/memory/reading.js";
import type { ModelRequest } from "../../src/model.js";
import { memoryAblationRequest } from "./memory-ablation.js";

export const STRATEGIES = ["all", "keyword", "e5"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** Fixed retrieval policy, never accepts question labels or expected facts. */
export function installStrategy(h: Harness, strategy: Strategy) {
  const native = h.memory.facts.bind(h.memory);
  h.memory.facts = async (query, now, cutoff, _budget, domain, signal) => {
    if (signal?.aborted) throw new Error("comparison_cancelled");
    return strategy === "e5"
      ? native(query, now, cutoff, 2000, domain, signal)
      : readFacts(
          h.store,
          query,
          now,
          cutoff,
          strategy === "all" ? 12000 : 2000,
          domain,
          strategy === "all",
        );
  };
}

/** Equal reader/model options. Only retrieved records and coverage may differ. */
export function comparisonWireRequest(request: ModelRequest): ModelRequest {
  const actual =
    request.purpose === "chat" ? memoryAblationRequest(request, true) : request;
  return {
    ...actual,
    tools: [],
    reasoningEffort: "low",
    temperature: undefined,
    maxOutputTokens: 1500,
  };
}

export function actualDelivery(request: Pick<ModelRequest, "messages">) {
  const first = request.messages[0];
  if (!first?.content.startsWith("<当前状态与记忆数据>\n"))
    throw new Error("comparison_missing_state");
  const data = JSON.parse(first.content.split("\n")[1]!);
  if (
    data.conversationSummaries?.length ||
    data.followUps?.length ||
    data.explicitBoundaries?.length
  )
    throw new Error("comparison_extra_evidence");
  if (request.messages.length !== 2 && request.messages.length !== 3)
    throw new Error("comparison_history_leak");
  return data as {
    memories: { id: string; text: string; kind: string }[];
    memoryRead: unknown;
  };
}

export function sourceRecall(expected: string[], actual: string[]) {
  return expected.length
    ? {
        matched: expected.filter((id) => actual.includes(id)).length,
        required: expected.length,
        complete: expected.every((id) => actual.includes(id)),
      }
    : { matched: 0, required: 0, complete: null };
}
