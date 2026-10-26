import { createServer } from "node:http";
import { it, expect } from "vitest";
import { DeepSeekModel, collect } from "../src/model.js";
it("真实SDK将json标志透传为response_format，并关闭思考，不自动执行工具", async () => {
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let buffer = "";
    req.on("data", (chunk) => (buffer += String(chunk)));
    req.on("end", () => {
      body = JSON.parse(buffer);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (content: unknown, reason: string | null) =>
        JSON.stringify({
          id: "synthetic-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-flash",
          choices: [{ index: 0, delta: content, finish_reason: reason }],
        });
      res.end(
        `data: ${chunk({ role: "assistant", content: '{"ok":true}' }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const port = new DeepSeekModel(
      "synthetic-provider-key",
      `http://127.0.0.1:${address.port}`,
    );
    const result = await collect(port, {
      purpose: "summary",
      model: "deepseek-flash",
      system: "Only return JSON.",
      messages: [{ role: "user", content: "Synthetic JSON protocol test." }],
      json: true,
      maxOutputTokens: 100,
      signal: AbortSignal.timeout(5000),
    });
    expect(JSON.parse(result.text)).toEqual({ ok: true });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.thinking).toEqual({ type: "disabled" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("评审可按单次请求开启低强度推理，隐藏推理不混入正文，后续聊天仍关闭", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let buffer = "";
    req.on("data", (part) => (buffer += String(part)));
    req.on("end", () => {
      bodies.push(JSON.parse(buffer));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) =>
        JSON.stringify({
          id: "synthetic-reasoning",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-flash",
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
      res.end(
        `data: ${chunk({ role: "assistant", reasoning_content: "private synthetic reasoning" }, null)}\n\ndata: ${chunk({ content: '{"ok":true}' }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = new DeepSeekModel(
      "synthetic-key",
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    const base = {
      model: "deepseek-flash",
      system: "Only return JSON.",
      messages: [{ role: "user" as const, content: "Synthetic request." }],
      json: true,
      maxOutputTokens: 100,
      signal: AbortSignal.timeout(5000),
    };
    const result = await collect(port, {
      ...base,
      purpose: "judge",
      reasoningEffort: "low",
    });
    expect(result.text).toBe('{"ok":true}');
    expect(bodies[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
      response_format: { type: "json_object" },
    });
    await collect(port, { ...base, purpose: "chat" });
    expect(bodies[1]).toMatchObject({ thinking: { type: "disabled" } });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    await collect(port, { ...base, purpose: "judge", temperature: 0 });
    expect(bodies[2]).toMatchObject({
      thinking: { type: "disabled" },
      temperature: 0,
    });
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
