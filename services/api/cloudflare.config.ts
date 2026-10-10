import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate, compatibilityFlags } from "./worker-runtime.ts";

export default defineConfig({
  worker: {
    name: "pateat-api",
    entrypoint,
    compatibilityDate,
    compatibilityFlags,
    // Declared for typed bindings only; the database is not provisioned yet.
    env: { DB: bindings.d1({ name: "pateat" }) },
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1, redactQueryString: true },
  },
});
