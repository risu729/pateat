import {
  normalizeHostname,
  parseSiteUrl,
  type LocalSettings,
  type SiteDefault,
  type SiteRule,
  type VaultCatalog,
  type VaultItemMetadata,
} from "./schema";
import { getItemEligibility, type EligibilityReason } from "./vault-policy";

/** Whether a site rule covers a canonical hostname: its own, or a subdomain's if included. */
export function siteRuleCovers(rule: SiteRule, hostname: string): boolean {
  return (
    hostname === rule.hostname || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`))
  );
}

/**
 * Whether Pateat runs on a page at all: an HTTP(S) URL whose hostname policy inputs accept.
 * Exclusion rules do not decide this; they pause automatic login (ADR 0062). The allowed
 * sites do: see `isSiteAllowed`.
 */
export function isSupportedSite(value: string): boolean {
  const url = parseSiteUrl(value);
  return Boolean(url && normalizeHostname(url.hostname));
}

/**
 * Whether an exclusion rule covers the page, or the page is not one Pateat runs on. A rule
 * pauses automatic login of the site until it is removed (ADR 0062).
 */
export function isSiteExcluded(
  settings: Pick<LocalSettings, "excludedSites">,
  value: string,
): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  // Invalid destinations are blocked, never treated as a permission grant.
  if (!hostname) return true;
  return settings.excludedSites.some((site) => siteRuleCovers(site, hostname));
}

type AllowedSites = Pick<LocalSettings, "allowedSites" | "allowedSitesEnabled">;

/** Whether the allowed sites are on, which limits Pateat to them (ADR 0077). */
export function allowlistOn(settings: AllowedSites): boolean {
  return settings.allowedSitesEnabled === true;
}

/**
 * Whether the allowed sites let automatic login run on a page (ADR 0077): it is a page
 * Pateat runs on and, while they are on, one of them covers it. A page they leave out is
 * paused as an exclusion pauses it (ADR 0062): what the person starts still runs.
 */
export function isSiteAllowed(settings: AllowedSites, value: string): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  if (!hostname) return false;
  return (
    !allowlistOn(settings) ||
    (settings.allowedSites ?? []).some((site) => siteRuleCovers(site, hostname))
  );
}

/**
 * How the site rules treat a URL, for what a page says: `invalid` for a URL Pateat does
 * not run on, `excluded` (paused, ADR 0062) when an exclusion covers it, `not-allowed`
 * (paused too, ADR 0077) while the allowed sites are on and none covers it, else
 * `allowed`.
 */
export function siteAccess(
  settings: Pick<LocalSettings, "excludedSites"> & AllowedSites,
  value: string,
): "allowed" | "excluded" | "not-allowed" | "invalid" {
  if (!isSupportedSite(value)) return "invalid";
  if (isSiteExcluded(settings, value)) return "excluded";
  return isSiteAllowed(settings, value) ? "allowed" : "not-allowed";
}

/**
 * Whether Pateat asks for the master password on this page's site before it fills or
 * signs with an item that has Bitwarden's re-prompt. An invalid URL asks, so a doubt
 * never skips the question.
 */
export function asksForMasterPassword(settings: LocalSettings, value: string): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  if (!hostname) return true;
  return settings.repromptSites.some((site) => siteRuleCovers(site, hostname));
}

/** Whether an item has to wait for the master password on this page's site. */
export function itemAsksForMasterPassword(
  settings: LocalSettings,
  item: Pick<VaultItemMetadata, "reprompt"> | undefined,
  value: string,
): boolean {
  return item?.reprompt === true && asksForMasterPassword(settings, value);
}

/**
 * Whether Pateat hands every passkey request of this page's exact hostname on to the
 * browser (ADR 0007). An invalid destination is handed on too.
 */
export function isPasskeyBrowserSite(settings: LocalSettings, value: string): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  if (!hostname) return true;
  return settings.passkeyBrowserSites.some((site) => site.hostname === hostname);
}

export type SiteAccountResolution =
  | { ok: true; origin: string; connectionId: string; itemId: string; fieldIds: string[] }
  | {
      ok: false;
      reason:
        | "invalid-url"
        | "default-not-set"
        | "item-origin-mismatch"
        | "account-ambiguous"
        | "vault-unavailable"
        | EligibilityReason;
    };

export type SiteDefaultConnection =
  | { ok: true; connectionId: string }
  | { ok: false; reason: "connection-missing" | "account-ambiguous" | "vault-unavailable" };

/**
 * The local connection a saved site default names: the one catalog connection of that
 * provider account. An account connected twice is ambiguous, and so is one whose user ID
 * is connected here only on another server (ADR 0023). With no match while a connection of
 * that provider cannot name its account (locked or unavailable), the vault is unavailable
 * rather than the account missing.
 */
export function siteDefaultConnection(
  entry: Pick<SiteDefault, "provider" | "server" | "userId">,
  catalog: VaultCatalog,
): SiteDefaultConnection {
  const sameProvider = catalog.connections.filter(
    (connection) => connection.provider === entry.provider,
  );
  const sameUser = sameProvider.filter((connection) => connection.userId === entry.userId);
  const matches = sameUser.filter((connection) => connection.server === entry.server);
  if (matches.length > 1 || (!matches.length && sameUser.length))
    return { ok: false, reason: "account-ambiguous" };
  if (matches[0]) return { ok: true, connectionId: matches[0].id };
  return sameProvider.some((connection) => connection.userId === undefined)
    ? { ok: false, reason: "vault-unavailable" }
    : { ok: false, reason: "connection-missing" };
}

/**
 * Pure next-login selection. This never switches a current browser session. An exclusion
 * rule does not refuse it: on a paused site only a popup pick logs in (ADR 0062).
 */
export function resolveSiteAccount(
  settings: LocalSettings,
  catalog: VaultCatalog,
  value: string,
): SiteAccountResolution {
  const url = parseSiteUrl(value);
  if (!url || !normalizeHostname(url.hostname)) return { ok: false, reason: "invalid-url" };
  // An exclusion rule only pauses automatic login, and a pick still logs in (ADR 0062), as
  // on a site outside the allowed sites (ADR 0077).
  const selected = settings.siteDefaults.find((entry) => entry.origin === url.origin);
  if (!selected) return { ok: false, reason: "default-not-set" };
  const connection = siteDefaultConnection(selected, catalog);
  if (!connection.ok) return { ok: false, reason: connection.reason };
  const { connectionId } = connection;
  const eligibility = getItemEligibility(settings, catalog, connectionId, selected.itemId);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  if (!eligibility.item.allowedOrigins.includes(url.origin))
    return { ok: false, reason: "item-origin-mismatch" };
  return {
    ok: true,
    origin: url.origin,
    connectionId,
    itemId: selected.itemId,
    fieldIds: eligibility.fieldIds,
  };
}
