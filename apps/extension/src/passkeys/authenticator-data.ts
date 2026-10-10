import { concatBytes, sha256 } from "./encoding";

export const AUTHENTICATOR_FLAGS = Object.freeze({
  userPresent: 0x01,
  userVerified: 0x04,
  backupEligible: 0x08,
  backupState: 0x10,
});

export interface AssertionFlags {
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
}

/** Assertion authenticator data: RP ID hash, flags and counter; no attested data or extensions. */
export async function buildAssertionAuthenticatorData(
  rpId: string,
  flags: AssertionFlags,
  counter: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xff_ff_ff_ff)
    throw new RangeError("Invalid signature counter");
  if (flags.backupState && !flags.backupEligible) throw new RangeError("BS requires BE");
  let value = 0;
  if (flags.userPresent) value |= AUTHENTICATOR_FLAGS.userPresent;
  if (flags.userVerified) value |= AUTHENTICATOR_FLAGS.userVerified;
  if (flags.backupEligible) value |= AUTHENTICATOR_FLAGS.backupEligible;
  if (flags.backupState) value |= AUTHENTICATOR_FLAGS.backupState;
  const tail = new Uint8Array(5);
  tail[0] = value;
  new DataView(tail.buffer).setUint32(1, counter);
  // RP IDs are canonical ASCII domains, so their UTF-8 and byte-string forms agree.
  return concatBytes(await sha256(new TextEncoder().encode(rpId)), tail);
}
