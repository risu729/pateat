/** Unpadded base64url, as used by WebAuthn client data and JSON serializations. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Strict unpadded base64url with canonical trailing bits. */
export function fromBase64Url(value: string): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1)
    return undefined;
  try {
    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return toBase64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}
