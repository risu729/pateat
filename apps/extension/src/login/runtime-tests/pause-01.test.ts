import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings } from "@pateat/contracts";
import { i18n } from "../../i18n";
import { pickFailure, statusResponseSchema } from "../choice-wire";
import { createLoginBadge, memoryBadgeStorage, setActionBadge } from "../badge";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, startsOf, recipe, harness, setPause, realTime } =
  createRuntimeTestHarness(fake);

describe("pausing automatic login of a site (ADR 0062)", () => {
  const PAUSES = "pateat.login-pauses.v1";
  const popup = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/popup.html",
  } as never;
  afterEach(() => {
    vi.useRealTimers();
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
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.incognito = new Set();
    fake.state.openTabs = undefined;
  });
  const stored = () =>
    (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Record<string, unknown>[];
  const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const paused = (
    live: Parameters<typeof harness>[1] = {},
    overrides: Parameters<typeof harness>[0] = {},
  ) => {
    const reports: LoginReport[] = [];
    const h = harness(overrides, {
      ...live,
      report: (entry) => reports.push(entry),
      badge:
        live.badge ?? createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() }),
    });
    const refused = () => reports.filter((entry) => entry.type === "refused");
    return { h, reports, refused };
  };
  const status = async (h: ReturnType<typeof harness>, tabId = 1) =>
    v.parse(
      statusResponseSchema,
      await h.login.handle({ version: 1, type: "login.status.get", tabId }, popup),
    );
  it("refuses the site's automatic logins in every tab, and offers its account", async () => {
    const { h, reports, refused } = paused();
    fake.state.openTabs = [1, 2];
    fake.state.tabUrls[2] = "https://www.login.example/account";
    const answer = (await setPause(h, true)) as { ok: true; until: number };
    expect(answer).toEqual({ ok: true, until: expect.any(Number) });
    expect(answer.until - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(fake.state.session[PAUSES]).toEqual([
      {
        site: "login.example",
        incognito: false,
        length: "1h",
        until: new Date(answer.until).toISOString(),
      },
    ]);
    expect(reports).toContainEqual({
      type: "pause",
      tabId: 1,
      origin,
      action: "paused",
      length: "1h",
    });
    // Every tab of the registrable site shows the pause.
    await vi.waitFor(() => expect(fake.state.badges[2]?.text).toBe("II"));
    expect(fake.state.badges[2]?.title).toMatch(
      /^Pateat: automatic login is paused on this site until \d\d:\d\d\.$/u,
    );
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    fake.state.tabUrls[3] = fake.state.pageUrl;
    expect(await h.hello({ tab: { id: 3 }, documentId: "third" })).toEqual({
      ok: false,
      reason: "paused",
    });
    expect(executes()).toEqual([]);
    expect(refused()).toEqual([
      expect.objectContaining({ tabId: 1, reason: "paused", candidates: 1 }),
      expect.objectContaining({ tabId: 3, reason: "paused", candidates: 1 }),
    ]);
    // The saved default alone is offered, and the choice's amber count shows over the pause.
    expect(await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup)).toEqual(
      {
        ok: true,
        origin,
        documentId: "synthetic-document",
        candidates: [{ connectionId, itemId }],
        paused: true,
      },
    );
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("1"));
    expect(fake.state.badges[1]?.title).toBe(
      "Pateat: automatic login is paused on this site. Click to choose an account.",
    );
    expect(await status(h)).toMatchObject({
      ok: true,
      pause: { until: answer.until },
      page: { state: "denied", reason: "paused" },
    });
  });
  it("leaves other sites logging in", async () => {
    const { h } = paused();
    fake.state.tabUrls[3] = "https://elsewhere.example/";
    expect(await setPause(h, true, 3)).toEqual({ ok: true, until: expect.any(Number) });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
    expect((await status(h)).ok && (await status(h))).not.toHaveProperty("pause");
  });
  it("keeps normal and incognito windows apart", async () => {
    const { h } = paused();
    fake.state.incognito = new Set([2]);
    fake.state.tabUrls[2] = fake.state.pageUrl;
    await setPause(h, true, 2);
    expect(fake.state.session[PAUSES]).toMatchObject([{ site: "login.example", incognito: true }]);
    expect(await h.hello({ tab: { id: 2 }, documentId: "incognito" })).toEqual({
      ok: false,
      reason: "paused",
    });
    // The normal window's tab of the same site still logs in.
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(stored()).toMatchObject([{ state: "authenticated", document: { tabId: 1 } }]),
    );
  });
  it("pauses a frame's login when its tab's site or its own site is paused", async () => {
    const { h } = paused();
    const top = "https://top.example/page";
    const frame = { frameId: 4, documentId: "frame", tab: { id: 1, url: top } };
    fake.state.tabUrls[1] = top;
    // Unpaused, the frame is refused for another reason: the item does not match the tab.
    const before = (await h.hello(frame)) as { reason: string };
    expect(before.reason).toBe("frame-top-mismatch");
    await setPause(h, true);
    expect(await h.hello({ ...frame, documentId: "frame-2" })).toEqual({
      ok: false,
      reason: "paused",
    });
    await setPause(h, false);
    fake.state.tabUrls[2] = fake.state.pageUrl;
    await setPause(h, true, 2);
    expect(await h.hello({ ...frame, documentId: "frame-3" })).toEqual({
      ok: false,
      reason: "paused",
    });
  });
  it("ends by itself after an hour; an open page waits for its next announcement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { h } = paused();
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    expect(fake.state.reconnects).toEqual([]);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    // Nothing asks the page to announce again.
    expect(fake.state.reconnects).toEqual([]);
    expect(await status(h)).not.toHaveProperty("pause");
    expect(await h.hello({ documentId: "reloaded" })).toEqual({ ok: true });
  });
  it("survives a worker restart", async () => {
    const first = paused();
    await setPause(first.h, true);
    const restarted = paused();
    expect(await restarted.h.hello()).toEqual({ ok: false, reason: "paused" });
  });
  it("logs in once with a popup pick, whose sign-in ends the pause", async () => {
    const { h, reports } = paused();
    fake.state.openTabs = [1, 2];
    fake.state.tabUrls[2] = fake.state.pageUrl;
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
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
          makeDefault: false,
        },
        popup,
      ),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
    await vi.waitFor(() => expect(fake.state.session[PAUSES]).toEqual([]));
    expect(reports).toContainEqual({ type: "pause", tabId: 1, origin, action: "picked" });
    await vi.waitFor(() => expect(fake.state.badges[2]?.text).toBe(""));
    // The site's other tabs log in by themselves again.
    expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
  });
  it("stops the site's running automatic login before its next step; its tab asks", async () => {
    // The pause acts while the login waits for its next step.
    realTime();
    const { h, reports, refused } = paused();
    fake.state.openTabs = [1];
    let pausing: Promise<unknown> | undefined;
    // The password is filled; the person presses Pause before the form is submitted.
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind !== "fill") return;
      pausing = setPause(h, true);
      await pausing;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(pausing).toBeDefined());
    expect(await pausing).toEqual({ ok: true, until: expect.any(Number) });
    await vi.waitFor(() =>
      expect(reports).toContainEqual(
        expect.objectContaining({ type: "attempt", outcome: "policy-changed", cause: "paused" }),
      ),
    );
    // The submit is never clicked, and the login holds nothing.
    expect(
      executes().map(
        (entry) =>
          (entry as unknown as { operation: { step: { kind: string } } }).operation.step.kind,
      ),
    ).toEqual(["fill"]);
    await vi.waitFor(() => expect(stored()).toEqual([]));
    expect(fake.state.session[PAUSES]).toHaveLength(1);
    await vi.waitFor(() =>
      expect(refused()).toContainEqual(
        expect.objectContaining({ tabId: 1, reason: "paused", candidates: 1 }),
      ),
    );
    expect(
      await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup),
    ).toMatchObject({ ok: true, paused: true });
    expect(await status(h)).toMatchObject({ page: { state: "denied", reason: "paused" } });
  });
  it("stops a login when its next page shows on a paused site", async () => {
    // The next page shows while the login waits for it.
    realTime();
    const twoPages = parseLoginRecipe({
      version: 1,
      id: "synthetic-two-pages",
      revision: 1,
      origin,
      pageKind: "sign-in",
      slots: ["password"],
      steps: [
        { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        {
          kind: "fill",
          path: "/password",
          fields: [{ slot: "password", target: target("password") }],
        },
        { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
      ],
      maxSubmissions: 2,
    });
    // A pause this worker did not see start, as one stored before it restarted.
    let pausedTill: number | undefined;
    const { h, reports } = paused({
      pauses: {
        until: async () => pausedTill,
        pause: async () => pausedTill,
        resume: async () => false,
        clearIncognito: async () => undefined,
      },
    });
    h.recipes.recipe.mockResolvedValue(twoPages);
    // The first page's button is pressed; the site is paused before the next page shows.
    fake.state.onExecute = async () => {
      pausedTill = Date.now() + 60_000;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(1));
    fake.state.pageUrl = `${origin}/password`;
    fake.state.observedPath = "/password";
    const answer = await h.hello({ documentId: "next-page" });
    expect(answer).toEqual({ ok: false, reason: "paused" });
    expect(reports).toContainEqual(
      expect.objectContaining({ type: "attempt", outcome: "policy-changed", cause: "paused" }),
    );
    expect(executes()).toHaveLength(1);
    expect(stored()).toEqual([]);
  });
  it("refuses an announcement whose admission a pause overtook", async () => {
    const { h } = paused();
    h.recipes.recipe.mockImplementationOnce(async () => {
      await setPause(h, true);
      return recipe;
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    expect(executes()).toEqual([]);
    expect(stored()).toEqual([]);
  });
  it("uses the sender's window kind before the tab's", async () => {
    const { h } = paused();
    fake.state.incognito = new Set([2]);
    fake.state.tabUrls[2] = fake.state.pageUrl;
    await setPause(h, true, 2);
    // The browser no longer says the tab is incognito; the message's sender does.
    fake.state.incognito = new Set();
    expect(await h.hello({ tab: { id: 2, incognito: true }, documentId: "incognito" })).toEqual({
      ok: false,
      reason: "paused",
    });
    expect(await h.hello({ tab: { id: 2, incognito: false }, documentId: "normal" })).toEqual({
      ok: true,
    });
  });
  it("shows II again after a worker restart, until the pause ends", async () => {
    // The pause ends on the clock, after the badges are drawn.
    realTime();
    fake.state.openTabs = [1, 2, 3];
    fake.state.tabUrls[2] = "https://www.login.example/account";
    fake.state.tabUrls[3] = "https://elsewhere.example/";
    fake.state.session[PAUSES] = [
      {
        site: "login.example",
        incognito: false,
        length: "10m",
        until: new Date(Date.now() + 1500).toISOString(),
      },
    ];
    // The restarted worker draws the badges of the paused site's tabs without any page
    // announcing itself.
    paused();
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("II"));
    await vi.waitFor(() => expect(fake.state.badges[2]?.text).toBe("II"));
    expect(fake.state.badges[3]?.text ?? "").toBe("");
    // It ends by itself at the end time.
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe(""), { timeout: 4000 });
    expect(fake.state.badges[2]?.text).toBe("");
  });
  it("shows II on a tab that moved to a page of a paused site", async () => {
    // The pause's own end timer is the clock's next one, which a wait would fire.
    realTime();
    const badge = createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() });
    const { h } = paused({ badge });
    fake.state.openTabs = [1];
    await setPause(h, true);
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("II"));
    const elsewhere = "https://elsewhere.example/";
    badge.loaded(1, elsewhere);
    await h.login.tabLoaded({ id: 1, url: elsewhere, incognito: false } as never);
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe(""));
    const back = "https://www.login.example/";
    badge.loaded(1, back);
    await h.login.tabLoaded({ id: 1, url: back, incognito: false } as never);
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("II"));
  });
  it("re-offers a paused choice whose pick another tab's login overtook", async () => {
    const { h } = paused();
    fake.state.incognito = new Set([2]);
    fake.state.tabUrls[2] = fake.state.pageUrl;
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    // The incognito window is not paused; its login starts and holds the site meanwhile.
    fake.state.onExecute = () => new Promise(() => undefined);
    fake.state.onReconnect = async () => {
      await h.hello({ tab: { id: 2 }, documentId: "incognito" });
      return h.hello();
    };
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "synthetic-document",
          connectionId,
          itemId,
          makeDefault: false,
        },
        popup,
      ),
    ).toEqual({ ok: false, reason: "origin-busy" });
    expect(
      await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup),
    ).toMatchObject({ ok: true, paused: true, candidates: [{ connectionId, itemId }] });
  });
  it("asks the site's tabs to announce again on resume, so they log in at once", async () => {
    const { h, reports } = paused();
    fake.state.openTabs = [1, 2, 3];
    fake.state.tabUrls[2] = fake.state.pageUrl;
    fake.state.tabUrls[3] = "https://elsewhere.example/";
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    fake.state.onReconnect = () => h.hello();
    // Only the resume's own requests count, not the worker start's.
    fake.state.reconnects = [];
    expect(await setPause(h, false)).toEqual({ ok: true });
    expect(reports).toContainEqual({ type: "pause", tabId: 1, origin, action: "resumed" });
    expect(fake.state.session[PAUSES]).toEqual([]);
    expect(fake.state.reconnects).toEqual([{ tabId: 1 }, { tabId: 2 }]);
    await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
    // The pause's choice ended with it.
    expect(await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup)).toEqual(
      { ok: false, reason: "no-choice" },
    );
    // Nothing is left to resume.
    expect(await setPause(h, false)).toEqual({ ok: true });
    expect(fake.state.reconnects).toHaveLength(2);
  });
  const ruled = (rules: LocalSettings["excludedSites"]) =>
    harness(
      { excludedSites: rules },
      { badge: createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() }) },
    );
  it("pauses a site an exclusion rule covers until turned back on, in every tab and window kind", async () => {
    fake.state.openTabs = [1, 2, 3];
    fake.state.incognito.add(2);
    fake.state.tabUrls[2] = "https://www.login.example/account";
    fake.state.tabUrls[3] = "https://elsewhere.example/";
    // The worker draws the badges of the covered site's tabs as it starts.
    const h = ruled([{ hostname: "login.example", includeSubdomains: true }]);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    expect(executes()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
    // The page offers its account in the popup, as a paused page does.
    expect(
      await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup),
    ).toMatchObject({ ok: true, paused: true });
    // The page's waiting choice shows its count; every other tab of the site shows `II`
    // until turned back on, incognito ones too.
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("1"));
    await vi.waitFor(() =>
      expect(fake.state.badges[2]).toEqual({
        text: "II",
        title: "Pateat: automatic login is paused on this site until turned back on.",
      }),
    );
    expect(fake.state.badges[3]?.text ?? "").toBe("");
    // The rule holds in both window kinds, for the page's own passkey requests too.
    expect(await h.login.defaultUnset(origin, false)).toBe("paused");
    expect(await h.login.defaultUnset(origin, true)).toBe("paused");
    expect(await h.login.defaultUnset("https://elsewhere.example", false)).toBe(false);
    expect(
      await h.login.conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: new AbortController().signal,
        incognito: false,
      }),
    ).toEqual({ kind: "delegate", reason: "paused" });
    // The popup reads the rule from the settings; the worker reports no pause of a length.
    expect(await status(h)).not.toHaveProperty("pause");
  });
  it("applies a rule saved or removed elsewhere as a pause and a resume (ADR 0062)", async () => {
    const h = ruled([]);
    fake.state.openTabs = [1, 2];
    fake.state.tabUrls[2] = "https://www.login.example/account";
    // A conditional request of the page waits for its login.
    const waiting = h.login.conditionalRequest({
      tabId: 1,
      origin,
      documentId: "synthetic-document",
      signal: new AbortController().signal,
      incognito: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.settings.settings.excludedSites = [{ hostname: "login.example", includeSubdomains: true }];
    h.login.settingsChanged("saved");
    expect(await waiting).toEqual({ kind: "delegate", reason: "paused" });
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("II"));
    await vi.waitFor(() => expect(fake.state.badges[2]?.text).toBe("II"));
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    expect(executes()).toEqual([]);
    // Removing the rule asks the paused pages to announce again, so they log in at once.
    fake.state.reconnects = [];
    h.settings.settings.excludedSites = [];
    h.login.settingsChanged("synced");
    await vi.waitFor(() => expect(fake.state.reconnects).toContainEqual({ tabId: 1 }));
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe(""));
    expect(fake.state.badges[2]?.text).toBe("");
    // An unrelated settings change asks no page again.
    fake.state.reconnects = [];
    h.login.settingsChanged("saved");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.state.reconnects).toEqual([]);
  });
  const privateOff = () =>
    paused({}, { loginInPrivateWindows: undefined } as Parameters<typeof harness>[0]);
  const PRIVATE_TITLE = "Pateat: automatic login is off in private windows.";
  it("pauses every site of a private window while automatic login is off there, not a normal window", async () => {
    fake.state.openTabs = [1, 2, 3];
    fake.state.incognito = new Set([2, 3]);
    fake.state.tabUrls[2] = fake.state.pageUrl;
    fake.state.tabUrls[3] = "https://elsewhere.example/";
    const { h } = privateOff();
    // The private window's tabs show II as the worker starts, whatever their site.
    await vi.waitFor(() =>
      expect(fake.state.badges[2]).toEqual({ text: "II", title: PRIVATE_TITLE }),
    );
    await vi.waitFor(() =>
      expect(fake.state.badges[3]).toEqual({ text: "II", title: PRIVATE_TITLE }),
    );
    expect(fake.state.badges[1]?.text ?? "").toBe("");
    expect(await h.hello({ tab: { id: 2 }, documentId: "incognito" })).toEqual({
      ok: false,
      reason: "paused",
    });
    expect(executes()).toEqual([]);
    // The page offers its account in the popup, as a paused page does.
    expect(
      await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, popup),
    ).toMatchObject({ ok: true, paused: true });
    // The page's own passkey requests: a conditional one goes to the browser, and the
    // person's own ones are answered as before the pause, as Pateat's chooser cannot open
    // in a private window (ADR 0062 E).
    expect(
      await h.login.conditionalRequest({
        tabId: 2,
        origin,
        documentId: "incognito",
        signal: new AbortController().signal,
        incognito: true,
      }),
    ).toEqual({ kind: "delegate", reason: "paused" });
    expect(await h.login.defaultUnset(origin, true)).toBe(false);
    expect(await h.login.defaultUnset(origin, false)).toBe(false);
    // The private window keeps no pause of a length; the popup reads the setting.
    expect(await status(h, 2)).not.toHaveProperty("pause");
    expect(fake.state.session[PAUSES]).toBeUndefined();
    // The normal window's tab of the same site still logs in.
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(stored()).toMatchObject([{ state: "authenticated", document: { tabId: 1 } }]),
    );
  });
  it("applies automatic login in private windows as soon as it is turned on or off", async () => {
    fake.state.openTabs = [1, 2];
    fake.state.incognito = new Set([2]);
    fake.state.tabUrls[2] = fake.state.pageUrl;
    const { h } = privateOff();
    expect(await h.hello({ tab: { id: 2 }, documentId: "incognito" })).toEqual({
      ok: false,
      reason: "paused",
    });
    // Its waiting choice shows its count over the pause.
    await vi.waitFor(() => expect(fake.state.badges[2]?.text).toBe("1"));
    // Turned on elsewhere: the paused page announces again and logs in.
    fake.state.reconnects = [];
    fake.state.onReconnect = () => h.hello({ tab: { id: 2 }, documentId: "incognito" });
    h.settings.settings.loginInPrivateWindows = true;
    h.login.settingsChanged("synced");
    await vi.waitFor(() => expect(fake.state.reconnects).toContainEqual({ tabId: 2 }));
    await vi.waitFor(() =>
      expect(stored()).toMatchObject([{ state: "authenticated", document: { tabId: 2 } }]),
    );
    expect(["1", "II"]).not.toContain(fake.state.badges[2]?.text);
    expect(fake.state.badges[1]?.text ?? "").toBe("");
    // Turned off again: the private window's tabs are paused once more.
    fake.state.onReconnect = undefined;
    delete h.settings.settings.loginInPrivateWindows;
    h.login.settingsChanged("saved");
    await vi.waitFor(() =>
      expect(fake.state.badges[2]).toEqual({ text: "II", title: PRIVATE_TITLE }),
    );
    expect(await h.login.defaultUnset(origin, true)).toBe(false);
    // A pause of the site in the private window still treats its default as unset.
    await setPause(h, true, 2);
    expect(await h.login.defaultUnset(origin, true)).toBe("paused");
  });
  it("pauses for the length the person chose, and logs it", async () => {
    const { h, reports } = paused();
    fake.state.openTabs = [1];
    const answer = (await setPause(h, true, 1, "10m")) as { ok: true; until: number };
    expect(answer.until - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(answer.until - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(fake.state.session[PAUSES]).toEqual([expect.objectContaining({ length: "10m" })]);
    expect(reports).toContainEqual(expect.objectContaining({ action: "paused", length: "10m" }));
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    // A pause needs a known length.
    const before = structuredClone(fake.state.session[PAUSES]);
    expect(
      await h.login.handle(
        { version: 1, type: "login.pause.set", tabId: 1, paused: true, length: "1d" },
        popup,
      ),
    ).not.toMatchObject({ ok: true });
    expect(
      await h.login.handle({ version: 1, type: "login.pause.set", tabId: 1, paused: true }, popup),
    ).not.toMatchObject({ ok: true });
    expect(fake.state.session[PAUSES]).toEqual(before);
  });
  it("tells the popup a site's timed pause from the tab alone, without the page status", async () => {
    const { h } = paused();
    fake.state.openTabs = [1];
    const state = () => h.login.handle({ version: 1, type: "login.pause.get", tabId: 1 }, popup);
    expect(await state()).toEqual({ ok: true });
    const { until } = (await setPause(h, true, 1, "10m")) as { ok: true; until: number };
    expect(await state()).toEqual({ ok: true, until });
    await setPause(h, false);
    expect(await state()).toEqual({ ok: true });
    fake.state.tabUrls[1] = "chrome://newtab/";
    expect(await state()).toEqual({ ok: false, reason: "no-site" });
  });
  it("has no site to pause on a page that is not a website", async () => {
    const { h } = paused();
    fake.state.tabUrls[1] = "chrome://newtab/";
    expect(await setPause(h, true)).toEqual({ ok: false, reason: "no-site" });
    expect(fake.state.session[PAUSES]).toBeUndefined();
  });
  it("hands the site's own conditional passkey requests on at once", async () => {
    const { h } = paused();
    fake.state.openTabs = [1];
    const request = (documentId: string) =>
      h.login.conditionalRequest({
        tabId: 1,
        origin,
        documentId,
        signal: new AbortController().signal,
      });
    // One already waiting is handed on when the pause starts.
    const waiting = request("synthetic-document");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setPause(h, true);
    expect(await waiting).toEqual({ kind: "delegate", reason: "paused" });
    expect(await request("later")).toEqual({ kind: "delegate", reason: "paused" });
  });
  it("refuses a pick of an item with only a passkey, which the pause keeps from it", async () => {
    const { h, refused } = paused({
      passkeys: vi.fn(async () => ({ passkey: true, discoverable: true })),
    });
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        for (const field of response.catalog.connections[0]!.items[0]!.fields)
          if (field.id === "login.password") field.empty = true;
      return response;
    });
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
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
          makeDefault: false,
        },
        popup,
      ),
    ).toEqual({ ok: false, reason: "paused-no-password" });
    expect(executes()).toEqual([]);
    expect(stored()).toEqual([]);
    expect(refused()).toContainEqual(
      expect.objectContaining({
        reason: "no-route",
        detail: expect.stringMatching(/^password-empty/u),
      }),
    );
    expect(pickFailure("paused-no-password", "Synthetic item", false, i18n.getFixedT("en"))).toBe(
      "Automatic login is paused on this site, and Synthetic item has no password, so Pateat did not log in. To sign in with its passkey, use the page's own passkey sign-in button and choose Synthetic item in Pateat's window.",
    );
  });
  it("reads the pause and the asking from settings the passkey runtime already read", async () => {
    const { h } = paused();
    fake.state.openTabs = [1];
    const rule = { hostname: "login.example", includeSubdomains: true };
    // The copy wins over the store, which holds no rule.
    expect(
      await h.login.defaultUnset(origin, false, { excludedSites: [rule], siteDefaults: [] }),
    ).toBe("paused");
    expect(await h.login.defaultUnset(origin, false, { excludedSites: [], siteDefaults: [] })).toBe(
      false,
    );
    // Private windows still do not count for the person's own request (ADR 0062 E).
    expect(await h.login.defaultUnset(origin, true, { excludedSites: [], siteDefaults: [] })).toBe(
      false,
    );
  });
  it("tells the passkey runtime which window kind's site is paused", async () => {
    const { h } = paused();
    fake.state.openTabs = [1];
    expect(await h.login.defaultUnset(origin, false)).toBe(false);
    await setPause(h, true);
    expect(await h.login.defaultUnset(origin, false)).toBe("paused");
    // Incognito windows keep their own pauses, and another site is not paused.
    expect(await h.login.defaultUnset(origin, true)).toBe(false);
    expect(await h.login.defaultUnset("https://other.example", false)).toBe(false);
    await setPause(h, false);
    expect(await h.login.defaultUnset(origin, false)).toBe(false);
  });
  it("counts a site as paused while the paused sites cannot be read (ADR 0062)", async () => {
    const unreadable = async (): Promise<number | undefined> => {
      throw new Error("Synthetic read failure");
    };
    const { h } = paused({
      pauses: {
        until: unreadable,
        pause: unreadable,
        resume: async () => false,
        clearIncognito: async () => undefined,
      },
    });
    fake.state.openTabs = [1];
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    expect(executes()).toEqual([]);
    expect(await h.login.defaultUnset(origin, false)).toBe("paused");
    expect(
      await h.login.conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: new AbortController().signal,
        incognito: false,
      }),
    ).toEqual({ kind: "delegate", reason: "paused" });
    // The popup shows no end it does not know.
    expect(await status(h)).not.toHaveProperty("pause");
  });
  it("leaves the other window kind's tabs of the site alone on a pause and a resume", async () => {
    const { h } = paused();
    fake.state.openTabs = [1, 2];
    fake.state.incognito.add(2);
    fake.state.tabUrls[2] = fake.state.pageUrl;
    // The incognito tab's page of the site logs in, as its window is not paused.
    expect(await h.hello({ tab: { id: 2 }, documentId: "incognito" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(stored()).toMatchObject([{ state: "authenticated", document: { tabId: 2 } }]),
    );
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    expect(fake.state.badges[2]?.text ?? "").not.toBe("II");
    // Resuming asks only the normal window's tab to announce again.
    fake.state.reconnects = [];
    expect(await setPause(h, false)).toEqual({ ok: true });
    expect(fake.state.reconnects).toEqual([{ tabId: 1 }]);
  });
  it("forgets the private session's pauses, repeat counts and asks once its last window closes", async () => {
    // The pauses' own timers must not end them while the test waits.
    realTime();
    fake.state.windows = [false, true];
    try {
      fake.state.session["pateat.login-ask-every-time.v1"] = [
        { site: "login.example", incognito: true, defaults: "[]" },
        { site: "login.example", incognito: false, defaults: "[]" },
      ];
      const { h } = paused();
      const closed = fake.state.windowRemoved.at(-1)!;
      fake.state.openTabs = [1, 2];
      fake.state.incognito.add(2);
      fake.state.tabUrls[2] = fake.state.pageUrl;
      await setPause(h, true, 1);
      await setPause(h, true, 2);
      const silent = (incognito: boolean) =>
        h.login.passkeyAnswered(incognito ? 2 : 1, origin, "login.example", undefined, {
          silent: true,
          incognito,
        });
      silent(true);
      silent(false);
      await vi.waitFor(() =>
        expect(fake.state.session["pateat.login-relogins.v1"]).toHaveLength(2),
      );
      // A window closes while a private one is still open: nothing is forgotten.
      closed(0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.state.session[PAUSES]).toHaveLength(2);
      // The last private window closes.
      fake.state.windows = [false];
      closed(1);
      await vi.waitFor(() =>
        expect(fake.state.session[PAUSES]).toEqual([
          expect.objectContaining({ site: "login.example", incognito: false }),
        ]),
      );
      await vi.waitFor(() =>
        expect(fake.state.session["pateat.login-ask-every-time.v1"]).toEqual([
          { site: "login.example", incognito: false, defaults: "[]" },
        ]),
      );
      await vi.waitFor(() =>
        expect(fake.state.session["pateat.login-relogins.v1"]).toEqual([
          expect.objectContaining({ site: "login.example", incognito: false }),
        ]),
      );
      expect(await h.login.defaultUnset(origin, false)).toBe("paused");
    } finally {
      fake.state.windows = [false];
    }
  });
  it("hands on a conditional request whose site was paused while it was parked", async () => {
    let pausedTill: number | undefined;
    const { h } = paused({
      pauses: {
        until: async () => pausedTill,
        pause: async () => pausedTill,
        resume: async () => false,
        clearIncognito: async () => undefined,
      },
    });
    // The pause starts after the request was first checked, before it waits.
    h.recipes.starts.mockImplementation(async () => {
      pausedTill = Date.now() + 60_000;
      return startsOf([recipe.steps[0]!]);
    });
    expect(
      await h.login.conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: new AbortController().signal,
        incognito: false,
      }),
    ).toEqual({ kind: "delegate", reason: "paused" });
  });
  it("ends paused choices on resume after the pause ran out, and re-announces frames", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { h } = paused();
    fake.state.openTabs = [1, 3];
    const top = "https://top.example/page";
    fake.state.tabUrls[3] = top;
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("1"));
    // A frame of the site inside another site's page.
    expect(await h.hello({ tab: { id: 3, url: top }, frameId: 4, documentId: "frame" })).toEqual({
      ok: false,
      reason: "paused",
    });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    fake.state.reconnects = [];
    // Nothing is stored any more, yet the pause's choice ends and the pages announce again.
    expect(await setPause(h, false)).toEqual({ ok: true });
    expect(fake.state.reconnects).toEqual(expect.arrayContaining([{ tabId: 1 }, { tabId: 3 }]));
    await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe(""));
  });
});
