import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, recipe, harness } = createRuntimeTestHarness(fake);

describe("a button that goes on to an authenticator app's code (ADR 0081)", () => {
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
  // A page after the password that asks how to confirm the sign-in, then the code page on
  // the same path (ADR 0081).
  describe("the authenticator handler", () => {
    const app = { by: "text" as const, value: "Use code from authenticator" };
    const appHandler = { kind: "authenticator" as const, path: "/two-factor", target: app };
    const codeHandler = {
      kind: "totp" as const,
      path: "/two-factor",
      field: target("app-code"),
      target: target("verify"),
    };
    const chosen = parseLoginRecipe({
      ...unlearned,
      completion: home,
      handlers: [appHandler, codeHandler],
    });
    const toChooser = {
      path: "/two-factor",
      present: ["Use code from authenticator", "Text me a code"],
    };
    const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const withTotp = (h: ReturnType<typeof harness>) =>
      editFields(h, (fields) => [
        ...fields,
        { id: "login.totp-code", label: "Verification code", name: null, kind: "otp" },
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
    const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome, value.steps]] : [],
      );
    const choiceClicks = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" &&
          (entry as unknown as { authenticatorChoice?: boolean }).authenticatorChoice === true,
      );

    it("presses the button after the password, then types the code on the page it shows", async () => {
      onClick({
        login: toChooser,
        "Use code from authenticator": toCode,
        verify: toHome,
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(chosen);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(clicks("Use code from authenticator")).toBe(1);
      expect(clicks("Text me a code")).toBe(0);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      // Its text is checked when it is entered and again in the click's own task.
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.observe",
          targets: expect.arrayContaining([app]),
          require: expect.arrayContaining(["authenticator-choice"]),
        }),
      );
      expect(choiceClicks()).toHaveLength(1);
      expect(handlerReports(report)).toEqual([
        [0, "authenticator", "entered", 1],
        [1, "totp", "entered", 2],
      ]);
    }, 10_000);

    it("leaves the choice to the person for an item without a TOTP code", async () => {
      onClick({ login: toChooser, "Use code from authenticator": toCode });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      h.recipes.recipe.mockResolvedValue(chosen);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(handlerReports(report)).toEqual([[0, "authenticator", "missing-fact", 1]]),
        { timeout: 6_000 },
      );
      expect(clicks("Use code from authenticator")).toBe(0);
      expect(codeFills()).toEqual([]);
    }, 10_000);

    it("presses the code field's handler when the page already shows it", async () => {
      onClick({
        login: {
          path: "/two-factor",
          present: ["app-code", "verify", "Use code from authenticator"],
        },
        verify: toHome,
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(chosen);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(clicks("Use code from authenticator")).toBe(0);
      expect(codeFills()).toHaveLength(1);
      expect(handlerReports(report)).toEqual([[1, "totp", "entered", 2]]);
    }, 10_000);

    it("never presses it again once the login typed a code", async () => {
      // The code is refused and the site shows the choice again.
      onClick({ login: toChooser, "Use code from authenticator": toCode, verify: toChooser });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(chosen);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(handlerReports(report).at(-1)).toEqual([0, "authenticator", "shown-again", 1]),
        { timeout: 6_000 },
      );
      expect(clicks("Use code from authenticator")).toBe(1);
      expect(codeFills()).toHaveLength(1);
    }, 10_000);
  });
});
