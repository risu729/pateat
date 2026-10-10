import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalCryptoSession, type LocalCryptoSession } from "@pateat/bitwarden";
import { listStoredPasskeys, signStoredPasskey, type PasskeySignRequest } from "./passkey";
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
    ["RFU set", async () => ({ authenticatorData: toBase64Url(await authenticatorData(0x1f)) })],
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
    const view = {
      credentialId: "12345678-1234-4234-8234-123456789abc",
      keyType: "public-key",
      keyAlgorithm: "ECDSA",
      keyCurve: "P-256",
      keyValue: "2.synthetic-unused",
      rpId,
      userHandle: "c3ludGhldGljLXVzZXI=",
      userName: null,
      counter: "1",
      rpName: null,
      userDisplayName: null,
      discoverable: "true",
      creationDate: "2024-01-30T17:55:36.150Z",
    };
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
