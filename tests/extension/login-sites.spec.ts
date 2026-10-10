import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { SettingsResponse } from "../../packages/contracts/src/index";
import { withLoginExtension } from "./login-fixture";

type Status = { documents: { origin: string; state?: string; reason?: string }[] };

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

/** Synthetic HTTPS sites served by Playwright; no request leaves the test browser. */
async function serveSites(context: BrowserContext) {
  await context.route(/^https:\/\/(login|other)\.example\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html lang="en"><title>Synthetic HTTPS login</title><label>Password<input id="password" type="password"></label><button id="login" type="button">Log in</button></html>',
    }),
  );
}

test("the HTTPS login script is admitted only on an exact saved-default origin", async () => {
  await withLoginExtension(async (context, _worker, id) => {
    await serveSites(context);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
    const current = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
    if (!current.ok) throw new Error("Synthetic settings unavailable");
    const settings = current.snapshot.settings;
    settings.siteDefaults = [
      { origin: "https://login.example", connectionId: "demo-personal", itemId: "primary" },
    ];
    const saved = (await send(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: current.snapshot.revision,
      settings,
    })) as SettingsResponse;
    expect(saved.ok).toBe(true);

    const admitted = await context.newPage();
    await admitted.goto("https://login.example/signin");
    // No saved recipe exists yet, so the admitted document stops before observation.
    await expect
      .poll(async () => (await send(options, { version: 1, type: "login.probe.status" })) as Status)
      .toMatchObject({
        documents: [
          { origin: "https://login.example", state: "denied", reason: "recipe-not-found" },
        ],
      });

    const other = await context.newPage();
    await other.goto("https://other.example/signin");
    await expect(other.locator("#password")).toBeVisible();
    // The other origin's hello is refused before a document entry is created.
    await other.waitForTimeout(500);
    const status = (await send(options, { version: 1, type: "login.probe.status" })) as Status;
    expect(status.documents.map((entry) => entry.origin)).toEqual(["https://login.example"]);
    await expect(admitted.locator("#password")).toHaveValue("");
    await expect(other.locator("#password")).toHaveValue("");
  });
});
