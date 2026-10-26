import { afterEach, describe, expect, it } from "vitest";
import {
  FishAudioSpeech,
  FISH_VOICE_ID,
  VOICE_PREVIEW,
} from "../src/speech.js";
import { createApp } from "../src/server.js";
import { setup, until } from "./helpers.js";
import type { SpeechPort } from "../src/speech.js";
import { DomainError } from "../src/domain.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
});
const mp3 = Buffer.from("ID3-synthetic-audio");
async function make(
  synthesize: (
    text: string,
    signal: AbortSignal,
  ) => Promise<Buffer> = async () => mp3,
  stream?: SpeechPort["stream"],
) {
  const x = setup({ config: { fishAudioApiKey: "synthetic-fish-secret" } });
  const app = await createApp(x.h, {
    speech: {
      stream:
        stream ??
        async function* (text, signal) {
          yield await synthesize(text, signal);
        },
    },
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    await x.dispose();
  });
  const boot = await app.inject({ url: "/bootstrap" });
  const headers = {
    cookie: `harness_session=${boot.cookies[0]!.value}`,
    "x-local-token": boot.json().csrfToken,
  };
  return { ...x, app, headers };
}

describe("Fish Audio 协议边界", () => {
  it("密钥只经后台认证头发送，使用准确音色和用户选定的S2.1-Pro，返回音频不落盘", async () => {
    const x = setup({ config: { fishAudioApiKey: "synthetic-fish-secret" } });
    cleanups.push(x.dispose);
    const requests: { url: string; options: RequestInit }[] = [];
    const provider = new FishAudioSpeech(x.config, (async (url, options) => {
      requests.push({ url: String(url), options: options! });
      return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch);
    expect(
      await provider.synthesize("合成试听", new AbortController().signal),
    ).toEqual(mp3);
    expect(requests[0]!.url).toBe("https://api.fish.audio/v1/tts");
    expect(requests[0]!.options.headers).toMatchObject({
      Authorization: "Bearer synthetic-fish-secret",
      model: "s2.1-pro",
    });
    expect(JSON.parse(String(requests[0]!.options.body))).toMatchObject({
      reference_id: FISH_VOICE_ID,
      text: "合成试听",
      format: "mp3",
      temperature: 0.7,
      top_p: 0.7,
    });
    expect(requests[0]!.url).not.toContain("secret");
  });
  for (const [status, code] of [
    [401, "speech_authentication_failed"],
    [403, "speech_authentication_failed"],
    [402, "speech_balance_insufficient"],
    [429, "speech_rate_limited"],
    [503, "speech_provider_unavailable"],
  ] as const)
    it(`${status}错误安全归一且不自动重复收费请求`, async () => {
      const x = setup({ config: { fishAudioApiKey: "synthetic-fish-secret" } });
      cleanups.push(x.dispose);
      let calls = 0;
      const provider = new FishAudioSpeech(x.config, (async () => {
        calls++;
        return new Response("sensitive-provider-error", { status });
      }) as typeof fetch);
      await expect(
        provider.synthesize("合成", new AbortController().signal),
      ).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    });
  it("缺少凭据、过长文本在外发前拒绝", async () => {
    const x = setup();
    cleanups.push(x.dispose);
    const provider = new FishAudioSpeech(x.config, (async () => {
      throw new Error("must_not_call");
    }) as typeof fetch);
    await expect(
      provider.synthesize("合成", new AbortController().signal),
    ).rejects.toMatchObject({ code: "speech_key_missing" });
    const configured = new FishAudioSpeech({
      ...x.config,
      fishAudioApiKey: "synthetic",
    });
    await expect(
      configured.synthesize("长".repeat(4001), new AbortController().signal),
    ).rejects.toMatchObject({ code: "speech_text_too_long" });
  });
  it("200但实际JSON／空音频／超过上限均不当成可播放MP3", async () => {
    const x = setup({ config: { fishAudioApiKey: "synthetic" } });
    cleanups.push(x.dispose);
    for (const response of [
      new Response("{}", { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "audio/mpeg" } }),
      new Response("", { headers: { "content-type": "audio/mpeg" } }),
      new Response(Buffer.alloc(10 * 1024 * 1024 + 1), {
        headers: { "content-type": "audio/mpeg" },
      }),
    ]) {
      const provider = new FishAudioSpeech(
        x.config,
        (async () => response) as typeof fetch,
      );
      await expect(
        provider.synthesize("合成", new AbortController().signal),
      ).rejects.toBeInstanceOf(DomainError);
    }
  });
  it("取消信号传到提供方，原始异常和密钥不出边界", async () => {
    const x = setup({ config: { fishAudioApiKey: "synthetic" } });
    cleanups.push(x.dispose);
    let started = false;
    const provider = new FishAudioSpeech(x.config, (async (_url, options) => {
      started = true;
      return new Promise<Response>((_resolve, reject) =>
        options!.signal!.addEventListener(
          "abort",
          () => reject(new Error("secret-original-error")),
          { once: true },
        ),
      );
    }) as typeof fetch);
    const controller = new AbortController(),
      pending = provider.synthesize("合成", controller.signal);
    await until(() => started);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "speech_cancelled",
      message: "speech_cancelled",
    });
  });
});

describe("语音API权限、来源与生命周期", () => {
  it("沿用cookie／CSRF且配置不暴露key，CSP只为播放器开放blob", async () => {
    const x = await make();
    expect((await x.app.inject({ url: "/v1/voice" })).statusCode).toBe(401);
    const info = await x.app.inject({ url: "/v1/voice", headers: x.headers });
    expect(info.json()).toMatchObject({
      voiceId: FISH_VOICE_ID,
      configured: true,
    });
    expect(info.body).not.toContain("synthetic-fish-secret");
    const payload = {
      kind: "preview",
      expectedEpoch: x.store.settings().epoch,
    };
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/speech",
          payload,
          headers: { cookie: x.headers.cookie },
        })
      ).statusCode,
    ).toBe(403);
    const audio = await x.app.inject({
      method: "POST",
      url: "/v1/speech",
      payload,
      headers: x.headers,
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.rawPayload).toEqual(mp3);
    expect(audio.headers["cache-control"]).toBe("no-store");
    expect(audio.headers["content-security-policy"]).toContain(
      "media-src 'self' blob:",
    );
  });
  it("只能朗读当前完整助手回复，不能注入文本或朗读用户原文／旧修订", async () => {
    const texts: string[] = [];
    const x = await make(async (text) => {
      texts.push(text);
      return mp3;
    });
    const r = x.h.submit("合成语音来源", "speech-source");
    await x.h.waitForIdle();
    const assistant = x.store.require("messages", `assistant-${r.runId}`);
    const payload = {
      kind: "message",
      id: assistant.id,
      expectedEpoch: x.store.settings().epoch,
      expectedRevision: assistant.revision,
    };
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/speech",
          headers: x.headers,
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(texts).toEqual([assistant.content]);
    for (const changes of [
      { text: "任意注入" },
      { id: r.messageId },
      { expectedRevision: assistant.revision + 1 },
      { expectedEpoch: 0 },
    ])
      expect(
        (
          await x.app.inject({
            method: "POST",
            url: "/v1/speech",
            headers: x.headers,
            payload: { ...payload, ...changes },
          })
        ).statusCode,
      ).not.toBe(200);
    expect(texts).toHaveLength(1);
  });
  it("生成中遗忘会取消远端请求，迟到音频不返回，监听器回收", async () => {
    let started = false,
      aborted = false;
    const x = await make(async (_text, signal) => {
      started = true;
      return new Promise<Buffer>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(mp3);
          },
          { once: true },
        );
      });
    });
    const r = x.h.submit("待遗忘的合成资料", "speech-forget");
    await x.h.waitForIdle();
    const m = x.store.require("messages", `assistant-${r.runId}`);
    const baseline = x.h.signals.listenerCount("change");
    const pending = x.app.inject({
      method: "POST",
      url: "/v1/speech",
      headers: x.headers,
      payload: {
        kind: "message",
        id: m.id,
        expectedEpoch: x.store.settings().epoch,
        expectedRevision: m.revision,
      },
    });
    // inject is lazy until awaited/then is attached.
    const response = Promise.resolve(pending);
    await until(() => started);
    x.h.forget([r.messageId], []);
    expect((await response).statusCode).toBe(409);
    expect(aborted).toBe(true);
    expect(x.h.signals.listenerCount("change")).toBe(baseline);
  });
  it("单一合成并发限制，预览是固定合成文本，不从前端收私密原文", async () => {
    let release: () => void = () => {},
      started = false;
    const x = await make(async (text) => {
      expect(text).toBe(VOICE_PREVIEW);
      started = true;
      await new Promise<void>((r) => {
        release = r;
      });
      return mp3;
    });
    const payload = {
      kind: "preview",
      expectedEpoch: x.store.settings().epoch,
    };
    const first = Promise.resolve(
      x.app.inject({
        method: "POST",
        url: "/v1/speech",
        headers: x.headers,
        payload,
      }),
    );
    await until(() => started);
    const second = await x.app.inject({
      method: "POST",
      url: "/v1/speech",
      headers: x.headers,
      payload,
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe("speech_busy");
    release();
    expect((await first).statusCode).toBe(200);
  });
});

describe("HTTP 音频真正逐块传输", () => {
  it("提供方首块不等待尾块，MP3标记跨块也能校验", async () => {
    const x = setup({ config: { fishAudioApiKey: "synthetic" } });
    cleanups.push(x.dispose);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new FishAudioSpeech(
      x.config,
      (async () =>
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(Buffer.from("I"));
              c.enqueue(Buffer.from("D3-first"));
              await gate;
              c.enqueue(Buffer.from("-last"));
              c.close();
            },
          }),
          { headers: { "content-type": "audio/mpeg" } },
        )) as typeof fetch,
    );
    const iterator = provider.stream("合成", AbortSignal.timeout(3000));
    try {
      expect((await iterator.next()).value).toEqual(Buffer.from("ID3-first"));
    } finally {
      release();
    }
    expect((await iterator.next()).value).toEqual(Buffer.from("-last"));
    expect((await iterator.next()).done).toBe(true);
  });

  it("真实HTTP客户端在尾块未生成时收到首块，并保持单并发", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const x = await make(undefined, async function* () {
      yield mp3;
      await gate;
      yield Buffer.from("tail");
    });
    const base = await x.app.listen({ host: "127.0.0.1", port: 0 });
    const payload = {
      kind: "preview",
      expectedEpoch: x.store.settings().epoch,
    };
    const response = await fetch(`${base}/v1/speech`, {
      method: "POST",
      headers: { ...x.headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    const reader = response.body!.getReader();
    try {
      expect(response.headers.get("content-length")).toBeNull();
      expect(Buffer.from((await reader.read()).value!)).toEqual(mp3);
      const busy = await x.app.inject({
        method: "POST",
        url: "/v1/speech",
        headers: x.headers,
        payload,
      });
      expect(busy.statusCode).toBe(429);
    } finally {
      release();
    }
    expect(Buffer.from((await reader.read()).value!)).toEqual(
      Buffer.from("tail"),
    );
    expect((await reader.read()).done).toBe(true);
  });

  it("首块后的提供方故障截断HTTP，不能假装音频成功完成", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const x = await make(undefined, async function* () {
      yield mp3;
      await gate;
      throw new DomainError("speech_provider_unavailable", 502);
    });
    const base = await x.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${base}/v1/speech`, {
      method: "POST",
      headers: { ...x.headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "preview",
        expectedEpoch: x.store.settings().epoch,
      }),
      signal: AbortSignal.timeout(3000),
    });
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!)).toEqual(mp3);
    release();
    await expect(reader.read()).rejects.toThrow();
    expect(x.h.signals.listenerCount("change")).toBe(0);
  });

  it("客户端停止接收会取消还在等待的提供方并释放并发槽", async () => {
    let started = false,
      signal: AbortSignal | undefined;
    const x = await make(undefined, async function* (_text, incoming) {
      signal = incoming;
      yield mp3;
      started = true;
      // Deliberately uncooperative adapter: server must still terminate its wait.
      await new Promise<void>(() => {});
    });
    const baseline = x.h.signals.listenerCount("change");
    const base = await x.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/speech`, {
      method: "POST",
      headers: { ...x.headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "preview",
        expectedEpoch: x.store.settings().epoch,
      }),
      signal: controller.signal,
    });
    await response.body!.getReader().read();
    await until(() => started);
    controller.abort();
    await until(
      () => signal!.aborted && x.h.signals.listenerCount("change") === baseline,
    );
  });
});
