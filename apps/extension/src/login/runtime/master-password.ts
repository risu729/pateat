import {
  type LoginAccount,
  type LoginDocument,
  itemAsksForMasterPassword,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { type RepromptResponse } from "../choice-wire";
import { type DetailSite } from "../details";
import { type PickedAccount, type DetailOffer } from "./session-schemas";
import { frameKey } from "./steps";
import { quietly } from "./session-store";
import { saveSession } from "./attempt";
import { tabAttempt } from "./hold";
import type { Runtime } from "./state";

export const holdPassword = (rt: Runtime, attemptId: string, connectionId: string) => {
  rt.repromptTyped.delete(attemptId);
  rt.repromptTyped.set(attemptId, connectionId);
  for (const old of rt.repromptTyped.keys()) {
    if (rt.repromptTyped.size <= 256) break;
    rt.repromptTyped.delete(old);
  }
};

/** Where a login reads personal details from `connectionId` (`DetailSite`). */
export const detailSite = (
  rt: Runtime,
  attemptId: string,
  connectionId: string,
  url: string,
): DetailSite => ({
  url,
  verified: rt.repromptTyped.get(attemptId) === connectionId,
});

/**
 * Ends the master password state of one document, or of every document of the tab: its
 * window closes, so a document that replaced it can ask, and an unused grant goes.
 */
export function dropReprompt(rt: Runtime, tabId: number, documentId?: string): void {
  const matches = (key: string) =>
    documentId === undefined ? key.startsWith(`${tabId} `) : key === `${tabId} ${documentId}`;
  for (const [key, controller] of rt.repromptAsking)
    if (matches(key)) {
      rt.repromptAsking.delete(key);
      controller.abort();
    }
  // A closing window settles later; a document coming back meanwhile asks in a new one.
  for (const key of rt.passwordAsks.keys()) if (matches(key)) rt.passwordAsks.delete(key);
  for (const key of rt.repromptGrants.keys()) if (matches(key)) rt.repromptGrants.delete(key);
  const waiting = rt.repromptWaiting.get(tabId);
  if (waiting && (documentId === undefined || waiting.document.documentId === documentId))
    rt.repromptWaiting.delete(tabId);
}

/**
 * Opens the chooser window for the master password of a refused login's re-prompt item,
 * once per document at a time. Once the vault accepts it, the document announces again and
 * its login starts with that item, as after a pick in the popup (ADR 0021 B), whose pick it
 * keeps. The check is never cut off by the page: an aborted check would lock the vault.
 */
export function openPasswordWindow(
  rt: Runtime,
  kind: "login" | "detail",
  key: string,
  input: {
    tabId: number;
    origin: string;
    account: LoginAccount;
    connection: VaultConnectionMetadata;
    item: VaultItemMetadata;
  },
) {
  const ask = rt.options.askMasterPassword!;
  const controller = new AbortController();
  let settle!: (value: { answer: "verified" | "closed" | "unavailable"; aborted: boolean }) => void;
  const entry = {
    kind,
    connectionId: input.connection.id,
    answer: new Promise<{ answer: "verified" | "closed" | "unavailable"; aborted: boolean }>(
      (resolve) => (settle = resolve),
    ),
  };
  // Both are set before the window is asked for, so its end always removes them.
  rt.repromptAsking.set(key, controller);
  rt.passwordAsks.set(key, entry);
  void (async () => {
    let answer: "verified" | "closed" | "unavailable";
    try {
      answer = await ask({ ...input, signal: controller.signal });
    } catch {
      answer = "unavailable";
    } finally {
      if (rt.repromptAsking.get(key) === controller) rt.repromptAsking.delete(key);
      if (rt.passwordAsks.get(key) === entry) rt.passwordAsks.delete(key);
    }
    settle({ answer, aborted: controller.signal.aborted });
  })();
  return entry;
}

export async function askMasterPassword(
  rt: Runtime,
  asking: { document: LoginDocument; account: LoginAccount; pick?: PickedAccount },
  connection: VaultConnectionMetadata,
  item: VaultItemMetadata,
): Promise<RepromptResponse> {
  const { document, account: login } = asking;
  const key = `${document.tabId} ${document.documentId}`;
  if (!rt.options.askMasterPassword) return { ok: false, reason: "unavailable" };
  const open = rt.passwordAsks.get(key);
  if (open?.kind === "login") return { ok: true };
  // A window that asks before a detail's read is answered first; its password counts
  // for this login only when it was checked for the same vault account.
  const asked =
    open ??
    openPasswordWindow(rt, "login", key, {
      tabId: document.tabId,
      origin: document.origin,
      account: login,
      connection,
      item,
    });
  const { answer, aborted } = await asked.answer;
  // Checked for another vault account, whatever its answer: once it ends, this login
  // asks for its own, while the document still waits for it.
  const other = asked.connectionId !== connection.id;
  if (answer !== "verified" && !other) return { ok: false, reason: answer };
  const live = rt.documents.get(frameKey(document));
  if (live?.document.documentId !== document.documentId || aborted)
    return { ok: false, reason: "document-gone" };
  // The document may have started another login meanwhile, as after a pick in the popup.
  if (live.reason !== "master-password-reprompt") return { ok: false, reason: "not-waiting" };
  if (other) return askMasterPassword(rt, asking, connection, item);
  rt.repromptGrants.set(key, {
    connectionId: login.connectionId,
    itemId: login.itemId,
    at: Date.now(),
  });
  if (asking.pick) {
    rt.picked.set(document.tabId, { ...asking.pick });
    await quietly(rt, () => saveSession(rt));
  }
  try {
    await browser.tabs.sendMessage(
      document.tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: document.frameId, documentId: document.documentId },
    );
  } catch {
    rt.repromptGrants.delete(key);
    return { ok: false, reason: "document-gone" };
  }
  return { ok: true };
}

/**
 * Asks for the master password before a personal detail is read from `item`, another item
 * of the login's vault account with Bitwarden's re-prompt (ADR 0061; owner, 2026-10-23
 * 21:50 UTC), in the chooser window that asks for a login's own item, under its rules.
 * Once the vault accepts it, the offer's login holds it (`holdPassword`), while the tab
 * still runs that login. One window at a time per document: a second ask waits for the
 * first one's answer. A closed window or one that cannot open gives no password.
 */
export async function askDetailPassword(
  rt: Runtime,
  offer: DetailOffer,
  connection: VaultConnectionMetadata,
  item: VaultItemMetadata,
): Promise<boolean> {
  const { document } = offer;
  const key = `${document.tabId} ${document.documentId}`;
  if (!rt.options.askMasterPassword) return false;
  // A window already open for the document, for its login's item or another detail's,
  // is answered once; each ask then checks its own login.
  const asked =
    rt.passwordAsks.get(key) ??
    openPasswordWindow(rt, "detail", key, {
      tabId: document.tabId,
      origin: document.origin,
      account: offer.account,
      connection,
      item,
    });
  const { answer, aborted } = await asked.answer;
  if (aborted || tabAttempt(rt, document.tabId)?.id !== offer.attemptId) return false;
  // Checked for another vault account: once it ends, this read asks for its own.
  if (asked.connectionId !== connection.id) return askDetailPassword(rt, offer, connection, item);
  if (answer !== "verified") return false;
  holdPassword(rt, offer.attemptId, connection.id);
  return true;
}

/** The popup's button for a tab whose login waits for the master password. */
export async function repromptFor(rt: Runtime, tabId: number): Promise<RepromptResponse> {
  const waiting = rt.repromptWaiting.get(tabId);
  const live = rt.documents.get(frameKey({ tabId, frameId: 0 }));
  if (
    !waiting ||
    live?.document.documentId !== waiting.document.documentId ||
    live.reason !== "master-password-reprompt"
  )
    return { ok: false, reason: "not-waiting" };
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!snapshot.ok) return { ok: false, reason: "unavailable" };
  const connection = snapshot.catalog.connections.find(
    (entry) => entry.id === waiting.account.connectionId,
  );
  const item = connection?.items.find((entry) => entry.id === waiting.account.itemId);
  if (!connection || !item) return { ok: false, reason: "unavailable" };
  // The site may have stopped asking since.
  if (!itemAsksForMasterPassword(snapshot.snapshot.settings, item, live.url))
    return { ok: false, reason: "not-waiting" };
  return askMasterPassword(rt, waiting, connection, item);
}
