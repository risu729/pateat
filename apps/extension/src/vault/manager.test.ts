import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalVaultManager,
  type LocalVaultManager,
  type VaultCheckpoint,
  type VaultCryptoHost,
} from "./manager";
import { type VaultEntry, vaultFailure } from "./record";
import type { DurableVaultStore } from "./storage";
import type { HostSessionRef } from "../crypto/wire";
import type { OpenedHostSession } from "../crypto/host";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import {
  legacyItemKey,
  v1Password,
  V2_DECRYPTED_USER_KEY,
} from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { preparedVault } from "../../../../packages/bitwarden/src/__fixtures__/unlock";
import { activeEntry, disabledEntry, snapshotId } from "./__fixtures__/vault";

const managers: LocalVaultManager[] = [];
const itemId = preparedVault().ciphers[0]!.id! as unknown as string;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function harness(
  options: { initial?: VaultEntry; checkpoint?: (stage: VaultCheckpoint) => Promise<void> } = {},
) {
  let entry: VaultEntry | null = options.initial ? structuredClone(options.initial) : null;
  const events: string[] = [];
  const opened = new Map<
    string,
    { data: OpenedHostSession; prepared: ReturnType<typeof preparedVault> }
  >();
  const store = {
    read: vi.fn<DurableVaultStore["read"]>(async () => ({
      ok: true as const,
      data: structuredClone(entry),
    })),
    compareAndSwap: vi.fn<DurableVaultStore["compareAndSwap"]>(async (expected, next) => {
      events.push("commit");
      if ((entry?.revision ?? null) !== expected) return vaultFailure("storage-conflict");
      entry = structuredClone(next);
      return { ok: true as const, data: { revision: next.revision } };
    }),
    close: vi.fn(),
  };
  const host = {
    open: vi.fn<VaultCryptoHost["open"]>(async (request) => {
      events.push("open");
      const session: HostSessionRef = {
        brokerGeneration: crypto.randomUUID(),
        connectionId: accountProfile.connectionId,
        userId: request.prepared.binding.userId,
        snapshotId: request.snapshotId,
        sessionId: crypto.randomUUID(),
      };
      const metadata = {
        connectionId: accountProfile.connectionId,
        userId: request.prepared.binding.userId,
        accountVersion: request.prepared.binding.accountVersion,
        securityVersion:
          request.prepared.binding.accountVersion === "v2" ? (2 as const) : (1 as const),
      };
      const data = { session, metadata };
      opened.set(session.sessionId, { data, prepared: request.prepared });
      return { ok: true as const, data };
    }),
    verifyReceivedCiphers: vi.fn<VaultCryptoHost["verifyReceivedCiphers"]>(async (session) => {
      events.push("verify-all");
      return {
        ok: true as const,
        data: { verifiedCipherCount: opened.get(session.sessionId)!.prepared.ciphers.length },
      };
    }),
    exportUnlockMaterial: vi.fn<VaultCryptoHost["exportUnlockMaterial"]>(async (session) => {
      events.push("export");
      const active = opened.get(session.sessionId)!;
      return {
        ok: true as const,
        data: {
          metadata: structuredClone(active.data.metadata),
          userKey:
            active.data.metadata.accountVersion === "v2" ? V2_DECRYPTED_USER_KEY : legacyItemKey,
        },
      };
    }),
    lock: vi.fn<VaultCryptoHost["lock"]>(async (session) => {
      events.push("lock");
      opened.delete(session.sessionId);
      return { ok: true as const, data: null };
    }),
    catalog: vi.fn<VaultCryptoHost["catalog"]>(async (session) => ({
      ok: true as const,
      data: {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
        groups: [],
        items: [],
      },
    })),
    matchUris: vi.fn<VaultCryptoHost["matchUris"]>(async (session, targetUrl) => ({
      ok: true as const,
      data: {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
        targetOrigin: new URL(targetUrl).origin,
        candidates: [{ itemId, matches: [{ uriIndex: 0, match: 0 as const }] }],
        unavailableUris: [],
        unavailableItemIds: [],
      },
    })),
    listFields: vi.fn<VaultCryptoHost["listFields"]>(async (session, selectedId) => {
      const active = opened.get(session.sessionId);
      if (!active?.prepared.ciphers.some((cipher) => String(cipher.id) === selectedId))
        return { ok: false as const, error: { code: "field-missing" as const } };
      return {
        ok: true as const,
        data: [
          {
            kind: "hidden" as const,
            name: null,
            label: "Password",
            ref: {
              connectionId: session.connectionId,
              userId: session.userId,
              snapshotId: session.snapshotId,
              itemId: selectedId,
              fieldId: "login.password",
            },
          },
        ],
      };
    }),
    resolveField: vi.fn<VaultCryptoHost["resolveField"]>(async (_session, _ref, grant) =>
      grant.allowedFieldIds.includes("login.password")
        ? { ok: true as const, data: { kind: "text" as const, value: "synthetic-unit-password" } }
        : { ok: false as const, error: { code: "field-denied" as const } },
    ),
    findPasskeys: vi.fn<VaultCryptoHost["findPasskeys"]>(async (session, rpId) => {
      const binding = {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
      };
      return {
        ok: true as const,
        data: {
          ...binding,
          rpId,
          candidates: [
            {
              ...binding,
              itemId,
              credentialId: "AQID",
              rpId,
              userHandle: "BAUG",
              discoverable: true,
              counter: 0,
            },
          ],
          unavailableItemIds: [],
        },
      };
    }),
    signPasskey: vi.fn<VaultCryptoHost["signPasskey"]>(async (session, input) => ({
      ok: true as const,
      data: {
        connectionId: session.connectionId,
        userId: session.userId,
        snapshotId: session.snapshotId,
        itemId: input.itemId,
        credentialId: input.credentialId,
        signature: "MEUCIQ",
      },
    })),
  };
  const manager = createLocalVaultManager({
    profile: accountProfile,
    store,
    host,
    nowMs: () => 2_000_000_000_000,
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
  });
  managers.push(manager);
  return {
    manager,
    store,
    host,
    opened,
    events,
    entry: () => structuredClone(entry),
    setEntry: (value: VaultEntry | null) => {
      entry = structuredClone(value);
    },
  };
}
function candidate(autoUnlock: "enable" | "preserve" = "enable") {
  return {
    prepared: preparedVault(),
    unlock: { kind: "password" as const, password: v1Password },
    autoUnlock,
  };
}
async function accepted(h: ReturnType<typeof harness>) {
  const result = await h.manager.accept(candidate());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Synthetic unit accept failed");
  return result.data;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
});

describe("acceptance verification and publication", () => {
  it("verifies every captured supported item before export and durable commit", async () => {
    const h = harness();
    const result = await accepted(h);
    expect(h.events).toEqual(["open", "verify-all", "export", "commit"]);
    expect(result.summary).toMatchObject({
      autoUnlock: "enabled",
      accountVersion: "v1",
      securityVersion: 1,
      coverage: "received-envelope",
    });
    expect(h.entry()?.state).toBe("active");
    expect(h.manager.status().ready).toBe(true);
    const serialized = JSON.stringify(h.entry());
    expect(serialized).not.toContain(v1Password);
    expect(serialized).not.toContain("synthetic-unit-password");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("managerGeneration");
    expect(serialized).not.toContain("allowedFieldIds");
  });
  it.each(["rejected", "short-count"])(
    "rejects %s full-cipher verification without export or storage",
    async (mode) => {
      const h = harness();
      h.host.verifyReceivedCiphers.mockResolvedValue(
        mode === "rejected"
          ? { ok: false, error: { code: "crypto-failed" } }
          : { ok: true, data: { verifiedCipherCount: 0 } },
      );
      expect(await h.manager.accept(candidate())).toEqual({
        ok: false,
        error: { code: "crypto-failed" },
      });
      expect(h.host.exportUnlockMaterial).not.toHaveBeenCalled();
      expect(h.store.compareAndSwap).not.toHaveBeenCalled();
      expect(h.opened.size).toBe(0);
    },
  );
  it.each(["before-write", "after-write"] as const)(
    "withholds publication at %s checkpoint",
    async (stage) => {
      const held = gate();
      const checkpoint = vi.fn(async (actual) => {
        if (actual === stage) await held.promise;
      });
      const h = harness({ checkpoint });
      const pending = h.manager.accept(candidate());
      const settled = vi.fn();
      void pending.then(settled);
      await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledWith(stage));
      expect(settled).not.toHaveBeenCalled();
      expect(h.manager.status().ready).toBe(false);
      expect(h.store.compareAndSwap).toHaveBeenCalledTimes(stage === "before-write" ? 0 : 1);
      held.release();
      expect((await pending).ok).toBe(true);
    },
  );
  it("locks both old and candidate sessions when commit success cannot be read back", async () => {
    const h = harness();
    const old = await accepted(h);
    h.store.compareAndSwap.mockImplementationOnce(async (_expected, next) => {
      h.setEntry(next);
      h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
      return { ok: true, data: { revision: next.revision } };
    });
    expect(await h.manager.accept(candidate("preserve"))).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
    expect(h.opened.size).toBe(0);
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: true });
    expect(await h.manager.listFields(old.handle, itemId)).toEqual({
      ok: false,
      error: { code: "stale-vault-handle" },
    });
    h.store.read.mockImplementation(async () => ({ ok: true, data: h.entry() }));
    expect((await h.manager.restore()).ok).toBe(true);
  });
  it("preserves a verified old live session only when a failed write reads back the exact prior record", async () => {
    const h = harness();
    const old = await accepted(h);
    const durable = h.entry();
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("cache-quota-exceeded"));
    expect(await h.manager.accept(candidate("preserve"))).toEqual({
      ok: false,
      error: { code: "cache-quota-exceeded" },
    });
    expect(h.entry()).toEqual(durable);
    expect(h.manager.status().ready).toBe(true);
    expect((await h.manager.listFields(old.handle, itemId)).ok).toBe(true);
    expect(h.opened.size).toBe(1);
  });
  it("fences both sessions on an uncertain storage result", async () => {
    const h = harness();
    const old = await accepted(h);
    h.store.compareAndSwap.mockResolvedValueOnce(vaultFailure("storage-uncertain"));
    expect(await h.manager.accept(candidate("preserve"))).toEqual(
      vaultFailure("storage-uncertain"),
    );
    expect(h.opened.size).toBe(0);
    expect((await h.manager.listFields(old.handle, itemId)).ok).toBe(false);
  });
});

describe("durable disable and stale candidate races", () => {
  it("candidate-scoped disable rejects a different durable revision without writing a tombstone", async () => {
    const h = harness();
    await accepted(h);
    const before = h.entry();
    h.store.compareAndSwap.mockClear();
    expect(await h.manager.disableAutoUnlock(crypto.randomUUID())).toEqual(
      vaultFailure("storage-conflict"),
    );
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    expect(h.entry()).toEqual(before);
    expect(h.opened.size).toBe(0);
  });
  it("candidate-scoped disable never retries after a newer acceptance wins the native CAS", async () => {
    const h = harness();
    await accepted(h);
    const old = h.entry();
    if (!old) throw new Error("Synthetic cache acceptance failed");
    const replacement = activeEntry();
    replacement.revision = crypto.randomUUID();
    replacement.accepted.snapshotId = crypto.randomUUID();
    const nativeCas = h.store.compareAndSwap.getMockImplementation()!;
    h.store.compareAndSwap.mockClear();
    h.store.compareAndSwap.mockImplementationOnce(async (expected, next, signal) => {
      h.setEntry(replacement);
      return nativeCas(expected, next, signal);
    });
    expect(await h.manager.disableAutoUnlock(old.revision)).toEqual(
      vaultFailure("storage-conflict"),
    );
    expect(h.store.compareAndSwap).toHaveBeenCalledTimes(1);
    expect(h.entry()).toEqual(replacement);
    expect(h.entry()?.state).toBe("active");
    expect(h.opened.size).toBe(0);
  });
  it("persists an empty disabled tombstone and requires explicit re-enable intent", async () => {
    const h = harness();
    expect(await h.manager.disableAutoUnlock()).toMatchObject({
      ok: true,
      data: { autoUnlock: "disabled" },
    });
    expect(h.entry()).toMatchObject({ state: "disabled" });
    expect(Object.hasOwn(h.entry()!, "userKey")).toBe(false);
    expect(await h.manager.accept(candidate("preserve"))).toEqual(
      vaultFailure("auto-unlock-disabled"),
    );
    expect(h.host.open).not.toHaveBeenCalled();
    expect((await h.manager.accept(candidate("enable"))).ok).toBe(true);
  });
  it("durably disables an accepted record and invalidates live access before ACK", async () => {
    const h = harness();
    const old = await accepted(h);
    expect((await h.manager.disableAutoUnlock()).ok).toBe(true);
    expect(h.opened.size).toBe(0);
    expect(h.entry()).toMatchObject({
      state: "disabled",
      accepted: { recordId: old.handle.recordId, snapshotId: old.handle.snapshotId },
    });
    expect(Object.hasOwn(h.entry()!, "userKey")).toBe(false);
    expect(await h.manager.restore()).toEqual(vaultFailure("auto-unlock-disabled"));
    expect(await h.manager.listFields(old.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
  });
  it("locks a staged candidate before disabled ACK while its pre-commit barrier is held", async () => {
    const held = gate();
    const checkpoint = vi.fn(async (stage) => {
      if (stage === "before-write") await held.promise;
    });
    const h = harness({ checkpoint });
    const pending = h.manager.accept(candidate());
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledWith("before-write"));
    expect(h.opened.size).toBe(1);
    expect((await h.manager.disableAutoUnlock()).ok).toBe(true);
    expect(h.opened.size).toBe(0);
    held.release();
    expect(await pending).toEqual(vaultFailure("cancelled"));
    expect(h.entry()?.state).toBe("disabled");
    expect(h.store.compareAndSwap).toHaveBeenCalledTimes(1); // Only disable wrote.
  });
  it("never retries a stale candidate after another manager installs an initial tombstone", async () => {
    const held = gate();
    const checkpoint = vi.fn(async (stage) => {
      if (stage === "before-write") await held.promise;
    });
    const h = harness({ checkpoint });
    const pending = h.manager.accept(candidate());
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledWith("before-write"));
    const other = createLocalVaultManager({
      profile: accountProfile,
      host: h.host,
      store: h.store,
    });
    managers.push(other);
    expect((await other.disableAutoUnlock()).ok).toBe(true);
    held.release();
    expect(await pending).toEqual(vaultFailure("storage-conflict"));
    expect(h.entry()?.state).toBe("disabled");
    expect(h.store.compareAndSwap).toHaveBeenCalledTimes(2); // Disable then one failed candidate CAS.
    expect(h.opened.size).toBe(0);
  });
  it("cannot refresh a disabled accepted record without explicit enable", async () => {
    const h = harness({ initial: disabledEntry() });
    expect(await h.manager.accept(candidate("preserve"))).toEqual(
      vaultFailure("auto-unlock-disabled"),
    );
    expect(h.host.open).not.toHaveBeenCalled();
    expect((await h.manager.accept(candidate("enable"))).ok).toBe(true);
  });
});

describe("offline restore and fresh session scope", () => {
  it("restores the same accepted snapshot using only a decrypted key and a fresh manager handle", async () => {
    const durable = activeEntry();
    const h = harness({ initial: durable });
    const first = await h.manager.restore();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Synthetic restore failed");
    expect(first.data.handle).toMatchObject({ recordId: durable.accepted.recordId, snapshotId });
    expect(h.host.open.mock.calls[0]![0].unlock).toEqual({
      kind: "decrypted-key",
      userKey: durable.userKey,
    });
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
    const second = createLocalVaultManager({
      profile: accountProfile,
      host: h.host,
      store: h.store,
    });
    managers.push(second);
    const restored = await second.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("Second synthetic restore failed");
    expect(restored.data.handle.snapshotId).toBe(first.data.handle.snapshotId);
    expect(restored.data.handle.managerGeneration).not.toBe(first.data.handle.managerGeneration);
    expect(await second.listFields(first.data.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
  });
  it.each([
    "managerGeneration",
    "handleId",
    "connectionId",
    "userId",
    "recordId",
    "snapshotId",
  ] as const)("denies a changed handle %s before host access", async (key) => {
    const h = harness();
    const current = await accepted(h);
    expect(
      await h.manager.listFields({ ...current.handle, [key]: crypto.randomUUID() }, itemId),
    ).toEqual(vaultFailure("stale-vault-handle"));
    expect(h.host.listFields).not.toHaveBeenCalled();
  });
  it("requires the current policy snapshot and retains field exclusion", async () => {
    const h = harness();
    const current = await accepted(h);
    const listed = await h.manager.listFields(current.handle, itemId);
    if (!listed.ok) throw new Error("Synthetic field listing failed");
    const ref = listed.data[0]!.ref;
    expect(
      await h.manager.resolveField(current.handle, ref, {
        snapshotId: crypto.randomUUID(),
        allowedFieldIds: ["login.password"],
      }),
    ).toEqual(vaultFailure("stale-field-reference"));
    expect(h.host.resolveField).not.toHaveBeenCalled();
    expect(
      await h.manager.resolveField(current.handle, ref, {
        snapshotId: current.handle.snapshotId,
        allowedFieldIds: [],
      }),
    ).toEqual(vaultFailure("field-denied"));
  });
  it("withholds a completed field result after disable invalidates its handle", async () => {
    const h = harness();
    const current = await accepted(h);
    const listed = await h.manager.listFields(current.handle, itemId);
    if (!listed.ok) throw new Error("Synthetic field listing failed");
    const held = gate();
    h.host.resolveField.mockImplementationOnce(async () => {
      await held.promise;
      return { ok: true, data: { kind: "text", value: "synthetic-late-password" } };
    });
    const pending = h.manager.resolveField(current.handle, listed.data[0]!.ref, {
      snapshotId: current.handle.snapshotId,
      allowedFieldIds: ["login.password"],
    });
    await h.manager.disableAutoUnlock();
    held.release();
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
  });
  it("replaces a now-unavailable item without reusing its old decrypted field", async () => {
    const h = harness();
    const old = await accepted(h);
    const next = candidate("preserve");
    next.prepared.ciphers = [];
    next.prepared.unavailableItems = [{ itemId, reason: "unsupported-cipher-type" }];
    const result = await h.manager.accept(next);
    if (!result.ok) throw new Error("Synthetic unavailable-item accept failed");
    expect(result.data.handle.snapshotId).not.toBe(old.handle.snapshotId);
    expect(await h.manager.listFields(old.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect((await h.manager.listFields(result.data.handle, itemId)).ok).toBe(false);
  });
});

describe("prior accepted identity and signed account floor", () => {
  it.each(["active", "disabled"] as const)(
    "retains the prior V2 account format even with floor1 in %s state",
    async (state) => {
      const prior = activeEntry("v2");
      prior.accepted.minimumSecurityVersion = 1;
      prior.accepted.prepared.minimumSecurityVersion = 1;
      const initial: VaultEntry =
        state === "active"
          ? prior
          : {
              schemaVersion: 1,
              revision: prior.revision,
              profile: prior.profile,
              state: "disabled",
              accepted: prior.accepted,
            };
      const h = harness({ initial });
      expect(await h.manager.accept(candidate())).toEqual(vaultFailure("security-downgrade"));
      expect(h.host.open).not.toHaveBeenCalled();
    },
  );
  it("carries the prior verified floor into a fresh native open rather than trusting lower prepared metadata", async () => {
    const h = harness({ initial: activeEntry("v2") });
    const next = { ...candidate(), prepared: preparedVault("v2") };
    expect(next.prepared.minimumSecurityVersion).toBe(1);
    const result = await h.manager.accept(next);
    expect(result.ok).toBe(true);
    expect(h.host.open.mock.calls[0]![0].prepared.minimumSecurityVersion).toBe(2);
  });
  it("rejects a different account subject before native open", async () => {
    const h = harness({ initial: activeEntry() });
    const next = candidate();
    next.prepared.binding.userId = "50000000-0000-4000-8000-000000000001";
    expect(await h.manager.accept(next)).toEqual(vaultFailure("account-mismatch"));
    expect(h.host.open).not.toHaveBeenCalled();
  });
});

describe("durable authority across independent managers", () => {
  it("joins an in-flight native retirement before disable ACK and never opens a stale restored candidate", async () => {
    const h = harness({ initial: activeEntry() });
    const first = await h.manager.restore();
    if (!first.ok) throw new Error("Synthetic first restore failed");
    const held = gate();
    h.host.lock.mockImplementationOnce(async (session) => {
      await held.promise;
      h.opened.delete(session.sessionId);
      return { ok: true, data: null };
    });
    const pending = h.manager.restore();
    await vi.waitFor(() => expect(h.host.lock).toHaveBeenCalledTimes(1));
    let disabled = false;
    const disabling = h.manager.disableAutoUnlock().then((result) => {
      disabled = true;
      return result;
    });
    try {
      // Drain the deterministic mocked storage/host microtasks: an unjoined
      // fence would already ACK although the old native session still exists.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(disabled).toBe(false);
      expect(h.opened.size).toBe(1);
      expect(h.host.open).toHaveBeenCalledTimes(1);
    } finally {
      held.release();
    }
    expect((await disabling).ok).toBe(true);
    expect((await pending).ok).toBe(false);
    expect(h.host.open).toHaveBeenCalledTimes(1);
    expect(h.manager.status().ready).toBe(false);
    expect(h.opened.size).toBe(0);
    expect(h.entry()?.state).toBe("disabled");
  });
  it("denies an old live handle after another manager durably disables its record", async () => {
    const h = harness();
    const current = await accepted(h);
    const other = createLocalVaultManager({
      profile: accountProfile,
      host: h.host,
      store: h.store,
    });
    managers.push(other);
    expect((await other.disableAutoUnlock()).ok).toBe(true);
    expect(await h.manager.listFields(current.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(h.host.listFields).not.toHaveBeenCalled();
    expect(h.opened.size).toBe(0);
  });
  it("matches URIs only through the current live snapshot and withholds a late result", async () => {
    const h = harness();
    const current = await accepted(h);
    const matched = await h.manager.matchUris(current.handle, "https://example.com/login");
    expect(matched).toMatchObject({
      ok: true,
      data: { snapshotId: current.handle.snapshotId, candidates: [{ itemId }] },
    });
    expect(h.host.matchUris.mock.calls[0]?.[0].snapshotId).toBe(current.handle.snapshotId);
    const held = gate();
    h.host.matchUris.mockImplementationOnce(async (session, targetUrl) => {
      await held.promise;
      return {
        ok: true,
        data: {
          connectionId: session.connectionId,
          userId: session.userId,
          snapshotId: session.snapshotId,
          targetOrigin: new URL(targetUrl).origin,
          candidates: [],
          unavailableUris: [],
          unavailableItemIds: [],
        },
      };
    });
    const pending = h.manager.matchUris(current.handle, "https://example.com/login");
    await vi.waitFor(() => expect(h.host.matchUris).toHaveBeenCalledTimes(2));
    await h.manager.disableAutoUnlock();
    held.release();
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    expect(await h.manager.matchUris(current.handle, "https://example.com/login")).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(h.host.matchUris).toHaveBeenCalledTimes(2);
  });
  it("finds and signs passkeys only through the current live snapshot", async () => {
    const h = harness();
    const current = await accepted(h);
    expect(await h.manager.findPasskeys(current.handle, "example.com")).toMatchObject({
      ok: true,
      data: {
        snapshotId: current.handle.snapshotId,
        rpId: "example.com",
        candidates: [{ itemId, credentialId: "AQID" }],
      },
    });
    const input = {
      itemId,
      credentialId: "AQID",
      rpId: "example.com",
      authenticatorData: "A".repeat(50),
      clientDataHash: "A".repeat(43),
    };
    expect(await h.manager.signPasskey(current.handle, input)).toMatchObject({
      ok: true,
      data: { snapshotId: current.handle.snapshotId, itemId, signature: "MEUCIQ" },
    });
    expect(h.host.signPasskey.mock.calls[0]?.[0].snapshotId).toBe(current.handle.snapshotId);
    expect(h.host.signPasskey.mock.calls[0]?.[1]).toEqual(input);
    expect(
      await h.manager.signPasskey(current.handle, undefined as unknown as typeof input),
    ).toEqual(vaultFailure("invalid-request"));
    expect(h.host.signPasskey).toHaveBeenCalledTimes(1);
    const held = gate();
    h.host.signPasskey.mockImplementationOnce(async (session, signed) => {
      await held.promise;
      return {
        ok: true,
        data: {
          connectionId: session.connectionId,
          userId: session.userId,
          snapshotId: session.snapshotId,
          itemId: signed.itemId,
          credentialId: signed.credentialId,
          signature: "MEUCIQ",
        },
      };
    });
    const pending = h.manager.signPasskey(current.handle, input);
    await vi.waitFor(() => expect(h.host.signPasskey).toHaveBeenCalledTimes(2));
    await h.manager.disableAutoUnlock();
    held.release();
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    expect(await h.manager.findPasskeys(current.handle, "example.com")).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(await h.manager.signPasskey(current.handle, input)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(h.host.findPasskeys).toHaveBeenCalledTimes(1);
    expect(h.host.signPasskey).toHaveBeenCalledTimes(2);
  });
  it("withholds a field completed after an external writer replaces the accepted revision", async () => {
    const h = harness();
    const current = await accepted(h);
    const listed = await h.manager.listFields(current.handle, itemId);
    if (!listed.ok) throw new Error("Synthetic listing failed");
    const held = gate();
    h.host.resolveField.mockImplementationOnce(async () => {
      await held.promise;
      return { ok: true, data: { kind: "text", value: "synthetic-late-password" } };
    });
    const pending = h.manager.resolveField(current.handle, listed.data[0]!.ref, {
      snapshotId: current.handle.snapshotId,
      allowedFieldIds: ["login.password"],
    });
    await vi.waitFor(() => expect(h.host.resolveField).toHaveBeenCalledTimes(1));
    const replaced = h.entry()!;
    replaced.revision = crypto.randomUUID();
    h.setEntry(replaced);
    held.release();
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    expect(h.opened.size).toBe(0);
  });
  it("detaches handle, reference, and allowed fields before a slow durable preflight read", async () => {
    const h = harness();
    const current = await accepted(h);
    const listed = await h.manager.listFields(current.handle, itemId);
    if (!listed.ok) throw new Error("Synthetic listing failed");
    const held = gate();
    const durable = h.entry();
    h.store.read.mockImplementationOnce(async () => {
      await held.promise;
      return { ok: true, data: durable };
    });
    const ref = structuredClone(listed.data[0]!.ref);
    const originalRef = structuredClone(ref);
    const originalHandle = structuredClone(current.handle);
    const grant = { snapshotId: current.handle.snapshotId, allowedFieldIds: [] as string[] };
    const pending = h.manager.resolveField(current.handle, ref, grant);
    grant.snapshotId = crypto.randomUUID();
    grant.allowedFieldIds.push("login.password");
    Object.assign(ref, { fieldId: "login.username" });
    current.handle.handleId = crypto.randomUUID();
    held.release();
    expect(await pending).toEqual(vaultFailure("field-denied"));
    expect(h.host.resolveField.mock.calls[0]![1]).toEqual(originalRef);
    expect(h.host.resolveField.mock.calls[0]![2]).toEqual({ allowedFieldIds: [] });
    expect((await h.manager.listFields(originalHandle, itemId)).ok).toBe(true);
  });
  it("gives same-record restoration a fresh activation handle inside one manager", async () => {
    const h = harness({ initial: activeEntry() });
    const first = await h.manager.restore();
    const second = await h.manager.restore();
    if (!first.ok || !second.ok) throw new Error("Synthetic restore failed");
    expect(second.data.handle.snapshotId).toBe(first.data.handle.snapshotId);
    expect(second.data.handle.handleId).not.toBe(first.data.handle.handleId);
    expect(await h.manager.listFields(first.data.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
  });
});
