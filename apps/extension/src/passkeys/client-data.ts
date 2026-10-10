import { toBase64Url } from "./encoding";

const encoder = new TextEncoder();

/** WebAuthn CCDToString: JSON string with the specification's exact escaping. */
function ccdToString(value: string): string {
  let encoded = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x22) encoded += '\\"';
    else if (code === 0x5c) encoded += "\\\\";
    else if (code < 0x20) encoded += `\\u${code.toString(16).padStart(4, "0")}`;
    else encoded += char;
  }
  return `${encoded}"`;
}

/**
 * Serialize same-origin `webauthn.get` client data in the specification's fixed member order.
 * Cross-origin callers are not admitted, so `crossOrigin` is false and `topOrigin` is absent.
 */
export function serializeGetClientData(challenge: Uint8Array, origin: string): Uint8Array {
  return encoder.encode(
    `{"type":${ccdToString("webauthn.get")},"challenge":${ccdToString(toBase64Url(challenge))},` +
      `"origin":${ccdToString(origin)},"crossOrigin":false}`,
  );
}
