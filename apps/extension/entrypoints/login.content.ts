import { defineContentScript } from "wxt/utils/define-content-script";
import { installLoginContent } from "../src/login/content";

/**
 * Runs in the isolated world of every top-level HTTPS page. It only announces the
 * document; the background admits saved-default origins before any observation.
 */
export default defineContentScript({
  matches: ["https://*/*"],
  runAt: "document_idle",
  noScriptStartedPostMessage: true,
  main(ctx) {
    ctx.onInvalidated(installLoginContent());
  },
});
