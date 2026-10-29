import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LocalSettings,
  type LoginEntryRecipe,
  type LoginLogoutRecipe,
  type LoginTarget,
  type LogoutPurpose,
  type LogoutTarget,
} from "@pateat/contracts";
import { statusResponseSchema } from "../choice-wire";
import type { LoginReport } from "../runtime";
import { siteDefaultsMark, type LogoutService } from "../switch";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  sender,
  target,
  otherItemId,
  uriMatch,
  liveDefault,
  harness,
  realTime,
} = createRuntimeTestHarness(fake);

describe("account switching from the popup (ADR 0063)", () => {
  let pausedNow = false;
  const popup = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/popup.html",
  } as never;
  const both = uriMatch({
    candidates: [
      { itemId, matches: [{ uriIndex: 0, match: 0 }] },
      { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
    ],
  });
  const homeUrl = `${origin}/home`;
  const signinUrl = `${origin}/signin`;
  const home = (h: ReturnType<typeof harness>) => {
    fake.state.pageUrl = homeUrl;
    return h.hello({ documentId: "home" }, false);
  };
  const switchTo = (h: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) =>
    h.login.handle(
      {
        version: 1,
        type: "login.switch.start",
        tabId: 1,
        connectionId,
        itemId: otherItemId,
        makeDefault: false,
        ...overrides,
      },
      popup,
    );
  const status = async (h: ReturnType<typeof harness>) =>
    v.parse(
      statusResponseSchema,
      await h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup),
    );
  const attempts = () =>
    (fake.state.storage["pateat.login-attempts.v5"] ?? []) as {
      account: { itemId: string };
      document: { tabId: number; documentId: string };
      state: string;
    }[];
  const clicks = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.logout.click")
      .map((entry) => (entry as { target?: LoginTarget }).target);
  const logoutRecipe = (
    targets: { target: LogoutTarget["target"]; purpose: LogoutPurpose; path?: string }[],
  ): LoginLogoutRecipe => ({
    version: 1 as const,
    id: "gen-00000000000000000000000000000001",
    revision: targets.length,
    origin,
    logout: {
      path: "/home",
      targets: targets.map(({ path = "/home", ...entry }) => ({
        kind: "click" as const,
        path,
        ...entry,
      })),
    },
  });
  const homePage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/home",
      language: "en",
      complete: true,
      candidates: [
        { id: "c1", role: "button", target: target("account-menu"), label: "Account" },
        { id: "c2", role: "button", target: target("sign-out"), label: "Sign out" },
      ],
    },
  };
  async function signedIn(
    live: Parameters<typeof harness>[1] = {},
    overrides: Partial<LocalSettings> = {},
  ) {
    const report = vi.fn<(entry: LoginReport) => void>();
    const h = harness(overrides, {
      uris: async () => ({ ok: true, data: both }),
      report,
      ...live,
    });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([{ account: { itemId }, state: "authenticated" }]),
    );
    expect(await home(h)).toMatchObject({ ok: false, reason: "logged-in" });
    const reports = () =>
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "switch");
    return { h, reports };
  }
  const leadsToSignIn = (h: ReturnType<typeof harness>, value = "sign-out") => {
    fake.state.onLogoutClick = (message) => {
      if ((message["target"] as LoginTarget).value !== value) return;
      fake.state.entry.check = { ok: true, signIn: true, start: true, signUp: false };
      fake.state.pageUrl = signinUrl;
      void h.hello({ documentId: "signin-again" });
    };
  };
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
    fake.state.pageUrl = signinUrl;
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: false };
    fake.state.logoutClick = { ok: true };
    fake.state.onLogoutClick = undefined;
    fake.state.logoutLocal = { ok: false, reason: "none" };
  });
  it("logs in with the picked account on a sign-in page a passkey from Pateat signed in", async () => {
    const logout = {
      recipes: vi.fn(async () => [
        logoutRecipe([{ target: target("sign-out"), purpose: "logout" }]),
      ]),
      generate: vi.fn<LogoutService["generate"]>(),
    };
    const { h } = await signedIn({ logout });
    fake.state.onLogoutClick = (message) => {
      if ((message["target"] as LoginTarget).value !== "sign-out") return;
      fake.state.entry.check = { ok: true, signIn: true, start: true, signUp: false };
      fake.state.pageUrl = signinUrl;
      // The sign-in page asks for a passkey on load, and the bridge answers it before the
      // page announces; the switch's own login still runs there.
      h.login.passkeyAnswered(1, origin, "login.example", undefined, {
        incognito: false,
        documentId: "signin-again",
      });
      void h.hello({ documentId: "signin-again" });
    };
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([
        {
          account: { itemId: otherItemId },
          document: { documentId: "signin-again" },
          state: "authenticated",
        },
      ]),
    );
  });
  it("logs out with the stored recipe, logs in once with the picked account, then asks", async () => {
    const logout = {
      recipes: vi.fn(async () => [
        logoutRecipe([{ target: target("sign-out"), purpose: "logout" }]),
      ]),
      generate: vi.fn<LogoutService["generate"]>(),
    };
    const { h, reports } = await signedIn({ logout });
    // The popup marks the account of the tab's login as used in this tab.
    expect(await status(h)).toMatchObject({ used: { connectionId, itemId } });
    leadsToSignIn(h);
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([
        {
          account: { itemId: otherItemId },
          document: { documentId: "signin-again" },
          state: "authenticated",
        },
      ]),
    );
    expect(clicks()).toEqual([target("sign-out")]);
    // A stored recipe that ends on its logout needs no model call.
    expect(logout.generate).not.toHaveBeenCalled();
    expect(h.fields.mock.calls.at(-1)![0]).toMatchObject({
      account: { connectionId, itemId: otherItemId },
    });
    await vi.waitFor(() =>
      expect(reports()).toEqual([
        { type: "switch", tabId: 1, origin, stage: "start" },
        { type: "switch", tabId: 1, origin, stage: "click", purpose: "logout", source: "recipe" },
        {
          type: "switch",
          tabId: 1,
          origin,
          stage: "end",
          outcome: "signed-out",
          clicks: 1,
          recipeId: "gen-00000000000000000000000000000001",
          recipeRevision: 1,
        },
      ]),
    );
    // Not made the default: the saved default stays, and the site asks every time.
    expect(h.settings.settings.siteDefaults).toEqual([expect.objectContaining({ origin, itemId })]);
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-ask-every-time.v1"]).toEqual([
        { site: "login.example", incognito: false, defaults: expect.any(String) },
      ]),
    );
    expect(fake.state.session["pateat.login-switch-picks.v1"]).toEqual([]);
    expect(await status(h)).toMatchObject({ used: { connectionId, itemId: otherItemId } });
    // The pick's login is the person's own, which the relogin guard does not count.
    expect(fake.state.session["pateat.login-relogins.v1"] ?? []).toEqual([
      expect.objectContaining({ at: [expect.any(Number)] }),
    ]);
  }, 15_000);
  it("clicks the control that says it logs out by its words, without the service", async () => {
    const logout = { recipes: vi.fn(async () => []), generate: vi.fn<LogoutService["generate"]>() };
    const { h, reports } = await signedIn({ logout });
    fake.state.logoutLocal = { ok: true, target: target("bye") };
    fake.state.logoutClick = { ok: true, reacted: "navigated" };
    const hosts = fake.state.entry.hosts;
    fake.state.entry.hosts = { ok: true, hosts: ["login.example", "other.example"] };
    leadsToSignIn(h, "bye");
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([
        { account: { itemId: otherItemId }, document: { documentId: "signin-again" } },
      ]),
    );
    fake.state.entry.hosts = hosts;
    expect(logout.generate).not.toHaveBeenCalled();
    // The page is told which of its hosts are on the site: a logout link elsewhere is not
    // this site's.
    expect(
      fake.state.messages.filter((entry) => entry.type === "login.logout.local"),
    ).toMatchObject([{ onSite: ["login.example"] }]);
    // The click watches the page for 5 seconds for a reaction.
    expect(
      fake.state.messages.filter((entry) => entry.type === "login.logout.click"),
    ).toMatchObject([{ target: target("bye"), watchMs: 5000 }]);
    await vi.waitFor(() =>
      expect(reports()).toEqual([
        { type: "switch", tabId: 1, origin, stage: "start" },
        { type: "switch", tabId: 1, origin, stage: "click", purpose: "logout", source: "local" },
        { type: "switch", tabId: 1, origin, stage: "end", outcome: "signed-out", clicks: 1 },
      ]),
    );
  }, 15_000);
  it("moves a switch's pick to the tab that replaced its tab", async () => {
    const logout = { recipes: vi.fn(async () => []), generate: vi.fn<LogoutService["generate"]>() };
    const { h } = await signedIn({ logout });
    // The page never answers the logout, so the switch is still running.
    fake.state.logoutLocal = { ok: true, target: target("bye") };
    fake.state.logoutClick = new Promise(() => {});
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-switch-picks.v1"]).toMatchObject([{ tabId: 1 }]),
    );
    fake.state.tabUrls[2] = fake.state.pageUrl;
    for (const listener of fake.state.replaced) listener(2, 1);
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-switch-picks.v1"]).toMatchObject([
        { tabId: 2, itemId: otherItemId },
      ]),
    );
  });
  it("holds the site in other tabs sharing its cookies until the switch ends", async () => {
    const logout = {
      recipes: vi.fn(async () => []),
      generate: vi.fn<LogoutService["generate"]>(async () => ({
        outcome: "abstained",
        reason: "no-logout-control",
      })),
    };
    const { h } = await signedIn({ logout });
    fake.state.tabUrls[1] = homeUrl;
    fake.state.extracted = { logout: homePage };
    fake.state.logoutLocal = { ok: true, target: target("bye") };
    let answer!: (value: unknown) => void;
    fake.state.logoutClick = new Promise((resolve) => {
      answer = resolve;
    });
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() => expect(clicks()).toEqual([target("bye")]));
    // Another tab's login page logs in with nothing meanwhile: it would sign the site back
    // in with the account being left.
    fake.state.pageUrl = signinUrl;
    fake.state.tabUrls[2] = signinUrl;
    const fills = h.fields.mock.calls.length;
    expect(await h.hello({ tab: { id: 2 }, documentId: "tab-2" })).toEqual({
      ok: false,
      reason: "origin-busy",
    });
    expect(h.fields.mock.calls).toHaveLength(fills);
    // A second switch on the site is refused, also from that tab.
    expect(await switchTo(h, { tabId: 2 })).toEqual({ ok: false, reason: "site-held" });
    // An incognito window keeps its own cookies.
    fake.state.tabUrls[3] = signinUrl;
    expect(await h.hello({ tab: { id: 3, incognito: true }, documentId: "tab-3" })).toEqual({
      ok: true,
    });
    // The switch fails: the hold ends with it.
    answer({ ok: false, reason: "missing" });
    await vi.waitFor(() => expect(fake.state.session["pateat.login-switch-picks.v1"]).toEqual([]));
    expect(await status(h)).toMatchObject({ switch: { state: "failed" } });
    expect(await h.hello({ tab: { id: 2 }, documentId: "tab-2-again" })).toEqual({ ok: true });
  }, 15_000);
  it("goes on in the tab that replaced its tab while it logs out", async () => {
    const logout = {
      recipes: vi.fn(async () => []),
      generate: vi.fn<LogoutService["generate"]>(async () => ({
        outcome: "abstained",
        reason: "no-logout-control",
      })),
    };
    const { h, reports } = await signedIn({ logout });
    fake.state.tabUrls[1] = homeUrl;
    fake.state.extracted = { logout: homePage };
    fake.state.logoutLocal = { ok: true, target: target("bye") };
    let answer!: (value: unknown) => void;
    fake.state.logoutClick = new Promise((resolve) => {
      answer = resolve;
    });
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() => expect(clicks()).toEqual([target("bye")]));
    fake.state.tabUrls[2] = homeUrl;
    for (const listener of fake.state.replaced) listener(2, 1);
    expect(await h.hello({ tab: { id: 2 }, documentId: "home-2" }, false)).toMatchObject({
      ok: false,
    });
    // The new tab's switch is the one running; the gone tab has none.
    expect(await switchTo(h, { tabId: 2 })).toEqual({ ok: false, reason: "in-progress" });
    answer({ ok: false, reason: "missing" });
    await vi.waitFor(() =>
      expect(reports().at(-1)).toMatchObject({ stage: "end", outcome: "failed", tabId: 2 }),
    );
    const switchOf = async (tabId: number) =>
      v.parse(
        statusResponseSchema,
        await h.login.handle({ version: 1, type: "login.status.get", tabId }, popup),
      );
    expect(await switchOf(2)).toMatchObject({ switch: { state: "failed" } });
    expect(await switchOf(1)).not.toHaveProperty("switch");
    await vi.waitFor(() => expect(fake.state.session["pateat.login-switch-picks.v1"]).toEqual([]));
  }, 15_000);
  it("ends a switch whose worker stopped while it logged out, and says so", async () => {
    const logout = { recipes: vi.fn(async () => []), generate: vi.fn<LogoutService["generate"]>() };
    const { h } = await signedIn({ logout });
    fake.state.logoutLocal = { ok: true, target: target("bye") };
    fake.state.logoutClick = new Promise(() => {});
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-switch-picks.v1"]).toMatchObject([{ tabId: 1 }]),
    );
    // The worker restarts in the same browser session.
    const restarted = harness({}, { uris: async () => ({ ok: true, data: both }), logout });
    expect(await status(restarted)).toMatchObject({
      switch: { state: "failed", reason: "interrupted", connectionId, itemId: otherItemId },
    });
    await vi.waitFor(() => expect(fake.state.session["pateat.login-switch-picks.v1"]).toEqual([]));
    // The site's next login page logs in as without the switch: with the saved default.
    fake.state.pageUrl = signinUrl;
    expect(await restarted.hello({ documentId: "signin-later" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(restarted.fields.mock.calls.at(-1)?.[0]).toMatchObject({
        account: { connectionId, itemId },
      }),
    );
  }, 15_000);
  it("opens the menu the model names, then clicks the logout it names there", async () => {
    const menu = logoutRecipe([{ target: target("account-menu"), purpose: "menu" }]);
    const full = logoutRecipe([
      { target: target("account-menu"), purpose: "menu" },
      { target: target("sign-out"), purpose: "logout" },
    ]);
    const logout = {
      recipes: vi.fn(async () => []),
      generate: vi.fn<LogoutService["generate"]>(async (request) => ({
        outcome: "recipe",
        recipe: request.base ? full : menu,
      })),
    };
    const { h, reports } = await signedIn({ logout });
    fake.state.extracted = { logout: homePage };
    leadsToSignIn(h);
    expect(await switchTo(h, { makeDefault: true })).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(attempts()).toMatchObject([
          { account: { itemId: otherItemId }, state: "authenticated" },
        ]),
      { timeout: 10_000 },
    );
    expect(clicks()).toEqual([target("account-menu"), target("sign-out")]);
    expect(logout.generate.mock.calls.map(([request]) => request.base)).toEqual([
      undefined,
      { recipeId: menu.id, revision: 1 },
    ]);
    // The page sent is the logout description, without slots.
    expect(logout.generate.mock.calls[0]![0]).toEqual({
      version: 1,
      observation: homePage.observation,
    });
    await vi.waitFor(() =>
      expect(reports().map((entry) => [entry.stage, entry.purpose, entry.learned])).toEqual([
        ["start", undefined, undefined],
        ["click", "menu", true],
        ["click", "logout", true],
        ["end", undefined, true],
      ]),
    );
    // Made the default once the login succeeded; the site does not ask every time.
    await vi.waitFor(() =>
      expect(h.settings.settings.siteDefaults).toEqual([
        expect.objectContaining({ origin, itemId: otherItemId }),
      ]),
    );
    expect(fake.state.session["pateat.login-ask-every-time.v1"] ?? []).toEqual([]);
  }, 20_000);
  it("stops when no control logs out, and the tab keeps its account", async () => {
    const logout = {
      recipes: vi.fn(async () => []),
      generate: vi.fn<LogoutService["generate"]>(async () => ({
        outcome: "abstained",
        reason: "no-logout-control",
      })),
    };
    const { h, reports } = await signedIn({ logout });
    fake.state.extracted = { logout: homePage };
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(reports().at(-1)).toMatchObject({
        stage: "end",
        outcome: "failed",
        reason: "no-logout-control",
        detail: "no-logout-control",
        clicks: 0,
      }),
    );
    expect(clicks()).toEqual([]);
    expect(await status(h)).toMatchObject({
      used: { connectionId, itemId },
      switch: { state: "failed", reason: "no-logout-control", connectionId, itemId: otherItemId },
    });
    await vi.waitFor(() => expect(fake.state.session["pateat.login-switch-picks.v1"]).toEqual([]));
    // The tab's login stays: the sign-in page shown later is no switch's.
    expect(attempts()).toMatchObject([{ account: { itemId }, state: "authenticated" }]);
  });
  it("stops after three clicks when the site still shows the account", async () => {
    const stuck = logoutRecipe([
      { target: target("account-menu"), purpose: "menu" },
      { target: target("more"), purpose: "menu" },
      { target: target("account-menu"), purpose: "menu" },
    ]);
    const logout = {
      recipes: vi.fn(async () => [stuck]),
      generate: vi.fn<LogoutService["generate"]>(),
    };
    const { h, reports } = await signedIn({ logout });
    expect(await switchTo(h)).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(reports().at(-1)).toMatchObject({
          stage: "end",
          outcome: "failed",
          reason: "still-signed-in",
          clicks: 3,
        }),
      { timeout: 10_000 },
    );
    expect(clicks()).toHaveLength(3);
    expect(await status(h)).toMatchObject({
      switch: { state: "failed", reason: "still-signed-in" },
    });
  }, 15_000);
  it.each<[string, () => Partial<Parameters<typeof harness>[1]>, Record<string, unknown>, string]>([
    [
      "an account that does not match the page",
      () => ({}),
      { itemId: "unlisted-item" },
      "not-a-candidate",
    ],
    ["a worker without the service's logout", () => ({ logout: undefined }), {}, "unavailable"],
  ])("refuses %s", async (_name, live, overrides, reason) => {
    const logout = { recipes: vi.fn(async () => []), generate: vi.fn<LogoutService["generate"]>() };
    pausedNow = false;
    const { h } = await signedIn({ logout, ...live() });
    pausedNow = true;
    expect(await switchTo(h, overrides)).toEqual({ ok: false, reason });
    expect(fake.state.session["pateat.login-switch-picks.v1"] ?? []).toEqual([]);
    expect(clicks()).toEqual([]);
  });
  it("refuses an excluded site, a page Pateat does not know and other senders", async () => {
    const logout = { recipes: vi.fn(async () => []), generate: vi.fn<LogoutService["generate"]>() };
    const { h } = await signedIn({ logout });
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.switch.start",
          tabId: 1,
          connectionId,
          itemId: otherItemId,
          makeDefault: false,
        },
        sender(),
      ),
    ).toBeUndefined();
    expect(await switchTo(h, { tabId: 4 })).toEqual({ ok: false, reason: "no-page" });
  });
  it.each([
    ["paused", (_h: ReturnType<typeof harness>) => (pausedNow = true)],
    [
      "excluded",
      (h: ReturnType<typeof harness>) =>
        (h.settings.settings.excludedSites = [
          { hostname: "login.example", includeSubdomains: false },
        ]),
    ],
  ])(
    "switches on a site %s since its login: the switch is the person's pick",
    async (_name, stop) => {
      const logout = {
        recipes: vi.fn(async () => [
          logoutRecipe([{ target: target("sign-out"), purpose: "logout" }]),
        ]),
        generate: vi.fn<LogoutService["generate"]>(),
      };
      pausedNow = false;
      const { h } = await signedIn({
        logout,
        pauses: {
          until: async () => (pausedNow ? Date.now() + 60 * 60_000 : undefined),
          pause: async () => Date.now() + 60 * 60_000,
          resume: async () => false,
          clearIncognito: async () => undefined,
        },
      });
      stop(h);
      leadsToSignIn(h);
      expect(await switchTo(h)).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attempts()).toMatchObject([
          {
            account: { itemId: otherItemId },
            document: { documentId: "signin-again" },
            state: "authenticated",
          },
        ]),
      );
      expect(clicks()).toEqual([target("sign-out")]);
      pausedNow = false;
    },
    15_000,
  );
  it("asks on every page of the site after a pick without the default, apart for incognito windows", async () => {
    const report = vi.fn<(entry: LoginReport) => void>();
    const h = harness(
      { siteDefaults: [], bindings: [] },
      { allowedOrigins: [], uris: async () => ({ ok: true, data: both }), report },
    );
    expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
    fake.state.onReconnect = () => h.hello();
    // The person picks an account without making it the default.
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "synthetic-document",
          connectionId,
          itemId: otherItemId,
          makeDefault: false,
        },
        popup,
      ),
    ).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-ask-every-time.v1"]).toEqual([
        { site: "login.example", incognito: false, defaults: "[]" },
      ]),
    );
    // The pick's login is the person's own, which the relogin guard does not count.
    expect(fake.state.session["pateat.login-relogins.v1"] ?? []).toEqual([]);
    // Every other login page of the site now asks, filling nothing.
    const fills = h.fields.mock.calls.length;
    fake.state.tabUrls[2] = signinUrl;
    expect(await h.hello({ tab: { id: 2 }, documentId: "tab-2" })).toEqual({
      ok: false,
      reason: "account-asked",
    });
    expect(h.fields.mock.calls).toHaveLength(fills);
    expect(
      await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, popup),
    ).toMatchObject({
      ok: true,
      ask: "one-time-pick",
      candidates: [
        expect.objectContaining({ itemId }),
        expect.objectContaining({ itemId: otherItemId }),
      ],
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "refused",
        tabId: 2,
        reason: "account-asked",
        detail: "one-time-pick",
      }),
    );
    // The person's passkey requests treat the default as unset there too, and the page's
    // own conditional request goes to the browser.
    expect(await h.login.defaultUnset(origin, false)).toBe(true);
    expect(
      await h.login.conditionalRequest({
        tabId: 2,
        origin,
        documentId: "tab-2",
        signal: new AbortController().signal,
        incognito: false,
      }),
    ).toEqual({ kind: "delegate", reason: "one-time-pick" });
    // An incognito window keeps its own: it chooses as without a pick.
    expect(await h.login.defaultUnset(origin, true)).toBe(false);
    fake.state.tabUrls[3] = signinUrl;
    expect(await h.hello({ tab: { id: 3, incognito: true }, documentId: "tab-3" })).toEqual({
      ok: false,
      reason: "account-ambiguous",
    });
    // A default saved since, as in the popup, ends the asking: its account logs in.
    h.settings.settings.siteDefaults = [liveDefault()];
    h.settings.revision += 1;
    fake.state.tabUrls[4] = signinUrl;
    expect(await h.hello({ tab: { id: 4 }, documentId: "tab-4" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toContainEqual(
        expect.objectContaining({
          account: expect.objectContaining({ itemId }),
          document: expect.objectContaining({ tabId: 4 }),
        }),
      ),
    );
    expect(fake.state.session["pateat.login-ask-every-time.v1"]).toEqual([]);
    expect(await h.login.defaultUnset(origin, false)).toBe(false);
  });
  it.each([
    ["stopped", "pateat.login-stopped-asks.v1", "stopped-login"],
    ["rejected", "pateat.login-rejected-asks.v1", "rejected"],
  ])(
    "fills nothing on a site that asks every time, also while the tab's login %s",
    async (_name, key, ask) => {
      fake.state.session["pateat.login-ask-every-time.v1"] = [
        {
          site: "login.example",
          incognito: false,
          defaults: siteDefaultsMark([liveDefault()], "login.example", (value) =>
            new URL(value).hostname.split(".").slice(-2).join("."),
          ),
        },
      ];
      // The tab also asks for that reason, which alone would fill the page once.
      fake.state.session[key] = [{ tabId: 1, origin }];
      const h = harness({}, { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) });
      expect(await h.hello()).toEqual({ ok: false, reason: "account-asked" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual([]);
      expect(attempts() ?? []).toEqual([]);
      expect(
        await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup),
      ).toMatchObject({ ok: true, ask });
    },
  );
  it("stops asking once a pick makes its account the default", async () => {
    // Kept before the worker starts, as after a restart in the same browser session.
    fake.state.session["pateat.login-ask-every-time.v1"] = [
      {
        site: "login.example",
        incognito: false,
        defaults: siteDefaultsMark([liveDefault()], "login.example", (value) =>
          new URL(value).hostname.split(".").slice(-2).join("."),
        ),
      },
    ];
    const h = harness({}, { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) });
    expect(await h.hello()).toEqual({ ok: false, reason: "account-asked" });
    fake.state.onReconnect = () => h.hello();
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "synthetic-document",
          connectionId,
          itemId,
          makeDefault: true,
        },
        popup,
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-ask-every-time.v1"]).toEqual([]),
    );
    expect(await h.login.defaultUnset(origin, false)).toBe(false);
  });
  it.each([
    [true, { outcome: "pressed" }],
    [false, { outcome: "refused", reason: "no-return-target" }],
  ] as const)(
    "presses the site's sign-in entry on a page that names no return target only while switching (%s)",
    async (switching, logged) => {
      // The entry's press waits for the next page, which never shows here.
      realTime();
      const entryRecipe: LoginEntryRecipe = {
        version: 1,
        id: "synthetic-entry",
        revision: 2,
        origin,
        entry: { path: "/", target: { by: "text", value: "Login" } },
      };
      if (switching)
        fake.state.session["pateat.login-switch-picks.v1"] = [
          {
            tabId: 1,
            site: "login.example",
            incognito: false,
            connectionId,
            itemId: otherItemId,
            makeDefault: false,
            until: Date.now() + 60_000,
            // Kept past a worker restart once the switch signed out.
            signedOut: true,
          },
        ];
      fake.state.pageUrl = `${origin}/`;
      fake.state.entry.inspect = {
        ok: true,
        state: "unique",
        href: "https://accounts.login.example/login",
        url: fake.state.pageUrl,
      };
      const report = vi.fn<(entry: LoginReport) => void>();
      const h = harness(
        { siteDefaults: [], bindings: [] },
        {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
          entries: [entryRecipe],
          report,
        },
      );
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue([]);
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
      await vi.waitFor(() =>
        expect(
          report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "entry"),
        ).toEqual([expect.objectContaining(logged)]),
      );
    },
  );
});
