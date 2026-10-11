import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate, compatibilityFlags } from "./worker-runtime.ts";

export default defineConfig({
  worker: {
    name: "pateat-api",
    entrypoint,
    compatibilityDate,
    compatibilityFlags,
    env: {
      // Declared for typed bindings only; the database is not provisioned yet.
      DB: bindings.d1({ name: "pateat" }),
      // The owner web UI built from manage/index.html, read by the Worker after Access.
      ASSETS: bindings.assets(),
      // The Access team domain (`<team>.cloudflareaccess.com`) and application
      // audience tag that guard /enroll and /manage. Unset values fail closed.
      ACCESS_TEAM_DOMAIN: bindings.secret(),
      ACCESS_AUD: bindings.secret(),
      // The public origin (`https://<host>`) and ES256 key set of the OIDC issuer that
      // owners trust for Claude Workload Identity Federation. Unset values fail closed.
      OIDC_ISSUER: bindings.secret(),
      OIDC_SIGNING_KEYS: bindings.secret(),
      // Bounds anonymous credential redemption per client address.
      REDEEM_LIMITER: bindings.rateLimit({
        namespace: "1001",
        simple: { limit: 10, period: 60 },
      }),
    },
    // Every request reaches the Worker first, so no built file skips the Access check.
    assets: { runWorkerFirst: true, htmlHandling: "none", notFoundHandling: "none" },
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1, redactQueryString: true },
  },
});
