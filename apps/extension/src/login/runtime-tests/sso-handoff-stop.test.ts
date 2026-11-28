import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdsOrigin,
  parseLoginRecipe,
  type LoginAttemptMetadata,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import type { SsoState } from "../runtime/sso-state";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
// The runtime's SSO state, so a test can make the tab's method choice a hand-off.
const states = vi.hoisted(() => [] as SsoState[]);
vi.mock("../runtime/sso-state", async (original) => {
  const actual = await original<typeof import("../runtime/sso-state")>();
  return {
    ...actual,
    createSsoState: () => {
      const state = actual.createSsoState();
      states.push(state);
      return state;
    },
  };
});
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, harness } = createRuntimeTestHarness(fake);

// A hand-off (ADR 0036 amendment of 2026-11-28, #1847): an SSO item's login types its
// identifier on the site's page, presses Next and stops at the step after.
describe("a hand-off login that stops after its identifier", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0)) listener(1);
  });
  beforeEach(() => {
    states.length = 0;
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    // Next leads to the site's own password page in the same document, which the judge
    // could be sent.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "next") {
        fake.state.observedPath = "/password";
        fake.state.present = new Set(["password", "login"]);
        fake.state.extracted = { "signed-in": passwordPage };
      }
    };
  });
  const passwordPage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/password",
      language: "en",
      complete: true,
      candidates: [
        { id: "c1", role: "password", target: target("password"), label: "Password" },
        { id: "c2", role: "button", target: target("login"), label: "Sign in" },
      ],
    },
  };
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "synthetic-email-first",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
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
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
  const verifyPage = {
    ...passwordPage,
    observation: { ...passwordPage.observation, path: "/verify" },
  };
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  const reconnects = () => fake.state.messages.filter((entry) => entry.type === "login.reconnect");
  async function until(check: () => boolean, maxMs = 60_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  /**
   * The item, without a password, chosen for the tab's document as the SSO method choice
   * does; `handoff` marks it a hand-off. Its item holds a passkey, so a stop without the
   * mark waits for the page's request and judges its page.
   */
  function start({
    handoff = true,
    documentId = "synthetic-document",
    frameId = 0,
  }: { handoff?: boolean; documentId?: string; frameId?: number } = {}) {
    const report = vi.fn<(entry: LoginReport) => void>();
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: "challenge" };
    });
    const h = harness(
      {},
      {
        allowedOrigins: [origin],
        username: true,
        report,
        passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
        generation: {
          available: vi.fn<LoginGeneration["available"]>(async () => true),
          generate: vi.fn<LoginGeneration["generate"]>(),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge,
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      },
    );
    h.recipes.recipe.mockResolvedValue(emailFirst);
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        for (const field of response.catalog.connections[0]!.items[0]!.fields)
          if (field.id === "login.password") field.empty = true;
      return response;
    });
    states.at(-1)!.native.set(1, {
      document: { origin, tabId: 1, frameId, documentId },
      account: { origin, connectionId, itemId },
      chosen: { connectionId, itemId, saved: false, source: "match" },
      route: "password",
      ...(handoff ? { handoff: true as const } : {}),
    });
    const refusals = () =>
      report.mock.calls.flatMap(([entry]) => (entry.type === "refused" ? [entry] : []));
    return { h, report, judge, refusals };
  }
  /** The document's conditional passkey request, waiting before the login starts. */
  function waitingRequest(h: ReturnType<typeof harness>) {
    let decided: ConditionalDecision | undefined;
    void h.login
      .conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: new AbortController().signal,
      })
      .then((value) => (decided = value));
    return () => decided;
  }

  it("ends `challenge` on the site's password page, without the passkey or the judge", async () => {
    vi.useFakeTimers();
    const { h, report, judge } = start();
    const decided = waitingRequest(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "blocked");
    const record = status()![0] as unknown as LoginAttemptMetadata;
    expect(record).toMatchObject({
      outcome: "challenge",
      ssoHandoff: true,
      stepIndex: 2,
      stopAt: 2,
      submissions: 1,
    });
    expect(record).not.toHaveProperty("watch");
    expect(record).not.toHaveProperty("stopJudged");
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.username"]);
    // The page's waiting request is never answered, and nothing is judged.
    expect(decided()).not.toMatchObject({ kind: "answer" });
    expect(judge).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "attempt",
        state: "blocked",
        outcome: "challenge",
        reason: "password-empty:sso-identifier:same-site",
      }),
    );
    // The page announces again, so what it offers next decides.
    expect(reconnects()).toHaveLength(1);
    // Nothing more is filled while it does.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed()).toHaveLength(2);
  });

  it("judges the stop's page without the mark, as before", async () => {
    vi.useFakeTimers();
    const { h, judge } = start({ handoff: false });
    // No request: the stop is judged for a passkey button, then watched.
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge", stopAt: 2, stopJudged: true });
    expect(status()![0]).not.toHaveProperty("ssoHandoff");
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("goes on past an identifier-only route's Continue to its stop, unjudged", async () => {
    vi.useFakeTimers();
    const { h, report, judge } = start();
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...emailFirst,
        slots: ["username"],
        steps: emailFirst.steps.slice(0, 2),
        maxSubmissions: 1,
      }),
    );
    // The page after Next asks for nothing the recipe knows, with something to describe.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click") {
        fake.state.observedPath = "/verify";
        fake.state.present = new Set();
        fake.state.extracted = { "signed-in": verifyPage };
        // A quiet page, which the judge would be sent.
        fake.state.signs = quiet;
      }
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "blocked");
    expect(status()![0]).toMatchObject({
      outcome: "challenge",
      ssoHandoff: true,
      stepIndex: 2,
      stopAt: 2,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "password-empty:sso-identifier:same-site" }),
    );
    expect(reconnects()).toHaveLength(1);
  });

  it("goes on to its stop unjudged on a new page of the site that is not the password's", async () => {
    vi.useFakeTimers();
    const { h, judge } = start();
    // Next never answers: the site loads another of its own pages meanwhile.
    fake.state.onExecute = (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      return step.kind === "click" ? new Promise(() => undefined) : Promise.resolve();
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    // A quiet page with something to describe, which the judge would be sent.
    fake.state.observedPath = "/verify";
    fake.state.present = new Set();
    fake.state.signs = quiet;
    fake.state.extracted = { "signed-in": verifyPage };
    fake.state.tabUrls[1] = `${origin}/verify`;
    void h.hello({ documentId: "verify-document", url: `${origin}/verify` }, false);
    await until(() => status()?.[0]?.["state"] === "blocked");
    expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2, stopAt: 2 });
    expect(judge).not.toHaveBeenCalled();
    expect(reconnects()).toHaveLength(1);
  });

  it("ends `left-origin` when Next takes the tab to another origin, holding nothing", async () => {
    vi.useFakeTimers();
    const { h, judge } = start();
    // Next never answers: the tab moves to the identity provider meanwhile.
    fake.state.onExecute = (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      return step.kind === "click" ? new Promise(() => undefined) : Promise.resolve();
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    const idp = "https://idp.example";
    fake.state.observedPath = "/authorize";
    fake.state.present = new Set();
    fake.state.tabUrls[1] = `${idp}/authorize`;
    void h.hello({ documentId: "idp-document", url: `${idp}/authorize` }, false);
    await until(() => status()?.[0]?.["state"] === "blocked");
    const record = status()![0] as unknown as LoginAttemptMetadata;
    expect(record).toMatchObject({ outcome: "left-origin", ssoHandoff: true, stopAt: 2 });
    expect(holdsOrigin(record)).toBe(false);
    expect(judge).not.toHaveBeenCalled();
    expect(executed()).toHaveLength(2);
  });

  it("refuses a route whose steps before the stop fill more than the username", async () => {
    const { h, refusals } = start();
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...emailFirst,
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "username", target: target("email") },
              { slot: "password", target: target("password") },
            ],
          },
          { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
          { kind: "click", path: "/next", target: target("login"), purpose: "submit" },
        ],
      }),
    );
    fake.state.present = new Set(["email", "password", "next"]);
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(refusals()).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "sso-identifier:fills-other" }),
    ]);
    expect(executed()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("refuses a recipe with alternatives, as any stop", async () => {
    const { h, refusals } = start();
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...emailFirst,
        alternatives: [
          {
            slots: ["account", "password"],
            steps: [
              {
                kind: "fill",
                path: "/signin",
                fields: [{ slot: "account", target: target("id") }],
              },
              { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
              {
                kind: "fill",
                path: "/password",
                fields: [{ slot: "password", target: target("password") }],
              },
              { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
            ],
          },
        ],
      }),
    );
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(refusals()).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "sso-identifier:alternatives" }),
    ]);
    expect(executed()).toEqual([]);
  });

  it("refuses in a frame, naming the frame", async () => {
    const { h, refusals } = start({ documentId: "frame-document", frameId: 3 });
    const top = "https://login.example/account";
    fake.state.tabUrls[1] = top;
    expect(
      await h.hello({ frameId: 3, documentId: "frame-document", tab: { id: 1, url: top } }),
    ).toEqual({ ok: false, reason: "no-route" });
    expect(refusals()).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "sso-identifier:frame" }),
    ]);
    expect(executed()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });
});
