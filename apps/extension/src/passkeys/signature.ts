import { concatBytes } from "./encoding";

const P256_SCALAR_BYTES = 32;

function derInteger(raw: Uint8Array): Uint8Array {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start++;
  const trimmed = raw.subarray(start);
  // A set high bit would make the DER INTEGER negative; prefix a zero byte.
  const positive = trimmed[0]! & 0x80 ? concatBytes(Uint8Array.of(0), trimmed) : trimmed;
  return concatBytes(Uint8Array.of(0x02, positive.length), positive);
}

/** Convert a WebCrypto IEEE P1363 P-256 signature (r || s) to the DER form WebAuthn expects. */
export function p1363ToDer(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature.length !== P256_SCALAR_BYTES * 2) throw new RangeError("Invalid P-256 signature");
  const r = derInteger(signature.subarray(0, P256_SCALAR_BYTES));
  const s = derInteger(signature.subarray(P256_SCALAR_BYTES));
  // Both integers are at most 33 bytes, so the sequence length fits the short form.
  return concatBytes(Uint8Array.of(0x30, r.length + s.length), r, s);
}

/** Strict inverse used for verification; rejects non-minimal or oversized DER integers. */
export function derToP1363(signature: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  if (signature.length < 8 || signature[0] !== 0x30 || signature[1] !== signature.length - 2)
    return undefined;
  const output = new Uint8Array(P256_SCALAR_BYTES * 2);
  let offset = 2;
  for (const target of [0, P256_SCALAR_BYTES]) {
    if (signature[offset] !== 0x02) return undefined;
    const length = signature[offset + 1]!;
    const value = signature.subarray(offset + 2, offset + 2 + length);
    if (length === 0 || value.length !== length || length > P256_SCALAR_BYTES + 1) return undefined;
    if (value[0]! & 0x80) return undefined;
    if (length > 1 && value[0] === 0 && !(value[1]! & 0x80)) return undefined;
    const digits = value[0] === 0 && length > 1 ? value.subarray(1) : value;
    if (digits.length > P256_SCALAR_BYTES) return undefined;
    output.set(digits, target + P256_SCALAR_BYTES - digits.length);
    offset += 2 + length;
  }
  return offset === signature.length ? output : undefined;
}

/** ECDSA P-256 SHA-256 over authenticatorData || clientDataHash, returned as DER. */
export async function signAssertion(
  key: CryptoKey,
  authenticatorData: Uint8Array,
  clientDataHash: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    key.type !== "private" ||
    key.algorithm.name !== "ECDSA" ||
    (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
    clientDataHash.length !== 32
  )
    throw new TypeError("Unsupported assertion key");
  const raw = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    concatBytes(authenticatorData, clientDataHash),
  );
  return p1363ToDer(new Uint8Array(raw));
}

/** Import a PKCS #8 P-256 key as non-extractable and sign-only. */
export function importAssertionKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as Uint8Array<ArrayBuffer>,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}
