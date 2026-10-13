import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Page-reading code (the observation extractor and the executor's element lookup)
// depends on layout and computed styles, so it is tested in Chromium. Diagnostics use
// Chromium's IndexedDB and WebCrypto; the vault and session stores' `*.browser.test.ts`
// suites run their native transactions there too.
export default defineConfig({
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  // Browser Mode suites share this root; separate caches keep one suite's optimized
  // dependencies from making the next suite re-optimize and reload its page.
  cacheDir: "node_modules/.vite/extension-dom",
  // Pre-bundle up front; a mid-run optimization reloads the test page.
  optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "valibot", "xstate"] },
  test: {
    include: [
      "apps/extension/src/{diagnostics,observation,page}/*.test.ts",
      "apps/extension/src/{connections,vault}/*.browser.test.ts",
    ],
    retry: 0,
    // Set by CI's Verify job; `mise run coverage:summary` reports the result.
    coverage: {
      enabled: Boolean(process.env["PATEAT_COVERAGE"]),
      include: ["apps/extension/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/__fixtures__/**", "**/vitest.*.ts"],
      reporter: ["json"],
      reportsDirectory: "coverage/extension-dom",
    },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
