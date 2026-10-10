import { getFoundationStatus, isStatusRequest } from "@pateat/contracts";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { createLocalSettingsRuntime } from "../src/settings";
import { createProbeCatalog } from "../src/login/dummy";
import { createLoginRuntime } from "../src/login/runtime";
import { createBrowserCryptoHost } from "../src/crypto/browser";
import { createCryptoProbe, createCryptoProbeControls } from "../src/crypto/probe";

export default defineBackground(() => {
  const catalog = import.meta.env.MODE === "probe" ? createProbeCatalog() : undefined;
  const settings = catalog ? createLocalSettingsRuntime({ catalog }) : createLocalSettingsRuntime();
  const login = catalog ? createLoginRuntime(settings, catalog) : undefined;
  const cryptoControls = import.meta.env.MODE === "probe" ? createCryptoProbeControls() : undefined;
  const cryptoHost = createBrowserCryptoHost(
    cryptoControls
      ? { checkpoint: cryptoControls.checkpoint, requestTimeoutMs: cryptoControls.requestTimeoutMs }
      : {},
  );
  const cryptoProbe = cryptoControls ? createCryptoProbe(cryptoHost, cryptoControls) : undefined;
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      cryptoProbe &&
      sender.id === browser.runtime.id &&
      sender.url === new URL("crypto-probe.html", browser.runtime.getURL("/options.html")).href &&
      message !== null &&
      typeof message === "object" &&
      message.type === "crypto.probe"
    ) {
      void cryptoProbe(message).then(sendResponse);
      return true;
    }
    if (
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL("/options.html") &&
      message !== null &&
      typeof message === "object" &&
      (message.type === "settings.get" || message.type === "settings.save")
    ) {
      void settings.handle(message).then((response) => {
        if (message.type === "settings.save" && response.ok) login?.settingsChanged();
        return sendResponse(response);
      });
      return true;
    }
    if (
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL("/options.html") &&
      isStatusRequest(message)
    ) {
      sendResponse(getFoundationStatus());
    }

    if (
      login &&
      message !== null &&
      typeof message === "object" &&
      typeof message.type === "string" &&
      message.type.startsWith("login.")
    ) {
      void login
        .handle(message, sender)
        .then(sendResponse, () => sendResponse({ ok: false, reason: "runtime-unavailable" }));
      return true;
    }

    if (
      import.meta.env.MODE === "probe" &&
      sender.id === browser.runtime.id &&
      sender.tab?.id !== undefined &&
      sender.url?.startsWith("http://127.0.0.1:") &&
      message?.type === "pateat.test.document"
    ) {
      sendResponse({
        tabId: sender.tab.id,
        frameId: sender.frameId,
        documentId: sender.documentId,
        active: sender.tab.active,
      });
    }
    return false;
  });
});
