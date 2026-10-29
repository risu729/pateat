import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../../crypto/wire";
import type { LoginReport } from "../runtime/report";
import type { ConditionalDecision, PasskeyItem } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, recipe, otherItemId, uriMatch, harness, realTime } =
  createRuntimeTestHarness(fake);

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
