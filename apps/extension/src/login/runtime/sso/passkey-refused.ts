import { browser } from "wxt/browser";
import {
  sameLoginDocument,
  type LoginAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
} from "@pateat/contracts";
import { change } from "../attempt";
import { forget } from "../session-store";
import { frameKey, recordKey } from "../steps";
import { ssoChild } from "../sso-state";
import type { Runtime } from "../state";
import type { Execution } from "../types";

const sameAccount = (a: LoginAccount, b: LoginAccount) =>
  a.origin === b.origin && a.connectionId === b.connectionId && a.itemId === b.itemId;

/**
 * Names the login a tab's native method choice started on its own document, so a later
 * login of the same account in that tab is never taken for the one the choice made.
 */
export function bindNativeChoice(
  rt: Runtime,
  document: LoginDocument,
  metadata: LoginAttemptMetadata,
): void {
  const native = rt.sso.native.get(document.tabId);
  if (
    native &&
    native.attemptId === undefined &&
    sameLoginDocument(native.document, document) &&
    sameAccount(native.account, metadata.account)
  )
    native.attemptId = metadata.id;
}

/**
 * A passkey the site refused, on a login a native method choice started for an item with
 * an SSO method (ADR 0085, a refused passkey): its item's SSO method comes before the
 * password, so the login never goes back to the password (ADR 0034 rule 6). A passkey the
 * chooser picked by itself ends the login and its page is admitted again, where the
 * chooser picks once more without the passkey: it lands on the preferred SSO method, or
 * stops with that method's reason, and only an item without a preferred SSO method gets
 * the password then. A passkey the person picked for "Log in now" ends with the refused
 * passkey's stop, and the popup offers the methods again without it. An item with no SSO
 * method, and an IdP's own login during an SSO hop, fall back as any native login does.
 * Returns whether it took the login over.
 */
export async function ssoAfterPasskey(rt: Runtime, run: Execution): Promise<boolean> {
  const { document } = run.live;
  const { account } = run.metadata;
  const native = rt.sso.native.get(document.tabId);
  if (
    !native ||
    native.route !== "passkey" ||
    native.attemptId !== run.metadata.id ||
    document.frameId !== 0 ||
    ssoChild(rt.sso, run.metadata) ||
    !sameAccount(native.account, account) ||
    (!native.automatic && !native.methods)
  )
    return false;
  rt.sso.native.delete(document.tabId);
  rt.sso.passkeyRefused.set(document.tabId, { ...account });
  await change(
    rt,
    run,
    { type: "CANCEL" },
    undefined,
    undefined,
    undefined,
    native.automatic ? "sso-after-passkey" : "sso-passkey-refused",
  );
  // The person's own pick stops here: its record stays, and the popup offers the methods
  // again without the passkey rather than any method being chosen by itself.
  if (!native.automatic || rt.attempts.get(document.tabId) !== run) return true;
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
