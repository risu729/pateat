import { afterEach, describe, expect, it } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createLocalCryptoSession } from "./local-crypto";
import {
  decodeBitwardenBase64,
  decodeBitwardenCredentialId,
  decodeLocalPasskeyPrivateKey,
  mapLocalPasskeyCredentials,
} from "./passkeys";
import {
  fidoCredential,
  fidoPrivateKey,
  legacyCipher,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
} from "./__fixtures__/crypto";

const scope = {
  connectionId: "synthetic-passkeys",
  userId: "00000000-0000-4000-8000-000000000001",
  snapshotId: "00000000-0000-4000-8000-000000000002",
  itemId: "00000000-0000-4000-8000-000000000003",
};
// Synthetic SDK Fido2CredentialView shape; keyValue is an opaque EncString placeholder.
const view = {
  credentialId: "12345678-1234-4234-8234-123456789abc",
  keyType: "public-key",
  keyAlgorithm: "ECDSA",
  keyCurve: "P-256",
  keyValue: "2.synthetic|encrypted|key",
  rpId: "synthetic.example.test",
  userHandle: "c3ludGhldGljLXVzZXI",
  userName: "synthetic-user",
  counter: "0",
  rpName: "Synthetic",
  userDisplayName: "Synthetic User",
  discoverable: "true",
  creationDate: "2024-01-30T17:55:36.150Z",
};
const map = (...credentials: unknown[]) => mapLocalPasskeyCredentials({ ...scope, credentials });
const sessions: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const active of sessions.splice(0)) active.dispose();
});

describe("Bitwarden passkey credential IDs", () => {
  it("decodes a GUID as its 16 raw bytes in order", () => {
    expect(
      Array.from(decodeBitwardenCredentialId("00112233-4455-6677-8899-AABBCCDDEEFF")!),
    ).toEqual([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
  });

  it("decodes b64-prefixed imported IDs and rejects other forms", () => {
    // WebAuthn L3 section 16.2 credential_id.
    const vector = "f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4";
    const bytes = decodeBitwardenCredentialId("b64.-R85HbTJsv3g6nAYnLo_tj9Xm6YSKzOtlP8-wzAIS-Q");
    expect(Array.from(bytes!, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(vector);
    for (const invalid of [
      "",
      "b64.",
      "b64.+R85HbTJsv3g6nAYnLo_tj9Xm6YSKzOtlP8-wzAIS-Q",
      "b64.AB=",
      "12345678123442348234123456789abc",
      "{12345678-1234-4234-8234-123456789abc}",
      `b64.${"A".repeat(1366)}`,
    ])
      expect(decodeBitwardenCredentialId(invalid)).toBeUndefined();
  });

  it("accepts either Bitwarden base64 alphabet but only canonical encodings", () => {
    expect(decodeBitwardenBase64("-_8")).toEqual(Uint8Array.of(0xfb, 0xff));
    expect(decodeBitwardenBase64("+/8=")).toEqual(Uint8Array.of(0xfb, 0xff));
    expect(decodeBitwardenBase64("+_8")).toBeUndefined();
    expect(decodeBitwardenBase64("-_9")).toBeUndefined();
    expect(decodeBitwardenBase64("-_8==")).toBeUndefined();
    expect(decodeBitwardenBase64("A")).toBeUndefined();
  });
});

describe("Bitwarden passkey metadata mapping", () => {
  it("maps a zero-counter discoverable credential without key material", () => {
    expect(map(view)).toEqual({
      ok: true,
      data: [
        {
          ...scope,
          credentialId: "EjRWeBI0QjSCNBI0VniavA",
          rpId: "synthetic.example.test",
          userHandle: "c3ludGhldGljLXVzZXI",
          discoverable: true,
          counter: 0,
        },
      ],
    });
    const result = map(view);
    expect(JSON.stringify(result)).not.toContain("encrypted");
  });

  it("preserves a nonzero counter for explicit refusal and canonicalizes user handles", () => {
    expect(
      map({ ...view, counter: "4294967295", userHandle: "c3ludGhldGljLXVzZXI=" }),
    ).toMatchObject({
      ok: true,
      data: [{ counter: 4294967295, userHandle: "c3ludGhldGljLXVzZXI" }],
    });
    expect(map({ ...view, discoverable: "false", userHandle: null })).toMatchObject({
      ok: true,
      data: [{ discoverable: false, userHandle: null }],
    });
  });

  it("returns no credentials for an item without passkeys", () => {
    expect(map()).toEqual({ ok: true, data: [] });
  });

  it.each([
    ["two credentials", [view, view], "unsupported-crypto"],
    ["RSA key", [{ ...view, keyAlgorithm: "RSA" }], "unsupported-crypto"],
    ["other curve", [{ ...view, keyCurve: "P-384" }], "unsupported-crypto"],
    ["other key type", [{ ...view, keyType: "secret" }], "unsupported-crypto"],
    ["malformed credential ID", [{ ...view, credentialId: "not-an-id" }], "unsupported-crypto"],
    ["uppercase RP ID", [{ ...view, rpId: "Synthetic.example.test" }], "unsupported-crypto"],
    ["RP ID with a port", [{ ...view, rpId: "example.test:443" }], "unsupported-crypto"],
    ["trailing-dot RP ID", [{ ...view, rpId: "example.test." }], "unsupported-crypto"],
    ["boolean-like discoverable", [{ ...view, discoverable: "1" }], "unsupported-crypto"],
    ["negative counter", [{ ...view, counter: "-1" }], "unsupported-crypto"],
    ["leading-zero counter", [{ ...view, counter: "01" }], "unsupported-crypto"],
    ["counter overflow", [{ ...view, counter: "4294967296" }], "unsupported-crypto"],
    ["oversized user handle", [{ ...view, userHandle: "A".repeat(88) }], "unsupported-crypto"],
    ["discoverable without user handle", [{ ...view, userHandle: null }], "unsupported-crypto"],
    ["missing key", [{ ...view, keyValue: "" }], "invalid-crypto-input"],
    ["non-object view", ["credential"], "invalid-crypto-input"],
  ] as const)("rejects %s", (_name, credentials, code) => {
    expect(map(...credentials)).toEqual({ ok: false, error: { code } });
  });

  it("rejects unbound or malformed scopes", () => {
    expect(mapLocalPasskeyCredentials({ ...scope, itemId: "item", credentials: [view] })).toEqual({
      ok: false,
      error: { code: "invalid-crypto-input" },
    });
    expect(mapLocalPasskeyCredentials({ ...scope, credentials: [view], extra: true })).toEqual({
      ok: false,
      error: { code: "invalid-crypto-input" },
    });
  });
});

describe("SDK-decrypted passkey round trip", () => {
  it("maps SDK views and decodes the exact PKCS #8 private key", async () => {
    const created = await createLocalCryptoSession(
      {
        connectionId: scope.connectionId,
        userId: scope.userId,
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
      sdk,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    sessions.push(created.data);
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: { ...original.login, fido2Credentials: [fidoCredential] },
    };
    const views = await created.data.decryptFido2Credentials({
      connectionId: scope.connectionId,
      cipher,
    });
    expect(views.ok).toBe(true);
    if (!views.ok) return;
    const mapped = mapLocalPasskeyCredentials({
      ...scope,
      itemId: original.id,
      credentials: views.data,
    });
    expect(mapped).toMatchObject({
      ok: true,
      data: [
        {
          itemId: original.id,
          credentialId: "EjRWeBI0QjSCNBI0VniavA",
          rpId: "synthetic.example.test",
          discoverable: true,
          counter: 0,
        },
      ],
    });
    const key = await created.data.decryptFido2PrivateKey({
      connectionId: scope.connectionId,
      cipher,
    });
    expect(key).toEqual({ ok: true, data: fidoPrivateKey });
    const decoded = decodeLocalPasskeyPrivateKey(key.ok ? key.data : undefined);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const imported = await crypto.subtle.importKey(
      "pkcs8",
      decoded.data as Uint8Array<ArrayBuffer>,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    expect(imported.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
  });

  it("rejects non-PKCS #8 private key strings", () => {
    for (const invalid of [undefined, "", "AAAA", "MIGH", `${"A".repeat(400)}`])
      expect(decodeLocalPasskeyPrivateKey(invalid).ok).toBe(false);
  });
});
