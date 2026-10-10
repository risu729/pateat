import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyRelay } from "../src/passkeys/relay";

/** Relays bounded passkey requests from the MAIN-world bridge to the background. */
export default defineContentScript({
  matches: ["https://*/*"],
  runAt: "document_start",
  main(ctx) {
    ctx.onInvalidated(installPasskeyRelay((message) => browser.runtime.sendMessage(message)));
  },
});
