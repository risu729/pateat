import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { sendMessage } from "../src/messaging/protocol";
import { shownPasskeyAccount } from "../src/page/accounts";
import { installPasskeyRelay } from "../src/passkeys/relay";

/** Relays bounded passkey requests from the MAIN-world bridge to the background. */
export default defineContentScript({
  // `http://localhost` too, as in Bitwarden (ADR 0050).
  matches: ["https://*/*", "http://localhost/*"],
  runAt: "document_start",
  // WXT would otherwise post a start message naming the extension ID to every page.
  noScriptStartedPostMessage: true,
  main(ctx) {
    ctx.onInvalidated(
      installPasskeyRelay(
        (message) => sendMessage("passkey", message),
        // An extension reload or update leaves this script without a runtime ID.
        () => browser.runtime?.id !== undefined,
        // ADR 0028 amendment of 2026-11-17: the account the page shows, read at a click.
        () => shownPasskeyAccount(document),
      ),
    );
  },
});
