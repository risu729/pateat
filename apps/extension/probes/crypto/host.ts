import { loadBrowserCryptoSdk } from "../../../../packages/bitwarden/src/browser-sdk";

export async function initializeSyntheticCryptoHost() {
  // SDK error logging can include panic details. Only fixed evidence messages leave
  // these synthetic hosts; raw SDK diagnostics are never forwarded.
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
    console[method] = () => {};
  const sdk = await loadBrowserCryptoSdk();
  // The only permitted fetch was the packaged same-extension WASM above.
  globalThis.fetch = () => Promise.reject(new Error("Network disabled in crypto host"));
  sdk.init_sdk(sdk.LogLevel.Error, sdk.LogLevel.Error, 0);
  return sdk;
}
