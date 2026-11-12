import { expect, it } from "vitest";
import { createLocalVaultManager } from "../../../src/vault/manager";
import { vaultFailure } from "../../../src/vault/record";
import { accountProfile } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import type { VaultManagerTestContext } from "./context";

export function registerComparisonCases({
  harness,
  accepted,
  itemId,
  compare,
  managers,
}: Pick<VaultManagerTestContext, "harness" | "accepted" | "itemId" | "compare" | "managers">) {
  it("reports items whose digests are equal in the live and candidate sessions before the write", async () => {
    const h = harness();
    const old = await accepted(h);
    expect(old.sameCustomFields).toEqual([]);
    expect(h.host.customFieldDigests).not.toHaveBeenCalled();
    h.events.length = 0;
    const other = crypto.randomUUID();
    const result = await h.manager.accept(compare([itemId, other, "not-a-uuid", itemId]));
    expect(result.ok && result.data.sameCustomFields).toEqual([itemId]);
    expect(result.ok && result.data.comparedSnapshotId).toBe(old.handle.snapshotId);
    expect(h.events).toEqual([
      "open",
      "verify-all",
      "export",
      "digest",
      "digest",
      "commit",
      "lock",
    ]);
    const sessions = h.host.customFieldDigests.mock.calls.map(([session, ids]) => {
      expect(ids).toEqual([itemId, other]);
      return session.snapshotId;
    });
    expect(sessions).toEqual([old.handle.snapshotId, result.ok && result.data.handle.snapshotId]);
    // The live session is not tied to the sync's cancellation.
    expect(h.host.customFieldDigests.mock.calls[0]![2]).toBeUndefined();
  });
  it.each(["different", "missing", "live-rejected", "live-thrown"] as const)(
    "accepts without reporting the item when the digests are %s",
    async (mode) => {
      const h = harness();
      await accepted(h);
      if (mode === "different")
        h.host.customFieldDigests.mockImplementationOnce(async (_session, ids) => ({
          ok: true,
          data: { digests: Object.fromEntries(ids.map((id) => [id, "B".repeat(43)])) },
        }));
      else if (mode === "missing")
        h.host.customFieldDigests.mockResolvedValue({
          ok: true,
          data: { digests: { [itemId]: null } },
        });
      else if (mode === "live-rejected")
        h.host.customFieldDigests.mockResolvedValueOnce({
          ok: false,
          error: { code: "crypto-locked" },
        });
      else h.host.customFieldDigests.mockRejectedValueOnce(new Error("synthetic"));
      const result = await h.manager.accept(compare());
      expect(result.ok && result.data.sameCustomFields).toEqual([]);
      expect(h.manager.status().ready).toBe(true);
    },
  );
  it("forgets the live session at once when its digest request ended it", async () => {
    const h = harness();
    await accepted(h);
    h.events.length = 0;
    h.host.customFieldDigests.mockResolvedValueOnce({ ok: false, error: { code: "timeout" } });
    const result = await h.manager.accept(compare());
    expect(result.ok && result.data.sameCustomFields).toEqual([]);
    expect(result.ok && result.data.comparedSnapshotId).toBeUndefined();
    expect(h.events.indexOf("lock")).toBeLessThan(h.events.indexOf("commit"));
  });
  it("leaves no live session when the write fails after the live digest ended it", async () => {
    const h = harness();
    const old = await accepted(h);
    h.host.customFieldDigests.mockResolvedValueOnce({ ok: false, error: { code: "timeout" } });
    h.store.compareAndSwap.mockResolvedValueOnce({
      ok: false,
      error: { code: "cache-quota-exceeded" },
    });
    expect((await h.manager.accept(compare())).ok).toBe(false);
    expect(h.manager.status().ready).toBe(false);
    expect((await h.manager.listFields(old.handle, itemId)).ok).toBe(false);
  });
  it.each(["timeout", "crypto-locked", "thrown"] as const)(
    "fails before the write and keeps the live snapshot when the candidate digest %s",
    async (mode) => {
      const h = harness();
      const old = await accepted(h);
      const durable = h.entry();
      h.events.length = 0;
      h.host.customFieldDigests.mockImplementation(async (session, ids) => {
        if (session.snapshotId !== old.handle.snapshotId) {
          if (mode === "thrown") throw new Error("synthetic");
          return { ok: false, error: { code: mode } };
        }
        return {
          ok: true,
          data: { digests: Object.fromEntries(ids.map((id) => [id, "A".repeat(43)])) },
        };
      });
      expect(await h.manager.accept(compare())).toEqual(vaultFailure("crypto-failed"));
      expect(h.events).not.toContain("commit");
      expect(h.entry()).toEqual(durable);
      expect(h.manager.status().ready).toBe(true);
      expect((await h.manager.listFields(old.handle, itemId)).ok).toBe(true);
      // The candidate was retired; only the live session stays open.
      expect(h.opened.size).toBe(1);
      // The next sync skips the comparison so a repeating failure cannot block it.
      h.host.customFieldDigests.mockClear();
      // A skipping sync that does not commit leaves the skip for the next one.
      h.store.compareAndSwap.mockResolvedValueOnce({
        ok: false,
        error: { code: "cache-quota-exceeded" },
      });
      expect((await h.manager.accept(compare())).ok).toBe(false);
      const next = await h.manager.accept(compare());
      expect(next.ok && next.data.sameCustomFields).toEqual([]);
      expect(h.host.customFieldDigests).not.toHaveBeenCalled();
      // Comparing resumes once a skipping sync has committed.
      h.host.customFieldDigests.mockImplementation(async (_session, ids) => ({
        ok: true,
        data: { digests: Object.fromEntries(ids.map((id) => [id, "A".repeat(43)])) },
      }));
      const later = await h.manager.accept(compare());
      expect(later.ok && later.data.sameCustomFields).toEqual([itemId]);
    },
  );
  it("commits without reporting the item when the candidate digest fails without ending it", async () => {
    const h = harness();
    const old = await accepted(h);
    h.host.customFieldDigests.mockImplementation(async (session, ids) =>
      session.snapshotId === old.handle.snapshotId
        ? {
            ok: true,
            data: { digests: Object.fromEntries(ids.map((id) => [id, "A".repeat(43)])) },
          }
        : { ok: false, error: { code: "resource-limit" } },
    );
    const result = await h.manager.accept(compare());
    expect(result.ok && result.data.sameCustomFields).toEqual([]);
    expect(h.manager.status().ready).toBe(true);
  });
  it("fails before the write and forgets the live session when both digests ended them", async () => {
    const h = harness();
    const old = await accepted(h);
    const durable = h.entry();
    h.events.length = 0;
    h.host.customFieldDigests.mockResolvedValue({ ok: false, error: { code: "crypto-failed" } });
    expect(await h.manager.accept(compare())).toEqual(vaultFailure("crypto-failed"));
    expect(h.events).not.toContain("commit");
    expect(h.entry()).toEqual(durable);
    expect(h.manager.status().ready).toBe(false);
    expect((await h.manager.listFields(old.handle, itemId)).ok).toBe(false);
    expect(h.opened.size).toBe(0);
  });
  it("compares nothing without an open session for the record being replaced", async () => {
    const h = harness();
    await accepted(h);
    const fresh = createLocalVaultManager({
      profile: accountProfile,
      host: h.host,
      store: h.store,
    });
    managers.push(fresh);
    const result = await fresh.accept(compare());
    expect(result.ok && result.data.sameCustomFields).toEqual([]);
    expect(h.host.customFieldDigests).not.toHaveBeenCalled();
  });
}
