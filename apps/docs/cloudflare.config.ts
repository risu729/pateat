import { defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "pateat-docs",
    compatibilityDate: "2026-11-04",
    // This Worker has no entrypoint, secrets, or service/data bindings.
    assets: { basePath: "/docs", notFoundHandling: "404-page" },
    triggers: [
      triggers.fetch({ pattern: "pateat.takuk.me/docs", zone: "takuk.me" }),
      triggers.fetch({ pattern: "pateat.takuk.me/docs/*", zone: "takuk.me" }),
    ],
    workersDev: false,
    previewUrls: false,
    observability: { logs: { enabled: true }, traces: { enabled: true } },
  },
});
