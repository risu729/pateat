import { browser } from "wxt/browser";
import { createCryptoHost, type CryptoHostPort, type CryptoHostDependencies } from "./host";
import { OFFSCREEN_PATH } from "./wire";

export function createBrowserCryptoHost(
  options: Pick<CryptoHostDependencies, "checkpoint" | "requestTimeoutMs"> = {},
) {
  // The browser-owned sender URL also fences Ports left over from a prior broker.
  // The nonce is not authority: host admission additionally checks native context identity.
  const query = `?host=${crypto.randomUUID()}`;
  const offscreenPath = `${OFFSCREEN_PATH.slice(1)}${query}`;
  const offscreenUrl = `${browser.runtime.getURL(OFFSCREEN_PATH)}${query}`;
  const listeners = new Map<(port: CryptoHostPort) => void, (port: CryptoHostPort) => void>();
  return createCryptoHost({
    ...options,
    extensionId: browser.runtime.id,
    offscreenUrl,
    getContexts: () =>
      browser.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      }),
    createDocument: () =>
      browser.offscreen.createDocument({
        url: offscreenPath,
        reasons: ["WORKERS"],
        justification: "Run packaged local vault cryptography in cancellable dedicated Workers.",
      }),
    closeDocument: () => browser.offscreen.closeDocument(),
    onConnect: {
      addListener(listener) {
        listeners.set(listener, listener);
        browser.runtime.onConnect.addListener(listener);
      },
      removeListener(listener) {
        const owned = listeners.get(listener);
        if (owned) browser.runtime.onConnect.removeListener(owned);
        listeners.delete(listener);
      },
    },
  });
}
