import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 12000,
    hookTimeout: 12000,
    fileParallelism: false,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/unit.json" },
  },
});
