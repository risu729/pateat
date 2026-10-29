import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsStore, parseLoginRecipe, type SettingsSnapshot } from "@pateat/contracts";
import { createVaultAutoSync, createVaultSyncRecords } from "../../connections/auto-sync";
import { createLoginGeneration } from "../../service/generation";
import { createSettingsSync } from "../../service/settings-sync";
import type { ServiceTransport } from "../../service/transport";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, recipe, savedBinding, excludingLive, harness } =
  createRuntimeTestHarness(fake);

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
  const handled = parseLoginRecipe({ ...unlearned, completion: home, handlers: [keyHandler] });
  void parseLoginRecipe({ ...unlearned, revision: 2, handlers: [keyHandler] });
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
      const h = harness(excludingLive(["login.password"]), {
        passkeys: withPasskey,
        report,
        username: true,
      });
      // An email-first page: the route binds only the username, so no binding is refused,
      // and the item's password decides whether the route can finish.
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({
          version: 1,
          id: "synthetic-email-first",
          revision: 1,
          origin,
          pageKind: "sign-in",
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
    it("counts the time the person takes with the CAPTCHA and the button as theirs", async () => {
      vi.useFakeTimers();
      captchaOnLogin();
      const service = generation(async () => ({ verdict: "signed-in" }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { generation: service, report });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("login") === 1);
      const [held] = status() as { timing: { personSince?: number } }[];
      expect(held!.timing.personSince).toEqual(expect.any(Number));
      await vi.advanceTimersByTimeAsync(60_000);
      fake.state.executeReply = undefined;
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
      await until(settled("authenticated"));
      const signedIn = report.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry.type === "attempt" && entry.state === "authenticated");
      const times = (signedIn as { times: Record<string, number> }).times;
      // A minute at least was the person's, and never more than the login took.
      expect(times["personMs"]).toBeGreaterThanOrEqual(60_000);
      expect(times["personMs"]! + times["serviceMs"]!).toBeLessThanOrEqual(times["totalMs"]!);
      expect(times["otherMs"]).toBe(
        times["totalMs"]! - times["personMs"]! - times["serviceMs"]! - times["pageMs"]!,
      );
      expect(status()![0]).not.toHaveProperty("timing.personSince");
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
    describe("a passkey request after the handler's click (ADR 0029 amendment of 2026-10-24)", () => {
      const signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
        username: true,
      };
      const run = (answer: boolean) => {
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: withPasskey, report, username: true });
        h.recipes.recipe.mockResolvedValue(
          parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
        );
        fake.state.onExecute = async (message) => {
          const step = (
            message["operation"] as { step: { kind: string; target?: { value: string } } }
          ).step;
          if (step.kind !== "click" || !step.target) return;
          if (step.target.value === "login") {
            fake.state.observedPath = toWebauthn.path;
            fake.state.present = new Set(toWebauthn.present);
            fake.state.extracted = { "signed-in": toWebauthn.extracted };
            return;
          }
          fake.state.observedPath = "/home";
          fake.state.present = new Set();
          fake.state.signs = signs;
          h.login.passkeyRequested(1, origin);
          if (!answer) return;
          vi.setSystemTime(Date.now() + 1);
          h.login.passkeyAnswered(1, origin, "login.example");
        };
        return { h, report };
      };
      const states = (report: ReturnType<typeof run>["report"]) =>
        report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
      it("counts the request while no answer of Pateat's followed it", async () => {
        vi.useFakeTimers();
        const { h, report } = run(false);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => states(report).length > 0, 20_000);
        expect(states(report)[0]).toMatchObject({ s5: true, decision: "continuing" });
        expect(status()![0]!["state"]).not.toBe("authenticated");
      });
      it("skips the request Pateat answered and completes on the username", async () => {
        vi.useFakeTimers();
        const { h, report } = run(true);
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated", "authenticated"), 20_000);
        expect(states(report).at(-1)).toMatchObject({ s5: false, decision: "signed-in" });
      });
    });
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
        undefined,
        undefined,
        undefined,
        expect.any(Array),
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
      const watched = () => (status()![0]!["watch"] as { pages: number } | undefined)?.pages;
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
          accountPolicies: [],
          itemPolicies: [],
          customFieldReviews: [],
          excludedSites,
          passkeyBrowserSites: [],
          repromptSites: [],
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
              state: {
                version: 1,
                profileId: "00000000-0000-4000-8000-000000000010",
                revision: 5,
                settings: settings([]),
              },
            }),
            saveSettings: vi.fn(),
          },
          settings: store,
          storage: {
            read: async () => ({
              version: 1,
              origin: serviceOrigin,
              deviceId,
              profileId: "00000000-0000-4000-8000-000000000010",
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
        // The service judges the layout a login ran (ADR 0060); these logins' recipe has none,
        // so they are judged as its only layout's.
        return (...args: Parameters<LoginGeneration["judge"]>) => {
          const [recipeId, revision, route, seen, sent, branch, ...rest] = args;
          return service.judge(recipeId, revision, route, seen, sent, branch ?? "1000", ...rest);
        };
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
  });
});
