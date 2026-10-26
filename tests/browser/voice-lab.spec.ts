import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  COMPARISON_TEXT,
  SPEECH_COMPARISONS,
} from "../../src/speech-comparison.js";

test("四组独立试听、内存重听、喜欢标记与移动布局", async ({ page }) => {
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  const requests: Record<string, unknown>[] = [];
  await page.route("**/v1/voice-comparison/speech", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "audio/mpeg", body: audio });
  });
  await page.goto("/voice-lab");
  await expect(page.locator(".variant")).toHaveCount(4);
  await expect(page.locator("#sample-text")).toHaveText(COMPARISON_TEXT);
  expect(requests).toHaveLength(0);
  await page
    .getByRole("button", { name: "生成四组，稍后试听", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(4);
  await expect(
    page.locator(".result").filter({ hasText: "生成完成" }),
  ).toHaveCount(4);
  expect(requests.map((r) => r.variantId)).toEqual(
    SPEECH_COMPARISONS.map((r) => r.id),
  );
  for (const request of requests)
    expect(Object.keys(request).sort()).toEqual(["expectedEpoch", "variantId"]);
  const card = page.locator('[data-variant="s2-soft"]');
  await card
    .getByRole("button", { name: "重听（不再合成）", exact: true })
    .click();
  await expect
    .poll(() =>
      card
        .locator("audio")
        .evaluate((a: HTMLAudioElement) => !a.paused && a.currentTime > 0),
    )
    .toBe(true);
  expect(requests).toHaveLength(4);
  await card.getByRole("button", { name: "标记喜欢", exact: true }).click();
  await expect(page.locator("#preference")).toContainText("D · S2.1-Pro");
  await expect(
    card.getByRole("button", { name: "标记喜欢", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/voice-lab-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "清除本页音频", exact: true }).click();
  await expect(card.locator("audio")).not.toHaveAttribute("src");
  await expect(
    card.getByRole("button", { name: "重听（不再合成）", exact: true }),
  ).toBeDisabled();
});

test("独立调试页经实际HTTP流在尾段到达前播放，并可取消", async ({ page }) => {
  const { setup } = await import("../helpers.js");
  const { createApp } = await import("../../src/server.js");
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  let release!: () => void,
    ended = false,
    providerSignal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const x = setup();
  const app = await createApp(x.h, {
    speech: {
      async *stream(_text, signal, options) {
        expect(options?.model).toBe("s2.1-pro");
        providerSignal = signal;
        yield audio.subarray(0, 24000);
        await gate;
        ended = true;
        yield audio.subarray(24000);
      },
    },
  });
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(base + "/voice-lab");
    const card = page.locator('[data-variant="s2-soft"]');
    await card.getByRole("button", { name: "生成并试听", exact: true }).click();
    await expect
      .poll(() =>
        card
          .locator("audio")
          .evaluate((a: HTMLAudioElement) => a.currentTime > 0.05 && !a.paused),
      )
      .toBe(true);
    expect(ended).toBe(false);
    await expect(card.locator(".timing")).toContainText(/开始播放 \d+ ms/);
    await page
      .getByRole("button", { name: "停止生成与播放", exact: true })
      .click();
    await expect.poll(() => providerSignal?.aborted).toBe(true);
    await expect(card.locator("audio")).not.toHaveAttribute("src");
    await expect(
      card.getByRole("button", { name: "重听（不再合成）", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
    await page.goto("about:blank");
    await app.close();
    await x.dispose();
  }
});

test("单组失败显示安全错误且不自动重试合成", async ({ page }) => {
  let calls = 0;
  await page.route("**/v1/voice-comparison/speech", (route) => {
    calls++;
    return route.fulfill({
      status: 502,
      json: { error: "speech_provider_unavailable" },
    });
  });
  await page.goto("/voice-lab");
  const card = page.locator('[data-variant="s1-soft"]');
  await card.getByRole("button", { name: "生成并试听", exact: true }).click();
  await expect(card.locator(".result")).toContainText("暂时不可用");
  expect(calls).toBe(1);
  await expect(
    card.getByRole("button", { name: "重听（不再合成）", exact: true }),
  ).toBeDisabled();
});

test("调试页兼容播放与浏览器权限拦截不会重复调用", async ({ page }) => {
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  let calls = 0;
  await page.route("**/v1/voice-comparison/speech", (route) => {
    calls++;
    return route.fulfill({ contentType: "audio/mpeg", body: audio });
  });
  await page.addInitScript(() => {
    MediaSource.isTypeSupported = () => false;
  });
  await page.goto("/voice-lab");
  const card = page.locator('[data-variant="s1-plain"]');
  await card.getByRole("button", { name: "生成并试听", exact: true }).click();
  await expect
    .poll(() =>
      card
        .locator("audio")
        .evaluate((a: HTMLAudioElement) => !a.paused && a.currentTime > 0),
    )
    .toBe(true);
  expect(calls).toBe(1);
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => {
      throw new DOMException("blocked", "NotAllowedError");
    };
  });
  await page.reload();
  await card.getByRole("button", { name: "生成并试听", exact: true }).click();
  await expect(card.locator(".result")).toContainText("需要一次点击");
  await expect(
    card.getByRole("button", { name: "重听（不再合成）", exact: true }),
  ).toBeEnabled();
  expect(calls).toBe(2);
});

test("已备的四份真实格式样本可直接试听且不调用合成", async ({ page }) => {
  const { setup } = await import("../helpers.js");
  const { createApp } = await import("../../src/server.js");
  const { FISH_VOICE_ID } = await import("../../src/speech.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const audio = await readFile("tests/fixtures/speech-tone.mp3");
  const x = setup();
  const dir = join(x.dir, "reports", "voice-comparison");
  await mkdir(dir, { recursive: true });
  for (const v of SPEECH_COMPARISONS)
    await writeFile(join(dir, `${v.id}.mp3`), audio);
  await writeFile(
    join(dir, "report.json"),
    JSON.stringify({
      passed: true,
      text: COMPARISON_TEXT,
      voiceId: FISH_VOICE_ID,
      results: SPEECH_COMPARISONS.map((v) => ({
        ...v,
        passed: true,
        bytes: audio.length,
        firstChunkMs: 100,
        totalMs: 200,
      })),
    }),
  );
  let calls = 0;
  const app = await createApp(x.h, {
    speech: {
      async *stream() {
        calls++;
        throw new Error("must_not_synthesize");
      },
    },
  });
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(base + "/voice-lab");
    await expect(
      page.getByRole("button", { name: "试听已备样本", exact: true }),
    ).toHaveCount(4);
    const card = page.locator('[data-variant="s2-soft"]');
    await card
      .getByRole("button", { name: "试听已备样本", exact: true })
      .click();
    await expect
      .poll(() =>
        card
          .locator("audio")
          .evaluate((a: HTMLAudioElement) => a.currentTime > 0 && !a.paused),
      )
      .toBe(true);
    expect(calls).toBe(0);
  } finally {
    await page.goto("about:blank");
    await app.close();
    await x.dispose();
  }
});
