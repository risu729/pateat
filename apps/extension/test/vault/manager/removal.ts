import { expect, it, vi } from "vitest";
import { vaultFailure } from "../../../src/vault/record";
import type { VaultManagerTestContext } from "./context";

export function registerRemovalCases({
  harness,
  candidate,
  accepted,
  gate,
  itemId,
}: Pick<VaultManagerTestContext, "harness" | "candidate" | "accepted" | "gate" | "itemId">) {
  it("locks the live session before deleting the record and its retained unlock key", async () => {
    const h = harness();
    const old = await accepted(h);
    h.events.length = 0;
    expect(await h.manager.remove()).toEqual({ ok: true, data: true });
    expect(h.events).toEqual(["lock", "remove"]);
    expect(h.opened.size).toBe(0);
    expect(h.entry()).toBeNull();
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: false });
    expect(await h.manager.restore()).not.toMatchObject({ ok: true });
    expect(await h.manager.listFields(old.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
  });
  it("cancels a staged candidate so it cannot recreate the deleted record", async () => {
    const held = gate();
    const checkpoint = vi.fn(async (stage) => {
      if (stage === "before-write") await held.promise;
    });
    const h = harness({ checkpoint });
    const pending = h.manager.accept(candidate());
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledWith("before-write"));
    expect((await h.manager.remove()).ok).toBe(true);
    expect(h.opened.size).toBe(0);
    held.release();
    expect(await pending).toEqual(vaultFailure("cancelled"));
    expect(h.entry()).toBeNull();
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
  });
  it("reports an unconfirmed deletion as storage uncertainty", async () => {
    const h = harness();
    await accepted(h);
    h.store.remove.mockResolvedValueOnce(vaultFailure("storage-uncertain"));
    expect(await h.manager.remove()).toEqual(vaultFailure("storage-uncertain"));
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: true });
  });
}
