import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BotManager } from "../src/bots.js";
import { ModelCredentials } from "../src/model-config.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setup } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("Grok 默认使用 4.3，旧 4.5 角色重启后迁移到 4.3 且保留 Key", async () => {
  const x = setup();
  cleanups.push(x.dispose);
  const s = x.store.settings();
  x.store.saveSettings({ ...s, model: "grok-4.5", revision: s.revision + 1 });
  x.h.updateModelKey("grok", "migration-grok-key");
  await x.h.close();
  expect(loadConfig({ dataDir: x.dir, modelMode: "grok" }).model).toBe(
    "grok-4.3",
  );
  const bots = new BotManager(x.config);
  cleanups.push(() => bots.close());
  expect(bots.get().store.settings()).toMatchObject({
    model: "grok-4.3",
    revision: s.revision + 2,
  });
  expect(bots.get().credentials.key("grok")).toBe("migration-grok-key");
});
async function server() {
  const x = setup({
    config: {
      apiKey: "ds-environment-key",
      grokApiKey: "grok-environment-key",
    },
  });
  cleanups.push(x.dispose);
  const app = await createApp(x.h);
  cleanups.push(() => app.close());
  const bootstrap = await app.inject({ url: "/bootstrap" });
  const headers = {
    cookie: `harness_session=${bootstrap.cookies[0]!.value}`,
    "x-local-token": bootstrap.json().csrfToken,
  };
  return { ...x, app, headers };
}

it("BYOK 保存、替换、移除只影响所选 provider，重开仍保留且文件权限为 0600", async () => {
  const x = await server();
  for (const provider of ["deepseek", "grok"] as const) {
    const r = await x.app.inject({
      method: "PUT",
      url: `/v1/model-credentials/${provider}`,
      headers: x.headers,
      payload: { apiKey: `  ${provider}-byok-secret  ` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      configured: true,
      source: "byok",
      hasByok: true,
    });
    expect(r.body).not.toContain("secret");
  }
  const reopened = new ModelCredentials(x.config);
  expect(statSync(reopened.path).mode & 0o777).toBe(0o600);
  expect(reopened.key("deepseek")).toBe("deepseek-byok-secret");
  expect(reopened.key("grok")).toBe("grok-byok-secret");
  reopened.save("grok", "replacement-grok-key");
  expect(reopened.key("grok")).toBe("replacement-grok-key");
  const removed = await x.app.inject({
    method: "DELETE",
    url: "/v1/model-credentials/grok",
    headers: x.headers,
  });
  expect(removed.json()).toEqual({
    configured: true,
    source: "environment",
    hasByok: false,
  });
  expect(reopened.key("grok")).toBe("grok-environment-key");
  expect(reopened.key("deepseek")).toBe("deepseek-byok-secret");
  expect(readFileSync(reopened.path, "utf8")).not.toContain(
    "replacement-grok-key",
  );
});

it("凭据 API 保留本地会话、CSRF 和来源校验，非法 Key 不覆盖已有值", async () => {
  const x = await server();
  const url = "/v1/model-credentials/grok";
  x.h.updateModelKey("grok", "existing-secret");
  expect(
    (await x.app.inject({ method: "PUT", url, payload: { apiKey: "new-key" } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await x.app.inject({
        method: "DELETE",
        url,
        headers: { cookie: x.headers.cookie },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await x.app.inject({
        method: "PUT",
        url,
        headers: { ...x.headers, origin: "https://foreign.example" },
        payload: { apiKey: "new-key" },
      })
    ).statusCode,
  ).toBe(403);
  for (const apiKey of [
    "",
    "   ",
    "abc\ndef",
    "abc def",
    "密钥",
    "x".repeat(4097),
  ]) {
    expect(
      (
        await x.app.inject({
          method: "PUT",
          url,
          headers: x.headers,
          payload: { apiKey },
        })
      ).statusCode,
    ).toBe(400);
  }
  expect(
    (
      await x.app.inject({
        method: "PUT",
        url: "/v1/model-credentials/unknown",
        headers: x.headers,
        payload: { apiKey: "new-key" },
      })
    ).statusCode,
  ).toBe(400);
  expect(x.h.credentials.key("grok")).toBe("existing-secret");
});

it("Grok 设置遵守 revision 校验，凭据不进入快照、健康、Trace、数据库、导出或备份", async () => {
  const x = await server();
  const key = "byok-must-never-enter-database";
  x.h.updateModelKey("grok", key);
  const changed = await x.app.inject({
    method: "PATCH",
    url: "/v1/relationships/local-relationship/settings",
    headers: x.headers,
    payload: {
      expectedRevision: x.store.settings().revision,
      model: "grok-4.3",
    },
  });
  expect(changed.statusCode).toBe(200);
  expect(x.h.modelStatus()).toMatchObject({
    provider: "grok",
    model: "grok-4.3",
    providers: { grok: { configured: true, source: "byok" } },
  });
  expect(
    (
      await x.app.inject({
        method: "PATCH",
        url: "/v1/relationships/local-relationship/settings",
        headers: x.headers,
        payload: { expectedRevision: 1, model: "deepseek-flash" },
      })
    ).statusCode,
  ).toBe(409);
  for (const url of [
    "/v1/health",
    "/v1/relationships/local-relationship/snapshot",
    "/v1/trace",
  ]) {
    const response = await x.app.inject({ url, headers: x.headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(key);
  }
  const receipt = (
    await x.app.inject({
      method: "POST",
      url: "/v1/exports",
      headers: x.headers,
      payload: {},
    })
  ).json();
  const exported = await x.app.inject({
    url: `/v1/exports/${receipt.id}`,
    headers: x.headers,
  });
  expect(exported.statusCode).toBe(200);
  expect(exported.body).not.toContain(key);
  const backup = join(x.dir, "synthetic-backup.sqlite");
  await x.store.backup(backup);
  for (const path of [
    backup,
    join(x.dir, "companion.sqlite"),
    join(x.dir, "companion.sqlite-wal"),
  ])
    expect(readFileSync(path).includes(Buffer.from(key))).toBe(false);
});

it("角色的模型与 Key 独立，重启保持选择，旧 DS 配置仍可用且缺 Grok Key 不借用 DS Key", async () => {
  const x = setup();
  await x.h.close();
  cleanups.push(x.dispose);
  const config = {
    ...x.config,
    modelMode: "deepseek" as const,
    apiKey: "legacy-ds-key",
    grokApiKey: undefined,
  };
  const bots = new BotManager(config);
  const original = bots.get(),
    other = bots.get("xiaotang");
  expect(original.modelStatus()).toMatchObject({
    provider: "deepseek",
    configured: true,
  });
  original.updateSettings({
    expectedRevision: original.store.settings().revision,
    model: "grok-4.3",
  });
  expect(original.modelStatus()).toMatchObject({
    provider: "grok",
    configured: false,
  });
  original.updateModelKey("grok", "original-grok-key");
  other.updateModelKey("grok", "other-grok-key");
  expect(other.modelStatus()).toMatchObject({
    provider: "deepseek",
    model: "deepseek-flash",
  });
  await bots.close();
  const reopened = new BotManager(config);
  cleanups.push(() => reopened.close());
  expect(reopened.get().modelStatus()).toMatchObject({
    provider: "grok",
    configured: true,
    model: "grok-4.3",
  });
  expect(reopened.get().credentials.key("grok")).toBe("original-grok-key");
  expect(reopened.get("xiaotang").credentials.key("grok")).toBe(
    "other-grok-key",
  );
});
