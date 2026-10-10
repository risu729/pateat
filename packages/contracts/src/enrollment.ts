import * as v from "valibot";

// Device enrollment contracts shared by the service and the extension. The verifier
// never leaves trusted extension storage until redemption; the enrollment page sees
// only its SHA-256 challenge and the code the owner types from the extension.

const base64Url256 = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));

/** 256 random bits, base64url without padding. */
export const enrollmentVerifierSchema = base64Url256;
/** base64url SHA-256 digest of the verifier. */
export const enrollmentChallengeSchema = base64Url256;
export const deviceCredentialSchema = v.pipe(
  v.string(),
  v.regex(/^pateat_device_[A-Za-z0-9_-]{43}$/),
);
export const deviceIdSchema = v.pipe(v.string(), v.uuid());
export const deviceLabelSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[^\p{C}]+$/u, "Labels cannot contain control characters"),
);

export const enrollmentRedeemSchema = v.strictObject({
  version: v.literal(1),
  verifier: enrollmentVerifierSchema,
});
/** The credential is returned exactly once; the service keeps only its hash. */
export const enrollmentRedeemResultSchema = v.strictObject({
  version: v.literal(1),
  deviceId: deviceIdSchema,
  credential: deviceCredentialSchema,
});

export type EnrollmentRedeem = v.InferOutput<typeof enrollmentRedeemSchema>;
export type EnrollmentRedeemResult = v.InferOutput<typeof enrollmentRedeemResultSchema>;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    const length = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
    for (let digit = 0; digit < length; digit += 1)
      output += BASE64URL[(chunk >> (18 - digit * 6)) & 63];
  }
  return output;
}

/** Creates a fresh verifier. Keep it in trusted extension storage only. */
export function createEnrollmentVerifier(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createEnrollmentChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * The 40-bit code the owner retypes on the enrollment page, shown as `XXXX-XXXX`.
 * It is derived from the secret verifier, not the challenge, so someone who sees the
 * enrollment link cannot compute it; the service checks it at redemption.
 */
export async function enrollmentCode(verifier: string): Promise<string> {
  const parsed = v.parse(enrollmentVerifierSchema, verifier);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`pateat-enrollment-code:${parsed}`),
    ),
  );
  let bits = 0n;
  for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let index = 7; index >= 0; index -= 1)
    code += CROCKFORD[Number((bits >> BigInt(index * 5)) & 31n)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts lowercase, spaces, hyphens and Crockford's ambiguous letters. */
export function normalizeEnrollmentCode(input: string): string | null {
  const compact = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
