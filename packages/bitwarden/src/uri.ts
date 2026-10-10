import { parse } from "tldts";
import * as v from "valibot";

import { failure, type BitwardenResult } from "./errors";

export interface UriMatchOptions {
  /** Effective setting/policy from the same trusted account as these decrypted URIs. */
  readonly defaultMatch?: 0 | 1 | 2 | 3 | 4 | 5 | null;
  /** Received sync domains DTO from that account/snapshot. No global list is fetched. */
  readonly domains?: unknown;
}

export interface UriMatchEvaluation {
  readonly matched: boolean;
  /** Descriptive only: matching never authorizes release to this origin. */
  readonly targetOrigin: string;
  readonly matches: readonly { readonly uriIndex: number; readonly match: 0 | 1 | 2 | 3 }[];
  readonly unavailableUris: readonly {
    readonly uriIndex: number;
    readonly reason: "unsupported-uri-match" | "unsupported-uri-scheme" | "invalid-uri";
  }[];
}

const maxUris = 1000;
const maxUrlLength = 8192;
const maxGroups = 1000;
const maxDomainMembers = 10_000;
const hostText = v.pipe(v.string(), v.minLength(1), v.maxLength(253));
const groupSchema = v.array(hostText);
const domainsSchema = v.object({
  equivalentDomains: v.nullable(v.array(groupSchema)),
  globalEquivalentDomains: v.nullable(
    v.array(
      v.object({
        type: v.pipe(v.number(), v.integer(), v.minValue(0)),
        domains: groupSchema,
        excluded: v.boolean(),
      }),
    ),
  ),
});
const optionsSchema = v.strictObject({
  defaultMatch: v.nullish(v.picklist([0, 1, 2, 3, 4, 5])),
  domains: v.optional(v.unknown()),
});
const uriSchema = v.object({
  uri: v.nullish(v.pipe(v.string(), v.maxLength(maxUrlLength))),
  match: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ambiguous = (value: string) => /\p{Cc}/u.test(value) || value.includes("\\");
const hasHostnameLabels = (hostname: string) =>
  hostname.startsWith("[") ||
  hostname
    .replace(/\.$/u, "")
    .split(".")
    .every((label) => label.length > 0);

function webUrl(value: string, allowBareHost: boolean): URL | undefined {
  if (!value || value.length > maxUrlLength || ambiguous(value)) return undefined;
  if (!allowBareHost && /\s/u.test(value)) return undefined;
  let candidate = value;
  if (allowBareHost) {
    candidate = candidate.trim();
    if (!candidate.includes("://") && candidate.includes(".")) candidate = `http://${candidate}`;
  }
  if (!/^https?:\/\/[^/]/iu.test(candidate)) return undefined;
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(candidate)?.[1];
  if (!authority || authority.includes("@")) return undefined;
  try {
    const url = new URL(candidate);
    if (url.username || url.password || !url.hostname || !hasHostnameLabels(url.hostname))
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function domainKey(url: URL): string | undefined {
  const hostname = url.hostname.replace(/\.$/u, "");
  // URL has already validated and canonicalized the address, including IPv6 brackets.
  if (hostname === "localhost" || hostname.startsWith("[")) return hostname;
  const result = parse(hostname, { extractHostname: false, allowPrivateDomains: true });
  return result.isIp ? hostname : (result.domain ?? undefined);
}

function equivalentHostname(value: string): string | undefined {
  if (value !== value.trim() || ambiguous(value) || /[/@?#]/u.test(value)) return undefined;
  try {
    const url = new URL(`https://${value}`);
    if (
      !url.hostname ||
      !hasHostnameLabels(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/"
    )
      return undefined;
    // Equivalent groups contain domain names, not service ports or URLs.
    if (!value.startsWith("[") && value.includes(":")) return undefined;
    return url.hostname.replace(/\.$/u, "");
  } catch {
    return undefined;
  }
}

function equivalentGroups(input: unknown): string[][] | undefined {
  if (input == null) return [];
  if (!isRecord(input)) return undefined;
  const user = input["equivalentDomains"];
  const global = input["globalEquivalentDomains"];
  if ((user !== null && !Array.isArray(user)) || (global !== null && !Array.isArray(global)))
    return undefined;
  if ((user?.length ?? 0) + (global?.length ?? 0) > maxGroups) return undefined;
  let total = 0;
  for (const group of [
    ...(user ?? []),
    ...(global ?? []).map((entry: unknown) => (isRecord(entry) ? entry["domains"] : undefined)),
  ]) {
    if (!Array.isArray(group)) return undefined;
    total += group.length;
    if (total > maxDomainMembers) return undefined;
  }
  const parsed = v.safeParse(domainsSchema, input);
  if (!parsed.success) return undefined;
  const groups = [
    ...(parsed.output.equivalentDomains ?? []),
    ...(parsed.output.globalEquivalentDomains ?? [])
      .filter((entry) => !entry.excluded)
      .map((entry) => entry.domains),
  ];
  const normalized: string[][] = [];
  for (const group of groups) {
    const values: string[] = [];
    for (const value of group) {
      const hostname = equivalentHostname(value);
      if (!hostname) return undefined;
      values.push(hostname);
    }
    normalized.push(values);
  }
  return normalized;
}

function matchingSettings(
  input: unknown,
): { defaultMatch: 0 | 1 | 2 | 3 | 4 | 5; groups: string[][] } | undefined {
  try {
    if (!isRecord(input)) return undefined;
    const parsed = v.safeParse(optionsSchema, input);
    if (!parsed.success) return undefined;
    const groups = equivalentGroups(parsed.output.domains);
    return groups ? { defaultMatch: parsed.output.defaultMatch ?? 0, groups } : undefined;
  } catch {
    return undefined;
  }
}

/** Provider matching is a candidate signal. Account/origin/document/field policy still gates filling. */
export function matchBitwardenLoginUris(
  uris: unknown,
  targetUrl: string,
  options: UriMatchOptions = {},
): BitwardenResult<UriMatchEvaluation> {
  try {
    if (!Array.isArray(uris) || uris.length > maxUris || typeof targetUrl !== "string")
      return failure("invalid-uri-input");
    const target = webUrl(targetUrl, false);
    if (!target) return failure("invalid-uri-input");
    const settings = matchingSettings(options);
    if (!settings) return failure("invalid-options");
    const targetDomain = domainKey(target);
    const equivalents = new Set<string>();
    if (targetDomain) {
      equivalents.add(targetDomain);
      // Deliberately direct membership only; overlapping groups do not create a transitive closure.
      for (const group of settings.groups)
        if (group.includes(targetDomain)) for (const domain of group) equivalents.add(domain);
    }
    const matches: { uriIndex: number; match: 0 | 1 | 2 | 3 }[] = [];
    const unavailableUris: {
      uriIndex: number;
      reason: "unsupported-uri-match" | "unsupported-uri-scheme" | "invalid-uri";
    }[] = [];
    uris.forEach((raw, uriIndex) => {
      const unavailable = (reason: (typeof unavailableUris)[number]["reason"]) =>
        unavailableUris.push({ uriIndex, reason });
      if (!isRecord(raw)) {
        unavailable("invalid-uri");
        return;
      }
      const parsed = v.safeParse(uriSchema, raw);
      if (!parsed.success) {
        unavailable("invalid-uri");
        return;
      }
      const match = parsed.output.match ?? settings.defaultMatch;
      if (match === 5) return;
      if (match !== 0 && match !== 1 && match !== 2 && match !== 3) {
        unavailable("unsupported-uri-match");
        return;
      }
      const stored = parsed.output.uri;
      if (!stored) {
        unavailable("invalid-uri");
        return;
      }
      const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(stored.trim())?.[1]?.toLowerCase();
      const bareHostPort =
        stored.trim().includes(".") && /^[^/?#:@]+:[0-9]+(?:[/?#]|$)/u.test(stored.trim());
      if (scheme && scheme !== "http" && scheme !== "https" && !bareHostPort) {
        unavailable("unsupported-uri-scheme");
        return;
      }
      const saved = webUrl(stored, true);
      if (!saved) {
        unavailable("invalid-uri");
        return;
      }
      let matched = false;
      switch (match) {
        case 0: {
          const savedDomain = domainKey(saved);
          matched = savedDomain !== undefined && equivalents.has(savedDomain);
          // Pinned client exception for user-authored Google scripts; other modes are explicit.
          if (savedDomain === "google.com" && target.host === "script.google.com") matched = false;
          break;
        }
        case 1:
          matched = saved.host === target.host;
          break;
        case 2:
          matched = targetUrl.startsWith(stored);
          break;
        case 3:
          matched = targetUrl === stored;
          break;
      }
      if (matched) matches.push({ uriIndex, match });
    });
    return {
      ok: true,
      data: { matched: matches.length > 0, targetOrigin: target.origin, matches, unavailableUris },
    };
  } catch {
    return failure("invalid-uri-input");
  }
}
