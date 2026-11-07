import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, recipe, harness } = createRuntimeTestHarness(fake);

// Why a code page's handler was not entered, logged once the login leaves the page to the
// person (#1381: VRChat's code page left to the person with no line saying why), and
// never for a page that renders late, a refused password or a withdrawn login.
describe("a page handler not entered (ADR 0066 amendment of 2026-11-07)", () => {
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
  const { completion: _unlearned, ...unlearned } = recipe;
  const home = [{ target: target("logout") }];
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown }>,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || !step.target) return;
      const next = pages[step.target.value];
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };
  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  function generation(judge: LoginGeneration["judge"]) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
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
  const codeHandler = {
    kind: "totp" as const,
    path: "/two-factor",
    field: target("app-code"),
    target: target("verify"),
  };
  const coded = parseLoginRecipe({ ...unlearned, completion: home, handlers: [codeHandler] });
  const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
  const codePage = observation("/two-factor", [
    {
      id: "c1",
      role: "text",
      target: target("app-code"),
      label: "Verification Code",
      autocomplete: "one-time-code",
    },
    { id: "c2", role: "button", target: target("verify"), label: "Verify" },
  ]);
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
  const notShown = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
    report.mock.calls.flatMap(([value]) =>
      value.type === "handler" ? [[value.handler, value.outcome, value.why]] : [],
    );
  /** Whether the handler's own reading, the code field then its button, was sent. */
  const handlerRead = (from: number) =>
    fake.state.messages
      .slice(from)
      .some(
        (entry) =>
          entry.type === "login.observe" &&
          JSON.stringify(entry.targets) === JSON.stringify([target("app-code"), target("verify")]),
      );
  it("logs no miss for a code page whose sign-in ends rejected", async () => {
    // The recipe's rejection shows where the code field would be: a refused password,
    // not a code page left to the person.
    const rejecting = parseLoginRecipe({ ...coded, rejection: target("rejected") });
    onClick({ login: { path: "/two-factor", present: ["verify", "rejected"] } });
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { passkeys: noPasskey, report });
    withTotp(h);
    h.recipes.recipe.mockResolvedValue(rejecting);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () => expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
      { timeout: 6_000 },
    );
    expect(codeFills()).toEqual([]);
    expect(notShown(report)).toEqual([]);
  }, 10_000);
  it("logs no miss for a code page whose login is then withdrawn", async () => {
    // Settings change right after the reading that missed the button: the login ends
    // as withdrawn, not as a code page left to the person.
    onClick({ login: { path: "/two-factor", present: ["app-code"] } });
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { passkeys: noPasskey, report });
    const reads = fake.state.messages.length;
    const later = setInterval(() => {
      if (handlerRead(reads)) {
        h.settings.revision += 1;
        clearInterval(later);
      }
    }, 1);
    onTestFinished(() => clearInterval(later));
    withTotp(h);
    h.recipes.recipe.mockResolvedValue(coded);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () => expect(status()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
      { timeout: 6_000 },
    );
    expect(notShown(report)).toEqual([]);
  }, 10_000);
  it("says the page moved when it left the code page's path before the reading", async () => {
    onClick({ login: toCode });
    const reads = fake.state.messages.length;
    // The handler's own reading finds the page already on another path.
    Object.defineProperty(fake.state, "observedPath", {
      configurable: true,
      get: () => (handlerRead(reads) ? "/next" : "/two-factor"),
      set: () => {},
    });
    onTestFinished(() => {
      Reflect.deleteProperty(fake.state, "observedPath");
    });
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { passkeys: noPasskey, report });
    withTotp(h);
    h.recipes.recipe.mockResolvedValue(coded);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(notShown(report)).toEqual([[0, "not-shown", "moved"]]), {
      timeout: 6_000,
    });
    expect(codeFills()).toEqual([]);
  }, 10_000);
  it("says once why a handler taken over from the judge was not entered, as on VRChat's code page", async () => {
    // 2026-11-07 12:48 UTC: the judge learned VRChat's code field and Verify button, the
    // login took the new revision over, and by then the person had pressed Verify, so
    // the button read "Verifying..." and the handler was passed over without a line.
    const plain = parseLoginRecipe(unlearned);
    const taken = parseLoginRecipe({ ...unlearned, revision: 2, handlers: [codeHandler] });
    onClick({ login: { path: "/two-factor", present: ["app-code"], extracted: codePage } });
    const service = generation(async () => ({ verdict: "challenge", recipe: taken }));
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { passkeys: noPasskey, generation: service, report });
    withTotp(h);
    h.recipes.recipe.mockResolvedValue(plain);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () => expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
      { timeout: 6_000 },
    );
    expect(status()).toMatchObject([{ recipeRevision: 2, handlers: [] }]);
    expect(codeFills()).toEqual([]);
    expect(notShown(report)).toEqual([[0, "not-shown", "ok.missing"]]);
  }, 10_000);
  it.each([
    ["entered", false],
    ["missing-fact", true],
  ] as const)(
    "logs only %s for a code page whose button renders after its field",
    async (outcome, empty) => {
      // The button shows a moment after the field, as a page still rendering: the earlier
      // reading that missed it is never logged, whether the handler is then entered or
      // refused for an item without a code.
      onClick({ login: { path: "/two-factor", present: ["app-code"] }, verify: toHome });
      const reads = fake.state.messages.length;
      const later = setInterval(() => {
        if (handlerRead(reads)) {
          fake.state.present = new Set(["app-code", "verify"]);
          clearInterval(later);
        }
      }, 10);
      onTestFinished(() => clearInterval(later));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h, empty);
      codes(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(notShown(report)).toEqual([[0, outcome, undefined]]), {
        timeout: 6_000,
      });
      if (!empty)
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
      else
        await vi.waitFor(() => expect(status()).toMatchObject([{ outcome: "challenge" }]), {
          timeout: 6_000,
        });
      expect(codeFills()).toHaveLength(empty ? 0 : 1);
      expect(notShown(report)).toEqual([[0, outcome, undefined]]);
    },
    10_000,
  );
});
