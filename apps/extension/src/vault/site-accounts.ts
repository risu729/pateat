import {
  connectionUse,
  getItemEligibility,
  isFieldExcluded,
  siteAccountsRequestSchema,
  type LocalSettings,
  type SettingsRequest,
  type SettingsResponse,
  type SiteAccountsResponse,
} from "@pateat/contracts";
import * as v from "valibot";
import type { LoginFieldBatch } from "../login/vault";
import { passkeyOrigin, rpIdsFor } from "../passkeys/rp-id";
import { findVaultPasskeys, type PasskeyFinder } from "../passkeys/vault";
import { findLiveSiteCandidates, type LiveUriMatcher } from "./site-candidates";

export { rpIdsFor };

type Settings = Extract<SettingsResponse, { ok: true }>;

/**
 * Which items could be the default account for an origin under the given settings. The
 * login executor accepts a default only for an item whose provider URI rules match the
 * page (or whose static `allowedOrigins` include it), and a passkey request prefers it only
 * when it holds a passkey for the request's RP ID, so only those items are listed. URI
 * rules are matched for `origin/`; a rule for a deeper path is not evaluated here.
 */
export async function findSiteAccounts(input: {
  saved: Settings;
  /**
   * The settings page's draft decides which connections and items are searched; it grants
   * nothing, and a username is read only under the saved settings.
   */
  settings: LocalSettings;
  origin: string;
  matchUris: LiveUriMatcher;
  findPasskeys: PasskeyFinder;
  /** Resolves matched live items' fields under the saved settings; never the demo vaults. */
  readFields?: LoginFieldBatch;
}): Promise<SiteAccountsResponse> {
  const { settings } = input;
  const { catalog } = input.saved;
  const accounts = new Map<
    string,
    { connectionId: string; itemId: string; uri: boolean; passkey: boolean; username?: string }
  >();
  const add = (connectionId: string, itemId: string, via: "uri" | "passkey") => {
    const key = JSON.stringify([connectionId, itemId]);
    const entry = accounts.getOrInsertComputed(key, () => ({
      connectionId,
      itemId,
      uri: false,
      passkey: false,
    }));
    entry[via] = true;
  };
  let complete = true;

  for (const connection of catalog.connections) {
    if (connectionUse(settings, catalog, connection.id) === "disabled") continue;
    for (const item of connection.items)
      if (
        item.allowedOrigins.includes(input.origin) &&
        getItemEligibility(settings, catalog, connection.id, item.id).eligible
      )
        add(connection.id, item.id, "uri");
  }

  // Bundled demo connections hold static metadata only; only live vaults are queried.
  const live = {
    ...catalog,
    connections: catalog.connections.filter((entry) => entry.provider !== "dummy"),
  };
  const uris = await findLiveSiteCandidates({
    settings,
    catalog: live,
    url: `${input.origin}/`,
    match: input.matchUris,
  });
  if (!uris.ok) return { version: 1, ok: false, reason: "invalid-request" };
  for (const entry of uris.candidates) add(entry.connectionId, entry.itemId, "uri");
  // An item whose rules could not be evaluated may still match; never report "no match".
  if (uris.unavailableConnections.length || uris.incompleteItems.length) complete = false;

  const view: Settings = {
    ...input.saved,
    snapshot: { ...input.saved.snapshot, settings },
    catalog: live,
  };
  // Passkeys answer only on HTTPS pages and `http://localhost`; any other `http:` page lists
  // only its URI matches (ADR 0050).
  const rpIds = passkeyOrigin(input.origin) ? rpIdsFor(input.origin) : [];
  for (const rpId of rpIds) {
    // Sequential: each query shares the bounded native host.
    // eslint-disable-next-line no-await-in-loop
    const found = await findVaultPasskeys({
      saved: view,
      origin: input.origin,
      rpId,
      find: input.findPasskeys,
    }).catch(() => undefined);
    if (!found) {
      complete = false;
      continue;
    }
    if (!found.complete) complete = false;
    for (const entry of found.candidates) add(entry.connectionId, entry.itemId, "passkey");
  }
  // Only matched items, so same-named items can be told apart; no other value is read. They
  // are read together, so the settings and each vault are checked once for all of them.
  if (input.readFields) {
    const read = [];
    for (const account of accounts.values()) {
      const connection = live.connections.find((entry) => entry.id === account.connectionId);
      const excluded = isFieldExcluded(
        settings,
        catalog,
        account.connectionId,
        account.itemId,
        "login.username",
      );
      if (connection && !excluded) read.push({ account, connection });
    }
    const usernames = read.length
      ? await input
          .readFields(
            read.map(({ account, connection }) => ({
              account: {
                origin: input.origin,
                connectionId: account.connectionId,
                itemId: account.itemId,
              },
              connection,
              fieldId: "login.username",
            })),
          )
          .catch(() => [])
      : [];
    for (const [index, { account }] of read.entries()) {
      const username = usernames[index];
      if (username) account.username = username.slice(0, 1024);
    }
  }
  return { version: 1, ok: true, origin: input.origin, accounts: [...accounts.values()], complete };
}

/** Answers `settings.site-accounts` from the settings page or the toolbar popup; callers check the sender. */
export function createSiteAccountsHandler(options: {
  settings: { handle(request: SettingsRequest): Promise<SettingsResponse> };
  matchUris: LiveUriMatcher;
  findPasskeys: PasskeyFinder;
  readFields?: LoginFieldBatch;
}) {
  const answer = async (message: unknown): Promise<SiteAccountsResponse> => {
    const request = v.safeParse(siteAccountsRequestSchema, message);
    if (!request.success) return { version: 1, ok: false, reason: "invalid-request" };
    // A username read while the settings change is refused, so a search that a save
    // overlapped, such as a login saving its picked account as the default, misses that
    // username; a search with a missed read while the settings changed is made again, at
    // most twice.
    for (let attempt = 0; ; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each search reads the settings anew
      const saved = await options.settings.handle({ version: 1, type: "settings.get" });
      if (!saved.ok) return { version: 1, ok: false, reason: "unavailable" };
      const { readFields } = options;
      let missed = false;
      // oxlint-disable-next-line no-await-in-loop -- searches run one after another
      const found = await findSiteAccounts({
        saved,
        settings: request.output.settings,
        origin: request.output.origin,
        matchUris: options.matchUris,
        findPasskeys: options.findPasskeys,
        ...(readFields
          ? {
              readFields: (fields) =>
                readFields(fields).then(
                  (values) => {
                    if (values.some((value) => value === undefined)) missed = true;
                    return values;
                  },
                  (error: unknown) => {
                    missed = true;
                    throw error;
                  },
                ),
            }
          : {}),
      });
      if (attempt === 2 || !missed) return found;
      // oxlint-disable-next-line no-await-in-loop -- compares with the settings searched
      const latest = await options.settings.handle({ version: 1, type: "settings.get" });
      if (!latest.ok || latest.snapshot.revision === saved.snapshot.revision) return found;
    }
  };
  // A vault's crypto Worker takes one job at a time, so concurrent lookups (one per saved
  // default, plus the picker) would refuse each other; answer them one after another.
  let queue: Promise<unknown> = Promise.resolve();
  return (message: unknown): Promise<SiteAccountsResponse> => {
    const run = queue.then(() => answer(message));
    queue = run.catch(() => undefined);
    return run;
  };
}
