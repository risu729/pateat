import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyPage } from "../src/passkeys/page";

/**
 * ADR 0007 bridge: wraps `navigator.credentials.get` in the page's MAIN world of every
 * top-level HTTPS document at document start. Requests Pateat does not claim go to the
 * browser unchanged; the isolated relay and the background decide what is claimed.
 */
export default defineContentScript({
  matches: ["https://*/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPasskeyPage();
  },
});
