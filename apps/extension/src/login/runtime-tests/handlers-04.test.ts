import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type DetailLink,
  type LocalSettings,
  type LoginHandler,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
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
  userId,
  savedBinding,
  otherItemId,
  liveItemPolicy,
  harness,
  realTime,
} = createRuntimeTestHarness(fake);

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
          h.settings.settings.itemPolicies = [
            liveItemPolicy(itemId, { excludedFields: ["login.totp-code"] }),
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
          h.settings.settings.itemPolicies = [
            liveItemPolicy(itemId, { excludedFields: ["login.totp-code"] }),
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
  describe("the detail handler (ADR 0061)", () => {
    const detailHandler = {
      kind: "detail" as const,
      path: "/confirm",
      fields: [
        { detail: "birth-date" as const, format: "yyyymm" as const, target: target("birth") },
        { detail: "phone-last-4" as const, target: target("phone") },
      ],
      target: target("confirm"),
    };
    const detailed = parseLoginRecipe({
      ...unlearned,
      completion: home,
      handlers: [detailHandler],
    });
    const toConfirm = { path: "/confirm", present: ["birth", "phone", "confirm"] };
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const detailFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "detail"),
      );
    const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome, value.steps]] : [],
      );
    it("ends as a challenge without a read, fill or click while no login links the details", async () => {
      onClick({ login: toConfirm, confirm: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      h.recipes.recipe.mockResolvedValue(detailed);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      expect(status()![0]).toMatchObject({ handlers: [] });
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.password"]);
      expect(detailFills()).toEqual([]);
      expect(clicks("confirm")).toBe(0);
      expect(report).toHaveBeenCalledWith({
        type: "handler",
        tabId: 1,
        origin,
        recipeId: detailed.id,
        recipeRevision: detailed.revision,
        handler: 0,
        kind: "detail",
        outcome: "detail-unlinked",
        steps: 2,
      });
      expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
      // Its inputs and button are observed apart from the recipe's own result targets.
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.observe",
          targets: [target("birth"), target("phone"), target("confirm")],
        }),
      );
    });
    const linkTo = (detail: DetailLink["detail"], source: DetailLink["source"]): DetailLink => ({
      origin,
      provider: "bitwarden",
      server: "cloud-us",
      userId,
      itemId,
      detail,
      source,
    });
    const asCard = (h: ReturnType<typeof harness>) => {
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          response.catalog.connections[0]!.items[1]!.fields = [
            "card.number",
            "card.expMonth",
            "card.expYear",
          ].map((id) => ({ id, label: id.slice(5), name: null, kind: "text" as const }));
        return response;
      });
    };
    const cardValues: Record<string, string> = {
      "card.number": "4000 0000 0000 0002",
      "card.expMonth": "4",
      "card.expYear": "2031",
      "login.username": "synthetic-user@example.test",
    };
    const asking = (fields: Extract<LoginHandler, { kind: "detail" }>["fields"]) =>
      parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [{ ...detailHandler, fields }],
      });
    it("fills the login item's linked PIN as its digits on a page shown by a same-document URL change", async () => {
      // The owner decided that every linked value is filled, a PIN included (2026-10-23
      // 11:41 UTC). Synthetic PIN only.
      onClick({ login: { path: "/confirm", present: ["pin", "confirm"] }, confirm: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        { detailLinks: [linkTo("pin", { itemId, field: { custom: "暗証番号" } })] },
        { passkeys: noPasskey, report, custom: [{ name: "暗証番号", kind: "hidden" }] },
      );
      h.fields.mockImplementation(async (request) =>
        request.fieldId.startsWith("custom.") ? "０１２３" : "synthetic-secret",
      );
      h.recipes.recipe.mockResolvedValue(asking([{ detail: "pin", target: target("pin") }]));
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(detailFills().map((entry) => entry.values)).toEqual([
        [{ slot: "detail", value: "0123", secret: "pin" }],
      ]);
      expect(clicks("confirm")).toBe(1);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
        "login.password",
        expect.stringMatching(/^custom\./u),
      ]);
      expect(handlerReports(report)).toEqual([[0, "detail", "entered", 2]]);
    }, 10_000);
    it("never reads a PIN linked to another login item", async () => {
      onClick({ login: { path: "/confirm", present: ["pin", "confirm"] }, confirm: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        { detailLinks: [linkTo("pin", { itemId: otherItemId, field: { custom: "PIN" } })] },
        { passkeys: noPasskey, report, otherCustom: [{ name: "PIN", kind: "hidden" }] },
      );
      h.recipes.recipe.mockResolvedValue(asking([{ detail: "pin", target: target("pin") }]));
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      );
      expect(handlerReports(report)).toEqual([[0, "detail", "detail-unlinked", 2]]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.password"]);
      expect(detailFills()).toEqual([]);
    });
    it.each([
      [
        "a card's expiry date from its month and year",
        { detail: "card-expiry" as const, format: "mm/yy" as const },
        "card.expMonth" as const,
        { value: "04/31", secret: "detail" },
        ["card.expMonth", "card.expYear"],
      ],
      [
        "a card's whole number",
        { detail: "card-number" as const },
        "card.number" as const,
        { value: "4000000000000002", secret: "card-number" },
        ["card.number"],
      ],
    ])(
      "fills %s, read from the linked card item",
      async (_label, asked, field, filled, read) => {
        onClick({ login: { path: "/confirm", present: ["card", "confirm"] }, confirm: toHome });
        const h = harness(
          { detailLinks: [linkTo(asked.detail, { itemId: otherItemId, field })] },
          { passkeys: noPasskey },
        );
        asCard(h);
        h.fields.mockImplementation(
          async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(asking([{ ...asked, target: target("card") }]));
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [{ slot: "detail", ...filled }],
        ]);
        expect(
          h.fields.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]),
        ).toEqual([[itemId, "login.password"], ...read.map((id) => [otherItemId, id])]);
      },
      10_000,
    );
    describe("a linked card with Bitwarden's re-prompt", () => {
      const documentFills = () =>
        fake.state.messages.filter((entry) => entry.type === "login.detail.fill");
      const listed = { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] };
      const numberLink = linkTo("card-number", { itemId: otherItemId, field: "card.number" });
      const cardReads = (h: ReturnType<typeof harness>) =>
        h.fields.mock.calls.filter(([request]) => request.account.itemId === otherItemId);
      const cardPage = (h: ReturnType<typeof harness>) => {
        asCard(h);
        h.fields.mockImplementation(
          async (request) => cardValues[request.fieldId] ?? "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(
          asking([{ detail: "card-number", target: target("card") }]),
        );
      };
      it("fills it as any other card on a site that does not ask", async () => {
        onClick({ login: { path: "/confirm", present: ["card", "confirm"] }, confirm: toHome });
        const h = harness(
          { detailLinks: [numberLink] },
          { passkeys: noPasskey, otherReprompt: true },
        );
        cardPage(h);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(detailFills().map((entry) => entry.values)).toEqual([
          [{ slot: "detail", value: "4000000000000002", secret: "card-number" }],
        ]);
      }, 10_000);
      it("asks for the master password before it reads the card on a site that asks, then fills it", async () => {
        realTime();
        onClick({ login: { path: "/confirm", present: ["card", "confirm"] }, confirm: toHome });
        const report = vi.fn<(report: LoginReport) => void>();
        let answer!: (value: "verified") => void;
        const askMasterPassword = vi.fn(
          (_input: unknown) => new Promise<"verified">((resolve) => (answer = resolve)),
        );
        // The login item has no re-prompt, so its login starts without asking.
        const h = harness(
          { ...listed, detailLinks: [numberLink] },
          { passkeys: noPasskey, report, otherReprompt: true, askMasterPassword },
        );
        cardPage(h);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(handlerReports(report)).toEqual([[0, "detail", "detail-reprompt", 2]]);
        await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
        expect(askMasterPassword.mock.calls[0]![0]).toMatchObject({
          tabId: 1,
          origin,
          account: { connectionId, itemId },
          item: { id: otherItemId, reprompt: true },
        });
        // Nothing of the card is read or filled while the window asks.
        expect(cardReads(h)).toEqual([]);
        expect(detailFills()).toEqual([]);
        expect(documentFills()).toEqual([]);
        answer("verified");
        await vi.waitFor(() => expect(documentFills()).toHaveLength(1));
        expect(documentFills()[0]).toMatchObject({
          path: "/confirm",
          fields: [{ target: target("card"), value: "4000000000000002", secret: "card-number" }],
        });
        expect(cardReads(h).map(([request]) => request.fieldId)).toEqual(["card.number"]);
        // The value is filled as the popup's Fill fills it: the person presses the button.
        expect(clicks("confirm")).toBe(0);
        expect(askMasterPassword).toHaveBeenCalledOnce();
      }, 10_000);
      it.each([["closed" as const], ["unavailable" as const]])(
        "reads and fills nothing when the window answers %s",
        async (given) => {
          realTime();
          onClick({ login: { path: "/confirm", present: ["card", "confirm"] }, confirm: toHome });
          const report = vi.fn<(report: LoginReport) => void>();
          const askMasterPassword = vi.fn(async (_input: unknown) => given);
          const h = harness(
            { ...listed, detailLinks: [numberLink] },
            { passkeys: noPasskey, report, otherReprompt: true, askMasterPassword },
          );
          cardPage(h);
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(askMasterPassword).toHaveBeenCalledOnce());
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          );
          expect(handlerReports(report)).toEqual([[0, "detail", "detail-reprompt", 2]]);
          expect(cardReads(h)).toEqual([]);
          expect(detailFills()).toEqual([]);
          expect(documentFills()).toEqual([]);
          expect(clicks("confirm")).toBe(0);
        },
        10_000,
      );
    });
  });
});
