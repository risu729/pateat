import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../../crypto/wire";
import type { LoginReport } from "../runtime/report";
import type { LoginGeneration } from "../runtime/deps";
import type { ConditionalDecision, PasskeyItem } from "../../passkeys/runtime";
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
  otherItemId,
  uriMatch,
  harness,
  realTime,
  savedBinding,
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
  describe("while the tab offers a popup choice outside a logout (ADR 0034 rule 5)", () => {
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
  it("never counts the refused passkey answer as the password route's credential (owner, 2026-11-08)", async () => {
    // After the fall-back, the password route types the identifier and only advances.
    vi.useFakeTimers();
    const identifier = parseLoginRecipe({
      ...recipe,
      slots: ["username"],
      rejection: target("rejected"),
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "username", target: target("password") }],
        },
        { kind: "click", path: "/signin", target: target("login"), purpose: "advance" },
      ],
    });
    const judge = vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "optional" }));
    const { h, report } = start(
      identifier,
      {
        username: true,
        generation: {
          available: vi.fn<LoginGeneration["available"]>(async () => true),
          generate: vi.fn<LoginGeneration["generate"]>(),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge,
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      },
      { bindings: [{ ...savedBinding, slots: [{ slot: "username", field: "username" }] }] },
    );
    const request = ask(h);
    await flush();
    expect(await h.hello()).toEqual({ ok: true });
    const answer = answerOf(await request.decision);
    fake.state.present = new Set(["password", "login", "rejected"]);
    // The click moves on to a quiet page that offers a choice, judged `optional`.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "click" || step.target.value !== "login") return;
      fake.state.observedPath = "/options";
      fake.state.present = new Set();
      fake.state.signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      fake.state.extracted = {
        "signed-in": {
          ok: true,
          observation: {
            version: 1,
            origin,
            path: "/options",
            language: "en",
            complete: true,
            candidates: [{ id: "c1", role: "button", target: target("later"), label: "Not now" }],
          },
        },
      };
    };
    // The bridge reports the answer it returned, as in the browser.
    h.login.passkeyAnswered(1, origin, "login.example");
    answer.answered(true);
    await until(() => judge.mock.calls.length === 1, 30_000);
    expect(routeChanges(report)).toEqual(["sign-in-rejected"]);
    expect(clicks("login")).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    // Only the identifier went in on the password route: not known to be signed in.
    expect(status()![0]).toMatchObject({ route: "password", outcome: "unknown-submit" });
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
  describe("a request its page moved away from in place (ADR 0034 amendment of 2026-11-17)", () => {
    /** The site's router moves the tab in place to `path`, as `history.pushState` does. */
    const moveTo = (path: string) => {
      fake.state.tabUrls[1] = `${origin}${path}`;
      fake.state.observedPath = path;
    };
    it("is handed on, never answered, when the page moves while its form is filled", async () => {
      const { h, report } = start();
      let request: ReturnType<typeof ask> | undefined;
      // The page asks while its form is being filled, then moves to another route of the
      // same document without cancelling the request (#1670).
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind !== "fill" || request) return;
        request = ask(h);
        await flush();
        moveTo("/challenge");
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(request?.decided()).toBeDefined());
      expect(request!.decided()).toEqual({ kind: "delegate", reason: "page-moved" });
      await vi.waitFor(() => expect(status()?.[0]?.["state"]).not.toBe("ready"));
      expect(status()![0]).toMatchObject({ route: "password", submissions: 1 });
      expect(routeChanges(report)).toEqual([]);
    });
    /** A login whose recipe starts on the page the site moves to. */
    const startThere = () => {
      const challenge = parseLoginRecipe({
        ...recipe,
        id: "synthetic-challenge",
        steps: recipe.steps.map((step) => ({ ...step, path: "/auth_challenge" })),
      });
      const started = start(challenge);
      started.h.recipes.starts.mockResolvedValue([
        { path: "/auth_challenge", steps: [challenge.steps[0]!] },
      ]);
      return started;
    };
    it("keeps the path a request first came on when it waits again", async () => {
      vi.useFakeTimers();
      const { h, report } = startThere();
      const input = {
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: new AbortController().signal,
      };
      // No login starts while it first waits on the sign-in page.
      const first = h.login.conditionalRequest(input);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await first).toEqual({ kind: "delegate", reason: "no-login" });
      // The page moves in place; the same request waits again, as the bridge passes it
      // on after a failed answer, and a login starts on the page it moved to.
      moveTo("/auth_challenge");
      fake.state.pageUrl = `${origin}/auth_challenge`;
      let again: ConditionalDecision | undefined;
      void h.login.conditionalRequest(input).then((value) => (again = value));
      await flush();
      signsInOnClick();
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      expect(again).toEqual({ kind: "delegate", reason: "page-moved" });
      expect(status()![0]).toMatchObject({ route: "password" });
      expect(routeChanges(report)).toEqual([]);
    });
    it("leaves a new login on the page it moved to on the password route", async () => {
      const { h, report } = startThere();
      // The sign-in page's own request waits while the site moves in place to its method
      // selection page, where a login then starts.
      const request = ask(h);
      await flush();
      moveTo("/auth_challenge");
      fake.state.pageUrl = `${origin}/auth_challenge`;
      signsInOnClick();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "authenticated", route: "password" }]),
      );
      expect(request.decided()).toEqual({ kind: "delegate", reason: "page-moved" });
      expect(clicks("login")).toBe(1);
      expect(routeChanges(report)).toEqual([]);
    });
    it("is handed on as page-unknown when its tab's path could not be read", async () => {
      const { h, report } = start();
      // The tab already shows another origin, so the request's path is unknown.
      fake.state.tabUrls[1] = "https://elsewhere.example/signin";
      const request = ask(h);
      await flush();
      fake.state.tabUrls[1] = `${origin}/signin`;
      signsInOnClick();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "authenticated", route: "password" }]),
      );
      expect(request.decided()).toEqual({ kind: "delegate", reason: "page-unknown" });
      expect(routeChanges(report)).toEqual([]);
    });
    it("is handed on when the page moves as the answer goes out", async () => {
      const { h, report } = start();
      const request = ask(h);
      await flush();
      // The page moves after the login found the request, just before it answers.
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        if (status()?.[0]?.["state"] === "submit-intent") moveTo("/challenge");
        return original();
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(request.decided()).toBeDefined());
      expect(request.decided()).toEqual({ kind: "delegate", reason: "page-moved" });
      // Never answered, the login falls back to its password as without a request.
      await vi.waitFor(() => expect(routeChanges(report)).toEqual(["request-missing"]));
      expect(status()![0]).toMatchObject({ route: "password" });
    });
  });
});
