import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/memory-browser",
  outputDir: "test-results/memory-artifacts",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/memory-browser.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4320",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx tsx scripts/memory-browser-fixture.ts",
    url: "http://127.0.0.1:4320",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
