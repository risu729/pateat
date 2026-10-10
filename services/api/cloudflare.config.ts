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
      // The Access team domain (`<team>.cloudflareaccess.com`) and application
      // audience tag that guard /enroll and /manage. Unset values fail closed.
      ACCESS_TEAM_DOMAIN: bindings.secret(),
      ACCESS_AUD: bindings.secret(),
      // Bounds anonymous credential redemption per client address.
      REDEEM_LIMITER: bindings.rateLimit({
        namespace: "1001",
        simple: { limit: 10, period: 60 },
      }),
    },
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1, redactQueryString: true },
  },
});
