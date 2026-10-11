import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { startLoginFixture } from "./login-server";
import { startSyncService } from "./sync-service";
import { withVaultProfile } from "./vault-fixture";

// The synthetic Bitwarden item stores the URI https://synthetic.example.test/login, so
// the production executor may choose it on that site without a saved default. Its
// custom fields share the name "duplicate": the first is "007", the second (Hidden) is
// "00001234". The login password is "test_password". The fixture site expects them.
const site = "https://synthetic.example.test";
const recipeId = "synthetic-identity";

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

/** The synthetic HTTPS site is served by the loopback fixture; nothing leaves the browser. */
async function serveSite(context: BrowserContext, fixture: { origin: string }) {
  await context.route(`${site}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.origin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

const target = (value: string) => ({ by: "id", value });
/** The multi-page fixture flow, published the way a generated recipe is (ADR 0013). */
const recipe = {
  version: 1,
  id: recipeId,
  revision: 1,
  origin: site,
  slots: ["branch", "account", "password"],
  steps: [
    {
      kind: "fill",
      path: "/identity",
      fields: [
        { slot: "branch", target: target("branch") },
        { slot: "account", target: target("account") },
      ],
    },
    { kind: "assert", path: "/identity", target: target("next"), present: true },
    { kind: "click", path: "/identity", target: target("next"), purpose: "advance" },
    { kind: "wait", path: "/password", target: target("password"), present: true, timeoutMs: 3000 },
    { kind: "fill", path: "/password", fields: [{ slot: "password", target: target("password") }] },
    { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
  ],
  completion: { path: "/authenticated", target: target("authenticated") },
  rejection: target("rejected"),
  maxSubmissions: 2,
};

function storedRecipes(background: Worker) {
  return background.evaluate(
    async () =>
      (
        await (
          globalThis as unknown as {
            chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
          }
        ).chrome.storage.local.get("pateat.sync-recipes.v1")
      )["pateat.sync-recipes.v1"],
  );
}

test("a recipe and binding synced from the service log in with the live vault and upload the chosen account", async () => {
  const fixture = await startLoginFixture(0, { password: "test_password" });
  const service = await startSyncService();
  try {
    await withVaultProfile(
      async (open, externalRequests) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        await setupProbe(browser.page, { action: "configure", variant: "uri" });
        const options = await browser.context.newPage();
        await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
        const accepted = await setupRequest(options, {
          type: "connection.begin",
          input: beginInput(),
        });
        if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
        const initial = await settingsRequest(options);
        // The probe build's bundled demo vaults cannot answer URI queries; a choice by URI
        // match refuses while any enabled connection is unanswered, so leave only Bitwarden.
        const settings = initial.snapshot.settings;
        settings.connections = settings.connections.map((entry) => ({
          ...entry,
          enabled: entry.connectionId === accepted.connectionId,
        }));
        const local = await settingsRequest(options, {
          version: 1,
          type: "settings.save",
          expectedRevision: initial.snapshot.revision,
          settings,
        });
        expect(local.snapshot.settings.connections.filter((entry) => entry.enabled)).toHaveLength(
          1,
        );
        const connection = local.catalog.connections.find(
          (entry) => entry.id === accepted.connectionId,
        );
        const item = connection?.items[0];
        if (!connection?.userId || !item) throw new Error("Synthetic vault item missing");
        // Nothing local names this site: the default and binding come only from the service.
        expect(local.snapshot.settings.siteDefaults).toEqual([]);
        expect(local.snapshot.settings.bindings ?? []).toEqual([]);

        const published = await service.request(`/v1/recipes/${recipeId}`, {
          method: "PUT",
          body: { version: 1, expectedRevision: 0, state: "active", recipe },
        });
        expect(published.status).toBe(200);
        const account = { provider: "bitwarden", userId: connection.userId, itemId: item.id };
        const binding = {
          recipeId,
          origin: site,
          ...account,
          itemName: item.label,
          slots: [
            { slot: "branch", field: { custom: "duplicate", position: 1, count: 3 } },
            { slot: "account", field: { custom: "duplicate", position: 2, count: 3 } },
            { slot: "password", field: "password" },
          ],
        };
        const stored = await service.request("/v1/settings", {
          method: "PUT",
          body: {
            version: 1,
            expectedRevision: 0,
            settings: { connections: [], excludedSites: [], siteDefaults: [], bindings: [binding] },
          },
        });
        expect(stored.status).toBe(200);

        // A paired device: the background reads this record and syncs over HTTPS.
        await browser.background.evaluate(
          async (record) =>
            (
              globalThis as unknown as {
                chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
              }
            ).chrome.storage.local.set({ "pateat.sync-service.v1": record }),
          {
            version: 1,
            kind: "connected",
            origin: service.origin,
            label: "Synthetic test device",
            deviceId: service.deviceId,
            credential: service.credential,
          },
        );
        // The settings page's pairing check syncs as soon as the device is connected.
        expect(await send(options, { version: 1, type: "service.pair.check" })).toMatchObject({
          ok: true,
          state: { kind: "connected" },
        });
        await expect
          .poll(async () => JSON.stringify(await storedRecipes(browser.background)))
          .toContain(recipeId);
        await expect
          .poll(async () => (await settingsRequest(options)).snapshot.settings.bindings)
          .toEqual([binding]);

        const runId = fixture.createRun();
        const page = await browser.context.newPage();
        await page.goto(`${site}/identity?runId=${runId}`);
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(fixture.evidence(runId)).toEqual({
          posts: 1,
          inputPosts: 0,
          clickPosts: 1,
          allMatched: true,
        });
        await expect
          .poll(() => send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            attempts: [{ state: "authenticated", outcome: "authenticated", submissions: 2 }],
          });

        // The single URI match is saved as this site's account, with the item's name for
        // display, and uploaded at once.
        const savedDefault = { origin: site, ...account, itemName: item.label };
        await expect
          .poll(
            async () =>
              ((await (await service.request("/v1/settings")).json()) as { settings: unknown })
                .settings,
          )
          .toMatchObject({ siteDefaults: [savedDefault], bindings: [binding] });
        await expect
          .poll(async () => (await settingsRequest(options)).snapshot.settings.siteDefaults)
          .toEqual([savedDefault]);

        // After a full restart the cached recipe, binding and saved account still apply,
        // with the service gone.
        await service.close();
        const reopened = await open();
        await serveSite(reopened.context, fixture);
        const again = fixture.createRun();
        const restarted = await reopened.context.newPage();
        await restarted.goto(`${site}/identity?runId=${again}`);
        await expect(restarted.locator("#authenticated")).toBeVisible();
        expect(fixture.evidence(again)).toMatchObject({ posts: 1, allMatched: true });
        // Only the routed site and the loopback service were contacted.
        expect([...new Set(externalRequests)].sort()).toEqual(["https://127.0.0.1", site]);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});
