// Seeds a running synthetic Vaultwarden server through its client API, encrypting like an
// official client with the pinned SDK. Synthetic accounts and items only.
// Request shapes follow Vaultwarden 1.37.4 (7c188967e7a467b19b2757bc3326f9cf3ccae327):
// src/api/identity.rs and core/accounts.rs (registration), core/ciphers.rs (items) and
// core/two_factor/authenticator.rs and email.rs (two-step methods).
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import * as v from "valibot";

import {
  derivePasswordAuthentication,
  generateLocalTotp,
} from "../../packages/bitwarden/src/index";
import { nodeSdk } from "../../packages/bitwarden/src/__fixtures__/node-sdk";
import { readTwoStepCode } from "./mailpit";

const { PureCrypto } = nodeSdk;

export interface SeededAccount {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly kdfIterations: number;
  readonly userId: string;
  /** The server-authorization hash Vaultwarden checks for protected actions. */
  readonly masterPasswordHash: string;
  /** The seeder's own bearer token, from a sign-in made before any two-step method. */
  readonly accessToken: string;
  /** The account's AES-256-CBC-HMAC user key, which encrypts every seeded item. */
  readonly userKey: Uint8Array;
}

export interface SyntheticPasskey {
  readonly rpId: string;
  readonly userName: string;
  /**
   * Keys added to the stored credential as they are. Vaultwarden returns them unchanged; the
   * official CLI 2026.10.0's `bw import` stores `response: null` (ADR 0059).
   */
  readonly extraKeys?: Readonly<Record<string, unknown>>;
}

export interface SyntheticLogin {
  readonly name: string;
  readonly username?: string;
  readonly password?: string;
  /**
   * Bitwarden URI match modes: null default, 0 base domain, 1 host, 2 starts with, 3 exact,
   * 4 regular expression, 5 never.
   */
  readonly uris?: readonly { uri: string; match?: 0 | 1 | 2 | 3 | 4 | 5 | null }[];
  /** A base32 secret or `otpauth://` URI. */
  readonly totp?: string;
  readonly passkey?: SyntheticPasskey;
}

const tokenSchema = v.object({ access_token: v.string() });
const claimsSchema = v.object({ sub: v.pipe(v.string(), v.uuid()) });
const idSchema = v.object({ id: v.pipe(v.string(), v.uuid()) });
const authenticatorSchema = v.object({
  enabled: v.boolean(),
  key: v.pipe(v.string(), v.regex(/^[A-Z2-7]{32}$/)),
});

async function call(
  baseUrl: string,
  path: string,
  request: { method: "POST" | "PUT"; json?: unknown; form?: URLSearchParams; token?: string },
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: request.method,
    headers: {
      Accept: "application/json",
      "Content-Type": request.form ? "application/x-www-form-urlencoded" : "application/json",
      ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}),
    },
    body: request.form ? request.form.toString() : JSON.stringify(request.json),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Vaultwarden answered ${response.status} for ${path}: ${text}`);
  return text ? (JSON.parse(text) as unknown) : null;
}

async function masterPasswordHash(email: string, password: string, iterations: number) {
  const result = await derivePasswordAuthentication(
    {
      connectionId: "vaultwarden-seed",
      email,
      password,
      prelogin: {
        mode: "legacy",
        response: { kdf: 0, kdfIterations: iterations, kdfMemory: null, kdfParallelism: null },
      },
    },
    nodeSdk,
  );
  if (!result.ok) throw new Error(`Password hash failed: ${result.error.code}`);
  return result.data.masterPasswordHash;
}

/**
 * Registers a synthetic V1 account (PBKDF2, an AES-256-CBC-HMAC user key and an RSA key pair)
 * as the web vault's registration does, and signs in once for the seeder's own token.
 */
export async function registerAccount(
  baseUrl: string,
  input: { email: string; password: string; kdfIterations?: number },
): Promise<SeededAccount> {
  const email = input.email.trim().toLowerCase();
  const { password } = input;
  const kdfIterations = input.kdfIterations ?? 600_000;
  const hash = await masterPasswordHash(email, password, kdfIterations);
  const userKey = PureCrypto.make_user_key_aes256_cbc_hmac();
  const wrappedUserKey = PureCrypto.encrypt_user_key_with_master_password(
    userKey,
    password,
    email,
    { pBKDF2: { iterations: kdfIterations } },
  );
  const privateKey = PureCrypto.rsa_generate_keypair();
  const publicKey = PureCrypto.rsa_extract_public_key(privateKey).toBase64();
  const encryptedPrivateKey = PureCrypto.wrap_decapsulation_key(privateKey, userKey);
  privateKey.fill(0);

  // With SIGNUPS_VERIFY off the server answers with the verification token instead of mailing it.
  const verification = v.parse(
    v.string(),
    await call(baseUrl, "/identity/accounts/register/send-verification-email", {
      method: "POST",
      json: { email, name: "Synthetic Vaultwarden user" },
    }),
  );
  const kdfData = { kdfType: 0, iterations: kdfIterations };
  await call(baseUrl, "/identity/accounts/register/finish", {
    method: "POST",
    json: {
      email,
      emailVerificationToken: verification,
      masterPasswordAuthentication: {
        kdf: kdfData,
        salt: email,
        masterPasswordAuthenticationHash: hash,
      },
      masterPasswordUnlock: { kdf: kdfData, salt: email, masterKeyWrappedUserKey: wrappedUserKey },
      userAsymmetricKeys: { publicKey, encryptedPrivateKey },
    },
  });

  const token = v.parse(
    tokenSchema,
    await call(baseUrl, "/identity/connect/token", {
      method: "POST",
      form: new URLSearchParams({
        grant_type: "password",
        username: email,
        password: hash,
        scope: "api offline_access",
        client_id: "web",
        deviceType: "9",
        deviceIdentifier: randomUUID(),
        deviceName: "pateat-vaultwarden-seed",
      }),
    }),
  );
  const payload = token.access_token.split(".")[1] ?? "";
  const claims = v.parse(
    claimsSchema,
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown,
  );
  return Object.freeze({
    baseUrl,
    email,
    password,
    kdfIterations,
    userId: claims.sub,
    masterPasswordHash: hash,
    accessToken: token.access_token,
    userKey,
  });
}

function encrypt(account: SeededAccount, value: string) {
  return PureCrypto.symmetric_encrypt_string(value, account.userKey);
}

function passkeyCredential(account: SeededAccount, passkey: SyntheticPasskey) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyValue = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const text = {
    credentialId: randomUUID(),
    keyType: "public-key",
    keyAlgorithm: "ECDSA",
    keyCurve: "P-256",
    keyValue,
    rpId: passkey.rpId,
    userHandle: randomBytes(16).toString("base64url"),
    userName: passkey.userName,
    counter: "0",
    rpName: passkey.rpId,
    userDisplayName: passkey.userName,
    discoverable: "true",
  };
  return {
    ...Object.fromEntries(
      Object.entries(text).map(([name, value]) => [name, encrypt(account, value)]),
    ),
    creationDate: new Date().toISOString(),
    ...passkey.extraKeys,
  };
}

/** Stores a personal login item and answers its ID. */
export async function addLogin(account: SeededAccount, item: SyntheticLogin): Promise<string> {
  const optional = (value: string | undefined) =>
    value === undefined ? null : encrypt(account, value);
  const login = {
    username: optional(item.username),
    password: optional(item.password),
    passwordRevisionDate: null,
    // Official clients store each URI with a checksum of its SHA-256 digest.
    uris:
      item.uris?.map(({ uri, match = null }) => ({
        uri: encrypt(account, uri),
        uriChecksum: encrypt(account, createHash("sha256").update(uri).digest("base64")),
        match,
      })) ?? null,
    totp: optional(item.totp),
    autofillOnPageLoad: null,
    fido2Credentials: item.passkey ? [passkeyCredential(account, item.passkey)] : null,
  };
  const created = await call(account.baseUrl, "/api/ciphers", {
    method: "POST",
    token: account.accessToken,
    json: {
      type: 1,
      name: encrypt(account, item.name),
      notes: null,
      folderId: null,
      organizationId: null,
      key: null,
      encryptedFor: account.userId,
      favorite: false,
      reprompt: 0,
      fields: null,
      passwordHistory: null,
      login,
    },
  });
  return v.parse(idSchema, created).id;
}

/**
 * The item `bw import` (official CLI 2026.10.0) made from a passkey export: its credential
 * holds `"response": null`, a key Pateat does not read (ADR 0059 decision 2).
 */
export function addImportedPasskeyLogin(
  account: SeededAccount,
  item: { name: string; username: string; password: string; uri: string; rpId: string },
) {
  return addLogin(account, {
    name: item.name,
    username: item.username,
    password: item.password,
    uris: [{ uri: item.uri }],
    passkey: { rpId: item.rpId, userName: item.username, extraKeys: { response: null } },
  });
}

/**
 * The authenticator code for `secret` at `nowMs`. Vaultwarden accepts one step either side and
 * never the same step twice, so right after `enableAuthenticator` sign in with the next step's
 * code (`Date.now() + 30_000`), and wait a step before reusing a step.
 */
export function authenticatorCode(secret: string, nowMs = Date.now()) {
  const code = generateLocalTotp(secret, { nowMs: () => nowMs });
  if (!code.ok) throw new Error(`TOTP failed: ${code.error.code}`);
  return code.data.value;
}

/** Turns on authenticator-app two-step and answers its base32 secret. */
export async function enableAuthenticator(account: SeededAccount): Promise<{ secret: string }> {
  const { baseUrl, masterPasswordHash: hash, accessToken } = account;
  const generated = v.parse(
    authenticatorSchema,
    await call(baseUrl, "/api/two-factor/get-authenticator", {
      method: "POST",
      token: accessToken,
      json: { masterPasswordHash: hash },
    }),
  );
  if (generated.enabled) throw new Error("Authenticator two-step is already on");
  const enabled = v.parse(
    authenticatorSchema,
    await call(baseUrl, "/api/two-factor/authenticator", {
      method: "PUT",
      token: accessToken,
      json: {
        key: generated.key,
        token: authenticatorCode(generated.key),
        masterPasswordHash: hash,
      },
    }),
  );
  if (!enabled.enabled) throw new Error("Authenticator two-step did not turn on");
  return { secret: generated.key };
}

/**
 * Turns on email two-step for the account's own address, reading the confirmation code from
 * Mailpit. Sign-in codes then come from `readTwoStepCode` after the client asks for one.
 */
export async function enableEmailTwoStep(account: SeededAccount, mailpitUrl: string) {
  const { baseUrl, email, masterPasswordHash: hash, accessToken } = account;
  await call(baseUrl, "/api/two-factor/send-email", {
    method: "POST",
    token: accessToken,
    json: { email, masterPasswordHash: hash },
  });
  const token = await readTwoStepCode(mailpitUrl, email);
  const enabled = v.parse(
    v.object({ email: v.string(), enabled: v.string() }),
    await call(baseUrl, "/api/two-factor/email", {
      method: "PUT",
      token: accessToken,
      json: { email, token, masterPasswordHash: hash },
    }),
  );
  // Vaultwarden answers `"enabled": "true"` as a string here.
  if (enabled.enabled !== "true" || enabled.email !== email)
    throw new Error("Email two-step did not turn on");
}
