import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalVaultHandle } from "./manager";
import { vaultFailure } from "./record";
import type { HostSessionRef } from "../crypto/wire";
import { disabledEntry, snapshotId } from "./__fixtures__/vault";
import { accepted, gate, harness, itemId, managers } from "../../test/vault-manager/harness";

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
});

describe("SSO metadata operations preserve durable live-vault authority", () => {
  const sourceInput = { itemId, allowedFieldIds: ["login.username"] };
  const candidateInput = { usernameProof: "P".repeat(43), candidates: [sourceInput] };
  function ssoHarness(kind: "ssoMethods" | "ssoCandidates") {
    const h = harness();
    const data =
      kind === "ssoMethods"
        ? {
            itemId,
            snapshotId,
            sourceEvidence: "E".repeat(43),
            result: { status: "ready", methods: [] },
          }
        : { snapshotId, candidates: [] };
    const host = vi.fn(
      async (_session: HostSessionRef, _input: unknown, _signal?: AbortSignal) => ({
        ok: true as const,
        data,
      }),
    );
    Object.assign(h.host, { [kind]: host });
    const input = kind === "ssoMethods" ? sourceInput : candidateInput;
    const invoke = (handle: LocalVaultHandle, signal?: AbortSignal) =>
      kind === "ssoMethods"
        ? h.manager.ssoMethods(handle, sourceInput, signal)
        : h.manager.ssoCandidates(handle, candidateInput, signal);
    return { ...h, invoke, native: host, input };
  }
  describe.each(["ssoMethods", "ssoCandidates"] as const)("%s", (kind) => {
    it("checks durable authority before and after its exact host request without writing storage", async () => {
      const h = ssoHarness(kind);
      const { handle } = await accepted(h);
      h.store.read.mockClear();
      h.store.compareAndSwap.mockClear();
      h.sessionKey.write.mockClear();
      const answer = await h.invoke(handle);
      const opened = await h.host.open.mock.results[0]!.value;
      if (!opened.ok) throw new Error("Synthetic host did not open");
      expect(h.native).toHaveBeenCalledExactlyOnceWith(opened.data.session, h.input, undefined);
      expect(answer).toBe(await h.native.mock.results[0]!.value);
      expect(h.store.read).toHaveBeenCalledTimes(2);
      expect(h.store.compareAndSwap).not.toHaveBeenCalled();
      expect(h.sessionKey.write).not.toHaveBeenCalled();
    });
    it("passes the caller's abort signal to its host request", async () => {
      const h = ssoHarness(kind);
      const { handle } = await accepted(h);
      const controller = new AbortController();
      expect(await h.invoke(handle, controller.signal)).toMatchObject({ ok: true });
      expect(h.native.mock.calls[0]?.[2]).toBe(controller.signal);
    });
    it("rejects a stale or uncloneable handle before host or storage access", async () => {
      const h = ssoHarness(kind);
      const { handle } = await accepted(h);
      h.store.read.mockClear();
      expect(await h.invoke({ ...handle, snapshotId: crypto.randomUUID() })).toEqual(
        vaultFailure("stale-vault-handle"),
      );
      expect(await h.invoke({ ...handle, extra: () => {} } as LocalVaultHandle)).toEqual(
        vaultFailure("invalid-request"),
      );
      expect(h.store.read).not.toHaveBeenCalled();
      expect(h.native).not.toHaveBeenCalled();
    });
    it.each(["disabled", "removed", "unreadable"])(
      "refuses a durable record %s before decryption",
      async (change) => {
        const h = ssoHarness(kind);
        const { handle } = await accepted(h);
        if (change === "disabled") h.setEntry(disabledEntry());
        if (change === "removed") h.setEntry(null);
        if (change === "unreadable")
          h.store.read.mockResolvedValueOnce(vaultFailure("storage-failed"));
        expect(await h.invoke(handle)).toEqual(
          vaultFailure(change === "unreadable" ? "storage-uncertain" : "stale-vault-handle"),
        );
        expect(h.native).not.toHaveBeenCalled();
        expect(h.manager.status().ready).toBe(false);
        expect(h.opened.size).toBe(0);
      },
    );
    it.each(["lock", "replace", "durable-disable"])(
      "withholds a successful result overtaken by %s",
      async (change) => {
        const h = ssoHarness(kind);
        const { handle } = await accepted(h);
        const entered = gate();
        const held = gate();
        h.native.mockImplementationOnce(async () => {
          entered.release();
          await held.promise;
          return {
            ok: true,
            data:
              kind === "ssoMethods"
                ? {
                    itemId,
                    snapshotId,
                    sourceEvidence: "E".repeat(43),
                    result: { status: "ready", methods: [] },
                  }
                : { snapshotId, candidates: [] },
          };
        });
        const pending = h.invoke(handle);
        try {
          await entered.promise;
          if (change === "lock") await h.manager.lock();
          if (change === "replace") await accepted(h);
          if (change === "durable-disable") h.setEntry(disabledEntry());
        } finally {
          held.release();
        }
        expect(await pending).toEqual(vaultFailure("stale-vault-handle"));
        expect(h.manager.status().ready).toBe(change === "replace");
        expect(h.opened.size).toBe(change === "replace" ? 1 : 0);
      },
    );
    it("detaches mutable nested inputs before a slow durable preflight", async () => {
      const h = ssoHarness(kind);
      const { handle } = await accepted(h);
      const durable = h.entry();
      const supplied = structuredClone(h.input);
      const original = structuredClone(supplied);
      const entered = gate();
      const held = gate();
      h.store.read.mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
        return { ok: true, data: durable };
      });
      const pending =
        kind === "ssoMethods"
          ? h.manager.ssoMethods(handle, supplied as typeof sourceInput)
          : h.manager.ssoCandidates(handle, supplied as typeof candidateInput);
      try {
        await entered.promise;
        if ("allowedFieldIds" in supplied) supplied.allowedFieldIds.push("login.password");
        if ("candidates" in supplied) {
          supplied.usernameProof = "X".repeat(43);
          supplied.candidates[0]!.allowedFieldIds.push("login.password");
        }
      } finally {
        held.release();
      }
      expect(await pending).toMatchObject({ ok: true });
      expect(h.native.mock.calls[0]?.[1]).toEqual(original);
    });
    it("gives a durable postflight failure precedence over a successful host result", async () => {
      const h = ssoHarness(kind);
      const { handle } = await accepted(h);
      h.store.read.mockResolvedValueOnce({ ok: true, data: h.entry() });
      h.store.read.mockRejectedValueOnce(new Error("Synthetic durable storage failure"));
      expect(await h.invoke(handle)).toEqual(vaultFailure("storage-uncertain"));
      expect(h.native).toHaveBeenCalledOnce();
      expect(h.manager.status().ready).toBe(false);
      expect(h.opened.size).toBe(0);
    });
  });
});
