import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { DomainError } from "./domain.js";
import {
  MAX_RECORDING_SECONDS,
  validateRecording,
  type TranscriptionPort,
  type Transcript,
} from "./transcription.js";

export function localAsrConfigured(config: AppConfig): boolean {
  return Boolean(
    config.localAsrPython &&
    existsSync(config.localAsrPython) &&
    config.localAsrFfmpeg &&
    existsSync(config.localAsrFfmpeg) &&
    config.localAsrModel &&
    existsSync(join(config.localAsrModel, "config.json")) &&
    ["weights.npz", "weights.safetensors"].some((name) =>
      existsSync(join(config.localAsrModel!, name)),
    ),
  );
}

/** A short-lived process owns audio and model state. Pipes only; no audio files. */
export class LocalTranscription implements TranscriptionPort {
  readonly remote = false;
  constructor(
    private readonly config: AppConfig,
    private readonly runner = fileURLToPath(
      new URL("../scripts/local-asr.py", import.meta.url),
    ),
  ) {}

  async transcribe(
    audio: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<Transcript> {
    validateRecording(audio, mimeType);
    if (signal.aborted) throw new DomainError("transcription_cancelled", 409);
    if (!localAsrConfigured(this.config))
      throw new DomainError("transcription_local_unavailable", 503);
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.config.localAsrPython!,
        [this.runner, this.config.localAsrModel!, this.config.localAsrFfmpeg!],
        {
          stdio: ["pipe", "pipe", "ignore"],
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            TOKENIZERS_PARALLELISM: "false",
          },
        },
      );
      let settled = false,
        closed = false,
        size = 0;
      const chunks: Buffer[] = [];
      const stop = () => {
        if (closed) return;
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      const finish = (error?: DomainError, result?: Transcript) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancelled);
        stop();
        chunks.length = 0;
        if (error) reject(error);
        else resolve(result!);
      };
      const cancelled = () =>
        finish(new DomainError("transcription_cancelled", 409));
      const timer = setTimeout(
        () => finish(new DomainError("transcription_timeout", 504)),
        45000,
      );
      timer.unref();
      signal.addEventListener("abort", cancelled, { once: true });
      child.on("error", () =>
        finish(new DomainError("transcription_local_unavailable", 503)),
      );
      child.stdin.on("error", () => {});
      child.stdout.on("data", (data: Buffer) => {
        if (settled) return;
        size += data.length;
        if (size > 128 * 1024)
          finish(new DomainError("transcription_invalid_response", 502));
        else chunks.push(data);
      });
      child.on("close", (code) => {
        closed = true;
        if (settled) return;
        if (code !== 0) {
          finish(
            new DomainError(
              code === 2
                ? "recording_invalid_audio"
                : code === 3
                  ? "recording_too_long"
                  : "transcription_local_unavailable",
              code === 2 || code === 3 ? 422 : 503,
            ),
          );
          return;
        }
        try {
          const value = z
            .object({
              text: z.string().max(12000),
              duration: z
                .number()
                .finite()
                .nonnegative()
                .max(MAX_RECORDING_SECONDS + 2),
            })
            .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const text = value.text.trim();
          if (!text) finish(new DomainError("transcription_no_speech", 422));
          else finish(undefined, { text, duration: value.duration });
        } catch {
          finish(new DomainError("transcription_invalid_response", 502));
        }
      });
      if (signal.aborted) cancelled();
      else child.stdin.end(audio);
    });
  }
}
