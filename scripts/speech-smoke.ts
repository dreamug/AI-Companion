import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  FishAudioSpeech,
  FISH_VOICE_ID,
  FISH_VOICE_NAME,
  VOICE_PREVIEW,
} from "../src/speech.js";
import { DomainError } from "../src/domain.js";
const config = loadConfig(),
  dir = join(config.dataDir, "reports");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const started = Date.now();
try {
  const chunks: Buffer[] = [];
  let firstChunkMs: number | null = null;
  for await (const chunk of new FishAudioSpeech(config).stream(
    VOICE_PREVIEW,
    AbortSignal.timeout(50000),
  )) {
    firstChunkMs ??= Date.now() - started;
    chunks.push(Buffer.from(chunk));
  }
  const audio = Buffer.concat(chunks);
  const report = {
    at: new Date().toISOString(),
    provider: "fish-audio",
    model: config.fishAudioModel,
    voiceId: config.fishAudioVoiceId ?? FISH_VOICE_ID,
    voiceName: FISH_VOICE_NAME,
    transport: "http-streaming",
    firstChunkMs,
    chunks: chunks.length,
    scope: "fixed_synthetic_preview",
    passed: true,
    bytes: audio.length,
    elapsedMs: Date.now() - started,
    audioFile: "voice-preview.mp3",
    costCny: null,
  };
  writeFileSync(join(dir, "voice-preview.mp3"), audio, { mode: 0o600 });
  writeFileSync(
    join(dir, "speech-smoke.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(
    JSON.stringify({
      passed: false,
      error: error instanceof DomainError ? error.code : "speech_test_failed",
    }),
  );
  process.exitCode = 1;
}
