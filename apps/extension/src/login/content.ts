import { browser } from "wxt/browser";
import { createContentSession } from "./content-session";
import { createContentListener } from "./content-dispatch";
import { pagePath } from "./content-dom";
import { watchPersonSteps } from "./person-step";
import { sendMessage } from "../messaging/protocol";

export interface LoginContentOptions {
  /** Echo attempt status to the page; only the synthetic probe fixture page may see it. */
  readonly probeStatus?: boolean;
}

export function installLoginContent(options: LoginContentOptions = {}): () => void {
  const context = createContentSession(options);
  const listener = createContentListener(context);
  document.addEventListener("submit", context.onSubmit, true);
  // The person's own sign-in step: only that it happened, on which path (ADR 0034).
  const unstep = watchPersonSteps(document, () => {
    if (context.cancelled) return;
    void sendMessage("login", {
      version: 1,
      type: "login.document.person-step",
      token: context.token,
      path: pagePath(),
    }).catch(() => undefined);
  });
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
    unstep();
    context.submitListeners.abort();
    browser.runtime.onMessage.removeListener(listener);
  };
}
