import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { MANIFEST_KEY } from "./manifest-key";
import { bitwardenSdkSourceAssets, readBitwardenSdkSource } from "./sdk-source";

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
  return readBitwardenSdkSource().version;
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
    description:
      "Logs in to websites and answers passkey sign-ins from your own password vault, kept on this device.",
    // Chrome 145 is the first with Map.prototype.getOrInsertComputed; native Temporal
    // needs 144, and the standard Uint8Array base64 and hex methods and RegExp.escape need 140.
    minimum_chrome_version: "145",
    action: {
      default_title: "Pateat",
      // Until the worker reads the vault records, show the locked icon.
      default_icon: { 16: "icon-locked/16.png", 32: "icon-locked/32.png" },
    },
    permissions: ["storage", "offscreen", "alarms"],
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
      : // Fixed production ID for pairing (ADR 0020). The probe build keeps its
        // path-derived ID so it never shares storage with the owner's production install.
        { key: MANIFEST_KEY }),
  }),
  hooks: {
    "build:publicAssets"(_wxt, files) {
      for (const record of bitwardenSdkSourceAssets()) {
        const index = files.findIndex((file) => file.relativeDest === record.relativeDest);
        if (index < 0) throw new Error(`Missing SDK source notice: ${record.relativeDest}`);
        files[index] = record;
      }
    },
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
