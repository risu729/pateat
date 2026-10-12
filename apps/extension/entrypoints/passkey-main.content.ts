import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyPage } from "../src/passkeys/page";

/**
 * ADR 0007 bridge: wraps `navigator.credentials.get` and `create` in the page's MAIN world of
 * every top-level HTTPS document at document start. Requests Pateat does not claim or decline
 * go to the browser unchanged; the isolated relay and the background decide.
 */
export default defineContentScript({
  matches: ["https://*/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPasskeyPage();
  },
});
