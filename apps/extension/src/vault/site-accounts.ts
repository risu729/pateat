import {
  getItemEligibility,
  isSiteExcluded,
  siteAccountsRequestSchema,
  type SettingsRequest,
  type SettingsResponse,
  type SiteAccountsResponse,
} from "@pateat/contracts";
import * as v from "valibot";
import { findLiveSiteCandidates, type LiveUriMatcher } from "./site-candidates";

type Settings = Extract<SettingsResponse, { ok: true }>;
/** Passkeys stored for one RP ID, as the passkey runtime finds them for a page origin. */
export type SitePasskeyFinder = (
  origin: string,
  rpId: string,
) => Promise<
  { candidates: readonly { connectionId: string; itemId: string }[]; complete: boolean } | undefined
>;

/** RP IDs a page on this host may use: the host itself and each parent domain. */
export function rpIdsFor(hostname: string): string[] {
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith("[")) return [hostname];
  const labels = hostname.split(".");
  return labels.slice(0, -1).map((_label, index) => labels.slice(index).join("."));
}

/**
 * Which items could be the saved default account for an origin, under the saved settings.
 * The login executor accepts a default only for an item whose provider URI rules match the
 * page (or whose static `allowedOrigins` include it), and a passkey request prefers it only
 * when it holds a passkey for the request's RP ID, so no other item is offered. Matching
 * uses `origin/`; rules for a deeper path are not evaluated here.
 */
export async function findSiteAccounts(input: {
  saved: Settings;
  origin: string;
  matchUris: LiveUriMatcher;
  findPasskeys: SitePasskeyFinder;
}): Promise<SiteAccountsResponse> {
  const { settings } = input.saved.snapshot;
  const { catalog } = input.saved;
  if (isSiteExcluded(settings, input.origin))
    return { version: 1, ok: false, reason: "site-excluded" };
  const accounts = new Map<
    string,
    { connectionId: string; itemId: string; uri: boolean; passkey: boolean }
  >();
  const add = (connectionId: string, itemId: string, via: "uri" | "passkey") => {
    const key = JSON.stringify([connectionId, itemId]);
    const entry = accounts.get(key) ?? { connectionId, itemId, uri: false, passkey: false };
    entry[via] = true;
    accounts.set(key, entry);
  };
  let complete = true;

  for (const connection of catalog.connections) {
    const configured = settings.connections.find((entry) => entry.connectionId === connection.id);
    if (!configured?.enabled) continue;
    for (const item of connection.items)
      if (
        item.allowedOrigins.includes(input.origin) &&
        getItemEligibility(settings, catalog, connection.id, item.id).eligible
      )
        add(connection.id, item.id, "uri");
  }

  const live = await findLiveSiteCandidates({
    settings,
    catalog,
    url: `${input.origin}/`,
    match: input.matchUris,
  });
  if (!live.ok)
    return {
      version: 1,
      ok: false,
      reason: live.reason === "site-excluded" ? "site-excluded" : "invalid-request",
    };
  for (const entry of live.candidates) add(entry.connectionId, entry.itemId, "uri");
  // Bundled demo connections hold static metadata only; they never answer URI queries.
  const provider = (connectionId: string) =>
    catalog.connections.find((entry) => entry.id === connectionId)?.provider;
  if (live.unavailableConnections.some((entry) => provider(entry.connectionId) === "bitwarden"))
    complete = false;

  for (const rpId of rpIdsFor(new URL(input.origin).hostname)) {
    // Sequential: each query shares the bounded native host.
    // eslint-disable-next-line no-await-in-loop
    const found = await input.findPasskeys(input.origin, rpId).catch(() => undefined);
    if (!found) {
      complete = false;
      continue;
    }
    if (!found.complete) complete = false;
    for (const entry of found.candidates) add(entry.connectionId, entry.itemId, "passkey");
  }
  return { version: 1, ok: true, origin: input.origin, accounts: [...accounts.values()], complete };
}

/** Answers `settings.site-accounts` from the settings page; callers check the sender. */
export function createSiteAccountsHandler(options: {
  settings: { handle(request: SettingsRequest): Promise<SettingsResponse> };
  matchUris: LiveUriMatcher;
  findPasskeys: SitePasskeyFinder;
}) {
  return async (message: unknown): Promise<SiteAccountsResponse> => {
    const request = v.safeParse(siteAccountsRequestSchema, message);
    if (!request.success) return { version: 1, ok: false, reason: "invalid-request" };
    const saved = await options.settings.handle({ version: 1, type: "settings.get" });
    if (!saved.ok) return { version: 1, ok: false, reason: "unavailable" };
    return findSiteAccounts({
      saved,
      origin: request.output.origin,
      matchUris: options.matchUris,
      findPasskeys: options.findPasskeys,
    });
  };
}
