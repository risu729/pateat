import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../../crypto/wire";
import type { LoginGeneration } from "./recipes";
import type { LoginReport } from "./reports";
import type { ConditionalDecision, PasskeyItem } from "../../passkeys/runtime";
import {
  connectionId,
  harness,
  itemId,
  origin,
  otherItemId,
  recipe,
  target,
  uriMatch,
  userId,
} from "./__fixtures__/harness";

const { fake } = await vi.hoisted(() => import("./__fixtures__/browser"));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));

describe("the start page's own passkey request (ADR 0034)", () => {
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
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    // The base recipe has no passkey button: the page asks for a passkey by itself.
    fake.state.present = new Set(["password", "login"]);
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });

  const discoverable = () => vi.fn(async () => ({ passkey: true, discoverable: true }));
  const secondFactor = () => vi.fn(async () => ({ passkey: true, discoverable: false }));
  const status = () =>
    fake.state.storage["pateat.login-attempts.v4"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target.value === value).length;
  const fills = () => executed().filter((step) => step.kind === "fill").length;
  /** The page signs in once the password route's button is clicked. */
  const signsInOnClick = () => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "login")
        fake.state.present = new Set(["authenticated"]);
    };
  };
  function start(
    used: LoginRecipe = recipe,
    live: Parameters<typeof harness>[1] = {},
    overrides: Partial<LocalSettings> = {},
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(overrides, { passkeys: discoverable(), report, ...live });
    h.recipes.recipe.mockResolvedValue(used);
    return { h, report };
  }
  /** The passkey bridge passes the top document's conditional request to the login. */
  const ask = (
    h: ReturnType<typeof harness>,
    change: Partial<{ tabId: number; origin: string; documentId: string }> = {},
  ) => {
    const controller = new AbortController();
    let decided: ConditionalDecision | undefined;
    const decision = h.login
      .conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: controller.signal,
        ...change,
      })
      .then((value) => (decided = value));
    return { controller, decision, decided: () => decided };
  };
  /** Lets the request reach its waiting place. */
  const flush = async () => {
    for (let index = 0; index < 10; index++)
      // eslint-disable-next-line no-await-in-loop
      await (vi.isFakeTimers()
        ? vi.advanceTimersByTimeAsync(0)
        : new Promise((resolve) => setTimeout(resolve, 0)));
  };
  /** Advances fake time until the check holds. */
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
  const answerOf = (decision: ConditionalDecision | undefined) => {
    expect(decision).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
    return decision as Extract<ConditionalDecision, { kind: "answer" }>;
  };
  const routeChanges = (report: ReturnType<typeof start>["report"]) =>
    report.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === "attempt" && "routeChange" in entry)
      .map((entry) => (entry as { route: string; routeChange?: string }).routeChange);

  it("hands a request on at once on an origin without a recipe", async () => {
    const { h } = start();
    const request = ask(h, { origin: "https://elsewhere.example" });
    expect(await request.decision).toEqual({ kind: "delegate", reason: "no-recipe" });
    expect(executed()).toEqual([]);
  });

  it("hands a request on when no login of its document starts within three seconds", async () => {
    vi.useFakeTimers();
    const { h } = start();
    const request = ask(h);
    await flush();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(request.decided()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    // A login of another document of the tab does not decide it either.
    const other = ask(h, { documentId: "other-document" });
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => other.decided() !== undefined, 5_000);
    expect(other.decided()).toEqual({ kind: "delegate", reason: "no-login" });
  });

  it("forgets a request the page aborts while it waits", async () => {
    const { h } = start();
    const request = ask(h);
    await flush();
    request.controller.abort();
    await request.decision;
    // A login of the document then finds no request to answer and takes the password.
    signsInOnClick();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "password" }]),
    );
    expect(fills()).toBe(1);
    expect(clicks("login")).toBe(1);
  });

  it("answers a waiting request with the login's item on the passkey route, filling nothing", async () => {
    const { h, report } = start();
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    const answer = answerOf(await request.decision);
    // The answer is the route's submission, recorded before it goes out.
    expect(status()![0]).toMatchObject({
      route: "passkey",
      variant: 0,
      state: "submit-intent",
      stepCount: 1,
      submissions: 1,
    });
    fake.state.present = new Set(["authenticated"]);
    answer.answered(true);
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "passkey" }]),
    );
    expect(executed()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ type: "start", route: "passkey", variant: 0 }),
    );
    expect(routeChanges(report)).toEqual([]);
  });

  it("switches a password login to the passkey route before it submits, keeping its fill", async () => {
    const { h, report } = start();
    let request: ReturnType<typeof ask> | undefined;
    // The page asks for a passkey while its form is being filled.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "fill" || request) return;
      request = ask(h);
      await flush();
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(request).toBeDefined());
    const answer = answerOf(await request!.decision);
    expect(status()![0]).toMatchObject({
      route: "passkey",
      variant: 0,
      state: "submit-intent",
      submissions: 1,
    });
    fake.state.present = new Set(["authenticated"]);
    answer.answered(true);
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "passkey" }]),
    );
    expect(fills()).toBe(1);
    expect(clicks("login")).toBe(0);
    expect(routeChanges(report)).toEqual(["page-request"]);
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ type: "attempt", route: "passkey", routeChange: "page-request" }),
    );
  });

  it("falls back to the password when the request went away before the answer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    // The page cancels its request while the login starts.
    const passkeys = vi.fn(async () => {
      controller.abort();
      return { passkey: true, discoverable: true };
    });
    const { h, report } = start(recipe, { passkeys });
    void h.login.conditionalRequest({
      tabId: 1,
      origin,
      documentId: "synthetic-document",
      signal: controller.signal,
    });
    await flush();
    signsInOnClick();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"), 20_000);
    expect(status()![0]).toMatchObject({ route: "password", variant: 0, submissions: 1 });
    expect(fills()).toBe(1);
    expect(clicks("login")).toBe(1);
    expect(routeChanges(report)).toEqual(["request-missing"]);
  });

  it("falls back to the recorded variant when the item cannot answer, and never answers twice", async () => {
    const { h, report } = start();
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    const answer = answerOf(await request.decision);
    signsInOnClick();
    answer.answered(false);
    // The passkey bridge passes the request to the login again, as it does after a failure.
    const again = ask(h);
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({
      route: "password",
      variant: 0,
      // The answer counted, and the password route kept its own budget.
      submissions: 2,
      maxSubmissions: 2,
    });
    expect(fills()).toBe(1);
    expect(clicks("login")).toBe(1);
    // The login signed in, so the page keeps waiting.
    expect(await again.decision).toEqual({ kind: "withhold" });
    expect(routeChanges(report)).toEqual(["answer-failed"]);
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ type: "attempt", route: "passkey", cause: "answer-failed" }),
    );
  });

  it("falls back to the password when the sign-in form still shows fifteen seconds after the answer", async () => {
    vi.useFakeTimers();
    const { h, report } = start();
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => request.decided() !== undefined, 5_000);
    const answer = answerOf(request.decided());
    answer.answered(true);
    // The site may still be exchanging the assertion while its form shows.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(status()![0]).toMatchObject({ state: "awaiting-result", route: "passkey" });
    expect(executed()).toEqual([]);
    signsInOnClick();
    await until(settled("authenticated"), 20_000);
    expect(status()![0]).toMatchObject({ route: "password", variant: 0, submissions: 2 });
    expect(fills()).toBe(1);
    expect(clicks("login")).toBe(1);
    expect(routeChanges(report)).toEqual(["sign-in-shown"]);
  });

  it("ends as a challenge without a password variant to fall back to", async () => {
    vi.useFakeTimers();
    // The item has no password, so no variant fits.
    const { h, report } = start(recipe, {}, { bindings: [] });
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields =
          response.catalog.connections[0]!.items[0]!.fields.map((field) =>
            field.id === "login.password" ? { ...field, empty: true as const } : field,
          );
      return response;
    });
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => request.decided() !== undefined, 5_000);
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(status()![0]).not.toHaveProperty("variant");
    answerOf(request.decided()).answered(false);
    await until(settled("blocked", "challenge"), 5_000);
    expect(executed()).toEqual([]);
    expect(routeChanges(report)).toEqual([]);
  });

  it("judges the page after the answer on the password route", async () => {
    vi.useFakeTimers();
    const { completion: _unlearned, ...unlearned } = recipe;
    const homePage = {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/home",
        language: "en",
        complete: true,
        candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
      },
    };
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return { verdict: "signed-in" };
      }),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    const used = parseLoginRecipe(unlearned);
    const { h } = start(used, { generation: service });
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => request.decided() !== undefined, 5_000);
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["logout"]);
    fake.state.extracted = { "signed-in": homePage };
    answerOf(request.decided()).answered(true);
    await until(settled("authenticated"), 20_000);
    expect(status()![0]).toMatchObject({ route: "passkey" });
    // The service knows no passkey route on a recipe without its button.
    expect(service.judge).toHaveBeenCalledWith(
      used.id,
      used.revision,
      "password",
      homePage.observation,
      expect.any(Function),
    );
    expect(executed()).toEqual([]);
  });

  describe("while the site may still be on the start page's path after the answer", () => {
    const homePage = {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/home",
        language: "en",
        complete: true,
        candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
      },
    };
    const onStart = { ...homePage, observation: { ...homePage.observation, path: "/signin" } };
    /** A recipe without a signed-in marker, so only the judge can settle the page. */
    function judged(verdict: "signed-in" | "unclear", change: Partial<LoginRecipe> = {}) {
      const { completion: _unlearned, ...unlearned } = { ...recipe, ...change };
      const service = {
        available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
        generate: vi.fn<LoginGeneration["generate"]>(async () => ({
          outcome: "skipped",
          reason: "sent",
        })),
        judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
          args[4]?.();
          return { verdict };
        }),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      };
      const used = parseLoginRecipe(unlearned);
      return { service, ...start(used, { generation: service }) };
    }

    it("judges only the page the site moves to a few seconds after the answer", async () => {
      vi.useFakeTimers();
      const { h, service } = judged("signed-in");
      const request = ask(h);
      await flush();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      // The form goes while the site exchanges the assertion on the start page's path.
      fake.state.present = new Set();
      answerOf(request.decided()).answered(true);
      setTimeout(() => {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.extracted = { "signed-in": homePage };
      }, 6_000);
      await vi.advanceTimersByTimeAsync(5_500);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", route: "passkey" });
      expect(service.judge).not.toHaveBeenCalled();
      // The page on another path is judged at once, well before the hold ends.
      await until(settled("authenticated"), 8_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(service.judge.mock.calls[0]![3]).toEqual(homePage.observation);
      expect(executed()).toEqual([]);
    });

    it("judges a page that stays on the start page's path once fifteen seconds passed", async () => {
      vi.useFakeTimers();
      const { h, service } = judged("unclear");
      const request = ask(h);
      await flush();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      // The form goes, and the page shows something to describe.
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": onStart };
      answerOf(request.decided()).answered(true);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", route: "passkey" });
      expect(service.judge).not.toHaveBeenCalled();
      // Anything the passkey route does not prove ends as a challenge.
      await until(settled("blocked", "challenge"), 10_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(executed()).toEqual([]);
    });

    it("waits while the start page's path shows nothing to describe, as a loader does", async () => {
      vi.useFakeTimers();
      const { h, service } = judged("signed-in");
      const request = ask(h);
      await flush();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      fake.state.present = new Set();
      answerOf(request.decided()).answered(true);
      // The site moves on a minute and a half after the answer.
      setTimeout(() => {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.extracted = { "signed-in": homePage };
      }, 90_000);
      await vi.advanceTimersByTimeAsync(85_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", route: "passkey" });
      expect(service.judge).not.toHaveBeenCalled();
      await until(settled("authenticated"), 20_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(executed()).toEqual([]);
    });

    it("ends as a challenge when the start page's path shows nothing for two minutes", async () => {
      vi.useFakeTimers();
      const { h, service } = judged("signed-in");
      const request = ask(h);
      await flush();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      fake.state.present = new Set();
      answerOf(request.decided()).answered(true);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", route: "passkey" });
      await until(settled("blocked", "challenge"), 10_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(executed()).toEqual([]);
    });

    it("judges a page on the start path at once after falling back to the password", async () => {
      vi.useFakeTimers();
      const { h, service } = judged("signed-in", { rejection: target("rejected") });
      const request = ask(h);
      await flush();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      // The site refuses the passkey, and its form goes once the password is submitted.
      fake.state.present = new Set(["password", "login", "rejected"]);
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "click" && step.target.value === "login") {
          fake.state.present = new Set(["logout"]);
          fake.state.extracted = { "signed-in": onStart };
        }
      };
      answerOf(request.decided()).answered(true);
      await until(settled("authenticated"), 10_000);
      expect(status()![0]).toMatchObject({ route: "password" });
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(clicks("login")).toBe(1);
    });
  });
  it("withholds a request that waited for a password login that signed in", async () => {
    // The item's passkey is a second factor only, so the login takes the password route.
    const { h, report } = start(recipe, { passkeys: secondFactor() });
    const request = ask(h);
    await flush();
    signsInOnClick();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "password" }]),
    );
    expect(await request.decision).toEqual({ kind: "withhold" });
    expect(fills()).toBe(1);
    expect(routeChanges(report)).toEqual([]);
  });

  it("hands a request on once the login it waited for ended without signing in", async () => {
    const { h } = start(parseLoginRecipe({ ...recipe, rejection: target("rejected") }), {
      passkeys: secondFactor(),
    });
    const request = ask(h);
    await flush();
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click") fake.state.present = new Set(["password", "login", "rejected"]);
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "blocked" }]));
    expect(await request.decision).toEqual({ kind: "delegate", reason: "login-ended" });
  });

  describe("while the tab asks for an account after a logout (ADR 0021 D)", () => {
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    const matching = { allowedOrigins: [], uris: async () => ({ ok: true as const, data: both }) };
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const choice = (h: ReturnType<typeof harness>, tabId = 1) =>
      h.login.handle({ version: 1, type: "login.choice.get", tabId }, popup);
    /** The person picks an account in the popup for the asked document. */
    const pick = (
      h: ReturnType<typeof harness>,
      overrides: Partial<{ tabId: number; documentId: string; itemId: string }> = {},
    ) =>
      h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "signed-out",
          connectionId,
          itemId: otherItemId,
          makeDefault: false,
          ...overrides,
        },
        popup,
      );
    /** A login with the saved default signs in; the form then shows in a new document. */
    const signedIn = async (live: Parameters<typeof harness>[1] = {}) => {
      const started = start(recipe, { ...matching, ...live });
      signsInOnClick();
      expect(await started.h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      fake.state.present = new Set(["password", "login"]);
      return started;
    };
    /**
     * Without a saved default, a picked account signs in; the form then shows in a new
     * document, which only asks: the popup offers both accounts.
     */
    const loggedOut = async (live: Parameters<typeof harness>[1] = {}) => {
      const started = start(recipe, { ...matching, ...live }, { siteDefaults: [], bindings: [] });
      const { h } = started;
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      fake.state.onReconnect = () => h.hello();
      signsInOnClick();
      expect(await pick(h, { documentId: "synthetic-document", itemId })).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      fake.state.present = new Set(["password", "login"]);
      fake.state.onExecute = undefined;
      expect(await h.hello({ documentId: "signed-out" })).toEqual({
        ok: false,
        reason: "logged-out",
      });
      expect(await choice(h)).toMatchObject({ documentId: "signed-out", logout: "this-tab" });
      fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
      return started;
    };

    it("keeps a request waiting during a login that only fills after a logout, and after it", async () => {
      vi.useFakeTimers();
      // The item holds a discoverable passkey, yet the login after the logout only fills.
      const { h, report } = await signedIn();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      fake.state.onExecute = () => held;
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => fills() === 2, 5_000);
      expect(status()![0]).toMatchObject({ fillOnly: true, route: "password" });
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      // The fill ends and the tab asks; the request still waits for the pick.
      release();
      await until(() => fake.state.badges[1]?.text === "2", 5_000);
      expect(await h.login.active()).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      expect(fills()).toBe(2);
      expect(clicks("login")).toBe(1);
      expect(routeChanges(report)).toEqual([]);
    });

    it("does not answer a login that only fills after a logout when the request came first", async () => {
      vi.useFakeTimers();
      const { h, report } = await signedIn();
      // The signed-out page asks for a passkey before its form is ready.
      fake.state.onExecute = () => new Promise(() => undefined);
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => fills() === 2, 5_000);
      expect(status()![0]).toMatchObject({ fillOnly: true, route: "password" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      expect(status()![0]).toMatchObject({ fillOnly: true, route: "password" });
      expect(clicks("login")).toBe(1);
      expect(routeChanges(report)).toEqual([]);
    });

    it("answers a waiting request with the account picked in the popup, on the passkey route", async () => {
      vi.useFakeTimers();
      const { h, report } = await loggedOut();
      expect(await choice(h)).toMatchObject({
        candidates: [
          { connectionId, itemId },
          { connectionId, itemId: otherItemId },
        ],
      });
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      // The tab asks, so the request is not handed on after three seconds.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      const filled = fills();
      expect(await pick(h)).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId: otherItemId },
      });
      expect(status()![0]).toMatchObject({
        route: "passkey",
        state: "submit-intent",
        submissions: 1,
        account: { connectionId, itemId: otherItemId },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "passkey",
        account: { connectionId, itemId: otherItemId },
      });
      expect(fills()).toBe(filled);
      expect(clicks("login")).toBe(1);
      expect(
        report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "start"),
      ).toEqual([
        expect.objectContaining({ route: "password", account: "pick" }),
        expect.objectContaining({ route: "passkey", account: "pick" }),
      ]);
      expect(routeChanges(report)).toEqual([]);
    });

    it("answers a request kept through a login that only filled with the account picked next", async () => {
      vi.useFakeTimers();
      const { h, report } = await signedIn();
      fake.state.onExecute = undefined;
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => fake.state.badges[1]?.text === "2", 5_000);
      expect(fills()).toBe(2);
      expect(await h.login.active()).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
      expect(await pick(h)).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId: otherItemId },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "passkey",
        account: { connectionId, itemId: otherItemId },
      });
      // Nothing was pressed after the logout, and the pick filled nothing.
      expect(fills()).toBe(2);
      expect(clicks("login")).toBe(1);
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "start", route: "passkey", account: "pick" }),
      );
      expect(routeChanges(report)).toEqual([]);
    });

    it("hands on a request of another document of the tab that was not asked", async () => {
      vi.useFakeTimers();
      const { h } = await loggedOut();
      const request = ask(h, { documentId: "other-page" });
      await flush();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(request.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    });

    it("logs a picked account without a discoverable passkey in with the password, then withholds", async () => {
      vi.useFakeTimers();
      const passkeys = vi.fn(async (account: unknown) =>
        (account as { itemId: string }).itemId === otherItemId
          ? { passkey: false, discoverable: false }
          : { passkey: true, discoverable: true },
      );
      const { h, report } = await loggedOut({ passkeys });
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      signsInOnClick();
      expect(await pick(h)).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "password",
        account: { connectionId, itemId: otherItemId },
      });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toEqual({ kind: "withhold" });
      expect(fills()).toBe(2);
      expect(clicks("login")).toBe(2);
      expect(routeChanges(report)).toEqual([]);
    });

    it("keeps a request of a tab asked for another tab's logout after that tab's pick logs in", async () => {
      vi.useFakeTimers();
      const { h, report } = await loggedOut();
      const recordOf = (tabId: number) =>
        status()?.find(
          (entry) => (entry["document"] as { tabId: number } | undefined)?.tabId === tabId,
        );
      // Another tab shows the form and asks only because of this tab's logout.
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "logged-out",
      });
      expect(await choice(h, 2)).toMatchObject({ documentId: "other-tab", logout: "other-tab" });
      const request = ask(h, { tabId: 2, documentId: "other-tab" });
      await flush();
      // The first tab's pick logs in there and ends its logout.
      signsInOnClick();
      expect(await pick(h, { itemId })).toEqual({ ok: true });
      await until(() => recordOf(1)?.["state"] === "authenticated", 20_000);
      expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
      // The second tab's choice is still offered, so its request still waits.
      expect(await choice(h, 2)).toMatchObject({ documentId: "other-tab", logout: "other-tab" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      fake.state.present = new Set(["password", "login"]);
      const filled = fills();
      const clicked = clicks("login");
      fake.state.onReconnect = () => h.hello({ tab: { id: 2 }, documentId: "other-tab" });
      expect(await pick(h, { tabId: 2, documentId: "other-tab" })).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId: otherItemId },
      });
      expect(recordOf(2)).toMatchObject({
        route: "passkey",
        state: "submit-intent",
        account: { connectionId, itemId: otherItemId },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(() => recordOf(2)?.["state"] === "authenticated", 20_000);
      expect(recordOf(2)).toMatchObject({ route: "passkey" });
      expect(fills()).toBe(filled);
      expect(clicks("login")).toBe(clicked);
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "start", tabId: 2, route: "passkey", account: "pick" }),
      );
    });

    it("hands a waiting request on soon after a pick that starts no login", async () => {
      vi.useFakeTimers();
      const { h } = await loggedOut();
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      // The picked item is quarantined meanwhile, so its login is refused.
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok) response.catalog.connections[0]!.quarantinedItemIds = [otherItemId];
        return response;
      });
      const sent = executed().length;
      expect(await pick(h)).toMatchObject({ ok: false });
      expect(await choice(h)).toMatchObject({ ok: false });
      await until(() => request.decided() !== undefined, 4_500);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
      expect(executed()).toHaveLength(sent);
    });

    it("hands a waiting request on soon after a pick whose page does not announce again", async () => {
      vi.useFakeTimers();
      const { h } = await loggedOut();
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      await until(() => request.decided() !== undefined, 4_500);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    });

    it("keeps a request whose choice is offered again soon after a pick that started no login", async () => {
      vi.useFakeTimers();
      const { h, report } = await loggedOut();
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      // The pick's reconnect gets no announcement, so it starts nothing.
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      // The document announces again a moment later and is asked again.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await h.hello({ documentId: "signed-out" })).toEqual({
        ok: false,
        reason: "logged-out",
      });
      expect(await choice(h)).toMatchObject({ documentId: "signed-out", logout: "this-tab" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      const filled = fills();
      fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
      expect(await pick(h)).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId: otherItemId },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "passkey",
        account: { connectionId, itemId: otherItemId },
      });
      expect(fills()).toBe(filled);
      expect(routeChanges(report)).toEqual([]);
    });

    it("hands on a request of a document asked without a logout, even while its pick is pending", async () => {
      vi.useFakeTimers();
      const { h } = start(recipe, matching, { siteDefaults: [], bindings: [] });
      // Several accounts match and none is the default: the popup asks, with no logout.
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(await choice(h)).toMatchObject({ ok: true, documentId: "synthetic-document" });
      expect(await choice(h)).not.toHaveProperty("logout");
      const request = ask(h);
      await flush();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(request.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
      expect(await choice(h)).toMatchObject({ ok: true, documentId: "synthetic-document" });
      // A second request is picked for meanwhile; the page announces again only later.
      const again = ask(h);
      await flush();
      fake.state.onReconnect = () =>
        new Promise((resolve) => setTimeout(() => resolve(h.hello()), 5_000));
      signsInOnClick();
      const picking = pick(h, { documentId: "synthetic-document" });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(again.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(again.decided()).toEqual({ kind: "delegate", reason: "no-login" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await picking).toEqual({ ok: true });
      // The pick's login, finding no request, takes the password.
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "password",
        account: { connectionId, itemId: otherItemId },
      });
    });

    it("keeps a request of a document asked after the tab's stopped login, and answers it with the pick", async () => {
      vi.useFakeTimers();
      const first = start(recipe, matching);
      // The login stops after its click, as when the page leaves while submitting.
      fake.state.onExecute = (message) =>
        (message["operation"] as { step: LoginStep }).step.kind === "click"
          ? new Promise(() => undefined)
          : Promise.resolve();
      expect(await first.h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "submit-intent", 5_000);
      const [record] = status()!;
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        fake.state.storage["pateat.login-attempts.v4"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "policy-changed",
            mutationIntent: undefined,
            operationId: undefined,
            operationKind: undefined,
            operationEffect: undefined,
          },
        ];
        fake.state.onExecute = undefined;
        // A restarted worker sees the form show again in a later page of the tab.
        const { h, report } = start(recipe, matching);
        const request = ask(h, { documentId: "next-page" });
        await flush();
        expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await until(() => fake.state.badges[1]?.text === "2", 5_000);
        expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(request.decided()).toBeUndefined();
        const filled = fills();
        fake.state.onReconnect = () => h.hello({ documentId: "next-page" });
        expect(await pick(h, { documentId: "next-page" })).toEqual({ ok: true });
        await until(() => request.decided() !== undefined, 5_000);
        expect(request.decided()).toMatchObject({
          kind: "answer",
          item: { connectionId, itemId: otherItemId },
        });
        fake.state.present = new Set(["authenticated"]);
        (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
        await until(settled("authenticated"), 20_000);
        expect(status()![0]).toMatchObject({
          route: "passkey",
          account: { connectionId, itemId: otherItemId },
        });
        expect(fills()).toBe(filled);
        expect(clicks("login")).toBe(1);
        expect(routeChanges(report)).toEqual([]);
      } finally {
        fake.browser.tabs.query = query;
      }
    });

    it("still withholds after four minutes with an item lookup given, and never looks items up", async () => {
      vi.useFakeTimers();
      const passkeyItems = vi.fn(async () => [{ connectionId, itemId: otherItemId }]);
      const { h } = await loggedOut({ passkeyItems });
      const sent = executed().length;
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(235_000);
      expect(request.decided()).toBeUndefined();
      await until(() => request.decided() !== undefined, 10_000);
      expect(request.decided()).toEqual({ kind: "withhold" });
      expect(executed()).toHaveLength(sent);
      expect(passkeyItems).not.toHaveBeenCalled();
    });
  });

  describe("while the tab offers a popup choice outside a logout (ADR 0034 rule 5)", () => {
    const thirdItemId = "80000000-0000-4000-8000-000000000003";
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const choice = (h: ReturnType<typeof harness>, tabId = 1) =>
      h.login.handle({ version: 1, type: "login.choice.get", tabId }, popup);
    /** The person picks an account in the popup for the page's document. */
    const pick = (
      h: ReturnType<typeof harness>,
      overrides: Partial<{ documentId: string; itemId: string; makeDefault: boolean }> = {},
    ) =>
      h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "synthetic-document",
          connectionId,
          itemId,
          makeDefault: false,
          ...overrides,
        },
        popup,
      );
    /** Only `itemId` holds a discoverable passkey among the offered items. */
    const holding = () =>
      vi.fn<(origin: string) => Promise<readonly PasskeyItem[]>>(async () => [
        { connectionId, itemId },
      ]);
    /** A lookup that answers when the test says so. */
    function deferred() {
      let answer!: (items: readonly PasskeyItem[]) => void;
      const lookup = vi.fn<(origin: string) => Promise<readonly PasskeyItem[]>>(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      return { lookup, answer: (items: readonly PasskeyItem[]) => answer(items) };
    }
    /**
     * Several accounts match the page and none is the site default, so the popup asks
     * without a logout; the offered accounts are `itemId` and `otherItemId`.
     */
    function choosing(
      live: Parameters<typeof harness>[1] = {},
      used: LoginRecipe = recipe,
      data: () => UriCandidates = () => both,
    ) {
      return start(
        used,
        { allowedOrigins: [], uris: async () => ({ ok: true as const, data: data() }), ...live },
        { siteDefaults: [], bindings: [] },
      );
    }
    async function offered(h: ReturnType<typeof harness>, documentId = "synthetic-document") {
      expect(await h.hello({ documentId })).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(await choice(h)).toMatchObject({ ok: true, documentId });
      expect(await choice(h)).not.toHaveProperty("logout");
    }
    /** The picked account's login answers the request on the passkey route and signs in. */
    async function answeredWithPick(
      h: ReturnType<typeof harness>,
      request: ReturnType<typeof ask>,
      report: ReturnType<typeof start>["report"],
    ) {
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h)).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId },
      });
      expect(status()![0]).toMatchObject({
        route: "passkey",
        state: "submit-intent",
        submissions: 1,
        account: { connectionId, itemId },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({ route: "passkey", account: { connectionId, itemId } });
      expect(executed()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(
        report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "start"),
      ).toEqual([expect.objectContaining({ route: "passkey", account: "pick" })]);
      expect(routeChanges(report)).toEqual([]);
    }
    /** Whether a request waits past the three seconds without a login, then is still open. */
    async function stillWaits(request: ReturnType<typeof ask>, ms = 10_000) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(request.decided()).toBeUndefined();
    }
    /** The request is handed on three to four seconds from now, as without a login. */
    async function handedOnSoon(request: ReturnType<typeof ask>) {
      await vi.advanceTimersByTimeAsync(2_500);
      expect(request.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_600);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    }

    it("keeps a request that comes after the choice, and answers it with a picked item's passkey", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      // Nothing is looked up before a request of the document waits.
      expect(passkeyItems).not.toHaveBeenCalled();
      const request = ask(h);
      await flush();
      expect(passkeyItems.mock.calls).toEqual([[origin]]);
      await stillWaits(request);
      await answeredWithPick(h, request, report);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
    });

    it("keeps a request that came first once the choice is offered within three seconds", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      const request = ask(h);
      await flush();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(request.decided()).toBeUndefined();
      await offered(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await stillWaits(request);
      await answeredWithPick(h, request, report);
    });

    it.each<[string, readonly PasskeyItem[]]>([
      ["no item", []],
      [
        "only items not offered",
        [
          { connectionId, itemId: thirdItemId },
          { connectionId: "another-connection", itemId },
        ],
      ],
    ])("hands a request on after three seconds when %s holds a passkey", async (_label, held) => {
      vi.useFakeTimers();
      const passkeyItems = vi.fn(async () => held);
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });

    it("hands a request on after three seconds when the lookup fails", async () => {
      vi.useFakeTimers();
      const passkeyItems = vi.fn(async (): Promise<readonly PasskeyItem[]> => {
        throw new Error("synthetic lookup failure");
      });
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await handedOnSoon(request);
    });

    it("keeps a request while the lookup runs past three seconds, and hands it on once it finds none", async () => {
      vi.useFakeTimers();
      const { lookup, answer } = deferred();
      const { h } = choosing({ passkeyItems: lookup });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      expect(lookup).toHaveBeenCalledTimes(1);
      answer([]);
      // Handed on at once: the three seconds have long passed.
      await flush();
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    });

    it("keeps a request whose slow lookup finds an offered item with a passkey", async () => {
      vi.useFakeTimers();
      const { lookup, answer } = deferred();
      const { h, report } = choosing({ passkeyItems: lookup });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      answer([{ connectionId, itemId }]);
      await flush();
      await stillWaits(request);
      await answeredWithPick(h, request, report);
    });

    it("logs a picked item without a passkey in with the password, then withholds", async () => {
      vi.useFakeTimers();
      const passkeys = vi.fn(async (account: unknown) =>
        (account as { itemId: string }).itemId === otherItemId
          ? { passkey: false, discoverable: false }
          : { passkey: true, discoverable: true },
      );
      const { h, report } = choosing({ passkeyItems: holding(), passkeys });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      signsInOnClick();
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, { itemId: otherItemId })).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "password",
        account: { connectionId, itemId: otherItemId },
      });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toEqual({ kind: "withhold" });
      expect(fills()).toBe(1);
      expect(clicks("login")).toBe(1);
      expect(routeChanges(report)).toEqual([]);
    });

    it("hands a request on once a picked item's password login ended without signing in", async () => {
      vi.useFakeTimers();
      const passkeys = vi.fn(async () => ({ passkey: false, discoverable: false }));
      const { h } = choosing(
        { passkeyItems: holding(), passkeys },
        parseLoginRecipe({ ...recipe, rejection: target("rejected") }),
      );
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "click") fake.state.present = new Set(["password", "login", "rejected"]);
      };
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, { itemId: otherItemId })).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "blocked", 20_000);
      expect(status()![0]).toMatchObject({ route: "password" });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "login-ended" });
    });

    it("hands a request on four minutes after it came without a pick, instead of withholding it", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await vi.advanceTimersByTimeAsync(239_000);
      expect(request.decided()).toBeUndefined();
      await until(() => request.decided() !== undefined, 10_000);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-pick" });
      expect(executed()).toEqual([]);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      // A pick afterwards signs in with the password.
      signsInOnClick();
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h)).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({ route: "password", account: { connectionId, itemId } });
    });

    it("hands a request on three seconds after a new top document replaces the choice", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      // The tab navigated: the new page is offered a choice of its own.
      await offered(h, "next-page");
      await handedOnSoon(request);
      // Without a request of the new page, its choice is not looked up.
      expect(passkeyItems).toHaveBeenCalledTimes(1);
    });

    it.each(["saved", "synced"] as const)(
      "hands a request on three seconds after a site default is %s for the origin",
      async (source) => {
        vi.useFakeTimers();
        const { h } = choosing({ passkeyItems: holding() });
        await offered(h);
        const request = ask(h);
        await flush();
        await stillWaits(request);
        // A change of settings that saves no default for the origin keeps the request.
        h.login.settingsChanged(source);
        await flush();
        await stillWaits(request, 5_000);
        h.settings.settings.siteDefaults.push({ origin, provider: "bitwarden", userId, itemId });
        h.login.settingsChanged(source);
        await flush();
        await handedOnSoon(request);
        expect(executed()).toEqual([]);
      },
    );

    it("hands a request on three seconds after the passkey chooser saves a site default", async () => {
      vi.useFakeTimers();
      const { h } = choosing({ passkeyItems: holding() });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      // Nothing saved yet: the request keeps waiting.
      h.login.siteDefaultSaved();
      await flush();
      await stillWaits(request, 5_000);
      h.settings.settings.siteDefaults.push({ origin, provider: "bitwarden", userId, itemId });
      h.login.siteDefaultSaved();
      await flush();
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });

    it("hands a request on three seconds after another tab's pick saves a site default", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      // Another tab of the site is offered the same accounts, and its page asks for a passkey.
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "account-ambiguous",
      });
      expect(await choice(h, 2)).toMatchObject({ ok: true, documentId: "other-tab" });
      const request = ask(h, { tabId: 2, documentId: "other-tab" });
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await stillWaits(request);
      // The first tab's pick signs in with the password and saves its account as the default.
      signsInOnClick();
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, { makeDefault: true })).toEqual({ ok: true });
      await until(() => h.settings.settings.siteDefaults.some((entry) => entry.origin === origin));
      expect(request.decided()).toBeUndefined();
      await handedOnSoon(request);
    });

    it("hands a request on after three seconds when a site default was saved before its check", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      // Saved without the runtime being told, as when the save raced the refusal.
      h.settings.settings.siteDefaults.push({ origin, provider: "bitwarden", userId, itemId });
      const request = ask(h);
      await flush();
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });

    it("checks the same choice again once a check found no passkey", async () => {
      vi.useFakeTimers();
      // The first check finds none, as with a locked vault; the next one finds the item.
      const passkeyItems = vi.fn(async (): Promise<readonly PasskeyItem[]> => []);
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      const first = ask(h);
      await flush();
      await handedOnSoon(first);
      passkeyItems.mockResolvedValue([{ connectionId, itemId }]);
      const request = ask(h);
      await flush();
      // A new request alone does not check the same choice again.
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await offered(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(2);
      await stillWaits(request);
      await answeredWithPick(h, request, report);
    });

    it("hands a request on three seconds after a frame's choice replaces the page's", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.tabUrls[1] = fake.state.pageUrl;
      expect(
        await h.hello({
          frameId: 3,
          documentId: "frame-document",
          tab: { id: 1, url: fake.state.pageUrl },
        }),
      ).toEqual({
        ok: false,
        reason: "account-ambiguous",
      });
      expect(await choice(h)).toMatchObject({ ok: true, documentId: "frame-document" });
      await handedOnSoon(request);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
    });

    it("keeps a request whose page's choice is offered again within three seconds of a frame's", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.tabUrls[1] = fake.state.pageUrl;
      expect(
        await h.hello({
          frameId: 3,
          documentId: "frame-document",
          tab: { id: 1, url: fake.state.pageUrl },
        }),
      ).toEqual({
        ok: false,
        reason: "account-ambiguous",
      });
      await vi.advanceTimersByTimeAsync(1_500);
      await offered(h);
      await flush();
      await stillWaits(request);
      // The frame's choice dropped the page's check, so it is looked up again.
      expect(passkeyItems).toHaveBeenCalledTimes(2);
      await answeredWithPick(h, request, report);
    });

    describe("after a worker restart", () => {
      /** The first worker offered the choice; a restarted worker only has it from storage. */
      async function restarted(passkeyItems: ReturnType<typeof holding>) {
        const first = choosing({ passkeyItems });
        await offered(first.h);
        const again = choosing({ passkeyItems });
        const request = ask(again.h);
        await flush();
        return { ...again, request };
      }

      it("keeps a request once the popup brings the choice back", async () => {
        vi.useFakeTimers();
        const passkeyItems = holding();
        const { h, report, request } = await restarted(passkeyItems);
        expect(passkeyItems).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        fake.state.onReconnect = () => h.hello();
        expect(await choice(h)).toMatchObject({ ok: true, documentId: "synthetic-document" });
        await flush();
        expect(passkeyItems).toHaveBeenCalledTimes(1);
        await stillWaits(request);
        await answeredWithPick(h, request, report);
      });

      it("hands a request on after three seconds when the choice cannot be brought back", async () => {
        vi.useFakeTimers();
        const passkeyItems = holding();
        const { h, request } = await restarted(passkeyItems);
        await vi.advanceTimersByTimeAsync(1_000);
        fake.state.onReconnect = async () => ({ ok: false });
        expect(await choice(h)).toMatchObject({ ok: false, reason: "no-choice" });
        await until(() => request.decided() !== undefined, 3_000);
        expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
        expect(passkeyItems).not.toHaveBeenCalled();
      });
    });

    it("hands a request on soon after a pick that starts no login", async () => {
      vi.useFakeTimers();
      const { h } = choosing({ passkeyItems: holding() });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });

    it("keeps a request whose choice is offered again soon after a pick that started no login", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      await vi.advanceTimersByTimeAsync(1_000);
      await offered(h);
      await flush();
      await stillWaits(request);
      // The same choice offered again keeps its check.
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await answeredWithPick(h, request, report);
    });

    it("hands a request on after three seconds on a recipe with a passkey button", async () => {
      vi.useFakeTimers();
      const { completion: _unlearned, ...unlearned } = recipe;
      const routed = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-passkey-route",
        passkey: { path: "/signin", target: { by: "text", value: "Sign in with a passkey" } },
      });
      fake.state.present = new Set(["password", "login", "Sign in with a passkey"]);
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems }, routed);
      await offered(h);
      const request = ask(h);
      await flush();
      await handedOnSoon(request);
      expect(passkeyItems).not.toHaveBeenCalled();
    });

    it("hands on a request of another document of the tab while the choice is offered", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h, { documentId: "other-document" });
      await flush();
      await handedOnSoon(request);
      expect(passkeyItems).not.toHaveBeenCalled();
    });

    it("looks up a choice once, again for other accounts, and only inside a vault hold", async () => {
      vi.useFakeTimers();
      // Holds without waiting for a vault check, as the lookup takes; an announcement
      // takes its own.
      let held = 0;
      const vault = {
        refreshIfStale: vi.fn(),
        enter: vi.fn(async (waitForCheck: boolean) => {
          if (!waitForCheck) held += 1;
          let left = false;
          return () => {
            if (left || waitForCheck) return;
            left = true;
            held -= 1;
          };
        }),
      };
      const insideHold: number[] = [];
      const passkeyItems = vi.fn(async (): Promise<readonly PasskeyItem[]> => {
        insideHold.push(held);
        return [{ connectionId, itemId }];
      });
      let data = both;
      const { h } = choosing(
        { passkeyItems, vault, extraItems: [{ id: thirdItemId, custom: [] }] },
        recipe,
        () => data,
      );
      await offered(h);
      const request = ask(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      expect(insideHold).toEqual([1]);
      expect(vault.enter).toHaveBeenLastCalledWith(false);
      expect(held).toBe(0);
      // The same choice offered again is not looked up again.
      await offered(h);
      await flush();
      await stillWaits(request);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      // A choice of other accounts is.
      data = uriMatch({
        candidates: [
          { itemId, matches: [{ uriIndex: 0, match: 0 }] },
          { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
          { itemId: thirdItemId, matches: [{ uriIndex: 0, match: 0 }] },
        ],
      });
      await offered(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(2);
      expect(insideHold).toEqual([1, 1]);
      expect(held).toBe(0);
      await stillWaits(request);
    });

    it("keeps a request picked for while the lookup runs, and answers it once the item is found", async () => {
      vi.useFakeTimers();
      const { lookup, answer } = deferred();
      const { h, report } = choosing({ passkeyItems: lookup });
      await offered(h);
      const request = ask(h);
      await flush();
      // The page announces again only five seconds after the pick.
      fake.state.onReconnect = () =>
        new Promise((resolve) => setTimeout(() => resolve(h.hello()), 5_000));
      const picking = pick(h);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(request.decided()).toBeUndefined();
      answer([{ connectionId, itemId }]);
      await flush();
      expect(request.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await picking).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
      expect(status()![0]).toMatchObject({ route: "passkey", account: { connectionId, itemId } });
      expect(routeChanges(report)).toEqual([]);
    });

    it("hands a request picked for on once the running lookup finds no passkey", async () => {
      vi.useFakeTimers();
      const { lookup, answer } = deferred();
      const { h } = choosing({ passkeyItems: lookup });
      await offered(h);
      const request = ask(h);
      await flush();
      fake.state.onReconnect = () =>
        new Promise((resolve) => setTimeout(() => resolve(h.hello()), 5_000));
      signsInOnClick();
      const picking = pick(h);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(request.decided()).toBeUndefined();
      answer([]);
      await flush();
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await picking).toEqual({ ok: true });
      // The pick's login, finding no request, takes the password.
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({ route: "password", account: { connectionId, itemId } });
    });
  });

  it("falls back as a missing request when the request went away as it was answered", async () => {
    const { h, report } = start();
    const request = ask(h);
    await flush();
    // The page aborts its request just before the answer goes out.
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      if (status()?.[0]?.["state"] === "submit-intent") request.controller.abort();
      return original();
    });
    signsInOnClick();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "password" }]),
    );
    expect(status()![0]).toMatchObject({ variant: 0, submissions: 2, maxSubmissions: 2 });
    expect(routeChanges(report)).toEqual(["request-missing"]);
    const attempts = report.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === "attempt");
    expect(attempts).not.toContainEqual(expect.objectContaining({ cause: "answer-failed" }));
    expect(attempts).toContainEqual(
      expect.objectContaining({ route: "passkey", state: "reconciling", outcome: "timeout" }),
    );
  });

  it("falls back to the password when the recipe's rejection shows after the answer", async () => {
    const rejecting = parseLoginRecipe({ ...recipe, rejection: target("rejected") });
    const { h, report } = start(rejecting);
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    const answer = answerOf(await request.decision);
    fake.state.present = new Set(["password", "login", "rejected"]);
    signsInOnClick();
    answer.answered(true);
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "password" }]),
    );
    expect(status()![0]).toMatchObject({ variant: 0, submissions: 2 });
    expect(fills()).toBe(1);
    expect(clicks("login")).toBe(1);
    expect(routeChanges(report)).toEqual(["sign-in-rejected"]);
  });

  it("does not take a rejection still showing from the passkey answer as the password's", async () => {
    const rejecting = parseLoginRecipe({ ...recipe, rejection: target("rejected") });
    const { h, report } = start(rejecting);
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    const answer = answerOf(await request.decision);
    fake.state.present = new Set(["password", "login", "rejected"]);
    // The banner stays after the click until the site signs in a little later.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "login")
        setTimeout(() => {
          fake.state.present = new Set(["authenticated"]);
        }, 300);
    };
    answer.answered(true);
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "password" }]),
    );
    expect(clicks("login")).toBe(1);
    expect(routeChanges(report)).toEqual(["sign-in-rejected"]);
  });

  it("does not spin when the answer is not authorized, and withholds after four minutes", async () => {
    vi.useFakeTimers();
    const first = new AbortController();
    // The page cancels its first request while the login starts on the passkey route.
    const passkeys = vi.fn(async () => {
      first.abort();
      return { passkey: true, discoverable: true };
    });
    const { h } = start(recipe, { passkeys });
    void h.login.conditionalRequest({
      tabId: 1,
      origin,
      documentId: "synthetic-document",
      signal: first.signal,
    });
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(status()![0]).toMatchObject({ route: "passkey", state: "ready" });
    // The extension's storage fails meanwhile, so no step is authorized any more.
    const set = fake.browser.storage.local.set;
    fake.browser.storage.local.set = async () => {
      throw new Error("synthetic storage failure");
    };
    try {
      for (const listener of fake.state.removed) listener(2);
      await flush();
    } finally {
      fake.browser.storage.local.set = set;
    }
    // The page asks again while the login waits for a request.
    const request = ask(h);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.decided()).toBeUndefined();
    expect(executed()).toEqual([]);
    // The login stays where it was; the request waits for it, then is withheld.
    await until(() => request.decided() !== undefined, 250_000);
    expect(request.decided()).toEqual({ kind: "withhold" });
    expect(executed()).toEqual([]);
  });
});
