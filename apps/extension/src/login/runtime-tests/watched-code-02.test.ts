import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, recipe, harness } = createRuntimeTestHarness(fake);

// An identity provider's sign-in, as Service NSW's on 2026-11-17 (#1668): the password,
// then in new documents a push approval with no authenticator choice, a list of methods
// the person reaches by "try another method", and the authenticator app's code page the
// person reaches by choosing it. The watch judges the code page and types the item's TOTP
// once (ADR 0027 amendment of 2026-11-17).
describe("an authenticator app's code page the person reaches in a new document", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0)) listener(1);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.codeSent = new Set();
    fake.state.appCode = new Set();
    fake.state.awaited = { ok: true };
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    // The password's submission shows the push approval page.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "login") open("/push");
    };
  });
  const { completion: _completion, ...plain } = recipe;
  const choice = {
    kind: "authenticator" as const,
    path: "/options",
    target: { by: "text" as const, value: "Authenticator app" },
  };
  const code = {
    kind: "totp" as const,
    path: "/otp",
    field: target("otp-code"),
    target: target("verify"),
  };
  const chosen = parseLoginRecipe({ ...plain, revision: 2, handlers: [choice] });
  const coded = parseLoginRecipe({ ...plain, revision: 3, handlers: [choice, code] });
  const noSign = () => ({
    password: false,
    code: false,
    captcha: false,
    invalid: false,
    alert: false,
    username: false,
  });
  const codeSign = () => ({ ...noSign(), code: true });
  const pages: Record<string, { present: string[]; observation: Record<string, unknown> }> = {
    "/push": {
      present: ["resend", "app-code-link", "another"],
      observation: {
        headings: ["Confirm on your phone"],
        nearButtons: ["We've sent a notification to your phone. Open the app to confirm."],
        candidates: [
          { id: "c1", role: "button", target: target("resend"), label: "Resend" },
          {
            id: "c2",
            role: "button",
            target: target("app-code-link"),
            label: "use a one-time code in your app",
          },
          { id: "c3", role: "button", target: target("another"), label: "try another method" },
        ],
      },
    },
    "/options": {
      present: ["Authenticator app", "sms"],
      observation: {
        headings: ["Select a method"],
        candidates: [
          {
            id: "c1",
            role: "button",
            target: { by: "text", value: "Authenticator app" },
            label: "Authenticator app",
          },
          { id: "c2", role: "button", target: target("sms"), label: "Text message (SMS)" },
        ],
      },
    },
    // ImmiAccount's app authentication step (2026-11-21, #1750): a plain text input with
    // `maxlength="6"`, which the sign-in state does not read as a code input (ADR 0027
    // amendment of 2026-11-22).
    "/app-auth": {
      present: ["authenticationCode", "submit"],
      observation: {
        title: "ImmiAccount",
        headings: ["Authenticate ImmiAccount", "App authentication"],
        candidates: [
          {
            id: "c1",
            role: "text",
            target: target("authenticationCode"),
            label: "Authentication code",
            maxLength: 6,
            group: "f1",
          },
          { id: "c2", role: "button", target: target("submit"), label: "Submit", group: "f1" },
        ],
      },
    },
    "/otp": {
      present: ["otp-code", "verify"],
      observation: {
        title: "Enter your authenticator code",
        headings: ["Enter your authenticator code"],
        nearCode: ["Check the authenticator app on your device and enter the code"],
        candidates: [
          {
            id: "c1",
            role: "text",
            target: target("otp-code"),
            label: "Enter your one-time code",
            autocomplete: "one-time-code",
            inputMode: "numeric",
          },
          { id: "c2", role: "button", target: target("verify"), label: "Continue" },
        ],
      },
    },
  };
  /**
   * Shows `path`'s page; `codePage` when it asks for the authenticator app's code,
   * `plainInput` when its code input is one the sign-in state does not read as one.
   */
  function open(path: string, codePage = false, plainInput = false) {
    const page = pages[path]!;
    fake.state.pageUrl = `${origin}${path}`;
    fake.state.observedPath = path;
    fake.state.present = new Set(page.present);
    fake.state.appCode = codePage
      ? new Set([plainInput ? "authenticationCode" : "otp-code"])
      : new Set();
    fake.state.signs = codePage && !plainInput ? codeSign : noSign;
    fake.state.extracted = {
      "signed-in": {
        ok: true,
        observation: {
          version: 1,
          origin,
          path,
          language: "en",
          complete: true,
          ...page.observation,
        },
      },
    };
  }
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const codeFills = () =>
    fake.state.messages.filter(
      (entry) =>
        entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
    );
  const clicks = (value: string) =>
    fake.state.messages.filter((entry) => {
      if (entry.type !== "login.execute") return false;
      const step = (entry as unknown as { operation: { step: LoginStep } }).operation.step;
      return step.kind === "click" && step.target.value === value;
    }).length;
  const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
    report.mock.calls.flatMap(([value]) =>
      value.type === "handler" ? [[value.handler, value.kind, value.outcome]] : [],
    );
  async function until(check: () => boolean, maxMs = 120_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  function start(judge: LoginGeneration["judge"]) {
    const report = vi.fn<(report: LoginReport) => void>();
    const generation = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn(judge),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    const h = harness(
      {},
      {
        report,
        passkeys: vi.fn(async () => ({ passkey: false, discoverable: false })),
        generation,
      },
    );
    h.recipes.recipe.mockResolvedValue(plain);
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        item.fields = [
          ...item.fields,
          { id: "login.totp-code", label: "Verification code", name: null, kind: "otp" },
        ] as never;
      }
      return response;
    });
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
    );
    return { h, report, generation };
  }
  const judgedPaths = (generation: ReturnType<typeof start>["generation"]) =>
    generation.judge.mock.calls.map((call) => (call[3] as { path: string }).path);

  it("judges the code page and types the item's TOTP once with the handler it learns", async () => {
    vi.useFakeTimers();
    const { h, report, generation } = start(async (...args) => {
      args[4]?.();
      const { path } = args[3] as { path: string };
      // The push page's "use a one-time code in your app" is the site's own app, not an
      // authenticator: the judge learns no handler there.
      if (path === "/push") return { verdict: "challenge" };
      if (path === "/options") return { verdict: "challenge", recipe: chosen };
      return { verdict: "challenge", recipe: coded };
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge" });
    expect(judgedPaths(generation)).toEqual(["/push"]);
    // The person presses "try another method": the list of methods, in a new document.
    open("/options");
    await h.hello({ documentId: "options" }, false);
    await until(() => judgedPaths(generation).length === 2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(judgedPaths(generation)).toEqual(["/push", "/options"]);
    // A watched login presses no button the judge learned there.
    expect(clicks("Authenticator app")).toBe(0);
    expect(status()![0]).toMatchObject({ state: "watching" });
    // The service now serves revision 2, which has no totp handler, so the code page is judged.
    h.recipes.recipe.mockResolvedValue(chosen);
    // The person chooses the authenticator app: its code page, in a new document.
    open("/otp", true);
    await h.hello({ documentId: "otp" }, false);
    await until(() => codeFills().length > 0);
    expect(judgedPaths(generation)).toEqual(["/push", "/options", "/otp"]);
    expect(codeFills()).toHaveLength(1);
    expect(handlerReports(report)).toContainEqual([1, "totp", "entered"]);
    await until(() => clicks("verify") === 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(codeFills()).toHaveLength(1);
  });

  it("types the code with the handler a later login already has, without judging the code page", async () => {
    vi.useFakeTimers();
    const { h, report, generation } = start(async (...args) => {
      args[4]?.();
      return { verdict: "challenge" };
    });
    h.recipes.recipe.mockResolvedValue(coded);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    open("/options");
    await h.hello({ documentId: "options" }, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clicks("Authenticator app")).toBe(0);
    const judged = generation.judge.mock.calls.length;
    open("/otp", true);
    await h.hello({ documentId: "otp" }, false);
    await until(() => codeFills().length > 0);
    expect(generation.judge).toHaveBeenCalledTimes(judged);
    expect(judgedPaths(generation)).not.toContain("/otp");
    expect(codeFills()).toHaveLength(1);
    expect(handlerReports(report)).toContainEqual([1, "totp", "entered"]);
    await until(() => clicks("verify") === 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(codeFills()).toHaveLength(1);
  });

  const appAuth = {
    kind: "totp" as const,
    path: "/app-auth",
    field: target("authenticationCode"),
    target: target("submit"),
  };
  const appCoded = parseLoginRecipe({ ...plain, revision: 2, handlers: [appAuth] });

  it("judges a code page with only a plain text code input and types the code it learns", async () => {
    vi.useFakeTimers();
    const { h, report, generation } = start(async (...args) => {
      args[4]?.();
      const { path } = args[3] as { path: string };
      if (path === "/app-auth") return { verdict: "challenge", recipe: appCoded };
      return { verdict: "challenge" };
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    // No sign of a sign-in going on: the page is judged as any such page, and the `totp`
    // handler the judge learns on a page that names an authenticator app is taken over.
    open("/app-auth", true, true);
    await h.hello({ documentId: "app-auth" }, false);
    await until(() => codeFills().length > 0);
    expect(judgedPaths(generation)).toEqual(["/push", "/app-auth"]);
    expect(codeFills()).toHaveLength(1);
    expect(handlerReports(report)).toContainEqual([0, "totp", "entered"]);
    expect(
      report.mock.calls.some(
        ([value]) => value.type === "judge" && value.watched === true && value.takenOver === true,
      ),
    ).toBe(true);
    await until(() => clicks("submit") === 1);
  });

  it("types the code with a known handler on a page with only a plain text code input", async () => {
    vi.useFakeTimers();
    const { h, report, generation } = start(async (...args) => {
      args[4]?.();
      return { verdict: "challenge" };
    });
    h.recipes.recipe.mockResolvedValue(appCoded);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    const judged = generation.judge.mock.calls.length;
    open("/app-auth", true, true);
    await h.hello({ documentId: "app-auth" }, false);
    await until(() => codeFills().length > 0);
    expect(generation.judge).toHaveBeenCalledTimes(judged);
    expect(handlerReports(report)).toContainEqual([0, "totp", "entered"]);
    await until(() => clicks("submit") === 1);
  });

  it("takes over no code handler on a plain page whose words name no authenticator app", async () => {
    vi.useFakeTimers();
    const { h, report, generation } = start(async (...args) => {
      args[4]?.();
      const { path } = args[3] as { path: string };
      if (path === "/app-auth") return { verdict: "challenge", recipe: appCoded };
      return { verdict: "challenge" };
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    open("/app-auth", true, true);
    fake.state.extracted = {
      "signed-in": {
        ok: true,
        observation: {
          version: 1,
          origin,
          path: "/app-auth",
          language: "en",
          complete: true,
          headings: ["Verify it's you"],
          candidates: (pages["/app-auth"]!.observation as { candidates: unknown[] }).candidates,
        },
      },
    };
    await h.hello({ documentId: "app-auth" }, false);
    await until(() => judgedPaths(generation).length === 2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(codeFills()).toEqual([]);
    expect(
      report.mock.calls.some(([value]) => value.type === "judge" && value.takenOver === true),
    ).toBe(false);
  });
});
