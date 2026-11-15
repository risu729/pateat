import { browser } from "wxt/browser";
import type { LoginAccount } from "@pateat/contracts";
import { change } from "../attempt";
import { forget } from "../session-store";
import { frameKey, recordKey } from "../steps";
import { ssoChild } from "../sso-state";
import type { Runtime } from "../state";
import type { Execution } from "../types";

const sameAccount = (a: LoginAccount, b: LoginAccount) =>
  a.origin === b.origin && a.connectionId === b.connectionId && a.itemId === b.itemId;

/**
 * A passkey the site refused, on a login whose route the SSO method chooser picked by
 * itself (ADR 0085, a refused passkey): its item may hold an enabled SSO method, which
 * comes before the password, so the login ends without going back to the password (ADR
 * 0034 rule 6) and its page is admitted again, where the chooser picks once more without
 * the passkey. It lands on the preferred SSO method, or stops with that method's reason;
 * only an item without an enabled SSO method gets the password then. A passkey the person
 * picked for a manual sign-in, and an IdP's own login during an SSO hop, fall back as any
 * native login does. Returns whether it took the login over.
 */
export async function ssoAfterPasskey(rt: Runtime, run: Execution): Promise<boolean> {
  const { document } = run.live;
  const { account } = run.metadata;
  const native = rt.sso.native.get(document.tabId);
  if (
    !native ||
    native.route !== "passkey" ||
    !native.automatic ||
    document.frameId !== 0 ||
    ssoChild(rt.sso, run.metadata) ||
    !sameAccount(native.account, account)
  )
    return false;
  rt.sso.native.delete(document.tabId);
  rt.sso.passkeyRefused.set(document.tabId, { ...account });
  await change(rt, run, { type: "CANCEL" }, undefined, undefined, undefined, "sso-after-passkey");
  if (rt.attempts.get(document.tabId) !== run) return true;
  // The ended login neither holds the site nor carries the document, which announces
  // itself again for the chooser.
  rt.attempts.delete(document.tabId);
  await forget(rt, recordKey(document.tabId, account.origin)).catch(() => undefined);
  if (rt.documents.get(frameKey(document)) === run.live)
    void browser.tabs
      .sendMessage(
        document.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: 0, documentId: document.documentId },
      )
      .catch(() => undefined);
  return true;
}
