import { defineContentScript } from "wxt/utils/define-content-script";
import { answerFramePresence } from "../src/login/frame-presence";
import { recordFillEdits } from "../src/page/fill-edits";
import { recordSiteValues } from "../src/page/site-values";

/**
 * Records, from the start of every HTTP(S) page and frame, the values the page itself puts
 * into account inputs before anyone types, which the login content script compares with
 * matching items' usernames when several match (ADR 0028 amendment of 2026-10-23), and
 * answers whether the frame still shows a document (ADR 0086).
 */
export default defineContentScript({
  matches: ["https://*/*", "http://*/*"],
  allFrames: true,
  runAt: "document_start",
  noScriptStartedPostMessage: true,
  main(ctx) {
    ctx.onInvalidated(recordSiteValues(document, window));
    ctx.onInvalidated(recordFillEdits(document, window));
    ctx.onInvalidated(answerFramePresence());
  },
});
