import { fromBase64Url, toBase64Url } from "../passkeys/encoding";

type CustomField = {
  name?: string | null | undefined;
  value?: string | null | undefined;
  type: number;
  linkedId?: number | null | undefined;
};

/** An HMAC key from the offscreen document's 32 raw bytes; anything else is refused. */
export async function importDigestKey(encoded: string | undefined): Promise<CryptoKey | undefined> {
  const raw = encoded === undefined ? undefined : fromBase64Url(encoded);
  if (raw?.length !== 32) return undefined;
  try {
    return await crypto.subtle.importKey(
      "raw",
      raw as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return undefined;
  }
}

/**
 * The keyed digest of an item's custom fields: every field in order, with its name, value,
 * type and linked source. Keyed, so whoever sees the digest cannot test guesses of a
 * short value against it offline.
 */
export async function customFieldsDigest(
  fields: readonly CustomField[] | null | undefined,
  key: CryptoKey,
): Promise<string> {
  const canonical = JSON.stringify(
    (fields ?? []).map((field) => [
      field.name ?? null,
      field.value ?? null,
      field.type,
      field.linkedId ?? null,
    ]),
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return toBase64Url(new Uint8Array(mac));
}

/** The offscreen relay's copy of a command: a digest request always carries its own key. */
export function withDigestKey<T extends { operation: { kind: string } }>(
  command: T,
  key: string,
): T {
  return command.operation.kind === "custom-digest"
    ? { ...command, operation: { ...command.operation, key } }
    : command;
}
