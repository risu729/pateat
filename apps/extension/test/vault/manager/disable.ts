import { expect, it, vi } from "vitest";
import { createLocalVaultManager } from "../../../src/vault/manager";
import { vaultFailure } from "../../../src/vault/record";
import { accountProfile } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { activeEntry, disabledEntry } from "../../../src/vault/__fixtures__/vault";
import type { VaultManagerTestContext } from "./context";

export function registerDisableCases({
  harness,
  candidate,
  accepted,
  gate,
  itemId,
  managers,
}: Pick<
  VaultManagerTestContext,
  "harness" | "candidate" | "accepted" | "gate" | "itemId" | "managers"
>) {
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
}
