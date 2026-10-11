import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Page-reading code (the observation extractor and the executor's element lookup)
// depends on layout and computed styles, so it is tested in Chromium.
export default defineConfig({
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  // Browser Mode suites share this root; separate caches keep one suite's optimized
  // dependencies from making the next suite re-optimize and reload its page.
  cacheDir: "node_modules/.vite/extension-dom",
  // Pre-bundle up front; a mid-run optimization reloads the test page.
  optimizeDeps: { include: ["valibot", "xstate"] },
  test: {
    include: ["apps/extension/src/{observation,page}/*.test.ts"],
    retry: 0,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
