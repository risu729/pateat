import type { LocalSettings } from "@pateat/contracts";

/**
 * How Pateat answers a claimed request. The owner chose to assert presence and verification
 * unconditionally (ADR 0007), which stays the default; the synced `passkeyPolicy` setting
 * can choose the ceremony's way for either (owner, 2026-11-02).
 */
export interface PasskeyPolicy {
  /** `always` sets UP without a user gesture; `activation` delegates requests that lack one. */
  readonly presence: "always" | "activation";
  /** `always` sets UV; `never` leaves it clear and delegates requests that require it. */
  readonly verification: "always" | "never";
}

/** Initial policy: unattended presence and verification. This does not follow the ceremony. */
export const INITIAL_PASSKEY_POLICY: PasskeyPolicy = Object.freeze({
  presence: "always",
  verification: "always",
});

/** Settings that cannot be read follow the ceremony rather than claim more than chosen. */
const UNREADABLE_PASSKEY_POLICY: PasskeyPolicy = Object.freeze({
  presence: "activation",
  verification: "never",
});

/**
 * The policy in the current settings (`passkeyPolicy`, synced with the profile): absent
 * means the initial policy; settings that cannot be read give the ceremony's. Never throws.
 */
export async function readPasskeyPolicy(
  read: () => Promise<Pick<LocalSettings, "passkeyPolicy">>,
): Promise<PasskeyPolicy> {
  try {
    return (await read()).passkeyPolicy ?? INITIAL_PASSKEY_POLICY;
  } catch {
    return UNREADABLE_PASSKEY_POLICY;
  }
}
