import { expect, it, vi } from "vitest";
import { parseSetupReply } from "../../../src/connections/wire";
import {
  accountNow,
  accountProfile,
} from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { rawCustomAccount } from "../../../../../packages/bitwarden/src/__fixtures__/connection";
import { v1Password } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import type { SetupTestContext } from "./context";

export function registerRefreshCases({
  authenticationHash,
  gate,
  newInput,
  harness,
  noSecrets,
  closers,
}: Pick<
  SetupTestContext,
  "authenticationHash" | "gate" | "newInput" | "harness" | "noSecrets" | "closers"
>) {
  it("withholds an uncertain initial commit after caller disposal without blindly disabling its unknown durable revision", async () => {
    const h = harness();
    const held = gate();
    const commit = h.manager.accept.getMockImplementation()!;
    h.manager.accept.mockImplementationOnce(async (input) => {
      await commit(input);
      await held.promise;
      return { ok: false, error: { code: "storage-uncertain" } };
    });
    const pending = h.caller.begin(newInput());
    await vi.waitFor(() => expect(h.durable()?.state).toBe("active"));
    const written = h.durable();
    h.caller.dispose();
    held.release();
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.policy.adopt).not.toHaveBeenCalled();
    expect(h.durable()).toEqual(written);
    const caller = h.service.createCaller();
    closers.push(() => caller.dispose());
    if (!written) throw new Error("Synthetic uncertain commit failed");
    expect(await caller.sync(written.profile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    const status = await caller.status();
    expect(status).toMatchObject({
      ok: true,
      kind: "status",
      connections: [{ connectionId: written.profile.connectionId, autoUnlock: "enabled" }],
    });
    noSecrets(status);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it("native permission removal cancels a held derivation and withholds its late result without disabling the old cache", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    const held = gate();
    h.host.deriveAuthentication.mockImplementationOnce(async () => {
      await held.promise;
      return {
        ok: true,
        data: { connectionId: accountProfile.connectionId, masterPasswordHash: authenticationHash },
      };
    });
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    await vi.waitFor(() => expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1));
    h.service.permissionsRemoved();
    expect(h.host.deriveAuthentication.mock.calls[0]?.[1]?.aborted).toBe(true);
    held.release();
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.durable()).toEqual(previous);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("status reads only local metadata and never attempts provider authentication or sync", async () => {
    const h = harness({ existing: true });
    const result = await h.caller.status();
    expect(result).toMatchObject({ ok: true, kind: "status", connections: [{ state: "ready" }] });
    noSecrets(result);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.host.deriveAuthentication).not.toHaveBeenCalled();
    expect(h.manager.accept).not.toHaveBeenCalled();
  });
  it("status reports the last time the vault was known to match Bitwarden", async () => {
    const h = harness({ existing: true });
    const acceptedAt = h.durable()!.accepted!.acceptedAt;
    const synced = async () => {
      const result = await h.caller.status();
      if (!result.ok || result.kind !== "status") throw new Error("Synthetic status failed");
      return result.connections[0]?.syncedAt;
    };
    expect(await synced()).toBe(acceptedAt);
    // Only a finished check that found no change confirms the open snapshot later.
    await h.revisions.update(accountProfile.connectionId, () => ({
      checkedAt: acceptedAt + 120_000,
      outcome: "failed",
    }));
    expect(await synced()).toBe(acceptedAt);
    await h.revisions.update(accountProfile.connectionId, (entry) => ({
      ...entry,
      unchangedAt: acceptedAt + 60_000,
    }));
    // A time after now (a clock set back) confirms nothing.
    expect(await synced()).toBe(acceptedAt);
    h.advance(120_000);
    expect(await synced()).toBe(acceptedAt + 60_000);
  });
  it("status lists the open vault's unusable items, at most 100, with their count", async () => {
    const h = harness({ existing: true });
    const unusableItems = Array.from({ length: 101 }, (_, index) => ({
      itemId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      check: "sdk-decrypt",
      revised: 1_762_720_517_000,
    }));
    h.manager.status.mockReturnValue({ ready: true, unusableItems } as never);
    const result = await h.caller.status();
    if (!result.ok || result.kind !== "status") throw new Error("Synthetic status failed");
    expect(result.connections[0]).toMatchObject({ state: "ready", unusableItemCount: 101 });
    // The page needs only the ID and check, not the revision date.
    expect(result.connections[0]?.unusableItems).toEqual(
      unusableItems.slice(0, 100).map(({ itemId, check }) => ({ itemId, check })),
    );
    expect(parseSetupReply(result)).toEqual(result);
    h.manager.status.mockReturnValue({ ready: true, unusableItems: [] } as never);
    const none = await h.caller.status();
    expect(none).toMatchObject({ connections: [{ state: "ready" }] });
    if (none.ok && none.kind === "status") {
      expect(none.connections[0]).not.toHaveProperty("unusableItems");
      expect(none.connections[0]).not.toHaveProperty("unusableItemCount");
    }
  });
  it("status lists the items used without some fields, at most 100", async () => {
    const h = harness({ existing: true });
    const partialItems = Array.from({ length: 101 }, (_, index) => ({
      itemId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      fields: ["login.password", "fields.2.value"],
    }));
    h.manager.status.mockReturnValue({ ready: true, partialItems } as never);
    const result = await h.caller.status();
    if (!result.ok || result.kind !== "status") throw new Error("Synthetic status failed");
    expect(result.connections[0]).toMatchObject({ state: "ready", partialItemCount: 101 });
    expect(result.connections[0]?.partialItems).toEqual(partialItems.slice(0, 100));
    expect(parseSetupReply(result)).toEqual(result);
  });
  it("status lists at most 20 fields of an item, with how many more there are", async () => {
    const h = harness({ existing: true });
    const fields = Array.from({ length: 23 }, (_, index) => `fields.${index}.value`);
    const itemId = "00000000-0000-4000-8000-000000000001";
    h.manager.status.mockReturnValue({ ready: true, partialItems: [{ itemId, fields }] } as never);
    const result = await h.caller.status();
    if (!result.ok || result.kind !== "status") throw new Error("Synthetic status failed");
    expect(result.connections[0]?.partialItems).toEqual([
      { itemId, fields: fields.slice(0, 20), moreFieldCount: 3 },
    ]);
    expect(parseSetupReply(result)).toEqual(result);
  });
  it("status reports the last automatic check's failure until a sync applies", async () => {
    const h = harness({ existing: true });
    const failure = async () => {
      const result = await h.caller.status();
      if (!result.ok || result.kind !== "status") throw new Error("Synthetic status failed");
      return result.connections[0]?.syncFailure;
    };
    expect(await failure()).toBeUndefined();
    const item = "7f0c5a3e-2b1d-4c8e-9a6f-3d2e1b0c9a8f";
    await h.revisions.update(accountProfile.connectionId, () => ({
      checkedAt: 1_792_152_000_000,
      outcome: "failed",
      failure: { at: 1_792_152_000_000, cause: "crypto-failed", check: "sdk-decrypt", item },
    }));
    // The refused item stays in the log; the page needs only the code and check.
    expect(await failure()).toEqual({
      at: 1_792_152_000_000,
      code: "crypto-failed",
      check: "sdk-decrypt",
    });
    // A stored value the reply cannot carry leaves the check out, not the whole status.
    await h.revisions.update(accountProfile.connectionId, (entry) => ({
      ...entry,
      failure: { at: 1_792_152_000_000, cause: "crypto-failed", check: "Not_A_Check" },
    }));
    expect(await failure()).toEqual({ at: 1_792_152_000_000, code: "crypto-failed" });
    await h.revisions.update(accountProfile.connectionId, (entry) => ({
      ...entry,
      failure: { at: 1_792_152_000_000, cause: "http-error", status: 503 },
    }));
    expect(await failure()).toEqual({ at: 1_792_152_000_000, code: "http-error" });
    await h.revisions.setRevision(accountProfile.connectionId, 1_792_152_060_000);
    expect(await failure()).toBeUndefined();
  });
  it("sync refreshes expired authorization, uses its new bearer, and keeps the rotated refresh out of the vault record", async () => {
    const h = harness({ existing: true });
    expect(
      (
        await h.caller.begin({
          kind: "existing",
          connectionId: accountProfile.connectionId,
          password: v1Password,
        })
      ).ok,
    ).toBe(true);
    const oldKey = h.durable();
    if (oldKey?.state !== "active") throw new Error("Synthetic acceptance failed");
    h.advance(3_601_000);
    const fresh = rawCustomAccount("unchanged", accountNow + 3601);
    h.setRaw(fresh);
    h.tokenResponses.push({
      status: 200,
      body: {
        access_token: fresh.token.access_token,
        token_type: "Bearer",
        expires_in: 1,
        refresh_token: "synthetic-rotated-refresh",
      },
    });
    const result = await h.caller.sync(accountProfile.connectionId);
    expect(result).toMatchObject({ ok: true, kind: "ready" });
    const tokens = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(new URLSearchParams(String(tokens[1]![1].body))).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "browser",
        refresh_token: "synthetic-refresh-token",
      }),
    );
    const syncs = h.fetch.mock.calls.filter(([url]) => url.endsWith("/sync"));
    expect(new Headers(syncs[1]![1].headers).get("Authorization")).toBe(
      `Bearer ${fresh.token.access_token}`,
    );
    expect(h.manager.accept.mock.calls[1]?.[0]).toMatchObject({
      unlock: { kind: "decrypted-key", userKey: oldKey.userKey },
      autoUnlock: "preserve",
    });
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    h.advance(2_000);
    const latest = rawCustomAccount("unchanged", accountNow + 3603);
    h.setRaw(latest);
    h.tokenResponses.push({
      status: 200,
      body: { access_token: latest.token.access_token, token_type: "Bearer", expires_in: 3600 },
    });
    expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    const allTokens = h.fetch.mock.calls.filter(([url]) => url.endsWith("/token"));
    expect(new URLSearchParams(String(allTokens[2]![1].body)).get("refresh_token")).toBe(
      "synthetic-rotated-refresh",
    );
    expect(JSON.stringify(h.durable())).not.toContain("synthetic-rotated-refresh");
    expect(h.sessionMemory.raw()).toMatchObject({ refreshToken: "synthetic-rotated-refresh" });
    noSecrets(result);
    expect(h.fetch).toHaveBeenCalledTimes(7);
  });
  it("a rejected refresh sends no sync or password fallback and preserves the exact accepted record", async () => {
    const h = harness({ existing: true });
    expect(
      (
        await h.caller.begin({
          kind: "existing",
          connectionId: accountProfile.connectionId,
          password: v1Password,
        })
      ).ok,
    ).toBe(true);
    const previous = h.durable();
    h.advance(3_601_000);
    h.tokenResponses.push({
      status: 400,
      body: { error: "invalid_grant", error_description: "synthetic-invalid-refresh-secret" },
    });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.fetch.mock.calls.filter(([url]) => url.endsWith("/sync"))).toHaveLength(1);
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    expect(h.manager.accept).toHaveBeenCalledTimes(1);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.durable()).toEqual(previous);
  });
  it.each(["token", "sync", "sync-after-read", "refresh"] as const)(
    "rechecks permission immediately before the %s HTTP call",
    async (stage) => {
      const h = harness({ existing: true });
      if (stage === "token") {
        h.host.deriveAuthentication.mockImplementationOnce(async () => {
          h.permission(false);
          return {
            ok: true,
            data: {
              connectionId: accountProfile.connectionId,
              masterPasswordHash: authenticationHash,
            },
          };
        });
      } else if (stage === "sync") {
        const fetch = h.fetch.getMockImplementation()!;
        h.fetch.mockImplementation(async (url, init) => {
          const result = await fetch(url, init);
          if (url.endsWith("/token")) h.permission(false);
          return result;
        });
      }
      if (stage === "sync-after-read")
        h.store.read.mockImplementationOnce(async () => {
          h.permission(false);
          return { ok: true, data: h.durable() };
        });
      const begun = await h.caller.begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
      });
      if (stage !== "refresh") {
        expect(begun).toEqual({ ok: false, error: { code: "provider-permission-required" } });
        expect(h.fetch).toHaveBeenCalledTimes(stage === "token" ? 1 : 2);
        expect(h.manager.accept).not.toHaveBeenCalled();
      } else {
        expect(begun.ok).toBe(true);
        const previous = h.durable();
        h.advance(3_601_000);
        // A native-store await can outlive the permission checked at sync entry.
        h.store.read.mockImplementationOnce(async () => {
          h.permission(false);
          return { ok: true, data: previous };
        });
        expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
          ok: false,
          error: { code: "provider-permission-required" },
        });
        expect(h.fetch).toHaveBeenCalledTimes(3);
        expect(h.durable()).toEqual(previous);
      }
    },
  );
  it("disposes an options caller while KDF is pending without later provider grant or cache disable", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    const held = gate();
    h.host.deriveAuthentication.mockImplementationOnce(async () => {
      await held.promise;
      return {
        ok: true,
        data: { connectionId: accountProfile.connectionId, masterPasswordHash: authenticationHash },
      };
    });
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    await vi.waitFor(() => expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1));
    await h.caller.dispose();
    held.release();
    expect((await pending).ok).toBe(false);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.durable()).toEqual(previous);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("a sanitized provider network failure has no retry, legacy fallback, or cache mutation", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    h.fetch.mockRejectedValueOnce(new Error(`Synthetic provider leaked ${v1Password}`));
    const result = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    expect(result.ok).toBe(false);
    noSecrets(result);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.durable()).toEqual(previous);
    expect(h.manager.accept).not.toHaveBeenCalled();
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("subject mismatch after encrypted sync never reaches native acceptance", async () => {
    const h = harness({ existing: true });
    const previous = h.durable();
    const wrong = rawCustomAccount();
    wrong.sync.profile.id = crypto.randomUUID();
    h.setRaw(wrong);
    const result = await h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "account-mismatch", check: "token-subject" },
    });
    expect(h.manager.accept).not.toHaveBeenCalled();
    expect(h.durable()).toEqual(previous);
  });
}
