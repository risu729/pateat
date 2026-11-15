import * as v from "valibot";
import type { Browser } from "wxt/browser";
import { observedPath } from "../../observation/path";
import { ssoCancelRequestSchema, ssoChooseRequestSchema, ssoGetRequestSchema } from "../sso-wire";
import type { Runtime } from "./state";
import { frameKey } from "./steps";

/**
 * The popup's SSO method choice messages (ADR 0085), or undefined for any other message.
 * The sender is checked by the caller.
 */
export function ssoPopupMessage(rt: Runtime, message: unknown): Promise<unknown> | undefined {
  const get = v.safeParse(ssoGetRequestSchema, message);
  if (get.success) return Promise.resolve(rt.ssoChoices?.get(get.output.tabId) ?? { ok: true });
  const choose = v.safeParse(ssoChooseRequestSchema, message);
  if (choose.success)
    return Promise.resolve(
      rt.ssoChoices?.choose(choose.output) ?? { ok: false, reason: "unavailable" },
    );
  const cancel = v.safeParse(ssoCancelRequestSchema, message);
  if (cancel.success)
    return Promise.resolve(
      rt.ssoChoices?.cancel(cancel.output.tabId, cancel.output.offerId) ?? {
        ok: false,
        reason: "offer-gone",
      },
    );
  return undefined;
}

/**
 * The tab's address changed. Only another origin or path of its top page withdraws a
 * method offer; a new query or fragment keeps it.
 */
export function ssoTabLoaded(rt: Runtime, tab: Pick<Browser.tabs.Tab, "id" | "url">): void {
  if (tab.id === undefined || !rt.ssoChoices) return;
  const top = rt.documents.get(frameKey({ tabId: tab.id, frameId: 0 }));
  const url = URL.parse(tab.url ?? "");
  if (top && url && url.origin === top.document.origin && observedPath(url.pathname) === top.path)
    return;
  rt.ssoChoices.documentChanged({ tabId: tab.id, frameId: 0 }, "page-changed");
}
