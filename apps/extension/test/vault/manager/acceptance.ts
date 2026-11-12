import { expect, it, vi } from "vitest";
import { vaultFailure } from "../../../src/vault/record";
import { v1Password } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import { preparedVault } from "../../../../../packages/bitwarden/src/__fixtures__/unlock";
import type { VaultManagerTestContext } from "./context";

export function registerAcceptanceCases({
  harness,
  candidate,
  accepted,
  gate,
  itemId,
}: Pick<VaultManagerTestContext, "harness" | "candidate" | "accepted" | "gate" | "itemId">) {
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
  it("accepts a snapshot without the items strict decryption refused, and lists them", async () => {
    const h = harness();
    const prepared = preparedVault();
    const refusedId = String(prepared.ciphers[0]!.id);
    const unusable = { itemId: refusedId.toUpperCase(), check: "sdk-decrypt" as const };
    h.host.verifyReceivedCiphers.mockResolvedValue({
      ok: true,
      data: {
        verifiedCipherCount: prepared.ciphers.length - 1,
        unusableItems: [unusable],
        partialItems: [],
      },
    });
    const result = await h.manager.accept(candidate());
    expect(result.ok).toBe(true);
    expect(h.store.compareAndSwap).toHaveBeenCalled();
    expect(h.manager.status()).toMatchObject({
      ready: true,
      unusableItems: [unusable],
      partialItems: [],
    });
  });
  it("lists the items used without some fields, and refuses one also named unusable", async () => {
    const h = harness();
    const prepared = preparedVault();
    const partialId = String(prepared.ciphers[0]!.id);
    const partial = { itemId: partialId, fields: ["login.password"] };
    h.host.verifyReceivedCiphers.mockResolvedValue({
      ok: true,
      data: {
        verifiedCipherCount: prepared.ciphers.length,
        unusableItems: [],
        partialItems: [partial],
      },
    });
    expect((await h.manager.accept(candidate())).ok).toBe(true);
    expect(h.manager.status()).toMatchObject({ ready: true, partialItems: [partial] });
    const other = harness();
    other.host.verifyReceivedCiphers.mockResolvedValue({
      ok: true,
      data: {
        verifiedCipherCount: prepared.ciphers.length - 1,
        unusableItems: [{ itemId: partialId, check: "sdk-decrypt" }],
        partialItems: [partial],
      },
    });
    expect(await other.manager.accept(candidate())).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "cipher-count" },
    });
  });
  it("lists the items the account mapper left out beside those decryption refused", async () => {
    const h = harness();
    const input = candidate();
    const missingKey = "00000000-0000-4000-8000-0000000000a1";
    const malformed = "00000000-0000-4000-8000-0000000000a2";
    input.prepared.unavailableItems.push(
      { itemId: missingKey, reason: "unknown-organization" },
      { itemId: "00000000-0000-4000-8000-0000000000a3", reason: "unsupported-cipher-type" },
      { itemId: malformed, reason: "malformed-item" },
    );
    const refused = {
      itemId: String(input.prepared.ciphers[0]!.id),
      check: "sdk-decrypt" as const,
    };
    h.host.verifyReceivedCiphers.mockResolvedValue({
      ok: true,
      data: {
        verifiedCipherCount: input.prepared.ciphers.length - 1,
        unusableItems: [refused],
        partialItems: [],
      },
    });
    expect((await h.manager.accept(input)).ok).toBe(true);
    // An item type Pateat does not read is not listed as something to fix in Bitwarden.
    expect(h.manager.status().unusableItems).toEqual([
      { itemId: missingKey, check: "unknown-organization" },
      { itemId: malformed, check: "malformed-item" },
      refused,
    ]);
  });
  it.each([
    ["one more than received", (id: string) => [id, "00000000-0000-4000-8000-0000000000ff"]],
    ["named twice", (id: string) => [id, id.toUpperCase()]],
    ["not received", () => ["00000000-0000-4000-8000-0000000000ff"]],
  ])("refuses unusable items %s", async (_label, ids) => {
    const h = harness();
    const prepared = preparedVault();
    const unusableItems = ids(String(prepared.ciphers[0]!.id)).map((id) => ({ itemId: id }));
    h.host.verifyReceivedCiphers.mockResolvedValue({
      ok: true,
      data: {
        verifiedCipherCount: Math.max(0, prepared.ciphers.length - unusableItems.length),
        unusableItems,
        partialItems: [],
      },
    });
    expect(await h.manager.accept(candidate())).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "cipher-count" },
    });
    expect(h.store.compareAndSwap).not.toHaveBeenCalled();
  });
  it.each(["rejected", "short-count"])(
    "rejects %s full-cipher verification without export or storage",
    async (mode) => {
      const h = harness();
      // A refused item's check, ID and revision date pass through for the diagnostic log.
      const refused = {
        code: "crypto-failed" as const,
        check: "attachment" as const,
        item: "00000000-0000-4000-8000-000000000002",
        revised: 1_762_720_517_000,
      };
      h.host.verifyReceivedCiphers.mockResolvedValue(
        mode === "rejected"
          ? { ok: false, error: refused }
          : { ok: true, data: { verifiedCipherCount: 0, unusableItems: [], partialItems: [] } },
      );
      expect(await h.manager.accept(candidate())).toEqual({
        ok: false,
        error: mode === "rejected" ? refused : { code: "crypto-failed", check: "cipher-count" },
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
  it("keeps an accept whose written record a request on the old handle reads", async () => {
    const held = gate();
    let hold = false;
    const h = harness({
      checkpoint: async (stage) => {
        if (hold && stage === "after-write") await held.promise;
      },
    });
    const old = await accepted(h);
    hold = true;
    h.host.matchUris.mockClear();
    const pending = h.manager.accept(candidate("preserve"));
    await vi.waitFor(() => expect(h.store.compareAndSwap).toHaveBeenCalledTimes(2));
    // A page or settings request still holding the replaced handle reads the new record.
    expect(await h.manager.matchUris(old.handle, "https://example.com/login")).toEqual({
      ok: false,
      error: { code: "stale-vault-handle" },
    });
    expect(h.host.matchUris).not.toHaveBeenCalled();
    held.release();
    const next = await pending;
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("Synthetic unit accept failed");
    expect(h.manager.status()).toMatchObject({ ready: true, storageUncertain: false });
    expect((await h.manager.matchUris(next.data.handle, "https://example.com/login")).ok).toBe(
      true,
    );
  });
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
    // A failed write that leaves another record behind locks both sessions.
    h.store.compareAndSwap.mockImplementationOnce(async (_expected, next) => {
      h.setEntry(next);
      return vaultFailure("cache-quota-exceeded");
    });
    expect(await h.manager.accept(candidate("preserve"))).toEqual(
      vaultFailure("cache-quota-exceeded"),
    );
    expect(h.opened.size).toBe(0);
    expect(h.manager.status()).toMatchObject({ ready: false, storageUncertain: true });
    expect((await h.manager.listFields(old.handle, itemId)).ok).toBe(false);
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
}
