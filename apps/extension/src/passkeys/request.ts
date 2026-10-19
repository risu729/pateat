import * as v from "valibot";
import { fromBase64Url, toBase64Url } from "./encoding";
import type { PasskeyPolicy } from "./policy";
import { resolveRpId } from "./rp-id";

const MIN_CHALLENGE_BYTES = 16;
// WebAuthn sets no upper bound. Google's sign-in asks with 2,056 bytes (2026-10-12), so this
// takes the page's own copy limit, which still fits the reply's client data bound.
const MAX_CHALLENGE_BYTES = 4096;
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
 * One bridged `PublicKeyCredentialDescriptor`, as the bridge snapshots `allowCredentials`
 * and `excludeCredentials`: the ID as base64url, decoded here.
 */
export const credentialDescriptorSchema = v.strictObject({
  type: shortText,
  id: bytes(1, MAX_CREDENTIAL_ID_BYTES),
  transports: v.optional(v.pipe(v.array(shortText), v.maxLength(16))),
});

/**
 * Bounded, page-supplied snapshot of `navigator.credentials.get({ publicKey })` options. The bridge
 * copies only these members: `hints` and `extensions` are dropped before relaying, because Pateat
 * does not interpret them. `timeout` only shortens how long the chooser window may wait
 * (ADR 0021). A snapshot with any other member is malformed and delegates.
 */
export const bridgedGetRequestSchema = v.strictObject({
  challenge: bytes(MIN_CHALLENGE_BYTES, MAX_CHALLENGE_BYTES),
  rpId: v.optional(v.pipe(v.string(), v.maxLength(253))),
  allowCredentials: v.pipe(v.array(credentialDescriptorSchema), v.maxLength(MAX_ALLOW_CREDENTIALS)),
  userVerification: v.optional(shortText),
  mediation: v.optional(shortText),
  uiMode: v.optional(v.literal("immediate")),
  timeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xff_ff_ff_ff))),
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
  | "immediate-allow-credentials"
  | "no-user-activation";

export interface AdmittedGetRequest {
  readonly origin: string;
  readonly rpId: string;
  readonly challenge: Uint8Array;
  /** Allowed public-key credential IDs as unpadded base64url; empty for discoverable requests. */
  readonly allowCredentialIds: readonly string[];
  /** Whether the assertion sets UV, as the policy decided at admission. */
  readonly userVerified: boolean;
  /** The caller's `timeout` in milliseconds, when it gave one. */
  readonly timeoutMs?: number;
  /**
   * The request waits for an autofill choice (`conditional` mediation). It is answered
   * only through a login's `passkey` route (ADR 0034).
   */
  readonly conditional?: true;
  /**
   * Chrome Immediate UI (ADR 0052): answered as a modal request, but only with a user gesture
   * and in a focused, active document outside incognito, where Chrome would answer it.
   */
  readonly immediate?: true;
}

export type Admission =
  | { readonly kind: "claim"; readonly request: AdmittedGetRequest }
  | { readonly kind: "delegate"; readonly reason: DelegationReason };

/** Snapshot members a report may name, in the log's lowercase form; page keys never are. */
const REPORTED_MEMBERS = new Map([
  ["challenge", "challenge"],
  ["rpId", "rp-id"],
  ["allowCredentials", "allow-credentials"],
  ["userVerification", "user-verification"],
  ["mediation", "mediation"],
  ["uiMode", "ui-mode"],
  ["timeout", "timeout"],
]);
const REPORTED_DESCRIPTOR_MEMBERS = new Map([
  ["type", "type"],
  ["id", "id"],
  ["transports", "transports"],
]);

/** Which member of a request delegated as `invalid-request` broke its bounds, without its value. */
export interface InvalidRequestReport {
  /** The member, such as `challenge` or `allow-credentials.id`; `other` for an unknown one. */
  readonly member: string;
  /** Its size: bytes for a base64url member (counted from its text), items for a list. */
  readonly length?: number;
}

/** The snapshot member a schema issue's path names, or `other` for any page key outside it. */
function reportedMember(path: readonly { readonly key: unknown }[]): string {
  const keys = path.flatMap((item) => (typeof item.key === "string" ? [item.key] : []));
  if (keys.length === 0) return "request";
  const member = REPORTED_MEMBERS.get(keys[0]!);
  if (member === undefined || keys.length > 2) return "other";
  if (keys.length === 1) return member;
  const descriptor =
    member === "allow-credentials" ? REPORTED_DESCRIPTOR_MEMBERS.get(keys[1]!) : undefined;
  return descriptor === undefined ? "other" : `${member}.${descriptor}`;
}

/**
 * Describes why `admitGetRequest` delegated a request as `invalid-request`, for the request's
 * report only; call it for that reason alone. Undefined when the snapshot is well formed and
 * names a `public-key` credential or none.
 */
export function describeInvalidRequest(request: unknown): InvalidRequestReport | undefined {
  const parsed = v.safeParse(bridgedGetRequestSchema, request);
  if (parsed.success) {
    const { allowCredentials } = parsed.output;
    return allowCredentials.length > 0 &&
      allowCredentials.every((entry) => entry.type !== "public-key")
      ? { member: "allow-credentials.type" }
      : undefined;
  }
  const issue = parsed.issues[0];
  const member = reportedMember(issue.path ?? []);
  // An unknown member's size says nothing about Pateat's bounds.
  if (member === "other") return { member };
  const { input } = issue;
  const length =
    typeof input === "string"
      ? member === "challenge" || member === "allow-credentials.id"
        ? Math.floor((input.length * 3) / 4)
        : input.length
      : Array.isArray(input)
        ? input.length
        : undefined;
  return { member, ...(length === undefined ? {} : { length }) };
}

/**
 * Decide whether Pateat may answer a request. Origin is browser-supplied; every other input is
 * page data. Anything not explicitly supported delegates to the browser's own implementation.
 * The policy decides whether a gesture or UV requirement limits admission. `conditional`
 * mediation is admitted only for a caller that answers it through a login (ADR 0034).
 */
export function admitGetRequest(input: {
  readonly origin: string;
  readonly request: unknown;
  readonly userActivation: boolean;
  readonly policy: PasskeyPolicy;
  readonly conditional?: boolean;
}): Admission {
  // Gates compare against the permissive value so an unknown stored setting fails closed.
  const parsed = v.safeParse(bridgedGetRequestSchema, input.request);
  if (!parsed.success) return { kind: "delegate", reason: "invalid-request" };
  const request = parsed.output;
  const immediate = request.uiMode === "immediate";
  const conditional =
    !immediate && request.mediation === "conditional" && input.conditional === true;
  // `required` asks for the person as `optional` does: a passkey request always shows the
  // browser's prompt, which Pateat answers in its place.
  const modal =
    request.mediation === undefined ||
    request.mediation === "optional" ||
    request.mediation === "required";
  if (!modal && !conditional) return { kind: "delegate", reason: "unsupported-mediation" };
  // Chrome rejects an Immediate UI allowlist to prevent cross-session tracking. Even a
  // descriptor of an unknown type must not turn it into an admitted discoverable request.
  if (immediate && request.allowCredentials.length !== 0)
    return { kind: "delegate", reason: "immediate-allow-credentials" };
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
  if ((immediate || input.policy.presence !== "always") && !input.userActivation)
    return { kind: "delegate", reason: "no-user-activation" };
  return {
    kind: "claim",
    request: Object.freeze({
      origin: input.origin,
      rpId: rpId.rpId,
      challenge: request.challenge,
      allowCredentialIds: Object.freeze(allowed.map((entry) => toBase64Url(entry.id))),
      userVerified: input.policy.verification === "always",
      ...(request.timeout === undefined ? {} : { timeoutMs: request.timeout }),
      ...(conditional ? { conditional: true as const } : {}),
      ...(immediate ? { immediate: true as const } : {}),
    }),
  };
}
