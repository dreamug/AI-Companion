import { DomainError } from "./domain.js";
import type { AppConfig } from "./config.js";
import { abortable } from "./async.js";

export const FISH_VOICE_ID = "5b50d7ae59f24c0cb447599df8ae34ab";
export const FISH_VOICE_NAME = "甜妹";
export const VOICE_PREVIEW =
  "你好呀，我是小野。今天也会陪你聊聊天，一起把手边的事情慢慢做好。";
export const MAX_SPEECH_CHARS = 4000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export interface SpeechOptions {
  model: "s1" | "s2.1-pro";
  voiceId: string;
  temperature: number;
  topP: number;
}

export interface SpeechPort {
  stream(
    text: string,
    signal: AbortSignal,
    options?: SpeechOptions,
  ): AsyncIterable<Uint8Array>;
}

/** Provider errors and request headers stay inside this adapter. Audio is never persisted. */
export class FishAudioSpeech implements SpeechPort {
  constructor(
    private readonly config: AppConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.stream(text, signal))
      chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async *stream(
    text: string,
    signal: AbortSignal,
    options?: SpeechOptions,
  ): AsyncGenerator<Uint8Array> {
    if (!this.config.fishAudioApiKey)
      throw new DomainError("speech_key_missing", 503);
    if (!text.trim() || text.length > MAX_SPEECH_CHARS)
      throw new DomainError("speech_text_too_long", 400);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 45000);
    timeout.unref();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      combined.throwIfAborted();
      const response = await abortable(
        this.request(
          `${(this.config.fishAudioBaseURL ?? "https://api.fish.audio").replace(/\/$/, "")}/v1/tts`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${this.config.fishAudioApiKey}`,
              "Content-Type": "application/json",
              model: options?.model ?? this.config.fishAudioModel ?? "s2.1-pro",
            },
            body: JSON.stringify({
              text,
              reference_id:
                options?.voiceId ??
                this.config.fishAudioVoiceId ??
                FISH_VOICE_ID,
              temperature: options?.temperature ?? 0.7,
              top_p: options?.topP ?? 0.7,
              format: "mp3",
              mp3_bitrate: 128,
              normalize: true,
              chunk_length: 100,
              latency: "balanced",
              prosody: { speed: 1, volume: 0 },
            }),
            signal: combined,
          },
        ),
        combined,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code =
          response.status === 401 || response.status === 403
            ? "speech_authentication_failed"
            : response.status === 402
              ? "speech_balance_insufficient"
              : response.status === 429
                ? "speech_rate_limited"
                : "speech_provider_unavailable";
        throw new DomainError(code, 502);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !/^(audio\/(mpeg|mp3)|application\/octet-stream)(;|$)/i.test(
          contentType,
        )
      ) {
        void response.body?.cancel().catch(() => {});
        throw new DomainError("speech_invalid_audio", 502);
      }
      if (!response.body) throw new DomainError("speech_empty_audio", 502);
      let size = 0;
      let prefix = Buffer.alloc(0);
      let validated = false;
      const reader = response.body.getReader();
      let complete = false;
      try {
        while (true) {
          combined.throwIfAborted();
          const result = await abortable(reader.read(), combined);
          if (result.done) {
            complete = true;
            break;
          }
          size += result.value.byteLength;
          if (size > MAX_AUDIO_BYTES) {
            throw new DomainError("speech_audio_too_large", 502);
          }
          if (!result.value.byteLength) continue;
          if (!validated) {
            prefix = Buffer.concat([prefix, result.value]);
            // The HTTP transport can split even the MP3 signature across reads.
            if (prefix.length < 3) continue;
            if (!(
              prefix.subarray(0, 3).toString() === "ID3" ||
              (prefix[0] === 0xff && ((prefix[1] ?? 0) & 0xe0) === 0xe0)
            ))
              throw new DomainError("speech_invalid_audio", 502);
            validated = true;
            yield prefix;
            prefix = Buffer.alloc(0);
          } else yield result.value;
        }
      } finally {
        if (!complete) {
          controller.abort("reader_closed");
          void reader.cancel().catch(() => {});
        }
        reader.releaseLock();
      }
      combined.throwIfAborted();
      if (!size) throw new DomainError("speech_empty_audio", 502);
      if (!validated) throw new DomainError("speech_invalid_audio", 502);
    } catch (error) {
      if (signal.aborted) throw new DomainError("speech_cancelled", 409);
      if (controller.signal.reason === "timeout")
        throw new DomainError("speech_timeout", 504);
      if (error instanceof DomainError) throw error;
      throw new DomainError("speech_provider_unavailable", 502);
    } finally {
      clearTimeout(timeout);
    }
  }
}
