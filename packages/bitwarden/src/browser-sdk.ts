// Upstream omits declarations for these browser subpaths; consumers need this ambient file.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./sdk-browser-modules.d.ts" />
import * as sdk from "@bitwarden/sdk-internal/index.js";
import * as bindings from "@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js";
import asset from "@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm?url";
import type { LocalCryptoSdk } from "./local-crypto";

let initialized: Promise<LocalCryptoSdk> | undefined;

/** Load only the packaged native WASM in an extension Worker, never a remote or JS fallback. */
export function loadBrowserCryptoSdk(): Promise<LocalCryptoSdk> {
  initialized ??= initialize();
  return initialized;
}

async function initialize(): Promise<LocalCryptoSdk> {
  const url = new URL(asset, location.href);
  if (url.protocol !== "chrome-extension:" || url.host !== location.host)
    throw new Error("Crypto asset must belong to this extension");
  const response = await fetch(url, { credentials: "omit", redirect: "error", cache: "no-store" });
  if (!response.ok || response.redirected) throw new Error("Crypto asset unavailable");
  const bytes = await response.arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, {
    "./bitwarden_wasm_internal_bg.js": bindings,
  });
  sdk.init(result.instance.exports);
  return sdk;
}
