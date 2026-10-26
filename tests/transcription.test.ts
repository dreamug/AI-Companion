import { afterEach, describe, expect, it } from "vitest";
import {
  FishAudioTranscription,
  decodeRecording,
  MAX_RECORDING_BYTES,
  type TranscriptionPort,
} from "../src/transcription.js";
import { createApp } from "../src/server.js";
import { BotManager } from "../src/bots.js";
import { setup, until } from "./helpers.js";
import { rmSync } from "node:fs";

const audio = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from("synthetic-browser-recording"),
]);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const signal = () => new AbortController().signal;
async function fixture(
  transcription: TranscriptionPort = {
    async transcribe() {
      return { text: "合成识别文字", duration: 1 };
    },
  },
) {
  const x = setup({ config: { fishAudioApiKey: "synthetic-fish-key" } });
  const app = await createApp(x.h, { transcription });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    await x.dispose();
  });
  const b = await app.inject({ url: "/bootstrap" });
  const headers = {
    cookie: `harness_session=${b.cookies[0]!.value}`,
    "x-local-token": b.json().csrfToken,
  };
  const payload = {
    audio: audio.toString("base64"),
    mimeType: "audio/webm",
    expectedEpoch: 1,
  };
  return { ...x, app, headers, payload };
}

describe("语音输入适配器", () => {
  it("用准确Pro模型和multipart发送二进制，去掉说话人标记，不泄露凭据", async () => {
    const x = setup({ config: { fishAudioApiKey: "synthetic-secret" } });
    cleanups.push(x.dispose);
    let calls = 0;
    const adapter = new FishAudioTranscription(x.config, async (url, init) => {
      calls++;
      expect(url).toBe("https://api.fish.audio/v1/asr");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer synthetic-secret",
        model: "transcribe-1-pro",
      });
      expect(init?.headers).not.toHaveProperty("Content-Type");
      const form = init?.body as FormData;
      expect(form.get("language")).toBe("zh");
      expect(form.get("ignore_timestamps")).toBe("true");
      expect(form.get("tag_audio_events")).toBe("false");
      expect(
        Buffer.from(await (form.get("audio") as Blob).arrayBuffer()),
      ).toEqual(audio);
      return Response.json({
        text: "<|speaker:0|> 你好，小棠。",
        duration: 1.2,
        segments: [],
      });
    });
    expect(await adapter.transcribe(audio, "audio/webm", signal())).toEqual({
      text: "你好，小棠。",
      duration: 1.2,
    });
    expect(calls).toBe(1);
  });
  it.each([
    [401, "transcription_authentication_failed"],
    [402, "transcription_balance_insufficient"],
    [429, "transcription_rate_limited"],
    [503, "transcription_provider_unavailable"],
    [400, "recording_invalid_audio"],
  ])("提供方%s错误归一且不自动重试", async (status, code) => {
    const x = setup({ config: { fishAudioApiKey: "secret-never-return" } });
    cleanups.push(x.dispose);
    let calls = 0;
    const adapter = new FishAudioTranscription(x.config, async () => {
      calls++;
      return new Response("private-provider-detail", {
        status: Number(status),
      });
    });
    await expect(
      adapter.transcribe(audio, "audio/webm", signal()),
    ).rejects.toThrow(String(code));
    expect(calls).toBe(1);
  });
  it("缺凭据、非法录音和过大录音在外发前拒绝", async () => {
    const x = setup();
    cleanups.push(x.dispose);
    let calls = 0;
    const adapter = new FishAudioTranscription(x.config, async () => {
      calls++;
      return Response.json({});
    });
    await expect(
      adapter.transcribe(audio, "audio/webm", signal()),
    ).rejects.toThrow("transcription_key_missing");
    expect(() => decodeRecording("not-base64", "audio/webm")).toThrow(
      "recording_invalid_audio",
    );
    expect(() =>
      decodeRecording(
        Buffer.from("not audio but text").toString("base64"),
        "audio/webm",
      ),
    ).toThrow("recording_invalid_audio");
    expect(() =>
      decodeRecording(
        Buffer.alloc(MAX_RECORDING_BYTES + 1).toString("base64"),
        "audio/wav",
      ),
    ).toThrow("recording_too_large");
    expect(calls).toBe(0);
  });
  it("静音、过长录音和异常响应不会生成聊天文本", async () => {
    const x = setup({ config: { fishAudioApiKey: "test-key" } });
    cleanups.push(x.dispose);
    for (const [data, code] of [
      [{ text: "<|speaker:0|> ", duration: 1 }, "transcription_no_speech"],
      [{ text: "长录音", duration: 90 }, "recording_too_long"],
      [{ text: "missing duration" }, "transcription_provider_unavailable"],
    ] as const) {
      const adapter = new FishAudioTranscription(x.config, async () =>
        Response.json(data),
      );
      await expect(
        adapter.transcribe(audio, "audio/webm", signal()),
      ).rejects.toThrow(code);
    }
  });
  it("取消可释放不响应signal的提供方等待，预取消不外发", async () => {
    const x = setup({ config: { fishAudioApiKey: "test-key" } });
    cleanups.push(x.dispose);
    let calls = 0;
    const adapter = new FishAudioTranscription(x.config, async () => {
      calls++;
      return new Promise<Response>(() => {});
    });
    const c = new AbortController();
    c.abort();
    await expect(
      adapter.transcribe(audio, "audio/webm", c.signal),
    ).rejects.toThrow("transcription_cancelled");
    expect(calls).toBe(0);
    const d = new AbortController();
    const pending = adapter.transcribe(audio, "audio/webm", d.signal);
    await until(() => calls === 1);
    d.abort();
    await expect(pending).rejects.toThrow("transcription_cancelled");
  });
});

describe("语音输入API作用域和生命周期", () => {
  it("识别只返回当前角色草稿，不新增消息或记忆", async () => {
    const x = await fixture();
    const before = x.h.snapshot();
    const r = await x.app.inject({
      method: "POST",
      url: "/v1/transcriptions",
      headers: x.headers,
      payload: x.payload,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      text: "合成识别文字",
      botId: "xiaoye",
      epoch: 1,
    });
    expect(x.h.snapshot().messages).toEqual(before.messages);
    expect(x.h.snapshot().memories).toEqual(before.memories);
    expect(r.body).not.toContain("synthetic-fish-key");
    expect(
      (
        await x.app.inject({ url: "/v1/voice-input", headers: x.headers })
      ).json(),
    ).toMatchObject({ configured: true, maxSeconds: 60 });
  });
  it("身份、CSRF、来源代数和外发许可在外发前核查", async () => {
    let calls = 0;
    const x = await fixture({
      async transcribe() {
        calls++;
        return { text: "测试", duration: 1 };
      },
    });
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          payload: x.payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: { cookie: x.headers.cookie },
          payload: x.payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: x.headers,
          payload: { ...x.payload, expectedEpoch: 2 },
        })
      ).statusCode,
    ).toBe(409);
    x.h.updateSettings({
      expectedRevision: x.store.settings().revision,
      remoteDisclosureAcknowledged: false,
    });
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: x.headers,
          payload: x.payload,
        })
      ).statusCode,
    ).toBe(409);
    expect(calls).toBe(0);
  });
  it.each(["forget", "consent"])(
    "%s使在途识别失效，迟到文本不得返回",
    async (kind) => {
      let resolve!: (v: { text: string; duration: number }) => void;
      let started = false;
      const x = await fixture({
        async transcribe() {
          started = true;
          return new Promise((r) => {
            resolve = r;
          });
        },
      });
      const pending = x.app
        .inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: x.headers,
          payload: x.payload,
        })
        .then((r) => r);
      await until(() => started);
      if (kind === "forget") {
        const memory = x.h.addMemory({ text: "用于合成遗忘测试" });
        x.h.forget([], [memory.id]);
      } else
        x.h.updateSettings({
          expectedRevision: x.store.settings().revision,
          remoteDisclosureAcknowledged: false,
        });
      const r = await pending;
      resolve({ text: "迟到私人文本", duration: 1 });
      expect(r.statusCode).toBe(409);
      expect(r.body).not.toContain("迟到私人文本");
    },
  );
  it("单角色并发受限，结束后可再次录音", async () => {
    let resolve!: (v: { text: string; duration: number }) => void,
      started = false;
    const x = await fixture({
      async transcribe() {
        started = true;
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    const first = x.app
      .inject({
        method: "POST",
        url: "/v1/transcriptions",
        headers: x.headers,
        payload: x.payload,
      })
      .then((r) => r);
    await until(() => started);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: x.headers,
          payload: x.payload,
        })
      ).statusCode,
    ).toBe(429);
    resolve({ text: "完成", duration: 1 });
    expect((await first).statusCode).toBe(200);
  });
  it("女友识别结果携带自身身份，归档会中止等待", async () => {
    const legacy = setup();
    await legacy.h.close();
    const bots = new BotManager(legacy.config);
    let started = false;
    const app = await createApp(bots.get(), {
      bots,
      transcription: {
        async transcribe() {
          started = true;
          return new Promise(() => {});
        },
      },
    });
    cleanups.push(async () => {
      await app.close();
      await bots.close();
      rmSync(legacy.dir, { recursive: true, force: true });
    });
    const b = await app.inject({ url: "/bootstrap" });
    const headers = {
      cookie: `harness_session=${b.cookies[0]!.value}`,
      "x-local-token": b.json().csrfToken,
      "x-bot-id": "xiaotang",
    };
    const pending = app
      .inject({
        method: "POST",
        url: "/v1/transcriptions",
        headers,
        payload: {
          audio: audio.toString("base64"),
          mimeType: "audio/webm",
          expectedEpoch: 1,
        },
      })
      .then((r) => r);
    await until(() => started);
    await bots.archive("xiaotang");
    expect((await pending).statusCode).toBe(409);
    expect(bots.get().snapshot().messages).toHaveLength(0);
  });
});
