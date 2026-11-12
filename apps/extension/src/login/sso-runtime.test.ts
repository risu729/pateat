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
it.each(["settings", "vault", "path", "document", "tab-close"] as const)(
  "the real login runtime withdraws an outstanding method offer on %s changes",
  async (change) => {
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
    if (change === "settings") runtime.settingsChanged("saved");
    if (change === "vault") runtime.vaultStateMayChange();
    if (change === "path") {
      fake.state.pageUrl = `${origin}/different`;
      await announce();
    }
    if (change === "document") await announce("new-document");
    if (change === "tab-close") for (const listener of fake.state.removed) listener(7);
    expect((await pending.result).ok).toBe(false);
    expect(await runtime.ssoChoices!.get(7)).toEqual({ ok: true });
    expect(fields).not.toHaveBeenCalled();
    expect(fake.state.messages.some((message) => message.type === "login.execute")).toBe(false);
    fixture.controller.invalidateAll();
  },
);
