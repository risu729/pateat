import { defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "pateat-docs",
    compatibilityDate: "2026-11-04",
    // This Worker has no entrypoint, secrets, or service/data bindings. The pages sit in
    // the assets' `docs/` directory, so they serve at `/docs/` without an asset base path,
    // which this account does not offer (API error 100343).
    assets: { notFoundHandling: "404-page" },
    // Pin takuk.me by ID so route reconciliation does not need zone-name lookup.
    triggers: [
      triggers.fetch({ pattern: "pateat.takuk.me/docs", zone: "e5f785a1c55a37a4b7c65ee832002237" }),
      triggers.fetch({
        pattern: "pateat.takuk.me/docs/*",
        zone: "e5f785a1c55a37a4b7c65ee832002237",
      }),
    ],
    workersDev: false,
    previewUrls: false,
    observability: { logs: { enabled: true }, traces: { enabled: true } },
  },
});
