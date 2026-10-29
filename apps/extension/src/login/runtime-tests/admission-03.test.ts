import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
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
  startsOf,
  recipe,
  userId,
  savedBinding,
  otherItemId,
  uriMatch,
  harness,
  shownHello,
  realTime,
} = createRuntimeTestHarness(fake);

describe("production login document admission", () => {
  afterEach(() => {
    // Close every test's tabs, so no attempt left reconciling answers a later test.
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
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.siteAccount = { ok: false };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.incognito = new Set();
    fake.state.openTabs = undefined;
  });

  describe("a login form inside a frame", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const framed = (top: string, overrides: Record<string, unknown> = {}) => {
      fake.state.tabUrls[1] = top;
      return { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top }, ...overrides };
    };
    it("keeps one attempt per tab and lets only a new page end a frame's attempt", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      const top = "https://login.example/home";
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      // The page around the frame and another frame of it never take the attempt over.
      expect(await h.hello({ documentId: "page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(await h.hello(framed(top, { frameId: 5, documentId: "widget-document" }))).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      // A sign-in input reported only for the log does not log the hold again.
      expect(await shownHello(h, { documentId: "page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      // A passkey page (ADR 0053) is answered as it would be without its button: a list or
      // a page that offered nothing is not logged again, an entry alone is.
      const passkeyHello = (extra: Record<string, unknown>) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            signIn: { path: "/home", passkey: true },
            ...extra,
          },
          sender({ documentId: "page-document", url: top }),
        );
      for (const extra of [{ list: { path: "/home", names: ["Welcome"] } }, {}])
        // eslint-disable-next-line no-await-in-loop
        expect(await passkeyHello(extra)).toEqual({ ok: false, reason: "tab-busy" });
      expect(
        report.mock.calls.filter(([value]) => value.type === "refused").map(([value]) => value),
      ).toHaveLength(2);
      expect(await passkeyHello({ entry: { path: "/home" } })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      // The log tells a refused frame from the tab's page.
      expect(
        report.mock.calls.flatMap(([value]) =>
          value.type === "refused" ? [[value.reason, value.frame]] : [],
        ),
      ).toEqual([
        ["tab-busy", undefined],
        ["tab-busy", true],
        ["tab-busy", undefined],
      ]);
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      // While the frame is still there, a new top document is its own page announcing.
      fake.state.gone = new Set(["page-document"]);
      expect(await h.hello({ documentId: "late-page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      // A new page in the tab ends the frame's attempt without a fill on the new page.
      fake.state.gone = new Set(["frame-document", "widget-document"]);
      fake.state.tabUrls[1] = "https://login.example/signin";
      await h.hello({ documentId: "next-page" });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { state: "blocked", outcome: "cancelled" },
        ]),
      );
      expect(executes()).toHaveLength(1);
    });
  });
  describe("a page a passkey from Pateat signed in, outside any login", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const answered = (h: ReturnType<typeof harness>, documentId = "synthetic-document") =>
      h.login.passkeyAnswered(1, origin, "login.example", undefined, {
        incognito: false,
        documentId,
      });
    const refused = { type: "refused", tabId: 1, origin, reason: "passkey-signed-in" };
    it("starts no login on the page the answer went to", async () => {
      // The clock stands still, so the answer's window cannot end between the announcements.
      vi.setTimerTickMode("manual");
      const report = vi.fn<(entry: LoginReport) => void>();
      const h = harness({}, { report });
      answered(h);
      expect(await h.hello()).toEqual({ ok: false, reason: "passkey-signed-in" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(fake.state.storage["pateat.login-attempts.v5"] ?? []).toEqual([]);
      expect(report).toHaveBeenCalledWith(refused);
      // The form showing again on that page starts nothing either.
      expect(await h.hello()).toEqual({ ok: false, reason: "passkey-signed-in" });
      expect(executes()).toEqual([]);
    });
    it("starts no login when the answer comes while the page is admitted", async () => {
      realTime();
      const report = vi.fn<(entry: LoginReport) => void>();
      const h = harness({}, { report });
      const lookup = h.recipes.recipe.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      h.recipes.recipe.mockImplementationOnce(async (...args) => {
        await held;
        return lookup(...args);
      });
      const admitted = h.hello();
      await vi.waitFor(() => expect(h.recipes.recipe).toHaveBeenCalledOnce());
      answered(h);
      release();
      expect(await admitted).toEqual({ ok: false, reason: "passkey-signed-in" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(report).toHaveBeenCalledWith(refused);
    });
    it("logs in on the tab's next page after the answer went to its previous one", async () => {
      const h = harness();
      answered(h, "previous-document");
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
    });
    it("logs in after an answer that names no page", async () => {
      const h = harness();
      h.login.passkeyAnswered(1, origin, "login.example", undefined, { incognito: false });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
    });
    it("logs in on that page again once 15 seconds have passed since the answer", async () => {
      vi.setTimerTickMode("manual");
      const h = harness();
      answered(h);
      vi.setSystemTime(Date.now() + 14_000);
      expect(await h.hello()).toEqual({ ok: false, reason: "passkey-signed-in" });
      vi.setSystemTime(Date.now() + 1_000);
      vi.setTimerTickMode("nextTimerAsync");
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
    });
    it("asks the refused page to announce again when the answer's 15 seconds end", async () => {
      vi.setTimerTickMode("manual");
      const h = harness();
      answered(h);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await h.hello()).toEqual({ ok: false, reason: "passkey-signed-in" });
      // Counted from the answer, not from the refusal.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fake.state.reconnects).toEqual([]);
      // The page's sign-in form still shows then: the site did not sign in with the passkey.
      fake.state.onReconnect = () => h.hello();
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.state.reconnects).toEqual([
        { tabId: 1, frameId: 0, documentId: "synthetic-document" },
      ]);
      vi.setTimerTickMode("nextTimerAsync");
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
    });
    it.each<[string, (h: ReturnType<typeof harness>) => Promise<unknown>]>([
      [
        "was replaced by the passkey's next page",
        (h) => h.hello({ documentId: "home-document", url: `${origin}/home` }, false),
      ],
      [
        "went away with its tab",
        async () => {
          for (const listener of fake.state.removed) listener(1);
        },
      ],
    ])("asks nothing of the refused page once it %s", async (_name, change) => {
      vi.setTimerTickMode("manual");
      const h = harness();
      answered(h);
      expect(await h.hello()).toEqual({ ok: false, reason: "passkey-signed-in" });
      await change(h);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fake.state.reconnects).toEqual([]);
      expect(executes()).toEqual([]);
    });
    it("lets the tab's running login follow its own answer, and log in again on its page", async () => {
      let release!: () => void;
      const clicked = new Promise<void>((resolve) => (release = resolve));
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click") await clicked;
      };
      const h = harness();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      // The bridge answers the page's request while the login submits on it.
      const at = Date.now();
      answered(h);
      release();
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { state: "authenticated" },
        ]),
      );
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      // Its first step showing again on that page, as after a logout, logs in again within
      // the answer's window: that answer was the login's, not a sign-in of its own.
      expect(Date.now() - at).toBeLessThan(15_000);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
    });
    it("logs in with an account picked in the popup on that page", async () => {
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const h = harness(
        { siteDefaults: [], bindings: [] },
        {
          allowedOrigins: [],
          uris: async () => ({
            ok: true,
            data: uriMatch({
              candidates: [
                { itemId, matches: [{ uriIndex: 0, match: 0 }] },
                { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
              ],
            }),
          }),
        },
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      fake.state.onReconnect = () => h.hello();
      answered(h);
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
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(h.fields.mock.calls[0]![0]).toMatchObject({ account: { itemId: otherItemId } });
    });
    it("starts no login in a frame of the page the answer went to", async () => {
      const report = vi.fn<(entry: LoginReport) => void>();
      const signin = fake.state.pageUrl;
      const top = "https://login.example/elsewhere";
      fake.state.pageUrl = top;
      const h = harness({}, { report });
      expect(await h.hello()).toMatchObject({ ok: false, reason: "recipe-not-found" });
      answered(h);
      fake.state.pageUrl = signin;
      fake.state.tabUrls[1] = top;
      const frame = { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top } };
      expect(await h.hello(frame)).toEqual({ ok: false, reason: "passkey-signed-in" });
      expect(executes()).toEqual([]);
      expect(report).toHaveBeenCalledWith({ ...refused, frame: true });
    });
  });
  describe("a frame's attempt when the tab changes page", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const framed = (top: string, overrides: Record<string, unknown> = {}) => {
      fake.state.tabUrls[1] = top;
      return { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top }, ...overrides };
    };
    const stored = () =>
      fake.state.storage["pateat.login-attempts.v5"] as { state: string; outcome?: string }[];
    it("lets a new page's frame that announced first keep its document", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const h = harness();
      // The previous page of the tab, without a login form.
      fake.state.tabUrls[1] = "https://login.example/home";
      expect(
        await h.hello({ documentId: "home-document", url: "https://login.example/home" }),
      ).toMatchObject({ ok: false });
      // The next page's login frame announces and starts before its own page does.
      const top = "https://login.example/account";
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      fake.state.gone = new Set(["home-document"]);
      expect(await h.hello({ documentId: "account-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      expect(stored()).toMatchObject([{ state: "executing" }]);
    });
    it("ends the attempt when the tab moves to a page on another origin", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      }));
      const h = harness({}, { allowedOrigins: [], uris });
      const top = "https://portal.example/account";
      fake.state.tabUrls[1] = top;
      expect(await h.hello({ documentId: "portal-document", url: top })).toMatchObject({
        ok: false,
      });
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      // The login navigates the whole tab; the frame goes with the old page.
      fake.state.gone = new Set(["frame-document", "portal-document"]);
      fake.state.tabUrls[1] = "https://portal.example/dashboard";
      await h.hello({ documentId: "dashboard-document", url: "https://portal.example/dashboard" });
      expect(stored()).toMatchObject([{ state: "blocked", outcome: "cancelled" }]);
      expect(executes()).toHaveLength(1);
    });
    it("refuses an operation once the tab shows another site", async () => {
      let authorized: unknown;
      const h = harness();
      fake.state.onExecute = async (message) => {
        fake.state.tabUrls[1] = "https://elsewhere.example/";
        const operation = message["operation"] as { attemptId: string; operationId: string };
        authorized = await h.login.handle(
          {
            version: 1,
            type: "login.operation.authorize",
            token: "synthetic-token",
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          },
          sender(framed("https://elsewhere.example/")),
        );
      };
      expect(await h.hello(framed("https://login.example/home"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(authorized).toBe(false));
    });
  });
  describe("a tab that moves to another origin", () => {
    const second = "https://second.example";
    const secondUrl = `${second}/signin`;
    const secondRecipe = parseLoginRecipe({ ...recipe, id: "second-signin", origin: second });
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    type Stored = {
      id: string;
      state: string;
      outcome?: string;
      submissions: number;
      mutationIntent?: true;
      changedAt?: number;
    } & {
      account: { origin: string };
      document: { tabId: number; documentId: string };
    };
    const stored = () => (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Stored[];
    const at = (from: string) => stored().find((entry) => entry.account.origin === from);
    const twoSites = (live: Parameters<typeof harness>[1] = {}) => {
      const h = harness(
        {
          siteDefaults: [
            { origin, provider: "bitwarden", server: "cloud-us", userId, itemId },
            { origin: second, provider: "bitwarden", server: "cloud-us", userId, itemId },
          ],
          bindings: [savedBinding, { ...savedBinding, recipeId: secondRecipe.id, origin: second }],
        },
        { allowedOrigins: [origin, second], ...live },
      );
      h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
        path !== "/signin"
          ? undefined
          : from === origin
            ? recipe
            : from === second
              ? secondRecipe
              : undefined,
      );
      h.recipes.starts.mockImplementation(async (from: string) =>
        startsOf(
          from === origin ? [recipe.steps[0]!] : from === second ? [secondRecipe.steps[0]!] : [],
        ),
      );
      return h;
    };
    const navigate = (
      h: ReturnType<typeof harness>,
      url: string,
      documentId: string,
      start = true,
    ) => {
      fake.state.tabUrls[1] = url;
      return h.hello({ documentId, url }, start);
    };
    const holdClicks = (...from: string[]) => {
      fake.state.onExecute = (message) => {
        const operation = message["operation"] as {
          step: { kind: string };
          document: { origin: string };
        };
        return operation.step.kind === "click" && from.includes(operation.document.origin)
          ? new Promise(() => undefined)
          : Promise.resolve();
      };
    };
    it("starts the next origin's login after an authenticated attempt in the tab", async () => {
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(executes()).toHaveLength(4);
      expect(h.fields.mock.calls.map(([request]) => request.account.origin)).toEqual([
        origin,
        second,
      ]);
      // The first origin's record is kept as it was.
      expect(at(origin)).toMatchObject({ state: "authenticated", document: { tabId: 1 } });
      expect(await h.login.active()).toBe(false);
    });
    it("tells of each origin's login in the tab as it signs in (ADR 0007)", async () => {
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = twoSites({ signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      expect(signedIn.mock.calls).toEqual([[1, origin]]);
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(signedIn.mock.calls).toEqual([
        [1, origin],
        [1, second],
      ]);
    });
    it("tells nothing of a submitted login that left its origin", async () => {
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      holdClicks(origin);
      const h = twoSites({ signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(
        await navigate(h, "https://elsewhere.example/home", "elsewhere-document"),
      ).toMatchObject({ ok: false });
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(signedIn).not.toHaveBeenCalled();
    });
    it("ends a submitted attempt as left-origin and lets the next origin log in", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent", submissions: 1 });
      expect(await h.login.active()).toBe(true);
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
        document: { tabId: 1, documentId: "synthetic-document" },
      });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(stored()).toHaveLength(2);
      // Nothing is left running, so a deferred policy write may proceed.
      expect(await h.login.active()).toBe(false);
      expect(executes().map((entry) => (entry as { operation?: unknown }).operation)).toEqual([
        expect.objectContaining({ document: expect.objectContaining({ origin }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin: second }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin: second }) }),
      ]);
    });
    const secondPage = `${second}/account`;
    const secondFrame = () => {
      fake.state.tabUrls[1] = secondPage;
      return h2frame;
    };
    const h2frame = {
      frameId: 3,
      documentId: "second-frame",
      url: secondUrl,
      tab: { id: 1, url: secondPage },
    };
    it("starts the next site's framed login after the tab's login ended on another site", async () => {
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" }),
      );
      fake.state.executeReply = undefined;
      expect(await navigate(h, secondPage, "second-page", false)).toMatchObject({ ok: false });
      // The ended login of the site the tab left never holds the next site's frame.
      expect(await h.hello(secondFrame())).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" });
    });
    it("lets the next site log in after the tab's framed login on another site", async () => {
      const portal = "https://portal.example/account";
      const h = twoSites({ allowedOrigins: [origin, second, "https://portal.example"] });
      fake.state.tabUrls[1] = portal;
      expect(
        await h.hello({ frameId: 5, documentId: "portal-frame", tab: { id: 1, url: portal } }),
      ).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "authenticated",
          document: { frameId: 5 },
          pageOrigin: "https://portal.example",
        }),
      );
      // After a worker restart, the next site's page and its frame are not held either.
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = twoSites();
        expect(await restarted.login.active()).toBe(false);
        expect(await navigate(restarted, secondPage, "second-page", false)).toMatchObject({
          reason: "recipe-not-found",
        });
        expect(await restarted.hello(secondFrame())).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
        expect(at(origin)).toMatchObject({ state: "authenticated", document: { frameId: 5 } });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("ends the left site's login when the next site's frame announces before its page", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await h.hello(secondFrame())).toEqual({ ok: true });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
      });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(await h.login.active()).toBe(false);
    });
    it("still holds a frame of the same page while its login runs", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      // A frame of the second site's origin inside the first site's page is not another site.
      expect(await h.hello({ ...h2frame, tab: { id: 1, url: fake.state.pageUrl } })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(at(origin)).toMatchObject({ state: "submit-intent" });
    });
    it("offers the next site's page for generation after the tab's login ended", async () => {
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      const available = vi.fn<LoginGeneration["available"]>(async () => true);
      const h = twoSites({
        uris: async (_connection, url) => ({
          ok: true,
          data: uriMatch({ targetOrigin: new URL(url).origin }),
        }),
        generation: {
          available,
          generate: vi.fn<LoginGeneration["generate"]>(),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge: vi.fn<LoginGeneration["judge"]>(),
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" }),
      );
      expect(
        await navigate(h, "https://elsewhere.example/login", "elsewhere-document", false),
      ).toEqual({ ok: false, reason: "recipe-not-found", starts: [], generate: true });
      expect(available).toHaveBeenCalledWith("https://elsewhere.example", "/login");
    });
    it("ends a submitted attempt when the next origin has no recipe", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, "https://elsewhere.example/home", "elsewhere-document")).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(stored()).toHaveLength(1);
      expect(await h.login.active()).toBe(false);
      expect(executes()).toHaveLength(2);
    });
    describe("after Pateat answered the site's passkey request (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      const submitted = async (rpId = "login.example") => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, rpId);
        fake.state.signs = quiet;
        return h;
      };
      it("completes when the tab moves on to the passkey's site and its page is quiet", async () => {
        const h = await submitted();
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        expect(await h.login.active()).toBe(false);
        expect(executes()).toHaveLength(2);
      });
      it("completes when an http://localhost login moves to another port there (ADR 0050)", async () => {
        const local = "http://localhost:3000";
        const localRecipe = parseLoginRecipe({ ...recipe, id: "local-signin", origin: local });
        holdClicks(local);
        fake.state.pageUrl = `${local}/signin`;
        fake.state.tabUrls[1] = fake.state.pageUrl;
        const h = harness(
          {
            siteDefaults: [
              { origin: local, provider: "bitwarden", server: "cloud-us", userId, itemId },
            ],
            bindings: [{ ...savedBinding, recipeId: localRecipe.id, origin: local }],
          },
          { allowedOrigins: [local] },
        );
        h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
          from === local && path === "/signin" ? localRecipe : undefined,
        );
        h.recipes.starts.mockImplementation(async (from: string) =>
          startsOf(from === local ? [localRecipe.steps[0]!] : []),
        );
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, local, "localhost");
        // The new page shows no username: only the passkey answer lets the move count.
        fake.state.signs = quiet;
        await navigate(h, "http://localhost:4000/home", "home-document", false);
        expect(at(local)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
      });
      it("waits until the new page has loaded", async () => {
        const h = await submitted();
        fake.state.loaded = false;
        setTimeout(() => (fake.state.loaded = true), 1_500);
        const reads = () => fake.state.messages.filter((entry) => entry.type === "login.state");
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        // Two readings while loading, then two once loaded.
        expect(reads().length).toBeGreaterThanOrEqual(4);
      }, 10_000);
      const homeFrame = {
        frameId: 3,
        documentId: "home-frame",
        url: "https://widgets.login.example/panel",
        tab: { id: 1, url: "https://www.login.example/home" },
      };
      it("leaves the move to the new top page when its frame announces first", async () => {
        const h = await submitted();
        fake.state.tabUrls[1] = homeFrame.tab.url;
        await h.hello(homeFrame, false);
        expect(at(origin)).toMatchObject({ state: "submit-intent" });
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("lets a frame that announces while the top page is read wait for it", async () => {
        const h = await submitted();
        const top = navigate(h, "https://www.login.example/home", "home-document", false);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await h.hello(homeFrame, false);
        expect(await top).not.toEqual({ ok: false, reason: "stale-document" });
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("ends left-origin when the new page shows a password field", async () => {
        const h = await submitted();
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, "https://www.login.example/signin", "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page still asks for a code", async () => {
        const h = await submitted();
        fake.state.signs = { ...quiet, code: true };
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page asks for a passkey again", async () => {
        const h = await submitted();
        // The new page's own request, as the bridge reports it before the page announces.
        h.login.passkeyRequested(1, "https://www.login.example");
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        // The login waits for the tab's next page, but the answer before that request no
        // longer counts.
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("reads the tab's next page when the first one went away before it was read", async () => {
        const h = await submitted();
        fake.state.gone = new Set(["redirect-document"]);
        expect(
          await navigate(h, "https://sso.login.example/redirect", "redirect-document", false),
        ).toEqual({ ok: false, reason: "stale-document" });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
      });
      it("ends left-origin when the next page comes more than 30 seconds after the answer", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        holdClicks(origin);
        const h = twoSites({ report });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, "login.example");
        fake.state.signs = quiet;
        fake.state.gone = new Set(["redirect-document"]);
        await navigate(h, "https://sso.login.example/redirect", "redirect-document", false);
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
        onTestFinished(() => clock.mockRestore());
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
          expect.objectContaining({
            type: "move",
            origin: "https://www.login.example",
            reason: "no-factor",
          }),
        );
      });
      it("ends left-origin on a host outside the passkey's RP ID", async () => {
        const h = await submitted("www.login.example");
        await navigate(h, "https://account.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("tells of the login's and the passkey site's origin once (ADR 0007)", async () => {
        const signedIn = vi.fn<(tabId: number, origin: string) => void>();
        holdClicks(origin);
        const h = twoSites({ signedIn });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, "login.example");
        fake.state.signs = quiet;
        expect(signedIn).not.toHaveBeenCalled();
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        expect(signedIn.mock.calls.toSorted()).toEqual([
          [1, origin],
          [1, "https://www.login.example"],
        ]);
        // Another page of the passkey's site tells nothing more.
        await navigate(h, "https://www.login.example/settings", "settings-document", false);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(signedIn).toHaveBeenCalledTimes(2);
      });
      it("tells nothing when the passkey site's page asks for a password again", async () => {
        const signedIn = vi.fn<(tabId: number, origin: string) => void>();
        holdClicks(origin);
        const h = twoSites({ signedIn });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, "login.example");
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, "https://www.login.example/signin", "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(signedIn).not.toHaveBeenCalled();
      });
      describe("on another site, as a second factor after the password (ADR 0022)", () => {
        const console = "https://console.elsewhere.example/home";
        it("completes when the page shows the account's username", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
          expect(executes()).toHaveLength(2);
        });
        it("checks the tab's next page when the first one went away before it was read", async () => {
          // Shaped like Oracle Cloud's sign-in (2026-10-13): a redirect through another
          // page that leaves before Pateat reads it, then the console.
          const report = vi.fn<(report: LoginReport) => void>();
          holdClicks(origin);
          const h = twoSites({ username: true, report });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          fake.state.gone = new Set(["callback-document"]);
          expect(
            await navigate(h, "https://www.elsewhere.example/callback", "callback-document", false),
          ).toEqual({ ok: false, reason: "stale-document" });
          expect(at(origin)).not.toMatchObject({ state: "blocked" });
          expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
            expect.objectContaining({
              type: "move",
              origin: "https://www.elsewhere.example",
              reason: "page-gone",
              kept: true,
            }),
          );
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        });
        it("logs why a move that ends left-origin did not complete", async () => {
          const report = vi.fn<(report: LoginReport) => void>();
          holdClicks(origin);
          const h = twoSites({ username: true, report });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, password: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
          expect(report.mock.calls.map(([entry]) => entry)).toContainEqual({
            type: "move",
            tabId: 1,
            origin: "https://console.elsewhere.example",
            recipeId: recipe.id,
            recipeRevision: recipe.revision,
            route: "password",
            reason: "sign-in-shown",
          });
        });
        it("ends left-origin when the page does not show it and no judge is paired", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 10_000);
        it("ends left-origin when the move comes more than 30 seconds after the answer", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          const now = Date.now.bind(Date);
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
          onTestFinished(() => clock.mockRestore());
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
      });
    });
  });
  void parseLoginRecipe({
    ...recipe,
    slots: ["branch", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "branch", target: target("branch") },
          { slot: "password", target: target("password") },
        ],
      },
      recipe.steps[1],
    ],
  });
});
