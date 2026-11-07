import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, userId, itemId, otherItemId, uriMatch, harness } = createRuntimeTestHarness(fake);

describe("a default the popup saves logs the tab in at once (ADR 0021, amended 2026-11-04)", () => {
  const popup = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/popup.html",
  } as never;
  const chosen = (h: ReturnType<typeof harness>, tabId = 1) =>
    h.login.handle({ version: 1, type: "login.default.chosen", tabId }, popup);
  const fresh = () =>
    fake.state.messages.filter((entry) => entry.type === "login.reconnect" && "fresh" in entry);
  afterEach(() => {
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2, 3, 4]) listener(tabId);
    fake.state.replaced.length = 0;
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.gone = new Set();
    fake.state.loaded = true;
    fake.state.openTabs = undefined;
    fake.state.onExecute = undefined;
    fake.state.executeReply = undefined;
    fake.state.awaited = { ok: true };
  });

  it("asks every frame of the tab to announce as a new page", async () => {
    const h = harness();
    expect(await chosen(h)).toEqual({ ok: true });
    expect(fresh()).toEqual([{ version: 1, type: "login.reconnect", fresh: true }]);
    expect(fake.state.reconnects).toEqual([{ tabId: 1 }]);
  });

  it("asks nothing when the tab's site has no default", async () => {
    const h = harness({ siteDefaults: [] });
    expect(await chosen(h)).toEqual({ ok: false, reason: "no-default" });
    // Another site's default is no default of this tab's site.
    fake.state.tabUrls[2] = "https://elsewhere.example/login";
    expect(await chosen(harness(), 2)).toEqual({ ok: false, reason: "no-default" });
    expect(fresh()).toEqual([]);
  });

  it("asks nothing of a tab that shows no web page", async () => {
    fake.state.tabUrls[1] = "chrome://newtab/";
    expect(await chosen(harness())).toEqual({ ok: false, reason: "no-page" });
    expect(fresh()).toEqual([]);
  });

  it("ends the choice the page waited for, so its announcement logs in", async () => {
    // Two items match, so the page waits for a pick.
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: both }));
    const h = harness({ siteDefaults: [], bindings: [] }, { allowedOrigins: [], uris });
    expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
    expect(
      await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup),
    ).toMatchObject({ ok: true, origin });
    h.settings.settings.siteDefaults.push({
      origin,
      provider: "bitwarden",
      server: "cloud-us",
      userId,
      itemId,
    });
    expect(await chosen(h)).toEqual({ ok: true });
    expect(fresh()).toHaveLength(1);
    expect(await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup)).toEqual(
      { ok: false, reason: "no-choice" },
    );
    expect(fake.state.badges[1]?.text ?? "").not.toBe("2");
  });

  it("leaves a login the tab still runs, so it is not announced over", async () => {
    // The login's fill never answers, so it runs while the popup saves the default.
    let release: () => void = () => undefined;
    fake.state.onExecute = () => new Promise<void>((resolve) => (release = resolve));
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.some((entry) => entry.type === "login.execute")).toBe(true),
    );
    expect(await chosen(h)).toEqual({ ok: false, reason: "login-running" });
    expect(fresh()).toEqual([]);
    release();
  });

  it("answers nothing to a page that sends it", async () => {
    const h = harness();
    const page = {
      id: "synthetic-extension",
      url: "https://login.example/signin",
      tab: { id: 1 },
      frameId: 0,
      documentId: "synthetic-document",
    } as never;
    expect(
      await h.login.handle({ version: 1, type: "login.default.chosen", tabId: 1 }, page),
    ).toBeUndefined();
    expect(fresh()).toEqual([]);
  });
});
