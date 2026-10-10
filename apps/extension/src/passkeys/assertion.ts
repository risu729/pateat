import { buildAssertionAuthenticatorData } from "./authenticator-data";
import { serializeGetClientData } from "./client-data";
import { sha256, toBase64Url } from "./encoding";
import type { AdmittedGetRequest } from "./request";
import type { PasskeyCandidate } from "./select";

/** JSON-safe assertion fields returned to the page; binary values are unpadded base64url. */
export interface PasskeyAssertion {
  readonly credentialId: string;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
  readonly userHandle: string | null;
}

/** Signs authenticatorData || clientDataHash where the private key lives; returns DER. */
export type AssertionSigner = (
  authenticatorData: Uint8Array<ArrayBuffer>,
  clientDataHash: Uint8Array<ArrayBuffer>,
) => Promise<Uint8Array>;

/**
 * Build a zero-counter assertion. UP is set because admission required a user gesture; UV is
 * never set; BE and BS match synced vault credentials.
 */
export async function createPasskeyAssertion(
  request: AdmittedGetRequest,
  credential: PasskeyCandidate,
  sign: AssertionSigner,
): Promise<PasskeyAssertion> {
  // Selection already enforces these; repeat them so no caller can sign an ineligible credential.
  const listed =
    request.allowCredentialIds.length === 0
      ? credential.discoverable && credential.userHandle !== null
      : request.allowCredentialIds.includes(credential.credentialId);
  if (credential.counter !== 0 || credential.rpId !== request.rpId || !listed)
    throw new RangeError("Ineligible credential");
  const clientDataJSON = serializeGetClientData(request.challenge, request.origin);
  const authenticatorData = await buildAssertionAuthenticatorData(
    request.rpId,
    { userPresent: true, userVerified: false, backupEligible: true, backupState: true },
    0,
  );
  const signature = await sign(authenticatorData, await sha256(clientDataJSON));
  return Object.freeze({
    credentialId: credential.credentialId,
    clientDataJSON: toBase64Url(clientDataJSON),
    authenticatorData: toBase64Url(authenticatorData),
    signature: toBase64Url(signature),
    userHandle: credential.userHandle,
  });
}
