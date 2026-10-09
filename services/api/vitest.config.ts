import { fileURLToPath, URL } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import config from "./cloudflare.config.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      miniflare: {
        compatibilityDate: config.worker.compatibilityDate,
        compatibilityFlags: config.worker.compatibilityFlags,
      },
    }),
  ],
  define: { PATEAT_BUILD_REVISION: JSON.stringify("test-revision") },
  test: { include: ["test/**/*.test.ts"] },
});
