import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  newLayoutKey,
  toLoginLayout,
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
const password = "test_password";
const recipeId = "synthetic-manual-single";

async function configure(browser: VaultBrowser, fixture: { origin: string }) {
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
      recipeId,
      ...account,
      itemName: item.label,
      slots: [{ slot: "password", field: "password" }],
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

  const recipe: LoginRecipe = {
    version: 1,
    id: recipeId,
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
          id: recipeId,
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
  await expect(popup.locator("#popup-origin")).toHaveText("synthetic.example.test");
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

test("Log in now hands an idle profile autofill to one normal login without changing page behavior", async () => {
  const fixture = await startLoginFixture(0, { password });
  try {
    await withVaultProfile(async (open) => {
      const browser = await open();
      const { options, accountValue } = await configure(browser, fixture);
      const site = await browser.context.newPage();
      await site.goto(`${origin}/single`);
      await expect(site.getByLabel("Password", { exact: true })).toHaveValue(password);
      await idle(options);
      expect(await submissions(site)).toBe(0);
      const popup = await openPopup(browser.context, options, site, browser.extensionId);
      await finishFromPopup(options, site, popup, accountValue);
    });
  } finally {
    await fixture.close();
  }
});

test("Log in now refuses an in-flight passive fill and becomes available only after it is idle", async () => {
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
      await idle(options);
      await finishFromPopup(options, site, popup, accountValue);
    });
  } finally {
    await fixture.close();
  }
});
