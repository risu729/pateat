import { expect, it } from "vitest";
import { rawModernV1Account, rawV1Account, rawV2Account } from "../../src/__fixtures__/account";
import { v1PrivateKey, v1WrappedUserKey } from "../../src/__fixtures__/crypto";
import type { ModernAccountContext } from "./context";

export function registerModernAccountCases({ known, setAt, mapRaw }: ModernAccountContext) {
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
}
