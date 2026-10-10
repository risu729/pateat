import { expect, test, type Page } from "@playwright/test";
import type { SettingsResponse } from "../../packages/contracts/src/index";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { startLoginFixture } from "./login-server";
import { withVaultProfile } from "./vault-fixture";

// The synthetic Bitwarden item: custom field 0 is "007", hidden custom field 1 is
// "00001234" and the login password is "test_password". The fixture site expects them.
const vaultPassword = "test_password";

async function send(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate(
    async (request) =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(value: unknown): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage(request),
    message,
  );
}

/** Connect the synthetic vault, bind its fields explicitly and save one exact-origin default. */
async function connectAndBind(options: Page, origin: string) {
  const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
  if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
  const saved = await settingsRequest(options);
  const item = saved.catalog.connections.find((entry) => entry.id === accepted.connectionId)
    ?.items[0];
  if (!item) throw new Error("Synthetic vault item missing");
  // Live metadata grants no origin by itself; the probe supplies only its loopback origin.
  expect(item.allowedOrigins).toEqual([]);
  const account = { connectionId: accepted.connectionId, itemId: item.id };
  expect(
    await send(options, {
      version: 1,
      type: "login.probe.configure",
      origin,
      account: {
        ...account,
        slots: [
          { slot: "branch", fieldId: `custom.${accepted.snapshotId}.0` },
          { slot: "account", fieldId: `custom.${accepted.snapshotId}.1` },
          { slot: "password", fieldId: "login.password" },
        ],
      },
    }),
  ).toEqual({ ok: true });
  const settings = saved.snapshot.settings;
  settings.siteDefaults = [{ origin, ...account }];
  const stored = await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: saved.snapshot.revision,
    settings,
  });
  return { ...account, snapshotId: accepted.snapshotId, revision: stored.snapshot.revision };
}

test("explicitly bound live vault fields complete a multi-page login, including after a full browser restart", async () => {
  const fixture = await startLoginFixture(0, { password: vaultPassword });
  try {
    await withVaultProfile(async (open) => {
      const first = await open();
      await setupProbe(first.page, { action: "configure", variant: "unchanged" });
      const options = await first.context.newPage();
      await options.goto(`chrome-extension://${first.extensionId}/options.html`);
      await connectAndBind(options, fixture.origin);
      const runId = fixture.createRun();
      const page = await first.context.newPage();
      await page.goto(`${fixture.origin}/identity?runId=${runId}`);
      await expect(page.locator("#authenticated")).toBeVisible();
      expect(fixture.evidence(runId)).toEqual({
        posts: 1,
        inputPosts: 0,
        clickPosts: 1,
        allMatched: true,
      });
      // The page can show completion before the background records the attempt outcome.
      await expect
        .poll(() => send(options, { version: 1, type: "login.probe.status" }))
        .toMatchObject({
          attempts: [{ state: "authenticated", outcome: "authenticated", submissions: 2 }],
        });

      // The cache restores offline; persisted settings, binding and default still apply.
      const reopened = await open();
      const status = await setupProbe(reopened.page, { action: "status" });
      expect(status.calls).toBe(0);
      const again = fixture.createRun();
      const restarted = await reopened.context.newPage();
      await restarted.goto(`${fixture.origin}/identity?runId=${again}`);
      await expect(restarted.locator("#authenticated")).toBeVisible();
      expect(fixture.evidence(again)).toMatchObject({ posts: 1, allMatched: true });
    });
  } finally {
    await fixture.close();
  }
});

test("a saved live field exclusion refuses the attempt before any page observation or fill", async () => {
  const fixture = await startLoginFixture(0, { password: vaultPassword });
  try {
    await withVaultProfile(async (open) => {
      const browser = await open();
      await setupProbe(browser.page, { action: "configure", variant: "unchanged" });
      const options = await browser.context.newPage();
      await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
      const bound = await connectAndBind(options, fixture.origin);
      const current = await settingsRequest(options);
      const settings = current.snapshot.settings;
      settings.connections = settings.connections.map((entry) =>
        entry.connectionId === bound.connectionId
          ? {
              ...entry,
              excludedFields: [{ itemId: bound.itemId, fieldId: "login.password" }],
            }
          : entry,
      );
      const saved = (await send(options, {
        version: 1,
        type: "settings.save",
        expectedRevision: current.snapshot.revision,
        settings,
      })) as SettingsResponse;
      expect(saved.ok).toBe(true);
      const runId = fixture.createRun();
      const page = await browser.context.newPage();
      await page.goto(`${fixture.origin}/identity?runId=${runId}`);
      await expect
        .poll(async () => send(options, { version: 1, type: "login.probe.status" }))
        .toMatchObject({ attempts: [], documents: [{ reason: "binding-field-excluded" }] });
      await expect(page.locator("#branch")).toHaveValue("");
      await expect(page.locator("#account")).toHaveValue("");
      expect(fixture.evidence(runId).posts).toBe(0);
    });
  } finally {
    await fixture.close();
  }
});

test("disabling the live connection during an attempt stops delivery of resolved fields", async () => {
  const fixture = await startLoginFixture(0, { password: vaultPassword });
  try {
    await withVaultProfile(async (open) => {
      const browser = await open();
      await setupProbe(browser.page, { action: "configure", variant: "unchanged" });
      const options = await browser.context.newPage();
      await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
      const bound = await connectAndBind(options, fixture.origin);
      expect(
        await send(options, {
          version: 1,
          type: "login.probe.control",
          action: "arm",
          checkpoint: "before-delivery",
        }),
      ).toEqual({ ok: true });
      const runId = fixture.createRun();
      const page = await browser.context.newPage();
      await page.goto(`${fixture.origin}/identity?runId=${runId}`);
      // Values for the first fill were resolved; the executor is paused before delivery.
      await expect
        .poll(async () => send(options, { version: 1, type: "login.probe.status" }))
        .toMatchObject({ checkpoint: "before-delivery" });
      expect(
        await setupRequest(options, {
          type: "connection.disable",
          connectionId: bound.connectionId,
        }),
      ).toMatchObject({ ok: true, kind: "disabled" });
      expect(
        await send(options, { version: 1, type: "login.probe.control", action: "release" }),
      ).toEqual({ ok: true });
      await expect
        .poll(async () => send(options, { version: 1, type: "login.probe.status" }))
        .toMatchObject({ attempts: [{ state: "blocked", outcome: "policy-changed" }] });
      await expect(page.locator("#branch")).toHaveValue("");
      await expect(page.locator("#account")).toHaveValue("");
      expect(fixture.evidence(runId).posts).toBe(0);
    });
  } finally {
    await fixture.close();
  }
});
