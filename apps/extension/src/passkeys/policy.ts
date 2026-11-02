import * as v from "valibot";

/**
 * How Pateat answers a claimed request. The owner chose to assert presence and verification
 * unconditionally (ADR 0007), which stays the default; a device setting the settings page
 * writes can choose the ceremony's way for either (owner, 2026-11-02).
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

/** The device setting (ADR 0007): never synced, as the vault timeout is not (ADR 0075). */
export const PASSKEY_POLICY_KEY = "pateat.passkey-policy.v1";

export const passkeyPolicySchema = v.strictObject({
  presence: v.picklist(["always", "activation"]),
  verification: v.picklist(["always", "never"]),
});

/** A damaged record follows the ceremony rather than claim more than may have been chosen. */
const DAMAGED_PASSKEY_POLICY: PasskeyPolicy = Object.freeze({
  presence: "activation",
  verification: "never",
});

/** The stored setting. Absent means the initial policy; a value that does not parse, the ceremony's. */
export function parsePasskeyPolicy(value: unknown): PasskeyPolicy {
  if (value === undefined || value === null) return INITIAL_PASSKEY_POLICY;
  const parsed = v.safeParse(passkeyPolicySchema, value);
  return parsed.success ? parsed.output : DAMAGED_PASSKEY_POLICY;
}

/** The stored policy; a record that cannot be read gives the ceremony's. Never throws. */
export async function readPasskeyPolicy(read: () => Promise<unknown>): Promise<PasskeyPolicy> {
  try {
    return parsePasskeyPolicy(await read());
  } catch {
    return DAMAGED_PASSKEY_POLICY;
  }
}
