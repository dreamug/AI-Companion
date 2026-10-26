import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { setup } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
async function make() {
  const x = setup({ config: { apiKey: "synthetic-key-never-export" } });
  const app = await createApp(x.h);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    await x.dispose();
  });
  const b = await app.inject({ url: "/bootstrap" });
  const boot = b.json();
  const headers = {
    cookie: `harness_session=${b.cookies[0]!.value}`,
    "x-local-token": boot.csrfToken,
  };
  return { ...x, app, headers, boot };
}

describe("本地API、作用域与凭据边界", () => {
  it("静态页面可打开，只有白名单资源可访问", async () => {
    const x = await make();
    const page = await x.app.inject({ url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("陪伴测试台");
    expect(page.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    for (const url of [
      "/env.local",
      "/.env.local",
      "/data/companion.sqlite",
      "/../env.local",
      "/%2e%2e/env.local",
      "/app.js/../../env.local",
    ]) {
      const r = await x.app.inject({ url, headers: x.headers });
      expect(r.statusCode).not.toBe(200);
      expect(r.body).not.toContain("synthetic-key-never-export");
    }
  });
  it("未授权读取拒绝，缺CSRF或跨站Origin写入拒绝", async () => {
    const x = await make();
    expect((await x.app.inject({ url: "/v1/health" })).statusCode).toBe(401);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/exports",
          headers: { cookie: x.headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/exports",
          headers: { ...x.headers, origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it("Host与Sec-Fetch-Site阻止DNS重绑定／跨站bootstrap", async () => {
    const x = await make();
    expect(
      (
        await x.app.inject({
          url: "/bootstrap",
          headers: { host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await x.app.inject({
          url: "/bootstrap",
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("Unicode伪造token返回403而非timingSafeEqual异常", async () => {
    const x = await make();
    const r = await x.app.inject({
      method: "POST",
      url: "/v1/exports",
      headers: { ...x.headers, "x-local-token": "界".repeat(64) },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });
  it("cookie为HttpOnly和SameSite Strict；不把CSRF放URL", async () => {
    const x = await make();
    const r = await x.app.inject({ url: "/bootstrap" });
    expect(r.headers["set-cookie"]).toContain("HttpOnly");
    expect(r.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(x.boot.csrfToken.length).toBe(64);
  });
  it("输入／快照／Trace来自同一实际Harness", async () => {
    const x = await make();
    const r = await x.app.inject({
      method: "POST",
      url: "/v1/threads/local-thread/inputs",
      headers: x.headers,
      payload: { text: "HTTP合成对话", idempotencyKey: "http-1" },
    });
    expect(r.statusCode).toBe(200);
    await x.h.waitForIdle();
    const snapshot = (
      await x.app.inject({
        url: "/v1/relationships/local-relationship/snapshot",
        headers: x.headers,
      })
    ).json();
    expect(
      snapshot.messages.some((m: { content: string }) =>
        m.content.includes("HTTP合成对话"),
      ),
    ).toBe(true);
    const trace = (
      await x.app.inject({
        url: `/v1/runs/${r.json().runId}/trace`,
        headers: x.headers,
      })
    ).json();
    expect(
      trace.trace.some((t: { stage: string }) => t.stage === "context"),
    ).toBe(true);
    expect(JSON.stringify(trace)).not.toContain("synthetic-key-never-export");
  });
  it("其他关系或线程不能越权访问", async () => {
    const x = await make();
    expect(
      (
        await x.app.inject({
          url: "/v1/relationships/other/snapshot",
          headers: x.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/threads/other/inputs",
          headers: x.headers,
          payload: { text: "x", idempotencyKey: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("健康、快照、导出均不含模型凭据", async () => {
    const x = await make();
    for (const url of [
      "/v1/health",
      "/v1/relationships/local-relationship/snapshot",
    ]) {
      const r = await x.app.inject({ url, headers: x.headers });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain("synthetic-key-never-export");
    }
    const receipt = (
      await x.app.inject({
        method: "POST",
        url: "/v1/exports",
        headers: x.headers,
        payload: {},
      })
    ).json();
    const data = await x.app.inject({
      url: `/v1/exports/${receipt.id}`,
      headers: x.headers,
    });
    expect(data.body).not.toContain("synthetic-key-never-export");
  });
  it("普通运行不注册故障注入路由，维护入口拒绝任意SQL", async () => {
    const x = await make();
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/test/v1/scenarios",
          headers: x.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/local/v1/maintenance",
          headers: x.headers,
          payload: { action: "sql", sql: "DROP TABLE messages" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("非法JSON与过大消息不会部分写入", async () => {
    const x = await make();
    const a = await x.app.inject({
      method: "POST",
      url: "/v1/threads/local-thread/inputs",
      headers: x.headers,
      payload: { text: "", idempotencyKey: "bad" },
    });
    expect(a.statusCode).toBe(400);
    const b = await x.app.inject({
      method: "POST",
      url: "/v1/threads/local-thread/inputs",
      headers: x.headers,
      payload: { text: "x".repeat(100000), idempotencyKey: "large" },
    });
    expect(b.statusCode).toBe(413);
    expect(x.store.list("runs")).toHaveLength(0);
  });
  it("网页维护操作也要走来源、版本与遗忘校验", async () => {
    const x = await make();
    const m = (
      await x.app.inject({
        method: "POST",
        url: "/v1/memory",
        headers: x.headers,
        payload: { text: "手工确认的合成事实", pinned: true },
      })
    ).json();
    const corrected = await x.app.inject({
      method: "POST",
      url: "/v1/memory/corrections",
      headers: x.headers,
      payload: {
        id: m.id,
        expectedRevision: 999,
        changes: { text: "错误覆盖" },
      },
    });
    expect(corrected.statusCode).toBe(409);
    const f = await x.app.inject({
      method: "POST",
      url: "/v1/memory/forget",
      headers: x.headers,
      payload: { memoryIds: [m.id] },
    });
    expect(f.statusCode).toBe(200);
    expect(x.store.require("memories", m.id).status).toBe("deleted");
  });
  it("公开SSE按cursor续传；已有消息不重新生成", async () => {
    const x = await make();
    await x.app.listen({ host: "127.0.0.1", port: 0 });
    const address = x.app.server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`,
      cursor = x.store.cursor(),
      controller = new AbortController();
    const r = await fetch(
      `${base}/v1/relationships/local-relationship/events?cursor=${cursor}`,
      { headers: { cookie: x.headers.cookie }, signal: controller.signal },
    );
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const accepted = x.h.submit("流协议测试", "sse");
    await x.h.waitForIdle();
    let chunks = "";
    for (let i = 0; i < 8 && !chunks.includes("message.completed"); i++) {
      const next = await reader.read();
      if (next.done) break;
      chunks += new TextDecoder().decode(next.value);
    }
    controller.abort();
    expect(chunks).toContain("run.accepted");
    expect(chunks).toContain("message.completed");
    expect(chunks).not.toContain("synthetic-key-never-export");
    expect(x.store.list("runs")).toHaveLength(1);
    expect(x.store.require("runs", accepted.runId).status).toBe("completed");
  });
  it("遗忘后的旧SSE cursor在发头前返回resync_required", async () => {
    const x = await make();
    const m = x.h.addMemory({ text: "游标测试" }),
      cursor = x.store.cursor();
    x.h.forget([], [m.id]);
    const r = await x.app.inject({
      url: `/v1/relationships/local-relationship/events?cursor=${cursor}`,
      headers: x.headers,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("resync_required");
  });
});

it("SSE自动重连优先使用Last-Event-ID，不被初始URL cursor覆盖", async () => {
  const x = await make();
  const initial = x.store.cursor();
  x.store.event("review.old", { synthetic: true }, x.clock.now());
  const cursor = x.store.cursor();
  x.store.event("review.new", { synthetic: true }, x.clock.now());
  const address = await x.app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  try {
    const response = await fetch(
      `${address}/v1/relationships/local-relationship/events?cursor=${encodeURIComponent(initial)}`,
      {
        headers: { cookie: x.headers.cookie, "last-event-id": cursor },
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("review.new")) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    expect(text).toContain("review.new");
    expect(text).not.toContain("review.old");
  } finally {
    controller.abort();
  }
});
