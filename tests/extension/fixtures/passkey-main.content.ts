import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyPage } from "../../../apps/extension/src/passkeys/page";

// Probe-only adapter. WebAuthn rejects IP-address origins, so passkeys use localhost.
export default defineContentScript({
  matches: ["http://localhost/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPasskeyPage();
  },
});
