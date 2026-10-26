import { test, expect, type Page } from "@playwright/test";
test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/voice", (r) =>
    r.fulfill({ json: { configured: false, voiceName: "合成测试" } }),
  );
  await page.route("**/v1/speech", (r) =>
    r.fulfill({ status: 503, json: { error: "synthetic_no_tts" } }),
  );
  await page.route("**/v1/voice-input", (r) =>
    r.fulfill({
      json: { configured: true, maxSeconds: 60, maxBytes: 4 * 1024 * 1024 },
    }),
  );
  // An explicit test double keeps every fake-microphone clip local to this browser test.
  await page.route("**/v1/transcriptions", (r) =>
    r.fulfill({
      json: {
        text: "默认合成识别",
        duration: 1,
        botId: r.request().headers()["x-bot-id"],
        epoch: r.request().postDataJSON().expectedEpoch,
      },
    }),
  );
  for (const bot of ["xiaoye", "xiaotang"]) {
    const b = await page.request.get("/bootstrap", {
      headers: { "x-bot-id": bot },
    });
    const boot = await b.json();
    const snapshot = await (
      await page.request.get(
        `/v1/relationships/${boot.relationshipId}/snapshot`,
        { headers: { "x-bot-id": bot } },
      )
    ).json();
    await page.request.patch(
      `/v1/relationships/${boot.relationshipId}/settings`,
      {
        headers: { "x-bot-id": bot, "x-local-token": boot.csrfToken },
        data: {
          expectedRevision: snapshot.settings.revision,
          remoteDisclosureAcknowledged: true,
        },
      },
    );
  }
  await page.goto("/");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  if (await page.locator("#acknowledge").isVisible())
    await page.locator("#acknowledge").click();
  await expect(page.locator("#disclosure")).toBeHidden();
  await expect(page.locator("#voice-record")).toBeEnabled();
});

async function record(page: Page) {
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(page.locator("#voice-input-status")).toContainText("正在录音");
  // Wait for an actual MediaRecorder timeslice, rather than substituting a recorder.
  await expect(page.locator("#voice-input-status")).toContainText("1 秒");
  await page.getByRole("button", { name: "结束录音", exact: true }).click();
}

test("真实MediaRecorder录音转可编辑文字，确认发送后才进入当前角色聊天", async ({
  page,
}) => {
  const payloads: Record<string, unknown>[] = [];
  await page.route("**/v1/transcriptions", (r) => {
    const input = r.request().postDataJSON();
    payloads.push(input);
    expect(r.request().headers()["x-bot-id"]).toBe("xiaoye");
    const audio = Buffer.from(input.audio, "base64");
    expect(audio.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return r.fulfill({
      json: {
        text: "这是语音输入的合成文字",
        duration: 1,
        botId: "xiaoye",
        epoch: input.expectedEpoch,
      },
    });
  });
  const messages = await page.locator("#messages .message").count();
  await page.locator("#chat-input").fill("已有草稿");
  await record(page);
  await expect(page.locator("#chat-input")).toHaveValue(
    "已有草稿\n这是语音输入的合成文字",
  );
  await expect(page.locator("#messages .message")).toHaveCount(messages);
  await page.locator("#chat-input").fill("确认编辑后的语音文字");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "确认编辑后的语音文字",
  );
  expect(payloads).toHaveLength(1);
});

test("取消录音停止麦克风，不外发音频或改写草稿", async ({ page }) => {
  let calls = 0;
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks = [];
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await original(options);
      (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks.push(
        ...stream.getTracks(),
      );
      return stream;
    };
  });
  await page.route("**/v1/transcriptions", (r) => {
    calls++;
    return r.fulfill({ status: 500, json: {} });
  });
  await page.reload();
  await expect(page.locator("#voice-record")).toBeEnabled();
  await page.locator("#chat-input").fill("不应丢失的草稿");
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(page.locator("#voice-input-status")).toContainText("正在录音");
  await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
  await expect(page.locator("#voice-input-status")).toContainText("已取消");
  await expect(page.locator("#chat-input")).toHaveValue("不应丢失的草稿");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { testTracks: MediaStreamTrack[] }
      ).testTracks.every((t) => t.readyState === "ended"),
    ),
  ).toBe(true);
  expect(calls).toBe(0);
});

test("识别途中取消后迟到结果不进入输入框", async ({ page }) => {
  let arrived = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/v1/transcriptions", async (r) => {
    arrived = true;
    await gate;
    try {
      await r.fulfill({
        json: {
          text: "不该出现的迟到结果",
          duration: 1,
          botId: "xiaoye",
          epoch: r.request().postDataJSON().expectedEpoch,
        },
      });
    } catch {}
  });
  await page.locator("#chat-input").fill("保留原稿");
  await record(page);
  await expect.poll(() => arrived).toBe(true);
  await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
  release();
  await expect(page.locator("#voice-record-cancel")).toBeHidden();
  await expect(page.locator("#chat-input")).toHaveValue("保留原稿");
});

test("切换角色中止识别，不把旧角色录音写进女友草稿", async ({ page }) => {
  let arrived = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/v1/transcriptions", async (r) => {
    arrived = true;
    await gate;
    try {
      await r.fulfill({
        json: { text: "旧角色的识别", duration: 1, botId: "xiaoye", epoch: 1 },
      });
    } catch {}
  });
  await record(page);
  await expect.poll(() => arrived).toBe(true);
  await page.locator("#bot-select").selectOption("xiaotang");
  await expect(page).toHaveURL(/bot=xiaotang/);
  release();
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await expect(page.locator("#chat-input")).not.toHaveValue(/旧角色的识别/);
  await expect(page.locator("#voice-record")).toBeEnabled();
});

test("麦克风拒绝授权时说明原因，文字聊天仍可使用", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });
  await page.reload();
  await expect(page.locator("#voice-record")).toBeEnabled();
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(page.locator("#voice-input-status")).toContainText(
    "麦克风权限未开启",
  );
  await page.locator("#chat-input").fill("麦克风失败后继续文字聊天");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "麦克风失败后继续文字聊天",
  );
});

test("女友的语音结果带正确角色，服务错误不覆写输入内容", async ({ page }) => {
  await page.locator("#bot-select").selectOption("xiaotang");
  await expect(page.locator("#connection")).toContainText("本地已连接");
  await page.route("**/v1/transcriptions", (r) => {
    expect(r.request().headers()["x-bot-id"]).toBe("xiaotang");
    return r.fulfill({
      status: 502,
      json: { error: "transcription_rate_limited" },
    });
  });
  await page.locator("#chat-input").fill("女友空间的草稿");
  await record(page);
  await expect(page.locator("#voice-input-status")).toContainText("服务繁忙");
  await expect(page.locator("#chat-input")).toHaveValue("女友空间的草稿");
});
