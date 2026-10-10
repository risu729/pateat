import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { admitPreparedBitwardenAccount, type PreparedBitwardenAccount } from "./account";
import { createLocalCryptoSession, type LocalCryptoSession } from "./local-crypto";
import { accountProfile, accountUserId } from "./__fixtures__/account";
import { v1Password, V2_DECRYPTED_USER_KEY } from "./__fixtures__/crypto";
import { preparedVault, type VaultFixtureKind } from "./__fixtures__/unlock";

const sessions: LocalCryptoSession[] = [];
const network = vi.fn(async () => {
  throw new Error("Unexpected synthetic vault network request");
});
function input(prepared: PreparedBitwardenAccount, unlock: unknown) {
  return {
    connectionId: prepared.binding.profile.connectionId,
    userId: prepared.binding.userId,
    email: prepared.binding.email,
    kdf: prepared.kdf,
    accountCryptographicState: prepared.accountCryptographicState,
    organizationKeys: prepared.organizationKeys,
    minimumSecurityVersion: prepared.minimumSecurityVersion,
    unlock,
  };
}
function changeAt(object: object, path: string[], value: unknown) {
  let cursor = object as Record<string, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[path.at(-1)!] = value;
}
beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("verified local unlock material with the actual official SDK", () => {
  it.each(["v1", "v2", "organization"] satisfies VaultFixtureKind[])(
    "restores %s from verified key material without password or an online token",
    async (kind) => {
      const prepared = preparedVault(kind);
      const original = await createLocalCryptoSession(
        input(prepared, {
          kind: "password",
          password: v1Password,
          masterPasswordUnlock: prepared.masterPasswordUnlock,
        }),
        sdk,
      );
      expect(original.ok).toBe(true);
      if (!original.ok) throw new Error("Synthetic password unlock failed");
      sessions.push(original.data);
      const exported = original.data.exportUnlockMaterial();
      expect(exported.ok).toBe(true);
      if (!exported.ok) throw new Error("Verified key export failed");
      expect(Object.keys(exported.data).sort()).toEqual(["metadata", "userKey"]);
      expect(exported.data.metadata).toEqual({
        connectionId: accountProfile.connectionId,
        userId: accountUserId,
        accountVersion: kind === "v2" ? "v2" : "v1",
        securityVersion: kind === "v2" ? 2 : 1,
      });
      if (kind === "v2") expect(exported.data.userKey).toBe(V2_DECRYPTED_USER_KEY);
      original.data.dispose();
      expect(original.data.exportUnlockMaterial()).toEqual({
        ok: false,
        error: { code: "crypto-locked" },
      });
      // Prepared context has no JWT or token, so offline admission must not
      // re-enter the online mapper's expiry/subject-token path.
      expect(Object.keys(prepared)).not.toContain("tokens");
      const admitted = admitPreparedBitwardenAccount(structuredClone(prepared), accountProfile);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error("Offline synthetic context rejected");
      const restored = await createLocalCryptoSession(
        input(admitted.data, { kind: "decrypted-key", userKey: exported.data.userKey }),
        sdk,
      );
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error("Offline native restore failed");
      sessions.push(restored.data);
      const decrypted = await restored.data.decryptCipher({
        connectionId: accountProfile.connectionId,
        cipher: admitted.data.ciphers[0],
      });
      expect(decrypted.ok).toBe(true);
      if (!decrypted.ok) throw new Error("Restored native item failed");
      if (kind === "v2")
        expect(decrypted.data).toMatchObject({ name: "Test Cipher", notes: "Some notes" });
      else
        expect(decrypted.data.login?.password).toBe(
          kind === "organization" ? "synthetic-org-password" : "test_password",
        );
      expect(restored.data.metadata).toEqual(exported.data.metadata);
    },
  );

  it("withholds a session when stored key bytes no longer unlock its encrypted private key", async () => {
    const prepared = preparedVault();
    const original = await createLocalCryptoSession(
      input(prepared, {
        kind: "password",
        password: v1Password,
        masterPasswordUnlock: prepared.masterPasswordUnlock,
      }),
      sdk,
    );
    if (!original.ok) throw new Error("Synthetic password unlock failed");
    sessions.push(original.data);
    const exported = original.data.exportUnlockMaterial();
    if (!exported.ok) throw new Error("Verified key export failed");
    const bytes = Uint8Array.from(atob(exported.data.userKey), (character) =>
      character.charCodeAt(0),
    );
    bytes[0] = bytes[0]! ^ 1;
    const changedKey = btoa(String.fromCharCode(...bytes));
    const restored = await createLocalCryptoSession(
      input(prepared, { kind: "decrypted-key", userKey: changedKey }),
      sdk,
    );
    expect(restored.ok).toBe(false);
  });
});

describe("offline encrypted prepared-context admission", () => {
  it("binds the canonical connection and provider rather than trusting stored metadata", () => {
    const prepared = preparedVault();
    expect(
      admitPreparedBitwardenAccount(prepared, {
        ...accountProfile,
        connectionId: "other-connection",
      }).ok,
    ).toBe(false);
    expect(
      admitPreparedBitwardenAccount(prepared, {
        ...accountProfile,
        environment: { kind: "cloud", region: "eu" },
      }).ok,
    ).toBe(false);
  });

  it.each([
    ["binding.userId", ["binding", "userId"], "not-a-uuid"],
    ["binding.accountVersion", ["binding", "accountVersion"], "v3"],
    ["coverage", ["coverage"], "complete-vault"],
    ["KDF", ["kdf"], { pBKDF2: { iterations: 1 } }],
    ["floor", ["minimumSecurityVersion"], 3],
    ["cipher DTO", ["ciphers", "0", "login"], { unknown: "plaintext" }],
    ["extra password", ["password"], v1Password],
    ["extra token", ["accessToken"], "synthetic-expired-token"],
  ] as const)("rejects malformed %s before any native SDK work", (_label, path, value) => {
    const prepared = preparedVault();
    changeAt(prepared, [...path], value);
    expect(admitPreparedBitwardenAccount(prepared, accountProfile).ok).toBe(false);
  });

  it("retains URI context and still admits older caches without it", () => {
    const prepared = preparedVault();
    prepared.uriMatchContext = {
      equivalentDomains: [["example.com", "example.net"]],
      defaultMatch: 3,
    };
    const admitted = admitPreparedBitwardenAccount(prepared, accountProfile);
    expect(admitted.ok && admitted.data.uriMatchContext).toEqual(prepared.uriMatchContext);
    delete prepared.uriMatchContext;
    const older = admitPreparedBitwardenAccount(prepared, accountProfile);
    expect(older.ok).toBe(true);
    expect(older.ok && "uriMatchContext" in older.data).toBe(false);
  });

  it.each([
    { equivalentDomains: [], defaultMatch: 9 },
    { equivalentDomains: [["Example.com"]], defaultMatch: 0 },
    { equivalentDomains: [], defaultMatch: 0, raw: "https://example.com" },
  ])(
    "drops a URI context that no longer readmits instead of rejecting the cache case %#",
    (context) => {
      const prepared = preparedVault();
      (prepared as { uriMatchContext?: unknown }).uriMatchContext = context;
      const admitted = admitPreparedBitwardenAccount(prepared, accountProfile);
      expect(admitted.ok).toBe(true);
      expect(admitted.ok && "uriMatchContext" in admitted.data).toBe(false);
    },
  );

  it("rejects duplicate supported and unavailable item identities", () => {
    const prepared = preparedVault();
    prepared.ciphers.push(structuredClone(prepared.ciphers[0]!));
    expect(admitPreparedBitwardenAccount(prepared, accountProfile).ok).toBe(false);
    const conflicting = preparedVault();
    conflicting.unavailableItems.push({
      itemId: conflicting.ciphers[0]!.id! as unknown as string,
      reason: "unsupported-cipher-type",
    });
    expect(admitPreparedBitwardenAccount(conflicting, accountProfile).ok).toBe(false);
  });

  it("rejects stripped V2 account state instead of falling back to V1", () => {
    const prepared = preparedVault("v2");
    prepared.accountCryptographicState = preparedVault().accountCryptographicState;
    expect(admitPreparedBitwardenAccount(prepared, accountProfile).ok).toBe(false);
    const partial = preparedVault("v2");
    changeAt(partial, ["accountCryptographicState", "V2", "signing_key"], undefined);
    expect(admitPreparedBitwardenAccount(partial, accountProfile).ok).toBe(false);
  });
});
