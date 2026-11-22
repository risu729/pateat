// The account a verification page shows, in a tab without Pateat's login (ADR 0035,
// amended 2026-11-22): the page is filled automatically only when it shows the username
// of exactly one of its matching accounts.
import * as v from "valibot";
import { itemAsksForMasterPassword } from "@pateat/contracts";
import { stateResultSchema } from "../wire";
import { send } from "./attempt";
import { generationSlotsFor, usernameReads } from "./generation-scope";
import { MAX_HINT_USERNAMES } from "./constants";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";

/**
 * The one matching account whose username the page shows in its header or navigation,
 * or, for an all-digit username, masked anywhere on the page (`showsMaskedNumber`), read
 * once, as ADR 0029's E2 reads it: each account's username is read from the vault,
 * sent to the page's content script for its comparison and dropped. Only items matching
 * the page's own URL count, and every one of them is compared, so two items with the
 * same username leave the page to the person. None when no account or more than one
 * matches, when the one that does asks for the master password on the page, when a vault
 * is unavailable or an item's URIs could not all be checked, when a username cannot be
 * read or the page does not answer, when more than `MAX_HINT_USERNAMES` accounts would be
 * read, or once `here` no longer finds the document on its path.
 */
export async function shownConfirmAccount(
  rt: Runtime,
  live: LiveDocument,
  here: () => LiveDocument | undefined,
): Promise<{ origin: string; connectionId: string; itemId: string } | undefined> {
  const scope = await generationSlotsFor(rt, live).catch(() => undefined);
  if (!scope?.complete) return undefined;
  const reads = usernameReads(rt, { ...scope, frameOnly: [] });
  if (!reads.length || reads.length > MAX_HINT_USERNAMES) return undefined;
  const shown: { connectionId: string; itemId: string }[] = [];
  // Serial reads through the shared vault host and of one page, as for E2.
  /* eslint-disable no-await-in-loop */
  for (const { connection, itemId, fieldId } of reads) {
    if (!here()) return undefined;
    let username = await rt
      .fields({
        account: { origin: live.document.origin, connectionId: connection.id, itemId },
        connection,
        fieldId,
      })
      .catch(() => undefined);
    // An account whose username could not be read may be the one the page shows.
    if (username === undefined) return undefined;
    if (!username) continue;
    const account: { username: string; masked: true } = { username, masked: true };
    username = "";
    const page = here();
    const answer =
      page && (await send(rt, page, { type: "login.state", account }).catch(() => undefined));
    account.username = "";
    const parsed = v.safeParse(stateResultSchema, answer);
    if (!parsed.success || !parsed.output.ok) return undefined;
    if (parsed.output.signs.username === true) shown.push({ connectionId: connection.id, itemId });
  }
  /* eslint-enable no-await-in-loop */
  const [one] = shown;
  if (shown.length !== 1 || !one || !here()) return undefined;
  const item = scope.items.find(
    (entry) => entry.connection.id === one.connectionId && entry.item.id === one.itemId,
  )?.item;
  if (!item || itemAsksForMasterPassword(scope.settings, item, live.url)) return undefined;
  return { origin: live.document.origin, ...one };
}
