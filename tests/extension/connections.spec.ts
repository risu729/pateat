import { expect, test } from "@playwright/test";
import { withVaultProfile } from "./vault-fixture";
import {
  setupProbe,
  setupRequest,
  settingsRequest,
  beginInput,
  inspectSetupPersistence,
} from "./connection-fixture";
import { v1Password } from "../../packages/bitwarden/src/__fixtures__/crypto";

test("manual options setup accepts real SDK data and restores value-free catalog offline after full profile closure", async () => {
  await withVaultProfile(async (open, requests) => {
    const first = await open();
    await setupProbe(first.page, { action: "configure", variant: "unchanged" });
    const options = await first.context.newPage();
    await options.goto(`chrome-extension://${first.extensionId}/options.html`);
    const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
    expect(accepted).toMatchObject({ ok: true, kind: "ready", policyReviewItemIds: [] });
    if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
    const before = await setupProbe(first.page, { action: "status" });
    expect(before).toMatchObject({
      calls: 3,
      preloginCalls: 1,
      tokenCalls: 1,
      syncCalls: 1,
      metadataOnly: true,
    });
    expect(before.catalogs).toEqual([
      {
        connectionId: accepted.connectionId,
        snapshotId: accepted.snapshotId,
        itemCount: 1,
        quarantineCount: 0,
        state: "ready",
      },
    ]);
    const saved = await settingsRequest(options);
    const item = saved.catalog.connections.find((entry) => entry.id === accepted.connectionId)
      ?.items[0];
    expect(item?.fields).toContainEqual({ id: "login.password", label: "Password" });
    expect(item?.fields.some((field) => field.id === `custom.${accepted.snapshotId}.1`)).toBe(true);
    expect(item?.allowedOrigins).toEqual([]);
    expect(await setupProbe(first.page, { action: "resolve", field: "password" })).toEqual({
      ok: true,
      matched: true,
    });
    expect(await inspectSetupPersistence(first.page)).toEqual({
      databaseExists: true,
      records: 1,
      noCredentialProperties: true,
      passwordAbsent: true,
      plaintextAbsent: true,
    });
    const reopened = await open();
    const after = await setupProbe(reopened.page, { action: "status" });
    expect(after).toMatchObject({
      calls: 0,
      configuredIds: [accepted.connectionId],
      metadataOnly: true,
      catalogs: before.catalogs,
    });
    expect(await setupProbe(reopened.page, { action: "resolve", field: "custom-1" })).toEqual({
      ok: true,
      matched: true,
    });
    expect(await inspectSetupPersistence(reopened.page)).toEqual({
      databaseExists: true,
      records: 1,
      noCredentialProperties: true,
      passwordAbsent: true,
      plaintextAbsent: true,
    });
    expect(requests).toEqual([]);
  });
});

test("probe permission denial reaches the real coordinator before any fixed provider request", async () => {
  await withVaultProfile(async (open, requests) => {
    const browser = await open();
    expect(await inspectSetupPersistence(browser.page)).toMatchObject({
      databaseExists: false,
      records: 0,
    });
    await setupProbe(browser.page, {
      action: "configure",
      variant: "unchanged",
      permission: false,
    });
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    expect(await setupRequest(options, { type: "connection.begin", input: beginInput() })).toEqual({
      ok: false,
      error: { code: "provider-permission-required" },
    });
    expect(await setupProbe(browser.page, { action: "status" })).toMatchObject({
      calls: 0,
      configuredIds: [],
      catalogs: [],
    });
    expect(await inspectSetupPersistence(browser.page)).toEqual({
      databaseExists: false,
      records: 0,
      noCredentialProperties: true,
      passwordAbsent: true,
      plaintextAbsent: true,
    });
    expect(requests).toEqual([]);
  });
});

test("native metadata overflow rejects the candidate before replacing its last accepted cache", async () => {
  await withVaultProfile(async (open, requests) => {
    const browser = await open();
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    const first = await setupRequest(options, { type: "connection.begin", input: beginInput() });
    if (!first.ok || first.kind !== "ready") throw new Error("Synthetic setup failed");
    const before = await setupProbe(browser.page, { action: "status" });
    await setupProbe(browser.page, {
      action: "configure",
      variant: "unchanged",
      overflow: "group-refs",
    });
    expect(
      await setupRequest(options, { type: "connection.sync", connectionId: first.connectionId }),
    ).toEqual({ ok: false, error: { code: "resource-limit" } });
    expect((await setupProbe(browser.page, { action: "status" })).catalogs).toEqual(
      before.catalogs,
    );
    expect(await setupProbe(browser.page, { action: "resolve", field: "password" })).toEqual({
      ok: true,
      matched: true,
    });
    expect(await inspectSetupPersistence(browser.page)).toEqual({
      databaseExists: true,
      records: 1,
      noCredentialProperties: true,
      passwordAbsent: true,
      plaintextAbsent: true,
    });
    expect(requests).toEqual([]);
  });
});

test("a different extension page cannot impersonate the exact trusted options Port", async () => {
  await withVaultProfile(async (open, requests) => {
    const browser = await open();
    const denied = await browser.page.evaluate(async () => {
      const scope = globalThis as unknown as {
        chrome: {
          runtime: {
            connect(options: { name: string }): {
              postMessage(value: unknown): void;
              onDisconnect: { addListener(listener: () => void): void };
              onMessage: { addListener(listener: () => void): void };
            };
          };
        };
      };
      const port = scope.chrome.runtime.connect({ name: "pateat.bitwarden-setup.v1" });
      return new Promise<{ disconnected: boolean; replied: boolean }>((resolve, reject) => {
        let replied = false;
        const timer = setTimeout(
          () => reject(new Error("Synthetic spoofed Port did not close")),
          5000,
        );
        port.onMessage.addListener(() => {
          replied = true;
        });
        port.onDisconnect.addListener(() => {
          clearTimeout(timer);
          resolve({ disconnected: true, replied });
        });
        port.postMessage({
          requestId: crypto.randomUUID(),
          type: "connection.status",
          caller: "options",
        });
      });
    });
    expect(denied).toEqual({ disconnected: true, replied: false });
    expect(await setupProbe(browser.page, { action: "status" })).toMatchObject({
      calls: 0,
      configuredIds: [],
    });
    expect(requests).toEqual([]);
  });
});

for (const challenge of ["mfa", "new-device"] as const) {
  test(`actual options Port pauses for manual ${challenge} and never resends without continuation`, async () => {
    await withVaultProfile(async (open, requests) => {
      const browser = await open();
      await setupProbe(browser.page, { action: "configure", variant: "unchanged", challenge });
      const options = await browser.context.newPage();
      await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
      const pending = await setupRequest(options, {
        type: "connection.begin",
        input: beginInput(),
      });
      expect(pending).toMatchObject({
        ok: true,
        kind: challenge === "mfa" ? "mfa-required" : "new-device-verification-required",
      });
      if (!pending.ok || !("flowId" in pending))
        throw new Error("Synthetic manual challenge failed");
      expect(await setupProbe(browser.page, { action: "status" })).toMatchObject({
        calls: 2,
        tokenCalls: 1,
        syncCalls: 0,
        catalogs: [{ itemCount: 0 }],
      });
      expect(await setupRequest(options, { type: "connection.status" })).toMatchObject({
        ok: true,
        kind: "status",
      });
      expect(await setupProbe(browser.page, { action: "status" })).toMatchObject({ calls: 2 });
      const ready = await setupRequest(options, {
        type: "connection.continue",
        input: {
          flowId: pending.flowId,
          ...(challenge === "mfa"
            ? { twoFactor: { provider: 0 as const, code: "123456" } }
            : { newDeviceOtp: "123456" }),
        },
      });
      expect(ready).toMatchObject({ ok: true, kind: "ready" });
      expect(await setupProbe(browser.page, { action: "status" })).toMatchObject({
        calls: 4,
        tokenCalls: 2,
        syncCalls: 1,
        catalogs: [{ state: "ready" }],
      });
      expect(await inspectSetupPersistence(browser.page)).toMatchObject({
        noCredentialProperties: true,
        passwordAbsent: true,
        plaintextAbsent: true,
      });
      expect(requests).toEqual([]);
    });
  });
}

for (const variant of ["unchanged", "builtin-changed", "changed", "reordered"] as const) {
  test(`custom exclusion replacement ${variant} preserves exact identity or quarantines the affected item`, async () => {
    await withVaultProfile(async (open, requests) => {
      const browser = await open();
      const options = await browser.context.newPage();
      await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
      const first = await setupRequest(options, { type: "connection.begin", input: beginInput() });
      if (!first.ok || first.kind !== "ready") throw new Error("Synthetic setup failed");
      const saved = await settingsRequest(options);
      const connection = saved.snapshot.settings.connections.find(
        (entry) => entry.connectionId === first.connectionId,
      )!;
      const item = saved.catalog.connections.find((entry) => entry.id === first.connectionId)!
        .items[0]!;
      connection.excludedFields.push({ itemId: item.id, fieldId: `custom.${first.snapshotId}.1` });
      await settingsRequest(options, {
        version: 1,
        type: "settings.save",
        expectedRevision: saved.snapshot.revision,
        settings: saved.snapshot.settings,
      });
      expect(await setupProbe(browser.page, { action: "resolve", field: "custom-1" })).toEqual({
        ok: false,
        error: { code: "field-denied" },
      });
      await setupProbe(browser.page, { action: "configure", variant });
      const refreshed = await setupRequest(options, {
        type: "connection.sync",
        connectionId: first.connectionId,
      });
      expect(refreshed).toMatchObject({ ok: true, kind: "ready" });
      if (!refreshed.ok || refreshed.kind !== "ready") throw new Error("Synthetic sync failed");
      expect(refreshed.snapshotId).not.toBe(first.snapshotId);
      const unchanged = variant === "unchanged" || variant === "builtin-changed";
      expect(refreshed.policyReviewItemIds).toEqual(unchanged ? [] : [item.id]);
      expect(await setupProbe(browser.page, { action: "resolve", field: "custom-1" })).toEqual({
        ok: false,
        error: { code: "field-denied" },
      });
      if (unchanged) {
        expect(await setupProbe(browser.page, { action: "resolve", field: "password" })).toEqual({
          ok: true,
          matched: true,
        });
        const latest = await settingsRequest(options);
        expect(
          latest.snapshot.settings.connections.find(
            (entry) => entry.connectionId === first.connectionId,
          )!.excludedFields,
        ).toContainEqual({ itemId: item.id, fieldId: `custom.${refreshed.snapshotId}.1` });
      } else {
        expect(await setupProbe(browser.page, { action: "resolve", field: "password" })).toEqual({
          ok: false,
          error: { code: "field-denied" },
        });
        const latest = await settingsRequest(options);
        expect(
          await setupRequest(options, {
            type: "connection.review",
            input: {
              connectionId: first.connectionId,
              itemId: item.id,
              snapshotId: refreshed.snapshotId,
              expectedRevision: latest.snapshot.revision,
              excludedFieldIds: [`custom.${refreshed.snapshotId}.1`],
            },
          }),
        ).toMatchObject({ ok: true, kind: "ready", policyReviewItemIds: [] });
        expect(await setupProbe(browser.page, { action: "resolve", field: "password" })).toEqual({
          ok: true,
          matched: true,
        });
        expect(await setupProbe(browser.page, { action: "resolve", field: "custom-1" })).toEqual({
          ok: false,
          error: { code: "field-denied" },
        });
      }
      expect(requests).toEqual([]);
    });
  });
}

test("rejected reauthentication preserves the accepted local record and two independent connection catalogs", async () => {
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
      throw new Error("Synthetic isolated setup failed");
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(first.snapshotId).not.toBe(second.snapshotId);
    const before = await setupProbe(browser.page, { action: "status" });
    expect(before.configuredIds).toEqual([first.connectionId, second.connectionId]);
    expect(before.catalogs).toHaveLength(2);
    await setupProbe(browser.page, {
      action: "configure",
      variant: "unchanged",
      challenge: "rejected",
    });
    expect(
      await setupRequest(options, {
        type: "connection.begin",
        input: {
          kind: "existing",
          connectionId: first.connectionId,
          password: v1Password,
          autoUnlock: "preserve",
        },
      }),
    ).toEqual({ ok: false, error: { code: "authentication-rejected" } });
    const after = await setupProbe(browser.page, { action: "status" });
    expect(after.catalogs).toEqual(before.catalogs);
    expect(after.syncCalls).toBe(2);
    expect(await inspectSetupPersistence(browser.page)).toEqual({
      databaseExists: true,
      records: 2,
      noCredentialProperties: true,
      passwordAbsent: true,
      plaintextAbsent: true,
    });
    expect(await setupProbe(browser.page, { action: "resolve", field: "password" })).toEqual({
      ok: true,
      matched: true,
    });
    expect(requests).toEqual([]);
  });
});
