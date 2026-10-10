import { describe, expect, it } from "vitest";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { activeEntry, disabledEntry } from "./__fixtures__/vault";
import {
  admitVaultEntry,
  MAX_VAULT_RECORD_BYTES,
  sameVaultEntry,
  vaultRecordBytes,
} from "./record";

function changeAt(object: object, path: string[], value: unknown) {
  let cursor = object as Record<string, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[path.at(-1)!] = value;
}
describe("durable vault record admission", () => {
  it.each(["v1", "v2"] as const)(
    "admits a structurally complete %s encrypted context without a token",
    (kind) => {
      const entry = activeEntry(kind);
      const admitted = admitVaultEntry(entry, accountProfile);
      expect(admitted).toEqual({ ok: true, data: entry });
      if (!admitted.ok) throw new Error("Synthetic record rejected");
      expect(admitted.data).not.toBe(entry);
    },
  );
  it.each([true, false])(
    "admits a disabled tombstone with accepted context=%s and no retained key",
    (accepted) => {
      const entry = disabledEntry(accepted);
      expect(admitVaultEntry(entry, accountProfile)).toEqual({ ok: true, data: entry });
      expect(Object.hasOwn(entry, "userKey")).toBe(false);
    },
  );
  it.each([
    ["version", ["schemaVersion"], 2],
    ["revision", ["revision"], "not-a-uuid"],
    ["missing active context", ["accepted"], undefined],
    ["identity mismatch", ["accepted", "userId"], "50000000-0000-4000-8000-000000000001"],
    ["account format mismatch", ["accepted", "accountVersion"], "v2"],
    ["floor mismatch", ["accepted", "minimumSecurityVersion"], 2],
    ["timestamp", ["accepted", "acceptedAt"], -1],
    ["coverage", ["accepted", "coverage"], "complete-vault"],
    ["key encoding", ["userKey"], "not!base64"],
    ["key omitted", ["userKey"], undefined],
    ["password", ["password"], "synthetic-only-password"],
    ["token", ["accessToken"], "synthetic-only-token"],
    ["page grant", ["allowedFieldIds"], ["login.password"]],
    ["native session", ["session"], { sessionId: "synthetic-session" }],
    ["prepared unknown field", ["accepted", "prepared", "unknown"], "plaintext"],
  ] as const)(
    "rejects malformed %s instead of treating the record as first setup",
    (_label, path, value) => {
      const entry = activeEntry();
      changeAt(entry, [...path], value);
      expect(admitVaultEntry(entry, accountProfile)).toEqual({
        ok: false,
        error: { code: "invalid-cache-record" },
      });
    },
  );
  it("rejects a key-bearing disabled record", () => {
    const entry = { ...disabledEntry(), userKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    expect(admitVaultEntry(entry, accountProfile)).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
  });
  it.each([
    { ...accountProfile, connectionId: "other-connection" },
    { ...accountProfile, environment: { kind: "cloud", region: "eu" } },
  ])("rejects a record from a different connection/provider %#", (profile) => {
    expect(admitVaultEntry(activeEntry(), profile)).toEqual({
      ok: false,
      error: { code: "account-mismatch" },
    });
  });
  it("rejects an oversized record before storage or native work", () => {
    const entry = { ...activeEntry(), oversized: "x".repeat(MAX_VAULT_RECORD_BYTES) };
    expect(vaultRecordBytes(entry)).toBeGreaterThan(MAX_VAULT_RECORD_BYTES);
    expect(admitVaultEntry(entry, accountProfile)).toEqual({
      ok: false,
      error: { code: "cache-quota-exceeded" },
    });
  });
});

describe("exact committed record comparison", () => {
  it("ignores object key order but includes all encrypted members", () => {
    const entry = activeEntry();
    expect(sameVaultEntry(entry, Object.fromEntries(Object.entries(entry).reverse()))).toBe(true);
  });
  it.each([
    [["userKey"], "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
    [["accepted", "snapshotId"], "50000000-0000-4000-8000-000000000001"],
    [["accepted", "prepared", "ciphers", "0", "notes"], "changed-ciphertext"],
    [["state"], "disabled"],
  ] as const)("detects changed member %# even with the same revision", (path, value) => {
    const original = activeEntry();
    const changed = structuredClone(original);
    changeAt(changed, [...path], value);
    expect(changed.revision).toBe(original.revision);
    expect(sameVaultEntry(original, changed)).toBe(false);
  });
});
