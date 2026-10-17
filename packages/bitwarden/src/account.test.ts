import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import {
  admitPreparedBitwardenAccount,
  createBitwardenAccountMapper,
  type PreparedBitwardenAccount,
} from "./account";
import { createBitwardenTransport } from "./transport";
import { createLocalCryptoSession } from "./local-crypto";
import {
  accountNow,
  accountProfile,
  accountUserId,
  rawLoginCipher,
  rawModernV1Account,
  rawOrganizationAccount,
  rawV1Account,
  rawV2Account,
  syntheticJwt,
} from "./__fixtures__/account";
import {
  TEST_ORGANIZATION_ID,
  TEST_ORGANIZATION_KEY,
  fidoCredential,
  fidoPrivateKey,
  v1Email,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
} from "./__fixtures__/crypto";
import { jsonResponse } from "./__fixtures__/transport";
import { v2ContainedKeyId, v2UnlockSalt } from "./__fixtures__/account-generated";

const sessions: Array<{ dispose(): void }> = [];
const bootstrap = { kind: "bootstrap", email: v1Email };
const known = {
  kind: "known",
  profile: accountProfile,
  email: v1Email,
  userId: accountUserId,
  accountVersion: "v2",
  minimumSecurityVersion: 2,
};
type Raw =
  | ReturnType<typeof rawV1Account>
  | ReturnType<typeof rawV2Account>
  | ReturnType<typeof rawModernV1Account>;

function setAt(root: object, path: Array<string | number>, value: unknown) {
  let target = root as Record<string, unknown>;
  for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const last = path.at(-1)!;
  if (value === undefined) delete target[last];
  else target[last] = value;
}

function authenticated(raw: Raw) {
  const {
    access_token: accessToken,
    token_type: _tokenType,
    expires_in: expiresIn,
    refresh_token: refreshToken,
    ...encryptedAccount
  } = raw.token;
  return {
    kind: "authenticated",
    tokens: { accessToken, tokenType: "Bearer", expiresIn, refreshToken },
    encryptedAccount,
  };
}

function mapper(binding: unknown = bootstrap, profile: unknown = accountProfile) {
  const created = createBitwardenAccountMapper(profile, binding, { nowSeconds: () => accountNow });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("Synthetic account mapper rejected");
  return created.data;
}

function mapRaw(raw: Raw, binding: unknown = bootstrap) {
  return mapper(binding).map({
    connectionId: accountProfile.connectionId,
    authenticated: authenticated(raw),
    sync: raw.sync,
  });
}

async function initializePrepared(prepared: PreparedBitwardenAccount) {
  const result = await createLocalCryptoSession(
    {
      connectionId: accountProfile.connectionId,
      userId: prepared.binding.userId,
      email: prepared.binding.email,
      kdf: prepared.kdf,
      accountCryptographicState: prepared.accountCryptographicState,
      unlock: {
        kind: "password",
        password: v1Password,
        masterPasswordUnlock: prepared.masterPasswordUnlock,
      },
      organizationKeys: prepared.organizationKeys,
      minimumSecurityVersion: prepared.minimumSecurityVersion,
    },
    sdk,
  );
  if (result.ok) sessions.push(result.data);
  return result;
}

async function mapReceived(raw: Raw) {
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    if (url.endsWith("/connect/token")) return jsonResponse(raw.token);
    if (url.endsWith("/sync")) return jsonResponse(raw.sync);
    throw new Error("Unexpected synthetic request");
  });
  const created = createBitwardenTransport(accountProfile, { fetch });
  if (!created.ok) throw new Error("Synthetic transport rejected");
  const token = await created.data.passwordToken({
    connectionId: accountProfile.connectionId,
    email: v1Email,
    masterPasswordHash: "wmyadRMyBZOH7P/a/ucTCbSghKgdzDpPqUnu/DAVtSw=",
    device: { identifier: "12345678-1234-4234-8234-123456789abc", name: "Pateat synthetic host" },
  });
  if (!token.ok || token.data.kind !== "authenticated")
    throw new Error("Synthetic token DTO rejected");
  const sync = await created.data.sync({
    connectionId: accountProfile.connectionId,
    accessToken: token.data.tokens.accessToken,
  });
  if (!sync.ok) throw new Error("Synthetic sync DTO rejected");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://identity.bitwarden.com/connect/token",
    "https://api.bitwarden.com/sync",
  ]);
  return mapper().map({
    connectionId: accountProfile.connectionId,
    authenticated: token.data,
    sync: sync.data,
  });
}

async function received(raw: Raw) {
  const prepared = await mapReceived(raw);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error("Synthetic account DTO mapping rejected");
  const session = await createLocalCryptoSession(
    {
      connectionId: accountProfile.connectionId,
      userId: prepared.data.binding.userId,
      email: prepared.data.binding.email,
      kdf: prepared.data.kdf,
      accountCryptographicState: prepared.data.accountCryptographicState,
      unlock: {
        kind: "password",
        password: v1Password,
        masterPasswordUnlock: prepared.data.masterPasswordUnlock,
      },
      organizationKeys: prepared.data.organizationKeys,
      minimumSecurityVersion: prepared.data.minimumSecurityVersion,
    },
    sdk,
  );
  expect(session.ok).toBe(true);
  if (!session.ok) throw new Error("Synthetic mapped password unlock rejected");
  sessions.push(session.data);
  return { prepared: prepared.data, session: session.data };
}

afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  vi.restoreAllMocks();
});

describe("raw provider account through native local crypto", () => {
  it("maps ordinary full legacy Data and password-unlocks the independent V1 login", async () => {
    const { prepared, session } = await received(rawV1Account());
    expect(prepared.coverage).toBe("received-envelope");
    expect(prepared.binding.accountVersion).toBe("v1");
    expect(prepared.ciphers[0]!.data == null).toBe(true);
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("My test login");
    expect(result.data.login?.username).toBe("test_username");
    expect(result.data.login?.password).toBe("test_password");
  });

  it("receives, maps and decrypts a modern V1 account through the transport", async () => {
    const { prepared, session } = await received(rawModernV1Account());
    expect(prepared.binding.accountVersion).toBe("v1");
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.login?.password).toBe("test_password");
  });

  it("maps the matching organization account and decrypts independent organization fields", async () => {
    const { prepared, session } = await received(rawOrganizationAccount());
    expect(prepared.organizationKeys).toHaveLength(1);
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Synthetic organization login");
    expect(result.data.login?.username).toBe("synthetic-org-user");
    expect(result.data.login?.password).toBe("synthetic-org-password");
  });

  it("password-unlocks V2 from modern wire data and decrypts the independently recorded sealed blob", async () => {
    const { prepared, session } = await received(rawV2Account());
    expect(prepared.binding.accountVersion).toBe("v2");
    expect(prepared.kdf).toEqual({ argon2id: { iterations: 6, memory: 32, parallelism: 4 } });
    expect(prepared.masterPasswordUnlock.salt).toBe(v2UnlockSalt);
    expect(prepared.masterPasswordUnlock.containedKeyId).toBe(v2ContainedKeyId);
    expect(session.metadata.securityVersion).toBe(2);
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Test Cipher");
    expect(result.data.notes).toBe("Some notes");
  });

  it.each(["v1", "v2"] as const)(
    "retains a valid known provider binding's security floor for a %s account",
    (accountVersion) => {
      const raw = accountVersion === "v2" ? rawV2Account() : rawV1Account();
      const result = mapRaw(raw, { ...known, accountVersion });
      expect(result.ok).toBe(true);
      // A V1 account under a floor-2 binding keeps the floor, so the session refuses it.
      if (result.ok) expect(result.data.minimumSecurityVersion).toBe(2);
    },
  );

  it.each([undefined, null])(
    "password-unlocks and verifies V2 when sync omits optional signedPublicKey as %s",
    async (value) => {
      const raw = rawV2Account();
      setAt(
        raw,
        ["sync", "profile", "accountKeys", "publicKeyEncryptionKeyPair", "signedPublicKey"],
        value,
      );
      const { prepared, session } = await received(raw);
      expect(prepared.binding.accountVersion).toBe("v2");
      expect(
        "V2" in prepared.accountCryptographicState &&
          prepared.accountCryptographicState.V2.signed_public_key,
      ).toBe(raw.token.AccountKeys.publicKeyEncryptionKeyPair.signedPublicKey);
      expect(session.metadata.securityVersion).toBe(2);
      const result = await session.decryptCipher({
        connectionId: accountProfile.connectionId,
        cipher: prepared.ciphers[0],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.name).toBe("Test Cipher");
    },
  );

  it("rejects a V2 account when both responses omit signedPublicKey", async () => {
    // The pinned SDK requires the signed public key for V2 account state.
    const raw = rawV2Account();
    setAt(
      raw,
      ["sync", "profile", "accountKeys", "publicKeyEncryptionKeyPair", "signedPublicKey"],
      undefined,
    );
    setAt(raw, ["token", "AccountKeys", "publicKeyEncryptionKeyPair", "signedPublicKey"], null);
    expect(await mapReceived(raw)).toEqual({ ok: false, error: { code: "invalid-response" } });
  });

  it("does not discard a tampered signedPublicKey supplied only by the token", async () => {
    const raw = rawV2Account();
    setAt(
      raw,
      ["sync", "profile", "accountKeys", "publicKeyEncryptionKeyPair", "signedPublicKey"],
      undefined,
    );
    const bytes = Uint8Array.from(
      atob(raw.token.AccountKeys.publicKeyEncryptionKeyPair.signedPublicKey),
      (part) => part.charCodeAt(0),
    );
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    raw.token.AccountKeys.publicKeyEncryptionKeyPair.signedPublicKey = btoa(
      String.fromCharCode(...bytes),
    );
    const prepared = mapRaw(raw);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(await initializePrepared(prepared.data)).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it.each([
    [2, "secureNote", { type: 0 }, { type: 0 }],
    [
      3,
      "card",
      { number: rawLoginCipher().login.password },
      { number: rawLoginCipher().login.password },
    ],
    [
      4,
      "identity",
      { firstName: rawLoginCipher().login.username },
      { firstName: rawLoginCipher().login.username },
    ],
  ])(
    "maps and decrypts ordinary received type%d with recorded ciphertext",
    async (type, kind, typed, flat) => {
      const raw = rawV1Account();
      const cipher = raw.sync.ciphers[0]!;
      setAt(cipher, ["type"], type);
      setAt(cipher, ["login"], null);
      setAt(cipher, [String(kind)], typed);
      cipher.data = JSON.stringify({ name: cipher.name, ...flat });
      const { prepared, session } = await received(raw);
      const result = await session.decryptCipher({
        connectionId: accountProfile.connectionId,
        cipher: prepared.ciphers[0],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.name).toBe("My test login");
      if (type === 2) expect(result.data.secureNote?.type).toBe(0);
      if (type === 3) expect(result.data.card?.number).toBe("test_password");
      if (type === 4) expect(result.data.identity?.firstName).toBe("test_username");
    },
  );

  /** Server-stored Data is PascalCase with nulls omitted; the response model carries nulls. */
  function serverStoredLogin(passwordRevisionDate: string | null) {
    const raw = rawModernV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    const login = rawLoginCipher().login;
    // Any recorded ciphertext stands in for the encrypted URI.
    const uri = login.username;
    cipher["login"] = {
      ...login,
      uri: uri,
      uris: [{ uri: uri, uriChecksum: null, match: null }],
      passwordRevisionDate,
    };
    cipher["attachments"] = null;
    cipher["data"] = JSON.stringify({
      Uri: uri,
      Uris: [{ Uri: uri }],
      Username: login.username,
      Password: login.password,
      ...(passwordRevisionDate ? { PasswordRevisionDate: "2024-01-30T17:55:36.15Z" } : {}),
      Name: cipher["name"],
    });
    return raw;
  }

  it.each([null, "2024-01-30T17:55:36.150Z"])(
    "accepts server-stored Data that omits nulls (revision date %j)",
    async (date) => {
      const { prepared, session } = await received(serverStoredLogin(date));
      const result = await session.decryptCipher({
        connectionId: accountProfile.connectionId,
        cipher: prepared.ciphers[0],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.login?.password).toBe("test_password");
    },
  );

  it("still rejects stored Data that contradicts the response model", () => {
    const raw = serverStoredLogin(null);
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    cipher["data"] = JSON.stringify({
      ...JSON.parse(cipher["data"] as string),
      Username: v1WrappedUserKey,
    });
    expect(mapRaw(raw)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("maps an identity whose stored Data spells SSN in capitals", async () => {
    const raw = rawModernV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    const secret = rawLoginCipher().login.password;
    cipher["type"] = 4;
    cipher["login"] = null;
    cipher["identity"] = { ssn: secret };
    cipher["data"] = JSON.stringify({ Name: cipher["name"], SSN: secret });
    const { prepared, session } = await received(raw);
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.identity?.ssn).toBe("test_password");
  });

  it.each([0, 1])("maps an organization collection of type %d", (type) => {
    const raw = rawOrganizationAccount();
    (raw.sync.collections as unknown[]).push({
      id: "2bc9ac1e-f5aa-45f2-94bf-b181009709b8",
      organizationId: "1bc9ac1e-f5aa-45f2-94bf-b181009709b8",
      name: rawLoginCipher().login.username,
      externalId: null,
      readOnly: false,
      hidePasswords: false,
      manage: false,
      type,
      object: "collectionDetails",
    });
    expect(mapRaw(raw).ok).toBe(true);
  });

  function rawWithCollection(fields: Record<string, unknown>) {
    const raw = rawOrganizationAccount();
    (raw.sync.collections as unknown[]).push({
      id: "2bc9ac1e-f5aa-45f2-94bf-b181009709b8",
      organizationId: "1bc9ac1e-f5aa-45f2-94bf-b181009709b8",
      name: rawLoginCipher().login.username,
      externalId: null,
      readOnly: false,
      hidePasswords: false,
      manage: false,
      type: 0,
      object: "collectionDetails",
      ...fields,
    });
    return raw;
  }

  // The web admin console saves a blank External ID input as "". Pateat never
  // reads either field, so an empty value is the same as an absent one.
  it.each([
    ["externalId", { externalId: "" }],
    ["defaultUserCollectionEmail", { defaultUserCollectionEmail: "" }],
    [
      "externalId and defaultUserCollectionEmail",
      { externalId: "", defaultUserCollectionEmail: "" },
    ],
  ])("treats an empty collection %s like an absent one", (_name, fields) => {
    const result = mapRaw(rawWithCollection(fields));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const collection = result.data.encryptedMetadata.collections.find(
      ({ id }) => id === "2bc9ac1e-f5aa-45f2-94bf-b181009709b8",
    );
    expect(collection).toBeDefined();
    expect(collection?.externalId).toBeUndefined();
    expect(collection?.defaultUserCollectionEmail).toBeUndefined();
    const admitted = admitPreparedBitwardenAccount(structuredClone(result.data), accountProfile);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.data.encryptedMetadata).toEqual(result.data.encryptedMetadata);
  });

  it.each([
    ["externalId", { externalId: 5 }],
    ["defaultUserCollectionEmail", { defaultUserCollectionEmail: 5 }],
  ])("refuses a non-string collection %s", (_name, fields) => {
    expect(mapRaw(rawWithCollection(fields))).toMatchObject({
      ok: false,
      error: { code: "invalid-response" },
    });
  });

  // Bitwarden server before v2025.7.0 and Vaultwarden 1.35.x–1.36.0 send no
  // collection type; such a collection is a SharedCollection (0).
  it.each([
    ["missing", "absent"],
    ["null", null],
  ])("maps a collection with a %s type as a shared collection", (_name, type) => {
    const raw = rawWithCollection({});
    const collections = raw.sync.collections as Record<string, unknown>[];
    const pushed = collections.at(-1)!;
    if (type === "absent") delete pushed["type"];
    else pushed["type"] = type;
    expect(Object.hasOwn(pushed, "type")).toBe(type !== "absent");
    const result = mapRaw(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const collection = result.data.encryptedMetadata.collections.find(
      ({ id }) => id === "2bc9ac1e-f5aa-45f2-94bf-b181009709b8",
    );
    expect(collection?.type).toBe(0);
    const admitted = admitPreparedBitwardenAccount(structuredClone(result.data), accountProfile);
    expect(admitted.ok).toBe(true);
  });

  it.each([2, -1, "0", "1", true])("refuses a collection of type %j", (type) => {
    expect(mapRaw(rawWithCollection({ type }))).toMatchObject({
      ok: false,
      error: { code: "invalid-response" },
    });
  });

  it("accepts attachments carrying the response model type tag", () => {
    const raw = rawModernV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    cipher["attachments"] = [
      {
        id: "a1b2c3",
        url: null,
        fileName: rawLoginCipher().login.username,
        key: null,
        size: "10",
        sizeName: "10 Bytes",
        object: "attachment",
      },
    ];
    expect(mapRaw(raw).ok).toBe(true);
    (cipher["attachments"] as Record<string, unknown>[])[0]!["object"] = "cipher";
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("ignores unsigned advertised securityVersion when determining verified local state", async () => {
    const raw = rawV2Account();
    raw.sync.profile.accountKeys.securityState.securityVersion = 99;
    raw.token.AccountKeys.securityState.securityVersion = 99;
    const { prepared, session } = await received(raw);
    expect(prepared.minimumSecurityVersion).toBe(1);
    expect(session.metadata.securityVersion).toBe(2);
  });

  it("keeps authentication KDF independent from modern vault unlock KDF", () => {
    const raw = rawV2Account();
    raw.token.Kdf = 0;
    raw.token.KdfIterations = 100_000;
    setAt(raw, ["token", "KdfMemory"], null);
    setAt(raw, ["token", "KdfParallelism"], null);
    const result = mapRaw(raw);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data.kdf).toEqual({ argon2id: { iterations: 6, memory: 32, parallelism: 4 } });
  });
});

describe("account and provider binding admission", () => {
  it.each([
    ["tokenType", "MAC"],
    ["expiresIn", 0],
    ["expiresIn", "3600"],
    ["expiresIn", 1.5],
  ])("rejects malformed authenticated-token metadata %s", (name, value) => {
    const raw = rawV1Account();
    const outcome = authenticated(raw);
    setAt(outcome, ["tokens", name as string], value);
    expect(
      mapper().map({
        connectionId: accountProfile.connectionId,
        authenticated: outcome,
        sync: raw.sync,
      }).ok,
    ).toBe(false);
  });

  it.each([
    { sub: "10000000-0000-4000-8000-000000000002" },
    { sub: "not-a-uuid" },
    { email: "other@example.test" },
    { exp: accountNow },
    { exp: accountNow - 1 },
    { exp: "future" },
    { exp: 1.5 },
    { nbf: accountNow + 301 },
    { nbf: "future" },
    { nbf: 1.5 },
    { nbf: -1 },
    { iat: "past" },
    { sstamp: "other-stamp" },
    { iss: 5 },
    { aud: { secret: "synthetic-secret" } },
  ])("rejects inconsistent or malformed JWT claims %j", (claims) => {
    const raw = rawV1Account();
    raw.token.access_token = syntheticJwt(claims);
    expect(mapRaw(raw).ok).toBe(false);
  });

  // Bitwarden (Duende) and Vaultwarden set nbf to the server's issue second, so a browser clock
  // slightly behind the server must still accept a fresh token; 300 s is the skew Duende allows
  // by default when it validates a token.
  it.each([1, 60, 300])("accepts a token whose nbf is %i s ahead of the local clock", (ahead) => {
    const raw = rawV1Account();
    raw.token.access_token = syntheticJwt({ nbf: accountNow + ahead, iat: accountNow + ahead });
    expect(mapRaw(raw).ok).toBe(true);
  });

  it.each([
    { nbf: accountNow + 301 },
    { nbf: accountNow + 3600 },
    { exp: accountNow },
    { exp: accountNow - 1 },
    { exp: accountNow, nbf: accountNow + 300 },
  ])("reports a token outside its validity window as expired %j", (claims) => {
    const raw = rawV1Account();
    raw.token.access_token = syntheticJwt(claims);
    expect(mapRaw(raw)).toEqual({ ok: false, error: { code: "authentication-expired" } });
  });

  it.each(["opaque-token", "a.b.c", "e30.e30.c3ludGhldGlj", "x".repeat(200_000)])(
    "rejects malformed bounded JWT without echoing it",
    (accessToken) => {
      const raw = rawV1Account();
      raw.token.access_token = accessToken;
      const result = mapRaw(raw);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(accessToken);
    },
  );

  it("does not infer public provider identity from an opaque internal JWT issuer", () => {
    const raw = rawV1Account();
    raw.token.access_token = syntheticJwt({ iss: "http://internal-identity", aud: ["api"] });
    expect(mapRaw(raw).ok).toBe(true);
  });

  it("normalizes matching account email and security-stamp spelling", () => {
    const raw = rawV1Account();
    raw.sync.profile.email = v1Email.toUpperCase();
    raw.token.access_token = syntheticJwt({
      email: v1Email.toUpperCase(),
      sstamp: raw.sync.profile.securityStamp.toUpperCase(),
    });
    const result = mapRaw(raw, { ...bootstrap, email: v1Email.toUpperCase() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.binding.email).toBe(v1Email);
  });

  it.each([NaN, Infinity, -1, accountNow + 0.5])(
    "rejects an invalid trusted clock value %s",
    (now) => {
      const raw = rawV1Account();
      const created = createBitwardenAccountMapper(accountProfile, bootstrap, {
        nowSeconds: () => now,
      });
      expect(created.ok).toBe(true);
      if (created.ok)
        expect(
          created.data.map({
            connectionId: accountProfile.connectionId,
            authenticated: authenticated(raw),
            sync: raw.sync,
          }),
        ).toEqual({ ok: false, error: { code: "invalid-options" } });
    },
  );

  it("rejects a different request connection", () => {
    const raw = rawV1Account();
    expect(
      mapper().map({
        connectionId: "other-connection",
        authenticated: authenticated(raw),
        sync: raw.sync,
      }).ok,
    ).toBe(false);
  });

  it.each([
    { ...known, userId: "10000000-0000-4000-8000-000000000002" },
    { ...known, email: "other@example.test" },
  ])("rejects an account outside the known binding %j", (binding) => {
    expect(mapRaw(rawV2Account(), binding).ok).toBe(false);
  });

  it.each([
    { ...accountProfile, connectionId: "other-connection" },
    { ...accountProfile, environment: { kind: "cloud", region: "eu" } },
    {
      ...accountProfile,
      environment: { kind: "self-hosted", baseUrl: "https://vault.example.test" },
    },
  ])("rejects reusing a prior binding on another provider %j", (profile) => {
    expect(createBitwardenAccountMapper(profile, known, { nowSeconds: () => accountNow }).ok).toBe(
      false,
    );
  });

  it("rejects a known V2 account returning V1 even with security floor1", () => {
    expect(mapRaw(rawV1Account(), { ...known, minimumSecurityVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: "security-downgrade" },
    });
  });
});

describe("strict modern data without legacy alias fallback", () => {
  it.each([
    ["sync", "profile", "accountKeys", "signatureKeyPair"],
    ["sync", "profile", "accountKeys", "securityState"],
    ["sync", "userDecryption", "masterPasswordUnlock", "salt"],
    ["sync", "userDecryption", "masterPasswordUnlock", "kdf"],
  ])("rejects partial modern metadata at %j despite legacy fields", (...path) => {
    const raw = rawV2Account();
    setAt(raw, path, undefined);
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("rejects token V2 versus stripped sync V1 independently of caller floor", () => {
    const raw = rawV2Account();
    setAt(raw, ["sync", "profile", "accountKeys"], undefined);
    setAt(raw, ["sync", "profile", "privateKey"], v1PrivateKey);
    setAt(raw, ["sync", "profile", "key"], v1WrappedUserKey);
    setAt(raw, ["sync", "userDecryption"], null);
    expect(mapRaw(raw).ok).toBe(false);
  });

  it.each([
    [["sync", "profile", "key"], v1WrappedUserKey],
    [["sync", "profile", "privateKey"], v1PrivateKey],
    [["sync", "profile", "accountKeys", "securityState", "securityState"], "malformed"],
    [
      ["sync", "profile", "accountKeys", "publicKeyEncryptionKeyPair", "signedPublicKey"],
      "not-base64",
    ],
    [["sync", "userDecryption", "userKeyId"], "ffffffffffffffffffffffffffffffff"],
    [["sync", "userDecryption", "masterPasswordUnlock", "containedKeyId"], "bad"],
    [["sync", "userDecryption", "masterPasswordUnlock", "kdf", "kdfType"], 99],
  ] as Array<[string[], unknown]>)(
    "rejects contradictory/unknown modern metadata at %j",
    (path, value) => {
      const raw = rawV2Account();
      setAt(raw, path, value);
      expect(mapRaw(raw).ok).toBe(false);
    },
  );

  it.each([{}, "malformed"])(
    "does not fall back when modern accountKeys is malformed as %j",
    (value) => {
      const raw = rawV1Account();
      setAt(raw, ["sync", "profile", "accountKeys"], value);
      expect(mapRaw(raw).ok).toBe(false);
    },
  );

  it("maps a modern V1 account whose token unlock data omits the contained key ID", () => {
    const mapped = mapRaw(rawModernV1Account());
    expect(mapped).toMatchObject({ ok: true, data: { binding: { accountVersion: "v1" } } });
    if (mapped.ok)
      expect(mapped.data.masterPasswordUnlock.containedKeyId).toBe(
        "0123456789abcdef0123456789abcdef",
      );
  });

  it("still rejects a token contained key ID that contradicts sync", () => {
    const raw = rawModernV1Account();
    setAt(
      raw,
      ["token", "UserDecryptionOptions", "MasterPasswordUnlock", "ContainedKeyId"],
      "ffffffffffffffffffffffffffffffff",
    );
    expect(mapRaw(raw)).toEqual({
      ok: false,
      error: { code: "account-mismatch", check: "token-unlock" },
    });
  });

  it("names the failed check without any compared value", () => {
    expect(
      mapRaw(rawModernV1Account(), { kind: "bootstrap", email: "other@example.test" }),
    ).toEqual({ ok: false, error: { code: "account-mismatch", check: "configured-email" } });
  });

  it("accepts an explicitly null legacy AccountKeys field only without V2 evidence", () => {
    const raw = rawV1Account();
    setAt(raw, ["sync", "profile", "accountKeys"], null);
    expect(mapRaw(raw).ok).toBe(true);
    expect(mapRaw(raw, { ...known, minimumSecurityVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: "security-downgrade" },
    });
  });

  it.each([
    [["sync", "profile", "forcePasswordReset"], true],
    [["sync", "profile", "usesKeyConnector"], true],
    [["token", "ForcePasswordReset"], true],
    [["token", "ApiUseKeyConnector"], true],
  ] as Array<[string[], unknown]>)(
    "does not silently ordinary-unlock another required ceremony at %j",
    (path, value) => {
      const raw = rawV1Account();
      setAt(raw, path, value);
      expect(mapRaw(raw)).toEqual({ ok: false, error: { code: "unsupported-unlock" } });
    },
  );

  it("rejects conflicting Pascal/camel aliases", () => {
    const raw = rawV1Account();
    setAt(raw, ["sync", "profile", "Key"], "2.synthetic-conflicting-key");
    expect(mapRaw(raw).ok).toBe(false);
  });
});

describe("received-envelope item mapping", () => {
  it.each([5, 6, 7, 8, 99])(
    "reports unsupported type%d without forwarding encrypted secrets or blocking login",
    (type) => {
      const raw = rawV1Account();
      raw.sync.ciphers.push({
        ...rawLoginCipher(),
        id: "10000000-0000-4000-8000-000000000003",
        type,
        name: "synthetic-unavailable-secret",
        data: "synthetic-unavailable-blob",
      });
      const result = mapRaw(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.ciphers).toHaveLength(1);
      expect(result.data.unavailableItems).toEqual([
        { itemId: "10000000-0000-4000-8000-000000000003", reason: "unsupported-cipher-type" },
      ]);
      expect(JSON.stringify(result.data)).not.toContain("synthetic-unavailable-secret");
      expect(JSON.stringify(result.data)).not.toContain("synthetic-unavailable-blob");
      expect(result.data.coverage).toBe("received-envelope");
    },
  );

  it("rejects an unavailable item with invalid identifying metadata", () => {
    const raw = rawV1Account();
    raw.sync.ciphers.push({ ...rawLoginCipher(), id: "not-an-id", type: 99 });
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("rejects duplicate organization identifiers rather than selecting a key", () => {
    const raw = rawOrganizationAccount();
    setAt(
      raw,
      ["sync", "profile", "organizations"],
      [
        { id: TEST_ORGANIZATION_ID, key: TEST_ORGANIZATION_KEY, enabled: true, status: 2 },
        { id: TEST_ORGANIZATION_ID, key: TEST_ORGANIZATION_KEY, enabled: true, status: 2 },
      ],
    );
    expect(mapRaw(raw)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it.each([
    [1, 1],
    [1, 5],
    [5, 1],
    [5, 99],
  ])("rejects duplicate supported/unavailable IDs with types %i and %i", (first, second) => {
    const raw = rawV1Account();
    raw.sync.ciphers[0]!.type = first;
    raw.sync.ciphers.push({ ...rawLoginCipher(), type: second });
    expect(mapRaw(raw).ok).toBe(false);
  });

  it.each(["profile", "ciphers", "folders", "collections", "policies", "sends"])(
    "rejects a truncated envelope missing %s",
    (key) => {
      const raw = rawV1Account();
      setAt(raw, ["sync", key], undefined);
      expect(mapRaw(raw).ok).toBe(false);
    },
  );

  it("keeps an empty envelope explicitly non-authoritative", () => {
    const raw = rawV1Account();
    raw.sync.ciphers = [];
    const result = mapRaw(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ciphers).toEqual([]);
      expect(result.data.coverage).toBe("received-envelope");
      expect(result.data).not.toHaveProperty("complete");
    }
  });

  it("ignores item keys Pateat does not read, as Vaultwarden returns them", async () => {
    // Vaultwarden returns the JSON a client stored and sends no Data. The official CLI's
    // `bw import` stores `response: null` in a passkey.
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    delete cipher["data"];
    cipher["login"] = {
      ...(cipher["login"] as Record<string, unknown>),
      futureField: "not-guessed",
      fido2Credentials: [{ ...fidoCredential, response: null }],
    };
    const { prepared, session } = await received(raw);
    expect(JSON.stringify(prepared.ciphers)).not.toMatch(/futureField|"response"/u);
    const request = { connectionId: accountProfile.connectionId, cipher: prepared.ciphers[0] };
    expect((await session.decryptCipher(request)).ok).toBe(true);
    expect(await session.decryptFido2PrivateKey(request)).toEqual({
      ok: true,
      data: fidoPrivateKey,
    });
  });

  it("ignores unknown typed keys beside the official server's stored Data", async () => {
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    cipher["login"] = { ...(cipher["login"] as Record<string, unknown>), futureField: "a" };
    const data = JSON.parse(cipher["data"] as string) as Record<string, unknown>;
    cipher["data"] = JSON.stringify({ ...data, futureField: "b" });
    const { prepared, session } = await received(raw);
    expect(JSON.stringify(prepared.ciphers)).not.toContain("futureField");
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok && result.data.login?.password).toBe("test_password");
  });

  it.each(["Envelope", "WrappedCek", "FormatVersion", "ENVELOPE", "WRAPPED_CEK", "Format_Version"])(
    "does not read flat Data with the sealed-blob key %s as legacy fields",
    (key) => {
      const raw = rawV1Account();
      const cipher = raw.sync.ciphers[0]!;
      cipher.data = JSON.stringify({ ...JSON.parse(cipher.data), [key]: "synthetic" });
      expect(mapRaw(raw).ok).toBe(false);
    },
  );

  it.each([
    ["login", []],
    ["login", ["synthetic"]],
    ["fields", [[]]],
  ])("refuses an array where %s holds an object", (name, value) => {
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    delete cipher["data"];
    cipher[name] = value;
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("ignores legacy flat Data keys outside the item's type", async () => {
    const raw = rawV1Account();
    const cipher = raw.sync.ciphers[0]!;
    cipher.data = JSON.stringify({ ...JSON.parse(cipher.data), futureField: "not-guessed" });
    const { prepared } = await received(raw);
    expect(JSON.stringify(prepared.ciphers)).not.toContain("futureField");
  });

  it("rejects conflicting legacy flat Data and typed login fields", () => {
    const raw = rawV1Account();
    raw.sync.ciphers[0]!.data = JSON.stringify({
      name: raw.sync.ciphers[0]!.name,
      username: "2.conflicting-username",
      password: raw.sync.ciphers[0]!.login.password,
    });
    expect(mapRaw(raw)).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("does not reinterpret an unknown claimed sealed format as legacy fields", () => {
    const raw = rawV1Account();
    raw.sync.ciphers[0]!.data = JSON.stringify({
      format_version: 99,
      wrapped_cek: "synthetic",
      envelope: "synthetic",
    });
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("rejects a partial cipher even when it carries plausible login fields", () => {
    const raw = rawV1Account();
    setAt(raw, ["sync", "ciphers", 0, "partialData"], { name: raw.sync.ciphers[0]!.name });
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("rejects an organization item with no received organization key", () => {
    const raw = rawOrganizationAccount();
    raw.sync.profile.organizations = [];
    expect(mapRaw(raw).ok).toBe(false);
  });

  it("does not mutate caller-owned DTOs during mapping", () => {
    const raw = rawV2Account();
    const before = structuredClone(raw);
    expect(mapRaw(raw).ok).toBe(true);
    expect(raw).toEqual(before);
  });

  it.each(["login", "fields", "data"])(
    "rejects an own __proto__ member in %s without prototype pollution",
    (target) => {
      const raw = rawV1Account();
      const cipher = raw.sync.ciphers[0]!;
      if (target === "login") {
        setAt(cipher, ["data"], undefined);
        setAt(
          cipher,
          ["login"],
          JSON.parse(
            JSON.stringify(cipher.login).replace(
              /\}$/u,
              ',"__proto__":{"polluted":"synthetic-secret"}}',
            ),
          ),
        );
      } else if (target === "fields") {
        setAt(cipher, ["data"], undefined);
        setAt(
          cipher,
          ["fields"],
          JSON.parse(
            '[{"name":null,"value":null,"type":0,"__proto__":{"polluted":"synthetic-secret"}}]',
          ),
        );
      } else {
        cipher.data = cipher.data.replace(/\}$/u, ',"__proto__":{"polluted":"synthetic-secret"}}');
      }
      const result = mapRaw(raw);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect("polluted" in {}).toBe(false);
    },
  );
});

describe("same-account URI match context", () => {
  const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherOrganizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const policy = (organizationIdValue: string, detection: unknown, enabled: unknown = true) => ({
    id: crypto.randomUUID(),
    organizationId: organizationIdValue,
    type: 16,
    data: { uriMatchDetection: detection },
    enabled,
    object: "policy",
  });
  function context(raw: Raw) {
    const result = mapRaw(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Synthetic account rejected");
    return result.data.uriMatchContext;
  }
  function withOrganization(membership: Record<string, unknown>, policies: unknown[]) {
    // No organization item is received, so a keyless membership still maps.
    const raw = rawV2Account();
    Object.assign(raw.sync.profile, {
      organizations: [{ id: organizationId, enabled: true, status: 2, ...membership }],
    });
    Object.assign(raw.sync, { policies, policiesNew: [] });
    return { raw, id: organizationId };
  }

  it("retains received equivalent domains with the provider's Domain default", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      domains: {
        object: "domains",
        equivalentDomains: [["Example.com", "example.net"]],
        globalEquivalentDomains: [{ type: 3, domains: ["example.org"], excluded: false }],
      },
    });
    expect(context(raw)).toEqual({
      equivalentDomains: [["example.com", "example.net"], ["example.org"]],
      defaultMatch: 0,
    });
    expect(context(rawV1Account())).toEqual({ equivalentDomains: [], defaultMatch: 0 });
  });

  it("marks malformed received domains unavailable without rejecting the account", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, { domains: { equivalentDomains: [["https://example.com/login"]] } });
    expect(context(raw)).toEqual({ equivalentDomains: "unavailable", defaultMatch: 0 });
  });

  it("applies an enforced organization URI match default", () => {
    const { raw, id } = withOrganization({ type: 2, usePolicies: true }, []);
    Object.assign(raw.sync, { policies: [policy(id, 3)] });
    expect(context(raw)?.defaultMatch).toBe(3);
  });

  it.each([
    ["owner", { type: 0 }],
    ["admin", { type: 1 }],
    ["policies unavailable", { type: 2, usePolicies: false }],
    ["disabled organization", { type: 2, enabled: false }],
  ])("does not enforce the default for an exempt %s membership", (_label, membership) => {
    const { raw, id } = withOrganization(membership, []);
    Object.assign(raw.sync, { policies: [policy(id, 3)] });
    expect(context(raw)?.defaultMatch).toBe(0);
  });

  it("exempts a provider user and ignores a disabled policy", () => {
    const { raw, id } = withOrganization({ type: 2 }, []);
    Object.assign(raw.sync.profile, { providerOrganizations: [{ id, enabled: true }] });
    Object.assign(raw.sync, { policies: [policy(id, 3)] });
    expect(context(raw)?.defaultMatch).toBe(0);
    const disabled = withOrganization({ type: 2 }, []);
    Object.assign(disabled.raw.sync, { policies: [policy(disabled.id, 3, false)] });
    expect(context(disabled.raw)?.defaultMatch).toBe(0);
  });

  it("enforces a policy whose organization context is missing", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, { policies: [policy(organizationId, 2)] });
    expect(context(raw)?.defaultMatch).toBe(2);
  });

  it("falls back to Domain for absent or invalid policy data", () => {
    for (const detection of [undefined, null, 6, "3"]) {
      const raw = rawV2Account();
      Object.assign(raw.sync, { policies: [policy(organizationId, detection)] });
      expect(context(raw)?.defaultMatch).toBe(0);
    }
  });

  it("fails closed when enforced organizations disagree instead of using response order", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      policies: [policy(organizationId, 1), policy(otherOrganizationId, 3)],
    });
    expect(context(raw)?.defaultMatch).toBe("unavailable");
    const agreeing = rawV2Account();
    Object.assign(agreeing.sync, {
      policies: [policy(organizationId, 1), policy(otherOrganizationId, 1)],
    });
    expect(context(agreeing)?.defaultMatch).toBe(1);
  });

  it("prefers non-empty policiesNew and otherwise falls back to policies", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      policies: [policy(organizationId, 1)],
      policiesNew: [policy(organizationId, 3)],
    });
    expect(context(raw)?.defaultMatch).toBe(3);
    Object.assign(raw.sync, { policiesNew: [] });
    expect(context(raw)?.defaultMatch).toBe(1);
    Object.assign(raw.sync, { policiesNew: null });
    expect(context(raw)?.defaultMatch).toBe(1);
  });

  it.each([{ enabled: "true" }, { organizationId: "not-a-uuid" }])(
    "marks a malformed URI default policy unavailable case %#",
    (change) => {
      const raw = rawV2Account();
      Object.assign(raw.sync, { policies: [{ ...policy(organizationId, 1), ...change }] });
      expect(context(raw)?.defaultMatch).toBe("unavailable");
    },
  );

  it("ignores unrelated policy types", () => {
    const raw = rawV2Account();
    Object.assign(raw.sync, {
      policies: [
        { ...policy(organizationId, 3), type: 11 },
        { type: 99, enabled: "odd" },
      ],
    });
    expect(context(raw)?.defaultMatch).toBe(0);
  });
});
