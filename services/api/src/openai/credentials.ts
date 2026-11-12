import { openAIApiKeySchema, type ManageOpenAI } from "@pateat/contracts";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { openAICredentials } from "../db/schema";

export type OpenAICredentialEnv = { DB: D1Database; INFERENCE_CREDENTIAL_KEY?: string };
const encoder = new TextEncoder();
const aad = (ownerId: string) => encoder.encode(`pateat:openai:v1:${ownerId}`);

/** An operator-held 256-bit key, separate from every owner's provider credential. */
async function encryptionKey(env: OpenAICredentialEnv) {
  if (!/^[a-f0-9]{64}$/i.test(env.INFERENCE_CREDENTIAL_KEY ?? "")) return undefined;
  try {
    return await crypto.subtle.importKey(
      "raw",
      Uint8Array.fromHex(env.INFERENCE_CREDENTIAL_KEY!),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    return undefined;
  }
}

export class CredentialStorageUnavailable extends Error {
  constructor() {
    super("Provider credential storage is unavailable");
  }
}

async function stored(env: OpenAICredentialEnv, ownerId: string) {
  const [row] = await drizzle(env.DB)
    .select()
    .from(openAICredentials)
    .where(eq(openAICredentials.ownerId, ownerId))
    .limit(1);
  return row;
}

async function decrypt(
  row: { nonce: string; ciphertext: string },
  key: CryptoKey,
  ownerId: string,
) {
  const nonce = Uint8Array.fromBase64(row.nonce, { alphabet: "base64url" });
  if (nonce.length !== 12) throw new CredentialStorageUnavailable();
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(ownerId) },
    key,
    Uint8Array.fromBase64(row.ciphertext, { alphabet: "base64url" }),
  );
  return v.parse(
    openAIApiKeySchema,
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(clear),
  );
}

/** Status only: neither the stored ciphertext nor its plaintext is returned. */
export async function openAICredentialState(
  env: OpenAICredentialEnv,
  ownerId: string,
): Promise<ManageOpenAI> {
  const [row, key] = await Promise.all([stored(env, ownerId), encryptionKey(env)]);
  let storedInvalid = false;
  if (row && key) {
    try {
      await decrypt(row, key, ownerId);
    } catch {
      storedInvalid = true;
    }
  }
  return {
    version: 1,
    configured: row !== undefined,
    storage: key ? "ready" : "unavailable",
    storedInvalid,
  };
}

/** Stores only authenticated ciphertext, bound to this owner. Saving makes no provider call. */
export async function saveOpenAICredential(
  env: OpenAICredentialEnv,
  ownerId: string,
  value: string,
) {
  const apiKey = v.parse(openAIApiKeySchema, value);
  const key = await encryptionKey(env);
  if (!key) throw new CredentialStorageUnavailable();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(ownerId) },
      key,
      encoder.encode(apiKey),
    ),
  );
  const row = {
    nonce: nonce.toBase64({ alphabet: "base64url", omitPadding: true }),
    ciphertext: encrypted.toBase64({ alphabet: "base64url", omitPadding: true }),
    updatedAt: Date.now(),
  };
  await drizzle(env.DB)
    .insert(openAICredentials)
    .values({ ownerId, ...row })
    .onConflictDoUpdate({ target: openAICredentials.ownerId, set: row });
}

export async function deleteOpenAICredential(env: OpenAICredentialEnv, ownerId: string) {
  await drizzle(env.DB).delete(openAICredentials).where(eq(openAICredentials.ownerId, ownerId));
}

/** Opens one owner's key only for an authenticated request; it never reaches a response or log. */
export async function resolveOpenAICredential(env: OpenAICredentialEnv, ownerId: string) {
  const row = await stored(env, ownerId);
  if (!row) return { status: "not_configured" as const };
  const key = await encryptionKey(env);
  if (!key) return { status: "unavailable" as const };
  try {
    return { status: "ready" as const, credential: { apiKey: await decrypt(row, key, ownerId) } };
  } catch {
    return { status: "unavailable" as const };
  }
}
