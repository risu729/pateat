import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// The extractor depends on layout and computed styles, so it is tested in Chromium.
export default defineConfig({
  root: fileURLToPath(new URL("../../../../", import.meta.url)),
  // Pre-bundle up front; a mid-run optimization reloads the test page.
  optimizeDeps: { include: ["valibot", "xstate"] },
  test: {
    include: ["apps/extension/src/observation/*.test.ts"],
    retry: 0,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
