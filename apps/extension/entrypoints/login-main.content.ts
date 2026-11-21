import { defineContentScript } from "wxt/utils/define-content-script";
import { installMainWorldDefinitions } from "../src/page/element-definitions";
import { installMainWorldClicks } from "../src/page/script-url-click";

/**
 * Clicks or submits, in the page's MAIN world, what the login content script asks it to
 * when that runs a `javascript:` URL (a link, or a form's `javascript:` action), so Chrome
 * runs the URL under the page's own content security policy, and tells
 * it when the page defines a custom element it asked about, which the isolated world's
 * `customElements` cannot (ADR 0082). It runs in every HTTP(S) page and frame, as the
 * login script does, and reads nothing from the page.
 */
export default defineContentScript({
  matches: ["https://*/*", "http://*/*"],
  allFrames: true,
  runAt: "document_start",
  world: "MAIN",
  main() {
    installMainWorldClicks();
    installMainWorldDefinitions();
  },
});
