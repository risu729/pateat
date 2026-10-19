import * as v from "valibot";
import { decodeBase64 } from "./base64";
import { bitwardenEmail } from "./email";

const connectionId = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const token = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(16384),
  v.regex(/^[A-Za-z0-9._~+/-]+=*$/),
);
const code = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
function authenticationHash(value: string) {
  return decodeBase64(value)?.length === 32;
}
const masterPasswordHash = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9+/]{43}=$/),
  v.check(authenticationHash),
);
const deviceIdentifier = v.pipe(v.string(), v.uuid());
export const passwordTokenRequestSchema = v.strictObject({
  connectionId,
  email: bitwardenEmail,
  masterPasswordHash,
  device: v.strictObject({
    identifier: deviceIdentifier,
    name: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(128),
      v.check((value) => value.trim().length > 0),
    ),
  }),
  twoFactor: v.optional(
    v.strictObject({
      // Recovery code is account mutation. Complex ceremonies and remembered tokens are separate gates.
      provider: v.picklist([0, 1]),
      token: code,
      remember: v.optional(v.boolean(), false),
    }),
  ),
  newDeviceOtp: v.optional(code),
});
export const refreshTokenRequestSchema = v.strictObject({ connectionId, refreshToken: token });
/** The same hash the password grant sent, for the same server's email code send only. */
export const emailLoginCodeRequestSchema = v.strictObject({
  connectionId,
  email: bitwardenEmail,
  masterPasswordHash,
  deviceIdentifier,
});

const record = v.pipe(
  v.custom<Record<string, unknown>>(
    (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  ),
  v.record(v.string(), v.unknown()),
);
const positive = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2147483647));
const tokenResponseSchema = v.looseObject({
  access_token: token,
  token_type: v.pipe(
    v.string(),
    v.check((value) => value.toLowerCase() === "bearer"),
  ),
  expires_in: positive,
  refresh_token: v.optional(v.nullable(token)),
});
export type AuthenticationTokens = {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken?: string;
};
export type PasswordTokenOutcome =
  | {
      kind: "authenticated";
      tokens: AuthenticationTokens;
      encryptedAccount: Record<string, unknown>;
    }
  | { kind: "mfa-required"; providers: number[]; supportedProviders: (0 | 1)[] }
  | { kind: "new-device-verification-required"; invalidOtp: boolean }
  | {
      kind: "interaction-required";
      reason: "sso" | "protocol-compatibility" | "unsupported-challenge";
    }
  | { kind: "rejected"; reason: "credentials" | "mfa" | "refresh" | "other" };
export type RefreshTokenOutcome =
  | { kind: "authenticated"; tokens: AuthenticationTokens }
  | { kind: "rejected"; reason: "refresh" | "other" };

function tokens(input: unknown): AuthenticationTokens | undefined {
  const parsed = v.safeParse(tokenResponseSchema, input);
  if (!parsed.success) return undefined;
  const value = parsed.output;
  return {
    accessToken: value.access_token,
    tokenType: "Bearer",
    expiresIn: value.expires_in,
    ...(value.refresh_token == null ? {} : { refreshToken: value.refresh_token }),
  };
}

// BaseResponse accepts Pascal/camel case; reject conflicting copies rather than choosing one.
function alias(body: Record<string, unknown>, name: string) {
  const camel = name[0]!.toLowerCase() + name.slice(1);
  if (
    Object.hasOwn(body, name) &&
    Object.hasOwn(body, camel) &&
    JSON.stringify(body[name]) !== JSON.stringify(body[camel])
  )
    throw new Error();
  return Object.hasOwn(body, name) ? body[name] : body[camel];
}
const accountShape = v.looseObject({
  Key: v.optional(v.nullable(v.string())),
  PrivateKey: v.optional(v.nullable(v.string())),
  AccountKeys: v.optional(v.nullable(record)),
  UserDecryptionOptions: v.optional(v.nullable(record)),
  Kdf: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
  KdfIterations: v.optional(v.nullable(positive)),
  KdfMemory: v.optional(v.nullable(positive)),
  KdfParallelism: v.optional(v.nullable(positive)),
  ForcePasswordReset: v.optional(v.nullable(v.boolean())),
  ApiUseKeyConnector: v.optional(v.nullable(v.boolean())),
  MasterPasswordPolicy: v.optional(v.nullable(record)),
});
const challengeNames = [
  "TwoFactorProviders",
  "TwoFactorProviders2",
  "ErrorModel",
  "MasterPasswordPolicy",
  "Email",
  "SsoEmail2faSessionToken",
  "SsoOrganizationIdentifier",
];
const challengeKeys = new Set([
  "error",
  "error_description",
  ...challengeNames.flatMap((name) => [name, name[0]!.toLowerCase() + name.slice(1)]),
]);
function legacyProviderIds(input: unknown) {
  if (
    !Array.isArray(input) ||
    !input.every(
      (value) =>
        (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) ||
        (typeof value === "string" && /^(0|[1-9]\d{0,2})$/.test(value) && Number(value) <= 255),
    )
  )
    return undefined;
  return [...new Set(input.map(Number))].sort((a, b) => a - b);
}

// Vaultwarden's error JSON repeats one message in `message`, `validationErrors` and `errorModel`
// (src/error.rs L226-L260). Line numbers below are in the same tree:
// https://github.com/dani-garcia/vaultwarden/tree/7c188967e7a467b19b2757bc3326f9cf3ccae327/src
const vaultwardenErrorKeys = new Set([
  "message",
  "validationErrors",
  "errorModel",
  "error",
  "error_description",
  "exceptionMessage",
  "exceptionStackTrace",
  "innerExceptionMessage",
  "object",
]);
function vaultwardenRejection(body: Record<string, unknown>): PasswordTokenOutcome {
  const unsupported = { kind: "interaction-required", reason: "unsupported-challenge" } as const;
  const model = body["errorModel"];
  const message = v.safeParse(record, model).success
    ? (model as Record<string, unknown>)["message"]
    : undefined;
  if (
    Object.keys(body).some((key) => !vaultwardenErrorKeys.has(key)) ||
    typeof message !== "string" ||
    body["message"] !== message
  )
    return unsupported;
  // api/identity.rs L382 and L421 (unknown email, wrong password).
  if (message === "Username or password is incorrect. Try again")
    return { kind: "rejected", reason: "credentials" };
  // Authenticator code (api/core/two_factor/authenticator.rs L166, L176), email code
  // (api/core/two_factor/email.rs L285, L300) and recovery code (api/identity.rs L890).
  if (
    message.startsWith("Invalid TOTP code! ") ||
    message.startsWith("Token is invalid! ") ||
    message === "Token has expired" ||
    message === "Two-step token is invalid. Try again."
  )
    return { kind: "rejected", reason: "mfa" };
  return unsupported;
}

/** Token parsing grants no unlock, cache, subject verification or authoritative vault capability. */
export function parsePasswordTokenOutcome(
  input: unknown,
  status: number,
): PasswordTokenOutcome | undefined {
  const parsed = v.safeParse(record, input);
  if (!parsed.success) return undefined;
  const body = parsed.output;
  try {
    if (status === 200) {
      if (body["error"] !== undefined) return undefined;
      const accepted = tokens(body);
      if (!accepted) return undefined;
      const encryptedAccount: Record<string, unknown> = {};
      for (const name of Object.keys(accountShape.entries)) {
        const value = alias(body, name);
        if (value !== undefined) encryptedAccount[name] = value;
      }
      if (!v.safeParse(accountShape, encryptedAccount).success) return undefined;
      return { kind: "authenticated", tokens: accepted, encryptedAccount };
    }
    if (status !== 400 || typeof body["error"] !== "string" || body["access_token"] !== undefined)
      return undefined;
    if (body["error"] === "version_header_missing" || body["error"] === "invalid_client_version")
      return { kind: "interaction-required", reason: "protocol-compatibility" };
    if (body["error_description"] != null && typeof body["error_description"] !== "string")
      return undefined;
    const modern = alias(body, "TwoFactorProviders2");
    const legacy = alias(body, "TwoFactorProviders");
    let mfa: Extract<PasswordTokenOutcome, { kind: "mfa-required" }> | undefined;
    if (modern !== undefined || legacy !== undefined) {
      let providers: number[];
      if (modern !== undefined) {
        const providerRecord = v.safeParse(record, modern);
        if (!providerRecord.success) return undefined;
        const entries = Object.entries(providerRecord.output);
        if (
          !entries.every(
            ([key, value]) =>
              /^(0|[1-9]\d{0,2})$/.test(key) &&
              Number(key) <= 255 &&
              (value === null || v.safeParse(record, value).success),
          )
        )
          return undefined;
        providers = entries.map(([key]) => Number(key));
      } else {
        const legacyIds = legacyProviderIds(legacy);
        if (!legacyIds) return undefined;
        providers = legacyIds;
      }
      providers = [...new Set(providers)].sort((a, b) => a - b);
      if (providers.length === 0) return undefined;
      // The pinned server sends both representations of the same set. Null is malformed,
      // while a missing field permits the explicitly supported older representation.
      if (legacy !== undefined) {
        const legacyIds = legacyProviderIds(legacy);
        if (!legacyIds || JSON.stringify(legacyIds) !== JSON.stringify(providers)) return undefined;
      }
      mfa = {
        kind: "mfa-required",
        providers,
        supportedProviders: providers.filter((value): value is 0 | 1 => value === 0 || value === 1),
      };
    }
    const errorModel = alias(body, "ErrorModel");
    if (errorModel !== undefined && !v.safeParse(record, errorModel).success) return undefined;
    const message =
      errorModel === undefined
        ? undefined
        : alias(errorModel as Record<string, unknown>, "Message");
    if (message !== undefined && typeof message !== "string") return undefined;
    if (body["error"] === "device_error") {
      const description = body["error_description"];
      if (
        message === "new device verification required" ||
        description === "New device verification required"
      )
        return { kind: "new-device-verification-required", invalidOtp: false };
      if (message === "invalid new device otp" || description === "Invalid New Device OTP")
        return { kind: "new-device-verification-required", invalidOtp: true };
    }
    const sso = alias(body, "SsoOrganizationIdentifier");
    if (sso !== undefined) {
      if (typeof sso !== "string" || !sso) return undefined;
      return { kind: "interaction-required", reason: "sso" };
    }
    if (body["error"] === "" && body["object"] === "error") return vaultwardenRejection(body);
    // Unknown concurrent guards must not be advertised as a usable manual-code challenge.
    // No undocumented CAPTCHA fields or arbitrary provider URLs are interpreted.
    if (Object.keys(body).some((key) => !challengeKeys.has(key)))
      return { kind: "interaction-required", reason: "unsupported-challenge" };
    if (mfa)
      return body["error"] === "invalid_grant"
        ? mfa
        : { kind: "interaction-required", reason: "unsupported-challenge" };
    if (body["error"] === "invalid_grant") {
      if (message === "Two-step token is invalid. Try again.")
        return { kind: "rejected", reason: "mfa" };
      if (
        message === "Username or password is incorrect. Try again." ||
        body["error_description"] === "invalid_username_or_password"
      )
        return { kind: "rejected", reason: "credentials" };
      // SSO can omit its organization identifier (multiple enforcing organizations).
      // Unknown invalid_grant descriptions are not evidence of a wrong password.
      return { kind: "interaction-required", reason: "unsupported-challenge" };
    }
    return { kind: "interaction-required", reason: "unsupported-challenge" };
  } catch {
    return undefined;
  }
}

export function parseRefreshTokenOutcome(
  input: unknown,
  status: number,
): RefreshTokenOutcome | undefined {
  if (status === 200) {
    const body = v.safeParse(record, input);
    if (!body.success || body.output["error"] !== undefined) return undefined;
    const accepted = tokens(body.output);
    return accepted ? { kind: "authenticated", tokens: accepted } : undefined;
  }
  const body = v.safeParse(record, input);
  if (
    status !== 400 ||
    !body.success ||
    typeof body.output["error"] !== "string" ||
    body.output["access_token"] !== undefined
  )
    return undefined;
  return {
    kind: "rejected",
    reason: body.output["error"] === "invalid_grant" ? "refresh" : "other",
  };
}

/** What `POST {api}/two-factor/send-email-login` answered. The answer carries no code. */
export type EmailLoginCodeOutcome =
  | { kind: "sent" }
  | { kind: "rate-limited" }
  /** Vaultwarden without mail settings: `Email 2FA is disabled`. */
  | { kind: "unavailable" }
  /** Any other refusal. The official server delays and words every refusal alike. */
  | { kind: "refused" };
export function parseEmailLoginCodeOutcome(
  input: unknown,
  status: number,
): EmailLoginCodeOutcome | undefined {
  if (status === 200) return { kind: "sent" };
  if (status === 429) return { kind: "rate-limited" };
  if (status !== 400) return undefined;
  const body = v.safeParse(record, input);
  if (!body.success) return undefined;
  // Vaultwarden email.rs L44: https://github.com/dani-garcia/vaultwarden/blob/7c188967e7a467b19b2757bc3326f9cf3ccae327/src/api/core/two_factor/email.rs#L43-L45
  return body.output["object"] === "error" && body.output["message"] === "Email 2FA is disabled"
    ? { kind: "unavailable" }
    : { kind: "refused" };
}
