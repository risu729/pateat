import { defineContentScript } from "wxt/utils/define-content-script";
import { installLoginContent } from "../../../apps/extension/src/login/content";

export default defineContentScript({
  matches: ["http://127.0.0.1/*"],
  runAt: "document_idle",
  main(ctx) {
    ctx.onInvalidated(installLoginContent());
  },
});
