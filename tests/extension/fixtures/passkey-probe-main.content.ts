import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyPage } from "../../../apps/extension/src/passkeys/page";

// Probe-only adapter for the loopback relying party. WebAuthn rejects IP-address origins, so
// passkeys use localhost; HTTPS pages get the production bridge.
export default defineContentScript({
  matches: ["http://localhost/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPasskeyPage();
  },
});
