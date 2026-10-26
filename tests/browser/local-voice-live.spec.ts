import { test, expect } from "@playwright/test";

// Explicit opt-in: actual offline model + a fixed synthetic microphone file.
test.skip(process.env.LOCAL_ASR_LIVE !== "1", "需要显式启用本地模型实测");
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${process.env.LOCAL_ASR_TEST_AUDIO ?? "/missing-synthetic-audio.wav"}`,
    ],
  },
  permissions: ["microphone"],
});
test("浏览器录音经实际本地模型形成草稿，未发送内容不进入聊天", async ({
  page,
}) => {
  test.setTimeout(65000);
  await page.route("**/v1/voice", (r) =>
    r.fulfill({ json: { configured: false, voiceName: "测试" } }),
  );
  await page.goto("/?bot=xiaotang");
  await expect(page.locator("#voice-input-status")).toContainText(
    "本地识别已就绪",
  );
  await expect(page.locator("#voice-input-help")).toContainText(
    "不上传语音服务",
  );
  // Audio remains local even when chat's remote model disclosure is unacknowledged.
  const response = await page.request.get("/v1/voice-input", {
    headers: { "x-bot-id": "xiaotang" },
  });
  expect(await response.json()).toMatchObject({
    provider: "local-whisper",
    remote: false,
    configured: true,
  });
  const before = await page.locator("#messages .message").count();
  await page.locator("#chat-input").fill("保留的文字草稿");
  await page.locator("#voice-record").click();
  await expect(page.locator("#voice-input-status")).toContainText("7 秒", {
    timeout: 12000,
  });
  await page.locator("#voice-record").click();
  await expect(page.locator("#voice-input-status")).toContainText(
    "已转成文字",
    { timeout: 45000 },
  );
  await expect(page.locator("#chat-input")).toHaveValue(
    /保留的文字草稿\n.*你好呀.*小野/,
  );
  await expect(page.locator("#messages .message")).toHaveCount(before);
});
