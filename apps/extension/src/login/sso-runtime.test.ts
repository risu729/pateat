import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () =>
  (await import("./runtime-tests/browser-fake")).createBrowserFake(),
);
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
import { ssoHarness, account, document, origin } from "./sso-choice-fixture";
const { createLoginRuntime, createLoginSites } = await import("./runtime-tests/harness");
beforeEach(() => {
  Object.assign(fake.state, {
    storage: {},
    session: {},
    openTabs: [7],
    messages: [],
    tabUrls: {},
    pageUrl: `${origin}/ready`,
    granted: true,
    observedPath: "/ready",
    present: new Set(),
    onReconnect: undefined,
  });
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) listener(7);
  fake.state.replaced.length = 0;
  vi.useRealTimers();
});
async function setup() {
  const fixture = ssoHarness();
  const settings = {
    handle: fixture.readSettings,
    read: async () => structuredClone(fixture.saved.snapshot),
  };
  const fields = vi.fn(async () => {
    throw new Error("No credential release in chooser tests");
  });
  const runtime = createLoginRuntime(settings, {
    fields,
    sso: fixture.source,
    sites: createLoginSites(settings),
    recipes: {
      recipe: async () => undefined,
      routes: async () => [],
      starts: async () => [],
      entries: async () => [],
    },
  });
  const announce = (documentId = document.documentId) =>
    runtime.handle({ version: 1, type: "login.document.ready", token: "sso-token" }, {
      id: "synthetic-extension",
      tab: { id: 7, incognito: false },
      frameId: 0,
      documentId,
      url: fake.state.pageUrl,
      origin,
    } as never);
  await announce();
  const pending = await runtime.ssoChoices!.request({
    document,
    account,
    native: { passkey: true, password: true },
  });
  expect(
    await runtime.handle(
      { version: 1, type: "login.sso.get", tabId: 7 },
      { id: "synthetic-extension", url: "chrome-extension://synthetic-extension/popup.html" },
    ),
  ).toMatchObject({ ok: true, offer: { id: pending.offerId } });
  return { fixture, runtime, fields, announce, pending };
}
it.each(["settings", "vault", "path", "document", "tab-close", "tab-path"] as const)(
  "the real login runtime withdraws an outstanding method offer on %s changes",
  async (change) => {
    const { fixture, runtime, fields, announce, pending } = await setup();
    if (change === "settings") {
      // The offer's own site excluded, as a settings page save or a sync writes it.
      fixture.saved.snapshot.revision += 1;
      fixture.saved.snapshot.settings.excludedSites.push({
        hostname: new URL(origin).hostname,
        includeSubdomains: false,
      });
      runtime.settingsChanged("saved");
    }
    if (change === "vault") {
      fixture.saved.catalog.connections[1]!.state = "locked";
      await runtime.vaultStateMayChange();
    }
    if (change === "path") {
      fake.state.pageUrl = `${origin}/different`;
      await announce();
    }
    if (change === "document") await announce("new-document");
    if (change === "tab-close") for (const listener of fake.state.removed) listener(7);
    if (change === "tab-path")
      await runtime.tabLoaded({ id: 7, url: `${origin}/elsewhere` } as never);
    expect(await pending.result).toMatchObject({
      ok: false,
      ...(change === "settings" ? { reason: "settings-changed" } : {}),
    });
    expect(await runtime.ssoChoices!.get(7)).toEqual({ ok: true });
    expect(fields).not.toHaveBeenCalled();
    expect(fake.state.messages.some((message) => message.type === "login.execute")).toBe(false);
    fixture.controller.invalidateAll();
  },
);
it.each(["a vault status read", "a new query", "a new fragment"] as const)(
  "the real login runtime keeps the method offer after %s",
  async (change) => {
    const { fixture, runtime, pending } = await setup();
    if (change === "a vault status read") await runtime.vaultStateMayChange();
    if (change === "a new query")
      await runtime.tabLoaded({ id: 7, url: `${origin}/ready?step=2` } as never);
    if (change === "a new fragment")
      await runtime.tabLoaded({ id: 7, url: `${origin}/ready#details` } as never);
    expect(await runtime.ssoChoices!.get(7)).toMatchObject({
      ok: true,
      offer: { id: pending.offerId },
    });
    fixture.controller.invalidateAll();
    runtime.ssoChoices!.invalidateAll();
  },
);
it.each(["synced", "saved"] as const)(
  "the real login runtime keeps the method offer over %s settings that change nothing it reads",
  async (source) => {
    const { fixture, runtime, pending } = await setup();
    let ended = false;
    void pending.result.then(() => {
      ended = true;
      return undefined;
    });
    // Another site's account choice and the theme, as a sync from the service applies them.
    fixture.saved.snapshot.revision += 1;
    fixture.saved.snapshot.changes = [
      { revision: fixture.saved.snapshot.revision, cause: "service-sync" },
    ];
    fixture.saved.snapshot.settings.siteDefaults.push({
      origin: "https://elsewhere.example.test",
      provider: "bitwarden",
      server: "cloud-us",
      userId: account.itemId,
      itemId: account.itemId,
    });
    fixture.saved.snapshot.settings.theme = "dark";
    const checked = vi.spyOn(runtime.ssoChoices!, "settingsChanged");
    runtime.settingsChanged(source);
    // The offer was checked against the settings the change wrote, and kept.
    expect(checked).toHaveBeenCalledTimes(1);
    await checked.mock.results[0]!.value;
    expect(ended).toBe(false);
    expect(await runtime.ssoChoices!.get(7)).toMatchObject({
      ok: true,
      offer: { id: pending.offerId },
    });
    fixture.controller.invalidateAll();
    runtime.ssoChoices!.invalidateAll();
  },
);
