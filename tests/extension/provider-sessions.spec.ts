import { expect, test } from "@playwright/test";
import { withVaultProfile } from "./vault-fixture";
import {
  beginInput,
  inspectProviderSessions,
  setupProbe,
  setupRequest,
} from "./connection-fixture";

test("sync after a full profile reopen uses the saved sign-in without a password or token request", async () => {
  await withVaultProfile(async (open, requests) => {
    const first = await open();
    const options = await first.context.newPage();
    await options.goto(`chrome-extension://${first.extensionId}/options.html`);
    const accepted = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput(),
    });
    if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
    // The native store holds the session tokens beside, never inside, the vault records,
    // and neither the master password nor vault plaintext.
    expect(await inspectProviderSessions(first.page)).toMatchObject({
      version: 2,
      stores: ["providerSessions", "records"],
      sessions: [{ state: "active", hasAccessToken: true, hasRefreshToken: true }],
      recordsHaveNoToken: true,
      passwordAbsent: true,
      plaintextAbsent: true,
    });
    const reopened = await open();
    const page = await reopened.context.newPage();
    await page.goto(`chrome-extension://${reopened.extensionId}/options.html`);
    // Startup and status perform no provider HTTP.
    expect(await setupRequest(page, { type: "connection.status" })).toMatchObject({
      ok: true,
      connections: [{ providerSession: "active", autoUnlock: "enabled" }],
    });
    expect(await setupProbe(reopened.page, { action: "status" })).toMatchObject({ calls: 0 });
    const sync = () =>
      setupRequest(page, { type: "connection.sync", connectionId: accepted.connectionId });
    // Two consecutive syncs: the second uses the cache revision accepted by the first.
    expect(await sync()).toMatchObject({ ok: true, kind: "ready" });
    expect(await sync()).toMatchObject({ ok: true, kind: "ready" });
    expect(await setupProbe(reopened.page, { action: "status" })).toMatchObject({
      calls: 2,
      preloginCalls: 0,
      tokenCalls: 0,
      syncCalls: 2,
    });
    expect(requests).toEqual([]);
  });
});

test("local forget and permission removal clear sync sign-in but keep offline unlock", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    const first = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput("First vault"),
    });
    const second = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput("Second vault"),
    });
    if (!first.ok || first.kind !== "ready" || !second.ok || second.kind !== "ready")
      throw new Error("Synthetic setup failed");
    expect(
      await setupRequest(options, { type: "connection.forget", connectionId: first.connectionId }),
    ).toEqual({ ok: true, kind: "forgotten", connectionId: first.connectionId });
    expect((await inspectProviderSessions(browser.page)).sessions).toHaveLength(1);
    const status = await setupRequest(options, { type: "connection.status" });
    expect(status).toMatchObject({
      connections: [
        { connectionId: first.connectionId, providerSession: "none", autoUnlock: "enabled" },
        { connectionId: second.connectionId, providerSession: "active", autoUnlock: "enabled" },
      ],
    });
    const before = await setupProbe(browser.page, { action: "status" });
    expect(
      await setupRequest(options, { type: "connection.sync", connectionId: first.connectionId }),
    ).toEqual({ ok: false, error: { code: "setup-reauthentication-required" } });
    expect((await setupProbe(browser.page, { action: "status" })).calls).toBe(before.calls);
    await setupProbe(browser.page, {
      action: "configure",
      variant: "unchanged",
      permission: false,
    });
    expect(await inspectProviderSessions(browser.page)).toMatchObject({ records: 2, sessions: [] });
    expect(await setupProbe(browser.page, { action: "resolve", field: "password" })).toEqual({
      ok: true,
      matched: true,
    });
  });
});

test("deleting a connection removes its local records and it stays gone after reopening", async () => {
  await withVaultProfile(async (open, requests) => {
    const browser = await open();
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    const first = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput("First vault"),
    });
    const second = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput("Second vault"),
    });
    if (!first.ok || first.kind !== "ready" || !second.ok || second.kind !== "ready")
      throw new Error("Synthetic setup failed");
    expect(await inspectProviderSessions(browser.page)).toMatchObject({
      records: 2,
      sessions: [{ state: "active" }, { state: "active" }],
    });
    const before = await setupProbe(browser.page, { action: "status" });
    expect(
      await setupRequest(options, { type: "connection.delete", connectionId: first.connectionId }),
    ).toEqual({ ok: true, kind: "deleted", connectionId: first.connectionId });
    // Local only: no provider request is made.
    expect((await setupProbe(browser.page, { action: "status" })).calls).toBe(before.calls);
    expect(await inspectProviderSessions(browser.page)).toMatchObject({
      records: 1,
      sessions: [{ state: "active" }],
    });
    expect(await setupRequest(options, { type: "connection.status" })).toMatchObject({
      connections: [{ connectionId: second.connectionId }],
    });
    const reopened = await open();
    const page = await reopened.context.newPage();
    await page.goto(`chrome-extension://${reopened.extensionId}/options.html`);
    const status = await setupRequest(page, { type: "connection.status" });
    expect(status).toMatchObject({
      ok: true,
      connections: [
        { connectionId: second.connectionId, autoUnlock: "enabled", providerSession: "active" },
      ],
    });
    if (!status.ok || status.kind !== "status") throw new Error("Synthetic status failed");
    expect(status.connections).toHaveLength(1);
    expect(await setupProbe(reopened.page, { action: "status" })).toMatchObject({
      configuredIds: [second.connectionId],
    });
    expect(await inspectProviderSessions(reopened.page)).toMatchObject({
      records: 1,
      sessions: [{ state: "active" }],
    });
    expect(
      await setupRequest(page, { type: "connection.delete", connectionId: first.connectionId }),
    ).toEqual({ ok: false, error: { code: "invalid-request" } });
    expect(requests).toEqual([]);
  });
});

test("the native session store guards on the cache record and its own revision", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    expect(await setupProbe(browser.page, { action: "session-store" })).toEqual({
      ok: true,
      results: {
        retain: "ok",
        guardMismatch: "storage-conflict",
        guardDisabled: "storage-conflict",
        revisionConflict: "storage-conflict",
        unchanged: true,
        swap: "ok",
        readback: true,
        corruptRead: "invalid-cache-record",
        corruptReplace: "invalid-cache-record",
        corruptDeleteWithRevision: "invalid-cache-record",
        corruptKept: true,
        corruptDelete: "ok",
        deleted: true,
        mismatchRead: "account-mismatch",
        mismatchReplace: "ok",
        replaced: true,
      },
    });
  });
});
