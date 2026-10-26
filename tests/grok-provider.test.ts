import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  GrokModel,
  ProviderModel,
  collect,
  modelEvents,
  type ModelRequest,
} from "../src/model.js";
import { setup } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function endpoint(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
  ) => void,
) {
  const server = createServer((req, res) => {
    let buffer = "";
    req.on("data", (chunk) => (buffer += String(chunk)));
    req.on("end", () => handler(req, res, JSON.parse(buffer)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function grokResponse(res: ServerResponse, text = '{"ok":true}', tool = false) {
  const response = {
    id: "grok-test-response",
    object: "response",
    created_at: 1,
    model: "grok-4.3",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 5 },
    },
  };
  const events: unknown[] = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress" },
    },
  ];
  if (tool) {
    const item = {
      type: "function_call",
      id: "tool-item",
      call_id: "tool-call",
      name: "search_memory",
      arguments: '{"query":"测试"}',
    };
    events.push(
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
    );
  } else {
    events.push(
      {
        type: "response.output_text.delta",
        item_id: "text-item",
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_text.done",
        item_id: "text-item",
        output_index: 0,
        content_index: 0,
        text,
      },
    );
  }
  events.push({ type: "response.completed", response });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose: "chat",
    model: "grok-4.3",
    system: "Only return JSON.",
    messages: [{ role: "user", content: "Synthetic provider contract test." }],
    signal: AbortSignal.timeout(5000),
    maxOutputTokens: 300,
    ...overrides,
  };
}

it("Grok 4.3 使用真实 SDK、独立 Key、JSON、关闭推理和禁用响应存储，并返回用量与身份", async () => {
  let received: Record<string, unknown> = {};
  const baseURL = await endpoint((req, res, body) => {
    expect(req.url).toBe("/responses");
    expect(req.headers.authorization).toBe("Bearer grok-synthetic-key");
    received = body;
    grokResponse(res);
  });
  const result = await collect(
    new GrokModel("grok-synthetic-key", baseURL),
    request({ json: true }),
  );
  expect(JSON.parse(result.text)).toEqual({ ok: true });
  expect(received).toMatchObject({
    model: "grok-4.3",
    stream: true,
    store: false,
    max_output_tokens: 300,
    reasoning: { effort: "none" },
    text: { format: { type: "json_object" } },
  });
  expect(received).not.toHaveProperty("thinking");
  expect(result).toMatchObject({
    providerModel: "grok-4.3",
    requestId: "grok-test-response",
    usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 5 },
  });
});

it("Grok 4.3 在响应结束前透传文字增量，显式关闭 reasoning", async () => {
  let complete!: () => void;
  let received: Record<string, unknown> = {};
  const baseURL = await endpoint((_req, res, body) => {
    received = body;
    const response = {
      id: "stream-test",
      object: "response",
      model: "grok-4.3",
      status: "completed",
      output: [],
    };
    const send = (event: unknown) =>
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    send({
      type: "response.created",
      response: { ...response, status: "in_progress" },
    });
    send({
      type: "response.output_text.delta",
      item_id: "text",
      output_index: 0,
      content_index: 0,
      delta: "第一段",
    });
    complete = () => {
      send({
        type: "response.output_text.delta",
        item_id: "text",
        output_index: 0,
        content_index: 0,
        delta: "第二段",
      });
      send({
        type: "response.output_text.done",
        item_id: "text",
        output_index: 0,
        content_index: 0,
        text: "第一段第二段",
      });
      send({ type: "response.completed", response });
      res.end();
    };
  });
  const iterator = modelEvents(
    new GrokModel("stream-test-key", baseURL),
    request(),
  );
  try {
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "text", text: "第一段" },
    });
    expect(received).toMatchObject({
      model: "grok-4.3",
      stream: true,
      reasoning: { effort: "none" },
    });
    complete();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "text", text: "第二段" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "finish", reason: "stop" },
    });
  } finally {
    await iterator.return(undefined);
  }
});

it("Grok 工具调用交由 Harness 执行，工具历史可在下一步回传", async () => {
  const bodies: Record<string, unknown>[] = [];
  const baseURL = await endpoint((_req, res, body) => {
    bodies.push(body);
    grokResponse(res, "完成", bodies.length === 1);
  });
  const model = new GrokModel("grok-tool-key", baseURL);
  const events = [];
  for await (const event of modelEvents(
    model,
    request({
      tools: [
        {
          name: "search_memory",
          description: "查找记忆",
          schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    }),
  ))
    events.push(event);
  expect(bodies).toHaveLength(1);
  expect(events).toContainEqual({
    type: "tool",
    call: { id: "tool-call", name: "search_memory", input: { query: "测试" } },
  });
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" });
  await collect(
    model,
    request({
      messages: [
        { role: "user", content: "查找测试" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-call",
              name: "search_memory",
              input: { query: "测试" },
            },
          ],
        },
        {
          role: "tool",
          content: '{"matches":[]}',
          callId: "tool-call",
          toolName: "search_memory",
        },
      ],
    }),
  );
  expect(bodies[1]?.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "function_call_output",
        call_id: "tool-call",
        output: '{"matches":[]}',
      }),
    ]),
  );
});

it.each([
  [401, "provider_authentication_failed"],
  [429, "provider_rate_limited"],
  [503, "provider_unavailable"],
])("Grok HTTP %i 被分类且不泄露 Key 或响应体", async (status, code) => {
  const baseURL = await endpoint((_req, res) => {
    res.writeHead(status as number, {
      "content-type": "application/json",
      "retry-after": "3",
    });
    res.end('{"error":{"message":"private-upstream-detail"}}');
  });
  await expect(
    collect(new GrokModel("never-echo-this-key", baseURL), request()),
  ).rejects.toMatchObject({
    code,
    ...(status === 429 || status === 503 ? { retryAfterMs: 3000 } : {}),
  });
});

it("Grok 无 Key 不发送网络请求；取消会中断等待", async () => {
  await expect(
    collect(new GrokModel(undefined), request()),
  ).rejects.toMatchObject({ code: "model_key_missing" });
  const baseURL = await endpoint(() => {});
  await expect(
    collect(
      new GrokModel("grok-cancel-key", baseURL),
      request({ signal: AbortSignal.timeout(50) }),
    ),
  ).rejects.toMatchObject({ code: "cancelled" });
});

it("运行中的请求按捕获的模型路由，切换设置后仍使用原服务商与 Key", async () => {
  const requests: {
    path: string | undefined;
    key: string | undefined;
    model: unknown;
  }[] = [];
  const baseURL = await endpoint((req, res, body) => {
    requests.push({
      path: req.url,
      key: req.headers.authorization,
      model: body.model,
    });
    if (req.url === "/responses") return grokResponse(res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = {
      id: "ds-response",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: { content: "DS" }, finish_reason: "stop" }],
    };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  const x = setup({
    config: {
      baseURL,
      grokBaseURL: baseURL,
      apiKey: "ds-env-key",
      grokApiKey: "grok-env-key",
    },
  });
  cleanups.push(x.dispose);
  x.h.updateModelKey("grok", "grok-byok-key");
  let selectedModel = "deepseek-flash";
  const model = new ProviderModel(x.config, () => selectedModel);
  selectedModel = "grok-4.3";
  await collect(model, request({ model: "deepseek-flash" }));
  await collect(model, request());
  expect(requests).toEqual([
    {
      path: "/chat/completions",
      key: "Bearer ds-env-key",
      model: "deepseek-flash",
    },
    { path: "/responses", key: "Bearer grok-byok-key", model: "grok-4.3" },
  ]);
});
