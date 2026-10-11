import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  // Browser Mode suites share this root; separate caches keep one suite's optimized
  // dependencies from making the next suite re-optimize and reload its page.
  cacheDir: "node_modules/.vite/options",
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/options/*.test.tsx"],
    fileParallelism: false,
    retry: 0,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
