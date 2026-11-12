import { expect, test } from "@playwright/test";
import { parseLoginRecipe, toLoginLayout } from "../../packages/contracts/src/index";
import {
  beginInput,
  catalogAccount,
  settingsRequest,
  setupProbe,
  setupRequest,
  useOnly,
} from "./connection-fixture";
import { sendToBackground as send } from "./background-message";
import { withVaultProfile } from "./vault-fixture";

test("a packaged popup repairs stale custom binding names and saves only after the synthetic page signs in", async () => {
  const origin = "https://synthetic.example.test";
  await withVaultProfile(async (open) => {
    const browser = await open();
    await browser.context.route(`${origin}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en"><title>Synthetic binding repair</title>
        <form><label>Branch<input id="branch"></label><label>Password<input id="password" type="password"></label><button id="login" type="button">Sign in</button></form>
        <script>document.querySelector('#login').onclick=()=>{if(document.querySelector('#branch').value==='007'&&document.querySelector('#password').value==='test_password'){document.querySelector('form').remove();const marker=document.createElement('p');marker.id='authenticated';marker.textContent='Signed in';document.body.append(marker)}}</script></html>`,
      }),
    );
    await setupProbe(browser.page, { action: "configure", variant: "uri" });
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    const accepted = await setupRequest(options, { type: "connection.begin", input: beginInput() });
    if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
    const current = await settingsRequest(options);
    const connection = current.catalog.connections.find(
      (entry) => entry.id === accepted.connectionId,
    )!;
    const item = connection.items[0]!;
    const account = catalogAccount(current.catalog, connection.id);
    const settings = useOnly(current.snapshot.settings, current.catalog, connection.id);
    settings.siteDefaults = [{ origin, ...account, itemId: item.id }];
    const binding = {
      recipeId: "synthetic-binding-repair",
      origin,
      ...account,
      itemId: item.id,
      itemName: item.label,
      slots: [
        { slot: "branch", field: { custom: "Removed branch" } },
        { slot: "password", field: "password" as const },
      ],
    };
    settings.bindings = [binding];
    await settingsRequest(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: current.snapshot.revision,
      settings,
    });
    const recipe = parseLoginRecipe({
      version: 1,
      id: binding.recipeId,
      revision: 1,
      origin,
      pageKind: "sign-in",
      slots: ["branch", "password"],
      steps: [
        {
          kind: "fill",
          path: "/repair",
          fields: [
            { slot: "branch", target: { by: "id", value: "branch" } },
            { slot: "password", target: { by: "id", value: "password" } },
          ],
        },
        { kind: "click", path: "/repair", target: { by: "id", value: "login" }, purpose: "submit" },
      ],
      completion: [{ target: { by: "id", value: "authenticated" } }],
      maxSubmissions: 1,
    });
    await options.evaluate(
      async (document) => {
        const { chrome } = globalThis as unknown as {
          chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
        };
        await chrome.storage.local.set({
          "pateat.device-recipes.v1": { version: 1, recipes: [document] },
        });
      },
      {
        version: 1,
        id: recipe.id,
        revision: 1,
        origin,
        layouts: [toLoginLayout(recipe, { key: "1000", createdAt: 1000 })],
      },
    );
    const page = await browser.context.newPage();
    await page.goto(`${origin}/repair`);
    await expect
      .poll(() => send(options, { version: 1, type: "login.probe.status" }))
      .toMatchObject({ documents: [expect.objectContaining({ reason: "field-missing" })] });
    await expect(page.locator("#branch")).toHaveValue("");
    await expect(page.locator("#password")).toHaveValue("");
    const opened = browser.context.waitForEvent("page", (entry) =>
      entry.url().endsWith("/popup.html"),
    );
    await options.evaluate(async (url) => {
      const { chrome } = globalThis as unknown as {
        chrome: { tabs: { create(value: { url: string; active: boolean }): Promise<unknown> } };
      };
      await chrome.tabs.create({ url, active: false });
    }, `chrome-extension://${browser.extensionId}/popup.html`);
    const popup = await opened;
    await expect(popup.locator("#popup-origin")).toHaveText("synthetic.example.test");
    const field = popup.getByRole("combobox", { name: "Input 1: Removed branch", exact: true });
    await expect(field).toBeVisible();
    await expect(popup.locator("body")).not.toContainText("test_password");
    await expect(popup.locator("body")).not.toContainText("00001234");
    const candidate = `custom.${accepted.snapshotId}.0`;
    await expect(field.locator(`option[value="${candidate}"]`)).toHaveText(
      `${item.fields.find((entry) => entry.id === candidate)!.name} (1/3)`,
    );
    expect((await settingsRequest(options)).snapshot.settings.bindings).toEqual([binding]);
    await field.selectOption(candidate);
    await popup.getByRole("button", { name: "Use these fields and retry", exact: true }).click();
    await expect(page.locator("#authenticated")).toBeVisible();
    await expect
      .poll(
        async () => (await settingsRequest(options)).snapshot.settings.bindings[0]!.slots[0]!.field,
      )
      .toEqual({
        custom: item.fields.find((entry) => entry.id === candidate)!.name,
        position: 1,
        count: 3,
      });
  });
});
