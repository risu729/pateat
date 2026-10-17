import { expect, test, type Page, type Worker } from "@playwright/test";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { startLoginFixture } from "./login-server";
import { withVaultProfile } from "./vault-fixture";
import { sendToBackground as send } from "./background-message";

// The synthetic Bitwarden item's fields, as in login-vault.spec.ts; no real vault is used.
const vaultPassword = "test_password";
const TIMEOUT_KEY = "pateat.vault-timeout.v1";
const ACTIVITY_KEY = "pateat.vault-activity.v1";

type StorageChrome = {
  storage: {
    local: { set(values: Record<string, unknown>): Promise<void> };
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
};

/** Connect the synthetic vault, bind its fields and save one exact-origin default. */
async function connectAndBind(options: Page, origin: string) {
  const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
  if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
  const saved = await settingsRequest(options);
  const connection = saved.catalog.connections.find((entry) => entry.id === accepted.connectionId);
  const item = connection?.items[0];
  if (!connection?.userId || !item) throw new Error("Synthetic vault item missing");
  expect(
    await send(options, {
      version: 1,
      type: "login.probe.configure",
      origin,
      account: {
        connectionId: accepted.connectionId,
        itemId: item.id,
        slots: [
          { slot: "branch", fieldId: `custom.${accepted.snapshotId}.0` },
          { slot: "account", fieldId: `custom.${accepted.snapshotId}.1` },
          { slot: "password", fieldId: "login.password" },
        ],
      },
    }),
  ).toEqual({ ok: true });
  const settings = saved.snapshot.settings;
  settings.siteDefaults = [
    { origin, provider: connection.provider, userId: connection.userId, itemId: item.id },
  ];
  await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: saved.snapshot.revision,
    settings,
  });
  return accepted.connectionId;
}

function activity(background: Worker) {
  return background.evaluate(async (key) => {
    const { chrome } = globalThis as unknown as { chrome: StorageChrome };
    return (await chrome.storage.session.get(key))[key] as
      | { lastUsedAt: number; locked?: true }
      | undefined;
  }, ACTIVITY_KEY);
}

async function autoUnlock(options: Page, connectionId: string) {
  const status = await setupRequest(options, { type: "connection.status" });
  if (!status.ok || status.kind !== "status") throw new Error("Synthetic status unavailable");
  return status.connections.find((entry) => entry.connectionId === connectionId)?.autoUnlock;
}

test("the vault timeout locks an unused vault before the next login uses it", async () => {
  const fixture = await startLoginFixture(0, { password: vaultPassword });
  try {
    await withVaultProfile(async (open) => {
      const browser = await open();
      await setupProbe(browser.page, { action: "configure", variant: "unchanged" });
      const options = await browser.context.newPage();
      await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
      const connectionId = await connectAndBind(options, fixture.origin);
      expect(await autoUnlock(options, connectionId)).toBe("enabled");

      // A one-minute timeout, written as the settings page writes it; the worker counts
      // it from the change.
      const changed = Date.now();
      await browser.background.evaluate(
        async ([key, value]) => {
          const { chrome } = globalThis as unknown as { chrome: StorageChrome };
          await chrome.storage.local.set({ [key]: value });
        },
        [TIMEOUT_KEY, 1] as const,
      );
      await expect
        .poll(async () => (await activity(browser.background))?.lastUsedAt ?? 0)
        .toBeGreaterThanOrEqual(changed);

      // Used within the minute: the login fills from the vault.
      const recent = fixture.createRun();
      const first = await browser.context.newPage();
      await first.goto(`${fixture.origin}/identity?runId=${recent}`);
      await expect(first.locator("#authenticated")).toBeVisible();
      expect(fixture.evidence(recent)).toMatchObject({ posts: 1, allMatched: true });
      expect(await autoUnlock(options, connectionId)).toBe("enabled");

      // The last use was two minutes ago: the next vault use locks it first.
      await browser.background.evaluate(
        async ([key, value]) => {
          const { chrome } = globalThis as unknown as { chrome: StorageChrome };
          await chrome.storage.session.set({ [key]: value });
        },
        [ACTIVITY_KEY, { lastUsedAt: Date.now() - 2 * 60_000 }] as const,
      );
      const stale = fixture.createRun();
      const second = await browser.context.newPage();
      await second.goto(`${fixture.origin}/identity?runId=${stale}`);
      await expect.poll(() => autoUnlock(options, connectionId)).toBe("disabled");
      await expect.poll(async () => (await activity(browser.background))?.locked).toBe(true);
      await second.waitForTimeout(1000);
      await expect(second.locator("#branch")).toHaveValue("");
      await expect(second.locator("#account")).toHaveValue("");
      await expect(second.locator("#authenticated")).toHaveCount(0);
      expect(fixture.evidence(stale).posts).toBe(0);
    });
  } finally {
    await fixture.close();
  }
});

test("the vault timeout locks on a browser restart unless it is set to never", async () => {
  await withVaultProfile(async (open) => {
    const first = await open();
    await setupProbe(first.page, { action: "configure", variant: "unchanged" });
    const options = await first.context.newPage();
    await options.goto(`chrome-extension://${first.extensionId}/options.html`);
    const accepted = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput(),
    });
    if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
    const { connectionId } = accepted;

    // The default, never: a restart keeps automatic unlock.
    const kept = await open();
    const keptOptions = await kept.context.newPage();
    await keptOptions.goto(`chrome-extension://${kept.extensionId}/options.html`);
    expect(await autoUnlock(keptOptions, connectionId)).toBe("enabled");
    await kept.background.evaluate(
      async ([key, value]) => {
        const { chrome } = globalThis as unknown as { chrome: StorageChrome };
        await chrome.storage.local.set({ [key]: value });
      },
      [TIMEOUT_KEY, "restart"] as const,
    );
    await expect.poll(async () => (await activity(kept.background))?.lastUsedAt).toBeDefined();
    // The same session keeps it unlocked.
    expect(await autoUnlock(keptOptions, connectionId)).toBe("enabled");

    // A new browser session has no activity record, so the worker locks at start.
    const restarted = await open();
    const restartedOptions = await restarted.context.newPage();
    await restartedOptions.goto(`chrome-extension://${restarted.extensionId}/options.html`);
    await expect.poll(() => autoUnlock(restartedOptions, connectionId)).toBe("disabled");
    await expect.poll(async () => (await activity(restarted.background))?.locked).toBe(true);
  });
});
