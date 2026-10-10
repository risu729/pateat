import { browser } from "wxt/browser";
import { createCryptoHost, type CryptoHostPort, type CryptoHostDependencies } from "./host";
import { OFFSCREEN_PATH } from "./wire";

export function createBrowserCryptoHost(
  options: Pick<CryptoHostDependencies, "checkpoint" | "requestTimeoutMs"> = {},
) {
  const offscreenUrl = browser.runtime.getURL(OFFSCREEN_PATH);
  const listeners = new Map<(port: CryptoHostPort) => void, (port: CryptoHostPort) => void>();
  return createCryptoHost({
    ...options,
    extensionId: browser.runtime.id,
    offscreenUrl,
    getContexts: () =>
      browser.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
      }),
    createDocument: () =>
      browser.offscreen.createDocument({
        url: OFFSCREEN_PATH.slice(1),
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
