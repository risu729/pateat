import { defineContentScript } from "wxt/utils/define-content-script";
import { installLoginContent } from "../src/login/content";

/**
 * Runs in the isolated world of every HTTPS page and frame. It only announces the
 * document; the background needs a cached recipe for the origin before any observation,
 * and a frame also needs the tab's page to be admitted (ADR 0017).
 */
export default defineContentScript({
  matches: ["https://*/*"],
  allFrames: true,
  runAt: "document_idle",
  noScriptStartedPostMessage: true,
  main(ctx) {
    ctx.onInvalidated(installLoginContent());
  },
});
