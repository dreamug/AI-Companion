import { defineConfig } from "@playwright/test";

// Isolate this delivery regression run from other local feature test services.
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  outputDir: "./test-results/reply-presentation-artifacts",
  reporter: [
    ["list"],
    ["json", { outputFile: "data/reports/reply-presentation-browser.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4331",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4331",
    reuseExistingServer: false,
    env: {
      HARNESS_MODEL: "mock",
      HARNESS_DATA_DIR: `/tmp/aic-replies-web-${process.pid}`,
      PORT: "4331",
    },
    timeout: 30000,
  },
});
