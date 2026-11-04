import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginReport } from "../runtime/report";
import { HOLD_MS, SITE_WAIT_MS } from "../runtime/constants";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, startsOf, recipe, userId, itemId, savedBinding, harness } =
  createRuntimeTestHarness(fake);

// A login's wait for the site that a stopped worker lost ends when it ran out (ADR 0022,
// amended 2026-11-03): a Microsoft login stayed `reconciling` for two hours in the owner's
// Chrome after a page of another origin of the site asked for a passkey.
describe("a login whose wait for the site ran out", () => {
  const auth = "https://auth.login.example";
  const second = "https://second.example";
  const secondRecipe = parseLoginRecipe({ ...recipe, id: "second-signin", origin: second });
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  type Stored = {
    id: string;
    state: string;
    outcome?: string;
    settled?: true;
    changedAt?: number;
    watch?: { since: number };
    timing: { since: number; pageMs: number; pageSince?: number; personSince?: number };
    account: { origin: string };
    document: { tabId: number; origin: string; documentId: string };
  };
  const stored = () => (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Stored[];
  const at = (from: string) => stored().find((entry) => entry.account.origin === from);
  const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const attempts = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
    report.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry): entry is Extract<LoginReport, { type: "attempt" }> => entry.type === "attempt",
      );

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
    fake.state.gone = new Set();
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.openTabs = undefined;
  });

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
      path !== "/signin" ? undefined : from === origin ? recipe : undefined,
    );
    h.recipes.starts.mockImplementation(async (from: string) =>
      startsOf(from === origin ? [recipe.steps[0]!] : []),
    );
    return h;
  };
  const navigate = (h: ReturnType<typeof harness>, url: string, documentId: string) => {
    fake.state.tabUrls[1] = url;
    return h.hello({ documentId, url }, false);
  };
  /** A login whose submit click never returns, held by a page of `auth` that asked for a passkey. */
  const askedThere = async (live: Parameters<typeof harness>[1] = {}) => {
    fake.state.onExecute = (message) =>
      (message["operation"] as { step: { kind: string } }).step.kind === "click"
        ? new Promise(() => undefined)
        : Promise.resolve();
    const h = twoSites(live);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(2));
    fake.state.signs = quiet;
    h.login.passkeyRequested(1, auth);
    expect(await navigate(h, `${auth}/passkey`, "auth-document")).toEqual({
      ok: false,
      reason: "stale-document",
    });
    expect(at(origin)).not.toMatchObject({ state: "blocked" });
    return h;
  };
  /** The stored login as a stopped worker left it, its wait for the site begun `ago` ms ago. */
  const stoppedWorker = (ago: number) => {
    const record = at(origin)!;
    const now = Date.now();
    fake.state.storage["pateat.login-attempts.v5"] = [
      {
        ...record,
        timing: {
          since: now - ago - 5_000,
          serviceMs: 0,
          networkMs: 0,
          personMs: 0,
          pageMs: 0,
          pageSince: now - ago,
        },
      },
    ];
    fake.state.openTabs = [1];
    return now - ago + SITE_WAIT_MS;
  };

  it("ends left-origin when the worker starts again on the page of another origin", async () => {
    await askedThere();
    const ranOut = stoppedWorker(SITE_WAIT_MS + 60_000);
    const report = vi.fn<(report: LoginReport) => void>();
    const restarted = twoSites({ report });
    expect(await restarted.login.active()).toBe(false);
    expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
    expect(at(origin)!.timing.pageSince).toBeUndefined();
    const ended = attempts(report).find((entry) => entry.outcome === "left-origin")!;
    // It ended when the wait ran out, a minute before the worker started again.
    expect(ended.times).toMatchObject({ pageMs: SITE_WAIT_MS, totalMs: SITE_WAIT_MS + 5_000 });
    expect(Date.now()).toBeGreaterThanOrEqual(ranOut + 60_000);
    // Nothing was typed or clicked again.
    expect(executes()).toHaveLength(2);
  });

  it("settles as unknown and is watched from then when the tab is back on its origin", async () => {
    await askedThere();
    const ranOut = stoppedWorker(SITE_WAIT_MS + 60_000);
    fake.state.tabUrls[1] = `${origin}/callback`;
    const restarted = twoSites();
    expect(await restarted.login.active()).toBe(false);
    const record = at(origin)!;
    expect(record).toMatchObject({
      state: "reconciling",
      settled: true,
      outcome: "unknown-submit",
    });
    expect(record.watch?.since).toBe(ranOut);
    expect(record.timing).toMatchObject({ pageMs: SITE_WAIT_MS, personSince: ranOut });
    expect(record.timing.pageSince).toBeUndefined();
  });

  it("ends cancelled a login that submitted nothing, which no step goes on with", async () => {
    await askedThere();
    stoppedWorker(SITE_WAIT_MS + 60_000);
    const [record] = stored() as unknown as Record<string, unknown>[];
    const {
      operationId: _id,
      operationKind: _kind,
      operationEffect: _effect,
      mutationIntent: _intent,
      outcome: _outcome,
      ...rest
    } = record!;
    fake.state.storage["pateat.login-attempts.v5"] = [
      { ...rest, state: "ready", stepIndex: 0, submissions: 0, usedOperationIds: [] },
    ];
    fake.state.tabUrls[1] = `${origin}/signin`;
    const restarted = twoSites();
    expect(await restarted.login.active()).toBe(false);
    expect(at(origin)).toMatchObject({ state: "blocked", outcome: "cancelled" });
    expect(at(origin)!.timing.pageMs).toBe(SITE_WAIT_MS);
  });

  it("wakes the stopped worker by the alarm when the wait runs out later", async () => {
    await askedThere();
    const ranOut = stoppedWorker(10_000);
    const siteWait = vi.fn<(when: number | undefined) => void>();
    const restarted = twoSites({ siteWait });
    expect(await restarted.login.active()).toBe(true);
    expect(at(origin)).toMatchObject({ state: "reconciling" });
    await vi.waitFor(() => expect(siteWait).toHaveBeenLastCalledWith(ranOut));
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + SITE_WAIT_MS);
    onTestFinished(() => clock.mockRestore());
    await restarted.login.siteWaitDue();
    expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
    expect(at(origin)!.timing.pageMs).toBe(SITE_WAIT_MS);
    // No login waits for the site any more, so the alarm is cleared.
    expect(siteWait).toHaveBeenLastCalledWith(undefined);
  });

  it("ends at the bound when the tab's next page shows only after it", async () => {
    await askedThere();
    stoppedWorker(10_000);
    const report = vi.fn<(report: LoginReport) => void>();
    const restarted = twoSites({ report });
    expect(await restarted.login.active()).toBe(true);
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 2 * 60 * 60_000);
    onTestFinished(() => clock.mockRestore());
    await navigate(restarted, `${auth}/passkey`, "auth-again");
    expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
    const ended = attempts(report).find((entry) => entry.outcome === "left-origin")!;
    // Two hours later, but the wait counts only until it ran out.
    expect(ended.times).toMatchObject({ pageMs: SITE_WAIT_MS, totalMs: SITE_WAIT_MS + 5_000 });
  });

  it("settles a login whose next page never showed once the alarm fires", async () => {
    // The submit replaces the document, so the login waits for the tab's next page.
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
        fake.state.gone.add("synthetic-document");
    };
    const h = twoSites({ siteWait: () => undefined });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(at(origin)?.timing.pageSince).toBeDefined());
    expect(await h.login.active()).toBe(true);
    const ranOut = at(origin)!.timing.pageSince! + SITE_WAIT_MS;
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + SITE_WAIT_MS);
    onTestFinished(() => clock.mockRestore());
    await h.login.siteWaitDue();
    expect(at(origin)).toMatchObject({ state: "reconciling", settled: true });
    expect(at(origin)!.watch?.since).toBe(ranOut);
    // A login settled as unknown no longer holds settings writes back.
    expect(await h.login.active()).toBe(false);
  });

  it("ends left-origin when the tab shows no web page, so the site is not held for a watch", async () => {
    // RC 2026-11-04: app.notion.com's tab went to about:blank after the password submit,
    // and the watch from the bound held the site against other tabs for 10 minutes.
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
        fake.state.gone.add("synthetic-document");
    };
    const h = twoSites({ siteWait: () => undefined });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(at(origin)?.timing.pageSince).toBeDefined());
    // Pateat may read every HTTP(S) page, so `about:blank` comes without a URL.
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = async (id: number) => ({ id, incognito: false }) as never;
    onTestFinished(() => {
      fake.browser.tabs.get = get;
    });
    const now = Date.now.bind(Date);
    let ahead = SITE_WAIT_MS;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + ahead);
    onTestFinished(() => clock.mockRestore());
    await h.login.siteWaitDue();
    expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
    expect(at(origin)!.watch).toBeUndefined();
    expect(at(origin)!.timing.pageMs).toBe(SITE_WAIT_MS);
    // Another tab of the site logs in once the record's own hold ends, as after any move away.
    fake.browser.tabs.get = get;
    ahead = HOLD_MS + 1_000;
    fake.state.tabUrls[2] = fake.state.pageUrl;
    expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
  });

  it("settles as unknown when the tab could not be read, as one Chrome is replacing", async () => {
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
        fake.state.gone.add("synthetic-document");
    };
    const h = twoSites({ siteWait: () => undefined });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(at(origin)?.timing.pageSince).toBeDefined());
    const get = fake.browser.tabs.get;
    fake.browser.tabs.get = async () => {
      throw new Error("No tab with id: 1.");
    };
    onTestFinished(() => {
      fake.browser.tabs.get = get;
    });
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + SITE_WAIT_MS);
    onTestFinished(() => clock.mockRestore());
    await h.login.siteWaitDue();
    expect(at(origin)).toMatchObject({ state: "reconciling", settled: true });
  });

  it("leaves a login that a page that asked for a passkey holds to that page", async () => {
    const siteWait = vi.fn<(when: number | undefined) => void>();
    // The submit replaces the document, so the login waits for the tab's next page.
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
        fake.state.gone.add("synthetic-document");
    };
    const h = twoSites({ siteWait });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(at(origin)?.timing.pageSince).toBeDefined());
    fake.state.signs = quiet;
    h.login.passkeyRequested(1, auth);
    expect(await navigate(h, `${auth}/passkey`, "auth-document")).toMatchObject({ ok: false });
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + SITE_WAIT_MS);
    onTestFinished(() => clock.mockRestore());
    await h.login.siteWaitDue();
    expect(at(origin)).toMatchObject({ state: "reconciling" });
    expect(at(origin)!.settled).toBeUndefined();
    // It is looked at again 30 seconds later, Chrome's shortest alarm delay.
    expect(siteWait.mock.lastCall?.[0]).toBeGreaterThanOrEqual(now() + SITE_WAIT_MS + 30_000);
  });
});
