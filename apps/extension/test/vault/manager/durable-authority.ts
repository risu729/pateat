import { expect, it, vi } from "vitest";
import { createLocalVaultManager } from "../../../src/vault/manager";
import { vaultFailure } from "../../../src/vault/record";
import { accountProfile } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { activeEntry } from "../../../src/vault/__fixtures__/vault";
import type { VaultManagerTestContext } from "./context";

export function registerDurableAuthorityCases({
  harness,
  accepted,
  gate,
  itemId,
  managers,
}: Pick<VaultManagerTestContext, "harness" | "accepted" | "gate" | "itemId" | "managers">) {
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
  it("lists login usernames only through the current live snapshot and withholds a late result", async () => {
    const h = harness();
    const current = await accepted(h);
    expect(await h.manager.loginUsernames(current.handle, [itemId])).toEqual({
      ok: true,
      data: { usernames: { [itemId]: "alice@example.test" } },
    });
    expect(h.host.loginUsernames.mock.calls[0]?.[0].snapshotId).toBe(current.handle.snapshotId);
    expect(h.host.loginUsernames.mock.calls[0]?.[1]).toEqual([itemId]);
    const held = gate();
    h.host.loginUsernames.mockImplementationOnce(async () => {
      await held.promise;
      return { ok: true, data: { usernames: { [itemId]: "late@example.test" } } };
    });
    const pending = h.manager.loginUsernames(current.handle, [itemId]);
    await vi.waitFor(() => expect(h.host.loginUsernames).toHaveBeenCalledTimes(2));
    await h.manager.disableAutoUnlock();
    held.release();
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    expect(await h.manager.loginUsernames(current.handle, [itemId])).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(h.host.loginUsernames).toHaveBeenCalledTimes(2);
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
  it("lists an item's passkey RP IDs only through the current live snapshot (ADR 0084)", async () => {
    const h = harness();
    const current = await accepted(h);
    expect(await h.manager.passkeyRpIds(current.handle, itemId)).toMatchObject({
      ok: true,
      data: { snapshotId: current.handle.snapshotId, itemId, rpIds: ["example.com"] },
    });
    expect(h.host.passkeyRpIds.mock.calls[0]?.[1]).toBe(itemId);
    expect(await h.manager.passkeyRpIds(current.handle, 1 as unknown as string)).toEqual(
      vaultFailure("invalid-request"),
    );
    await h.manager.disableAutoUnlock();
    expect(await h.manager.passkeyRpIds(current.handle, itemId)).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(h.host.passkeyRpIds).toHaveBeenCalledTimes(1);
  });
  it("checks a master password only through the current live session", async () => {
    const h = harness();
    const current = await accepted(h);
    expect(
      await h.manager.verifyMasterPassword(current.handle, "synthetic-master-password"),
    ).toEqual({ ok: true, data: { matches: true } });
    expect(await h.manager.verifyMasterPassword(current.handle, "synthetic-guess")).toEqual({
      ok: true,
      data: { matches: false },
    });
    expect(h.host.verifyMasterPassword.mock.calls[0]?.[0].snapshotId).toBe(
      current.handle.snapshotId,
    );
    expect(await h.manager.verifyMasterPassword(current.handle, "")).toEqual(
      vaultFailure("invalid-request"),
    );
    expect(h.host.verifyMasterPassword).toHaveBeenCalledTimes(2);
    const held = gate();
    h.host.verifyMasterPassword.mockImplementationOnce(async () => {
      await held.promise;
      return { ok: true, data: { matches: true } };
    });
    const pending = h.manager.verifyMasterPassword(current.handle, "synthetic-master-password");
    await vi.waitFor(() => expect(h.host.verifyMasterPassword).toHaveBeenCalledTimes(3));
    await h.manager.disableAutoUnlock();
    held.release();
    // A check that finished after the session ended does not count as verified.
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    expect(
      await h.manager.verifyMasterPassword(current.handle, "synthetic-master-password"),
    ).toEqual(vaultFailure("stale-vault-handle"));
    expect(h.host.verifyMasterPassword).toHaveBeenCalledTimes(3);
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
  it("resolves several fields with one durable check before and one after", async () => {
    const h = harness();
    const current = await accepted(h);
    const listed = await h.manager.listFields(current.handle, itemId);
    if (!listed.ok) throw new Error("Synthetic listing failed");
    const ref = listed.data[0]!.ref;
    const grant = { snapshotId: current.handle.snapshotId, allowedFieldIds: ["login.password"] };
    h.store.read.mockClear();
    const results = await h.manager.resolveFields(current.handle, [
      { ref, grant },
      { ref, grant: { ...grant, snapshotId: crypto.randomUUID() } },
      { ref, grant },
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
    expect(results[1]).toEqual(vaultFailure("stale-field-reference"));
    // The field with another snapshot never reaches the host.
    expect(h.host.resolveField).toHaveBeenCalledTimes(2);
    expect(h.store.read).toHaveBeenCalledTimes(2);
  });
  it("withholds every field of a batch once an external writer replaces the accepted revision", async () => {
    const h = harness();
    const current = await accepted(h);
    const listed = await h.manager.listFields(current.handle, itemId);
    if (!listed.ok) throw new Error("Synthetic listing failed");
    const ref = listed.data[0]!.ref;
    const grant = { snapshotId: current.handle.snapshotId, allowedFieldIds: ["login.password"] };
    const held = gate();
    h.host.resolveField.mockImplementationOnce(async () => {
      await held.promise;
      return { ok: true, data: { kind: "text", value: "synthetic-late-password" } };
    });
    const pending = h.manager.resolveFields(current.handle, [
      { ref, grant },
      { ref, grant },
    ]);
    await vi.waitFor(() => expect(h.host.resolveField).toHaveBeenCalledTimes(1));
    const replaced = h.entry()!;
    replaced.revision = crypto.randomUUID();
    h.setEntry(replaced);
    held.release();
    expect(await pending).toEqual([
      vaultFailure("stale-vault-handle"),
      vaultFailure("stale-vault-handle"),
    ]);
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
}
