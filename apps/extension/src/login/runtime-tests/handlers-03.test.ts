import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, snapshotId, target, recipe, savedBinding, excludingLive, harness } =
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
  void parseLoginRecipe(unlearned);
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
      it("fills a route step's totp slot bound to a custom field with a code", async () => {
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
        onClick({ login: toCode, verify: toHome });
        const h = harness(
          { bindings: namedFor() },
          { passkeys: noPasskey, custom: [{ name: "Seed", kind: "hidden", totpSeed: true }] },
        );
        customCode(h);
        h.recipes.recipe.mockResolvedValue(routeCoded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills().map((entry) => entry.values)).toEqual([
          [{ slot: "totp", value: "654321", secret: "otp" }],
        ]);
        expect(reads(h)).toEqual([{ fieldId: "login.password" }, { fieldId: seedId, code: true }]);
        expect(clicks("verify")).toBe(1);
      }, 10_000);
      it("refuses before any step a route step's totp slot bound to a custom field holding no key", async () => {
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
        onClick({ login: toCode, verify: toHome });
        const h = harness(
          { bindings: namedFor() },
          { passkeys: noPasskey, custom: [{ name: "Seed", kind: "text" }] },
        );
        customCode(h);
        h.recipes.recipe.mockResolvedValue(routeCoded);
        expect(await h.hello()).toEqual({ ok: false, reason: "totp-field-mismatch" });
        expect(h.fields).not.toHaveBeenCalled();
        expect(executed()).toEqual([]);
      });
      it("stops without a fill when no code can be made from the custom field", async () => {
        onClick({ login: toCode, verify: toHome });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          { bindings: namedFor() },
          {
            passkeys: noPasskey,
            report,
            custom: [{ name: "Seed", kind: "hidden", totpSeed: true }],
          },
        );
        withTotp(h);
        // As an invalid seed: the source answers the code request with nothing.
        h.fields.mockImplementation(async ({ code }) => (code ? undefined : "synthetic-secret"));
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
          { timeout: 6_000 },
        );
        expect(codeFills()).toEqual([]);
        expect(clicks("verify")).toBe(0);
        expect(reads(h)).toEqual([{ fieldId: "login.password" }, { fieldId: seedId, code: true }]);
        expect(
          report.mock.calls.flatMap(([entry]) => (entry.type === "attempt" ? [entry] : [])).at(-1),
        ).toMatchObject({
          state: "blocked",
          outcome: "policy-changed",
          cause: "field-unavailable",
        });
      }, 10_000);
      it("is not entered when the named Text field is not shaped like a TOTP key", async () => {
        onClick({ login: toCode, verify: toHome });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          { bindings: namedFor() },
          { passkeys: noPasskey, report, custom: [{ name: "Seed", kind: "text" }] },
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
    describe("with a custom field holding a TOTP key and no saved entry for the code (owner, 2026-10-23)", () => {
      const seedId = `custom.${snapshotId}.1`;
      const seeded = [
        { name: "Branch", kind: "text" as const },
        { name: "Seed", kind: "hidden" as const, totpSeed: true as const },
      ];
      const customCode = (h: ReturnType<typeof harness>) =>
        h.fields.mockImplementation(async ({ fieldId, code }) =>
          code
            ? fieldId === seedId
              ? "654321"
              : fieldId === "login.totp-code"
                ? "012345"
                : undefined
            : "synthetic-secret",
        );
      const reads = (h: ReturnType<typeof harness>) =>
        h.fields.mock.calls.map(([request]) => ({
          fieldId: request.fieldId,
          ...(request.code ? { code: request.code } : {}),
        }));
      it("makes the handler's code from that field when the built-in TOTP holds no key", async () => {
        onClick({ login: toCode, verify: toHome });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report, custom: seeded });
        withTotp(h, true);
        customCode(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(status()![0]).toMatchObject({ facts: { totp: true } });
        expect(codeFills().map((entry) => entry.values)).toEqual([
          [{ slot: "totp", value: "654321", secret: "otp" }],
        ]);
        expect(reads(h)).toEqual([{ fieldId: "login.password" }, { fieldId: seedId, code: true }]);
        expect(handlerReports(report)).toEqual([[0, "totp", "entered", 2]]);
      }, 10_000);
      it("keeps the built-in TOTP when it holds a key", async () => {
        onClick({ login: toCode, verify: toHome });
        const h = harness({}, { passkeys: noPasskey, custom: seeded });
        withTotp(h);
        customCode(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills().map((entry) => entry.values)).toEqual([
          [{ slot: "totp", value: "012345", secret: "otp" }],
        ]);
        expect(reads(h).map((read) => read.fieldId)).not.toContain(seedId);
      }, 10_000);
      it("is not entered when the account excludes that field", async () => {
        onClick({ login: toCode, verify: toHome });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(excludingLive([{ custom: "Seed", position: 1, count: 1 }]), {
          passkeys: noPasskey,
          report,
          custom: seeded,
        });
        withTotp(h, true);
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
      it("fills a route step's totp slot with a code from that field and saves it", async () => {
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
        onClick({ login: toCode, verify: toHome });
        const h = harness({}, { passkeys: noPasskey, custom: seeded });
        withTotp(h, true);
        customCode(h);
        h.recipes.recipe.mockResolvedValue(routeCoded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills().map((entry) => entry.values)).toEqual([
          [{ slot: "totp", value: "654321", secret: "otp" }],
        ]);
        expect(reads(h)).toEqual([{ fieldId: "login.password" }, { fieldId: seedId, code: true }]);
        // The widened binding names the field by its vault name.
        expect(h.settings.settings.bindings).toEqual([
          {
            ...savedBinding,
            slots: [...savedBinding.slots, { slot: "totp", field: { custom: "Seed" } }],
          },
        ]);
      }, 10_000);
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
      const routeCode = parseLoginRecipe({
        version: 1,
        id: "synthetic-code",
        revision: 1,
        origin,
        pageKind: "sign-in",
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
      it.each([
        ["", false],
        [", disabled", true],
      ])(
        "holds a page that reports its own submission while the button still shows%s",
        async (_label, disabled) => {
          onClick({ login: toCode, verify: toHome });
          onCodeFill(() => {
            // The content script saw the page submit the code; the form now says "Verifying".
            fake.state.executeReply = { ok: false, reason: "submitted", mutation: "possible" };
            // A button the page disables while it verifies still shows.
            if (disabled) fake.state.disabled = new Set(["verify"]);
            // Stop the clock at the fill, so it cannot run past the held click's wait
            // (HELD_CLICK_WAIT_MS) while the test still waits for the fill.
            vi.setTimerTickMode("manual");
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
          await vi.advanceTimersByTimeAsync(1_500);
          expect(status()).toMatchObject([{ state: "reconciling", stepIndex: 3 }]);
          expect(handlerReports(report)).toEqual([[0, "totp", "entered", 2]]);
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
          vi.setTimerTickMode("nextTimerAsync");
          await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
            timeout: 6_000,
          });
          expect(clicks("verify")).toBe(0);
        },
        15_000,
      );
      it("settles a page that hid its button when it submitted the code itself", async () => {
        vi.useFakeTimers();
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The content script saw the button go hidden: the app moved on in the same
          // document and kept its code form there, hidden.
          fake.state.executeReply = { ok: false, reason: "submitted", mutation: "possible" };
          fake.state.observedPath = "/home";
          fake.state.unusable = new Set(["app-code", "verify"]);
          fake.state.extracted = { "signed-in": homePage };
        });
        const service = generation(async () => ({ verdict: "signed-in" }));
        const h = harness({}, { passkeys: noPasskey, generation: service });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => codeFills().length === 1, 10_000);
        // Well before the held click's two minutes.
        await until(settled("authenticated"), 20_000);
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(service.judge).toHaveBeenCalledTimes(1);
      });
      it("settles a page that hid its button beside the completion before the click", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The code went in without a sign of a submission; the page then signs in on the
          // same path, keeping its code form there, hidden, so the click's wait never ends.
          fake.state.present = new Set(["app-code", "verify", "logout"]);
          fake.state.unusable = new Set(["app-code", "verify"]);
          fake.state.awaited = { ok: false, reason: "timeout" };
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
});
