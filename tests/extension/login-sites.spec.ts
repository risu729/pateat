import { expect, test, type BrowserContext } from "@playwright/test";
import type { SettingsResponse } from "../../packages/contracts/src/index";
import { withLoginExtension } from "./login-fixture";
import { sendToBackground as send } from "./background-message";
import { startLoginFixture } from "./login-server";

type Status = { documents: { origin: string; state?: string; reason?: string }[] };

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

test("the HTTPS login script admits non-excluded sites and stops without a recipe", async () => {
  await withLoginExtension(async (context, _worker, id) => {
    await serveSites(context);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
    const current = (await send(options, { version: 1, type: "settings.get" })) as SettingsResponse;
    if (!current.ok) throw new Error("Synthetic settings unavailable");
    const settings = current.snapshot.settings;
    // No saved default: an account can also be chosen by a single URI match (ADR 0013).
    settings.siteDefaults = [];
    settings.excludedSites = [{ hostname: "other.example", includeSubdomains: false }];
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
    // The excluded site's hello is refused before a document entry is created.
    await other.waitForTimeout(500);
    const status = (await send(options, { version: 1, type: "login.probe.status" })) as Status;
    expect(status.documents.map((entry) => entry.origin)).toEqual(["https://login.example"]);
    await expect(admitted.locator("#password")).toHaveValue("");
    await expect(other.locator("#password")).toHaveValue("");
  });
});

test("with the allowlist on, a site it leaves out gets no login until it is allowed", async () => {
  const fixture = await startLoginFixture();
  try {
    await withLoginExtension(async (context, _worker, id) => {
      const options = await context.newPage();
      await options.goto(`chrome-extension://${id}/options.html`);
      await expect(options.locator("#settings-status")).toContainText("Saved settings loaded");
      expect(
        await send(options, { version: 1, type: "login.probe.configure", origin: fixture.origin }),
      ).toMatchObject({ ok: true });
      const save = async (allowedSites: { hostname: string; includeSubdomains: boolean }[]) => {
        const current = (await send(options, {
          version: 1,
          type: "settings.get",
        })) as SettingsResponse;
        if (!current.ok) throw new Error("Synthetic settings unavailable");
        const settings = current.snapshot.settings;
        settings.siteDefaults = [
          {
            origin: fixture.origin,
            provider: "dummy",
            userId: "demo-personal-account",
            itemId: "primary",
          },
        ];
        settings.allowedSites = allowedSites;
        const saved = (await send(options, {
          version: 1,
          type: "settings.save",
          expectedRevision: current.snapshot.revision,
          settings,
        })) as SettingsResponse;
        expect(saved.ok).toBe(true);
      };
      // The allowlist is on and names only another site.
      await save([{ hostname: "other.example", includeSubdomains: true }]);
      const refused = fixture.createRun();
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/input-advance?runId=${refused}`);
      await expect(page.locator("#account")).toBeVisible();
      // A refused page creates no attempt; wait as the excluded-site test above does.
      await page.waitForTimeout(1000);
      const status = (await send(options, { version: 1, type: "login.probe.status" })) as {
        attempts: unknown[];
      };
      expect(status.attempts).toEqual([]);
      expect(fixture.evidence(refused).posts).toBe(0);
      await expect(page.locator("#account")).toHaveValue("");

      // Allowing the site lets the same page log in.
      await save([{ hostname: "127.0.0.1", includeSubdomains: false }]);
      const allowed = fixture.createRun();
      const again = await context.newPage();
      await again.goto(`${fixture.origin}/input-advance?runId=${allowed}`);
      await expect(again.locator("#authenticated")).toBeVisible();
      expect(fixture.evidence(allowed).allMatched).toBe(true);
    });
  } finally {
    await fixture.close();
  }
});
