import { decode } from "cbor2/decoder";

/**
 * Reads `SecurityState.version` from a signed security state (a COSE_Sign1, RFC 9052) that the SDK
 * has ALREADY verified during initialization. The SDK exports no accessor for it. The payload is the
 * SDK's CBOR map, e.g. `{"version": 2}`; other fields are ignored. Parsing grants no trust, and
 * anything unexpected returns undefined, so callers fail closed.
 */
export function verifiedSecurityStateVersion(bytes: Uint8Array): number | undefined {
  try {
    const sign1 = decode(bytes, { preferMap: true });
    // [protected header, unprotected header, payload, signature]
    if (!Array.isArray(sign1) || sign1.length !== 4) return undefined;
    const payload: unknown = sign1[2];
    if (!(payload instanceof Uint8Array)) return undefined;
    const state = decode(payload, {
      preferMap: true,
      rejectDuplicateKeys: true,
      rejectFloats: true,
      rejectStreaming: true,
      requirePreferred: true,
    });
    if (!(state instanceof Map)) return undefined;
    const version: unknown = state.get("version");
    return typeof version === "number" &&
      Number.isInteger(version) &&
      version >= 0 &&
      version <= 0xff_ff_ff_ff
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}
