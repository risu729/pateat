import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalCryptoSession, type LocalCryptoSession } from "@pateat/bitwarden";
import {
  listStoredPasskeys,
  findStoredPasskeys,
  selectPasskeyItem,
  signStoredPasskey,
  type PasskeySignRequest,
} from "./passkey";
import {
  fidoCredential,
  fidoPrivateKey,
  legacyCipher,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
} from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { nodeSdk } from "../../../../packages/bitwarden/src/__fixtures__/node-sdk";
import { concatBytes, fromBase64Url, sha256, toBase64Url } from "../passkeys/encoding";
import { derToP1363 } from "../passkeys/signature";

const binding = {
  connectionId: "synthetic-passkey-a",
  userId: "00000000-0000-0000-0000-000000000000",
  snapshotId: "11111111-1111-4111-8111-111111111111",
};
const itemId = "090c19ea-a61a-4df6-8963-262b97bc6266";
// The fixture's GUID credential ID and RP ID as the mapping exposes them.
const credentialId = "EjRWeBI0QjSCNBI0VniavA";
const rpId = "synthetic.example.test";
const sessions: LocalCryptoSession[] = [];
/** A decrypted SDK passkey view, for stub sessions. */
const decryptedView = {
  credentialId: "12345678-1234-4234-8234-123456789abc",
  keyType: "public-key",
  keyAlgorithm: "ECDSA",
  keyCurve: "P-256",
  keyValue: "2.synthetic-unused",
  rpId,
  userHandle: "c3ludGhldGljLXVzZXI=",
  userName: null,
  counter: "0",
  rpName: null,
  userDisplayName: null,
  discoverable: "true",
  creationDate: "2024-01-30T17:55:36.150Z",
};

async function session() {
  const created = await createLocalCryptoSession(
    {
      connectionId: binding.connectionId,
      userId: binding.userId,
      email: v1Email,
      kdf: v1Kdf,
      accountCryptographicState: { V1: { private_key: v1PrivateKey } },
      unlock: {
        kind: "password",
        password: v1Password,
        masterPasswordUnlock: {
          kdf: v1Kdf,
          masterKeyWrappedUserKey: v1WrappedUserKey,
          salt: v1Email,
        },
      },
    },
    nodeSdk,
  );
  if (!created.ok) throw new Error("Synthetic account was not initialized");
  sessions.push(created.data);
  return created.data;
}

/** The session is frozen, so observe key decryption through a delegating view. */
async function spiedSession() {
  const real = await session();
  const decrypt = vi.fn<LocalCryptoSession["decryptFido2PrivateKey"]>((input) =>
    real.decryptFido2PrivateKey(input),
  );
  const active = {
    decryptFido2Credentials: (
      input: Parameters<LocalCryptoSession["decryptFido2Credentials"]>[0],
    ) => real.decryptFido2Credentials(input),
    decryptFido2PrivateKey: decrypt,
  } as unknown as LocalCryptoSession;
  return { active, decrypt };
}

function cipher(credentials: readonly unknown[] = [fidoCredential]) {
  const original = legacyCipher();
  return { ...original, login: { ...original.login, fido2Credentials: credentials } };
}

async function authenticatorData(flags = 0x1d, rp = rpId, counter = 0) {
  const tail = new Uint8Array(5);
  tail[0] = flags;
  new DataView(tail.buffer).setUint32(1, counter);
  return concatBytes(await sha256(new TextEncoder().encode(rp)), tail);
}

async function request(overrides: Partial<PasskeySignRequest> = {}): Promise<PasskeySignRequest> {
  return {
    credentialId,
    rpId,
    authenticatorData: toBase64Url(await authenticatorData()),
    clientDataHash: toBase64Url(await sha256(new TextEncoder().encode("synthetic client data"))),
    ...overrides,
  };
}

async function verify(signature: string, signed: PasskeySignRequest) {
  const pkcs8 = Uint8Array.from(atob(fidoPrivateKey), (part) => part.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", privateKey);
  const publicJwk: JsonWebKey = { kty: kty!, crv: crv!, x: x!, y: y! };
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const raw = derToP1363(fromBase64Url(signature)!);
  if (!raw) return false;
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    raw,
    concatBytes(fromBase64Url(signed.authenticatorData)!, fromBase64Url(signed.clientDataHash)!),
  );
}

afterEach(() => {
  for (const active of sessions.splice(0)) active.dispose();
  vi.restoreAllMocks();
});

describe("passkey item selection", () => {
  const source = (overrides: { verified?: boolean; live?: boolean } = {}) => ({
    verified: overrides.verified ?? true,
    ciphers: new Map([[itemId, "encrypted-cipher"]]),
    loginUris: new Map(overrides.live === false ? [] : [[itemId, []]]),
  });

  it("selects a verified live login item by case-insensitive item ID", () => {
    for (const id of [itemId, itemId.toUpperCase()])
      expect(selectPasskeyItem(source(), id)).toEqual({
        ok: true,
        data: { itemId, cipher: "encrypted-cipher" },
      });
  });

  it("refuses items before verification", () => {
    expect(selectPasskeyItem(source({ verified: false }), itemId)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  });

  it("refuses deleted, archived, non-login and unknown items", () => {
    expect(selectPasskeyItem(source({ live: false }), itemId)).toEqual({
      ok: false,
      error: { code: "field-missing" },
    });
    expect(selectPasskeyItem(source(), crypto.randomUUID())).toEqual({
      ok: false,
      error: { code: "field-missing" },
    });
  });
});

describe("stored passkey listing", () => {
  it("returns bound, secret-free metadata for the item's credential", async () => {
    const listed = await listStoredPasskeys(await session(), binding, itemId, cipher());
    expect(listed).toEqual({
      ok: true,
      data: [
        {
          ...binding,
          itemId,
          credentialId,
          rpId,
          userHandle: "c3ludGhldGljLXVzZXItaWQ",
          discoverable: true,
          counter: 0,
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain(fidoPrivateKey);
  });

  it("lists nothing for an item without passkeys", async () => {
    expect(await listStoredPasskeys(await session(), binding, itemId, legacyCipher())).toEqual({
      ok: true,
      data: [],
    });
  });

  it("reports an unreadable or ambiguous item without a retiring code", async () => {
    const active = await session();
    expect(
      await listStoredPasskeys(active, binding, itemId, cipher([fidoCredential, fidoCredential])),
    ).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    const corrupt = { ...fidoCredential, rpId: fidoCredential.rpId.replace(/.=$/u, "A=") };
    const listed = await listStoredPasskeys(active, binding, itemId, cipher([corrupt]));
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error.code).not.toMatch(/^crypto-(?:failed|locked)$/u);
  });
});

describe("stored passkey search by RP ID", () => {
  const ids = {
    match: itemId,
    plain: "10000000-0000-4000-8000-000000000001",
    other: "10000000-0000-4000-8000-000000000002",
    corrupt: "10000000-0000-4000-8000-000000000003",
    deleted: "10000000-0000-4000-8000-000000000004",
  };
  const value = fidoCredential.keyValue;
  const mac = value.slice(value.lastIndexOf("|") + 1);
  const brokenRpId = {
    ...fidoCredential,
    rpId: fidoCredential.rpId.replace(/.=$/u, (end) => (end[0] === "A" ? "B=" : "A=")),
  };
  function vault() {
    // Every live login item, as the Worker records them during verification.
    const ciphers = new Map<string, unknown>([
      [ids.corrupt, cipher([brokenRpId])],
      [ids.match, cipher()],
      [ids.plain, legacyCipher()],
      [ids.other, cipher()],
      [ids.deleted, cipher()],
    ]);
    // The unreadable item comes first: the scan must continue past it.
    const loginUris = new Map([ids.corrupt, ids.match, ids.plain, ids.other].map((id) => [id, []]));
    return { verified: true, ciphers, loginUris };
  }

  it("returns every live login item whose stored passkey has the RP ID, without URI matching", async () => {
    const real = await session();
    // The session is frozen, so count metadata decryption through a delegating view.
    const decrypt = vi.fn<LocalCryptoSession["decryptFido2Credentials"]>((input) =>
      real.decryptFido2Credentials(input),
    );
    const active = { decryptFido2Credentials: decrypt } as unknown as LocalCryptoSession;
    const found = await findStoredPasskeys(active, binding, vault(), rpId);
    expect(found).toEqual({
      ok: true,
      data: {
        ...binding,
        rpId,
        candidates: [ids.match, ids.other].map((id) => ({
          ...binding,
          itemId: id,
          credentialId,
          rpId,
          userHandle: "c3ludGhldGljLXVzZXItaWQ",
          discoverable: true,
          counter: 0,
        })),
        unavailableItemIds: [ids.corrupt],
      },
    });
    expect(JSON.stringify(found)).not.toContain(mac);
    // Only the three live items that store a passkey are decrypted.
    expect(decrypt).toHaveBeenCalledTimes(3);
  });

  it.each(["example.test", "www.synthetic.example.test", "SYNTHETIC.example.test"])(
    "matches the RP ID exactly, so %s finds nothing",
    async (other) => {
      expect(await findStoredPasskeys(await session(), binding, vault(), other)).toMatchObject({
        ok: true,
        data: { rpId: other, candidates: [], unavailableItemIds: [ids.corrupt] },
      });
    },
  );

  describe("with decrypted views", () => {
    const tagged = (tag: string) => ({ tag, login: { fido2Credentials: ["encrypted"] } });
    const results: Record<string, unknown> = {
      broken: { ok: false, error: { code: "crypto-failed" } },
      locked: { ok: false, error: { code: "crypto-locked" } },
      twoOther: {
        ok: true,
        data: [
          { ...decryptedView, rpId: "other.example.test" },
          { ...decryptedView, rpId: "other.example.test" },
        ],
      },
      twoSame: { ok: true, data: [decryptedView, decryptedView] },
      single: { ok: true, data: [decryptedView] },
    };
    const stub = {
      decryptFido2Credentials: vi.fn(
        async (input: { cipher: { tag: string } }) => results[input.cipher.tag],
      ),
    } as unknown as LocalCryptoSession;
    const item = (index: number) => `20000000-0000-4000-8000-00000000000${index}`;
    const source = (tags: readonly string[], missing = false) => {
      const ciphers = new Map<string, unknown>(
        tags.map((tag, index) => [item(index), tagged(tag)]),
      );
      const keys = tags.map((_, index) => item(index));
      if (missing) keys.splice(1, 0, item(9));
      return { verified: true, ciphers, loginUris: new Map(keys.map((id) => [id, []])) };
    };

    it("reports unreadable, missing and ambiguous items with this RP ID and keeps scanning", async () => {
      expect(
        await findStoredPasskeys(
          stub,
          binding,
          source(["broken", "twoOther", "twoSame", "single"], true),
          rpId,
        ),
      ).toMatchObject({
        ok: true,
        data: {
          candidates: [{ itemId: item(3), rpId }],
          unavailableItemIds: [item(0), item(9), item(2)],
        },
      });
    });

    it("stops at a lock even after other items were scanned", async () => {
      expect(
        await findStoredPasskeys(stub, binding, source(["broken", "single", "locked"]), rpId),
      ).toEqual({ ok: false, error: { code: "crypto-locked" } });
    });
  });

  it("refuses to search before verification and keeps a locked session's code", async () => {
    expect(
      await findStoredPasskeys(await session(), binding, { ...vault(), verified: false }, rpId),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    const locked = {
      decryptFido2Credentials: vi.fn(async () => ({ ok: false, error: { code: "crypto-locked" } })),
    } as unknown as LocalCryptoSession;
    expect(await findStoredPasskeys(locked, binding, vault(), rpId)).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
  });
});

describe("stored passkey signing", () => {
  it.each([0x1d, 0x19])(
    "signs a zero-counter assertion with flags %#x that verifies against the stored key",
    async (flags) => {
      const signed = await request({
        authenticatorData: toBase64Url(await authenticatorData(flags)),
      });
      const result = await signStoredPasskey(await session(), binding, itemId, cipher(), signed);
      expect(result).toMatchObject({ ok: true, data: { ...binding, itemId, credentialId } });
      if (!result.ok) throw new Error("Synthetic signing failed");
      expect(Object.keys(result.data).sort()).toEqual(
        ["connectionId", "credentialId", "itemId", "signature", "snapshotId", "userId"].sort(),
      );
      expect(await verify(result.data.signature, signed)).toBe(true);
    },
  );

  it.each([{ credentialId: "AQIDBA" }, { rpId: "other.example.test" }])(
    "refuses a request for another credential or RP ID before decrypting the key %#",
    async (overrides) => {
      const { active, decrypt } = await spiedSession();
      expect(
        await signStoredPasskey(active, binding, itemId, cipher(), await request(overrides)),
      ).toEqual({ ok: false, error: { code: "stale-field-reference" } });
      expect(decrypt).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["UP clear", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x1c)) })],
    ["BE clear", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x15)) })],
    ["BS clear", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x0d)) })],
    ["AT set", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x5d)) })],
    ["ED set", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x9d)) })],
    ["RFU1 set", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x1f)) })],
    ["RFU2 set", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x3d)) })],
    [
      "nonzero counter",
      async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x1d, rpId, 1)) }),
    ],
    [
      "another RP ID hash",
      async () => ({
        authenticatorData: toBase64Url(await authenticatorData(0x1d, "other.example.test")),
      }),
    ],
    ["short data", async () => ({ authenticatorData: toBase64Url(new Uint8Array(36)) })],
    ["non-base64url data", async () => ({ authenticatorData: "not base64url!" })],
    ["short hash", async () => ({ clientDataHash: toBase64Url(new Uint8Array(31)) })],
    ["padded hash", async () => ({ clientDataHash: "A".repeat(43) + "=" })],
  ] as const)("refuses assertion data with %s before decrypting the key", async (_, overrides) => {
    const { active, decrypt } = await spiedSession();
    expect(
      await signStoredPasskey(active, binding, itemId, cipher(), await request(await overrides())),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("refuses a stored nonzero counter instead of signing without incrementing it", async () => {
    const view = { ...decryptedView, counter: "1" };
    const decryptFido2PrivateKey = vi.fn();
    const stub = {
      decryptFido2Credentials: vi.fn(async () => ({ ok: true, data: [view] })),
      decryptFido2PrivateKey,
    } as unknown as LocalCryptoSession;
    expect(await signStoredPasskey(stub, binding, itemId, cipher(), await request())).toEqual({
      ok: false,
      error: { code: "unsupported-crypto" },
    });
    expect(decryptFido2PrivateKey).not.toHaveBeenCalled();
  });

  it("maps a corrupted stored key to a per-item failure", async () => {
    const value = fidoCredential.keyValue;
    const tag = value.slice(value.lastIndexOf("|") + 1);
    const flipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
    const corrupt = { ...fidoCredential, keyValue: value.slice(0, -tag.length) + flipped };
    expect(
      await signStoredPasskey(await session(), binding, itemId, cipher([corrupt]), await request()),
    ).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
  });

  it("keeps a locked session's retiring code", async () => {
    const stub = {
      decryptFido2Credentials: vi.fn(async () => ({
        ok: false,
        error: { code: "crypto-locked" },
      })),
    } as unknown as LocalCryptoSession;
    expect(await signStoredPasskey(stub, binding, itemId, cipher(), await request())).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
  });
});
