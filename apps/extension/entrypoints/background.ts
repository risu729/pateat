import { getFoundationStatus, isStatusRequest } from "@pateat/contracts";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { createProbeCatalog } from "../src/login/dummy";
import { createLoginRuntime } from "../src/login/runtime";
import { combineFieldSources, createVaultFieldSource, dummyFieldSource } from "../src/login/vault";
import { createBrowserCryptoHost } from "../src/crypto/browser";
import { createCryptoProbe, createCryptoProbeControls } from "../src/crypto/probe";
import { createVaultProbe } from "../src/vault/probe";
import { createConnectionRuntime } from "../src/connections/runtime";
import { createConnectionProbeTransport } from "../src/connections/probe";
import { createProbePasskeySource } from "../src/passkeys/probe";
import { createPasskeyRuntime } from "../src/passkeys/runtime";

export default defineBackground(() => {
  const catalog = import.meta.env.MODE === "probe" ? createProbeCatalog() : undefined;
  const cryptoControls = import.meta.env.MODE === "probe" ? createCryptoProbeControls() : undefined;
  const cryptoHost = createBrowserCryptoHost(
    cryptoControls
      ? { checkpoint: cryptoControls.checkpoint, requestTimeoutMs: cryptoControls.requestTimeoutMs }
      : {},
  );
  const cryptoProbe = cryptoControls ? createCryptoProbe(cryptoHost, cryptoControls) : undefined;
  const vaultProbe = import.meta.env.MODE === "probe" ? createVaultProbe(cryptoHost) : undefined;
  const syntheticSetup =
    import.meta.env.MODE === "probe" ? createConnectionProbeTransport() : undefined;
  const connections = createConnectionRuntime(cryptoHost, {
    ...(catalog ? { baseCatalog: catalog } : {}),
    ...(syntheticSetup
      ? {
          transportOptions: syntheticSetup.transportOptions,
          containsPermission: syntheticSetup.containsPermission,
        }
      : {}),
  });
  const settings = connections.settings;
  // Site execution remains probe-gated until production document admission is added.
  const login = catalog
    ? createLoginRuntime(
        settings,
        combineFieldSources({
          dummy: dummyFieldSource,
          bitwarden: createVaultFieldSource(connections),
        }),
      )
    : undefined;
  const setupProbe = syntheticSetup?.handler(connections);
  const passkeyProbe = import.meta.env.MODE === "probe" ? createProbePasskeySource() : undefined;
  const passkeys = passkeyProbe
    ? createPasskeyRuntime(passkeyProbe.source, {
        extensionId: browser.runtime.id,
        timeoutMs: passkeyProbe.timeoutMs,
        policy: passkeyProbe.policy,
      })
    : undefined;

  browser.runtime.onConnect.addListener((port) => {
    connections.attach(port);
  });
  browser.permissions.onRemoved.addListener(() => {
    void connections.service.permissionsRemoved().catch(() => undefined);
  });
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      setupProbe &&
      sender.id === browser.runtime.id &&
      sender.url === new URL("crypto-probe.html", browser.runtime.getURL("/options.html")).href &&
      message !== null &&
      typeof message === "object" &&
      message.type === "setup.probe"
    ) {
      void setupProbe(message).then(sendResponse, () =>
        sendResponse({ ok: false, error: { code: "setup-unavailable" } }),
      );
      return true;
    }
    if (
      vaultProbe &&
      sender.id === browser.runtime.id &&
      sender.url === new URL("crypto-probe.html", browser.runtime.getURL("/options.html")).href &&
      message !== null &&
      typeof message === "object" &&
      message.type === "vault.probe"
    ) {
      void vaultProbe(message).then(sendResponse);
      return true;
    }
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
        if (message.type === "settings.save" && response.ok) {
          login?.settingsChanged();
          passkeys?.cancelAll();
        }
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
      passkeyProbe &&
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL("/options.html") &&
      message !== null &&
      typeof message === "object" &&
      typeof message.type === "string" &&
      message.type.startsWith("passkey.probe.")
    ) {
      sendResponse(passkeyProbe.control(message));
      return false;
    }
    if (
      passkeys &&
      message !== null &&
      typeof message === "object" &&
      typeof message.type === "string" &&
      message.type.startsWith("passkey.")
    ) {
      void passkeys
        .handle(message, sender)
        .then(sendResponse, () =>
          sendResponse({ kind: "delegate", reason: "runtime-unavailable" }),
        );
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
