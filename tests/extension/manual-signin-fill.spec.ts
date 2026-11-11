import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { SettingsResponse } from "../../packages/contracts/src/index";
import { sendToBackground as send } from "./background-message";
import { withLoginExtension } from "./login-fixture";
import { startLoginFixture } from "./login-server";

async function configure(options: Page, extensionId: string, origin: string) {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
  expect(await send(options, { version: 1, type: "login.probe.configure", origin })).toMatchObject({
    ok: true,
  });
  const read = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
  if (!read.ok) throw new Error("Synthetic settings unavailable");
  const settings = read.snapshot.settings;
  settings.pagePermissionDefaults = {
    "sign-in": "fill",
    confirm: "fill",
    "personal-details": "fill",
  };
  settings.siteDefaults = [
    {
      origin,
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    },
  ];
  expect(
    await send(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: read.snapshot.revision,
      settings,
    }),
  ).toMatchObject({ ok: true });
}
async function status(options: Page) {
  return send(options, { version: 1, type: "login.probe.status" });
}
async function idle(options: Page) {
  await expect
    .poll(() => status(options))
    .toMatchObject({
      attempts: [{ signInFill: true, state: "ready", stepIndex: 1, submissions: 0 }],
    });
}
const submissions = (page: Page) =>
  page.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0));

/** As in the packaged toolbar test, leave the actual website active in this window. */
async function openPopup(context: BrowserContext, options: Page, site: Page, extensionId: string) {
  await site.bringToFront();
  const opened = context.waitForEvent("page");
  await options.evaluate(async (url) => {
    const chrome = (
      globalThis as unknown as {
        chrome: { tabs: { create(options: { url: string; active: boolean }): Promise<unknown> } };
      }
    ).chrome;
    await chrome.tabs.create({ url, active: false });
  }, `chrome-extension://${extensionId}/popup.html`);
  const popup = await opened;
  await expect(popup).toHaveURL(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#popup-origin")).toHaveText("127.0.0.1");
  return popup;
}
async function unchangedFillPolicy(options: Page) {
  const read = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
  expect(read).toMatchObject({
    ok: true,
    snapshot: {
      settings: {
        pagePermissionDefaults: { "sign-in": "fill", confirm: "fill", "personal-details": "fill" },
      },
    },
  });
}

async function finishFromPopup(options: Page, site: Page, popup: Page) {
  await popup
    .getByRole("combobox", { name: "Account to log in with", exact: true })
    .selectOption(JSON.stringify(["demo-personal", "primary"]));
  const button = popup.getByRole("button", { name: "Log in now", exact: true });
  await expect(button).toBeEnabled();
  expect(await submissions(site)).toBe(0);
  await button.click();
  await expect(site.locator("#authenticated")).toBeVisible();
  await expect.poll(() => submissions(site)).toBe(1);
  await expect
    .poll(() => status(options))
    .toMatchObject({ attempts: [{ state: "authenticated", submissions: 1 }] });
  const after = (await status(options)) as { attempts: Record<string, unknown>[] };
  expect(after.attempts[0]).not.toHaveProperty("signInFill");
  await unchangedFillPolicy(options);
}

test("Log in now hands an idle profile autofill to one normal login without changing page behavior", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      const site = await context.newPage();
      await site.goto(`${fixture.origin}/single`);
      await expect(site.getByLabel("Password", { exact: true })).toHaveValue(
        "Pateat-synthetic-only!",
      );
      await idle(options);
      expect(await submissions(site)).toBe(0);
      const popup = await openPopup(context, options, site, id);
      await finishFromPopup(options, site, popup);
    });
  } finally {
    await fixture.close();
  }
});

test("Log in now refuses an in-flight passive fill and becomes available only after it is idle", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await configure(options, id, fixture.origin);
      expect(
        await send(options, {
          version: 1,
          type: "login.probe.control",
          action: "arm",
          checkpoint: "before-delivery",
        }),
      ).toMatchObject({ ok: true });
      const site = await context.newPage();
      await site.goto(`${fixture.origin}/single`);
      await expect
        .poll(() => status(options))
        .toMatchObject({
          checkpoint: "before-delivery",
          attempts: [
            { signInFill: true, operationKind: "fill", mutationIntent: true, submissions: 0 },
          ],
        });
      const popup = await openPopup(context, options, site, id);
      await expect(popup.getByRole("button", { name: "Log in now", exact: true })).toBeDisabled();
      await expect(popup.locator("#popup-manual-status")).toHaveText(
        "Another login is still running. Finish or stop it, then try again.",
      );
      await expect(site.getByLabel("Password", { exact: true })).toHaveValue("");
      expect(await submissions(site)).toBe(0);
      expect(
        await send(options, { version: 1, type: "login.probe.control", action: "release" }),
      ).toMatchObject({ ok: true });
      await expect(site.getByLabel("Password", { exact: true })).toHaveValue(
        "Pateat-synthetic-only!",
      );
      await idle(options);
      await finishFromPopup(options, site, popup);
    });
  } finally {
    await fixture.close();
  }
});
