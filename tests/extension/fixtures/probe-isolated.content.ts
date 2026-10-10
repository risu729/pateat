import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  matches: ["http://127.0.0.1/*"],
  runAt: "document_start",
  main(ctx) {
    ctx.addEventListener(window, "message", (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as {
        type?: unknown;
        id?: unknown;
        stateAtInstall?: unknown;
        nativeGetUnchanged?: unknown;
      } | null;
      if (
        data?.type !== "pateat.test.main-ready" ||
        typeof data.id !== "string" ||
        data.id.length > 64
      )
        return;
      void (async () => {
        const identity: unknown = await browser.runtime.sendMessage({
          type: "pateat.test.document",
        });
        let statusRequestAccepted = false;
        try {
          statusRequestAccepted =
            (await browser.runtime.sendMessage({
              version: 1,
              type: "runtime.status.get",
            })) !== undefined;
        } catch {
          // The settings-only boundary also permits browsers that reject a
          // response-less request instead of resolving it with undefined.
        }
        let settingsRequestAccepted = false;
        let storageReadAccepted = false;
        try {
          settingsRequestAccepted =
            (await browser.runtime.sendMessage({ version: 1, type: "settings.get" })) !== undefined;
        } catch {
          // Content scripts must not reach settings operations.
        }
        try {
          await browser.storage.local.get("pateat.local-settings.v1");
          storageReadAccepted = true;
        } catch {
          // Trusted-context-only storage must reject direct content-script reads.
        }
        if (ctx.isInvalid) return;
        window.postMessage(
          {
            type: "pateat.test.result",
            id: data.id,
            stateAtInstall: data.stateAtInstall,
            nativeGetUnchanged: data.nativeGetUnchanged,
            identity,
            statusRequestAccepted,
            settingsRequestAccepted,
            storageReadAccepted,
          },
          location.origin,
        );
      })();
    });
  },
});
