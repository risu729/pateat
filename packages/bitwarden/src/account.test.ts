import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createBitwardenAccountMapper, type PreparedBitwardenAccount } from "./account";
import { createBitwardenTransport } from "./transport";
import { createLocalCryptoSession } from "./local-crypto";
import {
  accountNow,
  accountProfile,
  accountUserId,
  rawLoginCipher,
  rawOrganizationAccount,
  rawV1Account,
  rawV2Account,
  syntheticJwt,
} from "./__fixtures__/account";
import { v1Email, v1Password, v1PrivateKey, v1WrappedUserKey } from "./__fixtures__/crypto";
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
type Raw = ReturnType<typeof rawV1Account> | ReturnType<typeof rawV2Account>;

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

async function received(raw: Raw) {
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
  const prepared = mapper().map({
    connectionId: accountProfile.connectionId,
    authenticated: token.data,
    sync: sync.data,
  });
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

  it("retains a valid known V2 provider binding", () => {
    const result = mapRaw(rawV2Account(), known);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.minimumSecurityVersion).toBe(2);
  });

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

  it("verifies V2 signed state when both responses omit optional signedPublicKey", async () => {
    const raw = rawV2Account();
    setAt(
      raw,
      ["sync", "profile", "accountKeys", "publicKeyEncryptionKeyPair", "signedPublicKey"],
      undefined,
    );
    setAt(raw, ["token", "AccountKeys", "publicKeyEncryptionKeyPair", "signedPublicKey"], null);
    const { prepared, session } = await received(raw);
    expect(
      "V2" in prepared.accountCryptographicState &&
        prepared.accountCryptographicState.V2.signed_public_key,
    ).toBeUndefined();
    expect(session.metadata.securityVersion).toBe(2);
    const result = await session.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: prepared.ciphers[0],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.name).toBe("Test Cipher");
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

  it("ignores unsigned advertised securityVersion when determining verified local state", async () => {
    const raw = rawV2Account();
    raw.sync.profile.accountKeys.securityState.securityVersion = 99;
    raw.token.AccountKeys.securityState.securityVersion = 99;
    const { prepared, session } = await received(raw);
    expect(prepared.minimumSecurityVersion).toBe(1);
    expect(session.metadata.securityVersion).toBe(2);
  });

  it("rejects a tampered signed V2 account after raw DTO preparation without returning a session", async () => {
    const raw = rawV2Account();
    const bytes = Uint8Array.from(
      atob(raw.sync.profile.accountKeys.securityState.securityState),
      (part) => part.charCodeAt(0),
    );
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const corrupted = btoa(String.fromCharCode(...bytes));
    raw.sync.profile.accountKeys.securityState.securityState = corrupted;
    raw.token.AccountKeys.securityState.securityState = corrupted;
    const prepared = mapRaw(raw);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(await initializePrepared(prepared.data)).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
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
    { sub: "10000000-0000-4000-8000-000000000002" },
    { sub: "not-a-uuid" },
    { email: "other@example.test" },
    { exp: accountNow },
    { exp: accountNow - 1 },
    { exp: "future" },
    { exp: 1.5 },
    { nbf: accountNow + 1 },
    { nbf: "future" },
    { iat: "past" },
    { sstamp: "other-stamp" },
    { iss: 5 },
    { aud: { secret: "synthetic-secret" } },
  ])("rejects inconsistent or malformed JWT claims %j", (claims) => {
    const raw = rawV1Account();
    raw.token.access_token = syntheticJwt(claims);
    expect(mapRaw(raw).ok).toBe(false);
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

  it("rejects a signed-security floor downgrade after native initialization", async () => {
    const result = mapRaw(rawV1Account(), { ...known, accountVersion: "v1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      await createLocalCryptoSession(
        {
          connectionId: accountProfile.connectionId,
          userId: result.data.binding.userId,
          email: v1Email,
          kdf: result.data.kdf,
          accountCryptographicState: result.data.accountCryptographicState,
          unlock: {
            kind: "password",
            password: v1Password,
            masterPasswordUnlock: result.data.masterPasswordUnlock,
          },
          minimumSecurityVersion: result.data.minimumSecurityVersion,
        },
        sdk,
      ),
    ).toEqual({ ok: false, error: { code: "security-downgrade" } });
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

  it("rejects duplicate received cipher IDs", () => {
    const raw = rawV1Account();
    raw.sync.ciphers.push(rawLoginCipher());
    expect(mapRaw(raw).ok).toBe(false);
  });

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
        { id: "1bc9ac1e-f5aa-45f2-94bf-b181009709b8", enabled: false },
        { id: "1bc9ac1e-f5aa-45f2-94bf-b181009709b8", enabled: false },
      ],
    );
    expect(mapRaw(raw).ok).toBe(false);
  });

  it.each([
    [1, 5],
    [5, 1],
    [5, 99],
  ])("rejects duplicate supported/unavailable IDs with types%j", (first, second) => {
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

  it("rejects conflicting legacy flat Data and typed login fields", () => {
    const raw = rawV1Account();
    raw.sync.ciphers[0]!.data = JSON.stringify({
      name: raw.sync.ciphers[0]!.name,
      username: "2.conflicting-username",
      password: raw.sync.ciphers[0]!.login.password,
    });
    expect(mapRaw(raw).ok).toBe(false);
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
      expect(Object.hasOwn({}, "polluted")).toBe(false);
    },
  );
});
