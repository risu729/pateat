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
} from "./__fixtures__/account";
import { v1Email, v1Password, v1WrappedUserKey } from "./__fixtures__/crypto";
import { jsonResponse } from "./__fixtures__/transport";
import { v2ContainedKeyId, v2UnlockSalt } from "./__fixtures__/account-generated";
import { registerBindingAdmissionCases } from "../test/account/binding-admission-cases";
import { registerModernAccountCases } from "../test/account/modern-account-cases";
import { registerItemMappingCases } from "../test/account/item-mapping-cases";
import { registerSameAccountUriCases } from "../test/account/same-account-uri-cases";

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

/** One item the mapper cannot admit leaves out only that item, named with why (ADR 0006). */
function expectLeftOut(raw: Raw, reason: string, index = 0) {
  const itemId = String((raw.sync.ciphers[index] as Record<string, unknown>)["id"]).toLowerCase();
  const result = mapRaw(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) return result;
  expect(result.data.ciphers.map((cipher) => String(cipher.id))).not.toContain(itemId);
  expect(result.data.unavailableItems).toContainEqual({ itemId, reason });
  return result;
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

export type AccountTestRaw = Raw;
export type AccountTestFixtures = {
  bootstrap: typeof bootstrap;
  known: typeof known;
  setAt: typeof setAt;
  authenticated: typeof authenticated;
  mapper: typeof mapper;
  mapRaw: typeof mapRaw;
  expectLeftOut: typeof expectLeftOut;
  received: typeof received;
  rawWithCollection: typeof rawWithCollection;
};

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
      error: { code: "crypto-failed", check: "session-open" },
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

  it("leaves out an item whose stored Data contradicts the response model", () => {
    const raw = serverStoredLogin(null);
    const cipher = raw.sync.ciphers[0]! as Record<string, unknown>;
    cipher["data"] = JSON.stringify({
      ...JSON.parse(cipher["data"] as string),
      Username: v1WrappedUserKey,
    });
    expectLeftOut(raw, "malformed-item");
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

  it("accepts attachments carrying the response model type tag, and no other", () => {
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
    expectLeftOut(raw, "malformed-item");
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
  registerBindingAdmissionCases({ bootstrap, known, setAt, authenticated, mapper, mapRaw });
});

describe("strict modern data without legacy alias fallback", () => {
  registerModernAccountCases({ known, setAt, mapRaw });
});

describe("received-envelope item mapping", () => {
  registerItemMappingCases({ setAt, mapRaw, expectLeftOut, received, rawWithCollection });
});

describe("same-account URI match context", () => {
  registerSameAccountUriCases({ mapRaw });
});
