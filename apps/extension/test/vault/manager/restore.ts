import { expect, it } from "vitest";
import { createLocalVaultManager } from "../../../src/vault/manager";
import { vaultFailure } from "../../../src/vault/record";
import { accountProfile } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { activeEntry, snapshotId } from "../../../src/vault/__fixtures__/vault";
import type { VaultManagerTestContext } from "./context";

export function registerRestoreCases({
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
  it("passes a code grant to the host without the snapshot ID", async () => {
    const h = harness();
    const current = await accepted(h);
    const listed = await h.manager.listFields(current.handle, itemId);
    if (!listed.ok) throw new Error("Synthetic field listing failed");
    const otp = { kind: "otp" as const, value: "654321", period: 30, validUntilMs: 60_000 };
    h.host.resolveField.mockImplementationOnce(async () => ({ ok: true, data: otp }));
    expect(
      await h.manager.resolveField(current.handle, listed.data[0]!.ref, {
        snapshotId: current.handle.snapshotId,
        allowedFieldIds: ["login.password"],
        code: true,
      }),
    ).toEqual({ ok: true, data: otp });
    expect(h.host.resolveField.mock.calls[0]![2]).toEqual({
      allowedFieldIds: ["login.password"],
      code: true,
    });
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
}
