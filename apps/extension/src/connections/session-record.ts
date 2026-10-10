import * as v from "valibot";
import {
  normalizeBitwardenProfile,
  type AuthenticationTokens,
  type BitwardenProfile,
  type PasswordTokenOutcome,
} from "@pateat/bitwarden";
import { sameVaultEntry, vaultFailure, vaultRecordBytes, type VaultResult } from "../vault/record";

export const MAX_PROVIDER_SESSION_BYTES = 256 * 1024;
type Authenticated = Extract<PasswordTokenOutcome, { kind: "authenticated" }>;

/** Only the encrypted account fields the mapper reads; no policy or challenge data. */
const ENCRYPTED_ACCOUNT_FIELDS = [
  "Key",
  "PrivateKey",
  "AccountKeys",
  "UserDecryptionOptions",
  "Kdf",
  "KdfIterations",
  "KdfMemory",
  "KdfParallelism",
  "ForcePasswordReset",
  "ApiUseKeyConnector",
] as const;
const uuid = v.pipe(v.string(), v.uuid());
const time = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const token = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(16384),
  v.regex(/^[A-Za-z0-9._~+/-]+=*$/),
);
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(65536));
const object = v.pipe(
  v.custom<Record<string, unknown>>(
    (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  ),
  v.record(v.string(), v.unknown()),
);
const count = v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2147483647)));
const encryptedAccountSchema = v.strictObject({
  Key: v.optional(v.nullable(text)),
  PrivateKey: v.optional(v.nullable(text)),
  AccountKeys: v.optional(v.nullable(object)),
  UserDecryptionOptions: v.optional(v.nullable(object)),
  Kdf: v.optional(count),
  KdfIterations: v.optional(count),
  KdfMemory: v.optional(count),
  KdfParallelism: v.optional(count),
  ForcePasswordReset: v.optional(v.nullable(v.boolean())),
  ApiUseKeyConnector: v.optional(v.nullable(v.boolean())),
});
const base = {
  schemaVersion: v.literal(1),
  revision: uuid,
  profile: v.unknown(),
  binding: v.strictObject({
    userId: uuid,
    email: v.pipe(v.string(), v.minLength(1), v.maxLength(320), v.email()),
  }),
  encryptedAccount: encryptedAccountSchema,
};
const sessionSchema = v.variant("state", [
  v.strictObject({
    ...base,
    state: v.literal("active"),
    accessToken: token,
    refreshToken: v.optional(token),
    receivedAt: time,
    expiresIn: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2147483647)),
  }),
  // A claim records ownership of one refresh attempt. It never stores a token.
  v.strictObject({ ...base, state: v.literal("refreshing"), claimId: uuid, claimedAt: time }),
]);
export type ProviderSessionEntry = {
  schemaVersion: 1;
  revision: string;
  profile: BitwardenProfile;
  binding: { userId: string; email: string };
  encryptedAccount: v.InferOutput<typeof encryptedAccountSchema>;
} & (
  | {
      state: "active";
      accessToken: string;
      refreshToken?: string;
      receivedAt: number;
      expiresIn: number;
    }
  | { state: "refreshing"; claimId: string; claimedAt: number }
);

export function narrowEncryptedAccount(
  input: Record<string, unknown>,
): ProviderSessionEntry["encryptedAccount"] | undefined {
  const picked: Record<string, unknown> = {};
  for (const name of ENCRYPTED_ACCOUNT_FIELDS)
    if (input[name] !== undefined) picked[name] = input[name];
  const checked = v.safeParse(encryptedAccountSchema, picked);
  return checked.success ? checked.output : undefined;
}

/** Strict admission. A session never authorizes offline unlock and is bound to one profile. */
export function admitProviderSession(
  input: unknown,
  expectedProfile: unknown,
): VaultResult<ProviderSessionEntry> {
  try {
    if (vaultRecordBytes(input) > MAX_PROVIDER_SESSION_BYTES)
      return vaultFailure("invalid-cache-record");
    const expected = normalizeBitwardenProfile(expectedProfile);
    if (!expected.ok) return expected;
    const checked = v.safeParse(sessionSchema, structuredClone(input));
    if (!checked.success) return vaultFailure("invalid-cache-record");
    const profile = normalizeBitwardenProfile(checked.output.profile);
    if (!profile.ok || JSON.stringify(profile.data) !== JSON.stringify(expected.data))
      return vaultFailure("account-mismatch");
    return {
      ok: true,
      data: { ...checked.output, profile: profile.data } as ProviderSessionEntry,
    };
  } catch {
    return vaultFailure("invalid-cache-record");
  }
}
export const sameProviderSession = sameVaultEntry;

/** Rebuild the transient authentication result used by the account mapper. */
export function authenticatedFrom(
  entry: Extract<ProviderSessionEntry, { state: "active" }>,
): Authenticated {
  const tokens: AuthenticationTokens = {
    accessToken: entry.accessToken,
    tokenType: "Bearer",
    expiresIn: entry.expiresIn,
    ...(entry.refreshToken ? { refreshToken: entry.refreshToken } : {}),
  };
  return {
    kind: "authenticated",
    tokens,
    encryptedAccount: structuredClone(entry.encryptedAccount),
  };
}

/** Unsigned claim decoding only correlates a response with the stored binding. */
export function tokenSubject(accessToken: string): { sub?: string; email?: string } {
  try {
    const part = accessToken.split(".")[1];
    if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) return {};
    const padding = "=".repeat((4 - (part.length % 4)) % 4);
    const bytes = atob(part.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const claims: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
      ),
    );
    if (!claims || typeof claims !== "object") return {};
    const { sub, email } = claims as Record<string, unknown>;
    return {
      ...(typeof sub === "string" ? { sub: sub.toLowerCase() } : {}),
      ...(typeof email === "string" ? { email: email.trim().toLowerCase() } : {}),
    };
  } catch {
    return {};
  }
}
