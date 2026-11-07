import { defineContentScript } from "wxt/utils/define-content-script";
import { installLoginContent } from "../../../apps/extension/src/login/content";
import { answerFramePresence } from "../../../apps/extension/src/login/frame-presence";

export default defineContentScript({
  matches: ["http://127.0.0.1/*"],
  allFrames: true,
  runAt: "document_idle",
  main(ctx) {
    ctx.onInvalidated(installLoginContent({ probeStatus: true }));
    // The probe build has no `login-start` on loopback pages (ADR 0086).
    ctx.onInvalidated(answerFramePresence());
  },
});
