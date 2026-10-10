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
    permissions: ["storage", "offscreen"],
    // Self-hosted provider origins are selected at setup. Only that connection's
    // canonical HTTPS hosts are requested from the user's setup gesture.
    optional_host_permissions: ["https://*/*"],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https:",
    },
    // Content-script matches do not grant access to tabs.Tab.url. The synthetic
    // coordinator needs that browser-provided URL for its fail-closed recheck.
    ...(mode === "probe"
      ? {
          host_permissions: ["http://127.0.0.1/*"],
        }
      : {}),
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
      entrypoints.push({
        name: "crypto-probe",
        inputPath: fileURLToPath(new URL("./probes/crypto/index.html", import.meta.url)),
        type: "unlisted-page",
      });
    },
  },
});
