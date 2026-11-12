import { expect, it, vi } from "vitest";
import type { KeyRetention } from "../../../src/vault/manager";
import { type VaultEntry, vaultFailure } from "../../../src/vault/record";
import {
  legacyItemKey,
  v1Password,
  V2_DECRYPTED_USER_KEY,
} from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import {
  activeEntry,
  disabledEntry,
  lockedEntry,
  snapshotId,
} from "../../../src/vault/__fixtures__/vault";
import type { VaultManagerTestContext } from "./context";

export function registerRetainedAcceptanceCases({
  harness,
  candidate,
  accepted,
  itemId,
  unlocked,
}: Pick<VaultManagerTestContext, "harness" | "candidate" | "accepted" | "itemId" | "unlocked">) {
  it("with session retention writes a locked record and keeps the key in memory first", async () => {
    const h = harness({ retention: "session" });
    const result = await accepted(h);
    const entry = h.entry();
    expect(entry).toMatchObject({
      state: "locked",
      accepted: { snapshotId: expect.any(String) },
    });
    expect(Object.hasOwn(entry!, "userKey")).toBe(false);
    expect(JSON.stringify(entry)).not.toContain(legacyItemKey);
    expect(await h.sessionValue()).toEqual({ revision: entry!.revision, userKey: legacyItemKey });
    // The key is in memory before the record that needs it lands.
    expect(h.sessionKey.write.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.compareAndSwap.mock.invocationCallOrder[0]!,
    );
    expect(h.sessionKey.clear).not.toHaveBeenCalled();
    expect(result.summary).toMatchObject({ revision: entry!.revision, autoUnlock: "disabled" });
    expect(h.manager.status().ready).toBe(true);
    expect((await h.manager.listFields(result.handle, itemId)).ok).toBe(true);
    expect(await h.manager.keyFor(entry)).toBe(legacyItemKey);
  });
  it("with durable retention writes an active record and drops a key left in memory", async () => {
    const h = harness({ retention: "session" });
    await accepted(h);
    h.setRetention("durable");
    const result = await h.manager.accept(candidate("preserve"));
    expect(result.ok).toBe(true);
    expect(h.entry()).toMatchObject({ state: "active", userKey: legacyItemKey });
    expect(await h.sessionValue()).toBeUndefined();
    expect(result.ok && result.data.summary.autoUnlock).toBe("enabled");
  });
  it("without a retention option keeps the key on disk", async () => {
    const h = harness();
    await accepted(h);
    expect(h.entry()).toMatchObject({ state: "active", userKey: legacyItemKey });
    expect(h.sessionKey.write).not.toHaveBeenCalled();
  });
  it("preserve on a locked record without this session's key is refused as locked", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    expect(await h.manager.accept(candidate("preserve"))).toEqual(vaultFailure("vault-locked"));
    expect(h.host.open).not.toHaveBeenCalled();
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    // A password sign-in enables it again.
    expect((await h.manager.accept(candidate("enable"))).ok).toBe(true);
    expect(h.entry()?.state).toBe("locked");
    expect(await h.manager.keyFor(h.entry())).toBe(legacyItemKey);
  });
  it("preserve on a locked record unlocked in this session moves the key to the new revision", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    await unlocked(h);
    const before = h.entry()!;
    const result = await h.manager.accept(candidate("preserve"));
    expect(result.ok).toBe(true);
    const after = h.entry()!;
    expect(after.state).toBe("locked");
    expect(after.revision).not.toBe(before.revision);
    expect(await h.sessionValue()).toEqual({ revision: after.revision, userKey: legacyItemKey });
  });
  it("a write that does not land leaves this session's key with the old record", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    await unlocked(h);
    const before = h.entry()!;
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("cache-quota-exceeded"));
    expect(await h.manager.accept(candidate("preserve"))).toEqual(
      vaultFailure("cache-quota-exceeded"),
    );
    expect(h.entry()).toEqual(before);
    // A failed sync does not lock a vault unlocked in this browser session.
    expect(await h.sessionValue()).toEqual({ revision: before.revision, userKey: legacyItemKey });
    expect(await h.manager.keyFor(before)).toBe(legacyItemKey);
  });
}

export function registerRetainedRestoreCases({
  harness,
}: Pick<VaultManagerTestContext, "harness">) {
  it("opens a locked record with this session's key of the same revision", async () => {
    const h = harness({ initial: lockedEntry() });
    await h.sessionKey.write({ revision: lockedEntry().revision, userKey: legacyItemKey });
    const result = await h.manager.restore();
    expect(result.ok).toBe(true);
    expect(h.host.open.mock.calls[0]![0].unlock).toEqual({
      kind: "decrypted-key",
      userKey: legacyItemKey,
    });
    expect(result.ok && result.data.summary.autoUnlock).toBe("disabled");
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
  });
  it("refuses a locked record without this session's key before any open", async () => {
    const h = harness({ initial: lockedEntry() });
    expect(await h.manager.restore()).toEqual(vaultFailure("vault-locked"));
    expect(h.host.open).not.toHaveBeenCalled();
    expect(h.manager.status().ready).toBe(false);
  });
  it("refuses a locked record when this session's key names another revision", async () => {
    const h = harness({ initial: lockedEntry() });
    await h.sessionKey.write({ revision: crypto.randomUUID(), userKey: legacyItemKey });
    expect(await h.manager.restore()).toEqual(vaultFailure("vault-locked"));
    expect(h.host.open).not.toHaveBeenCalled();
  });
  it("refuses a locked record when this session's key cannot be read", async () => {
    const h = harness({ initial: lockedEntry() });
    h.sessionKey.read.mockRejectedValue(new Error("Synthetic storage.session failure"));
    expect(await h.manager.restore()).toEqual(vaultFailure("vault-locked"));
    expect(h.host.open).not.toHaveBeenCalled();
  });
  it("still answers a logged-out record as disabled", async () => {
    const h = harness({ initial: disabledEntry() });
    await h.sessionKey.write({ revision: disabledEntry().revision, userKey: legacyItemKey });
    expect(await h.manager.restore()).toEqual(vaultFailure("auto-unlock-disabled"));
    expect(h.host.open).not.toHaveBeenCalled();
  });
}

export function registerRetainedKeyLookupCases({
  harness,
}: Pick<VaultManagerTestContext, "harness">) {
  it("answers the key that unlocks each record now", async () => {
    const h = harness();
    expect(await h.manager.keyFor(activeEntry())).toBe(legacyItemKey);
    expect(await h.manager.keyFor(activeEntry("v2"))).toBe(V2_DECRYPTED_USER_KEY);
    expect(await h.manager.keyFor(lockedEntry())).toBeUndefined();
    expect(await h.manager.keyFor(disabledEntry())).toBeUndefined();
    expect(await h.manager.keyFor(null)).toBeUndefined();
    await h.sessionKey.write({ revision: lockedEntry().revision, userKey: legacyItemKey });
    expect(await h.manager.keyFor(lockedEntry())).toBe(legacyItemKey);
    // A logged-out record is never unlocked by a key left in memory.
    expect(await h.manager.keyFor(disabledEntry())).toBeUndefined();
  });
}

export function registerUnlockCases({
  harness,
  candidate,
  gate,
  itemId,
  unlocked,
  passwordFailure,
}: Pick<
  VaultManagerTestContext,
  "harness" | "candidate" | "gate" | "itemId" | "unlocked" | "passwordFailure"
>) {
  it("opens a locked record with the master password and keeps the key in memory only", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    const before = h.entry();
    const result = await unlocked(h);
    expect(h.host.open.mock.calls[0]![0]).toMatchObject({
      snapshotId,
      unlock: { kind: "password", password: v1Password },
    });
    expect(h.events).toEqual(["open", "verify-all", "export"]);
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.entry()).toEqual(before);
    expect(await h.sessionValue()).toEqual({
      revision: before!.revision,
      userKey: legacyItemKey,
    });
    expect(result.summary).toMatchObject({ revision: before!.revision, autoUnlock: "disabled" });
    expect(result.handle).toMatchObject({ recordId: before!.accepted!.recordId, snapshotId });
    expect(h.manager.status()).toMatchObject({ ready: true, storageUncertain: false });
    expect((await h.manager.listFields(result.handle, itemId)).ok).toBe(true);
    // The password is kept nowhere.
    expect(JSON.stringify([h.entry(), await h.sessionValue(), result])).not.toContain(v1Password);
    // A worker that restarts later in this browser session restores without the password.
    await h.manager.lock();
    expect((await h.manager.restore()).ok).toBe(true);
  });
  it("with durable retention writes the key back to the record", async () => {
    const h = harness({ initial: lockedEntry(), retention: "durable" });
    await h.sessionKey.write({ revision: crypto.randomUUID(), userKey: legacyItemKey });
    const result = await unlocked(h);
    const entry = h.entry()!;
    expect(entry).toMatchObject({ state: "active", userKey: legacyItemKey });
    expect(entry.revision).not.toBe(lockedEntry().revision);
    expect(entry.accepted).toEqual(lockedEntry().accepted);
    expect(await h.sessionValue()).toBeUndefined();
    expect(result.summary).toMatchObject({ revision: entry.revision, autoUnlock: "enabled" });
    expect((await h.manager.listFields(result.handle, itemId)).ok).toBe(true);
  });
  it("on an active record with session retention moves the key to memory", async () => {
    const h = harness({ initial: activeEntry(), retention: "session" });
    const result = await unlocked(h);
    const entry = h.entry()!;
    expect(entry.state).toBe("locked");
    expect(Object.hasOwn(entry, "userKey")).toBe(false);
    expect(entry.revision).not.toBe(activeEntry().revision);
    expect(await h.sessionValue()).toEqual({ revision: entry.revision, userKey: legacyItemKey });
    expect(h.sessionKey.write.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.compareAndSwap.mock.invocationCallOrder[0]!,
    );
    expect((await h.manager.listFields(result.handle, itemId)).ok).toBe(true);
  });
  it("on an active record with durable retention writes nothing", async () => {
    const h = harness({ initial: activeEntry(), retention: "durable" });
    const result = await unlocked(h);
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.entry()).toEqual(activeEntry());
    expect(result.summary.autoUnlock).toBe("enabled");
  });
  it("a wrong master password fails as the crypto host's open and changes nothing", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    h.host.open.mockResolvedValueOnce(passwordFailure);
    expect(await h.manager.unlock("synthetic-wrong-password")).toEqual(
      vaultFailure("crypto-failed"),
    );
    expect(h.host.exportUnlockMaterial).not.toHaveBeenCalled();
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.sessionKey.write).not.toHaveBeenCalled();
    expect(h.entry()).toEqual(lockedEntry());
    expect(h.manager.status().ready).toBe(false);
    // The next try with the right password works.
    await unlocked(h);
  });
  it("refuses a password whose open does not verify every item", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    h.host.verifyReceivedCiphers.mockResolvedValueOnce({
      ok: true,
      data: { verifiedCipherCount: 0, unusableItems: [], partialItems: [] },
    });
    expect(await h.manager.unlock(v1Password)).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "cipher-count" },
    });
    expect(h.sessionKey.write).not.toHaveBeenCalled();
    expect(h.opened.size).toBe(0);
  });
  it("refuses exported material for another account", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    h.host.exportUnlockMaterial.mockImplementationOnce(async (session) => ({
      ok: true,
      data: {
        metadata: {
          connectionId: session.connectionId,
          userId: crypto.randomUUID(),
          accountVersion: "v1",
          securityVersion: 1,
        },
        userKey: legacyItemKey,
      },
    }));
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("crypto-failed"));
    expect(h.sessionKey.write).not.toHaveBeenCalled();
    expect(h.opened.size).toBe(0);
  });
  it("refuses a logged-out record: it needs a sign-in to the server", async () => {
    const h = harness({ initial: disabledEntry(), retention: "session" });
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("auto-unlock-disabled"));
    expect(h.host.open).not.toHaveBeenCalled();
    expect(h.sessionKey.write).not.toHaveBeenCalled();
  });
  it("refuses without a record or a password", async () => {
    const h = harness({ retention: "session" });
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("cache-missing"));
    h.setEntry(lockedEntry());
    expect(await h.manager.unlock("")).toEqual(vaultFailure("invalid-request"));
    expect(await h.manager.unlock(42 as unknown as string)).toEqual(
      vaultFailure("invalid-request"),
    );
    expect(h.host.open).not.toHaveBeenCalled();
  });
  it("answers a failed record read", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("storage-failed"));
    expect(h.host.open).not.toHaveBeenCalled();
  });
  it("a refused write leaves no open session", async () => {
    const h = harness({ initial: lockedEntry(), retention: "durable" });
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("storage-conflict"));
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("storage-conflict"));
    expect(h.opened.size).toBe(0);
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: false });
    expect(h.entry()).toEqual(lockedEntry());
  });
  it("an uncertain write fences the vault", async () => {
    const h = harness({ initial: lockedEntry(), retention: "durable" });
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("storage-uncertain"));
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("storage-uncertain"));
    expect(h.opened.size).toBe(0);
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: true });
  });
  it("a write that does not read back is uncertain", async () => {
    const h = harness({ initial: lockedEntry(), retention: "durable" });
    h.store.compareAndSwap.mockImplementationOnce(async (_expected, next) => {
      h.setEntry(next);
      h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
      return { ok: true, data: { revision: next.revision } };
    });
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("storage-uncertain"));
    expect(h.opened.size).toBe(0);
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: true });
  });
  it("replaces an earlier open session of the vault", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    const first = await unlocked(h);
    const second = await unlocked(h);
    expect(h.host.lock).toHaveBeenCalledTimes(1);
    expect(h.opened.size).toBe(1);
    expect(await h.manager.listFields(first.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect((await h.manager.listFields(second.handle, itemId)).ok).toBe(true);
  });
  it("is refused while another operation runs", async () => {
    const held = gate();
    const h = harness({
      initial: lockedEntry(),
      retention: "session",
      checkpoint: async (stage) => {
        if (stage === "before-write") await held.promise;
      },
    });
    await h.sessionKey.write({ revision: lockedEntry().revision, userKey: legacyItemKey });
    const pending = h.manager.accept(candidate("preserve"));
    await vi.waitFor(() => expect(h.store.read).toHaveBeenCalled());
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("resource-limit"));
    held.release();
    expect((await pending).ok).toBe(true);
  });
  it("a lock while the unlock runs leaves no key in memory", async () => {
    const held = gate();
    let calls = 0;
    const h = harness({
      initial: lockedEntry(),
      retention: async () => {
        calls += 1;
        await held.promise;
        return "session";
      },
    });
    const pending = h.manager.unlock(v1Password);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(await h.manager.lockVault()).toMatchObject({ ok: true });
    held.release();
    expect(await pending).toEqual(vaultFailure("cancelled"));
    expect(h.opened.size).toBe(0);
    // Once the lock answered, no unlock of this browser session is left.
    expect(await h.sessionValue()).toBeUndefined();
    expect(await h.manager.restore()).toEqual(vaultFailure("vault-locked"));
  });
}

export function registerVaultLockCases({
  harness,
  candidate,
  accepted,
  gate,
  itemId,
  unlocked,
}: Pick<
  VaultManagerTestContext,
  "harness" | "candidate" | "accepted" | "gate" | "itemId" | "unlocked"
>) {
  it("locks an active vault: the record keeps its sign-in, the key and the open session go", async () => {
    const h = harness();
    const old = await accepted(h);
    const before = h.entry()!;
    const result = await h.manager.lockVault();
    const entry = h.entry()!;
    expect(entry).toEqual({
      schemaVersion: 1,
      revision: expect.any(String),
      profile: before.profile,
      state: "locked",
      accepted: before.accepted,
    });
    expect(entry.revision).not.toBe(before.revision);
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        revision: entry.revision,
        autoUnlock: "disabled",
        snapshotId: old.handle.snapshotId,
      }),
    });
    expect(h.opened.size).toBe(0);
    expect(h.sessionKey.clear).toHaveBeenCalled();
    expect(await h.manager.listFields(old.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(await h.manager.restore()).toEqual(vaultFailure("vault-locked"));
    // The master password unlocks it again offline.
    expect((await h.manager.unlock(v1Password)).ok).toBe(true);
    expect(h.entry()).toMatchObject({ state: "active", userKey: legacyItemKey });
  });
  it("on a vault already locked drops this session's key and writes nothing", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    const opened = await unlocked(h);
    const result = await h.manager.lockVault();
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ revision: lockedEntry().revision, autoUnlock: "disabled" }),
    });
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(await h.sessionValue()).toBeUndefined();
    expect(h.opened.size).toBe(0);
    expect(await h.manager.listFields(opened.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(await h.manager.restore()).toEqual(vaultFailure("vault-locked"));
  });
  it("answers null without a record", async () => {
    const h = harness();
    expect(await h.manager.lockVault()).toEqual({ ok: true, data: null });
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
  });
  it("leaves a logged-out record as it is", async () => {
    const h = harness({ initial: disabledEntry() });
    expect(await h.manager.lockVault()).toEqual({
      ok: true,
      data: expect.objectContaining({
        autoUnlock: "disabled",
        revision: disabledEntry().revision,
      }),
    });
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.entry()?.state).toBe("disabled");
  });
  it("tries again after another writer replaced the record", async () => {
    const h = harness({ initial: activeEntry() });
    const newer = { ...activeEntry(), revision: crypto.randomUUID() };
    h.store.compareAndSwap.mockImplementationOnce(async () => {
      h.setEntry(newer);
      return vaultFailure("storage-conflict");
    });
    const result = await h.manager.lockVault();
    expect(result.ok).toBe(true);
    expect(h.store.compareAndSwap).toHaveBeenCalledTimes(2);
    expect(h.store.compareAndSwap.mock.calls[1]![0]).toBe(newer.revision);
    expect(h.entry()?.state).toBe("locked");
  });
  it("gives up after three conflicts", async () => {
    const h = harness({ initial: activeEntry() });
    h.store.compareAndSwap.mockResolvedValue(vaultFailure("storage-conflict"));
    expect(await h.manager.lockVault()).toEqual(vaultFailure("storage-conflict"));
    expect(h.store.compareAndSwap).toHaveBeenCalledTimes(3);
    expect(h.entry()?.state).toBe("active");
  });
  it("answers a failed read or write, and an uncertain one as uncertain", async () => {
    const h = harness({ initial: activeEntry() });
    h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
    expect(await h.manager.lockVault()).toEqual(vaultFailure("storage-failed"));
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("cache-quota-exceeded"));
    expect(await h.manager.lockVault()).toEqual(vaultFailure("cache-quota-exceeded"));
    expect(h.manager.status().storageUncertain).toBe(false);
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("storage-uncertain"));
    expect(await h.manager.lockVault()).toEqual(vaultFailure("storage-uncertain"));
    expect(h.manager.status().storageUncertain).toBe(true);
  });
  it("a lock that does not read back is uncertain", async () => {
    const h = harness({ initial: activeEntry() });
    h.store.compareAndSwap.mockImplementationOnce(async (_expected, next) => {
      h.setEntry(next);
      h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
      return { ok: true, data: { revision: next.revision } };
    });
    expect(await h.manager.lockVault()).toEqual(vaultFailure("storage-uncertain"));
    expect(h.manager.status().storageUncertain).toBe(true);
  });
  it("cancels an accept in progress", async () => {
    const held = gate();
    const h = harness({
      checkpoint: async (stage) => {
        if (stage === "before-write") await held.promise;
      },
    });
    const pending = h.manager.accept(candidate());
    await vi.waitFor(() => expect(h.opened.size).toBe(1));
    expect(await h.manager.lockVault()).toEqual({ ok: true, data: null });
    expect(h.opened.size).toBe(0);
    held.release();
    expect(await pending).toEqual(vaultFailure("cancelled"));
    expect(h.entry()).toBeNull();
  });
}

export function registerKeyRetentionChangeCases({
  harness,
  candidate,
  accepted,
  gate,
  itemId,
  unlocked,
}: Pick<
  VaultManagerTestContext,
  "harness" | "candidate" | "accepted" | "gate" | "itemId" | "unlocked"
>) {
  it("moves an open vault's key from the record to memory and keeps serving it", async () => {
    const h = harness();
    const old = await accepted(h);
    const before = h.entry()!;
    h.host.open.mockClear();
    expect(await h.manager.keepKey("session")).toEqual({ ok: true, data: true });
    const entry = h.entry()!;
    expect(entry).toMatchObject({ state: "locked", accepted: before.accepted });
    expect(Object.hasOwn(entry, "userKey")).toBe(false);
    expect(entry.revision).not.toBe(before.revision);
    expect(await h.sessionValue()).toEqual({ revision: entry.revision, userKey: legacyItemKey });
    // The open session keeps the same snapshot without a new open.
    expect(h.host.open).not.toHaveBeenCalled();
    expect(h.manager.status()).toMatchObject({
      ready: true,
      summary: { revision: entry.revision, autoUnlock: "disabled" },
    });
    expect((await h.manager.listFields(old.handle, itemId)).ok).toBe(true);
  });
  it("moves this session's key back to the record", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    const opened = await unlocked(h);
    expect(await h.manager.keepKey("durable")).toEqual({ ok: true, data: true });
    const entry = h.entry()!;
    expect(entry).toMatchObject({ state: "active", userKey: legacyItemKey });
    expect(entry.revision).not.toBe(lockedEntry().revision);
    expect(await h.sessionValue()).toBeUndefined();
    expect(h.manager.status().summary).toMatchObject({
      revision: entry.revision,
      autoUnlock: "enabled",
    });
    expect((await h.manager.listFields(opened.handle, itemId)).ok).toBe(true);
  });
  it("moves a key without an open session, and the vault restores from memory", async () => {
    const h = harness({ initial: activeEntry() });
    expect((await h.manager.keepKey("session")).ok).toBe(true);
    expect(h.host.open).not.toHaveBeenCalled();
    expect((await h.manager.restore()).ok).toBe(true);
  });
  it("leaves a locked vault without this session's key locked", async () => {
    const h = harness({ initial: lockedEntry() });
    expect(await h.manager.keepKey("durable")).toEqual({ ok: true, data: true });
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.entry()).toEqual(lockedEntry());
  });
  it.each<[KeyRetention, () => VaultEntry | null]>([
    ["durable", () => activeEntry()],
    ["session", () => lockedEntry()],
    ["session", () => disabledEntry()],
    ["durable", () => disabledEntry()],
    ["session", () => null],
  ])("with %s retention writes nothing for %o", async (retention, initial) => {
    const record = initial();
    const h = harness(record ? { initial: record } : {});
    expect(await h.manager.keepKey(retention)).toEqual({ ok: true, data: true });
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.sessionKey.write).not.toHaveBeenCalled();
  });
  it("answers a refused write and leaves the record", async () => {
    const h = harness({ initial: activeEntry() });
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("storage-conflict"));
    expect(await h.manager.keepKey("session")).toEqual(vaultFailure("storage-conflict"));
    expect(h.entry()).toEqual(activeEntry());
    expect(h.manager.status().storageUncertain).toBe(false);
  });
  it("fences the vault on an uncertain write or read-back", async () => {
    const h = harness();
    await accepted(h);
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("storage-uncertain"));
    expect(await h.manager.keepKey("session")).toEqual(vaultFailure("storage-uncertain"));
    expect(h.opened.size).toBe(0);
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: true });
    const other = harness({ initial: activeEntry() });
    other.store.compareAndSwap.mockImplementationOnce(async (_expected, next) => {
      other.setEntry(next);
      other.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
      return { ok: true, data: { revision: next.revision } };
    });
    expect(await other.manager.keepKey("session")).toEqual(vaultFailure("storage-uncertain"));
    expect(other.manager.status().storageUncertain).toBe(true);
  });
  it("is refused while another operation runs", async () => {
    const held = gate();
    const h = harness({
      checkpoint: async (stage) => {
        if (stage === "before-write") await held.promise;
      },
    });
    const pending = h.manager.accept(candidate());
    await vi.waitFor(() => expect(h.opened.size).toBe(1));
    expect(await h.manager.keepKey("session")).toEqual(vaultFailure("resource-limit"));
    held.release();
    expect((await pending).ok).toBe(true);
  });
}

export function registerLogoutRemovalCases({
  harness,
  unlocked,
}: Pick<VaultManagerTestContext, "harness" | "unlocked">) {
  it("disableAutoUnlock drops this session's key before the record is disabled", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    await unlocked(h);
    expect((await h.manager.disableAutoUnlock()).ok).toBe(true);
    expect(await h.sessionValue()).toBeUndefined();
    expect(h.sessionKey.clear.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.store.compareAndSwap.mock.invocationCallOrder.at(-1)!,
    );
    expect(h.entry()).toMatchObject({ state: "disabled", accepted: lockedEntry().accepted });
    expect(h.opened.size).toBe(0);
    expect(await h.manager.unlock(v1Password)).toEqual(vaultFailure("auto-unlock-disabled"));
  });
  it("remove drops this session's key before the record", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    await unlocked(h);
    expect(await h.manager.remove()).toEqual({ ok: true, data: true });
    expect(await h.sessionValue()).toBeUndefined();
    expect(h.sessionKey.clear.mock.invocationCallOrder.at(-1)).toBeLessThan(
      h.store.remove.mock.invocationCallOrder[0]!,
    );
    expect(h.entry()).toBeNull();
  });
  it("a session key that cannot be dropped stops the log out", async () => {
    const h = harness({ initial: lockedEntry(), retention: "session" });
    await unlocked(h);
    h.sessionKey.clear.mockRejectedValueOnce(new Error("Synthetic storage.session failure"));
    expect(await h.manager.disableAutoUnlock()).toEqual(vaultFailure("storage-uncertain"));
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.opened.size).toBe(0);
  });
}
