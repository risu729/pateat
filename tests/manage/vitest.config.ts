import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  // Browser Mode suites share this root; separate caches keep one suite's optimized
  // dependencies from making the next suite re-optimize and reload its page.
  cacheDir: "node_modules/.vite/manage",
  oxc: { jsx: { runtime: "automatic" } },
  define: { PATEAT_BUILD_REVISION: JSON.stringify("test-revision") },
  test: {
    include: ["tests/manage/*.test.tsx"],
    fileParallelism: false,
    retry: 0,
    // Set by CI's Verify job; `mise run coverage:summary` reports the result.
    coverage: {
      enabled: Boolean(process.env["PATEAT_COVERAGE"]),
      include: ["services/api/web/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/__fixtures__/**", "**/vitest.*.ts"],
      reporter: ["json"],
      reportsDirectory: "coverage/manage",
    },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
