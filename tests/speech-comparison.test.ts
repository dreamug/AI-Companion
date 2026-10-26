import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { setup } from "./helpers.js";
import {
  COMPARISON_TEXT,
  SPEECH_COMPARISONS,
  comparisonOptions,
} from "../src/speech-comparison.js";
import {
  FishAudioSpeech,
  FISH_VOICE_ID,
  type SpeechOptions,
} from "../src/speech.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const audio = Buffer.from("ID3-synthetic-comparison");
async function fixture() {
  const x = setup({
    config: {
      fishAudioModel: "s1",
      fishAudioVoiceId: "other-chat-voice",
      fishAudioApiKey: "synthetic-secret",
    },
  });
  const calls: { text: string; options?: SpeechOptions }[] = [];
  const app = await createApp(x.h, {
    speech: {
      async *stream(text, _signal, options) {
        calls.push({ text, options });
        yield audio;
      },
    },
  });
  cleanups.push(async () => {
    await app.close();
    await x.dispose();
  });
  const boot = await app.inject("/bootstrap");
  const headers = {
    cookie: `harness_session=${boot.cookies[0]!.value}`,
    "X-Local-Token": boot.json().csrfToken,
  };
  return { ...x, app, headers, calls };
}
describe("独立四组语音试听", () => {
  it("固定同音色同正文，四种组合与模型语法对应且互不写配置", async () => {
    const x = await fixture();
    const before = JSON.stringify(x.store.settings());
    const metadata = await x.app.inject({
      url: "/v1/voice-comparison",
      headers: x.headers,
    });
    expect(metadata.json()).toMatchObject({
      voiceId: FISH_VOICE_ID,
      text: COMPARISON_TEXT,
      variants: SPEECH_COMPARISONS,
    });
    expect(metadata.body).not.toContain("synthetic-secret");
    for (const variant of SPEECH_COMPARISONS) {
      const response = await x.app.inject({
        method: "POST",
        url: "/v1/voice-comparison/speech",
        headers: x.headers,
        payload: {
          variantId: variant.id,
          expectedEpoch: x.store.settings().epoch,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(audio);
      expect(response.headers["x-speech-first-chunk-ms"]).toBeDefined();
      expect(x.calls.at(-1)).toEqual({
        text: variant.cue + COMPARISON_TEXT,
        options: {
          model: variant.model,
          voiceId: FISH_VOICE_ID,
          temperature: 0.7,
          topP: 0.7,
        },
      });
    }
    expect(JSON.stringify(x.store.settings())).toBe(before);
    expect(x.config.fishAudioModel).toBe("s1");
    expect(x.config.fishAudioVoiceId).toBe("other-chat-voice");
    expect(x.store.list("messages")).toHaveLength(0);
  });
  it("cookie和CSRF生效；不接受前端任意文本、模型或音色覆盖", async () => {
    const x = await fixture();
    expect((await x.app.inject("/v1/voice-comparison")).statusCode).toBe(401);
    const payload = {
      variantId: "s1-plain",
      expectedEpoch: x.store.settings().epoch,
    };
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/voice-comparison/speech",
          headers: { cookie: x.headers.cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    for (const change of [
      { variantId: "unknown" },
      { text: "private" },
      { model: "drama-3" },
      { voiceId: "other" },
      { expectedEpoch: payload.expectedEpoch + 1 },
    ])
      expect(
        (
          await x.app.inject({
            method: "POST",
            url: "/v1/voice-comparison/speech",
            headers: x.headers,
            payload: { ...payload, ...change },
          })
        ).statusCode,
      ).not.toBe(200);
    expect(x.calls).toHaveLength(0);
    expect(
      (
        await x.app.inject({
          method: "POST",
          url: "/v1/speech",
          headers: x.headers,
          payload: {
            kind: "comparison",
            variantId: "s1-plain",
            expectedEpoch: payload.expectedEpoch,
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("逐次模型覆盖通过同一HTTP Streaming适配器发送，不修改默认值", async () => {
    const x = setup({
      config: {
        fishAudioApiKey: "synthetic",
        fishAudioModel: "s1",
        fishAudioVoiceId: "chat-voice",
      },
    });
    cleanups.push(x.dispose);
    const requests: RequestInit[] = [];
    const provider = new FishAudioSpeech(x.config, (async (_url, options) => {
      requests.push(options!);
      return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch);
    for (const variant of SPEECH_COMPARISONS) {
      const chunks = [];
      for await (const chunk of provider.stream(
        variant.cue + COMPARISON_TEXT,
        AbortSignal.timeout(1000),
        comparisonOptions(variant.id),
      ))
        chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(audio);
      const request = requests.at(-1)!;
      expect(request.headers).toMatchObject({ model: variant.model });
      expect(JSON.parse(String(request.body))).toMatchObject({
        reference_id: FISH_VOICE_ID,
        text: variant.cue + COMPARISON_TEXT,
        temperature: 0.7,
        top_p: 0.7,
        latency: "balanced",
        chunk_length: 100,
        prosody: { speed: 1, volume: 0 },
      });
    }
    await provider.synthesize("合成", AbortSignal.timeout(1000));
    expect(requests.at(-1)!.headers).toMatchObject({ model: "s1" });
    expect(JSON.parse(String(requests.at(-1)!.body))).toMatchObject({
      reference_id: "chat-voice",
    });
  });
  it("仅通过已认证路由提供匹配本次实验的固定样本，失配时拒绝旧音频", async () => {
    const x = await fixture();
    const dir = join(x.dir, "reports", "voice-comparison");
    mkdirSync(dir, { recursive: true });
    const report = {
      passed: true,
      voiceId: FISH_VOICE_ID,
      text: COMPARISON_TEXT,
      results: SPEECH_COMPARISONS.map((v) => ({
        ...v,
        passed: true,
        bytes: audio.length,
        firstChunkMs: 100,
        totalMs: 200,
      })),
    };
    for (const variant of SPEECH_COMPARISONS)
      writeFileSync(join(dir, `${variant.id}.mp3`), audio);
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    expect(
      (await x.app.inject("/v1/voice-comparison/samples/s1-plain")).statusCode,
    ).toBe(401);
    const meta = await x.app.inject({
      url: "/v1/voice-comparison",
      headers: x.headers,
    });
    expect(meta.json().preparedSamples).toHaveLength(4);
    expect(meta.json().preparedSamples[0]).not.toHaveProperty("audio");
    const sample = await x.app.inject({
      url: "/v1/voice-comparison/samples/s1-plain",
      headers: x.headers,
    });
    expect(sample.rawPayload).toEqual(audio);
    expect(sample.headers["cache-control"]).toBe("no-store");
    expect(x.calls).toHaveLength(0);
    writeFileSync(
      join(dir, "report.json"),
      JSON.stringify({ ...report, text: "过期样本" }),
    );
    expect(
      (
        await x.app.inject({
          url: "/v1/voice-comparison/samples/s1-plain",
          headers: x.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
});
