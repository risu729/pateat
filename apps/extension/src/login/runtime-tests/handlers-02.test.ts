import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, toLoginLayout, type LoginStep } from "@pateat/contracts";
import { createLoginGeneration } from "../../service/generation";
import { createRecipeSync } from "../../service/recipes";
import type { ServiceTransport } from "../../service/transport";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, snapshotId, target, startsOf, recipe, savedBinding, excludingLive, harness } =
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
  void parseLoginRecipe({ ...unlearned, completion: home, handlers: [keyHandler] });
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
  describe("on the page after an effect step", () => {
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
        undefined,
        undefined,
        undefined,
        expect.any(Array),
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
        undefined,
        undefined,
        undefined,
        expect.any(Array),
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
      // The service stores the recipe with its layout and judges the layout the login ran
      // (ADR 0060).
      const laid = { ...plain, layout: "1000" };
      const change = {
        recipeId: taken.id,
        revision: 2,
        state: "active" as const,
        recipe: {
          version: 1 as const,
          id: taken.id,
          revision: 2,
          origin: taken.origin,
          layouts: [toLoginLayout(taken, { key: "1000", createdAt: 1000 })],
        },
      };
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
          readRecovery: async () => undefined,
          writeRecovery: async () => undefined,
          clear: async () => undefined,
        },
        schedule: { read: async () => undefined, write: async () => undefined },
        build: "development",
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
      h.recipes.recipe.mockResolvedValue(laid);
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
    const codes = (h: ReturnType<typeof harness>) =>
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
    const codeFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
      );
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
      // The code is asked for as a code; the password is not.
      expect(h.fields.mock.calls.map(([request]) => request.code)).toEqual([undefined, true]);
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
    describe("without a button, on a page that submits the code itself (#916)", () => {
      const { target: _, ...buttonless } = codeHandler;
      const typed = parseLoginRecipe({ ...unlearned, completion: home, handlers: [buttonless] });
      const toBoxes = { path: "/two-factor", present: ["app-code"] };
      it("types the code as its submission and settles the page it leads to", async () => {
        onClick({ login: toBoxes });
        onCodeFill(() => {
          // The page signs in once the last digit is in.
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(typed);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "fill"]);
        // One fill that submits through the code's own input, typed as a code; no click.
        expect(codeFills()).toHaveLength(1);
        expect(codeFills()[0]).toMatchObject({
          values: [{ slot: "totp", value: "012345", secret: "otp" }],
          code: {},
          operation: { step: { kind: "fill", effect: "submit", event: "input" } },
        });
        expect(status()![0]).toMatchObject({
          handlers: [{ index: 0, start: 2 }],
          stepCount: 3,
          submissions: 2,
          maxSubmissions: 2,
        });
        // Only the code field is observed before it is entered.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({ type: "login.observe", targets: [target("app-code")] }),
        );
        expect(handlerReports(report)).toEqual([[0, "totp", "entered", 1]]);
      }, 10_000);
      it("leaves a code page that keeps its inputs to the person and never types again", async () => {
        vi.useFakeTimers();
        // A wrong code, or a page that waits for Enter: the inputs stay in the same document.
        onClick({ login: toBoxes });
        const service = generation(async () => ({ verdict: "signed-in" }));
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report, generation: service });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(typed);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => codeFills().length === 1);
        await vi.advanceTimersByTimeAsync(100_000);
        await until(settled("watching", "challenge"), 30_000);
        expect(codeFills()).toHaveLength(1);
        expect(executed().filter((step) => step.kind === "click")).toHaveLength(1);
        // The page still asking for the code is never judged.
        expect(service.judge).not.toHaveBeenCalled();
        expect(handlerReports(report)).toEqual([[0, "totp", "entered", 1]]);
      });
    });
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
    describe("with a custom field a saved binding names for the code", () => {
      const seedId = `custom.${snapshotId}.0`;
      const namedFor = (
        field: "password" | "username" | "totp" | { custom: string } = { custom: "Seed" },
      ) => [
        {
          ...savedBinding,
          slots: [
            { slot: "password", field: "password" as const },
            { slot: "totp", field },
          ],
        },
      ];
      const customCode = (h: ReturnType<typeof harness>) =>
        h.fields.mockImplementation(async ({ fieldId, code }) =>
          code ? (fieldId === seedId ? "654321" : undefined) : "synthetic-secret",
        );
      const reads = (h: ReturnType<typeof harness>) =>
        h.fields.mock.calls.map(([request]) => ({
          fieldId: request.fieldId,
          ...(request.code ? { code: request.code } : {}),
        }));
      it.each(["hidden", "text"] as const)(
        "fills a code made from a %s custom field and clicks the button once",
        async (kind) => {
          onClick({ login: toCode, verify: toHome });
          const report = vi.fn<(report: LoginReport) => void>();
          const h = harness(
            { bindings: namedFor() },
            { passkeys: noPasskey, report, custom: [{ name: "Seed", kind, totpSeed: true }] },
          );
          // The item's built-in TOTP is not what the code is made from.
          withTotp(h);
          customCode(h);
          h.recipes.recipe.mockResolvedValue(coded);
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
            timeout: 6_000,
          });
          expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "fill", "click"]);
          expect(clicks("verify")).toBe(1);
          expect(codeFills().map((entry) => entry.values)).toEqual([
            [{ slot: "totp", value: "654321", secret: "otp" }],
          ]);
          expect(reads(h)).toEqual([
            { fieldId: "login.password" },
            { fieldId: seedId, code: true },
          ]);
          expect(status()![0]).toMatchObject({
            facts: { totp: true },
            handlers: [{ index: 0, start: 2 }],
          });
          expect(handlerReports(report)).toEqual([[0, "totp", "entered", 2]]);
        },
        10_000,
      );
      it.each([
        ["a Boolean custom field", { custom: "Seed" }, "boolean"],
        ["a Linked custom field", { custom: "Seed" }, "linked"],
        ["the username", "username", undefined],
        ["the password", "password", undefined],
      ] as const)(
        "is not entered when the binding names %s for the code",
        async (_label, field, kind) => {
          onClick({ login: toCode, verify: toHome });
          const report = vi.fn<(report: LoginReport) => void>();
          const h = harness(
            { bindings: namedFor(field) },
            {
              passkeys: noPasskey,
              report,
              username: true,
              ...(kind === "linked"
                ? { custom: [{ name: "Seed", kind, linkedFieldId: "login.password" }] }
                : {}),
            },
          );
          if (kind === "boolean")
            editFields(h, (fields) => [
              ...fields.filter((entry) => !String(entry["id"]).startsWith("custom.")),
              { id: seedId, label: "Seed", name: "Seed", kind: "boolean" },
            ]);
          withTotp(h);
          customCode(h);
          h.recipes.recipe.mockResolvedValue(coded);
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          );
          // The built-in TOTP does not count when the binding names another field.
          expect(status()![0]).toMatchObject({ facts: { totp: false } });
          expect(codeFills()).toEqual([]);
          // Nothing is read for the code: no code request, and neither code field.
          expect(reads(h).filter((read) => read.code)).toEqual([]);
          expect(reads(h).map((read) => read.fieldId)).not.toContain(seedId);
          expect(reads(h).map((read) => read.fieldId)).not.toContain("login.totp-code");
          expect(handlerReports(report)).toEqual([[0, "totp", "missing-fact", 2]]);
        },
      );
      it("is not entered when the account excludes the custom field, despite a built-in TOTP", async () => {
        onClick({ login: toCode, verify: toHome });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          {
            bindings: namedFor(),
            ...excludingLive([{ custom: "Seed", position: 1, count: 1 }]),
          },
          {
            passkeys: noPasskey,
            report,
            custom: [{ name: "Seed", kind: "hidden", totpSeed: true }],
          },
        );
        withTotp(h);
        customCode(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(status()![0]).toMatchObject({ facts: { totp: false } });
        expect(codeFills()).toEqual([]);
        expect(reads(h)).toEqual([{ fieldId: "login.password" }]);
        expect(handlerReports(report)).toEqual([[0, "totp", "missing-fact", 2]]);
      });
    });
  });
});
