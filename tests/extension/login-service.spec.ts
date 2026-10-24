import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import {
  newLayoutKey,
  toLoginLayout,
  type LocalSettings,
  type LoginRecipe,
  type LoginRecipeDocument,
  type VaultItemMetadata,
} from "../../packages/contracts/src/index";
import {
  beginInput,
  catalogAccount,
  settingsRequest,
  setupProbe,
  setupRequest,
  useOnly,
} from "./connection-fixture";
import { logs } from "./login-fixture";
import { startLoginFixture } from "./login-server";
import { startSyncService } from "./sync-service";
import { withVaultProfile } from "./vault-fixture";
import { sendToBackground as send } from "./background-message";

// The synthetic Bitwarden item stores the URI https://synthetic.example.test/login, so
// the production executor may choose it on that site without a saved default. Its
// custom fields share the name "duplicate": the first is "007", the second (Hidden) is
// "00001234". The login password is "test_password". The fixture site expects them.
const site = "https://synthetic.example.test";
const recipeId = "synthetic-identity";

/** The synthetic HTTPS site is served by the loopback fixture; nothing leaves the browser. */
async function serveSite(context: BrowserContext, fixture: { origin: string }) {
  await context.route(`${site}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${fixture.origin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

const target = (value: string) => ({ by: "id" as const, value });
/** The multi-page fixture flow as the one layout of the published recipe (ADR 0060). */
const route: LoginRecipe = {
  version: 1,
  id: recipeId,
  revision: 1,
  origin: site,
  pageKind: "sign-in",
  slots: ["branch", "account", "password"],
  steps: [
    {
      kind: "fill",
      path: "/identity",
      fields: [
        { slot: "branch", target: target("branch") },
        { slot: "account", target: target("account") },
      ],
      effect: "prepare",
    },
    { kind: "assert", path: "/identity", target: target("next"), present: true },
    { kind: "click", path: "/identity", target: target("next"), purpose: "advance" },
    { kind: "wait", path: "/password", target: target("password"), present: true, timeoutMs: 3000 },
    {
      kind: "fill",
      path: "/password",
      fields: [{ slot: "password", target: target("password") }],
      effect: "prepare",
    },
    { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
  ],
  completion: [{ target: target("authenticated") }],
  rejection: target("rejected"),
  maxSubmissions: 2,
};
/**
 * The recipe published the way a generated one is stored (ADR 0013, ADR 0060): one layout,
 * created now so the service never finds it idle.
 */
const createdAt = Date.now();
const recipe: LoginRecipeDocument = {
  version: 1,
  id: recipeId,
  revision: 1,
  origin: site,
  layouts: [toLoginLayout(route, { key: newLayoutKey(createdAt, []), createdAt })],
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

type SyncService = Awaited<ReturnType<typeof startSyncService>>;
type VaultBrowser = {
  context: BrowserContext;
  background: Worker;
  page: Page;
  extensionId: string;
};

type Account = { provider: string; server: string; userId: string };
/** The synthetic account's vault policy as another device synced it (ADR 0023). */
type SyncedPolicy = Pick<LocalSettings, "accountPolicies" | "itemPolicies" | "customFieldReviews">;

/** The settings-page query for items that may log in to the site. */
function siteAccounts(options: Page, settings: LocalSettings) {
  return send(options, { version: 1, type: "settings.site-accounts", origin: site, settings });
}

/**
 * Connects the synthetic Bitwarden account, publishes the recipe and a binding to the
 * service and pairs the device, so the site's recipe and binding come only from the
 * service and no site default is saved. `policy` is the account's vault policy the
 * service holds, as another device wrote it.
 */
async function prepare(
  browser: VaultBrowser,
  service: SyncService,
  policy?: (account: Account, item: VaultItemMetadata) => SyncedPolicy,
  others: { id: string }[] = [],
  main: LoginRecipeDocument = recipe,
) {
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
  const settings = useOnly(initial.snapshot.settings, initial.catalog, accepted.connectionId);
  const local = await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: initial.snapshot.revision,
    settings,
  });
  const vaultAccount = catalogAccount(local.catalog, accepted.connectionId);
  // The add form's choice became the account's policy once the account was known.
  expect(local.snapshot.settings.accountPolicies.filter((entry) => entry.enabled)).toEqual([
    { ...vaultAccount, accountName: "Synthetic vault", enabled: true, selection: { mode: "all" } },
  ]);
  const connection = local.catalog.connections.find((entry) => entry.id === accepted.connectionId);
  const item = connection?.items[0];
  if (!connection?.userId || !item) throw new Error("Synthetic vault item missing");
  expect(local.catalog.settingsSyncPending).toBeUndefined();
  // Nothing local names this site: the default and binding come only from the service.
  expect(local.snapshot.settings.siteDefaults).toEqual([]);
  expect(local.snapshot.settings.bindings).toEqual([]);
  const beforePairing = await siteAccounts(options, local.snapshot.settings);

  const published = await service.request(`/v1/recipes/${recipeId}`, {
    method: "PUT",
    body: { version: 1, expectedRevision: 0, state: "active", recipe: main },
  });
  expect(published.status).toBe(200);
  for (const other of others) {
    // oxlint-disable-next-line no-await-in-loop -- one recipe at a time, as a device stores them
    const stored = await service.request(`/v1/recipes/${other.id}`, {
      method: "PUT",
      body: { version: 1, expectedRevision: 0, state: "active", recipe: other },
    });
    expect(stored.status).toBe(200);
  }
  const account = { ...vaultAccount, itemId: item.id };
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
  // A paired device takes its settings profile's lists at its first sync (ADR 0076), so
  // the service's profile uses this account too unless a test says otherwise.
  const synced: SyncedPolicy = policy?.(vaultAccount, item) ?? {
    accountPolicies: [
      {
        ...vaultAccount,
        accountName: "Synthetic vault",
        enabled: true,
        selection: { mode: "all" },
      },
    ],
    itemPolicies: [],
    customFieldReviews: [],
  };
  const stored = await service.request("/v1/settings", {
    method: "PUT",
    body: {
      version: 1,
      expectedRevision: 0,
      settings: {
        connections: [],
        ...synced,
        excludedSites: [],
        passkeyBrowserSites: [],
        siteDefaults: [],
        bindings: [binding],
      },
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
  // Until its first settings sync, a paired device uses no vault item: the account's
  // synced policy may say otherwise (ADR 0023). Nothing has started a sync yet.
  const pending = await settingsRequest(options);
  expect(pending.catalog.settingsSyncPending).toBe(true);
  expect(await siteAccounts(options, pending.snapshot.settings)).toMatchObject({
    ok: true,
    accounts: [],
    complete: false,
  });
  expect(await send(options, { version: 1, type: "service.get" })).toMatchObject({
    ok: true,
    state: { kind: "connected" },
  });
  // Saving settings syncs at once; the earlier save already scheduled the next one.
  await settingsRequest(options, {
    version: 1,
    type: "settings.save",
    expectedRevision: pending.snapshot.revision,
    settings: pending.snapshot.settings,
  });
  for (const id of [recipeId, ...others.map((other) => other.id)])
    // oxlint-disable-next-line no-await-in-loop -- each recipe arrives with the same sync
    await expect
      .poll(async () => JSON.stringify(await storedRecipes(browser.background)))
      .toContain(id);
  // The sync names the binding's account after this device's connection.
  const named = { ...binding, accountName: connection.label };
  await expect
    .poll(async () => (await settingsRequest(options)).snapshot.settings.bindings)
    .toEqual([named]);
  const after = await settingsRequest(options);
  expect(after.catalog.settingsSyncPending).toBeUndefined();
  return { options, accepted, connection, item, account, binding, named, beforePairing, after };
}

/** The account's synced policy entries in the local settings, without the demo vaults'. */
function bitwardenPolicy(settings: LocalSettings): SyncedPolicy {
  const own = <T extends { provider: string }>(entries: T[]) =>
    entries.filter((entry) => entry.provider === "bitwarden");
  return {
    accountPolicies: own(settings.accountPolicies),
    itemPolicies: own(settings.itemPolicies),
    customFieldReviews: own(settings.customFieldReviews),
  };
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
        // Another device chose this item only, excluded a custom field the binding does not
        // use, and reviewed the item's custom fields; this device applies that after sync.
        let synced: SyncedPolicy | undefined;
        const { options, connection, item, account, named, beforePairing, after } = await prepare(
          browser,
          service,
          (vaultAccount, vaultItem) => {
            synced = {
              accountPolicies: [
                {
                  ...vaultAccount,
                  accountName: "Synthetic vault",
                  enabled: true,
                  selection: { mode: "selected", groups: [] },
                },
              ],
              itemPolicies: [
                {
                  ...vaultAccount,
                  itemId: vaultItem.id,
                  itemName: vaultItem.label,
                  selected: true,
                  excluded: false,
                  excludedFields: [{ custom: "duplicate", position: 3, count: 3 }],
                },
              ],
              customFieldReviews: [
                {
                  ...vaultAccount,
                  itemId: vaultItem.id,
                  evidence: vaultItem.evidence!,
                  revisionDate: vaultItem.revisionDate!,
                },
              ],
            };
            return synced;
          },
        );
        // Before pairing, the item matched the site by its URI.
        expect(beforePairing).toMatchObject({
          ok: true,
          accounts: [{ connectionId: connection.id, itemId: item.id, uri: true }],
        });
        expect(bitwardenPolicy(after.snapshot.settings)).toEqual(synced);
        // Its review matches this device's copy, so the item is not held for review.
        expect(
          after.catalog.connections.find((entry) => entry.id === connection.id)
            ?.quarantinedItemIds ?? [],
        ).toEqual([]);
        // The excluded custom field is the Boolean one, which the binding does not use.
        expect(await setupProbe(browser.page, { action: "resolve", field: "custom-1" })).toEqual({
          ok: true,
          matched: true,
        });

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

        // The single URI match is saved as this site's account, with the item's and the
        // connection's names for display, and uploaded at once.
        const savedDefault = {
          origin: site,
          ...account,
          itemName: item.label,
          accountName: connection.label,
        };
        await expect
          .poll(
            async () =>
              ((await (await service.request("/v1/settings")).json()) as { settings: unknown })
                .settings,
          )
          .toMatchObject({ siteDefaults: [savedDefault], bindings: [named] });
        await expect
          .poll(async () => (await settingsRequest(options)).snapshot.settings.siteDefaults)
          .toEqual([savedDefault]);

        // The diagnostics page reads the service's own record for this device.
        const diagnostics = await browser.context.newPage();
        await diagnostics.goto(`chrome-extension://${browser.extensionId}/diagnostics.html`);
        await expect(diagnostics.locator("#diagnostics-service-generation")).toHaveText(
          "recipe generation off, no Claude credentials on the service (credentials-not-configured)",
        );
        await diagnostics.getByRole("button", { name: "Copy for bug report" }).click();
        await expect(diagnostics.locator("#report-preview")).toContainText(
          /Service record: paired \S+Z · 1 recipe · settings revision \d+ · recipe generation off/u,
        );
        await expect(diagnostics.locator("#report-preview")).not.toContainText(service.deviceId);

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

test("a page whose recipe finds no matching item checks the vault again and logs in once the item's URI arrives", async () => {
  const fixture = await startLoginFixture(0, { password: "test_password" });
  const service = await startSyncService();
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        // The item stores no URI yet, so no item matches the site.
        await setupProbe(browser.page, { action: "configure", variant: "unchanged" });
        const { accepted } = await prepare(browser, service);
        // The URI is added on another device, which moves the account's revision date.
        await setupProbe(browser.page, { action: "configure", variant: "uri" });
        // The last check was 20 seconds ago: a regular check waits a minute, while a check
        // after a page found no matching item waits ten seconds (ADR 0025).
        await browser.background.evaluate(async (id) => {
          const { chrome } = globalThis as unknown as {
            chrome: {
              storage: {
                local: {
                  get(key: string): Promise<Record<string, unknown>>;
                  set(items: Record<string, unknown>): Promise<void>;
                };
              };
            };
          };
          const key = "pateat.vault-sync-schedule.v1";
          const record = (await chrome.storage.local.get(key))[key] as
            | { version: 1; connections: Record<string, Record<string, unknown>> }
            | undefined;
          const { revisionMs } = record?.connections[id] ?? {};
          await chrome.storage.local.set({
            [key]: {
              version: 1,
              connections: {
                ...record?.connections,
                [id]: {
                  checkedAt: Date.now() - 20_000,
                  outcome: "unchanged",
                  ...(revisionMs === undefined ? {} : { revisionMs }),
                },
              },
            },
          });
        }, accepted.connectionId);
        const before = await setupProbe(browser.page, { action: "status" });

        const runId = fixture.createRun();
        const page = await browser.context.newPage();
        await page.goto(`${site}/identity?runId=${runId}`);
        await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
        expect(fixture.evidence(runId)).toMatchObject({ posts: 1, allMatched: true });
        // One revision check found the change and one full sync brought the URI.
        expect(await setupProbe(browser.page, { action: "status" })).toMatchObject({
          revisionCalls: before.revisionCalls + 1,
          syncCalls: before.syncCalls + 1,
        });
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});

test("a password page shown alone, as for an account the site remembers, logs in from its step, unless an email input shows beside it", async () => {
  const fixture = await startLoginFixture(0, { password: "test_password" });
  const service = await startSyncService();
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        await setupProbe(browser.page, { action: "configure", variant: "uri" });
        const { options } = await prepare(browser, service);

        // Beside an email input, as a form for another account, the password step starts
        // nothing (ADR 0049).
        const other = await browser.context.newPage();
        await other.addInitScript(() => sessionStorage.setItem("identityMatched", "true"));
        await other.goto(`${site}/password?email=1`);
        await expect(other.locator("#password")).toBeVisible();
        // The page is offered for generation instead, which ends its handling here, as no
        // model is configured.
        await expect
          .poll(() => logs(browser.background, "recipe.generate"))
          .toContainEqual(expect.objectContaining({ outcome: "unavailable" }));
        await expect(other.locator("#password")).toHaveValue("");
        expect(await other.evaluate(() => sessionStorage.getItem("submitClicks"))).toBeNull();
        expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
          attempts: [],
        });
        await other.close();

        // The recipe starts on /identity; its password step shows here without it, and no
        // other identifier input shows beside it (ADR 0049).
        const page = await browser.context.newPage();
        // The site already knows the account, as it would from an earlier sign-in.
        await page.addInitScript(() => sessionStorage.setItem("identityMatched", "true"));
        await page.goto(`${site}/password`);
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(await page.evaluate(() => sessionStorage.getItem("passwordMatched"))).toBe("true");
        expect(await page.evaluate(() => sessionStorage.getItem("identityClicks"))).toBeNull();
        await expect
          .poll(() => send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            attempts: [
              { state: "authenticated", outcome: "authenticated", startStep: 4, submissions: 1 },
            ],
          });
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});

test("a one-page form shown with its password input alone, as for an account the site remembers, logs in with the password alone (ADR 0049)", async () => {
  const fixture = await startLoginFixture(0, { password: "test_password" });
  const service = await startSyncService();
  // One step fills the identifiers and the password together on /password, as a generated
  // recipe does for a page that asks for all of them (Duolingo, 2026-10-24).
  const onePage: LoginRecipe = {
    ...route,
    steps: [
      {
        kind: "fill",
        path: "/password",
        fields: [
          { slot: "branch", target: target("branch") },
          { slot: "account", target: target("account") },
          { slot: "password", target: target("password") },
        ],
      },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
  };
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        await setupProbe(browser.page, { action: "configure", variant: "uri" });
        const { options } = await prepare(browser, service, undefined, [], {
          ...recipe,
          layouts: [toLoginLayout(onePage, { key: newLayoutKey(createdAt, []), createdAt })],
        });

        // Beside an email input, as a form for another account, it starts nothing.
        const other = await browser.context.newPage();
        await other.addInitScript(() => sessionStorage.setItem("identityMatched", "true"));
        await other.goto(`${site}/password?email=1`);
        await expect(other.locator("#password")).toBeVisible();
        await expect
          .poll(() => logs(browser.background, "login.refused"), { timeout: 20_000 })
          .toContainEqual(expect.objectContaining({ reason: "not-started" }));
        await expect(other.locator("#password")).toHaveValue("");
        expect(await other.evaluate(() => sessionStorage.getItem("submitClicks"))).toBeNull();
        await other.close();

        // The site already knows the account and asks for its password alone.
        const page = await browser.context.newPage();
        await page.addInitScript(() => sessionStorage.setItem("identityMatched", "true"));
        await page.goto(`${site}/password`);
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(await page.evaluate(() => sessionStorage.getItem("passwordMatched"))).toBe("true");
        await expect
          .poll(() => send(options, { version: 1, type: "login.probe.status" }))
          .toMatchObject({
            attempts: [
              {
                state: "authenticated",
                outcome: "authenticated",
                startStep: 0,
                startPartial: true,
                submissions: 1,
              },
            ],
          });
        await expect
          .poll(() => logs(browser.background, "login.start"))
          .toContainEqual(expect.objectContaining({ startStep: 0, startPartial: true }));
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});

for (const [name, policy] of [
  [
    "excludes the item",
    (account: Account, item: VaultItemMetadata): SyncedPolicy => ({
      accountPolicies: [
        { ...account, accountName: "Synthetic vault", enabled: true, selection: { mode: "all" } },
      ],
      itemPolicies: [
        {
          ...account,
          itemId: item.id,
          itemName: item.label,
          selected: false,
          excluded: true,
          excludedFields: [],
        },
      ],
      customFieldReviews: [],
    }),
  ],
  [
    "selects other items only",
    (account: Account): SyncedPolicy => ({
      accountPolicies: [
        {
          ...account,
          accountName: "Synthetic vault",
          enabled: true,
          selection: { mode: "selected", groups: [{ id: "other-group", name: "Other" }] },
        },
      ],
      itemPolicies: [],
      customFieldReviews: [],
    }),
  ],
] as const) {
  test(`a synced account policy that ${name} keeps the vault item from logging in`, async () => {
    const fixture = await startLoginFixture(0, { password: "test_password" });
    const service = await startSyncService();
    try {
      await withVaultProfile(
        async (open) => {
          const browser = await open();
          await serveSite(browser.context, fixture);
          await setupProbe(browser.page, { action: "configure", variant: "uri" });
          let synced: SyncedPolicy | undefined;
          const { options, after } = await prepare(browser, service, (account, vaultItem) => {
            synced = policy(account, vaultItem);
            return synced;
          });
          // The service's policy replaced the add form's one on this device.
          expect(bitwardenPolicy(after.snapshot.settings)).toEqual(synced);
          expect(await siteAccounts(options, after.snapshot.settings)).toMatchObject({
            ok: true,
            accounts: [],
          });

          const runId = fixture.createRun();
          const page = await browser.context.newPage();
          await page.goto(`${site}/identity?runId=${runId}`);
          await expect
            .poll(async () => send(options, { version: 1, type: "login.probe.status" }))
            .toMatchObject({ attempts: [], documents: [{ origin: site }] });
          await expect(page.locator("#branch")).toHaveValue("");
          await expect(page.locator("#account")).toHaveValue("");
          expect(fixture.evidence(runId).posts).toBe(0);
          // No site default names the item, since it was never chosen.
          expect((await settingsRequest(options)).snapshot.settings.siteDefaults).toEqual([]);
        },
        { args: ["--ignore-certificate-errors"] },
      );
    } finally {
      await service.close();
      await fixture.close();
    }
  });
}
test("a page whose recipe was generated as a verification only watches, and logs what it showed and how the person left it (ADR 0035)", async () => {
  const fixture = await startLoginFixture(0, { password: "test_password" });
  const service = await startSyncService();
  try {
    await withVaultProfile(
      async (open) => {
        const browser = await open();
        await serveSite(browser.context, fixture);
        await setupProbe(browser.page, { action: "configure", variant: "uri" });
        const confirmRoute: LoginRecipe = {
          version: 1,
          id: "synthetic-confirm",
          revision: 1,
          origin: site,
          pageKind: "confirm",
          slots: ["password"],
          steps: [
            {
              kind: "fill",
              path: "/confirm-transfer",
              fields: [{ slot: "password", target: target("confirm-password") }],
              effect: "prepare",
            },
            {
              kind: "click",
              path: "/confirm-transfer",
              target: target("confirm"),
              purpose: "submit",
            },
          ],
          completion: [{ target: target("authenticated") }],
          maxSubmissions: 1,
        };
        const confirm: LoginRecipeDocument = {
          version: 1,
          id: confirmRoute.id,
          revision: 1,
          origin: site,
          layouts: [toLoginLayout(confirmRoute, { key: newLayoutKey(createdAt, []), createdAt })],
        };
        const { options } = await prepare(browser, service, undefined, [confirm]);

        const page = await browser.context.newPage();
        // The site still knows the account, so its result page shows the recipes' marker.
        await page.addInitScript(() => {
          sessionStorage.setItem("identityMatched", "true");
          sessionStorage.setItem("passwordMatched", "true");
        });
        await page.goto(`${site}/account`);
        await page.goto(`${site}/confirm-transfer`);
        await expect(page.locator("#confirm-password")).toBeVisible();
        // Nothing is filled or pressed there; the person confirms the transfer themselves.
        await page.waitForTimeout(2_000);
        await expect(page.locator("#confirm-password")).toHaveValue("");
        await page.locator("#confirm").click();
        await expect(page.locator("#authenticated")).toBeVisible();
        expect(await send(options, { version: 1, type: "login.probe.status" })).toMatchObject({
          attempts: [],
        });

        const diagnostics = await browser.context.newPage();
        const entries = async () => {
          await diagnostics.goto(`chrome-extension://${browser.extensionId}/diagnostics.html`);
          await diagnostics.getByRole("button", { name: "Download logs" }).click();
          const text = (await diagnostics.locator("#logs-preview").textContent()) ?? "";
          return text
            .trim()
            .split("\n")
            .slice(1)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        };
        await expect
          .poll(async () =>
            (await entries()).filter((entry) => entry["event"] === "login.confirm-left"),
          )
          .toEqual([
            expect.objectContaining({
              recipe: "synthetic-confirm",
              recipeRevision: 1,
              pageKind: "confirm",
              personSubmitted: true,
              nextE1: true,
              url: "/confirm-transfer",
            }),
          ]);
        const logged = await entries();
        expect(
          logged.filter(
            (entry) =>
              entry["event"] === "login.refused" && entry["detail"] === "confirm-unsupported",
          ),
        ).toEqual([
          expect.objectContaining({
            reason: "not-started",
            recipe: "synthetic-confirm",
            recipeRevision: 1,
            pageKind: "confirm",
            amount: true,
            e1: false,
            previousUrl: "/account",
            url: "/confirm-transfer",
          }),
        ]);
        // No value or page text is logged.
        const text = JSON.stringify(logged);
        for (const absent of ["1,200", "Confirm", "test_password"])
          expect(text).not.toContain(absent);
      },
      { args: ["--ignore-certificate-errors"] },
    );
  } finally {
    await service.close();
    await fixture.close();
  }
});
