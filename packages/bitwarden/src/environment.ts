import * as v from "valibot";

import { failure, type BitwardenResult } from "./errors";

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

/** Trusted setup authorizes a single ordinary HTTPS root, never individual service URLs. */
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
  if (!/^https:\/\/[^/?#\\\s%@]+\/?$/i.test(raw)) return failure("invalid-profile");
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
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
  } catch {
    return failure("invalid-profile");
  }
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
