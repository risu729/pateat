import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: ({ mode }) => ({
    name: "Pateat",
    description: "Local login assistant — foundation preview. Login is not implemented.",
    minimum_chrome_version: "120",
    action: { default_title: "Open Pateat settings" },
    permissions: ["storage"],
    // Content-script matches do not grant access to tabs.Tab.url. The synthetic
    // coordinator needs that browser-provided URL for its fail-closed recheck.
    ...(mode === "probe" ? { host_permissions: ["http://127.0.0.1/*"] } : {}),
  }),
  hooks: {
    "entrypoints:found"(wxt, entrypoints) {
      // These scripts are compatibility experiments, never production features.
      if (wxt.config.mode !== "probe") return;
      for (const name of ["probe-main", "probe-isolated", "login-probe"]) {
        entrypoints.push({
          name,
          inputPath: fileURLToPath(
            new URL(`../../tests/extension/fixtures/${name}.content.ts`, import.meta.url),
          ),
          type: "content-script",
        });
      }
    },
  },
});
