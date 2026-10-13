/**
 * Canonical padded standard base64, as Bitwarden stores keys, hashes and EncString parts: no
 * whitespace, `=` padding and zero trailing bits. Anything else is rejected, not reinterpreted.
 */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return undefined;
  try {
    return Uint8Array.fromBase64(value, { lastChunkHandling: "strict" });
  } catch {
    return undefined;
  }
}

/** Canonical unpadded base64url, as in JWT segments: zero trailing bits, no `=` or whitespace. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) return undefined;
  try {
    // Strict decoding needs the padding back; it rejects a one-character final chunk.
    return Uint8Array.fromBase64(value.padEnd(Math.ceil(value.length / 4) * 4, "="), {
      alphabet: "base64url",
      lastChunkHandling: "strict",
    });
  } catch {
    return undefined;
  }
}
