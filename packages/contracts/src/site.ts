import { parse } from "tldts";
import { normalizeHostname, type SiteRule } from "./settings/schema";
import { siteRuleCovers } from "./settings/site-policy";

/**
 * The registrable domain of an origin's host, as Bitwarden's Domain match compares it:
 * public and private suffixes from tldts, so each name under a private suffix such as
 * `github.io` is its own domain; the host itself for `localhost` or an IP address.
 * `undefined` for a bare public suffix or a value that is no URL.
 */
function siteKey(value: string): string | undefined {
  const url = URL.parse(value);
  if (!url) return undefined;
  const hostname = url.hostname.replace(/\.$/u, "");
  if (hostname === "localhost" || hostname.startsWith("[")) return hostname;
  const result = parse(hostname, { extractHostname: false, allowPrivateDomains: true });
  return result.isIp ? hostname : (result.domain ?? undefined);
}

/**
 * Whether a page of `pageOrigin` may stand for the result of a login that started on
 * `loginOrigin` after the tab moved there (ADR 0022): an HTTPS origin (or, for a login on
 * an `http:` origin, an HTTP one, ADR 0050) of the same registrable domain, such as `https://pc.moppy.jp` for `https://ssl.pc.moppy.jp`, or,
 * right after a second factor (`afterSecondFactor`: a TOTP code, or a passkey once the
 * password was sent), such an origin of any site, such as `https://m365.cloud.microsoft`
 * for `https://login.microsoftonline.com` (owner's choices on 2026-10-13). The
 * extension's move check, the service's judge and the markers learned there all use this
 * one rule, so a later widening changes it here.
 */
export function loginMoveFits(
  loginOrigin: string,
  pageOrigin: string,
  afterSecondFactor: boolean,
): boolean {
  if (
    !pageOrigin.startsWith("https://") &&
    !(pageOrigin.startsWith("http://") && loginOrigin.startsWith("http://"))
  )
    return false;
  if (afterSecondFactor) return siteKey(pageOrigin) !== undefined;
  const site = siteKey(loginOrigin);
  return site !== undefined && siteKey(pageOrigin) === site;
}

/**
 * The registrable site a pause of `origin` covers (ADR 0062): its registrable domain, as
 * the extension's popup pauses it with its subdomains. `undefined` for a bare public suffix
 * or a value that is no URL.
 */
export function registrableSite(origin: string): string | undefined {
  return siteKey(origin);
}

/**
 * The permanent pause of a validated HTTP(S) origin (ADR 0062). A pause covers its
 * registrable site and subdomains; Resume removes only covering rules within that
 * site. Broader rules also cover other sites, so they stay for the settings page.
 * Transforms take the latest list, which may have changed since the policy was shown.
 */
export function sitePauseRules(excludedSites: readonly SiteRule[], origin: string) {
  const url = new URL(origin);
  const hostname = normalizeHostname(url.hostname) ?? url.hostname;
  const site = registrableSite(origin) ?? hostname;
  const covers = (rule: SiteRule) => siteRuleCovers(rule, hostname);
  const within = (rule: SiteRule) => rule.hostname === site || rule.hostname.endsWith(`.${site}`);
  const rules = excludedSites.filter(covers);
  return {
    site,
    rules,
    shared: rules.filter((rule) => !within(rule)),
    pause: (latest: readonly SiteRule[]): SiteRule[] => [
      ...latest.filter((rule) => rule.hostname !== site),
      { hostname: site, includeSubdomains: true },
    ],
    resume: (latest: readonly SiteRule[]): SiteRule[] =>
      latest.filter((rule) => !(covers(rule) && within(rule))),
  };
}
