import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Pateat",
    description: "Local login assistant — foundation preview. Login is not implemented.",
    minimum_chrome_version: "120",
    action: { default_title: "Open Pateat settings" },
    permissions: ["storage"],
  },
  hooks: {
    "entrypoints:found"(wxt, entrypoints) {
      // These scripts are compatibility experiments, never production features.
      if (wxt.config.mode !== "probe") return;
      for (const name of ["probe-main", "probe-isolated"]) {
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
