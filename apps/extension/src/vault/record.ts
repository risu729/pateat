import * as v from "valibot";
import {
  admitPreparedBitwardenAccount,
  normalizeBitwardenProfile,
  type BitwardenErrorCode,
  type BitwardenProfile,
  type PreparedBitwardenAccount,
} from "@pateat/bitwarden";

export const MAX_VAULT_RECORD_BYTES = 16 * 1024 * 1024;
export type VaultErrorCode =
  | BitwardenErrorCode
  | "invalid-cache-record"
  | "cache-missing"
  | "auto-unlock-disabled"
  | "cache-quota-exceeded"
  | "storage-failed"
  | "storage-uncertain"
  | "storage-conflict"
  | "stale-vault-handle";
export type VaultResult<T> = { ok: true; data: T } | { ok: false; error: { code: VaultErrorCode } };
export const vaultFailure = (code: VaultErrorCode): VaultResult<never> => ({
  ok: false,
  error: { code },
});
export type AcceptedVaultContext = {
  recordId: string;
  snapshotId: string;
  userId: string;
  accountVersion: "v1" | "v2";
  minimumSecurityVersion: 1 | 2;
  acceptedAt: number;
  coverage: "received-envelope";
  prepared: PreparedBitwardenAccount;
};
export type VaultEntry = {
  schemaVersion: 1;
  revision: string;
  profile: BitwardenProfile;
} & (
  | { state: "active"; accepted: AcceptedVaultContext; userKey: string }
  | { state: "disabled"; accepted?: AcceptedVaultContext }
);
const uuid = v.pipe(v.string(), v.uuid());
const acceptedSchema = v.strictObject({
  recordId: uuid,
  snapshotId: uuid,
  userId: uuid,
  accountVersion: v.picklist(["v1", "v2"]),
  minimumSecurityVersion: v.picklist([1, 2]),
  acceptedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  coverage: v.literal("received-envelope"),
  prepared: v.unknown(),
});
const base = { schemaVersion: v.literal(1), revision: uuid, profile: v.unknown() };
const entrySchema = v.variant("state", [
  v.strictObject({
    ...base,
    state: v.literal("active"),
    accepted: acceptedSchema,
    userKey: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(1_048_576),
      v.check((value) => {
        try {
          return btoa(atob(value)) === value;
        } catch {
          return false;
        }
      }),
    ),
  }),
  v.strictObject({ ...base, state: v.literal("disabled"), accepted: v.optional(acceptedSchema) }),
]);
export function vaultRecordBytes(input: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return Infinity;
  }
}
/** Strict offline admission. No token, JWT, password, plaintext item, or page grant is stored. */
export function admitVaultEntry(input: unknown, expectedProfile: unknown): VaultResult<VaultEntry> {
  try {
    if (vaultRecordBytes(input) > MAX_VAULT_RECORD_BYTES)
      return vaultFailure("cache-quota-exceeded");
    const expected = normalizeBitwardenProfile(expectedProfile);
    if (!expected.ok) return expected;
    const checked = v.safeParse(entrySchema, structuredClone(input));
    if (!checked.success) return vaultFailure("invalid-cache-record");
    const profile = normalizeBitwardenProfile(checked.output.profile);
    if (!profile.ok || JSON.stringify(profile.data) !== JSON.stringify(expected.data))
      return vaultFailure("account-mismatch");
    const value = checked.output;
    if (value.accepted) {
      const prepared = admitPreparedBitwardenAccount(value.accepted.prepared, profile.data);
      if (!prepared.ok) return vaultFailure("invalid-cache-record");
      if (
        prepared.data.binding.userId !== value.accepted.userId ||
        prepared.data.binding.accountVersion !== value.accepted.accountVersion ||
        prepared.data.minimumSecurityVersion !== value.accepted.minimumSecurityVersion
      )
        return vaultFailure("invalid-cache-record");
      value.accepted.prepared = prepared.data;
    }
    return { ok: true, data: { ...value, profile: profile.data } as VaultEntry };
  } catch {
    return vaultFailure("invalid-cache-record");
  }
}
/** Canonical comparison includes the key and every encrypted member, never just the revision. */
export function sameVaultEntry(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  try {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  } catch {
    return false;
  }
}
