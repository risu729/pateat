import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

/** CI sets PATEAT_REVISION, as for the service; a local build reads its own checkout. */
function buildRevision(): string {
  const configured = process.env["PATEAT_REVISION"];
  if (configured) return configured;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "development";
  }
}

/** The SDK version the bundled Bitwarden package pins, shown on the diagnostics page. */
function bitwardenSdkVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../packages/bitwarden/package.json", import.meta.url), "utf8"),
  );
  const version = (manifest as { dependencies?: Record<string, string> }).dependencies?.[
    "@bitwarden/sdk-internal"
  ];
  if (!version) throw new Error("Missing @bitwarden/sdk-internal dependency");
  return version;
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      PATEAT_BUILD_REVISION: JSON.stringify(buildRevision()),
      PATEAT_BITWARDEN_SDK_VERSION: JSON.stringify(bitwardenSdkVersion()),
    },
  }),
  manifest: ({ mode }) => ({
    name: "Pateat",
    description: "Local login assistant — foundation preview. Login is not implemented.",
    minimum_chrome_version: "120",
    action: {
      default_title: "Open Pateat settings",
      // Until the worker reads the vault records, show the locked icon.
      default_icon: { 16: "icon-locked/16.png", 32: "icon-locked/32.png" },
    },
    permissions: ["storage", "offscreen"],
    // Owner-approved install-time HTTPS site access (ADR 0009). The login content script
    // runs on every HTTPS page; only non-excluded sites with a cached recipe can execute.
    // Chrome can still re-request these hosts if the user withholds site access, so no
    // redundant optional entry is declared.
    host_permissions: ["https://*/*"],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https:",
    },
    // Content-script matches do not grant access to tabs.Tab.url. The synthetic
    // coordinator needs that browser-provided URL for its fail-closed recheck.
    ...(mode === "probe"
      ? {
          host_permissions: ["https://*/*", "http://127.0.0.1/*"],
        }
      : {}),
  }),
  hooks: {
    "entrypoints:found"(wxt, entrypoints) {
      // These scripts are compatibility experiments, never production features.
      if (wxt.config.mode !== "probe") return;
      for (const name of [
        "probe-main",
        "probe-isolated",
        "login-probe",
        "passkey-probe-main",
        "passkey-probe-isolated",
      ]) {
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
