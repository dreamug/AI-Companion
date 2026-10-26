import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 30000,
  outputDir: "./test-results/voice-input-artifacts",
  reporter: [
    ["list"],
    ["json", { outputFile: "data/reports/voice-input-browser.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4331",
    viewport: { width: 1280, height: 1000 },
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    permissions: ["microphone"],
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4331",
    reuseExistingServer: false,
    env: {
      HARNESS_MODEL: "mock",
      HARNESS_DATA_DIR: `/tmp/aic-voice-input-web-${process.pid}`,
      PORT: "4331",
    },
    timeout: 30000,
  },
});
