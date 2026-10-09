import { defineContentScript } from "wxt/utils/define-content-script";

// This entrypoint exists only in the separate, loopback-only probe build.
// It proves injection timing without wrapping or invoking WebAuthn.
export default defineContentScript({
  matches: ["http://127.0.0.1/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    const stateAtInstall = document.readyState;
    const originalGet = navigator.credentials?.get;
    Object.defineProperty(window, "__pateatDocumentStartProbe", { value: true });

    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { type?: unknown; id?: unknown } | null;
      if (data?.type !== "pateat.test.start" || typeof data.id !== "string" || data.id.length > 64)
        return;
      window.postMessage(
        {
          type: "pateat.test.main-ready",
          id: data.id,
          stateAtInstall,
          nativeGetUnchanged: navigator.credentials?.get === originalGet,
        },
        location.origin,
      );
    });
  },
});
