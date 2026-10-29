import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  target,
  recipe,
  savedBinding,
  otherItemId,
  uriMatch,
  liveDefault,
  harness,
  realTime,
} = createRuntimeTestHarness(fake);

describe("the start page's own passkey request (ADR 0034)", () => {
  beforeEach(realTime);
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
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target.value === value).length;
  const fills = () => executed().filter((step) => step.kind === "fill").length;
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
  const flush = async () => {
    for (let index = 0; index < 10; index++)
      // eslint-disable-next-line no-await-in-loop
      await (vi.isFakeTimers()
        ? vi.advanceTimersByTimeAsync(0)
        : new Promise((resolve) => setTimeout(resolve, 0)));
  };
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
  it("widens a saved default's binding that lacks a slot after the fallback signs in (ADR 0027)", async () => {
    // The saved default's passkey plan saves nothing; the password variant fills the
    // username its saved binding lacks, so that binding is what the sign-in saves.
    const withUsername = parseLoginRecipe({
      ...recipe,
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [
            { slot: "username", target: target("user") },
            { slot: "password", target: target("password") },
          ],
        },
        recipe.steps[1]!,
      ],
    });
    fake.state.present = new Set(["user", "password", "login"]);
    const { h, report } = start(withUsername, { username: true });
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    const answer = answerOf(await request.decision);
    signsInOnClick();
    answer.answered(false);
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "password", variant: 0 });
    expect(routeChanges(report)).toEqual(["answer-failed"]);
    await vi.waitFor(() =>
      expect(h.settings.settings.bindings).toEqual([
        {
          ...savedBinding,
          slots: [...savedBinding.slots, { slot: "username", field: "username" }],
        },
      ]),
    );
    expect(h.settings.settings.siteDefaults).toEqual([liveDefault()]);
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
      undefined,
      undefined,
      undefined,
      expect.any(Array),
    );
    expect(executed()).toEqual([]);
  });
  it("samples the signed-in page of a marked passkey login on the password route (ADR 0029)", async () => {
    vi.useFakeTimers();
    const homePage = {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/home",
        language: "en",
        complete: true,
        candidates: [
          { id: "c1", role: "button", target: target("authenticated"), label: "Sign out" },
        ],
      },
    };
    const samplePage = vi.fn<NonNullable<LoginGeneration["samplePage"]>>(
      async (_sample, describePage, sending) => {
        const described = await describePage();
        if ("unsent" in described) return { outcome: "not-sent", reason: described.unsent };
        await sending?.();
        return { outcome: "kept" };
      },
    );
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      samplePage,
    };
    // The recipe has its marker and no passkey button: the page asked for a passkey itself.
    const { h } = start(recipe, { generation: service });
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => request.decided() !== undefined, 5_000);
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["authenticated"]);
    fake.state.extracted = { "signed-in": homePage };
    answerOf(request.decided()).answered(true);
    await until(settled("authenticated"), 20_000);
    expect(status()![0]).toMatchObject({ route: "passkey" });
    await until(() => samplePage.mock.results.length > 0, 5_000);
    await samplePage.mock.results[0]!.value;
    // As the judge is told it: the service knows no passkey route on such a recipe.
    expect(samplePage.mock.calls[0]![0]).toEqual({
      recipeId: recipe.id,
      revision: recipe.revision,
      route: "password",
    });
    await expect(samplePage.mock.results[0]!.value).resolves.toEqual({ outcome: "kept" });
    expect(service.judge).not.toHaveBeenCalled();
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
  describe("while the tab asks for an account (ADR 0062)", () => {
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
    const signedIn = async (live: Parameters<typeof harness>[1] = {}) => {
      const started = start(recipe, { ...matching, ...live });
      signsInOnClick();
      expect(await started.h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      fake.state.present = new Set(["password", "login"]);
      return started;
    };
    const asked = async (live: Parameters<typeof harness>[1] = {}) => {
      fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
      const started = start(recipe, { ...matching, ...live }, { siteDefaults: [], bindings: [] });
      const { h } = started;
      expect(await h.hello({ documentId: "signed-out" })).toEqual({
        ok: false,
        reason: "account-asked",
      });
      expect(await choice(h)).toMatchObject({ documentId: "signed-out", ask: "rejected" });
      fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
      return started;
    };
    it("answers the signed-out page's own request with the default after a logout", async () => {
      vi.useFakeTimers();
      // The item holds a discoverable passkey: the login after the logout answers the
      // page's request, as on any visit (#833).
      const { h, report } = await signedIn();
      fake.state.onExecute = undefined;
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId },
      });
      expect(status()![0]).toMatchObject({
        route: "passkey",
        document: { documentId: "signed-out" },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(settled("authenticated"), 20_000);
      expect(fills()).toBe(1);
      expect(clicks("login")).toBe(1);
      expect(fake.state.badges[1]?.text ?? "").not.toMatch(/^\d+$/u);
      expect(routeChanges(report)).toEqual([]);
    });
    const fillsOnly = () => {
      fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
      return start(recipe, matching);
    };
    it("keeps a request waiting during a login that only fills while the tab asks, and after it", async () => {
      vi.useFakeTimers();
      // The item holds a discoverable passkey, yet the login while the tab asks only fills.
      const { h, report } = fillsOnly();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      fake.state.onExecute = () => held;
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => fills() === 1, 5_000);
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
      expect(fills()).toBe(1);
      expect(clicks("login")).toBe(0);
      expect(routeChanges(report)).toEqual([]);
    });
    it("does not answer a login that only fills while the tab asks when the request came first", async () => {
      vi.useFakeTimers();
      const { h, report } = fillsOnly();
      // The signed-out page asks for a passkey before its form is ready.
      fake.state.onExecute = () => new Promise(() => undefined);
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => fills() === 1, 5_000);
      expect(status()![0]).toMatchObject({ fillOnly: true, route: "password" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      expect(status()![0]).toMatchObject({ fillOnly: true, route: "password" });
      expect(clicks("login")).toBe(0);
      expect(routeChanges(report)).toEqual([]);
    });
    it("answers a request kept through a login that only filled with the account picked next", async () => {
      vi.useFakeTimers();
      const { h, report } = fillsOnly();
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => fake.state.badges[1]?.text === "2", 5_000);
      expect(fills()).toBe(1);
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
      // Nothing was pressed while the tab asked, and the pick filled nothing.
      expect(fills()).toBe(1);
      expect(clicks("login")).toBe(0);
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "start", route: "passkey", account: "pick" }),
      );
      expect(routeChanges(report)).toEqual([]);
    });
    it("answers a waiting request with the account picked in the popup, on the passkey route", async () => {
      vi.useFakeTimers();
      const { h, report } = await asked();
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
      expect(clicks("login")).toBe(0);
      expect(
        report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "start"),
      ).toEqual([expect.objectContaining({ route: "passkey", account: "pick" })]);
      expect(routeChanges(report)).toEqual([]);
    });
    it("hands on a request of another document of the tab that was not asked", async () => {
      vi.useFakeTimers();
      const { h } = await asked();
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
      const { h, report } = await asked({ passkeys });
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
      expect(fills()).toBe(1);
      expect(clicks("login")).toBe(1);
      expect(routeChanges(report)).toEqual([]);
    });
    it("keeps a request of a tab asked for another tab's rejection after that tab's pick logs in", async () => {
      vi.useFakeTimers();
      const { h, report } = await asked();
      const recordOf = (tabId: number) =>
        status()?.find(
          (entry) => (entry["document"] as { tabId: number } | undefined)?.tabId === tabId,
        );
      // Another tab shows the form and asks only because of this tab's rejection.
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "account-asked",
      });
      expect(await choice(h, 2)).toMatchObject({
        documentId: "other-tab",
        ask: "rejected-elsewhere",
      });
      const request = ask(h, { tabId: 2, documentId: "other-tab" });
      await flush();
      // The first tab's pick logs in there and ends its ask.
      signsInOnClick();
      expect(await pick(h, { itemId })).toEqual({ ok: true });
      await until(() => recordOf(1)?.["state"] === "authenticated", 20_000);
      expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([]);
      // The second tab's choice is still offered, so its request still waits.
      expect(await choice(h, 2)).toMatchObject({
        documentId: "other-tab",
        ask: "rejected-elsewhere",
      });
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
      const { h } = await asked();
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
  });
});
