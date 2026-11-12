import { expect, it, vi } from "vitest";
import { parseSetupReply } from "../../../src/connections/wire";
import type { SetupBegin } from "../../../src/connections/types";
import {
  accountNow,
  accountProfile,
} from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { rawCustomAccount } from "../../../../../packages/bitwarden/src/__fixtures__/connection";
import { rawV1Account } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Password } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import type { SetupTestContext } from "./context";

export function registerSessionRestartCases({
  harness,
  noSecrets,
  connected,
}: Pick<SetupTestContext, "harness" | "noSecrets" | "connected">) {
  it("a new background incarnation syncs without the password and without HTTP at startup", async () => {
    const h = harness({ existing: true });
    await connected(h);
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
    expect(JSON.stringify(h.sessionMemory.raw())).not.toContain(v1Password);
    const fresh = h.restart();
    const status = await fresh.caller.status();
    expect(status).toMatchObject({ connections: [{ providerSession: "active" }] });
    noSecrets(status);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    // The revision date is unchanged, and a manual Sync still sends a full sync.
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_000_000);
    expect((await fresh.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.host.deriveAuthentication).toHaveBeenCalledTimes(1);
    // A second consecutive sync still works against the newly accepted cache revision.
    expect((await fresh.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    expect(h.manager.accept).toHaveBeenCalledTimes(3);
  });
}

export function registerSessionRevisionCases({
  harness,
  connected,
  hold,
}: Pick<SetupTestContext, "harness" | "connected" | "hold">) {
  it("a password sign-in stores the revision date, and an unchanged vault is not synced again", async () => {
    const h = harness({ existing: true });
    await connected(h);
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_000_000);
    const fetches = h.fetch.mock.calls.length;
    const accepts = h.manager.accept.mock.calls.length;
    const fresh = h.restart();
    expect(await fresh.service.autoSync(accountProfile.connectionId, hold())).toBe("unchanged");
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts);
  });
  it("a moved revision date syncs, accepts under the hold and stores the new date", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const accepts = h.manager.accept.mock.calls.length;
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    const held = hold();
    expect(await h.restart().service.autoSync(accountProfile.connectionId, held)).toBe("synced");
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts + 1);
    expect(held.released()).toBe(true);
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_060_000);
  });
  it("only an automatic check adopts its snapshot as automatic (ADR 0025)", async () => {
    const h = harness({ existing: true });
    await connected(h);
    // A password sign-in is not automatic.
    expect(h.policy.adopt).toHaveBeenCalledTimes(1);
    expect(h.policy.adopt.mock.calls[0]?.[0]).not.toHaveProperty("automatic");
    const fresh = h.restart();
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    expect(await fresh.service.autoSync(accountProfile.connectionId, hold())).toBe("synced");
    expect(h.policy.adopt).toHaveBeenCalledTimes(2);
    expect(h.policy.adopt.mock.calls[1]?.[0]).toMatchObject({ automatic: true });
    expect((await fresh.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    expect(h.policy.adopt).toHaveBeenCalledTimes(3);
    expect(h.policy.adopt.mock.calls[2]?.[0]).not.toHaveProperty("automatic");
  });
  it("a login in progress defers before the full sync, or after it without accepting", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const fetches = h.fetch.mock.calls.length;
    const accepts = h.manager.accept.mock.calls.length;
    const fresh = h.restart();
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    expect(await fresh.service.autoSync(accountProfile.connectionId, hold(false))).toBe("deferred");
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    expect(await fresh.service.autoSync(accountProfile.connectionId, hold(true, false))).toBe(
      "deferred",
    );
    expect(h.fetch).toHaveBeenCalledTimes(fetches + 1);
    expect(h.manager.accept).toHaveBeenCalledTimes(accepts);
    // Nothing was applied, so the next check still sees a change.
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(1_792_152_000_000);
  });
  it.each([
    { label: "null", response: { status: 200, body: null }, outcome: "synced" },
    { label: "negative", response: { status: 200, body: -1 }, outcome: "account-deleted" },
    { label: "429", response: { status: 429, body: {} }, outcome: "rate-limited" },
    {
      label: "503",
      response: { status: 503, body: {} },
      outcome: { outcome: "failed", cause: "http-error", status: 503 },
    },
  ] as const)("a $label revision date answers $outcome", async ({ response, outcome }) => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push(response);
    expect(await h.restart().service.autoSync(accountProfile.connectionId, hold())).toEqual(
      outcome,
    );
  });
  it("a manual sync that applies without a revision date drops the automatic check's failure", async () => {
    const h = harness({ existing: true });
    await connected(h);
    await h.revisions.update(accountProfile.connectionId, (entry) => ({
      ...entry,
      outcome: "failed",
      failure: { at: 1_792_152_000_000, cause: "network" },
    }));
    const before = await h.revisions.revision(accountProfile.connectionId);
    h.revisionResponses.push({ status: 503, body: {} });
    expect(await h.caller.sync(accountProfile.connectionId)).toMatchObject({ ok: true });
    // No revision was learned, so the stored one stays.
    expect(await h.revisions.revision(accountProfile.connectionId)).toBe(before);
    const result = await h.caller.status();
    expect(result).toMatchObject({ ok: true, kind: "status" });
    if (result.ok && result.kind === "status")
      expect(result.connections[0]?.syncFailure).toBeUndefined();
  });
  it("an unavailable transport reports its code", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.transportFor.mockReturnValueOnce({ ok: false, error: { code: "network" } });
    expect(await h.restart().service.autoSync(accountProfile.connectionId, hold())).toEqual({
      outcome: "failed",
      cause: "network",
    });
  });
  it.each([429, 503])("a refresh HTTP %i retains its outcome and status", async (status) => {
    const h = harness({ existing: true });
    await connected(h);
    h.advance(3_601_000);
    h.tokenResponses.push({ status, body: {} });
    const result = await h.restart().service.autoSync(accountProfile.connectionId, hold());
    expect(result).toEqual(
      status === 429 ? "rate-limited" : { outcome: "failed", cause: "http-error", status },
    );
  });
  it("a session store failure reports its code", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.advance(3_601_000);
    h.sessionMemory.failNext("storage-uncertain");
    expect(await h.restart().service.autoSync(accountProfile.connectionId, hold())).toEqual({
      outcome: "failed",
      cause: "storage-uncertain",
    });
  });
  it.each([429, 503])("a sync HTTP %i retains its outcome and status", async (status) => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    h.syncResponses.push({ status, body: {} });
    expect(await h.restart().service.autoSync(accountProfile.connectionId, hold())).toEqual(
      status === 429 ? "rate-limited" : { outcome: "failed", cause: "http-error", status },
    );
  });
  it("a decrypt or acceptance failure reports its code and releases the hold", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    h.manager.accept.mockResolvedValueOnce({ ok: false, error: { code: "crypto-failed" } });
    const held = hold();
    expect(await h.restart().service.autoSync(accountProfile.connectionId, held)).toEqual({
      outcome: "failed",
      cause: "crypto-failed",
    });
    expect(held.released()).toBe(true);
  });
  it("a decryption failure reports which check refused which item, on both syncs", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const detail = {
      code: "crypto-failed" as const,
      check: "attachment" as const,
      item: "00000000-0000-4000-8000-000000000002",
      revised: 1_762_720_517_000,
    };
    h.manager.accept.mockResolvedValueOnce({ ok: false, error: detail });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({ ok: false, error: detail });
    const restarted = h.restart();
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    h.manager.accept.mockResolvedValueOnce({ ok: false, error: detail });
    expect(await restarted.service.autoSync(accountProfile.connectionId, hold())).toEqual({
      outcome: "failed",
      cause: "crypto-failed",
      check: "attachment",
      item: detail.item,
      revised: detail.revised,
    });
    // Another code never carries the detail.
    h.manager.accept.mockResolvedValueOnce({
      ok: false,
      error: { ...detail, code: "storage-uncertain" },
    } as never);
    expect(await restarted.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
  });
  it.each(["registry", "policy"] as const)(
    "a thrown %s error reports only exception",
    async (stage) => {
      const h = harness({ existing: true });
      await connected(h);
      const thrown = new Error("synthetic-private-message https://example.test/token");
      h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
      if (stage === "registry") h.registry.get.mockRejectedValueOnce(thrown);
      else h.policy.adopt.mockRejectedValueOnce(thrown);
      const held = hold();
      const result = await h.restart().service.autoSync(accountProfile.connectionId, held);
      expect(result).toEqual({ outcome: "failed", cause: "exception" });
      expect(JSON.stringify(result)).not.toContain(thrown.message);
      if (stage === "policy") expect(held.released()).toBe(true);
    },
  );
  it("a 401 on the revision date discards the session it used", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push({ status: 401, body: {} });
    expect(await h.restart().service.autoSync(accountProfile.connectionId, hold())).toBe(
      "reauthentication-required",
    );
    expect(h.sessionMemory.raw()).toBeUndefined();
  });
  it("a manual Sync started with an automatic check waits for it and still syncs", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const fresh = h.restart();
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    let answer!: (ready: boolean) => void;
    const auto = fresh.service.autoSync(accountProfile.connectionId, {
      ready: () => new Promise<boolean>((resolve) => (answer = resolve)),
      take: async () => undefined,
    });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    const before = h.fetch.mock.calls.length;
    let finished = false;
    const manual = fresh.caller.sync(accountProfile.connectionId).finally(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    answer(false);
    expect(await auto).toBe("deferred");
    expect((await manual).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(before + 1);
  });
}

export function registerSessionLifecycleCases({
  gate,
  newInput,
  harness,
  connected,
  hold,
  waitingForCode,
  closers,
}: Pick<
  SetupTestContext,
  "gate" | "newInput" | "harness" | "connected" | "hold" | "waitingForCode" | "closers"
>) {
  it.each([
    { label: "another", input: newInput },
    {
      label: "the same",
      input: (): SetupBegin => ({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
      }),
    },
  ])(
    "a Sync of $label connection while a sign-in waits for its code is refused and keeps it",
    async ({ input }) => {
      const h = harness({ existing: true });
      await connected(h);
      const challenge = await waitingForCode(h, input());
      const fetches = h.fetch.mock.calls.length;
      expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
        ok: false,
        error: { code: "resource-limit" },
      });
      expect(h.fetch).toHaveBeenCalledTimes(fetches);
      expect(
        await h.caller.continue({
          flowId: challenge.flowId,
          twoFactor: { provider: 0, code: "000123" },
        }),
      ).toMatchObject({ ok: true, kind: "ready" });
      // Nothing of the refused Sync or the finished sign-in keeps the connection busy.
      expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
    },
  );
  it("a code for a two-step method not offered ends the sign-in and frees the connection", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const challenge = await waitingForCode(h, {
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 1, code: "000123" },
      }),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    expect((await h.caller.sync(accountProfile.connectionId)).ok).toBe(true);
  });
  it("a challenge that permission removal ended no longer blocks the page", async () => {
    const h = harness();
    await waitingForCode(h, newInput());
    h.permission(false);
    await h.service.permissionsRemoved();
    h.permission(true);
    expect(await h.caller.begin(newInput())).toMatchObject({ ok: true, kind: "ready" });
  });
  it("a second sign-in while one waits for its code is refused and keeps the first", async () => {
    const h = harness();
    const challenge = await waitingForCode(h, newInput());
    expect(await h.caller.begin(newInput())).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(
      await h.caller.continue({
        flowId: challenge.flowId,
        twoFactor: { provider: 0, code: "000123" },
      }),
    ).toMatchObject({ ok: true, kind: "ready" });
  });
  it("an automatic check that has not claimed anything yields to a manual Sync", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const fresh = h.restart();
    const before = h.fetch.mock.calls.length;
    const auto = fresh.service.autoSync(accountProfile.connectionId, hold());
    const manual = fresh.caller.sync(accountProfile.connectionId);
    expect(await auto).toBe("skipped");
    expect((await manual).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(before + 1);
  });
  it("a password sign-in stops an automatic check and waits for it", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.revisionResponses.push({ status: 200, body: 1_792_152_060_000 });
    let answer!: (ready: boolean) => void;
    const auto = h.service.autoSync(accountProfile.connectionId, {
      ready: () => new Promise<boolean>((resolve) => (answer = resolve)),
      take: async () => undefined,
    });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    let finished = false;
    const signIn = h.caller
      .begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
      })
      .finally(() => {
        finished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    answer(true);
    expect(await auto).toBe("skipped");
    expect((await signIn).ok).toBe(true);
  });
  it("a sync failure after a committed rotation keeps the rotated token", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    h.advance(3_601_000);
    const fresh = rawCustomAccount("unchanged", accountNow + 3601);
    h.tokenResponses.push({
      status: 200,
      body: {
        access_token: fresh.token.access_token,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "synthetic-rotated-refresh",
      },
    });
    h.syncResponses.push({ status: 500, body: {} });
    expect(await h.restart().caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "http-error" },
    });
    expect(h.sessionMemory.raw()).toMatchObject({
      state: "active",
      refreshToken: "synthetic-rotated-refresh",
    });
    expect(h.durable()).toEqual(previous);
  });
  it("an HTTP 500 sync failure replies with only a wire-valid error code", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    h.syncResponses.push({ status: 500, body: {} });
    const reply = await h.caller.sync(accountProfile.connectionId);
    expect(reply).toEqual({ ok: false, error: { code: "http-error" } });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
    expect(h.durable()).toEqual(previous);
  });
  it("a rejected access token forgets only the sync session", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    h.syncResponses.push({ status: 401, body: {} });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()).toEqual(previous);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("changed account crypto requires password sign-in and preserves the cache", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const previous = h.durable();
    const changed = rawCustomAccount();
    changed.sync.profile.privateKey = rawV1Account().token.Key;
    h.setRaw(changed);
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()).toEqual(previous);
    expect(h.manager.accept).toHaveBeenCalledTimes(1);
  });
  it("local forget keeps offline unlock and is not a server logout", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const calls = h.fetch.mock.calls.length;
    expect(await h.caller.forget(accountProfile.connectionId)).toEqual({
      ok: true,
      kind: "forgotten",
      connectionId: accountProfile.connectionId,
    });
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(await h.revisions.revision(accountProfile.connectionId)).toBeUndefined();
    expect(await h.service.autoSync(accountProfile.connectionId, hold())).toBe("skipped");
    expect(h.durable()?.state).toBe("active");
    expect(await h.caller.status()).toMatchObject({
      connections: [{ providerSession: "none", autoUnlock: "enabled" }],
    });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
  });
  it("disabling automatic unlock also forgets sync credentials", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.manager.disableAutoUnlock.mockResolvedValueOnce({
      ok: true,
      data: { connectionId: accountProfile.connectionId, revision: crypto.randomUUID() },
    });
    expect((await h.caller.disable(accountProfile.connectionId)).ok).toBe(true);
    expect(h.sessionMemory.raw()).toBeUndefined();
  });
  it("forget during an in-progress password setup is refused and never disables auto unlock", async () => {
    const h = harness();
    const held = gate();
    const catalog = h.manager.catalog.getMockImplementation()!;
    h.manager.catalog.mockImplementationOnce(async (handle) => {
      await held.promise;
      return catalog(handle);
    });
    const pending = h.caller.begin(newInput());
    await vi.waitFor(() => expect(h.manager.catalog).toHaveBeenCalled());
    const [connectionId] = [...h.configurations.keys()];
    if (!connectionId) throw new Error("Synthetic setup did not register");
    expect(await h.caller.forget(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.forget(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    held.release();
    expect(await pending).toMatchObject({ ok: true, kind: "ready" });
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.durable()?.state).toBe("active");
  });
  it("forget aborts an in-flight sync flow, then forgets the session", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const held = gate();
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementationOnce(async (url, init) => {
      await held.promise;
      return fetch(url, init);
    });
    const pending = h.caller.sync(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4));
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.forget(accountProfile.connectionId)).toEqual({
      ok: true,
      kind: "forgotten",
      connectionId: accountProfile.connectionId,
    });
    held.release();
    expect((await pending).ok).toBe(false);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
  });
  it("a late 401 for one session does not delete a newer session from a password sign-in", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const used = (h.sessionMemory.raw() as { revision: string }).revision;
    const held = gate();
    h.fetch.mockImplementationOnce(async () => {
      await held.promise;
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    });
    const pending = h.caller.sync(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4));
    // Another incarnation signs in with the password and retains a newer session.
    const fresh = h.restart();
    expect(
      await fresh.caller.begin({
        kind: "existing",
        connectionId: accountProfile.connectionId,
        password: v1Password,
      }),
    ).toMatchObject({ ok: true, kind: "ready" });
    const newer = h.sessionMemory.raw() as { revision: string; state: string };
    expect(newer.revision).not.toBe(used);
    held.release();
    expect(await pending).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(h.sessionMemory.raw()).toMatchObject({ revision: newer.revision, state: "active" });
  });
  it("disable reports a failed session forget instead of success", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.manager.disableAutoUnlock.mockResolvedValueOnce({
      ok: true,
      data: { connectionId: accountProfile.connectionId, revision: crypto.randomUUID() },
    });
    h.sessionMemory.failNext("storage-uncertain");
    expect(await h.caller.disable(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
  });
  it("delete removes the session, vault record and registry entry locally without provider HTTP", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const calls = h.fetch.mock.calls.length;
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
    const reply = await h.caller.remove(accountProfile.connectionId);
    expect(reply).toEqual({
      ok: true,
      kind: "deleted",
      connectionId: accountProfile.connectionId,
    });
    expect(parseSetupReply(reply)).toEqual(reply);
    expect(h.fetch).toHaveBeenCalledTimes(calls);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.manager.remove).toHaveBeenCalledTimes(1);
    expect(h.durable()).toBeNull();
    expect(h.registry.remove).toHaveBeenCalledWith(accountProfile.connectionId);
    expect(h.policy.forget).toHaveBeenCalledWith(accountProfile.connectionId);
    expect(h.configurations.size).toBe(0);
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(await h.caller.status()).toEqual({ ok: true, kind: "status", connections: [] });
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    expect(await h.caller.remove(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  });
  it("delete removes a leftover connection whose first sign-in never completed", async () => {
    const h = harness();
    h.tokenResponses.push({ status: 503, body: {} });
    const reply = await h.caller.begin(newInput());
    expect(reply).toEqual({ ok: false, error: { code: "http-error" } });
    expect(parseSetupReply(reply)).toEqual(reply);
    const [connectionId] = [...h.configurations.keys()];
    if (!connectionId) throw new Error("Synthetic setup did not register");
    expect(await h.caller.status()).toMatchObject({
      connections: [{ connectionId, autoUnlock: "unknown", providerSession: "none" }],
    });
    expect(await h.caller.remove(connectionId)).toEqual({
      ok: true,
      kind: "deleted",
      connectionId,
    });
    expect(await h.caller.status()).toEqual({ ok: true, kind: "status", connections: [] });
  });
  it("delete during an in-progress password setup is refused and keeps every record", async () => {
    const h = harness();
    const held = gate();
    const catalog = h.manager.catalog.getMockImplementation()!;
    h.manager.catalog.mockImplementationOnce(async (handle) => {
      await held.promise;
      return catalog(handle);
    });
    const pending = h.caller.begin(newInput());
    await vi.waitFor(() => expect(h.manager.catalog).toHaveBeenCalled());
    const [connectionId] = [...h.configurations.keys()];
    if (!connectionId) throw new Error("Synthetic setup did not register");
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.remove(connectionId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    held.release();
    expect(await pending).toMatchObject({ ok: true, kind: "ready" });
    expect(h.manager.remove).not.toHaveBeenCalled();
    expect(h.registry.remove).not.toHaveBeenCalled();
    expect(h.durable()?.state).toBe("active");
  });
  it("delete aborts an in-flight sync flow before removing its records", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const held = gate();
    const fetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementationOnce(async (url, init) => {
      await held.promise;
      return fetch(url, init);
    });
    const pending = h.caller.sync(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4));
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    expect(await other.remove(accountProfile.connectionId)).toEqual({
      ok: true,
      kind: "deleted",
      connectionId: accountProfile.connectionId,
    });
    held.release();
    expect((await pending).ok).toBe(false);
    expect(h.manager.accept).toHaveBeenCalledTimes(1);
    expect(h.durable()).toBeNull();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.configurations.size).toBe(0);
  });
  it("a sign-in begun before delete cannot target the deleted connection", async () => {
    const h = harness({ existing: true });
    const held = gate();
    const get = h.registry.get.getMockImplementation()!;
    h.registry.get.mockImplementationOnce(async (id) => {
      await held.promise;
      return get(id);
    });
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    await vi.waitFor(() => expect(h.registry.get).toHaveBeenCalledTimes(1));
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    const removed = other.remove(accountProfile.connectionId);
    held.release();
    expect(await removed).toMatchObject({ ok: true, kind: "deleted" });
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.durable()).toBeNull();
  });
  it("a sign-in that read the registry during delete cannot recreate the connection", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const removing = gate();
    const remove = h.manager.remove.getMockImplementation()!;
    h.manager.remove.mockImplementationOnce(async () => {
      await removing.promise;
      return remove();
    });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    const removed = other.remove(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.manager.remove).toHaveBeenCalledTimes(1));
    const reading = gate();
    const get = h.registry.get.getMockImplementation()!;
    h.registry.get.mockImplementationOnce(async (id) => {
      const stale = await get(id);
      await reading.promise;
      return stale;
    });
    const fetches = h.fetch.mock.calls.length;
    const reads = h.registry.get.mock.calls.length;
    const pending = h.caller.begin({
      kind: "existing",
      connectionId: accountProfile.connectionId,
      password: v1Password,
    });
    await vi.waitFor(() => expect(h.registry.get).toHaveBeenCalledTimes(reads + 1));
    removing.release();
    expect(await removed).toMatchObject({ ok: true, kind: "deleted" });
    reading.release();
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.fetch).toHaveBeenCalledTimes(fetches);
    expect(h.durable()).toBeNull();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.configurations.size).toBe(0);
  });
  it("disable, sync and forget during a delete are refused and leave no record", async () => {
    const h = harness({ existing: true });
    await connected(h);
    const removing = gate();
    const remove = h.manager.remove.getMockImplementation()!;
    h.manager.remove.mockImplementationOnce(async () => {
      await removing.promise;
      return remove();
    });
    const other = h.service.createCaller();
    closers.push(() => other.dispose());
    const removed = other.remove(accountProfile.connectionId);
    await vi.waitFor(() => expect(h.manager.remove).toHaveBeenCalledTimes(1));
    const refused = { ok: false, error: { code: "resource-limit" } };
    expect(await h.caller.disable(accountProfile.connectionId)).toEqual(refused);
    expect(await h.caller.sync(accountProfile.connectionId)).toEqual(refused);
    expect(await h.caller.forget(accountProfile.connectionId)).toEqual(refused);
    expect(await h.caller.remove(accountProfile.connectionId)).toEqual(refused);
    removing.release();
    expect(await removed).toMatchObject({ ok: true, kind: "deleted" });
    expect(h.manager.disableAutoUnlock).not.toHaveBeenCalled();
    expect(h.durable()).toBeNull();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.configurations.size).toBe(0);
  });
  it("a failed vault deletion keeps the connection listed for another attempt", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.manager.remove.mockResolvedValueOnce({
      ok: false,
      error: { code: "storage-uncertain" },
    });
    expect(await h.caller.remove(accountProfile.connectionId)).toEqual({
      ok: false,
      error: { code: "storage-uncertain" },
    });
    expect(h.registry.remove).not.toHaveBeenCalled();
    expect(h.configurations.size).toBe(1);
    expect((await h.caller.remove(accountProfile.connectionId)).ok).toBe(true);
    expect(h.configurations.size).toBe(0);
  });
  it("permission removal never rejects when the registry or permission check fails", async () => {
    const h = harness({ existing: true });
    await connected(h);
    h.registry.list.mockRejectedValueOnce(new Error("synthetic registry failure"));
    await expect(h.service.permissionsRemoved()).resolves.toBeUndefined();
    h.permissions.contains.mockRejectedValueOnce(new Error("synthetic permission failure"));
    await expect(h.service.permissionsRemoved()).resolves.toBeUndefined();
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
  });
  it("a sign-in whose permission is removed after acceptance keeps no sync session", async () => {
    const h = harness({ existing: true });
    const accept = h.manager.accept.getMockImplementation()!;
    h.manager.accept.mockImplementation(async (...input: Parameters<typeof accept>) => {
      const result = await accept(...input);
      h.permission(false);
      return result;
    });
    await connected(h);
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()?.state).toBe("active");
  });
  it("permission removal forgets only connections whose provider lost access", async () => {
    const h = harness({ existing: true });
    await connected(h);
    await h.service.permissionsRemoved();
    expect(h.sessionMemory.raw()).toMatchObject({ state: "active" });
    h.permission(false);
    await h.service.permissionsRemoved();
    expect(h.sessionMemory.raw()).toBeUndefined();
    expect(h.durable()?.state).toBe("active");
    expect(await h.revisions.revision(accountProfile.connectionId)).toBeUndefined();
  });
}
