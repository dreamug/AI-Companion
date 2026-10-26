import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // No browser regression test may accidentally make chargeable synthesis calls.
  await page.route("**/v1/speech", (route) =>
    route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } }),
  );
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ json: { configured: false, voiceName: "测试音色" } }),
  );
  await page.addInitScript(() => {
    const w = window as unknown as {
      Notification: unknown;
      testNotifications: { body: string; onclick?: () => void }[];
    };
    w.testNotifications = [];
    class TestNotification {
      static permission = "granted";
      static async requestPermission() {
        return "granted";
      }
      body: string;
      onshow?: () => void;
      onclick?: () => void;
      onerror?: () => void;
      constructor(_title: string, options: { body: string }) {
        this.body = options.body;
        w.testNotifications.push(this);
        setTimeout(() => this.onshow?.(), 80);
      }
      close() {}
    }
    w.Notification = TestNotification;
  });
  await page.goto("/");
  await expect(page.locator("#connection")).toContainText("本地已连接");
});

// Closing a browser context is abrupt and need not dispatch pagehide. Navigate
// away explicitly so each test releases its live notification channel.
test.afterEach(async ({ page }) => {
  if (!page.url().startsWith("http://127.0.0.1:4319")) return;
  const offline = page
    .waitForResponse(
      (r) =>
        r.url().endsWith("/v1/channel") &&
        r.request().postDataJSON()?.permission === "offline",
      { timeout: 1000 },
    )
    .catch(() => null);
  await page.goto("about:blank");
  await offline;
});

test("聊天、刷新恢复、Trace和移动布局", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#chat-input").fill("浏览器合成聊天测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "浏览器合成聊天测试",
  );
  await page.reload();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "浏览器合成聊天测试",
  );
  await page.getByRole("button", { name: "Trace / 维护", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Trace 和上下文", exact: true })
    .click();
  await expect(page.locator("#trace-content")).toContainText("projected");
  await page.screenshot({
    path: "test-results/test-web-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("#chat-input")).toBeVisible();
  expect(errors).toEqual([]);
});

test("记忆新增、置顶、更正、来源可查且内容不会被当HTML执行", async ({
  page,
}) => {
  await page.getByRole("button", { name: "添加确认记忆", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor
    .locator("textarea")
    .fill("合成偏好：喜欢咖啡 <img src=x onerror=alert(1)>");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("#memory-list")).toContainText(
    "合成偏好：喜欢咖啡",
  );
  expect(await page.locator("#memory-list img").count()).toBe(0);
  const card = page
    .locator("#memory-list .card")
    .filter({ hasText: "合成偏好：喜欢咖啡" });
  await card.getByRole("button", { name: "更正", exact: true }).click();
  await editor.locator("textarea").fill("合成偏好：现在喜欢茶");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("#memory-list")).toContainText(
    "合成偏好：现在喜欢茶",
  );
  await page
    .locator("#memory-list .card")
    .filter({ hasText: "合成偏好：现在喜欢茶" })
    .getByRole("button", { name: "来源", exact: true })
    .click();
  await expect(editor).toContainText("合成偏好：现在喜欢茶");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
});

test("人格版本与专注开关真实保存", async ({ page }) => {
  await page.getByLabel("专注工作", { exact: true }).check();
  await page.reload();
  await expect(page.getByLabel("专注工作", { exact: true })).toBeChecked();
  await page.getByLabel("专注工作", { exact: true }).uncheck();
  await page.getByRole("button", { name: "人格", exact: true }).click();
  await page.locator("#persona-name").fill("测试陪伴者");
  await page.getByRole("button", { name: "发布新版本", exact: true }).click();
  await expect(page.locator("#model-status")).toContainText("人格 v2");
  await page.reload();
  await page.getByRole("button", { name: "人格", exact: true }).click();
  await expect(page.locator("#persona-name")).toHaveValue("测试陪伴者");
});

test("跟进到浏览器适配、点击回执、重载不补弹旧通知", async ({ page }) => {
  await page.getByRole("button", { name: "关心与投递", exact: true }).click();
  await page
    .getByRole("button", { name: "建立一次性跟进", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("textarea").fill("浏览器合成跟进事项");
  const now = Date.now();
  function local(at: number) {
    const d = new Date(at);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  await dialog
    .locator("input[type=datetime-local]")
    .nth(0)
    .fill(local(now - 60000));
  await dialog
    .locator("input[type=datetime-local]")
    .nth(1)
    .fill(local(now + 3600000));
  await dialog.locator("input[type=checkbox]").check();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testNotifications: unknown[] })
            .testNotifications.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (
      window as unknown as { testNotifications: { onclick?: () => void }[] }
    ).testNotifications[0]?.onclick?.(),
  );
  await expect(page.locator("#delivery-list")).toContainText("有点击回执");
  await page.reload();
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testNotifications: unknown[] })
          .testNotifications.length,
    ),
  ).toBe(0);
});

test("遗忘同步清除已展开上下文，其他页面也不会保留旧正文", async ({
  page,
  context,
}) => {
  const secret = "合成遗忘标记-月光书架-7391";
  await page.locator("#chat-input").fill(secret);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(secret);
  await page.getByRole("button", { name: "Trace / 维护", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Trace 和上下文", exact: true })
    .click();
  await expect(page.locator("#trace-content")).toContainText(secret);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("#connection")).toContainText("本地已连接");
  await other
    .getByRole("button", { name: "Trace / 维护", exact: true })
    .click();
  await other
    .getByRole("button", { name: "查看 Trace 和上下文", exact: true })
    .click();
  await expect(other.locator("#trace-content")).toContainText(secret);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".message.user")
    .filter({ hasText: secret })
    .getByRole("button", { name: "遗忘这条原始发言" })
    .click();
  for (const current of [page, other]) {
    await expect(current.locator("#trace-content")).not.toContainText(secret);
    await expect(current.locator("#messages")).not.toContainText(secret);
  }
  await page.locator("#chat-input").fill("遗忘之后继续聊天");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "遗忘之后继续聊天",
  );
  await other.close();
});

async function voiceFixture(page: import("@playwright/test").Page) {
  const { readFile } = await import("node:fs/promises");
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  const requests: Record<string, unknown>[] = [];
  await page.route("**/v1/voice", (route) =>
    route.fulfill({
      json: {
        provider: "fish-audio",
        configured: true,
        voiceName: "甜妹",
        voiceId: "5b50d7ae59f24c0cb447599df8ae34ab",
        model: "s1",
        maxChars: 4000,
      },
    }),
  );
  await page.route("**/v1/speech", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "audio/mpeg", body: audio });
  });
  await page.reload();
  await expect(page.locator("#voice-name")).toContainText("甜妹");
  return requests;
}

test("真实浏览器音频解码、手动朗读与停止，前端只发送来源ID", async ({
  page,
}) => {
  const requests = await voiceFixture(page);
  await page.getByLabel("自动朗读新回复", { exact: true }).uncheck();
  await page.locator("#chat-input").fill("语音手动播放合成测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const message = page.locator(".message.assistant").last();
  await expect(message).toContainText("语音手动播放合成测试");
  expect(requests).toHaveLength(0);
  await message.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(page.locator("#voice-status")).toContainText("正在朗读");
  await expect
    .poll(() =>
      page
        .locator("#voice-player")
        .evaluate(
          (audio: HTMLAudioElement) => audio.readyState >= 2 && !audio.paused,
        ),
    )
    .toBe(true);
  expect(requests[0]).toMatchObject({
    kind: "message",
    id: expect.any(String),
    expectedEpoch: expect.any(Number),
    expectedRevision: expect.any(Number),
  });
  expect(requests[0]).not.toHaveProperty("text");
  await page.getByRole("button", { name: "停止朗读", exact: true }).click();
  await expect(page.locator("#voice-player")).toBeHidden();
  await expect(page.locator("#voice-player")).not.toHaveAttribute("src");
  await expect(page.locator("#voice-status")).toContainText("已停止");
});

test("自动朗读默认开启且只处理新回复，刷新不重播历史", async ({ page }) => {
  const requests = await voiceFixture(page);
  await expect(
    page.getByLabel("自动朗读新回复", { exact: true }),
  ).toBeChecked();
  await page.locator("#chat-input").fill("语音自动播放合成测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator("#voice-status")).toContainText("正在朗读");
  await page.reload();
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await expect(
    page.getByLabel("自动朗读新回复", { exact: true }),
  ).toBeChecked();
  await page.waitForTimeout(250);
  expect(requests).toHaveLength(1);
});

test("播放中的来源被遗忘后停止并释放音频，旧声音不继续", async ({ page }) => {
  await voiceFixture(page);
  await page.getByLabel("自动朗读新回复", { exact: true }).uncheck();
  await page.locator("#chat-input").fill("语音遗忘合成标记");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const assistant = page.locator(".message.assistant").last();
  await expect(assistant).toContainText("语音遗忘合成标记");
  await assistant.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(page.locator("#voice-player")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".message.user")
    .filter({ hasText: "语音遗忘合成标记" })
    .getByRole("button", { name: "遗忘这条原始发言", exact: true })
    .click();
  await expect(page.locator("#voice-player")).toBeHidden();
  await expect(page.locator("#voice-player")).not.toHaveAttribute("src");
  await expect(page.locator("#voice-status")).toContainText("旧语音已清理");
});

test("语音配置接口失败不会阻断文字聊天和SSE", async ({ page }) => {
  await page.route("**/v1/voice", (route) =>
    route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } }),
  );
  await page.reload();
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await expect(page.locator("#voice-name")).toContainText("文字聊天仍可使用");
  await page.locator("#chat-input").fill("语音故障时仍可文字聊天");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "语音故障时仍可文字聊天",
  );
});

test("通知回执响应较慢时也能立即处理用户点击", async ({ page }) => {
  await page.route("**/v1/deliveries/*/events", async (route) => {
    if (route.request().postDataJSON().event === "constructed") {
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, 700));
      await route.fulfill({ response });
    } else await route.continue();
  });
  const boot = await (await page.request.get("/bootstrap")).json();
  const created = await page.request.post("/v1/follow-ups", {
    headers: { "X-Local-Token": boot.csrfToken },
    data: {
      text: "快速点击合成测试",
      dueAt: Date.now(),
      latestAt: Date.now() + 3600000,
      allowInterrupt: true,
    },
  });
  expect(created.ok()).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testNotifications: unknown[] })
            .testNotifications.length,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (
      window as unknown as { testNotifications: { onclick?: () => void }[] }
    ).testNotifications[0]?.onclick?.(),
  );
  await expect(page.locator("#delivery-list")).toContainText("有点击回执");
});

test("MP3后半段尚未到达时前半段已在真实浏览器播放", async ({ page }) => {
  const { setup } = await import("../helpers.js");
  const { createApp } = await import("../../src/server.js");
  const { readFile } = await import("node:fs/promises");
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  let release!: () => void,
    finished = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const x = setup();
  const app = await createApp(x.h, {
    speech: {
      async *stream() {
        yield audio.subarray(0, 24000);
        await gate;
        finished = true;
        yield audio.subarray(24000);
      },
    },
  });
  try {
    await page.unroute("**/v1/voice");
    await page.unroute("**/v1/speech");
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(base);
    await expect(page.locator("#voice-name")).toContainText("甜妹");
    await page.getByRole("button", { name: "试听音色", exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator("#voice-player")
          .evaluate((a: HTMLAudioElement) => a.currentTime > 0.05 && !a.paused),
      )
      .toBe(true);
    expect(finished).toBe(false);
    release();
    await expect.poll(() => finished).toBe(true);
    await expect(page.locator("#voice-status")).toContainText("朗读");
  } finally {
    release();
    await page.goto("about:blank");
    await app.close();
    await x.dispose();
  }
});

test("浏览器禁止自动播放时仍保留默认开关和单次音频", async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => {
      throw new DOMException("blocked", "NotAllowedError");
    };
  });
  const requests = await voiceFixture(page);
  await page.getByRole("button", { name: "试听音色", exact: true }).click();
  await expect(page.locator("#voice-status")).toContainText("需要一次点击");
  await expect(
    page.getByLabel("自动朗读新回复", { exact: true }),
  ).toBeChecked();
  await expect(page.locator("#voice-player")).toBeVisible();
  expect(requests).toHaveLength(1);
});

test("不支持MP3 MediaSource时单次请求兼容播放", async ({ page }) => {
  await page.addInitScript(() => {
    MediaSource.isTypeSupported = () => false;
  });
  const requests = await voiceFixture(page);
  await page.getByRole("button", { name: "试听音色", exact: true }).click();
  await expect(page.locator("#voice-status")).toContainText("正在朗读");
  expect(requests).toHaveLength(1);
});

test("网页切换两位角色、多轮聊天和刷新后历史各自保留", async ({ page }) => {
  const original = `只属于原角色-${Date.now()}`;
  await page.locator("#chat-input").fill(original);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    original,
  );
  await page.locator("#chat-input").fill("原角色未发送草稿");
  await page.locator("#bot-select").selectOption("xiaotang");
  await expect(page).toHaveURL(/bot=xiaotang/);
  await expect(page.locator("#chat-input")).toHaveValue("");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await expect(page.locator("#messages")).not.toContainText(original);
  for (const text of ["小棠第一轮合成对话", "小棠第二轮合成对话"]) {
    await page.locator("#chat-input").fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".message.assistant").last()).toContainText(text);
  }
  await page.reload();
  await expect(page.locator("#bot-select")).toHaveValue("xiaotang");
  await expect(page.locator("#messages")).toContainText("小棠第一轮合成对话");
  await page.locator("#bot-select").selectOption("xiaoye");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await expect(page.locator("#messages")).toContainText(original);
  await expect(page.locator("#messages")).not.toContainText(
    "小棠第一轮合成对话",
  );
  await expect(page.locator("#chat-input")).toHaveValue("原角色未发送草稿");
  await page.locator("#chat-input").fill("");
  await expect(page.locator("#archive-bot")).toBeDisabled();
});

test("网页创建、编辑角色与相处设定、归档和恢复完整可用", async ({ page }) => {
  const name = `小雨-${Date.now()}`;
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.locator("input").fill(name);
  await editor.getByLabel("初始相处模式").selectOption("romantic");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page).toHaveURL(/bot=[a-f0-9-]{36}/);
  await expect(page.locator("#connection")).toContainText("本地已连接");
  const id = new URL(page.url()).searchParams.get("bot")!;
  await expect(page.locator("#messages .message")).toHaveCount(0);
  await page.getByRole("button", { name: "人格", exact: true }).click();
  await expect(page.locator("#persona-name")).toHaveValue(name);
  await expect(page.locator("#relationship-mode")).toHaveValue("romantic");
  await page.locator("#persona-background").fill("成年虚构角色，喜欢看电影。");
  await page.locator("#persona-interests").fill("电影和摄影");
  await page.locator("#relationship-user").fill("阿宇");
  await page
    .locator("#relationship-interaction")
    .fill("自然简短地聊天，工作时认真。");
  await page.getByRole("button", { name: "发布新版本", exact: true }).click();
  await expect(page.locator("#model-status")).toContainText("人格 v2");
  await page.reload();
  await page.getByRole("button", { name: "人格", exact: true }).click();
  await expect(page.locator("#persona-background")).toHaveValue(
    "成年虚构角色，喜欢看电影。",
  );
  await expect(page.locator("#relationship-user")).toHaveValue("阿宇");
  await page.locator("#chat-input").fill("归档恢复要保留的聊天");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "归档恢复要保留的聊天",
  );
  await page.getByRole("button", { name: "归档当前角色", exact: true }).click();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page).toHaveURL(/bot=xiaoye/);
  await page.getByText("已归档角色", { exact: true }).click();
  const card = page.locator("#archived-bots .card").filter({ hasText: name });
  await card.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.locator(`#bot-select option[value="${id}"]`)).toHaveCount(
    1,
  );
  await page.locator("#bot-select").selectOption(id);
  await expect(page.locator("#messages")).toContainText("归档恢复要保留的聊天");
});

test("不同角色的并行页面不串消息、记忆和遗忘事件", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await other.goto("/?bot=xiaotang");
  await expect(other.locator("#connection")).toContainText("本地已连接");
  const a = `原角色隔离-${Date.now()}`,
    b = `女友角色隔离-${Date.now()}`;
  for (const [p, text] of [
    [page, a],
    [other, b],
  ] as const) {
    await p.locator("#chat-input").fill(text);
    await p.getByRole("button", { name: "发送", exact: true }).click();
    await expect(p.locator(".message.assistant").last()).toContainText(text);
  }
  await expect(page.locator("#messages")).not.toContainText(b);
  await expect(other.locator("#messages")).not.toContainText(a);
  page.once("dialog", (d) => d.accept());
  await page
    .locator(".message.user")
    .filter({ hasText: a })
    .getByRole("button", { name: "遗忘这条原始发言" })
    .click();
  await expect(page.locator("#messages")).not.toContainText(a);
  await expect(other.locator("#messages")).toContainText(b);
  await other.close();
});

test("切换角色会释放旧语音，新页面不重播旧角色回复", async ({ page }) => {
  const requests = await voiceFixture(page);
  await page.getByLabel("自动朗读新回复", { exact: true }).uncheck();
  await page.locator("#chat-input").fill("切换前播放测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const reply = page.locator(".message.assistant").last();
  await expect(reply).toContainText("切换前播放测试");
  await reply.getByRole("button", { name: "朗读", exact: true }).click();
  await expect(page.locator("#voice-status")).toContainText("正在朗读");
  await page.locator("#bot-select").selectOption("xiaotang");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await expect(page.locator("#voice-player")).not.toHaveAttribute("src");
  expect(requests).toHaveLength(1);
  await expect(page.locator("#messages")).not.toContainText("切换前播放测试");
});
