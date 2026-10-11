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
      // Bootstrapped on 2026-10-11. The ID keeps cf deploy from provisioning another
      // database; the release applies committed migrations to exactly this one.
      DB: bindings.d1({ name: "pateat", id: "68342d29-6704-464c-bdb2-b749812c1f19" }),
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
    // The only public host. Routine releases leave triggers alone; the bootstrap
    // applies this Custom Domain once (docs/delivery.md).
    domains: ["pateat.takuk.me"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1, redactQueryString: true },
  },
});
