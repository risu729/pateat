import { expect, test } from "@playwright/test";
import { withVaultProfile } from "./vault-fixture";
import {
  beginInput,
  heldDatabaseState,
  inspectProviderSessions,
  readSentinel,
  releaseVersionOneDatabase,
  seedVersionOneDatabase,
  setupProbe,
  setupRequest,
} from "./connection-fixture";

test("a version 1 database upgrades in place, and a blocked upgrade fails closed until released", async () => {
  // Each blocked native open waits for the 10 s open timeout before failing closed.
  test.setTimeout(120_000);
  await withVaultProfile(async (open) => {
    const browser = await open();
    // Seed before the options page loads and reads connection status.
    expect(await seedVersionOneDatabase(browser.page, true)).toBe(1);
    expect(await heldDatabaseState(browser.page)).toEqual({ version: 1, records: 1 });
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    // The held version 1 connection ignores versionchange, so the background cannot upgrade.
    const blocked = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput(),
    });
    expect(blocked).toEqual({ ok: false, error: { code: "storage-failed" } });
    expect(await heldDatabaseState(browser.page)).toEqual({ version: 1, records: 1 });
    await releaseVersionOneDatabase(browser.page);
    const accepted = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput(),
    });
    expect(accepted).toMatchObject({ ok: true, kind: "ready" });
    expect(await readSentinel(browser.page)).toEqual({ sentinel: true });
    expect(await inspectProviderSessions(browser.page)).toMatchObject({
      version: 2,
      stores: ["providerSessions", "records"],
      sessions: [{ state: "active", hasAccessToken: true, hasRefreshToken: true }],
      recordsHaveNoToken: true,
      passwordAbsent: true,
      plaintextAbsent: true,
    });
  });
});

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
