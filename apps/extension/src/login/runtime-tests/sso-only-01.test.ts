import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, otherItemId, uriMatch, harness } =
  createRuntimeTestHarness(fake);

describe("an item that signs in only through an identity provider (ADR 0026)", () => {
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
  const both = () => {
    const data = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    return vi.fn<LiveUriMatcher>(async () => ({ ok: true, data }));
  };
  // The other item holds no password and an `SSO` field, as a site's SSO-only item.
  const sso = { allowedOrigins: [] as string[], otherUsername: true };
  const ssoOnly = {
    ...sso,
    otherPassword: "empty" as const,
    otherCustom: [{ name: "SSO", kind: "text" as const }],
  };

  it("is not one of the site's own accounts, so the site's own item logs in at once", async () => {
    const h = harness({ siteDefaults: [], bindings: [] }, { ...ssoOnly, uris: both() });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalled());
    for (const [request] of h.fields.mock.calls)
      expect(request).toMatchObject({ account: { origin, connectionId, itemId } });
  });

  it("still counts as an account when its SSO field is excluded or it holds a password", async () => {
    const withPassword = harness(
      { siteDefaults: [], bindings: [] },
      { ...sso, otherCustom: ssoOnly.otherCustom, uris: both() },
    );
    expect(await withPassword.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
    const notSso = harness(
      { siteDefaults: [], bindings: [] },
      { ...ssoOnly, otherCustom: [{ name: "SSO URL", kind: "text" }], uris: both() },
    );
    expect(await notSso.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
  });

  it("is still chosen when it is the only match, and the route planner refuses it", async () => {
    const only = uriMatch({
      candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
    });
    const h = harness(
      { siteDefaults: [], bindings: [] },
      { ...ssoOnly, uris: vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: only })) },
    );
    // No password and no passkey: no route, as before; a passkey would still log it in.
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
  });
});
