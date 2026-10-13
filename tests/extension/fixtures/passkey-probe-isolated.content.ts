import { defineContentScript } from "wxt/utils/define-content-script";
import { sendMessage } from "../../../apps/extension/src/messaging/protocol";
import { installPasskeyRelay } from "../../../apps/extension/src/passkeys/relay";

export default defineContentScript({
  matches: ["http://localhost/*"],
  runAt: "document_start",
  main(ctx) {
    ctx.onInvalidated(installPasskeyRelay((message) => sendMessage("passkey", message)));
  },
});
