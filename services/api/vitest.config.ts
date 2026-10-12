import { fileURLToPath, URL } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { compatibilityDate, compatibilityFlags } from "./worker-runtime.ts";

const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

// A synthetic ES256 issuer key generated per run; it never signs for a real organization.
const issuerKey = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const { kty, crv, x, y, d } = (await crypto.subtle.exportKey(
  "jwk",
  issuerKey.privateKey,
)) as JsonWebKey;
const oidcSigningKeys = JSON.stringify({
  signingKeyId: "test-2026-10",
  keys: [{ kty, crv, alg: "ES256", kid: "test-2026-10", x, y, d }],
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // Local Miniflare storage only; tests never touch a provisioned database.
        d1Databases: ["DB"],
        // A stand-in for the built web UI, so tests do not depend on a client build.
        assets: {
          directory: fileURLToPath(new URL("./test/fixtures/assets", import.meta.url)),
          binding: "ASSETS",
          routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true },
        },
        // Synthetic Access settings; tests serve their own signing keys.
        bindings: {
          TEST_MIGRATIONS: migrations,
          ACCESS_TEAM_DOMAIN: "pateat-test.cloudflareaccess.com",
          ACCESS_AUD: "pateat-test-audience",
          // The synthetic "pateat pair" application's audience (ADR 0030).
          ACCESS_PAIR_AUD: "pateat-test-pair-audience",
          OIDC_ISSUER: "https://pateat.invalid",
          OIDC_SIGNING_KEYS: oidcSigningKeys,
          // A synthetic extension ID; Pateat's own is listed only in production.
          PAIRING_EXTENSION_IDS: ["abcdefghijklmnopabcdefghijklmnop"],
        },
        ratelimits: {
          OWNER_LIMITER: { namespace_id: "1002", simple: { limit: 120, period: 60 } },
          PAIR_LIMITER: { namespace_id: "1003", simple: { limit: 10, period: 60 } },
        },
      },
    }),
  ],
  define: { PATEAT_BUILD_REVISION: JSON.stringify("test-revision") },
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
});
