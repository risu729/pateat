import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type DetailLink, type LocalSettings } from "@pateat/contracts";
import type { LoginGeneration, LoginReport } from "../runtime";
import { siteDefaultsMark, type LogoutService } from "../switch";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  snapshotId,
  target,
  recipe,
  userId,
  otherItemId,
  liveAccountPolicy,
  harness,
  setPause,
} = createRuntimeTestHarness(fake);

describe("second-factor page handlers chosen per account (ADR 0027)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
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
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.cardHints = undefined;
    fake.state.question = undefined;
  });
  const securityKey = { by: "text" as const, value: "Use security key" };
  const keyHandler = { kind: "passkey" as const, path: "/login/webauthn", target: securityKey };
  const { completion: _unlearned, ...unlearned } = recipe;
  const plain = parseLoginRecipe(unlearned);
  const home = [{ target: target("logout") }];
  void parseLoginRecipe({ ...unlearned, completion: home, handlers: [keyHandler] });
  void parseLoginRecipe({ ...unlearned, revision: 2, handlers: [keyHandler] });
  const withPasskey = vi.fn(async () => ({ passkey: true, discoverable: false }));
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  void observation("/login/webauthn", [
    { id: "c1", role: "button", target: securityKey, label: "Use security key" },
  ]);
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map(
        (entry) =>
          (
            entry as unknown as {
              operation: { step: { kind: string; target?: { value: string } } };
            }
          ).operation.step,
      );
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target?.value === value).length;
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown } | "hang">,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || !step.target) return;
      const next = pages[step.target.value];
      if (next === "hang") return new Promise<void>(() => undefined);
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };

  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  function generation(judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" })) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      // Like the service, it says just before the request leaves the device.
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }

  async function until(check: () => boolean, maxMs = 200_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const settled = (state: string, outcome?: string) => () =>
    status()?.[0]?.["state"] === state &&
    (outcome === undefined || status()?.[0]?.["outcome"] === outcome);
  describe("a login watched after a step left to the person (ADR 0027)", () => {
    const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
    const described = (path: string) =>
      observation(path, [{ id: "c1", role: "link", target: target("help"), label: "Help" }]);
    const reports = vi.fn<(report: LoginReport) => void>();
    const judges = () =>
      reports.mock.calls.flatMap(([value]) =>
        value.type === "judge" && value.verdict !== "sent" ? [value] : [],
      );
    async function watched(
      verdicts: Awaited<ReturnType<LoginGeneration["judge"]>>["verdict"][] = [],
      chosen = plain,
      before?: (h: ReturnType<typeof harness>) => Promise<unknown>,
      live: Parameters<typeof harness>[1] = {},
    ) {
      vi.useFakeTimers();
      reports.mockClear();
      fake.state.signs = quiet;
      onClick({ login: { path: "/approve", present: [], extracted: described("/approve") } });
      const answers = ["challenge" as const, ...verdicts];
      const service = generation(async () => ({ verdict: answers.shift() ?? "unclear" }));
      const h = harness(
        {},
        { passkeys: withPasskey, generation: service, report: reports, ...live },
      );
      h.recipes.recipe.mockResolvedValue(chosen);
      await before?.(h);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"), 10_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      return { h, service };
    }
    async function open(
      h: ReturnType<typeof harness>,
      path: string,
      present: string[] = [],
      wait = 30_000,
    ) {
      fake.state.pageUrl = `${origin}${path}`;
      fake.state.observedPath = path;
      fake.state.present = new Set(present);
      fake.state.extracted = { "signed-in": described(path) };
      const answer = await h.hello({ documentId: `document${path.replaceAll("/", "-")}` }, false);
      await vi.advanceTimersByTimeAsync(wait);
      return answer;
    }
    it("completes on another layout's signed-in marker without asking the judge (ADR 0060)", async () => {
      // The login runs layout 1000, which has learned no marker; layout 2000 has.
      const running = parseLoginRecipe({ ...unlearned, layout: "1000" });
      const marked = parseLoginRecipe({ ...unlearned, layout: "2000", completion: home });
      const { h, service } = await watched([], running, async (created) => {
        Object.assign(created.recipes, { layoutsOf: vi.fn(async () => [running, marked]) });
      });
      await open(h, "/home", ["logout"]);
      expect(status()).toMatchObject([{ state: "authenticated" }]);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(
        reports.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])).at(-1),
      ).toMatchObject({ e1: true, decision: "signed-in" });
    });
    it("reads no sign-in state when another layout's marker cannot be observed (ADR 0060)", async () => {
      const running = parseLoginRecipe({ ...unlearned, layout: "1000" });
      const marked = parseLoginRecipe({ ...unlearned, layout: "2000", completion: home });
      const { h, service } = await watched([], running, async (created) => {
        Object.assign(created.recipes, { layoutsOf: vi.fn(async () => [running, marked]) });
      });
      fake.state.unobservable = new Set(["logout"]);
      const before = reports.mock.calls.length;
      await open(h, "/home", ["logout"]);
      // The page's sign-in state is unreadable: it neither completes the login nor goes to
      // the judge, and the login stays watched.
      expect(reports.mock.calls.slice(before).filter(([value]) => value.type === "state")).toEqual(
        [],
      );
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()).toMatchObject([{ state: "watching" }]);
    });
    it("ends as a refused password when the judge says so", async () => {
      const { h } = await watched(["rejected"]);
      await open(h, "/home");
      expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]);
    });
    it("stays watched on undecided pages, two at most, with a warning", async () => {
      const { h, service } = await watched(["unclear", "challenge"]);
      const { changedAt } = status()![0]!;
      await open(h, "/next");
      await open(h, "/later");
      await open(h, "/last");
      expect(service.judge).toHaveBeenCalledTimes(3);
      // Judged pages do not prolong the hold on the site (ADR 0022).
      expect(status()).toMatchObject([
        { state: "watching", outcome: "challenge", watch: { pages: 2 }, changedAt },
      ]);
      // The watch keeps the path of its own document, not a later document's.
      expect(status()).toMatchObject([{ watch: { path: "/approve" } }]);
      expect(judges().slice(1)).toMatchObject(
        [
          { verdict: "unclear", watched: true },
          { verdict: "challenge", watched: true, takenOver: false },
          { verdict: "not-sent", reason: "page-limit", watched: true },
        ].map(({ takenOver: _taken, ...rest }) => rest),
      );
    });
    it("never judges a page that shows a sign-in going on", async () => {
      const { h, service } = await watched();
      fake.state.signs = { ...quiet, code: true };
      await open(h, "/verify");
      fake.state.signs = quiet;
      await open(h, "/signin", ["password"]);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()).toMatchObject([{ state: "watching" }]);
    });
    it("keeps watching when another site's account choice is saved, as LinkedIn's was", async () => {
      const { h, service } = await watched(["signed-in"]);
      // 2026-10-12: a save for another site bumped the settings revision during LinkedIn's
      // watch, which ended it as a policy change though its account was still chosen.
      h.settings.settings.siteDefaults.push({
        origin: "https://other.example",
        provider: "bitwarden",
        server: "cloud-us",
        userId,
        itemId: otherItemId,
      });
      h.settings.revision += 1;
      const { changedAt } = status()![0]!;
      await vi.advanceTimersByTimeAsync(60_000);
      h.login.settingsChanged("saved");
      await vi.advanceTimersByTimeAsync(1000);
      // Taking the newer settings over does not prolong the hold on the site (ADR 0022).
      expect(status()).toMatchObject([{ state: "watching", policyRevision: 2, changedAt }]);
      await open(h, "/home");
      expect(service.judge).toHaveBeenCalledTimes(2);
      expect(status()).toMatchObject([{ state: "authenticated", policyRevision: 2 }]);
    });
    it("stops a watched login once newer settings no longer allow its account", async () => {
      const { h, service } = await watched(["signed-in"]);
      h.settings.settings.accountPolicies = [liveAccountPolicy({ enabled: false })];
      h.settings.revision += 1;
      h.login.settingsChanged("saved");
      await open(h, "/home");
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]);
      expect(reports).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "policy-changed", cause: "plan" }),
      );
    });
    it("keeps watching after a worker restart finds newer settings that keep its account", async () => {
      const { service } = await watched(["signed-in"]);
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness(
          {},
          { passkeys: withPasskey, generation: service, report: reports },
        );
        restarted.recipes.recipe.mockResolvedValue(plain);
        restarted.settings.revision = 2;
        await open(restarted, "/home");
        expect(service.judge).toHaveBeenCalledTimes(2);
        expect(status()).toMatchObject([{ state: "authenticated", policyRevision: 2 }]);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    async function signInPage(h: ReturnType<typeof harness>, tabId: number, documentId: string) {
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      fake.state.tabUrls[tabId] = fake.state.pageUrl;
      const answer = await h.hello({ tab: { id: tabId }, documentId });
      await vi.advanceTimersByTimeAsync(5_000);
      return answer;
    }
    const abandoned = (outcome: string, tabId = 1) =>
      expect.objectContaining({ type: "attempt", tabId, state: "blocked", outcome });
    it("ends a watch that never signed in when its first step shows again: this tab only fills", async () => {
      const { h } = await watched();
      const steps = executed().length;
      // The approval expired and the site went back to its sign-in page (owner, 2026-10-13).
      expect(await open(h, "/signin", ["password", "login"], 0)).toEqual({
        ok: true,
        starts: expect.any(Array),
      });
      // The page reports the first step ready.
      expect(await h.hello({ documentId: "document-signin" })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reports).toHaveBeenCalledWith(abandoned("challenge-abandoned"));
      expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
      // The tab fills the form once, without pressing anything (ADR 0021 D).
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill"]);
      expect(reports).toHaveBeenCalledWith(
        expect.objectContaining({ type: "start", tabId: 1, fillOnly: true }),
      );
      expect(reports).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refused",
          tabId: 1,
          reason: "account-asked",
          detail: "stopped-login",
        }),
      );
      expect(fake.state.badges[1]?.title).toBe(
        "Pateat: the last login on this site stopped in this tab. Click to choose an account.",
      );
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      expect(
        await h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, popup),
      ).toMatchObject({ ok: true, ask: "stopped-login" });
      expect(status() ?? []).toEqual([]);
      // Another tab, or a new one, logs in as before and presses the button.
      const before = executed().length;
      expect(await signInPage(h, 2, "other-tab")).toEqual({ ok: true });
      expect(
        executed()
          .slice(before)
          .map((step) => step.kind),
      ).toEqual(["fill", "click"]);
      expect(reports).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "start", tabId: 2, fillOnly: true }),
      );
      expect(reports).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "refused", tabId: 2, reason: "account-asked" }),
      );
    });
    it("keeps the site from another tab while the watch lasts, so no second code is sent", async () => {
      const { h } = await watched();
      const steps = executed().length;
      // While the first tab waits for its code, the person opens the sign-in page in a new
      // tab (Instagram on Real Chrome, 2026-10-23): it neither logs in nor ends the watch.
      expect(await signInPage(h, 2, "other-tab")).toEqual({ ok: false, reason: "origin-busy" });
      expect(executed().slice(steps)).toEqual([]);
      expect(reports).not.toHaveBeenCalledWith(abandoned("challenge-abandoned", 1));
      expect(status()).toMatchObject([{ state: "watching", document: { tabId: 1 } }]);
      // Past the hold's 5 minutes the watch still keeps it.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await signInPage(h, 2, "other-tab-later")).toEqual({
        ok: false,
        reason: "origin-busy",
      });
      expect(executed().slice(steps)).toEqual([]);
      // Once the watch's 10 minutes are over, the other tab logs in as before.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await signInPage(h, 2, "other-tab-after")).toEqual({ ok: true });
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill", "click"]);
    });
    it("lets another tab log in once the watched tab closes", async () => {
      const { h } = await watched();
      const steps = executed().length;
      expect(await signInPage(h, 2, "other-tab")).toEqual({ ok: false, reason: "origin-busy" });
      for (const listener of fake.state.removed) listener(1);
      await vi.waitFor(() => expect(status() ?? []).toEqual([]));
      expect(await signInPage(h, 2, "other-tab-again")).toEqual({ ok: true });
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill", "click"]);
    });
    it("never keeps an incognito tab from logging in while a normal tab's login is watched", async () => {
      const { h } = await watched();
      const steps = executed().length;
      // An incognito window keeps its own cookies, so its login sends no second code to
      // the same session (owner, 2026-10-23).
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2, incognito: true }, documentId: "incognito" })).toEqual({
        ok: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill", "click"]);
      // The normal tab's login is still watched.
      expect(status()).toContainEqual(
        expect.objectContaining({
          state: "watching",
          document: expect.objectContaining({ tabId: 1 }),
        }),
      );
    });
    const fromPopup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    it("keeps watching on a site paused meanwhile; another tab asks as paused, held (ADR 0062)", async () => {
      const { h } = await watched();
      const steps = executed().length;
      // Pateat presses nothing more for a watched login, so the pause leaves its code page.
      expect(await setPause(h, true)).toEqual({ ok: true, until: expect.any(Number) });
      expect(status()).toMatchObject([{ state: "watching", document: { tabId: 1 } }]);
      expect(reports).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "attempt", outcome: "policy-changed" }),
      );
      // Another tab of the paused site offers its choice, marked as held by the watch, and
      // a pick there waits rather than sending a second code.
      expect(await signInPage(h, 2, "paused-tab")).toEqual({ ok: false, reason: "paused" });
      expect(
        await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, fromPopup),
      ).toMatchObject({ ok: true, paused: true, held: true });
      expect(
        await h.login.handle(
          {
            version: 1,
            type: "login.choice.pick",
            tabId: 2,
            documentId: "paused-tab",
            connectionId,
            itemId,
            makeDefault: false,
          },
          fromPopup,
        ),
      ).toEqual({ ok: false, reason: "origin-busy" });
      expect(executed().slice(steps)).toEqual([]);
      expect(status()).toMatchObject([{ state: "watching", document: { tabId: 1 } }]);
    });
    it("holds the site against another tab that asks after a one-time pick (ADR 0063)", async () => {
      const { h, service } = await watched();
      const steps = executed().length;
      // The site asks every time, as after a pick in another tab without the default; the
      // worker restarts and reads it with the watched login.
      fake.state.session["pateat.login-ask-every-time.v1"] = [
        {
          site: "login.example",
          incognito: false,
          defaults: siteDefaultsMark(h.settings.settings.siteDefaults, "login.example", (entry) =>
            entry === origin ? "login.example" : undefined,
          ),
        },
      ];
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
      try {
        const restarted = harness(
          {},
          { passkeys: withPasskey, generation: service, report: reports },
        );
        restarted.recipes.recipe.mockResolvedValue(plain);
        // Held while the watch lasts, so no second code is sent, not even a fill.
        expect(await signInPage(restarted, 2, "asking-tab")).toEqual({
          ok: false,
          reason: "origin-busy",
        });
        expect(executed().slice(steps)).toEqual([]);
        expect(status()).toMatchObject([{ state: "watching", document: { tabId: 1 } }]);
        // Once the watch is over, the tab asks as after the pick, filling nothing.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(await signInPage(restarted, 2, "asking-tab-later")).toEqual({
          ok: false,
          reason: "account-asked",
        });
        expect(executed().slice(steps)).toEqual([]);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("refuses an account switch in another tab while the watch lasts (ADR 0063)", async () => {
      const logout = {
        recipes: vi.fn(async () => []),
        generate: vi.fn<LogoutService["generate"]>(),
      };
      const { h } = await watched([], plain, undefined, { logout });
      fake.state.tabUrls[2] = `${origin}/home`;
      await h.hello({ tab: { id: 2 }, documentId: "home-tab", url: `${origin}/home` }, false);
      expect(
        await h.login.handle(
          {
            version: 1,
            type: "login.switch.start",
            tabId: 2,
            connectionId,
            itemId: otherItemId,
            makeDefault: false,
          },
          fromPopup,
        ),
      ).toEqual({ ok: false, reason: "site-held" });
      expect(fake.state.session["pateat.login-switch-picks.v1"] ?? []).toEqual([]);
      expect(logout.recipes).not.toHaveBeenCalled();
    });
    it("keeps holding the site against another tab's page left open from before", async () => {
      const { h } = await watched([], plain, async (harnessed) => {
        // Another tab already shows a page of the site, which later renders the form.
        fake.state.tabUrls[2] = `${origin}/home`;
        await harnessed.hello(
          { tab: { id: 2 }, documentId: "open-tab", url: `${origin}/home` },
          false,
        );
        fake.state.pageUrl = `${origin}/signin`;
      });
      await vi.advanceTimersByTimeAsync(1000);
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "open-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
      expect(status()).toMatchObject([{ state: "watching", document: { tabId: 1 } }]);
    });
    it("keeps holding the site against another tab's page that is not the first step", async () => {
      const { h } = await watched();
      fake.state.pageUrl = `${origin}/home`;
      fake.state.observedPath = "/home";
      fake.state.tabUrls[2] = fake.state.pageUrl;
      await h.hello({ tab: { id: 2 }, documentId: "other-tab" }, false);
      expect(status()).toMatchObject([{ state: "watching", document: { tabId: 1 } }]);
    });
    it("ends a login whose result settled as unknown the same way, as Sony Bank's", async () => {
      vi.useFakeTimers();
      reports.mockClear();
      fake.state.signs = quiet;
      onClick({ login: { path: "/approve", present: [], extracted: described("/approve") } });
      // A failed request leaves the page undecided without completing it (ADR 0029).
      const service = generation(async () => ({ verdict: "unclear", reason: "timeout" }));
      const h = harness({}, { passkeys: withPasskey, generation: service, report: reports });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 10_000);
      expect(status()).toMatchObject([{ settled: true, watch: { pages: 0 } }]);
      expect(await open(h, "/signin", ["password", "login"], 0)).toEqual({
        ok: true,
        starts: expect.any(Array),
      });
      const steps = executed().length;
      expect(await h.hello({ documentId: "document-signin" })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(5_000);
      // 2026-10-13: Sony Bank's sign-in page after a password submit settled as unknown was
      // taken as a logout, and every other tab of the site only filled after it. Only this
      // tab asks and fills.
      expect(reports).toHaveBeenCalledWith(abandoned("watch-abandoned"));
      expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill"]);
      expect(status() ?? []).toEqual([]);
      const before = executed().length;
      expect(await signInPage(h, 2, "other-tab")).toEqual({ ok: true });
      expect(
        executed()
          .slice(before)
          .map((step) => step.kind),
      ).toEqual(["fill", "click"]);
    });
    it("ends a watched login that leaves its origin where it stopped, so its form is no logout", async () => {
      const { h } = await watched();
      // The site's timeout goes through another origin, which shows no signed-in page.
      fake.state.tabUrls[1] = "https://elsewhere.example/home";
      expect(
        await h.hello({ documentId: "elsewhere", url: "https://elsewhere.example/home" }, false),
      ).toMatchObject({ ok: false });
      expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]);
      expect(status()![0]).not.toHaveProperty("watch");
      // Once the hold ends, the tab's own sign-in page asks and only fills.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const steps = executed().length;
      expect(await signInPage(h, 1, "back")).toEqual({ ok: true });
      expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill"]);
      // Another tab logs in as before.
      const before = executed().length;
      expect(await signInPage(h, 2, "other-tab")).toEqual({ ok: true });
      expect(
        executed()
          .slice(before)
          .map((step) => step.kind),
      ).toEqual(["fill", "click"]);
    });
    it("asks on a page the watch followed once its first step shows after the watch", async () => {
      const { h } = await watched(["unclear"]);
      await open(h, "/next");
      const steps = executed().length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // The same page now shows the sign-in form, as a site that renders it in place.
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      expect(await h.hello({ documentId: "document-next" })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill"]);
      expect(status() ?? []).toEqual([]);
    });
    it("ends the watch after 10 minutes where the login stopped", async () => {
      const { h, service } = await watched(["signed-in"]);
      const { changedAt } = status()![0]!;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await open(h, "/home");
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge", changedAt }]);
      expect(status()![0]).not.toHaveProperty("watch");
    });
    it("counts a watch that ran out only up to its end, however late a page notices", async () => {
      const { h } = await watched();
      const [record] = status() as {
        watch: { since: number };
        timing: { since: number; personSince: number };
      }[];
      expect(record!.timing.personSince).toBeGreaterThanOrEqual(record!.watch.since);
      // The person left the tab for an hour; the next page is the first to notice the end.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await open(h, "/home");
      const ended = reports.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.type === "attempt" && entry.state === "blocked");
      const end = record!.watch.since + 10 * 60_000;
      expect(ended).toMatchObject({
        outcome: "challenge",
        times: {
          totalMs: end - record!.timing.since,
          personMs: end - record!.timing.personSince,
        },
      });
    });
  });
  describe("personal details from linked vault items (ADR 0061)", () => {
    const identityId = "80000000-0000-4000-8000-000000000003";
    const cardId = "80000000-0000-4000-8000-000000000004";
    const birthField = `custom.${snapshotId}.0`;

    const extraItems = [
      {
        id: identityId,
        builtin: [{ id: "identity.phone", label: "Phone number", kind: "text" as const }],
        custom: [
          { name: "生年月日", kind: "text" as const },
          { name: "Phone", kind: "text" as const },
        ],
      },
      {
        id: cardId,
        builtin: [
          { id: "card.number", label: "Card number", kind: "hidden" as const },
          { id: "card.code", label: "Security code", kind: "hidden" as const },
        ],
        custom: [],
      },
    ];
    const detailHandler = {
      kind: "detail" as const,
      path: "/signin",
      fields: [
        { detail: "birth-date" as const, format: "yyyymm" as const, target: target("birth") },
        { detail: "phone-last-4" as const, target: target("phone") },
      ],
      target: target("confirm"),
    };
    const detailed = parseLoginRecipe({
      ...unlearned,
      completion: home,
      handlers: [detailHandler],
    });
    void parseLoginRecipe({ ...detailed, rejection: target("rejected") });
    const toConfirm = { path: "/signin", present: ["birth", "phone", "confirm"] };

    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const linkTo = (detail: DetailLink["detail"], source: DetailLink["source"]): DetailLink => ({
      origin,
      provider: "bitwarden",
      server: "cloud-us",
      userId,
      itemId,
      detail,
      source,
    });
    const birthLink = linkTo("birth-date", { itemId: identityId, field: { custom: "生年月日" } });
    const phoneLink = linkTo("phone-last-4", { itemId: identityId, field: "identity.phone" });
    const values = (h: ReturnType<typeof harness>, read: Record<string, string>) =>
      h.fields.mockImplementation(async ({ fieldId }) => read[fieldId] ?? "synthetic-secret");
    const birthValue = { [birthField]: "1990-04-01" };
    const detailFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "detail"),
      );
    const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome, value.steps]] : [],
      );
    const reads = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]);

    const { source: _source } = birthLink;
    function start(
      links: DetailLink[],
      read: Record<string, string> = birthValue,
      chosen = detailed,
      overrides: Partial<LocalSettings> = {},
      live: Parameters<typeof harness>[1] = {},
    ) {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        { detailLinks: links, ...overrides },
        { passkeys: noPasskey, report, extraItems, ...live },
      );
      values(h, read);
      h.recipes.recipe.mockResolvedValue(chosen);
      return { h, report };
    }
    describe("a saved link", () => {
      it("fills the linked birth date after its radio, and clicks the button once", async () => {
        onClick({ login: toConfirm, confirm: toHome });
        const { h, report } = start([birthLink]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "fill", "click"]);
        expect(clicks("confirm")).toBe(1);
        // The date is made in the worker; the page gets only what its input asks for, and
        // only into an input that takes a detail.
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [{ slot: "detail", value: "199004", secret: "detail" }],
        ]);
        expect(JSON.stringify(fake.state.messages)).not.toContain("1990-04-01");
        expect(detailFills()[0]).toMatchObject({
          choose: true,
          operation: {
            step: { kind: "fill", fields: [{ slot: "detail", target: target("birth") }] },
          },
        });
        // Only the detail's fill checks a radio first.
        expect(
          fake.state.messages.filter(
            (entry) => entry.type === "login.execute" && "choose" in entry,
          ),
        ).toHaveLength(1);
        // The value is read from the linked item, not the login item.
        expect(reads(h)).toEqual([
          [itemId, "login.password"],
          [identityId, birthField],
        ]);
        expect(status()![0]).toMatchObject({
          handlers: [{ index: 0, start: 2, field: 0 }],
          stepCount: 4,
          submissions: 2,
        });
        expect(handlerReports(report)).toEqual([[0, "detail", "entered", 2]]);
        // The link is the owner's already; nothing is written.
        expect(h.store.update).not.toHaveBeenCalled();
      }, 10_000);
      it("fills the first input whose detail is linked, the phone's last four digits", async () => {
        onClick({ login: toConfirm, confirm: toHome });
        const { h, report } = start([phoneLink], { "identity.phone": "+81 90-0000-1234" });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [{ slot: "detail", value: "1234", secret: "detail" }],
        ]);
        expect(detailFills()[0]).toMatchObject({
          operation: { step: { fields: [{ slot: "detail", target: target("phone") }] } },
        });
        expect(JSON.stringify(fake.state.messages)).not.toContain("0000-1234");
        expect(reads(h).at(-1)).toEqual([identityId, "identity.phone"]);
        expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 2, field: 1 }] });
        expect(handlerReports(report)).toEqual([[0, "detail", "entered", 2]]);
      }, 10_000);
      it("fills the next linked input while the first is not writable", async () => {
        onClick({ login: toConfirm, confirm: toHome });
        // The page disables the birth input until its radio is chosen.
        fake.state.unusable = new Set(["birth"]);
        const { h } = start([birthLink, phoneLink], {
          ...birthValue,
          "identity.phone": "09000001234",
        });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [{ slot: "detail", value: "1234", secret: "detail" }],
        ]);
        expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 2, field: 1 }] });
        expect(reads(h).map(([, fieldId]) => fieldId)).not.toContain(birthField);
      }, 10_000);
      it.each([
        ["card-code", "card.code", "0123", { value: "0123", secret: "card-code" }],
        ["card-last-4", "card.number", "4000 0000 0000 0002", { value: "0002", secret: "detail" }],
      ] as const)(
        "fills a %s from the linked card",
        async (detail, field, read, filled) => {
          const card = parseLoginRecipe({
            ...detailed,
            handlers: [{ ...detailHandler, fields: [{ detail, target: target("code") }] }],
          });
          onClick({ login: { path: "/signin", present: ["code", "confirm"] }, confirm: toHome });
          const { h } = start([linkTo(detail, { itemId: cardId, field })], { [field]: read }, card);
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
            timeout: 6_000,
          });
          // A card code fills only an input that takes a card code.
          expect(detailFills().map((entry) => entry.values)).toEqual([
            [{ slot: "detail", ...filled }],
          ]);
          expect(reads(h).at(-1)).toEqual([cardId, field]);
          expect(JSON.stringify(fake.state.messages)).not.toContain("4000 0000");
        },
        10_000,
      );
      it.each([
        ["no date", [birthLink], { [birthField]: "spring of 1990" }],
        ["a day that does not exist", [birthLink], { [birthField]: "1990-02-30" }],
        ["a phone of too few digits", [phoneLink], { "identity.phone": "123" }],
      ])(
        "stops as a changed policy when the linked value is %s",
        async (_label, links, read) => {
          onClick({ login: toConfirm, confirm: toHome });
          const { h, report } = start(links, read);
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
          );
          expect(detailFills()).toEqual([]);
          expect(clicks("confirm")).toBe(0);
          expect(handlerReports(report)).toEqual([
            [0, "detail", "entered", 2],
            [0, "detail", "detail-unreadable", 2],
          ]);
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({ type: "attempt", cause: "field-unavailable" }),
          );
        },
        10_000,
      );
      it.each([
        ["gives no value", async () => undefined],
        [
          "fails",
          async () => {
            throw new Error("synthetic vault failure");
          },
        ],
      ])(
        "stops as a changed policy when the vault %s for the linked field",
        async (_label, failing) => {
          onClick({ login: toConfirm, confirm: toHome });
          const { h, report } = start([birthLink]);
          h.fields.mockImplementation(async (request) =>
            request.fieldId === birthField ? failing() : "synthetic-secret",
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
          );
          expect(detailFills()).toEqual([]);
          expect(clicks("confirm")).toBe(0);
          expect(handlerReports(report)).toEqual([
            [0, "detail", "entered", 2],
            [0, "detail", "detail-unavailable", 2],
          ]);
        },
        10_000,
      );
    });
  });
});
