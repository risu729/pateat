import type { LocalSettings } from "@pateat/contracts";

/**
 * How Pateat answers a claimed request. The owner chose to assert presence and verification
 * unconditionally (ADR 0007); the protections setting can ask for the ceremony instead, through
 * this shape rather than by changing admission or assertion code.
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

/** The policy that follows the WebAuthn ceremony as far as Pateat can, used when unsure. */
export const CEREMONY_PASSKEY_POLICY: PasskeyPolicy = Object.freeze({
  presence: "activation",
  verification: "never",
});

/** The policy the protections setting chooses; it applies to every site. */
export function passkeyPolicyOf(settings: Pick<LocalSettings, "protections">): PasskeyPolicy {
  return Object.freeze({
    presence: settings.protections.passkeyPresence,
    verification: settings.protections.passkeyVerification,
  });
}
