/**
 * How Pateat answers a claimed request. The owner chose to assert presence and verification
 * unconditionally (ADR 0007); a later per-site setting will supply other policies through this
 * shape instead of changing admission or assertion code.
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
