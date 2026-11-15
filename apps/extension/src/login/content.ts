import { browser } from "wxt/browser";
import { createContentSession } from "./content-session";
import { createContentListener } from "./content-dispatch";

export interface LoginContentOptions {
  /** Echo attempt status to the page; only the synthetic probe fixture page may see it. */
  readonly probeStatus?: boolean;
}

export function installLoginContent(options: LoginContentOptions = {}): () => void {
  const context = createContentSession(options);
  const listener = createContentListener(context);
  document.addEventListener("submit", context.onSubmit, true);
  addEventListener("popstate", context.urlChanged);
  context.navigation?.addEventListener("currententrychange", context.urlChanged);
  browser.runtime.onMessage.addListener(listener);
  void context.announce(false).catch(() => undefined);
  return () => {
    context.cancelled = true;
    context.waits.abort();
    removeEventListener("popstate", context.urlChanged);
    context.navigation?.removeEventListener("currententrychange", context.urlChanged);
    context.urlWatch?.();
    context.lateWatch?.();
    context.unwatch();
    context.inTab.stop();
    context.followConfirmPath(undefined);
    document.removeEventListener("submit", context.onSubmit, true);
    context.submitListeners.abort();
    browser.runtime.onMessage.removeListener(listener);
  };
}
