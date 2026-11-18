import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  laterStartSteps,
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import { laterReadiness } from "../wire";
import { loginRecordOf } from "../../service/login-records";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  otherItemId,
  target,
  recipe,
  savedBinding,
  uriMatch,
  harness,
  setPause,
  liveDefault,
} = createRuntimeTestHarness(fake);

// As Qantas's sign-in (#1675, 2026-11-18): the start page's form asks for the membership
// number, last name and PIN beside a passkey button, which shows on the same path a step
// that asks for the membership number alone, then Continue, then a passkey request. Layout
// 1794476533378 is the form's and 1794922960578 the step's, learned after the person pressed
// the button. Its login on 2026-11-18 at 01:56 UTC took the button's route for an item
// with a discoverable passkey and stopped at the step (build f67d2749).
describe("a passkey button that leads to a step asking for the account (ADR 0060)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
    fake.state.awaitReply = undefined;
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/auth/member/oauth";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = SIGN_IN;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
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
    fake.state.ambiguous = new Set();
  });
  // The path, steps and budgets of both layouts as stored for the site (2026-11-18).
  const SIGN_IN = "/auth/member/oauth";
  const FORM = "1794476533378";
  const STEP = "1794922960578";
  const { completion: _unlearned, ...bare } = recipe;
  const button = { by: "text" as const, value: "SIGN IN WITH PASSKEY" };
  const form = parseLoginRecipe({
    ...bare,
    id: "synthetic-member",
    revision: 2,
    layout: FORM,
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        path: SIGN_IN,
        fields: [
          { slot: "username", target: target("memberId") },
          { slot: "password", target: target("pin") },
        ],
        effect: "prepare",
      },
      { kind: "click", path: SIGN_IN, target: { by: "text", value: "LOG IN" }, purpose: "submit" },
    ],
    passkey: { path: SIGN_IN, target: button },
    maxSubmissions: 1,
  });
  const identifierStep = (overrides: Record<string, unknown> = {}) =>
    parseLoginRecipe({
      ...bare,
      id: "synthetic-member",
      revision: 2,
      layout: STEP,
      slots: ["username"],
      steps: [
        { kind: "fill", path: SIGN_IN, fields: [{ slot: "username", target: target("memberId") }] },
        {
          kind: "click",
          path: SIGN_IN,
          target: { by: "text", value: "CONTINUE" },
          purpose: "advance",
        },
      ],
      maxSubmissions: 1,
      ...overrides,
    });
  const startPage = ["memberId", "lastName", "pin", "LOG IN", button.value];
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => {
        const step = (entry as unknown as { operation: { step: LoginStep } }).operation.step;
        return step.kind === "fill"
          ? `fill:${step.fields.map((field) => field.target.value).join(",")}`
          : `${step.kind}:${step.kind === "click" ? step.target.value : ""}`;
      });
  /** The page as it shows `shown`; the button leads to `afterButton`, Continue to nothing. */
  const shows = (shown: string[], afterButton = ["memberId", "CONTINUE"], then?: () => void) => {
    fake.state.present = new Set(shown);
    fake.state.awaitReply = (readiness) => ({
      ok: (readiness as unknown as { targets: { value: string }[] }).targets.every((entry) =>
        fake.state.present!.has(entry.value),
      ),
    });
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "click") return;
      if (step.target.value === button.value) fake.state.present = new Set(afterButton);
      // The site asks for the passkey over the step it shows.
      if (step.target.value === "CONTINUE") then?.();
    };
  };
  const discoverable = { passkey: true, discoverable: true };
  const secondFactor = { passkey: true, discoverable: false };
  const none = { passkey: false, discoverable: false };
  function start(
    layouts: LoginRecipe[],
    facts: { passkey: boolean; discoverable: boolean },
    overrides: Partial<LocalSettings> = {},
    live: Parameters<typeof harness>[1] = {},
    identifierField: "username" | "password" = "username",
  ) {
    const reports: LoginReport[] = [];
    const binding: SavedLoginBinding = {
      ...savedBinding,
      recipeId: form.id,
      slots: [
        { slot: "username", field: identifierField },
        { slot: "password", field: "password" },
      ],
    };
    const passkeys = vi.fn(async () => facts);
    const h = harness(
      { bindings: [binding], ...overrides },
      { username: true, report: (entry) => reports.push(entry), passkeys, ...live },
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "1234567" : "synthetic-secret",
    );
    const newest = layouts.at(-1)!;
    h.recipes.recipe.mockImplementation(
      async (_origin: string, _path: string, _id?: string, layout?: string) =>
        layout === undefined ? newest : layouts.find((entry) => entry.layout === layout),
    );
    h.recipes.starts.mockResolvedValue([
      {
        path: SIGN_IN,
        steps: layouts.map((layout) => layout.steps[0]!),
        later: layouts.flatMap((layout) => laterStartSteps(layout).map(laterReadiness)),
      },
    ]);
    Object.assign(h.recipes, {
      later: vi.fn(async () => layouts.filter((layout) => laterStartSteps(layout).length > 0)),
      layouts: vi.fn(async () =>
        layouts.map((layout) => ({ recipe: layout, createdAt: Number(layout.layout) })),
      ),
      layoutsOf: vi.fn(async () => layouts),
    });
    return { h, reports, passkeys };
  }
  async function until(check: () => boolean, maxMs = 60_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const passwordRead = (h: ReturnType<typeof start>["h"]) =>
    h.fields.mock.calls.some(([request]) => request.fieldId === "login.password");
  const routeChanges = (reports: LoginReport[]) =>
    reports.filter((entry) => entry.type === "attempt" && entry.layoutFrom !== undefined);
  const answeredByBridge = (h: ReturnType<typeof start>["h"]) => () =>
    h.login.passkeyAnswered(1, origin, "login.example");

  it.each([["discoverable", discoverable]])(
    "presses the button, fills the account, presses Continue and answers with a passkey %s",
    async (_label, facts) => {
      vi.useFakeTimers();
      const { h, reports } = start([form, identifierStep()], facts);
      let named: unknown;
      shows(startPage, undefined, () => {
        // The site's request after Continue goes to this login's item.
        void h.login.loginAccount(1, origin).then((account) => (named = account));
        answeredByBridge(h)();
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(
        () => status()?.[0]?.["state"] === "reconciling" && status()?.[0]?.["submissions"] === 3,
      );
      expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY", "fill:memberId", "click:CONTINUE"]);
      expect(named).toEqual({ connectionId, itemId });
      expect(status()![0]).toMatchObject({
        route: "password",
        variant: 0,
        layout: STEP,
        stepIndex: 2,
        stepCount: 2,
        stopAt: 2,
        passkeyButton: true,
        // The button's click, Continue's and the one kept for the answer.
        maxSubmissions: 3,
      });
      expect(reports.find((entry) => entry.type === "start")).toMatchObject({
        route: "passkey",
        layout: FORM,
      });
      expect(routeChanges(reports)).toEqual([
        expect.objectContaining({
          routeChange: "passkey-button",
          layoutFrom: FORM,
          branch: STEP,
        }),
      ]);
      // No password or PIN is ever read or typed.
      expect(passwordRead(h)).toBe(false);
    },
  );
  // As Qantas's login in the owner's Chrome on 2026-11-18 at 11:17 UTC (build ce71c5f0): the
  // item's passkey answered the step's request, the page moved on, and the login signed in,
  // but the service got no login record of it.
  it("sends a record of the password route that signed in with the item's passkey", async () => {
    vi.useFakeTimers();
    const { h, reports } = start([form, identifierStep()], discoverable);
    shows(startPage, undefined, () => {
      h.login.passkeyAnswered(
        1,
        origin,
        "login.example",
        { connectionId, itemId },
        { incognito: false, documentId: "synthetic-document" },
      );
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(
      () => status()?.[0]?.["state"] === "reconciling" && status()?.[0]?.["submissions"] === 3,
    );
    // The site's next page, on another origin of its site, shows no sign-in form.
    fake.state.signs = {
      password: false,
      code: false,
      captcha: false,
      invalid: false,
      alert: false,
    };
    fake.state.tabUrls[1] = "https://www.login.example/home";
    void h.hello({ documentId: "home-document", url: "https://www.login.example/home" }, false);
    await until(() => status()?.[0]?.["state"] === "authenticated");
    const ended = reports.findLast(
      (entry): entry is Extract<LoginReport, { type: "attempt" }> =>
        entry.type === "attempt" && entry.times !== undefined,
    )!;
    expect(ended).toMatchObject({
      state: "authenticated",
      route: "password",
      branch: STEP,
      stop: "passkey-button",
      methods: { route: "password", used: "passkey", held: "passkey.password" },
    });
    expect(ended.methods).not.toHaveProperty("why");
    expect(loginRecordOf(ended, "development")).toMatchObject({
      recipeId: form.id,
      record: {
        revision: 2,
        branch: STEP,
        outcome: "authenticated",
        route: "password",
        used: "passkey",
        held: "passkey.password",
      },
    });
    expect(passwordRead(h)).toBe(false);
  });
  it("answers the conditional request the step makes after Continue with the item", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable);
    let decided: ConditionalDecision | undefined;
    shows(startPage, undefined, () => {
      void h.login
        .conditionalRequest({
          tabId: 1,
          origin,
          documentId: "synthetic-document",
          signal: new AbortController().signal,
        })
        .then((value) => (decided = value));
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => decided !== undefined);
    expect(decided).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
    expect(status()![0]).toMatchObject({ layout: STEP, stepIndex: 2, submissions: 3 });
    expect(passwordRead(h)).toBe(false);
  });
  it("ends at the step, watched, when no passkey request comes, and never types the PIN", async () => {
    vi.useFakeTimers();
    const { h, reports } = start([form, identifierStep()], discoverable);
    shows(startPage);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge", layout: STEP, stepIndex: 2 });
    expect(reports.filter((entry) => entry.type === "attempt").at(-1)).toMatchObject({
      reason: "passkey-button",
    });
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY", "fill:memberId", "click:CONTINUE"]);
    expect(passwordRead(h)).toBe(false);
  });
  it("fills the form's password route for an item without a passkey", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], none);
    shows(startPage);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    expect(executed()).toEqual(["fill:memberId,pin", "click:LOG IN"]);
    expect(status()![0]).toMatchObject({ route: "password", layout: FORM });
  });
  it.each([
    ["without such a step", [form]],
    ["with a step that asks for the account after the button", [form, identifierStep()]],
  ])(
    "fills the form's password for a passkey that is not discoverable, %s",
    async (_label, layouts) => {
      vi.useFakeTimers();
      const { h } = start(layouts, secondFactor);
      shows(startPage);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      expect(executed()).toEqual(["fill:memberId,pin", "click:LOG IN"]);
      expect(status()![0]).toMatchObject({ route: "password", layout: FORM });
    },
  );
  it("only presses the button for a discoverable passkey when no layout asks for the account", async () => {
    vi.useFakeTimers();
    const { h } = start([form], discoverable);
    shows(startPage);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["settled"] === true, 120_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    expect(status()![0]).toMatchObject({ route: "passkey", layout: FORM });
    expect(status()![0]).not.toHaveProperty("passkeyButton");
  });
  it.each<[string, Record<string, unknown>]>([
    ["that fills a password", { slots: ["password"] }],
    ["that ends with a submission", {}],
  ])("does not treat a layout %s as the button's step", async (label, overrides) => {
    vi.useFakeTimers();
    const other =
      label === "that fills a password"
        ? identifierStep({
            slots: ["password"],
            steps: [
              {
                kind: "fill",
                path: SIGN_IN,
                fields: [{ slot: "password", target: target("memberId") }],
              },
              {
                kind: "click",
                path: SIGN_IN,
                target: { by: "text", value: "CONTINUE" },
                purpose: "advance",
              },
            ],
          })
        : identifierStep({
            ...overrides,
            steps: [
              {
                kind: "fill",
                path: SIGN_IN,
                fields: [{ slot: "username", target: target("memberId") }],
              },
              {
                kind: "click",
                path: SIGN_IN,
                target: { by: "text", value: "CONTINUE" },
                purpose: "submit",
              },
            ],
          });
    const { h } = start([form, other], discoverable);
    shows(startPage);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    expect(status()![0]).toMatchObject({ route: "passkey", layout: FORM });
  });
  it("waits on the button's route while the button still shows beside the step", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable);
    // The click leaves the button showing, as a page still exchanging the passkey does.
    shows(startPage, ["memberId", "CONTINUE", button.value]);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    expect(status()![0]).toMatchObject({ route: "passkey", layout: FORM });
  });
  it("waits on the button's route while the button shows more than once beside the step", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable);
    shows(startPage, ["memberId", "CONTINUE", button.value]);
    const shown = fake.state.onExecute!;
    fake.state.onExecute = async (message, tabId) => {
      await shown(message, tabId);
      fake.state.ambiguous = new Set([button.value]);
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    expect(status()![0]).toMatchObject({ route: "passkey", layout: FORM });
  });
  it("does not switch before the step's Continue shows", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable);
    shows(startPage, ["memberId"]);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    // Continue shows later: the login goes on there.
    fake.state.present = new Set(["memberId", "CONTINUE"]);
    await until(() => executed().length === 3);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY", "fill:memberId", "click:CONTINUE"]);
  });
  it("fills the password route on a page set to fill only (ADR 0035)", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable, {
      pagePermissionDefaults: { "sign-in": "fill", confirm: "fill", "personal-details": "fill" },
    });
    shows(startPage);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 1);
    expect(executed()).toEqual(["fill:memberId,pin"]);
    expect(status()![0]).toMatchObject({ route: "password", signInFill: true });
  });
  it("fills the password route on a site whose passkey requests go to the browser (ADR 0007)", async () => {
    vi.useFakeTimers();
    const { h, passkeys } = start([form, identifierStep()], discoverable, {
      passkeyBrowserSites: [{ hostname: new URL(origin).hostname }],
    });
    shows(startPage);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    expect(executed()).toEqual(["fill:memberId,pin", "click:LOG IN"]);
    expect(passkeys).not.toHaveBeenCalled();
  });
  it("never sends the page after Continue to be judged or to continue the recipe", async () => {
    vi.useFakeTimers();
    const generation = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "abstained",
        reason: "ambiguous",
      })),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true as const, data: uriMatch() }));
    const { h } = start([form, identifierStep()], discoverable, {}, { generation, uris });
    // The site shows its PIN input after Continue instead of asking for the passkey.
    shows(startPage, undefined, () => {
      fake.state.present = new Set(["memberId", "pin", "CONTINUE"]);
      fake.state.signIn = true;
      fake.state.extracted = {
        login: {
          ok: true,
          observation: {
            version: 1,
            origin,
            path: SIGN_IN,
            language: "en",
            complete: true,
            candidates: [
              { id: "c1", role: "password", target: target("pin"), label: "PIN" },
              { id: "c2", role: "button", target: target("login"), label: "Log in" },
            ],
          },
        },
      };
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge", layout: STEP });
    expect(generation.generate).not.toHaveBeenCalled();
    expect(generation.judge).not.toHaveBeenCalled();
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY", "fill:memberId", "click:CONTINUE"]);
    expect(passwordRead(h)).toBe(false);
  });
  it("starts nothing on a paused site (ADR 0062)", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable);
    shows(startPage);
    await setPause(h, true);
    expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
    expect(executed()).toEqual([]);
  });
  it.each([["discoverable", discoverable, ["click:SIGN IN WITH PASSKEY"]]])(
    "never goes on to the step whose binding reads the password, for a passkey %s",
    async (_label, facts, steps) => {
      vi.useFakeTimers();
      // The account's identifier is bound to its password field.
      const { h } = start([form, identifierStep()], facts, {}, {}, "password");
      shows(startPage);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === steps.length);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(executed()).toEqual(steps);
      expect(status()![0]).toMatchObject({ layout: FORM });
    },
  );
  it("does not switch when the click moved the page to another path", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable);
    shows(startPage);
    const shown = fake.state.onExecute!;
    fake.state.onExecute = async (message, tabId) => {
      await shown(message, tabId);
      fake.state.observedPath = "/auth/member/passkey";
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    expect(status()![0]).toMatchObject({ route: "passkey", layout: FORM });
    // A discoverable passkey keeps the button's route: it never goes back to the password.
    await until(() => status()?.[0]?.["settled"] === true, 120_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    expect(passwordRead(h)).toBe(false);
  });
  it("never switches to the step in a frame", async () => {
    vi.useFakeTimers();
    const { h } = start([form, identifierStep()], discoverable);
    shows(startPage);
    fake.state.tabUrls[1] = "https://login.example/home";
    expect(
      await h.hello({
        frameId: 3,
        documentId: "frame-one",
        tab: { id: 1, url: "https://login.example/home" },
      }),
    ).toEqual({ ok: true });
    await until(() => executed().length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    expect(status()![0]).toMatchObject({ route: "passkey", layout: FORM });
    expect(status()![0]).not.toHaveProperty("passkeyButton");
  });
  it("never takes over the step after the site's account changed under the click", async () => {
    vi.useFakeTimers();
    const both = { matches: [{ uriIndex: 0, match: 0 as const }] };
    const uris = vi.fn<LiveUriMatcher>(async () => ({
      ok: true as const,
      data: uriMatch({
        candidates: [
          { itemId, ...both },
          { itemId: otherItemId, ...both },
        ],
      }),
    }));
    const { h } = start([form, identifierStep()], discoverable, {}, { otherUsername: true, uris });
    shows(startPage);
    const shown = fake.state.onExecute!;
    fake.state.onExecute = async (message, tabId) => {
      await shown(message, tabId);
      // The site's default now names another item, without a new settings revision.
      h.settings.settings.siteDefaults = [liveDefault({ itemId: otherItemId })];
      h.settings.settings.bindings = [];
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toEqual(["click:SIGN IN WITH PASSKEY"]);
    // The changed choice withdraws the login before any plan for another account is made.
    expect(status()![0]).toMatchObject({
      route: "passkey",
      layout: FORM,
      state: "blocked",
      outcome: "policy-changed",
    });
    // An ended login keeps no methods for a later worker (ADR 0055).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state.session["pateat.login-methods.v1"]).toEqual([]);
  });
});
