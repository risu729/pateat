import { browser } from "wxt/browser";
import { ContentState } from "./content-state";
import { createContentWatch } from "./content-watch";
import { createContentListener } from "./content-dispatch";

export interface LoginContentOptions {
  /** Echo attempt status to the page; only the synthetic probe fixture page may see it. */
  readonly probeStatus?: boolean;
}
export function installLoginContent({ probeStatus = false }: LoginContentOptions = {}): () => void {
  const state = new ContentState();
  const watch = createContentWatch(state);
  const listener = createContentListener(state, watch, probeStatus);

  document.addEventListener("submit", watch.onSubmit, true);
  addEventListener("popstate", watch.urlChanged);
  state.navigation?.addEventListener("currententrychange", watch.urlChanged);
  browser.runtime.onMessage.addListener(listener);
  void watch.announce(false).catch(() => undefined);
  return () => {
    state.cancelled = true;
    state.waits.abort();
    removeEventListener("popstate", watch.urlChanged);
    state.navigation?.removeEventListener("currententrychange", watch.urlChanged);
    state.urlWatch?.();
    state.lateWatch?.();
    watch.unwatch();
    state.inTab.stop();
    watch.followConfirmPath(undefined);
    document.removeEventListener("submit", watch.onSubmit, true);
    state.submitListeners.abort();
    browser.runtime.onMessage.removeListener(listener);
  };
}
