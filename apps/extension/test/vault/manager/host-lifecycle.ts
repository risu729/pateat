import { expect, it } from "vitest";
import { vaultFailure } from "../../../src/vault/record";
import { activeEntry } from "../../../src/vault/__fixtures__/vault";
import type { VaultManagerTestContext } from "./context";

export function registerHostLifecycleCases({
  harness,
  candidate,
  accepted,
  itemId,
}: Pick<VaultManagerTestContext, "harness" | "candidate" | "accepted" | "itemId">) {
  it("forgets a live session the crypto host has ended", async () => {
    const h = harness({ initial: activeEntry() });
    const first = await h.manager.restore();
    if (!first.ok) throw new Error("Synthetic restore failed");
    expect(h.manager.status().ready).toBe(true);
    // A Worker timeout or a lost offscreen document ends the session without a lock.
    h.opened.clear();
    const status = h.manager.status();
    expect(status.ready).toBe(false);
    expect(status.handle).toBeUndefined();
    expect(await h.manager.catalog(first.data.handle)).toEqual(vaultFailure("stale-vault-handle"));
    expect(h.host.catalog).not.toHaveBeenCalled();
    const next = await h.manager.restore();
    if (!next.ok) throw new Error("Synthetic second restore failed");
    expect(next.data.handle.handleId).not.toBe(first.data.handle.handleId);
    expect(h.manager.status()).toMatchObject({ ready: true, handle: next.data.handle });
    expect(h.opened.size).toBe(1);
    expect((await h.manager.catalog(next.data.handle)).ok).toBe(true);
  });
  it("compares no custom fields with a live session the crypto host has ended", async () => {
    const h = harness();
    await accepted(h);
    h.opened.clear();
    const result = await h.manager.accept({
      ...candidate("preserve"),
      compareCustomFields: [itemId],
    });
    expect(result.ok && result.data.sameCustomFields).toEqual([]);
    expect(h.host.customFieldDigests).not.toHaveBeenCalled();
  });
}
