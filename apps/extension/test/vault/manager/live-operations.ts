import { expect, it, vi } from "vitest";
import type { LocalVaultHandle } from "../../../src/vault/manager";
import { vaultFailure } from "../../../src/vault/record";
import { disabledEntry } from "../../../src/vault/__fixtures__/vault";
import type { VaultManagerTestContext } from "./context";

export function registerLiveOperationAuthorityCases({
  harness,
  accepted,
  gate,
  operation,
}: Pick<VaultManagerTestContext, "harness" | "accepted" | "gate" | "operation">) {
  it("returns the exact host result from the captured session and forwards its signal", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    const signal = new AbortController().signal;
    h.store.read.mockClear();
    const result = await operation.invoke(h, handle, signal);
    const host = h.host[operation.name];
    const reply = await host.mock.results[0]!.value;
    expect(reply).toMatchObject({ ok: true });
    expect(result).toBe(reply);
    const opened = await h.host.open.mock.results[0]!.value;
    if (!opened.ok) throw new Error("Synthetic host did not open");
    expect(host).toHaveBeenCalledExactlyOnceWith(opened.data.session, ...operation.args(), signal);
    expect(h.store.read).toHaveBeenCalledTimes(2);
    expect(h.manager.status().ready).toBe(true);
  });

  it("rejects a changed handle before storage or host access", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    h.store.read.mockClear();
    expect(await operation.invoke(h, { ...handle, handleId: crypto.randomUUID() })).toEqual(
      vaultFailure("stale-vault-handle"),
    );
    expect(h.store.read).not.toHaveBeenCalled();
    expect(h.host[operation.name]).not.toHaveBeenCalled();
  });

  it("rejects an uncloneable handle before storage or host access", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    h.store.read.mockClear();
    expect(await operation.invoke(h, { ...handle, extra: () => {} } as LocalVaultHandle)).toEqual(
      vaultFailure("invalid-request"),
    );
    expect(h.store.read).not.toHaveBeenCalled();
    expect(h.host[operation.name]).not.toHaveBeenCalled();
  });

  it("fences an unreadable durable record before host access", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
    expect(await operation.invoke(h, handle)).toEqual(vaultFailure("storage-uncertain"));
    expect(h.host[operation.name]).not.toHaveBeenCalled();
    expect(h.manager.status().ready).toBe(false);
    expect(h.opened.size).toBe(0);
  });

  it("denies an externally disabled durable record before host access", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    h.setEntry(disabledEntry());
    expect(await operation.invoke(h, handle)).toEqual(vaultFailure("stale-vault-handle"));
    expect(h.host[operation.name]).not.toHaveBeenCalled();
    expect(h.manager.status().ready).toBe(false);
    expect(h.opened.size).toBe(0);
  });

  it("withholds host access when a lock overtakes the durable preflight", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    const held = gate();
    const entered = gate();
    const durable = h.entry();
    h.store.read.mockImplementationOnce(async () => {
      entered.release();
      await held.promise;
      return { ok: true, data: durable };
    });
    const pending = operation.invoke(h, handle);
    try {
      await entered.promise;
      await h.manager.lock();
    } finally {
      held.release();
    }
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    expect(h.host[operation.name]).not.toHaveBeenCalled();
    expect(h.opened.size).toBe(0);
  });

  it("detaches the handle before a slow durable preflight", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    const supplied = { ...handle };
    const durable = h.entry();
    const held = gate();
    const entered = gate();
    h.store.read.mockImplementationOnce(async () => {
      entered.release();
      await held.promise;
      return { ok: true, data: durable };
    });
    const pending = operation.invoke(h, supplied);
    try {
      await entered.promise;
      supplied.handleId = crypto.randomUUID();
      supplied.snapshotId = crypto.randomUUID();
    } finally {
      held.release();
    }
    expect(await pending).toMatchObject({ ok: true });
    expect(h.host[operation.name].mock.calls[0]?.[0].snapshotId).toBe(handle.snapshotId);
    expect(h.manager.status().ready).toBe(true);
  });

  it("withholds a successful late host reply after lock", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    const held = gate();
    operation.hold(h, held);
    const pending = operation.invoke(h, handle);
    try {
      await vi.waitFor(() => expect(h.host[operation.name]).toHaveBeenCalledOnce());
      await h.manager.lock();
    } finally {
      held.release();
    }
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    expect(h.manager.status().ready).toBe(false);
    expect(h.opened.size).toBe(0);
  });

  it("withholds the old owner's reply after replacement and keeps the new owner usable", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    const held = gate();
    operation.hold(h, held);
    const pending = operation.invoke(h, handle);
    let next: Awaited<ReturnType<typeof accepted>> | undefined;
    try {
      await vi.waitFor(() => expect(h.host[operation.name]).toHaveBeenCalledOnce());
      next = await accepted(h);
    } finally {
      held.release();
    }
    expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
    if (!next) throw new Error("Synthetic replacement failed");
    expect(await operation.invoke(h, next.handle)).toMatchObject({ ok: true });
    expect(h.manager.status().ready).toBe(true);
    expect(h.opened.size).toBe(1);
  });

  it.each(["reported", "thrown"])(
    "gives a %s durable postflight failure precedence over the host's error",
    async (kind) => {
      const h = harness();
      const { handle } = await accepted(h);
      h.host[operation.name].mockResolvedValueOnce({
        ok: false,
        error: { code: "field-missing" },
      });
      h.store.read.mockResolvedValueOnce({ ok: true, data: h.entry() });
      if (kind === "reported") h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
      else h.store.read.mockRejectedValueOnce(new Error("Synthetic durable read failed"));
      expect(await operation.invoke(h, handle)).toEqual(vaultFailure("storage-uncertain"));
      expect(h.host[operation.name]).toHaveBeenCalledOnce();
      expect(h.manager.status().ready).toBe(false);
      expect(h.opened.size).toBe(0);
    },
  );

  it("propagates a thrown host exception without turning it into a durable failure", async () => {
    const h = harness();
    const { handle } = await accepted(h);
    const fault = new Error("Synthetic host exception");
    h.host[operation.name].mockRejectedValueOnce(fault);
    h.store.read.mockClear();
    await expect(operation.invoke(h, handle)).rejects.toBe(fault);
    expect(h.store.read).toHaveBeenCalledOnce();
    expect(h.manager.status().ready).toBe(true);
    expect(h.opened.size).toBe(1);
  });
}

export function registerMutableArgumentCases({
  harness,
  accepted,
  gate,
  itemId,
  signingInput,
}: Pick<VaultManagerTestContext, "harness" | "accepted" | "gate" | "itemId" | "signingInput">) {
  it.each(["loginUsernames", "signPasskey"] as const)(
    "%s detaches its mutable arguments before a slow durable preflight",
    async (name) => {
      const h = harness();
      const { handle } = await accepted(h);
      const ids = [itemId];
      const input = signingInput();
      const durable = h.entry();
      const held = gate();
      const entered = gate();
      h.store.read.mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
        return { ok: true, data: durable };
      });
      const pending =
        name === "loginUsernames"
          ? h.manager.loginUsernames(handle, ids)
          : h.manager.signPasskey(handle, input);
      try {
        await entered.promise;
        ids[0] = crypto.randomUUID();
        input.itemId = crypto.randomUUID();
        input.credentialId = "changed-credential";
        input.rpId = "changed.example";
      } finally {
        held.release();
      }
      expect(await pending).toMatchObject({ ok: true });
      expect(h.host[name].mock.calls[0]?.[1]).toEqual(
        name === "loginUsernames" ? [itemId] : signingInput(),
      );
      expect(h.host[name].mock.calls[0]?.[1]).not.toBe(name === "loginUsernames" ? ids : input);
    },
  );
}

export function registerInvalidInputCases({
  harness,
  accepted,
  invalid,
}: Pick<VaultManagerTestContext, "harness" | "accepted" | "invalid">) {
  it.each(invalid)(
    "$name validates its own input before durable or host access",
    async (operation) => {
      const h = harness();
      const { handle } = await accepted(h);
      h.store.read.mockClear();
      expect(await operation.invoke(h, handle)).toEqual(vaultFailure(operation.code));
      expect(h.store.read).not.toHaveBeenCalled();
      expect(h.host[operation.name]).not.toHaveBeenCalled();
      expect(h.manager.status().ready).toBe(true);
    },
  );
}
