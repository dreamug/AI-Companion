import type { AppConfig } from "../config.js";

/** The accepted memory baseline for the regular bot entry point.
 * Existing stores require an explicit offline migration; construction never upgrades them. */
export function stableMemoryConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    memoryV3: true,
    memoryV2: true,
    memoryFastPath: true,
    memoryReplyGuard: true,
    memoryAnswerReasoning: false,
    memoryFactsModel: undefined,
    memoryVectors: false,
    memorySummaries: false,
    conversationExperiment: false,
  };
}
