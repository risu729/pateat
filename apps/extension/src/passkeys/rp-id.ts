import { getPublicSuffix } from "tldts";

export type RpIdResult =
  | { readonly ok: true; readonly rpId: string }
  | {
      readonly ok: false;
      readonly reason: "invalid-origin" | "invalid-rp-id" | "rp-id-mismatch";
    };

const suffixOptions = { allowPrivateDomains: true } as const;
const canonicalDomain =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

/**
 * Accept only an `https:` origin or `http://localhost`, whose host is a canonical ASCII domain.
 * WebAuthn rejects IP addresses; trailing-dot hosts are left to the browser.
 */
export function effectiveDomain(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost"))
    return undefined;
  const host = url.hostname;
  if (!canonicalDomain.test(host) || ipv4.test(host)) return undefined;
  return host;
}

/**
 * WebAuthn RP ID admission for a caller origin. An explicit RP ID must already be canonical and be
 * equal to the effective domain or a registrable domain suffix of it, using the Public Suffix List
 * including private suffixes. Related origin requests are not evaluated and therefore fail here.
 */
export function resolveRpId(origin: string, requested?: unknown): RpIdResult {
  const host = effectiveDomain(origin);
  if (!host) return { ok: false, reason: "invalid-origin" };
  if (requested === undefined) return { ok: true, rpId: host };
  if (typeof requested !== "string" || !canonicalDomain.test(requested) || ipv4.test(requested))
    return { ok: false, reason: "invalid-rp-id" };
  if (requested === host) return { ok: true, rpId: requested };
  if (!host.endsWith(`.${requested}`)) return { ok: false, reason: "rp-id-mismatch" };
  const requestedSuffix = getPublicSuffix(requested, suffixOptions);
  const hostSuffix = getPublicSuffix(host, suffixOptions);
  if (!requestedSuffix || !hostSuffix) return { ok: false, reason: "rp-id-mismatch" };
  // HTML: reject a public suffix itself, or any suffix of the origin's public suffix.
  if (requestedSuffix === requested || `.${hostSuffix}`.endsWith(`.${requested}`))
    return { ok: false, reason: "rp-id-mismatch" };
  return { ok: true, rpId: requested };
}
