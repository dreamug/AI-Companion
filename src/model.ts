import { createDeepSeek } from "@ai-sdk/deepseek";
import { createXai } from "@ai-sdk/xai";
import type { AppConfig } from "./config.js";
import { ModelCredentials, providerForModel } from "./model-config.js";
import {
  streamText,
  tool,
  jsonSchema,
  isStepCount,
  Output,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { DomainError, type Usage } from "./domain.js";
import { createHash } from "node:crypto";
import { accountModelPool } from "./model-pool.js";

export type TurnMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  callId?: string;
  toolName?: string;
};
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolDeclaration = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};
export type ModelRequest = {
  background?: boolean;
  purpose: "chat" | "extract" | "summary" | "concern" | "judge" | "eval";
  model: string;
  system: string;
  messages: TurnMessage[];
  tools?: ToolDeclaration[];
  signal: AbortSignal;
  maxOutputTokens: number;
  json?: boolean;
  /** Providers may enforce this or inject it as instructions; always validate returned data. */
  outputSchema?: Record<string, unknown>;
  /** Explicit per-request reasoning; omitted keeps the fast chat default. */
  reasoningEffort?: "low";
  temperature?: 0;
};
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool"; call: ToolCall }
  | {
      type: "finish";
      reason: string;
      usage: Usage;
      providerModel?: string;
      requestId?: string;
    };
export interface ModelPort {
  readonly name: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

class RemoteModel implements ModelPort {
  constructor(
    readonly name: "deepseek" | "grok",
    private key: string | undefined,
    private baseURL: string,
  ) {}
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    if (!this.key) throw new DomainError("model_key_missing", 503);
    const options = { apiKey: this.key, baseURL: this.baseURL };
    const model =
      this.name === "grok"
        ? createXai(options).responses(request.model)
        : createDeepSeek(options)(request.model);
    const messages: ModelMessage[] = request.messages.map((m) => {
      if (m.role === "tool")
        return {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: m.callId!,
              toolName: m.toolName!,
              output: { type: "json" as const, value: JSON.parse(m.content) },
            },
          ],
        };
      if (m.role === "assistant" && m.toolCalls?.length)
        return {
          role: "assistant" as const,
          content: [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...m.toolCalls.map((c) => ({
              type: "tool-call" as const,
              toolCallId: c.id,
              toolName: c.name,
              input: c.input as Record<string, unknown>,
            })),
          ],
        };
      return { role: m.role, content: m.content };
    });
    const tools: ToolSet = {};
    for (const t of request.tools ?? [])
      tools[t.name] = tool({
        description: t.description,
        inputSchema: jsonSchema(t.schema),
      });
    try {
      const result = streamText({
        model,
        system: request.system,
        messages,
        ...(Object.keys(tools).length ? { tools } : {}),
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        maxRetries: 0,
        ...(request.outputSchema
          ? {
              output: Output.object({
                schema: jsonSchema(request.outputSchema),
              }),
            }
          : request.json
            ? { output: Output.json() }
            : {}),
        abortSignal: request.signal,
        stopWhen: isStepCount(1),
        providerOptions:
          this.name === "grok"
            ? {
                xai: {
                  store: false,
                  reasoningEffort: request.reasoningEffort ?? "none",
                },
              }
            : {
                deepseek: request.reasoningEffort
                  ? {
                      thinking: { type: "enabled" },
                      reasoningEffort: request.reasoningEffort,
                    }
                  : { thinking: { type: "disabled" } },
              },
        onError: () => {},
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") yield { type: "text", text: part.text };
        else if (part.type === "tool-call")
          yield {
            type: "tool",
            call: {
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            },
          };
        else if (part.type === "error") throw part.error;
      }
      const usage = await result.totalUsage;
      const response = await result.response;
      yield {
        type: "finish",
        reason: await result.finishReason,
        providerModel: response.modelId,
        requestId: response.id,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedTokens: usage.inputTokenDetails?.cacheReadTokens,
          calls: 1,
          estimated: false,
        },
      };
    } catch (error) {
      throw classifyModelError(error, request.signal);
    }
  }
}

export class DeepSeekModel extends RemoteModel {
  constructor(key: string | undefined, baseURL = "https://api.deepseek.com") {
    super("deepseek", key, baseURL);
  }
}
export class GrokModel extends RemoteModel {
  constructor(key: string | undefined, baseURL = "https://api.x.ai/v1") {
    super("grok", key, baseURL);
  }
}

/** Route by the model captured for a request, never by a mutable UI selection. */
export class ProviderModel implements ModelPort {
  private readonly credentials: ModelCredentials;
  constructor(
    private readonly config: AppConfig,
    private readonly currentModel: () => string,
  ) {
    this.credentials = new ModelCredentials(config);
  }
  get name() {
    return providerForModel(this.currentModel());
  }
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const provider = providerForModel(request.model);
    const key = this.credentials.key(provider);
    const model =
      provider === "grok"
        ? new GrokModel(key, this.config.grokBaseURL)
        : new DeepSeekModel(key, this.config.baseURL);
    const release = this.config.memoryFastPath
      ? await accountModelPool(
          createHash("sha256")
            .update(
              JSON.stringify([
                provider,
                provider === "grok"
                  ? this.config.grokBaseURL
                  : this.config.baseURL,
                key,
              ]),
            )
            .digest("hex"),
        ).acquire(request.background === true, request.signal)
      : undefined;
    try {
      yield* model.stream(request);
    } finally {
      release?.();
    }
  }
}
export function classifyModelError(
  error: unknown,
  signal?: AbortSignal,
): DomainError {
  if (error instanceof DomainError) return error;
  if (signal?.aborted) return new DomainError("cancelled", 409);
  const status =
    error && typeof error === "object" && "statusCode" in error
      ? Number(error.statusCode)
      : 0;
  if (status === 401 || status === 403)
    return new DomainError("provider_authentication_failed", 502);
  if (status === 402)
    return new DomainError("provider_balance_insufficient", 502);
  if (status === 429 || status >= 500) {
    const headers =
      error && typeof error === "object" && "responseHeaders" in error
        ? (error.responseHeaders as Record<string, string> | undefined)
        : undefined;
    const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
    const seconds = value === undefined ? NaN : Number(value);
    const waitMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : value
        ? Math.max(0, Date.parse(value) - Date.now())
        : NaN;
    return new DomainError(
      status === 429 ? "provider_rate_limited" : "provider_unavailable",
      503,
      undefined,
      Number.isFinite(waitMs) ? waitMs : undefined,
    );
  }

  return new DomainError("provider_request_failed", 502);
}

export class MockModel implements ModelPort {
  readonly name = "mock";
  constructor(readonly delayMs = 0) {}
  async *stream(r: ModelRequest): AsyncGenerator<ModelEvent> {
    const latest =
      r.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    let answer =
      r.purpose === "extract"
        ? JSON.stringify({ assertions: [], openLoops: [] })
        : r.purpose === "summary"
          ? JSON.stringify({ summary: "今天一起交流了工作与日常。" })
          : r.purpose === "judge"
            ? JSON.stringify({
                decision: "send",
                reason: "confirmed_follow_up",
              })
            : r.purpose === "concern"
              ? "之前提到的事情，现在进展怎么样？不急着回答。"
              : `[本地测试模型] 我听到了：${latest.slice(0, 160)}`;
    for (const text of answer.match(/.{1,12}/gs) ?? []) {
      if (r.signal.aborted) throw new DomainError("cancelled", 409);
      if (this.delayMs)
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      yield { type: "text", text };
    }
    yield {
      type: "finish",
      reason: "stop",
      usage: {
        inputTokens: 30,
        outputTokens: answer.length,
        totalTokens: 30 + answer.length,
        calls: 1,
        estimated: true,
      },
    };
  }
}

export async function collect(
  model: ModelPort,
  request: ModelRequest,
): Promise<{
  text: string;
  usage: Usage;
  providerModel?: string;
  requestId?: string;
}> {
  let text = "";
  let usage: Usage = { calls: 1, estimated: true };
  let finished = false;
  let providerModel: string | undefined, requestId: string | undefined;
  for await (const e of modelEvents(model, request)) {
    if (e.type === "text") text += e.text;
    if (e.type === "finish") {
      usage = e.usage;
      providerModel = e.providerModel;
      requestId = e.requestId;
      finished = true;
      if (e.reason === "length") throw new DomainError("output_truncated", 502);
      if (e.reason !== "stop") throw new DomainError("model_incomplete", 502);
    }
  }
  if (!finished || !text.trim())
    throw new DomainError("empty_model_output", 502);
  return { text, usage, providerModel, requestId };
}
export async function* modelEvents(
  model: ModelPort,
  request: ModelRequest,
): AsyncGenerator<ModelEvent> {
  const iterator = model.stream(request)[Symbol.asyncIterator]();
  try {
    while (true) {
      if (request.signal.aborted) throw new DomainError("cancelled", 409);
      let cleanup = () => {};
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new DomainError("cancelled", 409));
        request.signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => request.signal.removeEventListener("abort", onAbort);
      });
      let next: IteratorResult<ModelEvent>;
      try {
        next = await Promise.race([iterator.next(), aborted]);
      } finally {
        cleanup();
      }
      if (next.done) break;
      yield next.value;
    }
  } finally {
    void iterator.return?.().catch(() => {});
  }
}
export function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new DomainError("invalid_model_json", 502);
  }
}
