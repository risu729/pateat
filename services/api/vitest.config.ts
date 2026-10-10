import { fileURLToPath, URL } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { compatibilityDate, compatibilityFlags } from "./worker-runtime.ts";

const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // Local Miniflare storage only; tests never touch a provisioned database.
        d1Databases: ["DB"],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  define: { PATEAT_BUILD_REVISION: JSON.stringify("test-revision") },
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
});
