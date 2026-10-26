import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "test-results/browser-artifacts",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [["list"], ["json", { outputFile: "test-results/browser.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4319",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4319",
    reuseExistingServer: false,
    env: {
      HARNESS_MODEL: "mock",
      HARNESS_DATA_DIR: `/tmp/aic-harness-playwright-${process.pid}`,
      PORT: "4319",
    },
    timeout: 30000,
  },
});
