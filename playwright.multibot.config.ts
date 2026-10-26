import { defineConfig } from "@playwright/test";

// A separate service/port and reports keep parallel local work from erasing evidence.
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "web.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  outputDir: "./test-results/multibot-artifacts",
  reporter: [["list"], ["json", { outputFile: "data/reports/multibot-browser.json" }]],
  use: {
    baseURL: "http://127.0.0.1:4328",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4328",
    reuseExistingServer: false,
    env: {
      HARNESS_MODEL: "mock",
      HARNESS_DATA_DIR: `/tmp/aic-multibot-web-${process.pid}`,
      PORT: "4328",
    },
    timeout: 30000,
  },
});
