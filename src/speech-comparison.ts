import { z } from "zod";
import { FISH_VOICE_ID, type SpeechOptions } from "./speech.js";

export const COMPARISON_TEXT =
  "你回来啦，今天辛苦了。先歇一会儿吧，我在这里陪你，等你想说的时候，我们再慢慢聊。";
export const ComparisonId = z.enum([
  "s1-plain",
  "s1-soft",
  "s2-plain",
  "s2-soft",
]);
export const SPEECH_COMPARISONS = [
  { id: "s1-plain", name: "A · S1 · 原始语气", model: "s1", cue: "" },
  { id: "s1-soft", name: "B · S1 · 温柔语气", model: "s1", cue: "(soft tone)" },
  {
    id: "s2-plain",
    name: "C · S2.1-Pro · 原始语气",
    model: "s2.1-pro",
    cue: "",
  },
  {
    id: "s2-soft",
    name: "D · S2.1-Pro · 温柔语气",
    model: "s2.1-pro",
    cue: "[soft tone]",
  },
] as const;
export function comparison(id: unknown) {
  const value = ComparisonId.parse(id);
  return SPEECH_COMPARISONS.find((item) => item.id === value)!;
}
export function comparisonOptions(id: unknown): SpeechOptions {
  return {
    model: comparison(id).model,
    voiceId: FISH_VOICE_ID,
    temperature: 0.7,
    topP: 0.7,
  };
}
