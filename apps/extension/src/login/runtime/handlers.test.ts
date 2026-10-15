import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createSettingsStore,
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type SettingsSnapshot,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import { createVaultAutoSync, createVaultSyncRecords } from "../../connections/auto-sync";
import { createLoginGeneration } from "../../service/generation";
import { createRecipeSync } from "../../service/recipes";
import { createSettingsSync } from "../../service/settings-sync";
import type { ServiceTransport } from "../../service/transport";
import type { LoginGeneration } from "./recipes";
import type { LoginReport } from "./reports";
import {
  connectionId,
  harness,
  itemId,
  origin,
  otherItemId,
  recipe,
  savedBinding,
  startsOf,
  target,
  uriMatch,
  userId,
} from "./__fixtures__/harness";

const { fake } = await vi.hoisted(() => import("./__fixtures__/browser"));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));

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
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
  });

  const securityKey = { by: "text" as const, value: "Use security key" };
  const keyHandler = { kind: "passkey" as const, path: "/login/webauthn", target: securityKey };
  const { completion: _unlearned, ...unlearned } = recipe;
  const plain = parseLoginRecipe(unlearned);
  const home = [{ target: target("logout") }];
  /** npm's shape: a handler for its security-key page and a learned completion. */
  const handled = parseLoginRecipe({ ...unlearned, completion: home, handlers: [keyHandler] });
  const taken = parseLoginRecipe({ ...unlearned, revision: 2, handlers: [keyHandler] });
  const withPasskey = vi.fn(async () => ({ passkey: true, discoverable: false }));
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const webauthnPage = observation("/login/webauthn", [
    { id: "c1", role: "button", target: securityKey, label: "Use security key" },
  ]);
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v4"] as Record<string, unknown>[] | undefined;
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
  /** What each click leads to: the next path, its elements and its description. */
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
  const toWebauthn = {
    path: "/login/webauthn",
    present: ["Use security key"],
    extracted: webauthnPage,
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
  /** Replaces the item's catalog fields, as a vault sync would. */
  const editFields = (
    h: ReturnType<typeof harness>,
    edit: (fields: Record<string, unknown>[]) => Record<string, unknown>[],
  ) => {
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        item.fields = edit(item.fields as never) as never;
      }
      return response;
    });
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

  describe("the item's facts", () => {
    it.each([
      [
        "a password, a TOTP secret and a discoverable passkey",
        { passkey: true, discoverable: true },
        { empty: false },
        { password: true, totp: true, passkey: true, discoverablePasskey: true },
      ],
      [
        "a second-factor passkey and an empty TOTP field",
        { passkey: true, discoverable: false },
        { empty: true },
        { password: true, totp: false, passkey: true, discoverablePasskey: false },
      ],
      [
        "a failed passkey lookup and no TOTP field",
        "fails",
        undefined,
        { password: true, totp: false, passkey: false, discoverablePasskey: false },
      ],
    ] as const)("records %s when the login starts", async (_label, held, totp, facts) => {
      const passkeys = vi.fn(async () => {
        if (held === "fails") throw new Error("native host unavailable");
        return held;
      });
      const h = harness({}, { passkeys });
      if (totp)
        editFields(h, (fields) => [
          ...fields,
          {
            id: "login.totp-code",
            label: "Verification code",
            name: null,
            kind: "otp",
            ...(totp.empty ? { empty: true } : {}),
          },
        ]);
      fake.state.present = undefined;
      expect(await h.hello()).toEqual({ ok: true });
      expect(passkeys).toHaveBeenCalledWith({ origin, connectionId, itemId });
      await vi.waitFor(() => expect(status()).toHaveLength(1));
      expect(status()![0]).toMatchObject({ route: "password", facts, handlers: [] });
      // A sync while the login runs never changes the recorded facts.
      expect(passkeys).toHaveBeenCalledTimes(1);
    });

    it("refuses a login whose bound password is empty as no-route", async () => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, report });
      editFields(h, (fields) =>
        fields.map((field) =>
          field["id"] === "login.password" ? { ...field, empty: true } : field,
        ),
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      // The log names the missing fact, never a value, and why the login does not go on to
      // the passkey: the password is the recipe's first step (ADR 0036).
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refused",
          reason: "no-route",
          detail: "password-empty:no-advance",
        }),
      );
      expect(h.fields).not.toHaveBeenCalled();
      expect(executed()).toEqual([]);
      expect(status() ?? []).toEqual([]);
    });

    it("names a password the account may not fill apart from an empty one", async () => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        {
          connections: [
            {
              connectionId,
              enabled: true,
              selection: { mode: "all", groupIds: [], itemIds: [] },
              excludedItemIds: [],
              excludedFields: [{ itemId, fieldId: "login.password" }],
            },
          ],
        },
        { passkeys: withPasskey, report, username: true },
      );
      // An email-first page: the route binds only the username, so no binding is refused,
      // and the item's password decides whether the route can finish.
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({
          version: 1,
          id: "synthetic-email-first",
          revision: 1,
          origin,
          slots: ["username"],
          steps: [
            {
              kind: "fill",
              path: "/signin",
              fields: [{ slot: "username", target: target("password") }],
            },
            { kind: "click", path: "/signin", target: target("login"), purpose: "advance" },
          ],
          maxSubmissions: 1,
        }),
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "refused", detail: "password-not-allowed" }),
      );
      expect(h.fields).not.toHaveBeenCalled();
      expect(executed()).toEqual([]);
    });

    it("refuses a login whose Linked password field reads an empty password as no-route", async () => {
      const linked = {
        passkeys: withPasskey,
        custom: [{ name: "Secret", kind: "linked" as const, linkedFieldId: "login.password" }],
      };
      const bindings = [
        { ...savedBinding, slots: [{ slot: "password", field: { custom: "Secret" } }] },
      ];
      const h = harness({ bindings }, linked);
      editFields(h, (fields) =>
        fields.map((field) =>
          field["id"] === "login.password" ? { ...field, empty: true } : field,
        ),
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(h.fields).not.toHaveBeenCalled();
      // The same binding starts while the password holds a value.
      fake.state.present = undefined;
      expect(await harness({ bindings }, linked).hello({ documentId: "again" })).toEqual({
        ok: true,
      });
    });
  });

  describe("under a CAPTCHA before a click (ADR 0029, S4)", () => {
    /** The page shows a CAPTCHA, so its document leaves the login button to the person. */
    const captchaOnLogin = () => {
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        fake.state.executeReply =
          step.kind === "click" && step.target?.value === "login"
            ? { ok: false, reason: "captcha" }
            : undefined;
      };
    };

    it("leaves the click to the person and judges the page only once the button is gone", async () => {
      vi.useFakeTimers();
      captchaOnLogin();
      const service = generation(async () => ({ verdict: "signed-in" }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { generation: service, report });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("login") === 1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", submissions: 1 });
      expect(service.judge).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "attempt",
          state: "awaiting-result",
          cause: "captcha-shown",
        }),
      );
      // The person solves the CAPTCHA and presses the button.
      fake.state.executeReply = undefined;
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
      await until(settled("authenticated"));
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(service.judge.mock.calls[0]![3]).toEqual(homePage.observation);
      expect(clicks("login")).toBe(1);
    });

    it("does not take a rejection the page already showed as the person's", async () => {
      vi.useFakeTimers();
      captchaOnLogin();
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, rejection: target("rejected") }),
      );
      // The page shows a failed sign-in's banner next to its CAPTCHA.
      fake.state.present = new Set(["password", "login", "rejected"]);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("login") === 1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      fake.state.executeReply = undefined;
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
      await until(settled("authenticated"));
      expect(clicks("login")).toBe(1);
    });

    it("ends as a challenge when the button still shows after two minutes", async () => {
      vi.useFakeTimers();
      captchaOnLogin();
      const service = generation();
      const h = harness({}, { generation: service });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("login") === 1);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      await until(settled("watching", "challenge"), 10_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(clicks("login")).toBe(1);
    });
  });

  describe("on the page after an effect step", () => {
    it("clicks the security-key button once and signs in through the completion", async () => {
      onClick({ login: toWebauthn, "Use security key": toHome });
      const h = harness({}, { passkeys: withPasskey });
      h.recipes.recipe.mockResolvedValue(handled);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "click"]);
      expect(clicks("Use security key")).toBe(1);
      // The handler joined the attempt after the route's final click, with its own budget.
      expect(status()![0]).toMatchObject({
        handlers: [{ index: 0, start: 2 }],
        stepIndex: 2,
        stepCount: 3,
        submissions: 2,
        maxSubmissions: 2,
      });
      // The handler's element is observed apart from the recipe's own result targets.
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({ type: "login.observe", targets: [securityKey] }),
      );
    }, 10_000);

    it.each([
      ["holds no passkey", vi.fn(async () => ({ passkey: false, discoverable: false }))],
      ["cannot be asked about passkeys", undefined],
    ])("ends as a challenge without a click when the item %s", async (_label, passkeys) => {
      onClick({ login: toWebauthn, "Use security key": toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, passkeys ? { passkeys, report } : { report });
      h.recipes.recipe.mockResolvedValue(handled);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      expect(clicks("Use security key")).toBe(0);
      expect(status()![0]).toMatchObject({ handlers: [] });
      expect(report).toHaveBeenCalledWith({
        type: "handler",
        tabId: 1,
        origin,
        recipeId: handled.id,
        recipeRevision: handled.revision,
        handler: 0,
        kind: "passkey",
        outcome: "missing-fact",
        steps: 1,
      });
    });

    it("leaves a handler page shown again after its handler ran to the person", async () => {
      vi.useFakeTimers();
      const passkeyButton = { by: "text" as const, value: "Use passkey" };
      const twice = parseLoginRecipe({
        ...unlearned,
        handlers: [keyHandler, { kind: "passkey", path: "/login/verify", target: passkeyButton }],
      });
      onClick({
        login: toWebauthn,
        "Use security key": { path: "/login/verify", present: ["Use passkey"] },
        // Back to the first handler's page, as after a failed key.
        "Use passkey": toWebauthn,
      });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(twice);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"));
      expect(clicks("Use security key")).toBe(1);
      expect(clicks("Use passkey")).toBe(1);
      expect(service.judge).not.toHaveBeenCalled();
      expect(
        report.mock.calls.flatMap(([value]) =>
          value.type === "handler" ? [[value.handler, value.outcome]] : [],
        ),
      ).toEqual([
        [0, "entered"],
        [1, "entered"],
        [0, "shown-again"],
      ]);
    });

    it("judges the page only once the clicked button is gone", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toWebauthn });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      // A WebAuthn exchange or a chooser the person answers keeps the button showing.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
      await until(settled("authenticated"));
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(service.judge).toHaveBeenCalledWith(
        plain.id,
        plain.revision,
        "password",
        homePage.observation,
        expect.any(Function),
      );
      expect(clicks("Use security key")).toBe(1);
    });

    it("ends as a challenge when the clicked button still shows after two minutes", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toWebauthn });
      const service = generation();
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      await until(settled("watching", "challenge"), 10_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(clicks("Use security key")).toBe(1);
    });

    it("holds a handler's click across a same-document URL change while its button remains", async () => {
      vi.useFakeTimers();
      // The page moves to another path with pushState and keeps the button in its DOM.
      onClick({
        login: toWebauthn,
        "Use security key": { path: "/login/webauthn/verify", present: ["Use security key"] },
      });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(fake.state.observedPath).toBe("/login/webauthn/verify");
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      // Without a learned completion, the page is never judged while the button remains.
      await until(settled("watching", "challenge"), 10_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(clicks("Use security key")).toBe(1);
    });

    it("leaves a new document that shows the clicked handler's button to the person at once", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toWebauthn });
      const service = generation();
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      // The page reloads after the click and shows the button again.
      fake.state.pageUrl = `${origin}/login/webauthn`;
      await h.hello({ documentId: "reloaded" }, false);
      await until(settled("watching", "challenge"), 5_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(clicks("Use security key")).toBe(1);
    });

    describe("the pages judged after one effect step", () => {
      const page = (path: string, complete = true) => {
        const described = observation(path, [
          { id: "c1", role: "link", target: target("help"), label: "Help" },
        ]);
        return { ...described, observation: { ...described.observation, complete } };
      };
      const judged = () => status()![0]!["judged"] as { pages: number } | undefined;
      /** Pages judged while the settled login is watched (ADR 0027). */
      const watched = () => (status()![0]!["watch"] as { pages: number } | undefined)?.pages;
      /** The login's click leads to `/elsewhere`, which no check explains. */
      async function settledLogin(
        judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" }),
        extracted = page("/elsewhere"),
        report?: (report: LoginReport) => void,
      ) {
        vi.useFakeTimers();
        onClick({ login: { path: "/elsewhere", present: [], extracted } });
        const service = generation(judge);
        const h = harness(
          {},
          { passkeys: withPasskey, generation: service, ...(report ? { report } : {}) },
        );
        h.recipes.recipe.mockResolvedValue(plain);
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("reconciling", "unknown-submit"), 10_000);
        expect(status()![0]).toMatchObject({ settled: true });
        return { h, service };
      }
      /** The tab opens another page of the origin, which settles in turn. */
      async function open(h: ReturnType<typeof harness>, path: string) {
        fake.state.pageUrl = `${origin}${path}`;
        fake.state.observedPath = path;
        fake.state.present = new Set();
        fake.state.extracted = { "signed-in": page(path) };
        await h.hello({ documentId: `document${path.replaceAll("/", "-")}` }, false);
        await vi.advanceTimersByTimeAsync(30_000);
      }

      it("sends two more pages the model saw once the result settled (ADR 0027)", async () => {
        const { h, service } = await settledLogin();
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(judged()).toMatchObject({ pages: 1 });
        expect(watched()).toBe(0);
        await open(h, "/settings");
        await open(h, "/billing");
        expect(service.judge).toHaveBeenCalledTimes(3);
        // The watch's pages are counted apart from the effect step's.
        expect(judged()).toMatchObject({ pages: 1 });
        expect(watched()).toBe(2);
        await open(h, "/account");
        expect(service.judge).toHaveBeenCalledTimes(3);
        expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]);
      });

      it("reports the settled result once while later pages change nothing", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        const { h } = await settledLogin(undefined, undefined, report);
        await open(h, "/settings");
        await open(h, "/billing");
        await open(h, "/account");
        const attempts = report.mock.calls.flatMap(([value]) =>
          value.type === "attempt" ? [value] : [],
        );
        expect(attempts.filter((value) => value.settled)).toHaveLength(1);
        expect(attempts[0]).not.toHaveProperty("repeat");
        // Each new page resumes the attempt; the log repeats it at most quietly.
        expect(attempts.slice(-3)).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", repeat: true },
          { state: "reconciling", outcome: "unknown-submit", repeat: true },
          { state: "reconciling", outcome: "unknown-submit", repeat: true },
        ]);
        // The watch's undecided answers are warnings; its third page is not sent, and the
        // log says why (ADR 0027).
        const judges = report.mock.calls.flatMap(([value]) =>
          value.type === "judge" && value.verdict !== "sent" ? [value] : [],
        );
        expect(judges).toMatchObject([
          { verdict: "unclear" },
          { verdict: "unclear", watched: true },
          { verdict: "unclear", watched: true },
          { verdict: "not-sent", reason: "page-limit", watched: true },
        ]);
        expect(judges[0]).not.toHaveProperty("watched");
      });

      it("no longer holds policy writes once the result settled, also after a restart", async () => {
        const { h } = await settledLogin();
        // The record stays until the tab closes; counting it would hold settings and vault
        // writes past their limits for every later login.
        expect(await h.login.active()).toBe(false);
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          const restarted = harness({}, { passkeys: withPasskey, generation: generation() });
          expect(await restarted.login.active()).toBe(false);
          expect(status()).toMatchObject([{ state: "reconciling", settled: true }]);
        } finally {
          fake.browser.tabs.query = query;
        }
      });

      it("lets a held settings write and vault replacement through once the result settled", async () => {
        const { h } = await settledLogin();
        // The settings half of a full sync, wired to the login as the background wires it.
        const settings = (excludedSites: { hostname: string; includeSubdomains: boolean }[]) => ({
          connections: [],
          excludedSites,
          siteDefaults: [],
          bindings: [],
        });
        const agreed = settings([{ hostname: "intranet.example", includeSubdomains: false }]);
        let local: SettingsSnapshot = { version: 1, revision: 7, settings: agreed };
        const store = createSettingsStore(
          {
            read: async () => structuredClone(local),
            write: async (snapshot) => {
              local = structuredClone(snapshot) as SettingsSnapshot;
            },
          },
          { connections: [] },
        );
        const service = {
          origin: "https://pateat.example.com",
          deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
          credential: `pateat_device_${"C".repeat(43)}`,
          rejected: false,
        };
        const { origin: serviceOrigin, deviceId } = service;
        let since: unknown;
        const settingsSync = createSettingsSync({
          transport: {
            settings: async () => ({
              kind: "state",
              state: { version: 1, revision: 5, settings: settings([]) },
            }),
            saveSettings: vi.fn(),
          },
          settings: store,
          storage: {
            read: async () => ({
              version: 1,
              origin: serviceOrigin,
              deviceId,
              revision: 4,
              settings: agreed,
              local: agreed,
            }),
            write: async () => undefined,
            clear: async () => undefined,
          },
          hold: {
            read: async () => since,
            write: async (value: number) => {
              since = value;
            },
            clear: async () => {
              since = undefined;
            },
          },
          deferred: () => h.login.active(),
        });
        expect(await settingsSync.run(service, () => false)).toBe("synced");
        expect(local.settings.excludedSites).toEqual([]);
        expect(since).toBeUndefined();
        // The vault replacement is not deferred either.
        const outcomes: string[] = [];
        const vault = createVaultAutoSync({
          records: createVaultSyncRecords({ read: async () => undefined, write: async () => {} }),
          connections: async () => ["connection-1"],
          run: async (_id, hold) => {
            const release = await hold.take();
            release?.();
            return release ? "synced" : "deferred";
          },
          loginActive: () => h.login.active(),
          online: () => true,
          report: ({ outcome }) => outcomes.push(outcome),
        });
        vault.refreshIfStale();
        await vault.running();
        expect(outcomes).toEqual(["synced"]);
      });

      it("holds policy writes again while a later page of a settled login is judged", async () => {
        let answer!: (verdict: Awaited<ReturnType<LoginGeneration["judge"]>>) => void;
        const { h, service } = await settledLogin();
        service.judge.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        await open(h, "/settings");
        expect(service.judge).toHaveBeenCalledTimes(2);
        // A takeover after this answer would be stopped by a policy write meanwhile.
        expect(await h.login.active()).toBe(true);
        answer({ verdict: "unclear" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(status()).toMatchObject([{ state: "reconciling", settled: true }]);
        expect(await h.login.active()).toBe(false);
      });

      it("does not count a page it could not describe completely", async () => {
        const { h, service } = await settledLogin(undefined, page("/elsewhere", false));
        expect(service.judge).not.toHaveBeenCalled();
        expect(judged()).toBeUndefined();
        expect(watched()).toBe(0);
        await open(h, "/settings");
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(service.judge.mock.calls[0]![3]).toMatchObject({ path: "/settings" });
        expect(watched()).toBe(1);
      });

      /** The extension's own judge mapping over a service that gives these answers. */
      function serviceAnswering(...reasons: ("busy" | "already-judged" | "recipe-conflict")[]) {
        const judgeCompletion = vi.fn<ServiceTransport["judgeCompletion"]>(async () => {
          const reason = reasons.shift();
          return {
            kind: "result",
            result: reason
              ? { version: 1, status: "unavailable", reason }
              : { version: 1, status: "unclear" },
          };
        });
        const service = createLoginGeneration({
          service: {
            connection: async () => ({
              origin: "https://pateat.example.com",
              deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
              credential: `pateat_device_${"C".repeat(43)}`,
              rejected: false,
            }),
          },
          transport: { generateRecipe: vi.fn(), generateEntry: vi.fn(), judgeCompletion },
          storage: { read: async () => undefined, write: async () => undefined },
          slotStorage: { read: async () => undefined, write: async () => undefined },
          sync: async () => "synced",
          refresh: async () => "synced",
        });
        return (...args: Parameters<LoginGeneration["judge"]>) => service.judge(...args);
      }

      it("gives back a page the service refused while busy", async () => {
        const { h, service } = await settledLogin(serviceAnswering("busy", "busy"));
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(judged()).toMatchObject({ pages: 0 });
        // Also while the settled login is watched (ADR 0027).
        await open(h, "/settings");
        expect(service.judge).toHaveBeenCalledTimes(2);
        expect(service.judge.mock.calls[1]![3]).toMatchObject({ path: "/settings" });
        expect(watched()).toBe(0);
        await open(h, "/billing");
        expect(service.judge).toHaveBeenCalledTimes(3);
        expect(watched()).toBe(1);
      });

      it("spends a page the service refused for good", async () => {
        const { h, service } = await settledLogin(
          serviceAnswering("already-judged", "recipe-conflict", "already-judged"),
        );
        expect(judged()).toMatchObject({ pages: 1 });
        await open(h, "/settings");
        await open(h, "/billing");
        expect(watched()).toBe(2);
        await open(h, "/account");
        expect(service.judge).toHaveBeenCalledTimes(3);
      });

      it("counts a page whose request a worker restart cut off", async () => {
        vi.useFakeTimers();
        onClick({ login: { path: "/elsewhere", present: [], extracted: page("/elsewhere") } });
        const lost = generation(() => new Promise(() => undefined));
        const h = harness({}, { passkeys: withPasskey, generation: lost });
        h.recipes.recipe.mockResolvedValue(plain);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => lost.judge.mock.calls.length === 1, 10_000);
        expect(judged()).toMatchObject({ pages: 1 });
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          const service = generation();
          const restarted = harness({}, { passkeys: withPasskey, generation: service });
          restarted.recipes.recipe.mockResolvedValue(plain);
          await open(restarted, "/settings");
          expect(service.judge).toHaveBeenCalledTimes(1);
          expect(judged()).toMatchObject({ pages: 2 });
          // The page judged next settled the result; the watch judges its own pages.
          await open(restarted, "/billing");
          await open(restarted, "/account");
          await open(restarted, "/help");
          expect(service.judge).toHaveBeenCalledTimes(3);
          expect(judged()).toMatchObject({ pages: 2 });
        } finally {
          fake.browser.tabs.query = query;
        }
      });
    });

    it("judges the page after an advance whose next step never appeared", async () => {
      vi.useFakeTimers();
      const advancing = parseLoginRecipe({
        ...unlearned,
        steps: [
          { kind: "click", path: "/signin", target: target("continue"), purpose: "advance" },
          {
            kind: "fill",
            path: "/next",
            fields: [{ slot: "password", target: target("password") }],
          },
          { kind: "click", path: "/next", target: target("login"), purpose: "submit" },
        ],
        maxSubmissions: 2,
      });
      const elsewhere = observation("/verify", [
        { id: "c1", role: "button", target: target("resend"), label: "Resend email" },
      ]);
      fake.state.present = new Set(["continue"]);
      onClick({ continue: { path: "/verify", present: ["resend"], extracted: elsewhere } });
      const service = generation(async () => ({ verdict: "challenge" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(advancing);
      h.recipes.starts.mockResolvedValue(startsOf([advancing.steps[0]!]));
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"));
      expect(service.judge).toHaveBeenCalledWith(
        advancing.id,
        advancing.revision,
        "password",
        elsewhere.observation,
        expect.any(Function),
      );
      expect(executed()).toHaveLength(1);
    });

    it("logs a handler entered mid-route only for its own steps", async () => {
      vi.useFakeTimers();
      const midway = parseLoginRecipe({
        ...unlearned,
        steps: [
          { kind: "click", path: "/signin", target: target("continue"), purpose: "advance" },
          {
            kind: "fill",
            path: "/next",
            fields: [{ slot: "password", target: target("password") }],
          },
          { kind: "click", path: "/next", target: target("login"), purpose: "submit" },
        ],
        handlers: [{ kind: "passkey", path: "/verify", target: securityKey }],
        maxSubmissions: 2,
      });
      fake.state.present = new Set(["continue"]);
      onClick({
        continue: { path: "/verify", present: ["Use security key"] },
        "Use security key": { path: "/next", present: ["password", "login"] },
        login: toHome,
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(midway);
      h.recipes.starts.mockResolvedValue(startsOf([midway.steps[0]!]));
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 1 }] });
      // The route's steps after the handler's click belong to no handler.
      expect(
        report.mock.calls.flatMap(([value]) =>
          value.type === "attempt" && value.state === "executing"
            ? [[value.stepIndex, value.operation, value.handler]]
            : [],
        ),
      ).toEqual([
        [0, "click", undefined],
        [1, "click", 0],
        [2, "fill", undefined],
        [3, "click", undefined],
      ]);
    });

    it("sends a page without the marker even when the recipe has a completion", async () => {
      vi.useFakeTimers();
      const learned = parseLoginRecipe({ ...unlearned, completion: home });
      const welcome = observation("/welcome", [
        { id: "c1", role: "button", target: target("account"), label: "Account" },
      ]);
      onClick({ login: { path: "/welcome", present: ["account"], extracted: welcome } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(service.judge).toHaveBeenCalledWith(
        learned.id,
        learned.revision,
        "password",
        welcome.observation,
        expect.any(Function),
      );
    });

    it("sends a page whose marker is hidden, as in a closed menu (ADR 0029)", async () => {
      vi.useFakeTimers();
      const learned = parseLoginRecipe({ ...unlearned, completion: home });
      fake.state.unusable = new Set(["logout"]);
      onTestFinished(() => {
        fake.state.unusable = new Set();
      });
      onClick({ login: toHome });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(service.judge).toHaveBeenCalledTimes(1);
    });

    it("does not send a page that shows a marker the completion check cannot count", async () => {
      vi.useFakeTimers();
      const learned = parseLoginRecipe({ ...unlearned, completion: home });
      // The marker shows, but more than once.
      fake.state.ambiguous = new Set(["logout"]);
      onTestFinished(() => {
        fake.state.ambiguous = new Set();
      });
      onClick({ login: { path: "/account", present: ["logout"], extracted: homePage } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "marker-shown" }),
      );
    });
  });

  describe("the first login on a page that gains a handler", () => {
    it("takes the new revision over and clicks the handler with a grown budget", async () => {
      vi.useFakeTimers();
      let atClick: Record<string, unknown> | undefined;
      onClick({ login: toWebauthn, "Use security key": toHome });
      const recordAtClick = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        const step = (message["operation"] as { step: { target?: { value: string } } }).step;
        if (step.target?.value === "Use security key") atClick = structuredClone(status()![0]);
        await recordAtClick(message, tabId);
      };
      const answers = [
        { verdict: "challenge" as const, recipe: taken },
        { verdict: "signed-in" as const },
      ];
      const service = generation(async () => answers.shift() ?? { verdict: "unclear" });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      // The handler ran only once the attempt recorded the revision it belongs to.
      expect(atClick).toMatchObject({
        state: "submit-intent",
        recipeRevision: 2,
        handlers: [{ index: 0, start: 2 }],
        stepIndex: 2,
        stepCount: 3,
        submissions: 2,
        maxSubmissions: 2,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [plain.id, 1, "password", webauthnPage.observation],
        // The page after the handler is judged for the new revision.
        [plain.id, 2, "password", homePage.observation],
      ]);
      // The log shows each judgement, the takeover and the handler's click, in order.
      const reports = report.mock.calls.map(([value]) => value);
      expect(
        reports.flatMap((value) =>
          value.type === "judge"
            ? [`judge ${value.recipeRevision} ${value.verdict} ${value.takenOver ?? "-"}`]
            : value.type === "handler"
              ? [`handler ${value.handler} ${value.outcome}`]
              : value.type === "attempt" && value.handler !== undefined
                ? [`attempt ${value.state} ${value.operation ?? "-"} ${value.effect ?? "-"}`]
                : [],
        ),
      ).toEqual([
        "judge 1 sent -",
        "judge 1 challenge true",
        "handler 0 entered",
        "attempt ready - -",
        "attempt executing click submit",
        "attempt submit-intent click submit",
        "attempt awaiting-result click submit",
        "judge 2 sent -",
        "judge 2 signed-in -",
        "attempt authenticated click submit",
      ]);
    });

    it("pulls only recipes after the takeover, so a settings change does not stop the login", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toHome });
      const connection = {
        origin: "https://pateat.example.com",
        deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
        credential: `pateat_device_${"C".repeat(43)}`,
        rejected: false,
      };
      const change = { recipeId: taken.id, revision: 2, state: "active" as const, recipe: taken };
      let h: ReturnType<typeof harness> | undefined;
      // The settings half of a full sync applies a synced change, as the background wires it.
      const settings = {
        run: vi.fn(async () => {
          h!.login.settingsChanged("synced");
          return "synced" as const;
        }),
        clear: vi.fn(async () => undefined),
      };
      const recipeSync = createRecipeSync({
        service: { connection: async () => connection, recordSync: async () => undefined },
        transport: {
          recipeChanges: async () => ({
            kind: "page",
            page: { version: 1, changes: [change], cursor: 1, complete: true },
          }),
        },
        storage: {
          read: async () => undefined,
          write: async () => undefined,
          clear: async () => undefined,
        },
        schedule: { read: async () => undefined, write: async () => undefined },
        settings,
      });
      const judgeCompletion = vi
        .fn<ServiceTransport["judgeCompletion"]>()
        .mockResolvedValueOnce({
          kind: "result",
          result: { version: 1, status: "challenge", change },
        })
        .mockResolvedValueOnce({ kind: "result", result: { version: 1, status: "signed-in" } });
      const refresh = vi.fn(() => recipeSync.sync({ settings: false }));
      const sync = vi.fn(() => recipeSync.sync());
      const service = createLoginGeneration({
        service: { connection: async () => connection },
        transport: { generateRecipe: vi.fn(), generateEntry: vi.fn(), judgeCompletion },
        storage: { read: async () => undefined, write: async () => undefined },
        slotStorage: { read: async () => undefined, write: async () => undefined },
        sync,
        refresh,
      });
      h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => settled("authenticated")() || settled("blocked")());
      // A full sync here ended the login as blocked/policy-changed in the owner's Chrome.
      expect(status()![0]).toMatchObject({ state: "authenticated" });
      expect(clicks("Use security key")).toBe(1);
      expect(
        judgeCompletion.mock.calls.map((call) => [call[3].revision, call[3].observation]),
      ).toEqual([
        [1, webauthnPage.observation],
        [2, homePage.observation],
      ]);
      expect(refresh).toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(settings.run).not.toHaveBeenCalled();
    });

    it.each([
      ["changes the route's steps", { ...taken, maxSubmissions: 2 }],
      ["is another recipe", { ...taken, id: "another-recipe" }],
      ["is not newer", { ...taken, revision: 1 }],
    ])("ends as a challenge without a click when the revision %s", async (_label, next) => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toHome });
      const service = generation(async () => ({
        verdict: "challenge",
        recipe: parseLoginRecipe(next),
      }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"));
      expect(clicks("Use security key")).toBe(0);
      expect(status()![0]).toMatchObject({ recipeRevision: 1, handlers: [] });
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "challenge", takenOver: false }),
      );
      expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "handler" }));
    });

    it.each([
      ["the taken-over revision", taken, { ok: true }, 2],
      ["a cache that still holds the older revision", plain, { ok: true }, 2],
      [
        "a newer revision that only adds a completion",
        parseLoginRecipe({ ...taken, revision: 3, completion: home }),
        { ok: true },
        3,
      ],
      [
        "a newer revision that changes the route",
        parseLoginRecipe({ ...taken, revision: 3, maxSubmissions: 2 }),
        { ok: false, reason: "recipe-not-found" },
        2,
      ],
    ] as const)(
      "after navigation, resumes with %s",
      async (_label, cached, expected, recipeRevision) => {
        vi.useFakeTimers();
        // The handler's click never answers, so the attempt is running when the page changes.
        onClick({ login: toWebauthn, "Use security key": "hang" });
        const service = generation(async () => ({ verdict: "challenge", recipe: taken }));
        const h = harness({}, { passkeys: withPasskey, generation: service });
        h.recipes.recipe.mockResolvedValue(plain);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks("Use security key") === 1);
        h.recipes.recipe.mockResolvedValue(cached);
        expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual(expected);
        expect(status()![0]).toMatchObject({ recipeRevision, handlers: [{ index: 0, start: 2 }] });
      },
    );
  });

  describe("the totp handler", () => {
    const codeHandler = {
      kind: "totp" as const,
      path: "/two-factor",
      field: target("app-code"),
      target: target("verify"),
    };
    const coded = parseLoginRecipe({ ...unlearned, completion: home, handlers: [codeHandler] });
    const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    /** Adds the item's built-in TOTP field, as the catalog lists it. */
    const withTotp = (h: ReturnType<typeof harness>, empty = false) =>
      editFields(h, (fields) => [
        ...fields,
        {
          id: "login.totp-code",
          label: "Verification code",
          name: null,
          kind: "otp",
          ...(empty ? { empty: true } : {}),
        },
      ]);
    /** A synthetic code for the TOTP field and a synthetic secret for every other one. */
    const codes = (h: ReturnType<typeof harness>) =>
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
    const codeFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
      );
    /** Runs `then` when the code is filled, as the page reacts to it. */
    const onCodeFill = (then: () => void | Promise<void>) => {
      const clicked = fake.state.onExecute;
      fake.state.onExecute = async (message, tabId) => {
        fake.state.executeReply = undefined;
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "fill" && step.fields.some((field) => field.slot === "totp"))
          await then();
        await clicked?.(message, tabId);
      };
    };
    const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome, value.steps]] : [],
      );

    it("fills the item's TOTP code into the code field and clicks its button once", async () => {
      onClick({ login: toCode, verify: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "fill", "click"]);
      expect(clicks("verify")).toBe(1);
      // The code fills only a code input, and is read from the built-in field.
      expect(codeFills().map((entry) => entry.values)).toEqual([
        [{ slot: "totp", value: "012345", secret: "otp" }],
      ]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
        "login.password",
        "login.totp-code",
      ]);
      expect(status()![0]).toMatchObject({
        facts: { totp: true },
        handlers: [{ index: 0, start: 2 }],
        stepCount: 4,
        submissions: 2,
        maxSubmissions: 2,
      });
      // Both of its elements are observed before it is entered.
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.observe",
          targets: [target("app-code"), target("verify")],
        }),
      );
      expect(handlerReports(report)).toEqual([[0, "totp", "entered", 2]]);
      // The binding saved after the login names the route's slots only.
      expect(h.store.update).not.toHaveBeenCalled();
    }, 10_000);

    describe("when the tab moves to another site after the code (ADR 0022)", () => {
      const other = "https://portal.example";
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      const portalHome = {
        ok: true,
        observation: {
          version: 1,
          origin: other,
          path: "/home",
          language: "en",
          complete: true,
          candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
        },
      };
      /** The page leaves on `leaveOn`'s click; the item has a username and a TOTP code. */
      const leaving = (leaveOn: "login" | "verify", judge?: LoginGeneration["judge"]) => {
        onClick(leaveOn === "login" ? { login: "hang" } : { login: toCode, verify: "hang" });
        const report = vi.fn<(report: LoginReport) => void>();
        const live = judge ? { generation: generation(judge) } : {};
        const h = harness({}, { passkeys: noPasskey, report, username: true, ...live });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        return { h, report, live };
      };
      const move = (h: ReturnType<typeof harness>) => {
        fake.state.tabUrls[1] = `${other}/home`;
        return h.hello({ documentId: "portal-document", url: `${other}/home` }, false);
      };

      it("completes when the other site's page shows the account's username", async () => {
        const { h } = leaving("verify");
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1), { timeout: 6_000 });
        fake.state.signs = { ...quiet, username: true };
        await move(h);
        expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
        // Nothing is filled or clicked on the other site's page.
        expect(executed()).toHaveLength(4);
      }, 10_000);

      it("completes when the judge answers signed-in for the other site's page", async () => {
        const { h, live } = leaving("verify", async () => ({ verdict: "signed-in" }));
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1), { timeout: 6_000 });
        fake.state.signs = quiet;
        fake.state.extracted = { "signed-in": portalHome };
        await move(h);
        expect(status()).toMatchObject([{ state: "authenticated" }]);
        expect(live.generation!.judge).toHaveBeenCalledTimes(1);
        expect(live.generation!.judge.mock.calls[0]![3]).toEqual(portalHome.observation);
      }, 15_000);

      it("judges the page at the path it shows after changing its own URL", async () => {
        // A signed-in single-page app moves on from the URL it announced (history.pushState).
        const { h, live } = leaving("verify", async () => ({ verdict: "signed-in" }));
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1), { timeout: 6_000 });
        fake.state.signs = quiet;
        const chat = { ...portalHome, observation: { ...portalHome.observation, path: "/chat/" } };
        fake.state.extracted = { "signed-in": chat };
        await move(h);
        expect(status()).toMatchObject([{ state: "authenticated" }]);
        expect(live.generation!.judge.mock.calls[0]![3]).toEqual(chat.observation);
      }, 15_000);

      it("ends left-origin when the judge cannot decide", async () => {
        const { h, report } = leaving("verify", async () => ({ verdict: "unclear" }));
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1), { timeout: 6_000 });
        fake.state.signs = quiet;
        fake.state.extracted = { "signed-in": portalHome };
        await move(h);
        expect(status()).toMatchObject([{ state: "blocked", outcome: "left-origin" }]);
        expect(
          report.mock.calls.flatMap(([entry]) => (entry.type === "judge" ? [entry] : [])).at(-1),
        ).toMatchObject({ verdict: "unclear", origin: other, moved: true });
      }, 15_000);

      it("ends left-origin when the move comes right after the password, before any code", async () => {
        const { h } = leaving("login");
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("login")).toBe(1));
        fake.state.signs = { ...quiet, username: true };
        await move(h);
        expect(status()).toMatchObject([{ state: "blocked", outcome: "left-origin" }]);
        expect(fake.state.messages.filter((entry) => entry.type === "login.state")).toEqual([]);
      });

      it("ends left-origin when the move comes more than 30 seconds after the code", async () => {
        const { h } = leaving("verify");
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1), { timeout: 6_000 });
        fake.state.signs = { ...quiet, username: true };
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
        onTestFinished(() => clock.mockRestore());
        await move(h);
        expect(status()).toMatchObject([{ state: "blocked", outcome: "left-origin" }]);
      }, 10_000);

      it("completes on a marker learned on the other site, without the judge", async () => {
        const { h, live } = leaving("verify", async () => ({ verdict: "unclear" }));
        h.recipes.recipe.mockResolvedValue(
          parseLoginRecipe({
            ...coded,
            completion: [...home, { target: target("account"), origin: other }],
          }),
        );
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1), { timeout: 6_000 });
        fake.state.signs = quiet;
        fake.state.present = new Set(["account"]);
        await move(h);
        expect(status()).toMatchObject([{ state: "authenticated" }]);
        expect(live.generation!.judge).not.toHaveBeenCalled();
        expect(
          fake.state.messages.filter((entry) => entry.type === "login.observe").at(-1),
        ).toMatchObject({ targets: [target("account")] });
      }, 15_000);

      it("completes after a route step's code, as after a handler's", async () => {
        const routeCoded = parseLoginRecipe({
          ...unlearned,
          completion: home,
          slots: [...unlearned.slots, "totp"],
          steps: [
            ...unlearned.steps,
            {
              kind: "fill",
              path: "/two-factor",
              fields: [{ slot: "totp", target: target("app-code") }],
            },
            { kind: "click", path: "/two-factor", target: target("verify"), purpose: "submit" },
          ],
          maxSubmissions: 2,
        });
        onClick({ login: toCode, verify: "hang" });
        const bindings = [
          {
            ...savedBinding,
            slots: [
              { slot: "password", field: "password" as const },
              { slot: "totp", field: "totp" as const },
            ],
          },
        ];
        const h = harness({ bindings }, { passkeys: noPasskey, username: true });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(routeCoded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1), { timeout: 6_000 });
        fake.state.signs = { ...quiet, username: true };
        await move(h);
        expect(status()).toMatchObject([{ state: "authenticated" }]);
      }, 10_000);

      it("completes after the page submitted the code by itself", async () => {
        const { h } = leaving("verify");
        let filled = false;
        onCodeFill(() => {
          filled = true;
          // The page submits the code itself and its tab leaves; the click never runs.
          return new Promise<void>(() => undefined);
        });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(filled).toBe(true), { timeout: 6_000 });
        fake.state.signs = { ...quiet, username: true };
        await move(h);
        expect(status()).toMatchObject([{ state: "authenticated" }]);
        expect(clicks("verify")).toBe(0);
      }, 10_000);
    });

    it("never types a custom field a saved binding names for the code", async () => {
      onClick({ login: toCode, verify: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const bindings = [
        {
          ...savedBinding,
          slots: [
            { slot: "password", field: "password" as const },
            { slot: "totp", field: { custom: "Branch" } },
          ],
        },
      ];
      const h = harness({ bindings }, { passkeys: noPasskey, report });
      withTotp(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      expect(codeFills()).toEqual([]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.password"]);
      expect(handlerReports(report)).toEqual([[0, "totp", "missing-fact", 2]]);
    });

    it.each([
      ["field", ["app-code"]],
      ["button", ["verify"]],
    ])(
      "is not entered while only its %s shows",
      async (_label, present) => {
        onClick({ login: { path: "/two-factor", present } });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(codeFills()).toEqual([]);
        expect(handlerReports(report)).toEqual([]);
      },
      10_000,
    );

    it("is not entered while its field is hidden or disabled", async () => {
      onClick({ login: toCode });
      fake.state.unusable = new Set(["app-code"]);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.observe",
          targets: [target("app-code"), target("verify")],
          require: ["writable", "shown"],
        }),
      );
      expect(codeFills()).toEqual([]);
      expect(handlerReports(report)).toEqual([]);
    }, 10_000);

    it("enters a passkey handler before a totp handler shown with it", async () => {
      const key = { kind: "passkey" as const, path: "/two-factor", target: securityKey };
      // The recipe lists the code first; the passkey still goes first.
      const both = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [codeHandler, key],
      });
      const shown = { path: "/two-factor", present: ["app-code", "verify", "Use security key"] };
      onClick({ login: shown, "Use security key": toHome, verify: toHome });
      const h = harness({}, { passkeys: withPasskey });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(both);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(codeFills()).toEqual([]);
      // An item without a passkey takes the code instead.
      fake.state.messages = [];
      for (const listener of fake.state.removed.splice(0)) listener(1);
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      const coded2 = harness({}, { passkeys: noPasskey });
      withTotp(coded2);
      codes(coded2);
      coded2.recipes.recipe.mockResolvedValue(both);
      expect(await coded2.hello({ documentId: "second" })).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(clicks("Use security key")).toBe(0);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
    }, 15_000);

    it("presses a passkey handler shown instead of the route's own code step on its path", async () => {
      // The route fills a code on the page after the password; another account gets a
      // security-key page there, learned as a `passkey` handler. The code step still to run
      // fills no password, so it does not keep the handler out (ADR 0036).
      const key = { kind: "passkey" as const, path: "/two-factor", target: securityKey };
      const routeCodedKey = parseLoginRecipe({
        ...unlearned,
        completion: home,
        slots: [...unlearned.slots, "totp"],
        steps: [
          ...unlearned.steps,
          {
            kind: "fill",
            path: "/two-factor",
            fields: [{ slot: "totp", target: target("app-code") }],
          },
          { kind: "click", path: "/two-factor", target: target("verify"), purpose: "submit" },
        ],
        handlers: [key],
        maxSubmissions: 2,
      });
      onClick({
        login: { path: "/two-factor", present: ["Use security key"] },
        "Use security key": toHome,
      });
      const bindings = [
        {
          ...savedBinding,
          slots: [
            { slot: "password", field: "password" as const },
            { slot: "totp", field: "totp" as const },
          ],
        },
      ];
      const h = harness({ bindings }, { passkeys: withPasskey, username: true });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(routeCodedKey);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(codeFills()).toEqual([]);
      expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 2 }] });
    }, 10_000);

    it("types one code per login and leaves a second code page to the person", async () => {
      const again = {
        kind: "totp" as const,
        path: "/two-factor/again",
        field: target("app-code"),
        target: target("confirm"),
      };
      const twice = parseLoginRecipe({ ...unlearned, handlers: [codeHandler, again] });
      onClick({
        login: toCode,
        verify: { path: "/two-factor/again", present: ["app-code", "confirm"] },
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(twice);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        { timeout: 6_000 },
      );
      expect(codeFills()).toHaveLength(1);
      expect(clicks("confirm")).toBe(0);
      expect(handlerReports(report)).toEqual([
        [0, "totp", "entered", 2],
        [1, "totp", "code-used", 2],
      ]);
    }, 10_000);

    it.each([
      ["", false],
      [" with its field disabled", true],
    ])(
      "leaves the code page shown again in a new document%s to the person",
      async (_label, unusable) => {
        vi.useFakeTimers();
        onClick({ login: toCode, verify: toCode });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks("verify") === 1);
        // A wrong code: the page loads the code form again. A handler that ran counts as
        // shown again whatever state its elements are in.
        if (unusable) fake.state.unusable = new Set(["app-code", "verify"]);
        fake.state.pageUrl = `${origin}/two-factor`;
        await h.hello({ documentId: "again" }, false);
        await until(settled("watching", "challenge"), 5_000);
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(1);
        expect(handlerReports(report)).toEqual([
          [0, "totp", "entered", 2],
          [0, "totp", "shown-again", 2],
        ]);
      },
    );

    describe("a route's code page that submits by itself", () => {
      // A page opened on the code step, as a pending sign-in's second factor is: its
      // recipe's route fills only the `totp` slot, then clicks the button.
      const routeCode = parseLoginRecipe({
        version: 1,
        id: "synthetic-code",
        revision: 1,
        origin,
        slots: ["totp"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "totp", target: target("app-code") }],
          },
          { kind: "click", path: "/signin", target: target("verify"), purpose: "submit" },
        ],
        completion: home,
        maxSubmissions: 1,
      });
      const onCodePage = () => {
        fake.state.present = new Set(["app-code", "verify"]);
        fake.state.observed = ["unique", "unique"];
      };

      it("settles a page that moved on after the code fill without a click", async () => {
        onCodePage();
        onCodeFill(() => {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        });
        const h = harness({}, { passkeys: noPasskey });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(routeCode);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 1 });
      }, 10_000);

      it("settles the new document the code fill led to, never looking for the button", async () => {
        onCodePage();
        onCodeFill(() => {
          // The page submits on the last digit and navigates during the fill.
          fake.state.gone.add("synthetic-document");
          throw new Error("Could not establish connection. Receiving end does not exist.");
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(routeCode);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(codeFills()).toHaveLength(1));
        fake.state.pageUrl = `${origin}/home`;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        expect(await h.hello({ documentId: "signed-in" }, false)).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 1 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(
          report.mock.calls.some(
            ([value]) => value.type === "attempt" && value.outcome === "retry-limit",
          ),
        ).toBe(false);
      }, 10_000);
    });

    describe("a code page that submits by itself", () => {
      it("settles a form replaced by the code fill without a click", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The page posts the code and replaces its form, as the content script reports.
          fake.state.executeReply = {
            ok: false,
            reason: "structural-mismatch",
            mutation: "possible",
          };
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        });
        const h = harness({}, { passkeys: noPasskey });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        // The page's own submission took the click's place in the budget.
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2, maxSubmissions: 2 });
      }, 10_000);

      it("holds a page that reports its own submission while the button still shows", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The content script saw the page submit the code; the form now says "Verifying".
          fake.state.executeReply = { ok: false, reason: "submitted", mutation: "possible" };
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(codeFills()).toHaveLength(1), { timeout: 6_000 });
        // The fill named the button, so the page's own submission is watched for.
        expect(codeFills()[0]).toMatchObject({ code: { submit: target("verify") } });
        await new Promise((done) => setTimeout(done, 1_500));
        expect(status()).toMatchObject([{ state: "reconciling", stepIndex: 3 }]);
        expect(handlerReports(report)).toEqual([[0, "totp", "entered", 2]]);
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(clicks("verify")).toBe(0);
      }, 15_000);

      it("settles a page that moved to another path before the click", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        });
        const h = harness({}, { passkeys: noPasskey });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("settles the new document the code fill led to, never filling it again", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The page navigates during the fill, so the document never answers.
          fake.state.gone.add("synthetic-document");
          throw new Error("Could not establish connection. Receiving end does not exist.");
        });
        const service = generation(async () => ({ verdict: "signed-in" }));
        const h = harness({}, { passkeys: noPasskey, generation: service });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(codeFills()).toHaveLength(1));
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", stepIndex: 2 }]),
        );
        fake.state.pageUrl = `${origin}/home`;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        expect(await h.hello({ documentId: "signed-in" }, false)).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);

      it("ends as a challenge when the new document shows the code page again", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          fake.state.gone.add("synthetic-document");
          throw new Error("Could not establish connection. Receiving end does not exist.");
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", stepIndex: 2 }]),
        );
        fake.state.pageUrl = `${origin}/two-factor`;
        expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(handlerReports(report)).toEqual([
          [0, "totp", "entered", 2],
          [0, "totp", "shown-again", 2],
        ]);
      });
    });
  });

  describe("the totp handler, probed independently", () => {
    const CODE = "012345";
    const codeHandler = {
      kind: "totp" as const,
      path: "/two-factor",
      field: target("app-code"),
      target: target("verify"),
    };
    const coded = parseLoginRecipe({ ...unlearned, completion: home, handlers: [codeHandler] });
    const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
    const noPasskey = () => vi.fn(async () => ({ passkey: false, discoverable: false }));
    const totpField = (empty = false) => ({
      id: "login.totp-code",
      label: "Verification code",
      name: null,
      kind: "otp",
      ...(empty ? { empty: true } : {}),
    });
    const withTotp = (h: ReturnType<typeof harness>, empty = false) =>
      editFields(h, (fields) => [...fields, totpField(empty)]);
    /** Synthetic values only: a fixed code, a username and a secret. */
    const values = (h: ReturnType<typeof harness>) =>
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code"
          ? CODE
          : fieldId === "login.username"
            ? "synthetic-user"
            : "synthetic-secret",
      );
    const reads = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.map(([request]) => request.fieldId);
    const codeFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
      );
    const handlerOutcomes = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome]] : [],
      );
    /** Runs `then` when the code is filled, as the page reacts to it. */
    const onCodeFill = (then: () => unknown) => {
      const clicked = fake.state.onExecute;
      fake.state.onExecute = async (message, tabId) => {
        fake.state.executeReply = undefined;
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "fill" && step.fields.some((field) => field.slot === "totp"))
          await then();
        await clicked?.(message, tabId);
      };
    };
    function start(
      used: LoginRecipe,
      live: Parameters<typeof harness>[1] = {},
      overrides: Partial<LocalSettings> = {},
      totp: "set" | "empty" | "none" = "set",
    ) {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(overrides, { passkeys: noPasskey(), report, ...live });
      if (totp !== "none") withTotp(h, totp === "empty");
      values(h);
      h.recipes.recipe.mockResolvedValue(used);
      return { h, report };
    }
    /** Runs the other runtime of a worker restart on the same storage. */
    async function restarted<T>(run: () => Promise<T>): Promise<T> {
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        return await run();
      } finally {
        fake.browser.tabs.query = query;
      }
    }

    it.each([
      ["has no TOTP field", "none"],
      ["has an empty TOTP field", "empty"],
    ] as const)("reads nothing for the code when the item %s", async (_label, totp) => {
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(coded, {}, {}, totp);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      expect(status()![0]).toMatchObject({ facts: { totp: false }, handlers: [] });
      expect(reads(h)).toEqual(["login.password"]);
      expect(codeFills()).toEqual([]);
      expect(clicks("verify")).toBe(0);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "missing-fact"]]);
    });

    it("stops as a policy change without reading the code when its field is excluded after entry", async () => {
      onClick({ login: toCode, verify: toHome });
      let h!: ReturnType<typeof harness>;
      const report = vi.fn<(report: LoginReport) => void>((value) => {
        // The owner excludes the TOTP field once the handler joined the login.
        if (value.type === "handler" && value.outcome === "entered")
          h.settings.settings.connections[0]!.excludedFields = [
            { itemId, fieldId: "login.totp-code" },
          ];
      });
      h = harness({}, { passkeys: noPasskey(), report });
      withTotp(h);
      values(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
      );
      expect(report.mock.calls.at(-1)![0]).toMatchObject({
        type: "attempt",
        cause: "plan",
        reason: "binding-field-excluded",
      });
      expect(reads(h)).toEqual(["login.password"]);
      expect(codeFills()).toEqual([]);
      expect(clicks("verify")).toBe(0);
    });

    it("passes the handler over without reading when its field is excluded before entry", async () => {
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(coded);
      // Excluded after the login started, before the code page shows.
      const original = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          h.settings.settings.connections[0]!.excludedFields = [
            { itemId, fieldId: "login.totp-code" },
          ];
        await original(message, tabId);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      expect(status()![0]).toMatchObject({ facts: { totp: true }, handlers: [] });
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "missing-fact"]]);
      expect(reads(h)).toEqual(["login.password"]);
      expect(codeFills()).toEqual([]);
    });

    it("sends the code as an OTP secret with the item's username for the account check", async () => {
      onClick({ login: toCode, verify: toHome });
      const { h } = start(coded, { username: true });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(codeFills()).toHaveLength(1);
      expect(codeFills()[0]).toMatchObject({
        values: [{ slot: "totp", value: CODE, secret: "otp" }],
        account: { username: "synthetic-user" },
      });
    }, 10_000);

    it("ends as wrong-account without a click when the code page shows another account", async () => {
      onClick({ login: toCode, verify: toHome });
      onCodeFill(() => {
        fake.state.executeReply = { ok: false, reason: "wrong-account" };
      });
      const { h } = start(coded, { username: true });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "wrong-account" }]),
      );
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(0);
    });

    it("leaves a code page that keeps its form in the same document to the person after two minutes", async () => {
      vi.useFakeTimers();
      // A wrong code: the page shows its error beside the same form, without a new document.
      onClick({ login: toCode, verify: toCode });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const { h, report } = start(coded, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("verify") === 1);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      await until(settled("watching", "challenge"), 30_000);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(service.judge).not.toHaveBeenCalled();
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
    });

    it("never types a second code after a code the start page's route filled", async () => {
      const withCode = parseLoginRecipe({
        ...unlearned,
        completion: home,
        slots: ["password", "totp"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "password", target: target("password") },
              { slot: "totp", target: target("start-code") },
            ],
          },
          recipe.steps[1]!,
        ],
        handlers: [codeHandler],
      });
      const bindings = [
        {
          ...savedBinding,
          recipeId: withCode.id,
          slots: [
            { slot: "password", field: "password" as const },
            { slot: "totp", field: "totp" as const },
          ],
        },
      ];
      fake.state.present = new Set(["password", "start-code", "login"]);
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(withCode, {}, { bindings });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      // One code, typed by the route on the start page.
      expect(codeFills()).toHaveLength(1);
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
      expect(clicks("verify")).toBe(0);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "code-used"]]);
      expect(reads(h).filter((fieldId) => fieldId === "login.totp-code")).toHaveLength(1);
    });

    it("waits out a passkey click on a page with both handlers and never types the code there", async () => {
      vi.useFakeTimers();
      const key = { kind: "passkey" as const, path: "/two-factor", target: securityKey };
      const both = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [codeHandler, key],
      });
      const shown = { path: "/two-factor", present: ["app-code", "verify", securityKey.value] };
      // The security key is cancelled: the same document keeps both forms.
      onClick({ login: shown, [securityKey.value]: shown });
      const { h, report } = start(both, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(securityKey.value) === 1);
      await until(settled("watching", "challenge"), 200_000);
      expect(codeFills()).toEqual([]);
      expect(clicks("verify")).toBe(0);
      expect(handlerOutcomes(report)).toEqual([[1, "passkey", "entered"]]);
    });

    it("falls back to the code when a new document shows both handlers after the passkey ran", async () => {
      vi.useFakeTimers();
      const key = { kind: "passkey" as const, path: "/two-factor", target: securityKey };
      const both = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [key, codeHandler],
      });
      const shown = { path: "/two-factor", present: ["app-code", "verify", securityKey.value] };
      onClick({ login: shown, [securityKey.value]: shown, verify: toHome });
      const { h, report } = start(both, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(securityKey.value) === 1);
      // The page reloads after the key and offers both again.
      fake.state.pageUrl = `${origin}/two-factor`;
      await h.hello({ documentId: "reloaded" }, false);
      await until(() => settled("authenticated")() || settled("blocked")(), 20_000);
      // As ADR 0027 states: the passkey is passed over as shown again, the code is not.
      expect(handlerOutcomes(report)).toEqual([
        [0, "passkey", "entered"],
        [1, "totp", "entered"],
      ]);
      expect(codeFills()).toHaveLength(1);
      expect(clicks(securityKey.value)).toBe(1);
      expect(clicks("verify")).toBe(1);
      expect(status()![0]).toMatchObject({ state: "authenticated", submissions: 3 });
    });

    it("takes over a revision that adds a totp handler and types the code once", async () => {
      vi.useFakeTimers();
      const codePage = observation("/two-factor", [
        {
          id: "c1",
          role: "text",
          target: target("app-code"),
          label: "Code",
          inputMode: "numeric",
          maxLength: 6,
        },
        { id: "c2", role: "button", target: target("verify"), label: "Verify" },
      ]);
      onClick({ login: { ...toCode, extracted: codePage }, verify: toHome });
      const next = parseLoginRecipe({ ...unlearned, revision: 2, handlers: [codeHandler] });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: next })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const { h, report } = start(plain, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        handlers: [{ index: 0, start: 2 }],
        stepCount: 4,
        submissions: 2,
        maxSubmissions: 2,
      });
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(service.judge.mock.calls.map((call) => [call[1], call[3]])).toEqual([
        [1, codePage.observation],
        [2, homePage.observation],
      ]);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
    });

    describe("a code page that submits by itself", () => {
      it("settles a completion shown on the code page's own path without a click", async () => {
        const samePath = parseLoginRecipe({
          ...unlearned,
          completion: [{ target: target("logout") }],
          handlers: [codeHandler],
        });
        onClick({ login: toCode });
        onCodeFill(() => {
          fake.state.present = new Set(["logout"]);
        });
        const { h } = start(samePath);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
      }, 10_000);

      it("settles a rejection shown in place of the form as a rejected credential", async () => {
        const rejecting = parseLoginRecipe({
          ...coded,
          rejection: target("rejected"),
        });
        onClick({ login: toCode });
        onCodeFill(() => {
          fake.state.present = new Set(["rejected"]);
        });
        const { h } = start(rejecting);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
        );
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      });

      it("settles a page that leaves the path while the click waits for its button", async () => {
        onClick({ login: toCode });
        onCodeFill(() => {
          // The page shows a spinner in place of the form and moves on during the wait.
          fake.state.present = new Set(["app-code"]);
          fake.state.awaited = { ok: false, reason: "timeout" };
          fake.state.onAwait = () => {
            fake.state.observedPath = "/home";
            fake.state.present = new Set(["logout"]);
          };
        });
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("never fills the code again when the button never returns on the same path", async () => {
        onClick({ login: toCode });
        onCodeFill(() => {
          fake.state.present = new Set(["app-code"]);
          fake.state.awaited = { ok: false, reason: "timeout" };
        });
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        // The click step failed for want of its button; a late click could submit an
        // expired code, so the login ends without a retry.
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([
              {
                state: "blocked",
                stepIndex: 3,
                submissions: 1,
                retries: 0,
                outcome: "retry-limit",
              },
            ]),
          { timeout: 6_000 },
        );
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("never clicks the code's button when it returns only after the wait failed", async () => {
        onClick({ login: toCode, verify: toHome });
        let waits = 0;
        onCodeFill(() => {
          fake.state.present = new Set(["app-code"]);
          fake.state.awaited = { ok: false, reason: "timeout" };
          fake.state.onAwait = () => {
            waits += 1;
            if (waits > 1) fake.state.awaited = { ok: true };
          };
        });
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "blocked", outcome: "retry-limit" }]),
          { timeout: 6_000 },
        );
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("does not treat the route's own fill whose form went away as a submission", async () => {
        // The password page replaces its form after the fill; only a code fill counts.
        fake.state.onExecute = async (message) => {
          const step = (message["operation"] as { step: LoginStep }).step;
          if (step.kind !== "fill") return;
          fake.state.executeReply = {
            ok: false,
            reason: "structural-mismatch",
            mutation: "possible",
          };
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        };
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()![0]!["state"]).not.toMatch(/^(ready|executing)$/u));
        await new Promise((resolve) => setTimeout(resolve, 200));
        // The route's click was never counted as done by the page.
        expect(status()![0]).toMatchObject({ stepIndex: 0, submissions: 0 });
        expect(clicks("login")).toBe(0);
      });
    });

    describe("a worker restart", () => {
      it("never fills the code again when the worker restarts during the code fill", async () => {
        onClick({ login: toCode, verify: toHome });
        // The code fill never answers; the worker stops meanwhile.
        onCodeFill(() => new Promise<void>(() => undefined));
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(codeFills()).toHaveLength(1));
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "executing" }]));
        fake.state.onExecute = undefined;
        await restarted(async () => {
          const again = start(coded);
          // The same document announces itself to the new worker.
          await again.h.hello({}, false);
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(again.h.fields).not.toHaveBeenCalled();
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      });

      it("takes a new document after a restart during the code fill as the page's submission", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => new Promise<void>(() => undefined));
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "executing" }]));
        fake.state.onExecute = undefined;
        fake.state.pageUrl = `${origin}/home`;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        await restarted(async () => {
          const again = start(coded);
          expect(await again.h.hello({ documentId: "signed-in" }, false)).toEqual({ ok: true });
          await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
          expect(again.h.fields).not.toHaveBeenCalled();
        });
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      });

      it("leaves the code page to the person after a restart during the verify click", async () => {
        onClick({ login: toCode, verify: "hang" });
        const { h, report } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1));
        fake.state.onExecute = undefined;
        await restarted(async () => {
          const again = start(coded);
          await again.h.hello({}, false);
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          );
          expect(again.h.fields).not.toHaveBeenCalled();
          expect(handlerOutcomes(again.report)).toEqual([[0, "totp", "shown-again"]]);
        });
        expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(1);
      });
    });

    it("keeps the code out of reports, records, badges and every other message", async () => {
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(coded, { username: true });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(codeFills()).toHaveLength(1);
      expect(JSON.stringify(report.mock.calls)).not.toContain(CODE);
      expect(JSON.stringify(fake.state.storage)).not.toContain(CODE);
      expect(JSON.stringify(fake.state.session)).not.toContain(CODE);
      expect(JSON.stringify(fake.state.badges)).not.toContain(CODE);
      expect(JSON.stringify(h.settings)).not.toContain(CODE);
      const others = fake.state.messages.filter((entry) => !codeFills().includes(entry));
      expect(JSON.stringify(others)).not.toContain(CODE);
    }, 10_000);
  });

  describe("generation slots", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    const loginPage = observation("/signin", [
      { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
      { id: "c2", role: "password", target: target("password") },
      { id: "c3", role: "button", target: target("login"), label: "Sign in" },
    ]);
    const uris = async () => ({ ok: true as const, data: uriMatch() });

    it.each([
      ["is empty", {}, true],
      ["is excluded", { excludedFields: [{ itemId, fieldId: "login.password" }] }, false],
    ])(
      "offers no password when the matching item's password %s",
      async (_label, excluded, empty) => {
        fake.state.extracted = { login: loginPage };
        const service = { ...generation(), available: vi.fn(async (): Promise<true> => true) };
        const h = harness(
          {
            ...unsaved,
            connections: [
              {
                connectionId,
                enabled: true,
                selection: { mode: "all", groupIds: [], itemIds: [] },
                excludedItemIds: [],
                excludedFields: [],
                ...excluded,
              },
            ],
          },
          { allowedOrigins: [], uris, username: true, custom: [], generation: service },
        );
        if (empty)
          editFields(h, (fields) =>
            fields.map((field) =>
              field["id"] === "login.password" ? { ...field, empty: true } : field,
            ),
          );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(service.generate.mock.calls[0]![0].slots).toEqual([
          expect.objectContaining({ id: "username", kind: "identifier" }),
        ]);
      },
    );
  });

  describe("the item a running login uses", () => {
    it("is named only while the tab's login on that origin has not ended", async () => {
      onClick({ login: "hang" });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(clicks("login")).toBe(1));
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      expect(await h.login.loginAccount(1, "https://other.example")).toBeUndefined();
      expect(await h.login.loginAccount(2, origin)).toBeUndefined();
    });

    it("is not named once the login's result settled as unknown", async () => {
      vi.useFakeTimers();
      onClick({ login: { path: "/elsewhere", present: [] } });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("login") === 1);
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      await until(settled("reconciling", "unknown-submit"), 10_000);
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });

    it("keeps naming a running login's item after a worker restart", async () => {
      onClick({ login: "hang" });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(clicks("login")).toBe(1));
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness({}, { passkeys: withPasskey });
        expect(await restarted.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
        expect(status()).toMatchObject([{ state: "reconciling" }]);
        expect(await restarted.login.loginAccount(1, "https://other.example")).toBeUndefined();
      } finally {
        fake.browser.tabs.query = query;
      }
    });

    it("does not name a settled login's item after a worker restart", async () => {
      vi.useFakeTimers();
      onClick({ login: { path: "/elsewhere", present: [] } });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 10_000);
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness({}, { passkeys: withPasskey });
        expect(await restarted.login.loginAccount(1, origin)).toBeUndefined();
      } finally {
        fake.browser.tabs.query = query;
      }
    });

    it("is not named once the login ended", async () => {
      fake.state.present = undefined;
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });
  });

  describe("with password route variants", () => {
    const fillOn = (path: string, slots: string[]) => ({
      kind: "fill" as const,
      path,
      fields: slots.map((slot) => ({ slot, target: target(slot) })),
    });
    const clickOn = (path: string, value: string, purpose: "advance" | "submit") => ({
      kind: "click" as const,
      path,
      target: target(value),
      purpose,
    });
    const variantBinding = (slots: SavedLoginBinding["slots"]): SavedLoginBinding => ({
      ...savedBinding,
      recipeId: "synthetic-variants",
      slots,
    });

    it("does not judge a page that shows another variant's field on that variant's path", async () => {
      vi.useFakeTimers();
      // The branch variant signs in on the start page; the member variant continues to
      // `/verify` for its PIN.
      const twoPaths = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-variants",
        slots: ["branch", "password"],
        steps: [fillOn("/signin", ["branch", "password"]), clickOn("/signin", "login", "submit")],
        alternatives: [
          {
            slots: ["member", "pin"],
            steps: [
              fillOn("/signin", ["member"]),
              clickOn("/signin", "next", "advance"),
              fillOn("/verify", ["pin"]),
              clickOn("/verify", "confirm", "submit"),
            ],
          },
        ],
        maxSubmissions: 2,
      });
      // The branch login lands on the member variant's PIN page.
      const pinPage = observation("/verify", [
        { id: "c1", role: "password", target: target("pin"), label: "PIN" },
      ]);
      onClick({ login: { path: "/verify", present: ["pin"], extracted: pinPage } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness(
        {
          bindings: [
            variantBinding([
              { slot: "branch", field: { custom: "Branch" } },
              { slot: "password", field: "password" },
            ]),
          ],
        },
        { passkeys: withPasskey, generation: service },
      );
      h.recipes.recipe.mockResolvedValue(twoPaths);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(status()![0]).toMatchObject({ variant: 0 });
      // The page is a sign-in page of the route, whichever variant ran, as the service
      // would also answer.
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });

    it("takes a revision over on the variant the login runs and clicks the handler", async () => {
      vi.useFakeTimers();
      // Variant 0 has one step more than variant 1, so a handler inserted after the wrong
      // variant's steps would not follow the click that ran.
      const plainVariants = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-variants",
        slots: ["branch", "password"],
        steps: [
          fillOn("/signin", ["branch"]),
          fillOn("/signin", ["password"]),
          clickOn("/signin", "login", "submit"),
        ],
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [
              fillOn("/signin", ["contract", "password"]),
              clickOn("/signin", "login", "submit"),
            ],
          },
        ],
      });
      const takenVariants = parseLoginRecipe({
        ...plainVariants,
        revision: 2,
        handlers: [keyHandler],
      });
      onClick({ login: toWebauthn, "Use security key": toHome });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: takenVariants })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const h = harness(
        {
          bindings: [
            variantBinding([
              { slot: "contract", field: { custom: "Contract" } },
              { slot: "password", field: "password" },
            ]),
          ],
        },
        {
          passkeys: withPasskey,
          generation: service,
          custom: [{ name: "Contract", kind: "text" }],
        },
      );
      h.recipes.recipe.mockResolvedValue(plainVariants);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        route: "password",
        variant: 1,
        recipeRevision: 2,
        handlers: [{ index: 0, start: 2 }],
        stepCount: 3,
        maxSubmissions: 2,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "click"]);
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [plainVariants.id, 1, "password", webauthnPage.observation],
        [plainVariants.id, 2, "password", homePage.observation],
      ]);
    });
  });

  describe("a login watched after a step left to the person (ADR 0027)", () => {
    const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
    const described = (path: string) =>
      observation(path, [{ id: "c1", role: "link", target: target("help"), label: "Help" }]);
    const reports = vi.fn<(report: LoginReport) => void>();
    const judges = () =>
      reports.mock.calls.flatMap(([value]) =>
        value.type === "judge" && value.verdict !== "sent" ? [value] : [],
      );
    /**
     * Logs in with `chosen`; the click leads to `/approve`, a page no check explains, which
     * the judge answers `challenge`, as an app approval page. Later answers follow `verdicts`.
     */
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
    /** The tab opens another page of the origin, as after the person approved. */
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

    it("completes on a later page the judge finds signed in, reading only", async () => {
      const { h, service } = await watched(["signed-in"]);
      const steps = executed().length;
      // The page of the approval itself is not read again.
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "duplicate-document" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      // A later page watches for the first step, which would release the login.
      expect(await open(h, "/home")).toEqual({ ok: true, starts: expect.any(Array) });
      expect(service.judge).toHaveBeenCalledTimes(2);
      expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
      expect(status()![0]).not.toHaveProperty("watch");
      expect(executed()).toHaveLength(steps);
      expect(judges().at(-1)).toMatchObject({ verdict: "signed-in", watched: true });
      // The login finished, so its form showing again is a logout (ADR 0021 D).
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      await h.hello({ documentId: "signed-out" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reports).toHaveBeenCalledWith(
        expect.objectContaining({ type: "logout", tabId: 1, origin }),
      );
      expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([{ tabId: 1, origin }]);
      expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([]);
      // Another tab of the site asks too and only fills, as after any logout.
      const before = executed().length;
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(
        executed()
          .slice(before)
          .map((step) => step.kind),
      ).toEqual(["fill"]);
      expect(reports).toHaveBeenCalledWith(
        expect.objectContaining({ type: "start", tabId: 2, fillOnly: true }),
      );
    });

    it("hides the account's username from a watched page it judges", async () => {
      const { h, service } = await watched(
        ["signed-in"],
        plain,
        async (created) =>
          created.fields.mockImplementation(async ({ fieldId }) =>
            fieldId === "login.username" ? "taro.yamada" : "synthetic-secret",
          ),
        { username: true },
      );
      fake.state.pageUrl = `${origin}/home`;
      fake.state.observedPath = "/home";
      fake.state.present = new Set();
      fake.state.extracted = {
        "signed-in": observation("/home", [
          { id: "c1", role: "link", target: target("help"), label: "Help for taro.yamada" },
        ]),
      };
      await h.hello({ documentId: "document-home" }, false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.judge).toHaveBeenCalledTimes(2);
      expect(service.judge.mock.calls[1]![3].candidates).toEqual([
        { id: "c1", role: "link", target: target("help"), label: "Help for [account]" },
      ]);
      expect(JSON.stringify(service.judge.mock.calls)).not.toContain("taro");
      expect(status()).toMatchObject([{ state: "authenticated" }]);
    });

    it("completes on the recipe's completion without asking the judge", async () => {
      const completing = parseLoginRecipe({ ...unlearned, completion: home });
      const { h, service } = await watched([], completing);
      await open(h, "/home", ["logout"]);
      expect(status()).toMatchObject([{ state: "authenticated" }]);
      expect(service.judge).toHaveBeenCalledTimes(1);
    });

    it("completes on the sign-in state without asking the judge (ADR 0029)", async () => {
      const { h, service } = await watched();
      fake.state.signs = { ...quiet, username: true };
      await open(h, "/home");
      expect(status()).toMatchObject([{ state: "authenticated" }]);
      expect(service.judge).toHaveBeenCalledTimes(1);
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
      h.settings.settings.connections[0]!.enabled = false;
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

    /** The tab's page shows the recipe's first step as a new document of `tabId`. */
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

    it("ends a watch that never signed in when its first step shows again: no logout, this tab only fills", async () => {
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
      expect(reports).not.toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }));
      expect(reports).toHaveBeenCalledWith(abandoned("challenge-abandoned"));
      expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
      expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
      // The tab fills the form once, without pressing anything.
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill"]);
      expect(reports).toHaveBeenCalledWith(
        expect.objectContaining({ type: "start", tabId: 1, fillOnly: true }),
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
      ).toMatchObject({ ok: true, logout: "stopped-login" });
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
        expect.objectContaining({ type: "refused", tabId: 2, reason: "logged-out" }),
      );
    });

    it("ends the watch when the person starts over in another tab, which logs in as before", async () => {
      const { h } = await watched();
      const steps = executed().length;
      // The approval expired and the person opened the sign-in page in a new tab.
      expect(await signInPage(h, 2, "other-tab")).toEqual({ ok: true });
      expect(reports).not.toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }));
      expect(reports).toHaveBeenCalledWith(abandoned("challenge-abandoned", 1));
      expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
      // Only the watched tab asks if its own sign-in page shows again.
      expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
      // The new tab logs in and presses the button.
      expect(
        executed()
          .slice(steps)
          .map((step) => step.kind),
      ).toEqual(["fill", "click"]);
      expect(reports).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "start", tabId: 2, fillOnly: true }),
      );
      // The watched tab's own sign-in page then only fills.
      const before = executed().length;
      expect(await signInPage(h, 1, "document-signin")).toEqual({ ok: true });
      expect(
        executed()
          .slice(before)
          .map((step) => step.kind),
      ).toEqual(["fill"]);
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
      expect(reports).not.toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }));
      expect(status()).toMatchObject([{ state: "watching", document: { tabId: 1 } }]);
    });

    it("keeps holding the site against another tab's page that is not the first step", async () => {
      const { h } = await watched();
      fake.state.pageUrl = `${origin}/home`;
      fake.state.observedPath = "/home";
      fake.state.tabUrls[2] = fake.state.pageUrl;
      await h.hello({ tab: { id: 2 }, documentId: "other-tab" }, false);
      expect(reports).not.toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }));
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
      // taken as a logout, and every other tab of the site only filled after it.
      expect(reports).not.toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }));
      expect(reports).toHaveBeenCalledWith(abandoned("watch-abandoned"));
      expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
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
      expect(reports).not.toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }));
      expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
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
  });
});
