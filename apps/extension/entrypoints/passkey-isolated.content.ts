import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyRelay } from "../src/passkeys/relay";

/** Relays bounded passkey requests from the MAIN-world bridge to the background. */
export default defineContentScript({
  matches: ["https://*/*"],
  runAt: "document_start",
  // WXT would otherwise post a start message naming the extension ID to every page.
  noScriptStartedPostMessage: true,
  main(ctx) {
    ctx.onInvalidated(
      installPasskeyRelay(
        (message) => browser.runtime.sendMessage(message),
        // An extension reload or update leaves this script without a runtime ID.
        () => browser.runtime?.id !== undefined,
      ),
    );
  },
});
