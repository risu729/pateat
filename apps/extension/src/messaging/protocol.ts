import { defineExtensionMessaging } from "@webext-core/messaging";

/**
 * Messages to the background service worker, carried by `@webext-core/messaging`. A key
 * names the area that answers; its data is that area's own request, whose `type` still
 * picks the operation. The map types neither end: the background checks the sender and
 * parses each request with Valibot, and each sender parses the answer.
 *
 * The background's sends to a tab stay raw, since they address one document by
 * `documentId` and the library's tab send takes only a tab and frame. So do the Ports and
 * `window.postMessage`, which the library does not carry.
 */
export interface BackgroundProtocol {
  /** `settings.*`, from the settings page and the popup; export and import from the page. */
  settings(request: unknown): unknown;
  /** `service.*`, from the settings page. */
  service(request: unknown): unknown;
  /** `diagnostics.*`, from the diagnostics page. */
  diagnostics(request: unknown): unknown;
  /** `passkey-chooser.*`, from the passkey chooser window. */
  "passkey-chooser"(request: unknown): unknown;
  /** `login.*`, from the login content script, the popup and the probe build's controls. */
  login(request: unknown): unknown;
  /** `passkey.*`, from the passkey relay and the probe build's controls. */
  passkey(request: unknown): unknown;
  /** Probe build only, from the crypto probe page. */
  "setup.probe"(request: unknown): unknown;
  /** Probe build only, from the crypto probe page. */
  "vault.probe"(request: unknown): unknown;
  /** Probe build only, from the crypto probe page. */
  "crypto.probe"(request: unknown): unknown;
  /** Probe build only: the sending loopback content script's tab, frame and document. */
  "pateat.test.document"(): unknown;
}

// No logger: the library's debug lines would print each request and answer.
export const { sendMessage, onMessage } = defineExtensionMessaging<BackgroundProtocol>();
