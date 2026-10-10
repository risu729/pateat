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
        // Synthetic Access settings; tests serve their own signing keys.
        bindings: {
          TEST_MIGRATIONS: migrations,
          ACCESS_TEAM_DOMAIN: "pateat-test.cloudflareaccess.com",
          ACCESS_AUD: "pateat-test-audience",
        },
        ratelimits: { REDEEM_LIMITER: { namespace_id: "1001", simple: { limit: 10, period: 60 } } },
      },
    }),
  ],
  define: { PATEAT_BUILD_REVISION: JSON.stringify("test-revision") },
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
});
