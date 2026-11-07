

import {
  getItemEligibility,
  normalizeHostname,
  siteDefaultConnection,
  type LocalSettings,
  type SiteAccountsResponse,
  type SiteDefault,
  type VaultCatalog,
} from "@pateat/contracts";

import { unavailableReason } from "./unavailable-reason";

type ExcludedSite = LocalSettings["excludedSites"][number];

export type SiteAccountOption = {
  connectionId: string;
  connectionLabel: string;
  provider: string;
  server: string;
  userId: string | undefined;
  itemId: string;
  itemName: string;
  uri: boolean;
  passkey: boolean;
  value: string;
  /** The item name, then the login username when it matched, then an ID prefix if still ambiguous. */
  label: string;
};

/** Whether the draft lets an item be used at all; a passkey-only item has no fields. */
export function draftAllows(
  draft: LocalSettings,
  catalog: VaultCatalog,
  connectionId: string,
  itemId: string,
) {
  const connection = catalog.connections.find((entry) => entry.id === connectionId);
  if (connection?.quarantinedItemIds?.includes(itemId)) return false;
  const eligibility = getItemEligibility(draft, catalog, connectionId, itemId);
  return (
    eligibility.eligible ||
    (eligibility.reason === "fields-excluded" &&
      connection?.items.find((entry) => entry.id === itemId)?.fields.length === 0)
  );
}

/**
 * Matched items that are still in the catalog, matched ones first, each group in catalog
 * order. With `all`, every other item the draft allows is listed too, for a URI rule on a
 * deeper path that `origin/` does not match.
 */
export function siteAccountOptions(
  catalog: VaultCatalog,
  found: Extract<SiteAccountsResponse, { ok: true }> | undefined,
  all: boolean,
  draft: LocalSettings,
): SiteAccountOption[] {
  if (!found) return [];
  const options = catalog.connections.flatMap((connection) =>
    connection.items.flatMap((item) => {
      const match = found.accounts.find(
        (entry) => entry.connectionId === connection.id && entry.itemId === item.id,
      );
      return match || (all && draftAllows(draft, catalog, connection.id, item.id))
        ? [
            {
              connectionId: connection.id,
              connectionLabel: connection.label,
              provider: connection.provider,
              server: connection.server,
              userId: connection.userId,
              itemId: item.id,
              itemName: item.label,
              uri: match?.uri ?? false,
              passkey: match?.passkey ?? false,
              value: JSON.stringify([connection.id, item.id]),
              label: match?.username ? `${item.label} · ${match.username}` : item.label,
            },
          ]
        : [];
    }),
  );
  options.sort(
    (left, right) => Number(right.uri || right.passkey) - Number(left.uri || left.passkey),
  );
  const seen = new Map<string, number>();
  for (const option of options) {
    const key = JSON.stringify([option.connectionId, option.label]);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return options.map((option) =>
    (seen.get(JSON.stringify([option.connectionId, option.label])) ?? 0) > 1
      ? { ...option, label: `${option.label} · ID ${option.itemId.slice(0, 8)}` }
      : option,
  );
}

export function matchedBy(option: Pick<SiteAccountOption, "uri" | "passkey">): string {
  if (option.uri && option.passkey) return "URI and passkey";
  if (option.uri) return "URI";
  return option.passkey ? "passkey" : "no match for this origin";
}

/** The select value that removes an origin's default. */
export const NO_DEFAULT = "";
/** The select value of a saved default that no connection here names. */
export const SAVED_ELSEWHERE = "saved";

/**
 * The default an option makes for an origin, or why it cannot be saved. A default names the
 * account, so it must lead back to the chosen connection.
 */
export function defaultFor(
  origin: string,
  option: SiteAccountOption | undefined,
  catalog: VaultCatalog,
): { ok: true; value: SiteDefault } | { ok: false; message: string } {
  const userId = option?.userId;
  if (!option || !userId) return { ok: false, message: "Choose an available default account." };
  const value = {
    origin,
    provider: option.provider,
    server: option.server,
    userId,
    itemId: option.itemId,
    itemName: option.itemName,
    accountName: option.connectionLabel,
  };
  const mapped = siteDefaultConnection(value, catalog);
  if (!mapped.ok || mapped.connectionId !== option.connectionId)
    return {
      ok: false,
      message: unavailableReason(mapped.ok ? "account-ambiguous" : mapped.reason),
    };
  return { ok: true, value };
}

export function replaceDefault(settings: LocalSettings, origin: string, value?: SiteDefault) {
  settings.siteDefaults = settings.siteDefaults.filter((entry) => entry.origin !== origin);
  if (value) settings.siteDefaults.push(value);
}

/** The hostname an exclusion rule names for an origin, without a trailing dot. */
export function hostOf(origin: string): string {
  const hostname = new URL(origin).hostname;
  return normalizeHostname(hostname) ?? hostname;
}

export function ruleMatches(rule: ExcludedSite, origin: string): boolean {
  const hostname = hostOf(origin);
  return (
    hostname === rule.hostname || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`))
  );
}

/** The rule a default is listed under: the most specific of the rules that exclude it. */
export function ruleFor(rules: ExcludedSite[], origin: string): ExcludedSite | undefined {
  return rules
    .filter((rule) => ruleMatches(rule, origin))
    .sort(
      (left, right) =>
        right.hostname.length - left.hostname.length ||
        Number(left.includeSubdomains) - Number(right.includeSubdomains),
    )[0];
}

