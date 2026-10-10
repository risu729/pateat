import * as v from "valibot";
import { fromBase64Url, toBase64Url } from "./encoding";
import type { PasskeyPolicy } from "./policy";
import { resolveRpId } from "./rp-id";

const MIN_CHALLENGE_BYTES = 16;
const MAX_CHALLENGE_BYTES = 1024;
const MAX_CREDENTIAL_ID_BYTES = 1023;
export const MAX_ALLOW_CREDENTIALS = 64;

const bytes = (minimum: number, maximum: number) =>
  v.pipe(
    v.string(),
    v.maxLength(Math.ceil((maximum * 4) / 3)),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const decoded = fromBase64Url(dataset.value);
      if (!decoded || decoded.length < minimum || decoded.length > maximum) {
        addIssue({ message: "Invalid base64url bytes" });
        return NEVER;
      }
      return decoded;
    }),
  );
const shortText = v.pipe(v.string(), v.maxLength(64));

/**
 * Bounded, page-supplied snapshot of `navigator.credentials.get({ publicKey })` options. The bridge
 * copies only these members: `timeout`, `hints` and `extensions` are dropped before relaying,
 * because Pateat neither waits on the caller's timeout nor interprets hints or extensions. A
 * snapshot with any other member is malformed and delegates.
 */
export const bridgedGetRequestSchema = v.strictObject({
  challenge: bytes(MIN_CHALLENGE_BYTES, MAX_CHALLENGE_BYTES),
  rpId: v.optional(v.pipe(v.string(), v.maxLength(253))),
  allowCredentials: v.pipe(
    v.array(
      v.strictObject({
        type: shortText,
        id: bytes(1, MAX_CREDENTIAL_ID_BYTES),
        transports: v.optional(v.pipe(v.array(shortText), v.maxLength(16))),
      }),
    ),
    v.maxLength(MAX_ALLOW_CREDENTIALS),
  ),
  userVerification: v.optional(shortText),
  mediation: v.optional(shortText),
});
export type BridgedGetRequest = v.InferInput<typeof bridgedGetRequestSchema>;

export type DelegationReason =
  | "invalid-request"
  | "unsupported-mediation"
  | "user-verification-required"
  | "invalid-origin"
  | "invalid-rp-id"
  | "rp-id-mismatch"
  | "external-transports-only"
  | "no-user-activation";

export interface AdmittedGetRequest {
  readonly origin: string;
  readonly rpId: string;
  readonly challenge: Uint8Array;
  /** Allowed public-key credential IDs as unpadded base64url; empty for discoverable requests. */
  readonly allowCredentialIds: readonly string[];
  /** Whether the assertion sets UV, as the policy decided at admission. */
  readonly userVerified: boolean;
}

export type Admission =
  | { readonly kind: "claim"; readonly request: AdmittedGetRequest }
  | { readonly kind: "delegate"; readonly reason: DelegationReason };

/**
 * Decide whether Pateat may answer a request. Origin is browser-supplied; every other input is
 * page data. Anything not explicitly supported delegates to the browser's own implementation.
 * The policy decides whether a gesture or UV requirement limits admission.
 */
export function admitGetRequest(input: {
  readonly origin: string;
  readonly request: unknown;
  readonly userActivation: boolean;
  readonly policy: PasskeyPolicy;
}): Admission {
  // Gates compare against the permissive value so an unknown stored setting fails closed.
  const parsed = v.safeParse(bridgedGetRequestSchema, input.request);
  if (!parsed.success) return { kind: "delegate", reason: "invalid-request" };
  const request = parsed.output;
  if (request.mediation !== undefined && request.mediation !== "optional")
    return { kind: "delegate", reason: "unsupported-mediation" };
  if (request.userVerification === "required" && input.policy.verification !== "always")
    return { kind: "delegate", reason: "user-verification-required" };
  const rpId = resolveRpId(input.origin, request.rpId);
  if (!rpId.ok) return { kind: "delegate", reason: rpId.reason };
  // Unknown descriptor types are skipped, as the client algorithm requires.
  const allowed = request.allowCredentials.filter((entry) => entry.type === "public-key");
  if (request.allowCredentials.length > 0 && allowed.length === 0)
    return { kind: "delegate", reason: "invalid-request" };
  // Synced vault credentials are internal (or hybrid) authenticators. A list naming only other
  // transports cannot be satisfied here.
  if (
    allowed.length > 0 &&
    allowed.every(
      (entry) =>
        entry.transports !== undefined &&
        entry.transports.length > 0 &&
        !entry.transports.includes("internal") &&
        !entry.transports.includes("hybrid"),
    )
  )
    return { kind: "delegate", reason: "external-transports-only" };
  if (input.policy.presence !== "always" && !input.userActivation)
    return { kind: "delegate", reason: "no-user-activation" };
  return {
    kind: "claim",
    request: Object.freeze({
      origin: input.origin,
      rpId: rpId.rpId,
      challenge: request.challenge,
      allowCredentialIds: Object.freeze(allowed.map((entry) => toBase64Url(entry.id))),
      userVerified: input.policy.verification === "always",
    }),
  };
}
