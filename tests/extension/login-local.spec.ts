import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { startLoginFixture } from "./login-server";
import { startSyncService } from "./sync-service";
import { withVaultProfile } from "./vault-fixture";
import { sendToBackground as send } from "./background-message";

// Pateat without a sync service (ADR 0039): recipes come from a file imported on the
// settings page and stay on the device until a service is paired. The synthetic Bitwarden
// item stores the URI https://synthetic.example.test/login; its custom fields share the
// name "duplicate" and its password is "test_password", as the fixture site expects.
const site = "https://synthetic.example.test";
const recipeId = "synthetic-identity";
const localKey = "pateat.local-recipes.v1";

async function serveSite(context: BrowserContext, fixture: { origin: string }) {
  await context.route(`${site}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.origin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

const target = (value: string) => ({ by: "id", value });
/** The multi-page fixture flow, as an exported recipe file holds it. */
const recipe = {
  version: 1,
  id: recipeId,
  revision: 3,
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
  completion: [{ target: target("authenticated") }],
  rejection: target("rejected"),
  maxSubmissions: 2,
};
const recipeFile = { format: "pateat-recipes", version: 1, recipes: [recipe] };

function stored(background: Worker, key: string) {
  return background.evaluate(
    async (name) =>
      (
        await (
          globalThis as unknown as {
            chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
          }
        ).chrome.storage.local.get(name)
      )[name],
    key,
  );
}

type VaultBrowser = {
  context: BrowserContext;
  background: Worker;
  page: Page;
  extensionId: string;
};

/**
 * Connects the synthetic Bitwarden account and saves the binding for the recipe's custom
 * slots in local settings, as a device keeps it from an earlier pairing; then imports the
 * recipe file through the settings page's file input.
 */
async function prepare(browser: VaultBrowser) {
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
  const settings = initial.snapshot.settings;
  // Only the Bitwarden connection answers URI queries (see login-service.spec.ts).
  settings.connections = settings.connections.map((entry) => ({
    ...entry,
    enabled: entry.connectionId === accepted.connectionId,
  }));
  settings.bindings = [
    {
      recipeId,
      origin: site,
      provider: "bitwarden",
      userId: connection.userId,
      itemId: item.id,
      itemName: item.label,
      slots: [
        { slot: "branch", field: { custom: "duplicate", position: 1, count: 3 } },
        { slot: "account", field: { custom: "duplicate", position: 2, count: 3 } },
        { slot: "password", field: "password" },
      ],
    },
  ];
  const saved = await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: initial.snapshot.revision,
    settings,
  });

  // The settings page reloads with the saved settings and offers the import without a service.
  await options.reload();
  await expect(options.locator("#recipes-status")).toContainText("No sync service is paired");
  await options.locator("#recipe-file").setInputFiles({
    name: "pateat-recipes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(recipeFile)),
  });
  await expect(options.locator("#recipes-message")).toHaveText(
    "Imported 1 new recipe and 0 newer revisions.",
  );
  await expect(options.locator("#recipe-list")).toContainText(`${recipeId} · revision 3`);
  expect(await stored(browser.background, localKey)).toEqual({ version: 1, recipes: [recipe] });
  return { options, revision: saved.snapshot.revision };
}

test("without a service, a recipe imported from a file logs in with the live vault", async () => {
  const fixture = await startLoginFixture(0, { password: "test_password" });
  try {
    await withVaultProfile(async (open, externalRequests) => {
      const browser = await open();
      await serveSite(browser.context, fixture);
      await setupProbe(browser.page, { action: "configure", variant: "uri" });
      const { options } = await prepare(browser);

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
        .toMatchObject({ attempts: [{ state: "authenticated", outcome: "authenticated" }] });
      // The export holds the same recipe; no service took part.
      expect(await send(options, { version: 1, type: "recipes.export" })).toMatchObject({
        ok: true,
        file: recipeFile,
      });
      expect(await stored(browser.background, "pateat.sync-recipes.v1")).toBeUndefined();
      expect([...new Set(externalRequests)]).toEqual([site]);

      // After a full restart the kept recipe still logs in.
      const reopened = await open();
      await serveSite(reopened.context, fixture);
      const again = fixture.createRun();
      const restarted = await reopened.context.newPage();
      await restarted.goto(`${site}/identity?runId=${again}`);
      await expect(restarted.locator("#authenticated")).toBeVisible();
      expect(fixture.evidence(again)).toMatchObject({ posts: 1, allMatched: true });
    });
  } finally {
    await fixture.close();
  }
});

test("pairing uploads the recipes kept on the device once and then logs in from the service's copy", async () => {
  const fixture = await startLoginFixture(0, { password: "test_password" });
  const service = await startSyncService();
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        await setupProbe(browser.page, { action: "configure", variant: "uri" });
        const { options, revision } = await prepare(browser);

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
        // Saving settings starts a full sync at once.
        await settingsRequest(options, {
          version: 1,
          type: "settings.save",
          expectedRevision: revision,
          settings: (await settingsRequest(options)).snapshot.settings,
        });
        // The service holds the recipe as a new recipe at revision 1, and the device's own
        // copy is gone once the service has it.
        await expect
          .poll(async () => (await (await service.request("/v1/recipes")).json()) as unknown)
          .toMatchObject({
            changes: [
              { recipeId, revision: 1, state: "active", recipe: { ...recipe, revision: 1 } },
            ],
          });
        await expect.poll(() => stored(browser.background, localKey)).toBeUndefined();
        await expect
          .poll(async () =>
            JSON.stringify(await stored(browser.background, "pateat.sync-recipes.v1")),
          )
          .toContain(recipeId);
        expect(await send(options, { version: 1, type: "recipes.get" })).toMatchObject({
          ok: true,
          state: { source: "service", recipes: [{ id: recipeId, revision: 1 }], waiting: 0 },
        });
        // While paired, the settings page leaves imports to the service.
        expect(
          await send(options, { version: 1, type: "recipes.import", file: recipeFile }),
        ).toMatchObject({ ok: false, error: "paired" });

        const runId = fixture.createRun();
        const page = await browser.context.newPage();
        await page.goto(`${site}/identity?runId=${runId}`);
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(fixture.evidence(runId)).toMatchObject({ posts: 1, allMatched: true });
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});
