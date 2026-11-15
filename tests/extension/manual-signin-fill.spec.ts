import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  newLayoutKey,
  toLoginLayout,
  type LocalSettings,
  type LoginRecipe,
  type SettingsResponse,
} from "../../packages/contracts/src/index";
import { sendToBackground as send } from "./background-message";
import {
  beginInput,
  catalogAccount,
  settingsRequest,
  setupProbe,
  setupRequest,
  useOnly,
} from "./connection-fixture";
import { startLoginFixture } from "./login-server";
import { withVaultProfile, type VaultBrowser } from "./vault-fixture";

const origin = "https://synthetic.example.test";
// The synthetic Bitwarden item's login username and password.
const username = "test_username";
const password = "test_password";
/** One page whose last safe fill ends the profile autofill. */
const single: LoginRecipe = {
  version: 1,
  id: "synthetic-manual-single",
  revision: 1,
  origin,
  pageKind: "sign-in",
  slots: ["password"],
  steps: [
    {
      kind: "fill",
      path: "/single",
      effect: "prepare",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
    { kind: "click", path: "/single", target: { by: "id", value: "login" }, purpose: "submit" },
  ],
  completion: [{ target: { by: "id", value: "authenticated" } }],
  rejection: { by: "id", value: "rejected" },
  maxSubmissions: 1,
};
/**
 * An identifier-first form whose password shows in the same document after Next: the
 * profile autofill fills the account, then parks on its read-only wait for the password.
 */
const identifierFirst: LoginRecipe = {
  version: 1,
  id: "synthetic-manual-identifier-first",
  revision: 1,
  origin,
  pageKind: "sign-in",
  slots: ["account", "password"],
  steps: [
    {
      kind: "fill",
      path: "/identifier-first",
      effect: "prepare",
      fields: [{ slot: "account", target: { by: "id", value: "account" } }],
    },
    {
      kind: "click",
      path: "/identifier-first",
      target: { by: "id", value: "next" },
      purpose: "advance",
    },
    {
      kind: "fill",
      path: "/identifier-first",
      effect: "prepare",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
    {
      kind: "click",
      path: "/identifier-first",
      target: { by: "id", value: "login" },
      purpose: "submit",
    },
  ],
  completion: [{ target: { by: "id", value: "signed-in" } }],
  rejection: { by: "id", value: "rejected" },
  maxSubmissions: 2,
};

async function configure(
  browser: VaultBrowser,
  fixture: { origin: string },
  recipe: LoginRecipe = single,
  slots: LocalSettings["bindings"][number]["slots"] = [{ slot: "password", field: "password" }],
) {
  // The existing encrypted URI fixture matches this HTTPS origin. Requests stay local.
  await browser.context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `${fixture.origin}${url.pathname}${url.search}`,
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
  await setupProbe(browser.page, { action: "configure", variant: "uri" });
  const options = await browser.context.newPage();
  await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
  const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
  if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
  const initial = await settingsRequest(options);
  const connection = initial.catalog.connections.find(
    (entry) => entry.id === accepted.connectionId,
  );
  const item = connection?.items[0];
  if (!connection?.userId || !item) throw new Error("Synthetic vault item missing");
  const account = { ...catalogAccount(initial.catalog, connection.id), itemId: item.id };
  const settings = useOnly(initial.snapshot.settings, initial.catalog, connection.id);
  settings.pagePermissionDefaults = {
    "sign-in": "fill",
    confirm: "fill",
    "personal-details": "fill",
  };
  settings.siteDefaults = [{ origin, ...account }];
  settings.bindings = [
    {
      origin,
      recipeId: recipe.id,
      ...account,
      itemName: item.label,
      slots,
    },
  ];
  await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: initial.snapshot.revision,
    settings,
  });
  expect(
    await send(options, { version: 1, type: "settings.site-accounts", origin, settings }),
  ).toMatchObject({
    ok: true,
    complete: true,
    accounts: [{ connectionId: connection.id, itemId: item.id, uri: true }],
  });

  const createdAt = Date.now();
  // A known recipe in the normal device-owned store; no service or generation bypass.
  await browser.background.evaluate(
    async (record) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
        }
      ).chrome;
      await chrome.storage.local.set({ "pateat.device-recipes.v1": record });
    },
    {
      version: 1,
      recipes: [
        {
          version: 1,
          id: recipe.id,
          revision: 1,
          origin,
          layouts: [toLoginLayout(recipe, { key: newLayoutKey(createdAt, []), createdAt })],
        },
      ],
    },
  );
  return { options, accountValue: JSON.stringify([connection.id, item.id]) };
}
const status = (options: Page) => send(options, { version: 1, type: "login.probe.status" });
/** The profile autofill filled the page's last safe field and ended, pressing nothing. */
async function filled(options: Page) {
  await expect
    .poll(() => status(options))
    .toMatchObject({
      attempts: [
        { signInFill: true, state: "blocked", fillDone: true, stepIndex: 1, submissions: 0 },
      ],
    });
}
const submissions = (page: Page) =>
  page.evaluate(() => Number(sessionStorage.getItem("submitClicks") || 0));

/** As in the packaged toolbar test, leave the actual website active in this window. */
async function openPopup(
  context: BrowserContext,
  options: Page,
  site: Page,
  extensionId: string,
  host = "synthetic.example.test",
) {
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
  await expect(popup.locator("#popup-origin")).toHaveText(host);
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
async function finishFromPopup(options: Page, site: Page, popup: Page, accountValue: string) {
  const account = popup.getByRole("combobox", { name: "Account to log in with", exact: true });
  await expect(account).toBeVisible();
  await account.selectOption(accountValue);
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

test("Log in now refuses an in-flight passive fill and becomes available only after it ends", async () => {
  const fixture = await startLoginFixture(0, { password });
  try {
    await withVaultProfile(async (open) => {
      const browser = await open();
      const { options, accountValue } = await configure(browser, fixture);
      expect(
        await send(options, {
          version: 1,
          type: "login.probe.control",
          action: "arm",
          checkpoint: "before-delivery",
        }),
      ).toMatchObject({ ok: true });
      const site = await browser.context.newPage();
      await site.goto(`${origin}/single`);
      await expect
        .poll(() => status(options))
        .toMatchObject({
          checkpoint: "before-delivery",
          attempts: [
            { signInFill: true, operationKind: "fill", mutationIntent: true, submissions: 0 },
          ],
        });
      const popup = await openPopup(browser.context, options, site, browser.extensionId);
      await expect(popup.getByRole("button", { name: "Log in now", exact: true })).toBeDisabled();
      await expect(popup.locator("#popup-manual-status")).toHaveText(
        "Another login is still running. Finish or stop it, then try again.",
      );
      await expect(site.getByLabel("Password", { exact: true })).toHaveValue("");
      expect(await submissions(site)).toBe(0);
      expect(
        await send(options, { version: 1, type: "login.probe.control", action: "release" }),
      ).toMatchObject({ ok: true });
      await expect(site.getByLabel("Password", { exact: true })).toHaveValue(password);
      await filled(options);
      await finishFromPopup(options, site, popup, accountValue);
    });
  } finally {
    await fixture.close();
  }
});

test("Log in now takes over a profile autofill parked on its read-only wait", async () => {
  const fixture = await startLoginFixture(0, { password, accountName: username });
  try {
    await withVaultProfile(async (open) => {
      const browser = await open();
      const { options, accountValue } = await configure(browser, fixture, identifierFirst, [
        { slot: "account", field: "username" },
        { slot: "password", field: "password" },
      ]);
      const site = await browser.context.newPage();
      // With `account`, the page expects the item's username and signs in to /account.
      await site.goto(`${origin}/identifier-first?account=1`);
      await expect(site.locator("#account")).toHaveValue(username);
      await expect
        .poll(() => status(options))
        .toMatchObject({
          attempts: [{ signInFill: true, state: "ready", stepIndex: 1, submissions: 0 }],
        });
      const clicks = () =>
        site.evaluate(() => ({
          next: Number(sessionStorage.getItem("identityClicks") || 0),
          submit: Number(sessionStorage.getItem("submitClicks") || 0),
        }));
      expect(await clicks()).toEqual({ next: 0, submit: 0 });
      const popup = await openPopup(browser.context, options, site, browser.extensionId);
      const account = popup.getByRole("combobox", { name: "Account to log in with", exact: true });
      await account.selectOption(accountValue);
      await popup.getByRole("button", { name: "Log in now", exact: true }).click();
      await expect(site.locator("#signed-in")).toBeVisible();
      expect(await clicks()).toEqual({ next: 1, submit: 1 });
      const after = (await status(options)) as { attempts: Record<string, unknown>[] };
      expect(after.attempts).toHaveLength(1);
      expect(after.attempts[0]).not.toHaveProperty("signInFill");
      await unchangedFillPolicy(options);
    });
  } finally {
    await fixture.close();
  }
});
