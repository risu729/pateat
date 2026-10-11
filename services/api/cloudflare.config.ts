import { PATEAT_EXTENSION_ID } from "@pateat/contracts/extension-id";
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
      // The owner web UI built from manage/index.html, read by the Worker after Access.
      ASSETS: bindings.assets(),
      // The Access team domain (`<team>.cloudflareaccess.com`) and application
      // audience tag that guard /pair, /enroll and /manage. Unset values fail closed.
      ACCESS_TEAM_DOMAIN: bindings.secret(),
      ACCESS_AUD: bindings.secret(),
      // The public origin (`https://<host>`) and ES256 key set of the OIDC issuer that
      // owners trust for Claude Workload Identity Federation. Unset values fail closed.
      OIDC_ISSUER: bindings.secret(),
      OIDC_SIGNING_KEYS: bindings.secret(),
      // Extension IDs allowed to pair (ADR 0020). Not a secret; a self-hosted extension
      // build with its own key lists its ID here instead. The contracts subpath export is
      // dependency-free, so loading this config does not pull in every schema.
      PAIRING_EXTENSION_IDS: bindings.json([PATEAT_EXTENSION_ID]),
      // Bounds pairing per signed-in identity.
      PAIR_LIMITER: bindings.rateLimit({ namespace: "1003", simple: { limit: 10, period: 60 } }),
      // Bounds anonymous credential redemption per client address.
      REDEEM_LIMITER: bindings.rateLimit({
        namespace: "1001",
        simple: { limit: 10, period: 60 },
      }),
      // Bounds device and web UI requests per owner (docs/architecture.md#service-limits).
      OWNER_LIMITER: bindings.rateLimit({
        namespace: "1002",
        simple: { limit: 120, period: 60 },
      }),
    },
    // Every request reaches the Worker first, so no built file skips the Access check.
    assets: { runWorkerFirst: true, htmlHandling: "none", notFoundHandling: "none" },
    // The only public host. Routine releases leave triggers alone; the bootstrap
    // applies this Custom Domain once (docs/delivery.md).
    domains: ["pateat.takuk.me"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1, redactQueryString: true },
  },
});
