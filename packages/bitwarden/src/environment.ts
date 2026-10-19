import * as v from "valibot";

import { failure, type BitwardenResult } from "./errors";

/** Pinned server read compatibility, separate from Pateat's product version.
 * Device 2 is a Chrome extension; received records do not prove whole-vault coverage.
 * Types not implemented by the account mapper remain explicitly unavailable.
 */
export const BITWARDEN_READ_PROTOCOL = Object.freeze({
  clientVersion: "2026.2.0",
  deviceType: 2,
});

const profileSchema = v.strictObject({
  connectionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  environment: v.variant("kind", [
    v.strictObject({ kind: v.literal("cloud"), region: v.picklist(["us", "eu"]) }),
    v.strictObject({
      kind: v.literal("self-hosted"),
      baseUrl: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
    }),
  ]),
});

export type BitwardenProfile = Readonly<{
  connectionId: string;
  environment:
    | Readonly<{ kind: "cloud"; region: "us" | "eu" }>
    | Readonly<{ kind: "self-hosted"; baseUrl: string }>;
}>;

// Plain HTTP only for these hosts as typed, so the traffic stays on this machine (ADR 0059).
// Chrome's CSP cannot name an IPv6 literal such as [::1]; `localhost` reaches it.
const loopbackRoot = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/?$/i;

/** Trusted setup authorizes a single HTTPS root or a loopback HTTP root, never individual
 * service URLs. */
export function normalizeBitwardenProfile(input: unknown): BitwardenResult<BitwardenProfile> {
  const parsed = v.safeParse(profileSchema, input);
  if (!parsed.success) return failure("invalid-profile");
  const { connectionId, environment } = parsed.output;
  if (environment.kind === "cloud")
    return {
      ok: true,
      data: Object.freeze({ connectionId, environment: Object.freeze(environment) }),
    };

  const raw = environment.baseUrl;
  // Reject syntax which URL() would repair, including dot segments and encoded paths.
  if (!/^https?:\/\/[^/?#\\\s%@*]+\/?$/i.test(raw)) return failure("invalid-profile");
  const url = URL.parse(raw);
  if (!url) return failure("invalid-profile");
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackRoot.test(raw))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    return failure("invalid-profile");
  return {
    ok: true,
    data: Object.freeze({
      connectionId,
      environment: Object.freeze({ kind: "self-hosted" as const, baseUrl: url.origin }),
    }),
  };
}

export function bitwardenEndpoints(profile: BitwardenProfile): Readonly<{
  apiUrl: string;
  identityUrl: string;
}> {
  if (profile.environment.kind === "self-hosted")
    return Object.freeze({
      apiUrl: `${profile.environment.baseUrl}/api`,
      identityUrl: `${profile.environment.baseUrl}/identity`,
    });
  const suffix = profile.environment.region === "eu" ? "eu" : "com";
  return Object.freeze({
    apiUrl: `https://api.bitwarden.${suffix}`,
    identityUrl: `https://identity.bitwarden.${suffix}`,
  });
}
