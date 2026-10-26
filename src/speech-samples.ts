import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPARISON_TEXT, SPEECH_COMPARISONS } from "./speech-comparison.js";
import { FISH_VOICE_ID } from "./speech.js";

// Only explicitly generated, fixed diagnostic samples may be replayed here.
// No conversation text or arbitrary filesystem paths are accepted.
export function preparedSpeechSamples(dataDir: string) {
  try {
    const dir = join(dataDir, "reports", "voice-comparison");
    const report = JSON.parse(
      readFileSync(join(dir, "report.json"), "utf8"),
    ) as {
      passed: boolean;
      voiceId: string;
      text: string;
      results: {
        id: string;
        model: string;
        cue: string;
        passed: boolean;
        firstChunkMs: number;
        totalMs: number;
        bytes: number;
      }[];
    };
    if (
      !report.passed ||
      report.voiceId !== FISH_VOICE_ID ||
      report.text !== COMPARISON_TEXT
    )
      return [];
    return SPEECH_COMPARISONS.flatMap((v) => {
      const sample = report.results.find(
        (r) =>
          r.id === v.id && r.model === v.model && r.cue === v.cue && r.passed,
      );
      if (!sample) return [];
      const audio = readFileSync(join(dir, `${v.id}.mp3`));
      if (audio.length !== sample.bytes || audio.length > 10 * 1024 * 1024)
        return [];
      return [
        {
          id: v.id,
          url: `/v1/voice-comparison/samples/${v.id}`,
          audio,
          firstChunkMs: sample.firstChunkMs,
          totalMs: sample.totalMs,
        },
      ];
    });
  } catch {
    return [];
  }
}
