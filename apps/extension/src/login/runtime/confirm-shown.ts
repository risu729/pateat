// The account a verification page shows, in a tab without Pateat's login (ADR 0035,
// amended 2026-11-22): the page is filled automatically only when it shows the username
// of exactly one of its matching accounts.
import * as v from "valibot";
import { itemAsksForMasterPassword } from "@pateat/contracts";
import { stateResultSchema } from "../wire";
import { send } from "./attempt";
import { generationSlotsFor, usernameReads } from "./generation-scope";
import { MAX_HINT_USERNAMES } from "./constants";
import { frameKey } from "./steps";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";

/**
 * The one matching account whose username `live` shows in its header or navigation, read
 * once, as ADR 0029's E2 reads it: each account's username is read from the vault, sent
 * to the page's content script for its comparison and dropped. Items that ask for the
 * master password on the page, items without a username and items matching only a
 * frame's URL never count. None when no account or more than one matches, when a vault
 * is unavailable or an item's URIs could not all be checked, when more than
 * `MAX_HINT_USERNAMES` accounts would be read, or when the page changed meanwhile.
 */
export async function shownConfirmAccount(
  rt: Runtime,
  live: LiveDocument,
): Promise<{ origin: string; connectionId: string; itemId: string } | undefined> {
  const scope = await generationSlotsFor(rt, live).catch(() => undefined);
  if (!scope?.complete) return undefined;
  const items = scope.items.filter(
    ({ item }) => !itemAsksForMasterPassword(scope.settings, item, live.url),
  );
  const reads = usernameReads(rt, { ...scope, items, frameOnly: [] });
  if (!reads.length || reads.length > MAX_HINT_USERNAMES) return undefined;
  const current = () => rt.documents.get(frameKey(live.document)) === live;
  const shown: { connectionId: string; itemId: string }[] = [];
  // Serial reads through the shared vault host and of one page, as for E2.
  /* eslint-disable no-await-in-loop */
  for (const { connection, itemId, fieldId } of reads) {
    if (!current()) return undefined;
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
    const account = { username };
    username = "";
    const answer = await send(rt, live, { type: "login.state", account }).catch(() => undefined);
    account.username = "";
    const parsed = v.safeParse(stateResultSchema, answer);
    if (!parsed.success || !parsed.output.ok) return undefined;
    if (parsed.output.signs.username === true) shown.push({ connectionId: connection.id, itemId });
  }
  /* eslint-enable no-await-in-loop */
  if (shown.length !== 1 || !current()) return undefined;
  return { origin: live.document.origin, ...shown[0]! };
}
