import { test as base, expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager } from "../../src/bots.js";
import { createApp } from "../../src/server.js";
import { ScriptedModel, response } from "../helpers.js";
import type { ModelRequest } from "../../src/model.js";

const text = "第一条已经发出。\n\n第二条等待发送。\n\n第三条最后发送。";
const test = base.extend<{
  runtime: { bots: BotManager; base: string; requests: ModelRequest[] };
}>({
  runtime: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "companion-replies-browser-"));
    const requests: ModelRequest[] = [];
    const bots = new BotManager(
      {
        dataDir: dir,
        host: "127.0.0.1",
        port: 0,
        baseURL: "https://api.deepseek.com",
        model: "deepseek-flash",
        modelMode: "mock",
        maxRunMs: 1000,
        maxOutputTokens: 300,
        schedulerMs: 50,
      },
      () =>
        new ScriptedModel(async function* (request) {
          requests.push(request);
          const latest = request.messages
            .filter((m) => m.role === "user")
            .at(-1)?.content;
          yield* response(latest?.includes("插话") ? "收到你的插话" : text);
        }),
    );
    for (const bot of bots.all())
      bot.updateSettings({
        expectedRevision: bot.store.settings().revision,
        remoteDisclosureAcknowledged: true,
        autoExtract: false,
      });
    const app = await createApp(bots.get(), { bots });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      await use({ bots, base: address, requests });
    } finally {
      const closing = app.close();
      // This isolated fixture owns every connection. Release browser keepalive
      // sockets as well as SSE before removing its temporary database.
      app.server.closeAllConnections();
      await closing;
      await bots.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

test.beforeEach(async ({ page, runtime }) => {
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ json: { configured: false, voiceName: "测试音色" } }),
  );
  await page.route("**/v1/speech", (route) =>
    route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } }),
  );
  await page.goto(runtime.base);
  await expect(page.locator("#connection")).toContainText("本地已连接");
});
test.afterEach(async ({ page }) => {
  await page.goto("about:blank");
});

async function toggle(page: Page, id: string, value = true) {
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/settings") && r.request().method() === "PATCH",
    ),
    page.locator(id).setChecked(value),
  ]);
}
async function enable(page: Page, paced = true) {
  await toggle(page, "#split-replies");
  if (paced) await toggle(page, "#message-pacing");
}
async function send(page: Page, content = "开始聊天") {
  await page.locator("#chat-input").fill(content);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

test("开关默认关闭，普通流式回复仍是一个气泡，分条无间隔可独立开启", async ({
  page,
  runtime,
}) => {
  await expect(page.locator("#split-replies")).not.toBeChecked();
  await expect(page.locator("#message-pacing")).not.toBeChecked();
  await expect(page.locator("#message-pacing")).toBeDisabled();
  await send(page);
  await expect(page.locator("#run-status")).toContainText("已完成");
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await expect(page.locator(".message.assistant .message-text")).toHaveText(
    text,
  );
  expect(runtime.requests[0]?.system).not.toContain("本轮已开启分条回复");
  await enable(page, false);
  await send(page, "第二轮");
  await expect(page.locator(".message.assistant")).toHaveCount(4);
  await expect(page.locator("#cancel-run")).toBeDisabled();
});

test("每个bot独立保存，切换与刷新保留选项，其他角色仍默认关闭", async ({
  page,
  runtime,
}) => {
  await enable(page);
  await page.reload();
  await expect(page.locator("#split-replies")).toBeChecked();
  await expect(page.locator("#message-pacing")).toBeChecked();
  await page.locator("#bot-select").selectOption("xiaotang");
  await expect(page).toHaveURL(/bot=xiaotang/);
  await expect(page.locator("#split-replies")).not.toBeChecked();
  await expect(page.locator("#message-pacing")).not.toBeChecked();
  await expect(page.locator("#message-pacing")).toBeDisabled();
  await enable(page, false);
  expect(runtime.bots.get("xiaoye").store.settings()).toMatchObject({
    splitReplies: true,
    messagePacing: true,
  });
  expect(runtime.bots.get("xiaotang").store.settings()).toMatchObject({
    splitReplies: true,
    messagePacing: false,
  });
  await page.locator("#bot-select").selectOption("xiaoye");
  await expect(page.locator("#message-pacing")).toBeChecked();
});

test("第一条发出后刷新，后续消息继续按顺序发送且所有气泡身份不重复", async ({
  page,
  runtime,
}) => {
  await enable(page);
  await send(page);
  const bubbles = page.locator(".message.assistant");
  await expect(bubbles).toHaveCount(1);
  await expect(bubbles.first()).toContainText("第一条已经发出");
  await expect(page.locator("#run-status")).toContainText("正在输入");
  const firstId = await bubbles.first().getAttribute("data-message-id");
  await page.reload();
  await expect(bubbles.first()).toHaveAttribute("data-message-id", firstId!);
  await expect(bubbles).toHaveCount(3);
  await expect(page.locator(".message.assistant .message-text")).toHaveText(
    text.split("\n\n"),
  );
  await expect(page.locator("#cancel-run")).toBeDisabled();
  const ids = await bubbles.evaluateAll((elements) =>
    elements.map((e) => e.getAttribute("data-message-id")),
  );
  await page.reload();
  await expect(bubbles).toHaveCount(3);
  expect(
    await bubbles.evaluateAll((elements) =>
      elements.map((e) => e.getAttribute("data-message-id")),
    ),
  ).toEqual(ids);
  expect(new Set(ids).size).toBe(3);
  expect(runtime.requests).toHaveLength(1);
  await page.screenshot({
    path: "data/reports/reply-presentation.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("分条间隙插话立即结束旧消息组，不会继续显示旧尾段", async ({
  page,
  runtime,
}) => {
  await enable(page);
  await send(page);
  await expect(page.locator(".message.assistant").first()).toContainText(
    "第一条已经发出",
  );
  await send(page, "插话：先停下旧话题");
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(page.locator(".message.assistant").last()).toContainText(
    "收到你的插话",
  );
  await page.waitForTimeout(1500);
  await expect(page.locator("#messages")).not.toContainText("第二条等待发送");
  await expect(page.locator("#messages")).not.toContainText("第三条最后发送");
  expect(runtime.requests).toHaveLength(2);
  await page.reload();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
});

test("停止取消尚未发送内容，刷新也不会补发", async ({ page, runtime }) => {
  await enable(page);
  await send(page);
  await expect(page.locator(".message.assistant").first()).toContainText(
    "第一条已经发出",
  );
  await page.locator("#cancel-run").click();
  await expect(page.locator("#run-status")).toContainText("已取消");
  await page.reload();
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await page.waitForTimeout(1500);
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await expect(page.locator("#messages")).not.toContainText("第二条等待发送");
  expect(runtime.requests).toHaveLength(1);
});

test("分条语音串行播放，停止清空余下朗读，刷新不重播", async ({ page }) => {
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  const spoken: string[] = [];
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ json: { configured: true, voiceName: "测试音色" } }),
  );
  await page.route("**/v1/speech", (route) => {
    spoken.push(route.request().postDataJSON().id);
    return route.fulfill({ contentType: "audio/mpeg", body: audio });
  });
  await page.reload();
  await enable(page, false);
  await send(page);
  await expect(page.locator(".message.assistant")).toHaveCount(3);
  await expect(page.locator("#voice-status")).toContainText("正在朗读");
  expect(spoken).toHaveLength(1);
  const ids = await page
    .locator(".message.assistant")
    .evaluateAll((elements) =>
      elements.map((e) => e.getAttribute("data-message-id")),
    );
  expect(spoken[0]).toBe(ids[0]);
  await page.locator("#voice-player").evaluate((player: HTMLAudioElement) => {
    player.pause();
    player.dispatchEvent(new Event("ended"));
  });
  await expect.poll(() => spoken.length).toBe(2);
  expect(spoken[1]).toBe(ids[1]);
  await page.locator("#voice-stop").click();
  await page.waitForTimeout(250);
  expect(spoken).toHaveLength(2);
  await page.reload();
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await page.waitForTimeout(250);
  expect(spoken).toHaveLength(2);
});

test("停止朗读后本组后续气泡保持静音，历史分条消息仍可手动重听", async ({
  page,
  runtime,
}) => {
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  const spoken: string[] = [];
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ json: { configured: true, voiceName: "测试音色" } }),
  );
  await page.route("**/v1/speech", (route) => {
    spoken.push(route.request().postDataJSON().id);
    return route.fulfill({ contentType: "audio/mpeg", body: audio });
  });
  await page.reload();
  await enable(page);
  await send(page);
  await expect(page.locator("#voice-status")).toContainText("正在朗读");
  await page.locator("#voice-stop").click();
  await expect(page.locator(".message.assistant")).toHaveCount(3);
  await expect(page.locator("#run-status")).toContainText("已完成");
  expect(spoken).toHaveLength(1);
  await send(page, "插话：下一轮");
  await expect.poll(() => spoken.length).toBe(2);
  await page.locator("#voice-stop").click();
  await page
    .locator(".message.assistant")
    .first()
    .getByRole("button", { name: "朗读", exact: true })
    .click();
  await expect.poll(() => spoken.length).toBe(3);
  await expect(page.locator("#voice-status")).toContainText("正在朗读");
  const h = runtime.bots.get();
  h.updateSettings({
    expectedRevision: h.store.settings().revision,
    splitReplies: true,
  });
  await expect(page.locator("#settings-revision")).toContainText(
    `v${h.store.settings().revision}`,
  );
  await expect(page.locator("#voice-player")).toBeVisible();
  expect(spoken[2]).toBe(
    await page
      .locator(".message.assistant")
      .first()
      .getAttribute("data-message-id"),
  );
});
