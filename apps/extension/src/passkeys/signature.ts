import { DER } from "@noble/curves/abstract/weierstrass.js";
import { concatBytes } from "./encoding";

const P256_SCALAR_BYTES = 32;
const P256_SCALAR_LIMIT = 1n << BigInt(P256_SCALAR_BYTES * 8);

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeBigInt(value: bigint, target: Uint8Array): void {
  let rest = value;
  for (let index = target.length - 1; index >= 0; index--) {
    target[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

/** Convert a WebCrypto IEEE P1363 P-256 signature (r || s) to the DER form WebAuthn expects. */
export function p1363ToDer(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature.length !== P256_SCALAR_BYTES * 2) throw new RangeError("Invalid P-256 signature");
  const hex = DER.hexFromSig({
    r: bytesToBigInt(signature.subarray(0, P256_SCALAR_BYTES)),
    s: bytesToBigInt(signature.subarray(P256_SCALAR_BYTES)),
  });
  return Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}

/**
 * Strict inverse used for verification; rejects non-minimal or oversized DER integers.
 * noble's parser enforces the outer tag, minimal lengths, trailing bytes, negative and
 * non-minimal integers; the scalar width limit (at most one sign byte plus 32 bytes, and a
 * value below 2^256) is checked here.
 */
export function derToP1363(signature: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  try {
    const { r, s } = DER.toSig(signature, P256_SCALAR_BYTES + 1);
    if (r >= P256_SCALAR_LIMIT || s >= P256_SCALAR_LIMIT) return undefined;
    const output = new Uint8Array(P256_SCALAR_BYTES * 2);
    writeBigInt(r, output.subarray(0, P256_SCALAR_BYTES));
    writeBigInt(s, output.subarray(P256_SCALAR_BYTES));
    return output;
  } catch {
    return undefined;
  }
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
