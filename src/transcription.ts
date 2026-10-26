import { z } from "zod";
import type { AppConfig } from "./config.js";
import { DomainError } from "./domain.js";
import { abortable } from "./async.js";

export const MAX_RECORDING_SECONDS = 60;
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;
export const ASR_MODEL = "transcribe-1-pro";
export const RecordingSchema = z
  .object({
    audio: z
      .string()
      .min(1)
      .max(4 * Math.ceil(MAX_RECORDING_BYTES / 3)),
    mimeType: z.enum([
      "audio/webm",
      "audio/ogg",
      "audio/mp4",
      "audio/wav",
      "audio/mpeg",
    ]),
    expectedEpoch: z.number().int().positive(),
  })
  .strict();

export type Transcript = { text: string; duration: number };
export interface TranscriptionPort {
  readonly remote?: boolean;
  transcribe(
    audio: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<Transcript>;
}

export function validateRecording(audio: Uint8Array, mimeType: string): void {
  if (audio.byteLength > MAX_RECORDING_BYTES)
    throw new DomainError("recording_too_large", 413);
  const b = Buffer.from(audio);
  const format =
    mimeType === "audio/webm"
      ? b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : mimeType === "audio/ogg"
        ? b.subarray(0, 4).toString() === "OggS"
        : mimeType === "audio/mp4"
          ? b.subarray(4, 8).toString() === "ftyp"
          : mimeType === "audio/wav"
            ? b.subarray(0, 4).toString() === "RIFF" &&
              b.subarray(8, 12).toString() === "WAVE"
            : mimeType === "audio/mpeg"
              ? b.subarray(0, 3).toString() === "ID3" ||
                (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)
              : false;
  if (b.length < 12 || !format)
    throw new DomainError("recording_invalid_audio", 400);
}

export function decodeRecording(encoded: string, mimeType: string): Buffer {
  if (encoded.length > 4 * Math.ceil(MAX_RECORDING_BYTES / 3))
    throw new DomainError("recording_too_large", 413);
  const audio = Buffer.from(encoded, "base64");
  if (encoded.length % 4 !== 0 || audio.toString("base64") !== encoded)
    throw new DomainError("recording_invalid_audio", 400);
  validateRecording(audio, mimeType);
  return audio;
}

/** Audio and provider response bodies remain transient, outside model memory and logs. */
export class FishAudioTranscription implements TranscriptionPort {
  readonly remote = true;
  constructor(
    private readonly config: AppConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<Transcript> {
    if (!this.config.fishAudioApiKey)
      throw new DomainError("transcription_key_missing", 503);
    validateRecording(audio, mimeType);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort("timeout"), 45000);
    timer.unref();
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      combined.throwIfAborted();
      const extension =
        mimeType === "audio/mp4" ? "m4a" : mimeType.split("/")[1];
      const form = new FormData();
      form.append(
        "audio",
        new Blob([Buffer.from(audio)], { type: mimeType }),
        `recording.${extension}`,
      );
      form.append("language", "zh");
      form.append("ignore_timestamps", "true");
      form.append("tag_audio_events", "false");
      form.append("diarize", "false");
      const response = await abortable(
        this.request(
          `${(this.config.fishAudioBaseURL ?? "https://api.fish.audio").replace(/\/$/, "")}/v1/asr`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${this.config.fishAudioApiKey}`,
              model: ASR_MODEL,
            },
            body: form,
            signal: combined,
          },
        ),
        combined,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code =
          response.status === 401 || response.status === 403
            ? "transcription_authentication_failed"
            : response.status === 402
              ? "transcription_balance_insufficient"
              : response.status === 429
                ? "transcription_rate_limited"
                : response.status === 400 || response.status === 415
                  ? "recording_invalid_audio"
                  : "transcription_provider_unavailable";
        throw new DomainError(code, 502);
      }
      if (!response.body)
        throw new DomainError("transcription_invalid_response", 502);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await abortable(reader.read(), combined);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 128 * 1024)
            throw new DomainError("transcription_invalid_response", 502);
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        void reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {}
      }
      const parsed = z
        .object({
          text: z.string().max(16000),
          duration: z.number().finite().nonnegative(),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const text = parsed.text.replace(/<\|speaker:\d+\|>/g, "").trim();
      if (!text) throw new DomainError("transcription_no_speech", 422);
      if (text.length > 12000)
        throw new DomainError("transcription_text_too_long", 422);
      if (parsed.duration > MAX_RECORDING_SECONDS + 2)
        throw new DomainError("recording_too_long", 422);
      return { text, duration: parsed.duration };
    } catch (error) {
      if (combined.aborted)
        throw new DomainError(
          deadline.signal.aborted
            ? "transcription_timeout"
            : "transcription_cancelled",
          deadline.signal.aborted ? 504 : 409,
        );
      if (error instanceof DomainError) throw error;
      // No raw provider exception: it may contain audio, credentials or private transcript.
      throw new DomainError("transcription_provider_unavailable", 502);
    } finally {
      clearTimeout(timer);
      deadline.abort("finished");
    }
  }
}
