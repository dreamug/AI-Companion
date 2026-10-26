import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { FishAudioTranscription, ASR_MODEL } from "../src/transcription.js";
import { LocalTranscription } from "../src/local-transcription.js";
import { DomainError } from "../src/domain.js";
import { writePrivateJson } from "../src/files.js";

// The existing retained TTS preview is fixed synthetic speech, never a microphone recording.
const config = loadConfig();
const local = config.transcriptionMode === "local";
const audio = readFileSync(resolve("data/reports/voice-preview.mp3"));
const start = Date.now();
let report: Record<string, unknown>;
try {
  const result = await (
    local ? new LocalTranscription(config) : new FishAudioTranscription(config)
  ).transcribe(audio, "audio/mpeg", AbortSignal.timeout(50000));
  report = {
    at: new Date().toISOString(),
    scope: "fixed_synthetic_tts_preview_to_real_asr_no_user_audio",
    model: local ? "local-whisper-large-v3-turbo" : ASR_MODEL,
    passed: result.text.length > 0,
    text: result.text,
    duration: result.duration,
    elapsedMs: Date.now() - start,
    bytes: audio.length,
    audioPersisted: false,
  };
} catch (e) {
  report = {
    at: new Date().toISOString(),
    scope: "fixed_synthetic_tts_preview_to_real_asr_no_user_audio",
    model: local ? "local-whisper-large-v3-turbo" : ASR_MODEL,
    passed: false,
    error: e instanceof DomainError ? e.code : "smoke_failed",
  };
  process.exitCode = 1;
}
mkdirSync(resolve("data/reports"), { recursive: true, mode: 0o700 });
writePrivateJson(
  resolve(`data/reports/voice-input-${local ? "local-" : ""}live.json`),
  report,
);
console.log(JSON.stringify(report));
