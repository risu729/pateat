import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: "list",
  outputDir: "../../test-results/extension",
  timeout: 30_000,
  // TEMPORARY diagnostic.
  use: { trace: { mode: "retain-on-failure", screenshots: false, snapshots: true } },
});
