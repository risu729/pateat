import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare(), tailwindcss()],
  oxc: { jsx: { runtime: "automatic" } },
  environments: {
    // The owner web UI (manage/index.html) becomes the Worker's static assets, all
    // under /manage, with the notices of the dependencies it bundles.
    client: {
      build: {
        assetsDir: "manage/assets",
        license: { fileName: "manage/assets/licenses.md" },
        rollupOptions: { input: "manage/index.html" },
      },
    },
  },
  define: {
    PATEAT_BUILD_REVISION: JSON.stringify(process.env["PATEAT_REVISION"] ?? "development"),
  },
});
