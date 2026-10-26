import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { FishAudioSpeech } from "../src/speech.js";
import {
  COMPARISON_TEXT,
  SPEECH_COMPARISONS,
  comparisonOptions,
} from "../src/speech-comparison.js";
import { DomainError } from "../src/domain.js";
const config = loadConfig();
const dir = join(config.dataDir, "reports", "voice-comparison");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const provider = new FishAudioSpeech(config);
const results = [];
for (const variant of SPEECH_COMPARISONS) {
  const started = performance.now();
  let firstChunkMs: number | null = null;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of provider.stream(
      variant.cue + COMPARISON_TEXT,
      AbortSignal.timeout(50000),
      comparisonOptions(variant.id),
    )) {
      firstChunkMs ??= Math.round(performance.now() - started);
      chunks.push(Buffer.from(chunk));
    }
    const audio = Buffer.concat(chunks);
    writeFileSync(join(dir, `${variant.id}.mp3`), audio, { mode: 0o600 });
    results.push({
      ...variant,
      passed: true,
      firstChunkMs,
      totalMs: Math.round(performance.now() - started),
      chunks: chunks.length,
      bytes: audio.length,
    });
  } catch (error) {
    results.push({
      ...variant,
      passed: false,
      error: error instanceof DomainError ? error.code : "comparison_failed",
    });
  }
}
const report = {
  at: new Date().toISOString(),
  scope: "fixed_synthetic_text",
  text: COMPARISON_TEXT,
  voiceId: comparisonOptions("s1-plain").voiceId,
  transport: "http-streaming",
  passed: results.every((r) => r.passed),
  results,
};
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
