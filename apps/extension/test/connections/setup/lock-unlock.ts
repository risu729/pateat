import { expect, it, vi } from "vitest";
import { type VaultApplyHold } from "../../../src/connections/auto-sync";
import { parseSetupReply } from "../../../src/connections/wire";
import type { ConnectionSetupDependencies } from "../../../src/connections/types";
import {
  accountNow,
  accountProfile,
} from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Password } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import { activeEntry, lockedEntry } from "../../../src/vault/__fixtures__/vault";
import type { VaultEntry } from "../../../src/vault/record";
import { createLocalVaultManager, type VaultCryptoHost } from "../../../src/vault/manager";
import type { DurableVaultStore } from "../../../src/vault/storage";
import { memorySessionKeyStore } from "../../../src/vault/session-key";
import type { HostSessionRef } from "../../../src/crypto/wire";
import { legacyItemKey } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import type { SetupTestContext } from "./context";

export function registerLockUnlockCases({
  gate,
  harness,
  noSecrets,
  connectionId,
  unlockedReply,
  signedIn,
  lockInPlace,
  lockingManager,
  closers,
}: Pick<
  SetupTestContext,
  | "gate"
  | "harness"
  | "noSecrets"
  | "connectionId"
  | "unlockedReply"
  | "signedIn"
  | "lockInPlace"
  | "lockingManager"
  | "closers"
>) {
  it.each(["prelogin", "token"])(
    "a second caller's lock cancels sign-in blocked at %s even if its provider later answers",
    async (stage) => {
      const h = harness({ existing: true });
      await signedIn(h);
      const retained = h.sessionMemory.raw();
      lockingManager(h);
      h.manager.accept.mockClear();
      const entered = gate();
      const held = gate();
      const fetch = h.fetch.getMockImplementation()!;
      h.fetch.mockImplementation(async (url, init) => {
        const path = new URL(url).pathname;
        if (stage === "prelogin" ? path.includes("prelogin") : path.endsWith("/token")) {
          entered.release();
          // Deliberately ignore AbortSignal: even a late successful answer cannot unlock.
          await held.promise;
        }
        return fetch(url, init);
      });
      const pending = h.caller.begin({ kind: "existing", connectionId, password: v1Password });
      const other = h.service.createCaller();
      closers.push(() => other.dispose());
      try {
        await entered.promise;
        expect(await other.lock(connectionId)).toEqual({ ok: true, kind: "locked", connectionId });
        expect(h.durable()?.state).toBe("locked");
      } finally {
        held.release();
      }
      expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
      expect(h.durable()?.state).toBe("locked");
      expect(h.manager.accept).not.toHaveBeenCalled();
      expect(h.sessionMemory.raw()).toEqual(retained);
      expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
      expect(h.manager.remove).not.toHaveBeenCalled();
    },
  );

  it("lock invalidates a waiting MFA flow while retaining the existing provider session", async () => {
    const h = harness({ existing: true });
    await signedIn(h);
    const retained = h.sessionMemory.raw();
    lockingManager(h);
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", TwoFactorProviders2: { "0": null } },
    });
    const challenge = await h.caller.begin({
      kind: "existing",
      connectionId,
      password: v1Password,
    });
    if (!challenge.ok || challenge.kind !== "mfa-required")
      throw new Error("Synthetic MFA challenge failed");
    const requests = h.fetch.mock.calls.length;
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.lock(connectionId)).toEqual({ ok: true, kind: "locked", connectionId });
    expect(await h.caller.keepAlive(challenge.flowId)).toEqual({
      ok: false,
      error: { code: "setup-expired" },
    });
    expect(
      (
        await h.caller.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "000123" },
        })
      ).ok,
    ).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(requests);
    expect(h.durable()?.state).toBe("locked");
    expect(h.sessionMemory.raw()).toEqual(retained);
  });

  it("lock waits for accepted-flow retirement before locking its durable vault", async () => {
    const h = harness({ existing: true });
    lockingManager(h);
    const catalogHeld = gate();
    const retirementHeld = gate();
    const catalog = h.manager.catalog.getMockImplementation()!;
    h.manager.catalog.mockImplementationOnce(async (handle) => {
      await catalogHeld.promise;
      return catalog(handle);
    });
    h.manager.lock.mockImplementationOnce(async () => retirementHeld.promise);
    const pending = h.caller.begin({ kind: "existing", connectionId, password: v1Password });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    try {
      await vi.waitFor(() => expect(h.manager.catalog).toHaveBeenCalledOnce());
      const locked = other.lock(connectionId);
      await vi.waitFor(() => expect(h.manager.lock).toHaveBeenCalledOnce());
      expect(h.manager.lockVault).not.toHaveBeenCalled();
      retirementHeld.release();
      expect(await locked).toEqual({ ok: true, kind: "locked", connectionId });
      expect(h.durable()?.state).toBe("locked");
    } finally {
      retirementHeld.release();
      catalogHeld.release();
    }
    expect((await pending).ok).toBe(false);
    expect(h.durable()?.state).toBe("locked");
    expect(h.policy.adopt).not.toHaveBeenCalled();
  });

  it.each(["begin", "unlock"] as const)(
    "%s admitted before lock cannot resume from a stale registry read after lock returns",
    async (operation) => {
      const h = harness({ existing: true });
      h.manager.unlock.mockResolvedValue(unlockedReply());
      lockingManager(h);
      const reading = gate();
      const entered = gate();
      const get = h.registry.get.getMockImplementation()!;
      h.registry.get.mockImplementationOnce(async (id) => {
        const stale = await get(id);
        entered.release();
        await reading.promise;
        return stale;
      });
      const pending =
        operation === "begin"
          ? h.caller.begin({ kind: "existing", connectionId, password: v1Password })
          : h.caller.unlock({ connectionId, password: v1Password });
      const other = h.service.createCaller();
      closers.push(() => other.dispose());
      try {
        await entered.promise;
        expect(await other.lock(connectionId)).toMatchObject({ ok: true, kind: "locked" });
      } finally {
        reading.release();
      }
      expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.manager.unlock).not.toHaveBeenCalled();
      expect(h.durable()?.state).toBe("locked");
    },
  );

  it.each(["begin", "unlock"] as const)(
    "%s admitted during lock cannot resume from a stale registry read after lock returns",
    async (operation) => {
      const h = harness({ existing: true });
      h.manager.unlock.mockResolvedValue(unlockedReply());
      lockingManager(h);
      const locking = gate();
      const lockVault = h.manager.lockVault.getMockImplementation()!;
      h.manager.lockVault.mockImplementationOnce(async () => {
        await locking.promise;
        return lockVault();
      });
      const other = h.service.createCaller();
      closers.push(() => other.dispose());
      const locked = other.lock(connectionId);
      await vi.waitFor(() => expect(h.manager.lockVault).toHaveBeenCalledOnce());
      const reading = gate();
      const entered = gate();
      const get = h.registry.get.getMockImplementation()!;
      h.registry.get.mockImplementationOnce(async (id) => {
        const stale = await get(id);
        entered.release();
        await reading.promise;
        return stale;
      });
      const pending =
        operation === "begin"
          ? h.caller.begin({ kind: "existing", connectionId, password: v1Password })
          : h.caller.unlock({ connectionId, password: v1Password });
      try {
        await entered.promise;
        locking.release();
        expect(await locked).toMatchObject({ ok: true, kind: "locked" });
      } finally {
        locking.release();
        reading.release();
      }
      expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.manager.unlock).not.toHaveBeenCalled();
      expect(h.durable()?.state).toBe("locked");
    },
  );

  it("locking another connection does not cancel this connection's pending sign-in", async () => {
    const otherId = "synthetic-other-connection";
    const otherLock = vi.fn(async () => ({ ok: true as const, data: null }));
    const h = harness({
      existing: true,
      vaultFor: (profile) =>
        profile.connectionId === otherId
          ? ({ manager: { lockVault: otherLock } } as unknown as ReturnType<
              ConnectionSetupDependencies["vaultFor"]
            >)
          : undefined,
    });
    h.configurations.set(otherId, {
      ...structuredClone(h.configurations.get(connectionId)!),
      profile: { ...accountProfile, connectionId: otherId },
    });
    const entered = gate();
    const held = gate();
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname.endsWith("/token")) {
        entered.release();
        await held.promise;
      }
      return fetch(url, init);
    });
    const pending = h.caller.begin({ kind: "existing", connectionId, password: v1Password });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    try {
      await entered.promise;
      expect(await other.lock(otherId)).toEqual({
        ok: true,
        kind: "locked",
        connectionId: otherId,
      });
      expect(otherLock).toHaveBeenCalledOnce();
      expect(h.manager.lockVault).not.toHaveBeenCalled();
    } finally {
      held.release();
    }
    expect(await pending).toMatchObject({ ok: true, kind: "ready", connectionId });
    expect(h.durable()?.state).toBe("active");
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
  });

  it.each(["before-write", "after-write"] as const)(
    "lock fences real vault-manager acceptance paused at %s and late completion cannot reopen it",
    async (stage) => {
      let durable: VaultEntry | null = activeEntry();
      const store: DurableVaultStore = {
        read: async () => ({ ok: true, data: structuredClone(durable) }),
        compareAndSwap: async (expected, next) => {
          if ((durable?.revision ?? null) !== expected)
            return { ok: false, error: { code: "storage-conflict" } };
          durable = structuredClone(next);
          return { ok: true, data: { revision: next.revision } };
        },
        remove: async () => {
          durable = null;
          return { ok: true, data: true };
        },
        close() {},
      };
      const opened = new Set<string>();
      // Exercise the real manager's epochs, commits and cleanup with synthetic crypto replies.
      const cryptoHost = {
        open: vi.fn<VaultCryptoHost["open"]>(async (input) => {
          const session: HostSessionRef = {
            brokerGeneration: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            connectionId,
            userId: input.prepared.binding.userId,
            snapshotId: input.snapshotId,
          };
          opened.add(session.sessionId);
          return {
            ok: true,
            data: {
              session,
              metadata: {
                connectionId,
                userId: session.userId,
                accountVersion: "v1",
                securityVersion: 1,
              },
            },
          };
        }),
        verifyReceivedCiphers: vi.fn<VaultCryptoHost["verifyReceivedCiphers"]>(async () => ({
          ok: true,
          data: { verifiedCipherCount: 1, unusableItems: [], partialItems: [] },
        })),
        exportUnlockMaterial: vi.fn<VaultCryptoHost["exportUnlockMaterial"]>(async (session) => ({
          ok: true,
          data: {
            metadata: {
              connectionId,
              userId: session.userId,
              accountVersion: "v1",
              securityVersion: 1,
            },
            userKey: legacyItemKey,
          },
        })),
        lock: vi.fn<VaultCryptoHost["lock"]>(async (session) => {
          opened.delete(session.sessionId);
          return { ok: true, data: null };
        }),
        isOpen: (session: HostSessionRef) => opened.has(session.sessionId),
      };
      const entered = gate();
      const held = gate();
      const sessionKey = memorySessionKeyStore();
      const manager = createLocalVaultManager({
        profile: accountProfile,
        host: cryptoHost as unknown as VaultCryptoHost,
        store,
        sessionKey,
        nowMs: () => accountNow * 1000,
        checkpoint: async (current) => {
          if (current !== stage) return;
          entered.release();
          await held.promise;
        },
      });
      closers.push(() => manager.dispose());
      const h = harness({ existing: true, vaultFor: () => ({ store, manager }) });
      const other = h.service.createCaller();
      closers.push(() => other.dispose());
      const pending = h.caller.begin({ kind: "existing", connectionId, password: v1Password });
      try {
        await entered.promise;
        expect(await other.lock(connectionId)).toEqual({ ok: true, kind: "locked", connectionId });
        expect(await store.read()).toMatchObject({ ok: true, data: { state: "locked" } });
        expect(await sessionKey.read()).toBeUndefined();
        expect(opened.size).toBe(0);
      } finally {
        held.release();
      }
      expect((await pending).ok).toBe(false);
      expect(await store.read()).toMatchObject({ ok: true, data: { state: "locked" } });
      expect(await sessionKey.read()).toBeUndefined();
      expect(opened.size).toBe(0);
      expect(h.policy.adopt).not.toHaveBeenCalled();
      expect(h.sessionMemory.raw()).toBeUndefined();
    },
  );

  it("lock locks the vault and keeps its sync sign-in", async () => {
    const h = harness({ existing: true });
    await signedIn(h);
    h.manager.lockVault.mockResolvedValue({ ok: true, data: null });
    const reply = await h.caller.lock(connectionId);
    expect(reply).toEqual({ ok: true, kind: "locked", connectionId });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.manager.lockVault).toHaveBeenCalledOnce();
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.manager.remove).not.toHaveBeenCalled();
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
  });
  it("lock answers the vault's failure", async () => {
    const h = harness({ existing: true });
    h.manager.lockVault.mockResolvedValue({ ok: false, error: { code: "storage-uncertain" } });
    expect(await h.caller.lock(connectionId)).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
  });
  it("lock refuses an unknown connection without touching a vault", async () => {
    const h = harness({ existing: true });
    expect(await h.caller.lock("synthetic-missing")).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(h.manager.lockVault).not.toHaveBeenCalled();
  });
  it("a second lock or a log out while a lock runs is refused", async () => {
    const h = harness({ existing: true });
    let release!: () => void;
    h.manager.lockVault.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: null });
        }),
    );
    const pending = h.caller.lock(connectionId);
    await vi.waitFor(() => expect(h.manager.lockVault).toHaveBeenCalledOnce());
    expect(await h.service.createCaller().lock(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(await h.caller.disable(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    release();
    expect(await pending).toMatchObject({ ok: true, kind: "locked" });
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("unlock opens the vault offline with the master password", async () => {
    const h = harness({ existing: true });
    h.setDurable(lockedEntry());
    h.manager.unlock.mockResolvedValue(unlockedReply());
    const reply = await h.caller.unlock({ connectionId, password: v1Password });
    expect(reply).toEqual({ ok: true, kind: "unlocked", connectionId });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.manager.unlock).toHaveBeenCalledOnce();
    expect(h.manager.unlock.mock.calls[0]?.[0]).toBe(v1Password);
    noSecrets(reply);
    // No server is asked.
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.revisionDate).not.toHaveBeenCalled();
    expect(h.host.deriveAuthentication).not.toHaveBeenCalled();
    expect(h.permissions.contains).not.toHaveBeenCalled();
  });
  it("unlock answers a wrong master password as the vault does", async () => {
    const h = harness({ existing: true });
    h.setDurable(lockedEntry());
    h.manager.unlock.mockResolvedValue({ ok: false, error: { code: "crypto-failed" } });
    const reply = await h.caller.unlock({ connectionId, password: "synthetic-wrong-password" });
    expect(reply).toEqual({ ok: false, error: { code: "crypto-failed" } });
    expect(parseSetupReply(reply)).toEqual(reply);
    // The caller is free for the next try.
    h.manager.unlock.mockResolvedValue(unlockedReply());
    expect(await h.caller.unlock({ connectionId, password: v1Password })).toMatchObject({
      ok: true,
      kind: "unlocked",
    });
  });
  it("unlock refuses an unknown connection", async () => {
    const h = harness({ existing: true });
    expect(
      await h.caller.unlock({ connectionId: "synthetic-missing", password: v1Password }),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    expect(h.manager.unlock).not.toHaveBeenCalled();
  });
  it("unlock is refused while a sign-in of that connection runs", async () => {
    const h = harness({ existing: true });
    const derive = gate();
    const original = h.host.deriveAuthentication.getMockImplementation()!;
    h.host.deriveAuthentication.mockImplementationOnce(async (input, signal) => {
      await derive.promise;
      return original(input, signal);
    });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    const signIn = other.begin({ kind: "existing", connectionId, password: v1Password });
    await vi.waitFor(() => expect(h.host.deriveAuthentication).toHaveBeenCalledOnce());
    expect(await h.caller.unlock({ connectionId, password: v1Password })).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(h.manager.unlock).not.toHaveBeenCalled();
    derive.release();
    expect((await signIn).ok).toBe(true);
  });
  it("unlock is refused while a lock of that connection runs", async () => {
    const h = harness({ existing: true });
    let release!: () => void;
    h.manager.lockVault.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: null });
        }),
    );
    const pending = h.caller.lock(connectionId);
    await vi.waitFor(() => expect(h.manager.lockVault).toHaveBeenCalledOnce());
    expect(await h.service.createCaller().unlock({ connectionId, password: v1Password })).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    release();
    await pending;
    expect(h.manager.unlock).not.toHaveBeenCalled();
  });
  it("status reports a vault locked without this session's key as locked", async () => {
    const h = harness({ existing: true });
    h.setDurable(lockedEntry());
    const reply = await h.caller.status();
    expect(reply).toMatchObject({
      ok: true,
      kind: "status",
      connections: [{ connectionId, state: "locked", autoUnlock: "disabled" }],
    });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.manager.keyFor).toHaveBeenCalled();
  });
  it("status reports a vault unlocked in this session as usable, its key not on disk", async () => {
    const h = harness({ existing: true });
    h.setDurable(lockedEntry());
    h.manager.keyFor.mockResolvedValue(activeEntry().userKey);
    expect(await h.caller.status()).toMatchObject({
      connections: [{ state: "ready", autoUnlock: "disabled" }],
    });
  });
  it("a logged-out vault stays disabled however its key is held", async () => {
    const h = harness({ existing: true });
    h.setDurable({ ...lockedEntry(), state: "disabled" });
    h.manager.keyFor.mockResolvedValue(activeEntry().userKey);
    expect(await h.caller.status()).toMatchObject({
      connections: [{ state: "disabled", autoUnlock: "disabled" }],
    });
  });
  it("sync on a locked vault asks for the unlock and sends nothing", async () => {
    const h = harness({ existing: true });
    await signedIn(h);
    lockInPlace(h);
    const fetches = h.fetch.mock.calls.length;
    const accepts = h.manager.accept.mock.calls.length;
    const reply = await h.caller.sync(connectionId);
    expect(reply).toEqual({ ok: false, error: { code: "vault-locked" } });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts);
  });
  it("sync on a vault unlocked in this session opens the next snapshot with that key", async () => {
    const h = harness({ existing: true });
    await signedIn(h);
    const active = lockInPlace(h);
    h.manager.keyFor.mockResolvedValue(active.userKey);
    const accepts = h.manager.accept.mock.calls.length;
    expect(await h.caller.sync(connectionId)).toMatchObject({ ok: true, kind: "ready" });
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts + 1);
    expect(h.manager.accept.mock.calls.at(-1)?.[0]).toMatchObject({
      unlock: { kind: "decrypted-key", userKey: active.userKey },
      autoUnlock: "preserve",
    });
  });
  it("an automatic check skips a locked vault without a request", async () => {
    const h = harness({ existing: true });
    await signedIn(h);
    lockInPlace(h);
    const fetches = h.fetch.mock.calls.length;
    const checks = h.revisionDate.mock.calls.length;
    const hold: VaultApplyHold = { ready: async () => true, take: async () => () => undefined };
    expect(await h.restart().service.autoSync(connectionId, hold)).toBe("skipped");
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    expect(h.revisionDate).toHaveBeenCalledTimes(checks);
  });
  it("a password sign-in always unlocks: accept is asked to enable", async () => {
    const h = harness({ existing: true });
    h.setDurable(lockedEntry());
    await signedIn(h);
    expect(h.manager.accept.mock.calls.at(-1)?.[0].autoUnlock).toBe("enable");
  });
}
