import { expect, test } from "@playwright/test";
import { withStoppedLoginWorker } from "./login-fixture";
import {
  withVaultProfile,
  invokeVault,
  vaultData,
  mutateNativeVault,
  type Accepted,
  type VaultStatus,
  type VaultInspection,
} from "./vault-fixture";

for (const kind of ["v1", "v2", "organization"] as const) {
  test(`persists and restores actual ${kind} SDK material after full profile close and reopen`, async () => {
    await withVaultProfile(async (open, externalRequests) => {
      const first = await open();
      const accepted = await vaultData<Accepted>(first.page, { action: "accept", kind });
      expect(accepted.summary).toMatchObject({
        autoUnlock: "enabled",
        accountVersion: kind === "v2" ? "v2" : "v1",
        securityVersion: kind === "v2" ? 2 : 1,
      });
      expect(await vaultData(first.page, { action: "resolve" })).toEqual({ matches: true });
      const stored = await vaultData<VaultInspection>(first.page, { action: "inspect" });
      expect(stored).toMatchObject({
        exists: true,
        state: "active",
        keyStored: true,
        passwordAbsent: true,
        tokensAbsent: true,
        plaintextAbsent: true,
      });
      const oldStatus = await vaultData<VaultStatus>(first.page, { action: "status" });
      const reopened = await open(); // Actual Chromium process/profile closure, not a page refresh.
      const initial = await vaultData<VaultStatus>(reopened.page, { action: "status" });
      expect(initial.ready).toBe(false);
      expect(initial.host.sessions).toBe(0);
      const restored = await vaultData<Accepted>(reopened.page, { action: "restore" });
      expect(restored.handle.snapshotId).toBe(accepted.handle.snapshotId);
      expect(restored.handle.recordId).toBe(accepted.handle.recordId);
      expect(restored.handle.managerGeneration).not.toBe(accepted.handle.managerGeneration);
      expect(restored.handle.handleId).not.toBe(accepted.handle.handleId);
      const newStatus = await vaultData<VaultStatus>(reopened.page, { action: "status" });
      expect(newStatus.host.generation).not.toBe(oldStatus.host.generation);
      expect(newStatus.host.sessions).toBe(1);
      expect(await vaultData(reopened.page, { action: "resolve" })).toEqual({ matches: true });
      expect(await vaultData(reopened.page, { action: "inspect" })).toEqual(stored);
      expect(externalRequests).toEqual([]);
    });
  });
}

type UriCandidates = {
  snapshotId: string;
  targetOrigin: string;
  candidates: { itemId: string; matches: { uriIndex: number; match: number }[] }[];
  unavailableUris: unknown[];
  unavailableItemIds: string[];
};

test("matches actual SDK-decrypted URIs with retained context after full profile restart", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const first = await open();
    const accepted = await vaultData<Accepted>(first.page, { action: "accept", kind: "uri" });
    // The fixture also carries deleted and archived copies with identical URI rules.
    const exact = await vaultData<UriCandidates>(first.page, {
      action: "match",
      url: "https://synthetic.example.test/login",
    });
    expect(exact).toMatchObject({
      snapshotId: accepted.handle.snapshotId,
      targetOrigin: "https://synthetic.example.test",
      candidates: [
        {
          matches: [
            { uriIndex: 0, match: 3 },
            { uriIndex: 1, match: 0 },
          ],
        },
      ],
      unavailableUris: [],
      unavailableItemIds: [],
    });
    expect(exact.candidates).toHaveLength(1);
    const sibling = await vaultData<UriCandidates>(first.page, {
      action: "match",
      url: "https://auth.example.test/",
    });
    expect(sibling.candidates).toEqual([
      { itemId: exact.candidates[0]!.itemId, matches: [{ uriIndex: 1, match: 0 }] },
    ]);
    expect(
      (await vaultData<UriCandidates>(first.page, { action: "match", url: "https://example.org/" }))
        .candidates,
    ).toEqual([]);
    expect(JSON.stringify([exact, sibling])).not.toContain("synthetic.example.test/login");
    expect(await invokeVault(first.page, { action: "match", url: "ftp://example.test/" })).toEqual({
      ok: false,
      error: { code: "invalid-uri-input" },
    });
    const reopened = await open();
    await vaultData<Accepted>(reopened.page, { action: "restore" });
    expect(
      await vaultData<UriCandidates>(reopened.page, {
        action: "match",
        url: "https://synthetic.example.test/login",
      }),
    ).toEqual(exact);
    expect(externalRequests).toEqual([]);
  });
});

test("an accepted cache without URI context reports matching unavailable", async () => {
  await withVaultProfile(async (open) => {
    const { page } = await open();
    await vaultData<Accepted>(page, { action: "accept", kind: "uri-without-context" });
    expect(
      await invokeVault(page, { action: "match", url: "https://synthetic.example.test/login" }),
    ).toEqual({ ok: false, error: { code: "uri-context-unavailable" } });
  });
});

test("keeps durable disabled state across profile restart and requires explicit re-enable", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const first = await open();
    const accepted = await vaultData<Accepted>(first.page, { action: "accept", kind: "v1" });
    await vaultData(first.page, { action: "disable" });
    expect(await vaultData(first.page, { action: "inspect" })).toMatchObject({
      state: "disabled",
      keyStored: false,
      snapshotId: accepted.handle.snapshotId,
    });
    expect(await invokeVault(first.page, { action: "resolve" })).toEqual({
      ok: false,
      error: { code: "stale-vault-handle" },
    });
    const reopened = await open();
    expect(await invokeVault(reopened.page, { action: "restore" })).toEqual({
      ok: false,
      error: { code: "auto-unlock-disabled" },
    });
    expect(
      await invokeVault(reopened.page, { action: "accept", kind: "v1", autoUnlock: "preserve" }),
    ).toEqual({ ok: false, error: { code: "auto-unlock-disabled" } });
    const fresh = await vaultData<Accepted>(reopened.page, {
      action: "accept",
      kind: "v1",
      autoUnlock: "enable",
    });
    expect(fresh.handle.snapshotId).not.toBe(accepted.handle.snapshotId);
    expect(await vaultData(reopened.page, { action: "resolve" })).toEqual({ matches: true });
    expect(externalRequests).toEqual([]);
  });
});

test("rejects a corrupted last received cipher before export or replacement of last good record", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "accept", kind: "v1" });
    const before = await vaultData<VaultInspection>(browser.page, { action: "inspect" });
    expect(await invokeVault(browser.page, { action: "accept", kind: "corrupt-last" })).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
    expect(await vaultData(browser.page, { action: "inspect" })).toEqual(before);
    expect(await vaultData(browser.page, { action: "resolve" })).toEqual({ matches: true });
    expect((await vaultData<VaultStatus>(browser.page, { action: "status" })).host.sessions).toBe(
      1,
    );
    expect(externalRequests).toEqual([]);
  });
});

test("denies private Worker key export until all received ciphers are verified", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    expect(await vaultData(browser.page, { action: "export-gate" })).toEqual({ denied: true });
    expect((await vaultData<VaultInspection>(browser.page, { action: "inspect" })).exists).toBe(
      false,
    );
    expect((await vaultData<VaultStatus>(browser.page, { action: "status" })).host.sessions).toBe(
      0,
    );
    expect(externalRequests).toEqual([]);
  });
});

test("native IDB CAS from independent adapters cannot overwrite a durable disable", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "accept", kind: "v1" });
    expect(await vaultData(browser.page, { action: "cas-conflict" })).toEqual({
      conflict: true,
      disabled: true,
      blocked: true,
    });
    expect(await vaultData(browser.page, { action: "inspect" })).toMatchObject({
      state: "disabled",
      keyStored: false,
    });
    expect((await vaultData<VaultStatus>(browser.page, { action: "status" })).host.sessions).toBe(
      0,
    );
    expect(externalRequests).toEqual([]);
  });
});

test("a disable tombstone wins against the first staged acceptance without retry", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "arm", checkpoint: "before-write" });
    const pending = invokeVault(browser.page, { action: "accept", kind: "v1" });
    await expect
      .poll(async () => (await vaultData<VaultStatus>(browser.page, { action: "status" })).reached)
      .toBe(true);
    expect((await vaultData<VaultStatus>(browser.page, { action: "status" })).host.sessions).toBe(
      1,
    );
    await vaultData(browser.page, { action: "disable" });
    expect((await vaultData<VaultStatus>(browser.page, { action: "status" })).host.sessions).toBe(
      0,
    );
    await vaultData(browser.page, { action: "release" });
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(await vaultData(browser.page, { action: "inspect" })).toMatchObject({
      state: "disabled",
      keyStored: false,
      recordId: null,
    });
    expect(await invokeVault(browser.page, { action: "restore" })).toEqual({
      ok: false,
      error: { code: "auto-unlock-disabled" },
    });
    expect(externalRequests).toEqual([]);
  });
});

test("withholds publication after committed write until exact readback completes", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "arm", checkpoint: "after-write" });
    let published = false;
    const pending = invokeVault(browser.page, { action: "accept", kind: "v1" }).then((result) => {
      published = true;
      return result;
    });
    await expect
      .poll(async () => (await vaultData<VaultStatus>(browser.page, { action: "status" })).reached)
      .toBe(true);
    expect(await vaultData(browser.page, { action: "inspect" })).toMatchObject({
      state: "active",
      keyStored: true,
    });
    expect((await vaultData<VaultStatus>(browser.page, { action: "status" })).ready).toBe(false);
    expect(published).toBe(false);
    await vaultData(browser.page, { action: "release" });
    expect((await pending).ok).toBe(true);
    expect(await vaultData(browser.page, { action: "resolve" })).toEqual({ matches: true });
    expect(externalRequests).toEqual([]);
  });
});

test("restores a committed unpublished candidate after actual service worker reset", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "arm", checkpoint: "after-write" });
    const pending = invokeVault(browser.page, { action: "accept", kind: "v2" }).catch(() => ({
      ok: false as const,
      error: { code: "channel-closed" },
    }));
    await expect
      .poll(async () => (await vaultData<VaultStatus>(browser.page, { action: "status" })).reached)
      .toBe(true);
    const stored = await vaultData<VaultInspection>(browser.page, { action: "inspect" });
    const previous = await vaultData<VaultStatus>(browser.page, { action: "status" });
    await withStoppedLoginWorker(
      browser.context,
      browser.background,
      browser.page,
      async (expectRestarted) => {
        const status = await vaultData<VaultStatus>(browser.page, { action: "status" });
        await expectRestarted();
        expect(status.generation).not.toBe(previous.generation);
        expect(status.ready).toBe(false);
        const restored = await vaultData<Accepted>(browser.page, { action: "restore" });
        expect(restored.handle.snapshotId).toBe(stored.snapshotId);
        expect(restored.handle.recordId).toBe(stored.recordId);
        expect(await vaultData(browser.page, { action: "resolve" })).toEqual({ matches: true });
      },
    );
    expect((await pending).ok).toBe(false);
    expect(externalRequests).toEqual([]);
  });
});

test("rejects over-budget records without replacing the last good usable context", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "accept", kind: "v1" });
    expect(await vaultData(browser.page, { action: "oversize" })).toEqual({
      rejected: true,
      quota: true,
      unchanged: true,
    });
    expect(await vaultData(browser.page, { action: "resolve" })).toEqual({ matches: true });
    expect(externalRequests).toEqual([]);
  });
});

test("fails native offline initialization for structurally valid but wrong persisted key", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "accept", kind: "v1" });
    expect(await vaultData(browser.page, { action: "corrupt-key" })).toEqual({
      rejected: false,
      quota: false,
      unchanged: false,
    });
    const reopened = await open();
    expect((await invokeVault(reopened.page, { action: "restore" })).ok).toBe(false);
    expect((await vaultData<VaultStatus>(reopened.page, { action: "status" })).host.sessions).toBe(
      0,
    );
    expect(await invokeVault(reopened.page, { action: "resolve" })).toEqual({
      ok: false,
      error: { code: "stale-vault-handle" },
    });
    expect(externalRequests).toEqual([]);
  });
});

test("a newly unavailable item cannot reuse an old decrypted field", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    const old = await vaultData<Accepted>(browser.page, { action: "accept", kind: "v1" });
    expect(await vaultData(browser.page, { action: "resolve" })).toEqual({ matches: true });
    const accepted = await vaultData<Accepted>(browser.page, {
      action: "accept",
      kind: "unavailable",
    });
    expect(accepted.handle.snapshotId).not.toBe(old.handle.snapshotId);
    expect(await invokeVault(browser.page, { action: "resolve" })).toEqual({
      ok: false,
      error: { code: "field-missing" },
    });
    const reopened = await open();
    expect((await invokeVault(reopened.page, { action: "restore" })).ok).toBe(true);
    expect(await invokeVault(reopened.page, { action: "resolve" })).toEqual({
      ok: false,
      error: { code: "field-missing" },
    });
    expect(externalRequests).toEqual([]);
  });
});

test("native transaction abort after put success preserves the exact prior usable record", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "accept", kind: "v1" });
    const previous = await vaultData<VaultInspection>(browser.page, { action: "inspect" });
    expect(await mutateNativeVault(browser.page, "abort")).toEqual({
      committed: false,
      aborted: true,
      unchanged: true,
    });
    expect(await vaultData(browser.page, { action: "inspect" })).toEqual(previous);
    expect(await vaultData(browser.page, { action: "resolve" })).toEqual({ matches: true });
    expect(externalRequests).toEqual([]);
  });
});

test("malformed durable state fails closed instead of being treated as a missing initial record", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "accept", kind: "v1" });
    expect((await mutateNativeVault(browser.page, "malformed")).committed).toBe(true);
    expect(await invokeVault(browser.page, { action: "resolve" })).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
    const reopened = await open();
    expect(await invokeVault(reopened.page, { action: "restore" })).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
    expect(await invokeVault(reopened.page, { action: "accept", kind: "v1" })).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
    expect((await vaultData<VaultStatus>(reopened.page, { action: "status" })).host.sessions).toBe(
      0,
    );
    expect(externalRequests).toEqual([]);
  });
});

test("a changed durable revision after commit withholds both candidate and old live sessions", async () => {
  await withVaultProfile(async (open, externalRequests) => {
    const browser = await open();
    await vaultData(browser.page, { action: "accept", kind: "v1" });
    await vaultData(browser.page, { action: "arm", checkpoint: "after-write" });
    const pending = invokeVault(browser.page, {
      action: "accept",
      kind: "v1",
      autoUnlock: "preserve",
    });
    await expect
      .poll(async () => (await vaultData<VaultStatus>(browser.page, { action: "status" })).reached)
      .toBe(true);
    expect((await mutateNativeVault(browser.page, "replace")).committed).toBe(true);
    await vaultData(browser.page, { action: "release" });
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
    expect(await vaultData(browser.page, { action: "status" })).toMatchObject({
      ready: false,
      storageUncertain: true,
      host: { sessions: 0 },
    });
    expect((await invokeVault(browser.page, { action: "resolve" })).ok).toBe(false);
    expect((await invokeVault(browser.page, { action: "restore" })).ok).toBe(true);
    expect(await vaultData(browser.page, { action: "resolve" })).toEqual({ matches: true });
    expect(externalRequests).toEqual([]);
  });
});
