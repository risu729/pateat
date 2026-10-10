import { defineContentScript } from "wxt/utils/define-content-script";
import { installPasskeyPage } from "../../../apps/extension/src/passkeys/page";

// Probe-only adapter. WebAuthn rejects IP-address origins, so passkeys use localhost, and
// https://synthetic.example.test, the RP ID of the synthetic Bitwarden passkey, which tests
// serve through request interception.
export default defineContentScript({
  matches: ["http://localhost/*", "https://synthetic.example.test/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPasskeyPage();
  },
});
