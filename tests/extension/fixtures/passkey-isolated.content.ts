import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyRelay } from "../../../apps/extension/src/passkeys/relay";

export default defineContentScript({
  matches: ["http://localhost/*", "https://synthetic.example.test/*"],
  runAt: "document_start",
  main(ctx) {
    ctx.onInvalidated(installPasskeyRelay((message) => browser.runtime.sendMessage(message)));
  },
});
