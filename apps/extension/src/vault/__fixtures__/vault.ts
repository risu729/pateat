import type { VaultEntry } from "../record";
import {
  preparedVault,
  type VaultFixtureKind,
} from "../../../../../packages/bitwarden/src/__fixtures__/unlock";
import { accountProfile } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import {
  legacyItemKey,
  V2_DECRYPTED_USER_KEY,
} from "../../../../../packages/bitwarden/src/__fixtures__/crypto";

export const snapshotId = "20000000-0000-4000-8000-000000000001";
export const recordId = "30000000-0000-4000-8000-000000000001";
export const revision = "40000000-0000-4000-8000-000000000001";

// Structural/unit fixture only. Organization restoration uses the actual exported
// SDK key in the native-browser probe, not this deliberately shared mock key.
export function activeEntry(
  kind: VaultFixtureKind = "v1",
): Extract<VaultEntry, { state: "active" }> {
  const prepared = preparedVault(kind);
  prepared.minimumSecurityVersion = kind === "v2" ? 2 : 1;
  return {
    schemaVersion: 1,
    revision,
    profile: accountProfile,
    state: "active",
    accepted: {
      recordId,
      snapshotId,
      userId: prepared.binding.userId,
      accountVersion: prepared.binding.accountVersion,
      minimumSecurityVersion: prepared.minimumSecurityVersion,
      acceptedAt: 2_000_000_000_000,
      coverage: "received-envelope",
      prepared,
    },
    userKey: kind === "v2" ? V2_DECRYPTED_USER_KEY : legacyItemKey,
  };
}
export function disabledEntry(accepted = true): VaultEntry {
  const entry = activeEntry();
  return {
    schemaVersion: 1,
    revision,
    profile: accountProfile,
    state: "disabled",
    ...(accepted ? { accepted: entry.accepted } : {}),
  };
}
