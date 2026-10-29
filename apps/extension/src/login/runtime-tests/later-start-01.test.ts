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
import { createRecipeRepairs } from "../repair";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import { laterReadiness } from "../wire";
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
  savedBinding,
  otherItemId,
  uriMatch,
  harness,
} = createRuntimeTestHarness(fake);

describe("a login that starts at a later step its page shows (ADR 0049)", () => {
  afterEach(() => {
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
    fake.state.pageUrl = "https://login.example/signin/pwd";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin/pwd";
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
  });
  const twoPages = (passwordPath = "/signin/pwd", id = recipe.id) =>
    parseLoginRecipe({
      ...recipe,
      id,
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          path: "/signin/id",
          fields: [{ slot: "username", target: target("email") }],
        },
        { kind: "click", path: "/signin/id", target: target("next"), purpose: "advance" },
        {
          kind: "fill",
          path: passwordPath,
          fields: [{ slot: "password", target: target("password") }],
        },
        { kind: "click", path: passwordPath, target: target("login"), purpose: "submit" },
      ],
      maxSubmissions: 2,
    });
  const bindingOf = (used: LoginRecipe): SavedLoginBinding => ({
    ...savedBinding,
    recipeId: used.id,
    slots: used.slots.map((slot) => ({ slot, field: slot as "username" | "password" })),
  });
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
  const shows = (shown: string[]) => {
    fake.state.present = new Set(shown);
    fake.state.awaitReply = (readiness) => ({
      ok: (readiness as unknown as { targets: { value: string }[] }).targets.every((entry) =>
        fake.state.present!.has(entry.value),
      ),
    });
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "click" || step.purpose !== "submit") return;
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["authenticated"]);
    };
  };
  function start(
    recipes: LoginRecipe[],
    overrides: Partial<LocalSettings> = {},
    reports: LoginReport[] = [],
    live: Parameters<typeof harness>[1] = {},
  ) {
    const h = harness(
      { bindings: recipes.map(bindingOf), ...overrides },
      { username: true, report: (entry) => reports.push(entry), ...live },
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "me@example.com" : "synthetic-secret",
    );
    const at = (path: string) => recipes.filter((used) => used.steps[0]!.path === path);
    h.recipes.recipe.mockImplementation(async (_origin, path) =>
      at(path).length === 1 ? at(path)[0] : undefined,
    );
    h.recipes.starts.mockResolvedValue(
      recipes.map((used) => ({
        path: used.steps[0]!.path,
        steps: [used.steps[0]!],
        later: laterStartSteps(used).map(laterReadiness),
      })),
    );
    const later = vi.fn(async (_origin: string, path: string) =>
      recipes.filter((used) => laterStartSteps(used).some(({ step }) => step.path === path)),
    );
    Object.assign(h.recipes, { later });
    return { h, reports, later };
  }
  it("keeps the item the page's own value picked for the login's next document", async () => {
    // ADR 0028 amendment of 2026-10-23: the email page's value picks the other item; the
    // password page, a new document without that input, logs in with it too.
    fake.state.siteAccount = { ok: true, index: 1 };
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    const used = twoPages();
    shows(["email", "next"]);
    const submitted = fake.state.onExecute!;
    const { h, reports } = start([used], { siteDefaults: [], bindings: [] }, [], {
      allowedOrigins: [],
      otherUsername: true,
      uris: async () => ({
        ok: true,
        data: uriMatch({
          candidates: [
            { itemId, matches: [{ uriIndex: 0, match: 0 }] },
            { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
          ],
        }),
      }),
    });
    h.fields.mockImplementation(async ({ account, fieldId }) =>
      fieldId === "login.username"
        ? account.itemId === itemId
          ? "a@example.com"
          : "b@example.com"
        : "synthetic-secret",
    );
    h.recipes.recipe.mockResolvedValue(used);
    fake.state.onExecute = async (message, tabId) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "next") {
        fake.state.observedPath = "/signin/pwd";
        fake.state.pageUrl = "https://login.example/signin/pwd";
        fake.state.present = new Set(["password", "login"]);
        fake.state.gone.add("synthetic-document");
        setTimeout(() => void h.hello({ documentId: "password-page" }, false), 0);
        return;
      }
      await submitted(message, tabId);
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 10_000,
    });
    expect(executed()).toEqual(["fill:email", "click:next", "fill:password", "click:login"]);
    const passwords = h.fields.mock.calls
      .filter(([request]) => request.fieldId === "login.password")
      .map(([request]) => request.account.itemId);
    expect(passwords.length).toBeGreaterThan(0);
    expect(passwords.every((id) => id === otherItemId)).toBe(true);
    // The page was asked once, and the choice was never saved.
    expect(fake.state.messages.filter((entry) => entry.type === "login.site.account")).toHaveLength(
      1,
    );
    expect(reports).toContainEqual(
      expect.objectContaining({ type: "start", account: "site-value", itemId: otherItemId }),
    );
    expect(h.settings.settings.siteDefaults).toEqual([]);
  }, 20_000);
  describe("a generated layout whose later step no longer shows (ADR 0041)", () => {
    const layoutOf = (passwordPath: string) =>
      parseLoginRecipe({
        ...twoPages(passwordPath, `gen-${"c".repeat(32)}`),
        layout: "1000",
      });
    const used = layoutOf("/signin/pwd");
    async function redesigned(signs: Record<string, boolean>, passwordPath = "/signin/pwd") {
      const layout = layoutOf(passwordPath);
      fake.state.pageUrl = "https://login.example/signin/id";
      fake.state.observedPath = "/signin/id";
      shows(["email", "next"]);
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind !== "click" || step.target.value !== "next") return;
        fake.state.observedPath = passwordPath;
        fake.state.pageUrl = `https://login.example${passwordPath}`;
        fake.state.present = new Set(["passcode", "go"]);
        if (passwordPath === "/signin/id") return;
        // The password page loads as the next document.
        fake.state.gone.add("synthetic-document");
        setTimeout(() => void h.hello({ documentId: "password-page" }, false), 0);
      };
      const generate = vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "abstained",
        reason: "ambiguous",
      }));
      const repairs = createRecipeRepairs({
        read: async () => fake.state.storage["repairs"],
        write: async (value) => {
          fake.state.storage["repairs"] = value;
        },
      });
      const { h, reports } = start([layout], {}, [], {
        uris: vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() })),
        custom: [],
        generation: {
          available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
          generate,
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
        repairs,
      });
      fake.state.signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
        ...signs,
      };
      // The attempt's next document finds its recipe by its ID.
      h.recipes.recipe.mockResolvedValue(layout);
      fake.state.extracted = {
        login: {
          ok: true,
          observation: {
            version: 1,
            origin,
            path: passwordPath,
            language: "en",
            complete: true,
            candidates: [
              { id: "c1", role: "password", target: target("passcode") },
              { id: "c2", role: "button", target: target("go"), label: "Sign in" },
            ],
          },
        },
      };
      expect(await h.hello()).toEqual({ ok: true });
      // The advance is never confirmed, and the page settles as unknown once the step's
      // wait ran out.
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ outcome: "unknown-submit", settled: true }]),
        { timeout: 20_000 },
      );
      return { generate, reports };
    }
    it("sends the password page it reached for repair", async () => {
      const { generate, reports } = await redesigned({ password: true });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          repair: { recipeId: used.id, revision: 1, layout: "1000", step: 2 },
        }),
        expect.any(Function),
      );
      // A later step keeps its layout's page kind, so it carries no hint (ADR 0035).
      expect(generate.mock.calls[0]![0]).not.toHaveProperty("signedIn");
      expect(reports.filter((entry) => entry.type === "repair")).toEqual([
        expect.objectContaining({ recipeId: used.id, outcome: "due" }),
      ]);
      // The model abstained, which holds the recipe for the day.
      await vi.waitFor(() =>
        expect(fake.state.storage["repairs"]).toMatchObject({
          recipes: [{ recipeId: used.id, held: expect.any(Number) }],
        }),
      );
    }, 30_000);
    it("sends a single-URL form's password step that never showed (owner, 2026-10-23 12:51 UTC)", async () => {
      const { generate } = await redesigned({ password: true }, "/signin/id");
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          observation: expect.objectContaining({ path: "/signin/id" }),
          repair: { recipeId: used.id, revision: 1, layout: "1000", step: 2 },
        }),
        expect.any(Function),
      );
    }, 30_000);
    it.each([
      ["shows no password input", {}],
      ["asks for a CAPTCHA", { password: true, captcha: true }],
    ])(
      "sends nothing for a page that %s",
      async (_, signs) => {
        const { generate, reports } = await redesigned(signs);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(generate).not.toHaveBeenCalled();
        expect(reports.filter((entry) => entry.type === "repair")).toEqual([]);
      },
      30_000,
    );
  });
  it("logs in from the password page a site shows for the account it remembers", async () => {
    shows(["password", "login"]);
    const used = twoPages();
    const { h, reports } = start([used]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(executed()).toEqual(["fill:password", "click:login"]);
    expect(status()![0]).toMatchObject({ stepCount: 4, startStep: 2, submissions: 1 });
    expect(reports.find((entry) => entry.type === "start")).toMatchObject({ startStep: 2 });
    // The password fill names the account, so a page showing another one stops it.
    expect(fake.state.messages.find((entry) => entry.type === "login.execute")?.account).toEqual({
      username: "me@example.com",
    });
  });
  it("starts on the same path at the step that shows, as a page that keeps its path", async () => {
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    shows(["password", "login"]);
    const used = twoPages("/signin/id");
    const { h } = start([used]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(executed()).toEqual(["fill:password", "click:login"]);
    expect(status()![0]).toMatchObject({ startStep: 2 });
  });
  it("starts at the first step while it shows, also beside the later one", async () => {
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    shows(["email", "next", "password", "login"]);
    const used = twoPages("/signin/id");
    const { h, reports } = start([used]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executed().length).toBeGreaterThanOrEqual(2));
    expect(executed().slice(0, 2)).toEqual(["fill:email", "click:next"]);
    expect(status()![0]!["startStep"]).toBeUndefined();
    expect(reports.find((entry) => entry.type === "start")!).not.toHaveProperty("startStep");
  });
  it("starts no login at the later step of a page a passkey from Pateat signed in until its window ends", async () => {
    vi.setTimerTickMode("manual");
    shows(["password", "login"]);
    const { h } = start([twoPages()]);
    h.login.passkeyAnswered(1, origin, "login.example", undefined, {
      incognito: false,
      documentId: "synthetic-document",
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "passkey-signed-in" });
    expect(executed()).toEqual([]);
    // The password page still shows once the 15 seconds end: it announces again and logs in
    // from there.
    fake.state.onReconnect = () => h.hello();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.state.reconnects).toEqual([
      { tabId: 1, frameId: 0, documentId: "synthetic-document" },
    ]);
    vi.setTimerTickMode("nextTimerAsync");
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", startStep: 2 }]),
    );
    expect(executed()).toEqual(["fill:password", "click:login"]);
  });
  it("starts neither recipe when two recipes' later steps show", async () => {
    shows(["password", "login"]);
    const { h } = start([twoPages(), twoPages("/signin/pwd", "synthetic-other")]);
    expect(await h.hello()).toMatchObject({ ok: false });
    expect(executed()).toEqual([]);
    expect(status()).toBeUndefined();
  });
  it("asks the document again when the step that announced it no longer shows", async () => {
    shows([]);
    const { h } = start([twoPages()]);
    expect(await h.hello()).toEqual({ ok: false, reason: "stale-document" });
    expect(executed()).toEqual([]);
  });
  it("only fills the later step for the default after a rejected login", async () => {
    // The site rejected this tab's login (ADR 0021 D); the item is the site default.
    fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
    shows(["password", "login"]);
    const { h, reports } = start([twoPages()]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(reports.at(-1)).toMatchObject({
        type: "refused",
        reason: "account-asked",
        detail: "rejected",
      }),
    );
    expect(executed()).toEqual(["fill:password"]);
    expect(reports.find((entry) => entry.type === "start")).toMatchObject({
      fillOnly: true,
      startStep: 2,
    });
  });
  it("only fills the later step a single-page app shows after its filled first step", async () => {
    // The site rejected this tab's login; the sign-in app keeps one document for both pages.
    fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    shows(["email", "next"]);
    const { h, reports } = start([twoPages()]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(reports.at(-1)).toMatchObject({
        type: "refused",
        reason: "account-asked",
        detail: "rejected",
      }),
    );
    expect(executed()).toEqual(["fill:email"]);
    // The person presses Next; the same document moves to the password page in place.
    fake.state.pageUrl = "https://login.example/signin/pwd";
    fake.state.observedPath = "/signin/pwd";
    shows(["password", "login"]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executed()).toEqual(["fill:email", "fill:password"]));
    expect(reports.filter((entry) => entry.type === "start").at(-1)).toMatchObject({
      fillOnly: true,
      startStep: 2,
    });
  });
  it("logs in at the later step a single-page app shows when the popup picks the account", async () => {
    fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    shows(["email", "next"]);
    const { h, reports } = start([twoPages()]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(reports.at(-1)).toMatchObject({
        type: "refused",
        reason: "account-asked",
        detail: "rejected",
      }),
    );
    // The document announces again once the fill ended, then shows the password page in
    // place without announcing it.
    expect(await h.hello({}, false)).toMatchObject({ ok: false, reason: "form-not-ready" });
    fake.state.pageUrl = "https://login.example/signin/pwd";
    fake.state.observedPath = "/signin/pwd";
    shows(["password", "login"]);
    fake.state.onReconnect = () => h.hello();
    const picked = await h.login.handle(
      {
        version: 1,
        type: "login.choice.pick",
        tabId: 1,
        documentId: "synthetic-document",
        connectionId,
        itemId,
        makeDefault: false,
      },
      {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never,
    );
    expect(picked).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(executed().slice(-2)).toEqual(["fill:password", "click:login"]);
    expect(status()![0]).toMatchObject({ startStep: 2 });
  });
  it("logs in again at the later step shown again after this tab's login", async () => {
    shows(["password", "login"]);
    const { h, reports } = start([twoPages()]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    // The site logs out and shows the password page of the account it remembers: the tab
    // logs in again from there (ADR 0049, ADR 0062).
    shows(["password", "login"]);
    fake.state.observedPath = "/signin/pwd";
    expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([
        { state: "authenticated", document: { documentId: "synthetic-document-2" } },
      ]),
    );
    expect(executed()).toEqual(["fill:password", "click:login", "fill:password", "click:login"]);
    expect(reports.filter((entry) => entry.type === "start")).toEqual([
      expect.objectContaining({ startStep: 2 }),
      expect.objectContaining({ startStep: 2 }),
    ]);
  });
  it("starts at the later step beside the start page's passkey button for a password", async () => {
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    // A page that shows its passkey button at each stage, here beside the password input of
    // the account it remembers; the item holds a password and no passkey.
    shows(["password", "login", "passkey"]);
    const used = parseLoginRecipe({
      ...twoPages("/signin/id"),
      passkey: { path: "/signin/id", target: target("passkey") },
    });
    const { h, reports } = start([used]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(executed()).toEqual(["fill:password", "click:login"]);
    expect(status()![0]).toMatchObject({ route: "password", startStep: 2 });
    expect(reports.find((entry) => entry.type === "start")).toMatchObject({
      route: "password",
      startStep: 2,
    });
  });
  it("presses the passkey button beside the later step for an item with a passkey", async () => {
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    shows(["password", "login", "passkey"]);
    const used = parseLoginRecipe({
      ...twoPages("/signin/id"),
      passkey: { path: "/signin/id", target: target("passkey") },
    });
    const passkeys = vi.fn(async () => ({ passkey: true, discoverable: true }));
    const { h } = start([used], {}, [], { passkeys });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executed()).toEqual(["click:passkey"]));
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(status()![0]!["startStep"]).toBeUndefined();
  });
  it("still starts at the passkey button when it shows alone", async () => {
    fake.state.pageUrl = "https://login.example/signin/id";
    fake.state.observedPath = "/signin/id";
    shows(["passkey"]);
    const used = parseLoginRecipe({
      ...twoPages("/signin/id"),
      passkey: { path: "/signin/id", target: target("passkey") },
    });
    const passkeys = vi.fn(async () => ({ passkey: true, discoverable: true }));
    const { h } = start([used], {}, [], { passkeys });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executed()).toEqual(["click:passkey"]));
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(status()![0]!["startStep"]).toBeUndefined();
  });
  it("starts nothing while the page shows a signed-in marker, as a password prompt in an app", async () => {
    // The app asks for the password again before a sensitive action, on the path of the
    // recipe's password step, and still shows the recipe's signed-in marker.
    shows(["password", "login", "authenticated"]);
    const { h } = start([twoPages()]);
    expect(await h.hello()).toEqual({ ok: false, reason: "stale-document" });
    expect(executed()).toEqual([]);
    expect(status()).toBeUndefined();
  });
  describe("layouts of one recipe (ADR 0060)", () => {
    const otherForm = (layout: string, completion = "authenticated") =>
      parseLoginRecipe({
        ...twoPages(),
        layout,
        completion: [{ target: target(completion) }],
        steps: [
          ...twoPages().steps.slice(0, 2),
          {
            kind: "fill",
            path: "/signin/pwd",
            fields: [{ slot: "password", target: target("passcode") }],
          },
          { kind: "click", path: "/signin/pwd", target: target("continue"), purpose: "submit" },
        ],
      });
    const laid = (layouts: LoginRecipe[]) => {
      const { h, reports, later } = start([layouts[0]!]);
      later.mockResolvedValue(layouts);
      Object.assign(h.recipes, {
        layouts: vi.fn(async () =>
          layouts.map((layout) => ({ recipe: layout, createdAt: Number(layout.layout) })),
        ),
        layoutsOf: vi.fn(async () => layouts),
      });
      return { h, reports };
    };
    it("starts the one whose later steps show, as one recipe", async () => {
      shows(["passcode", "continue"]);
      const first = parseLoginRecipe({ ...twoPages(), layout: "1000" });
      const { h, reports } = laid([first, otherForm("2000")]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed()).toEqual(["fill:passcode", "click:continue"]));
      expect(status()![0]).toMatchObject({ layout: "2000", startStep: 2 });
      expect(reports.find((entry) => entry.type === "start")).toMatchObject({ layout: "2000" });
    });
    it("starts the newest of two whose later steps show as much", async () => {
      shows(["password", "login", "passcode", "continue"]);
      const first = parseLoginRecipe({ ...twoPages(), layout: "1000" });
      const { h, reports } = laid([first, otherForm("2000")]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed().length).toBeGreaterThanOrEqual(1));
      expect(executed()[0]).toBe("fill:passcode");
      expect(reports.find((entry) => entry.type === "start")).toMatchObject({
        layout: "2000",
        layouts: 2,
      });
    });
    it("starts nothing while the page shows another layout's signed-in marker", async () => {
      shows(["password", "login", "dashboard"]);
      const first = parseLoginRecipe({ ...twoPages(), layout: "1000" });
      const { h } = laid([first, otherForm("2000", "dashboard")]);
      expect(await h.hello()).toEqual({ ok: false, reason: "stale-document" });
      expect(executed()).toEqual([]);
      expect(status()).toBeUndefined();
    });
    describe("where the layouts part after the email page (ADR 0060)", () => {
      const original = parseLoginRecipe({ ...twoPages(), layout: "1000" });
      const onEmail = (
        layouts: LoginRecipe[],
        afterNext: string[],
        { nextPath = "/signin/pwd", newDocument = false } = {},
      ) => {
        fake.state.pageUrl = "https://login.example/signin/id";
        fake.state.observedPath = "/signin/id";
        shows(["email", "next"]);
        // A step's elements that do not show run out its wait.
        fake.state.awaitReply = (readiness) =>
          (readiness as unknown as { targets: { value: string }[] }).targets.every((entry) =>
            fake.state.present!.has(entry.value),
          )
            ? { ok: true }
            : { ok: false, reason: "timeout" };
        fake.state.onExecute = async (message) => {
          const step = (message["operation"] as { step: LoginStep }).step;
          if (step.kind !== "click") return;
          if (step.purpose === "advance") {
            fake.state.observedPath = nextPath;
            fake.state.pageUrl = `https://login.example${nextPath}`;
            fake.state.present = new Set(afterNext);
            if (newDocument) await new Promise(() => undefined);
            return;
          }
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["authenticated"]);
        };
        const { h, reports } = laid(layouts);
        // A resumed login asks for its own layout by ID.
        h.recipes.recipe.mockImplementation(
          async (_origin: string, path: string, id?: string, layout?: string) =>
            id === undefined
              ? path === "/signin/id"
                ? layouts.at(-1)
                : undefined
              : layouts.find((entry) => entry.layout === layout),
        );
        return { h, reports };
      };
      const inPlace = (layout: string, field: string, button: string) =>
        parseLoginRecipe({
          ...twoPages("/signin/id"),
          layout,
          steps: [
            ...twoPages("/signin/id").steps.slice(0, 2),
            {
              kind: "fill",
              path: "/signin/id",
              fields: [{ slot: "password", target: target(field) }],
            },
            { kind: "click", path: "/signin/id", target: target(button), purpose: "submit" },
          ],
        });
      const switches = (reports: LoginReport[]) =>
        reports.filter((entry) => entry.type === "attempt" && entry.layoutFrom !== undefined);
      it("goes on with the layout whose password page shows, and logs the switch", async () => {
        const { h, reports } = onEmail([original, otherForm("2000")], ["password", "login"]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({ layout: "2000" });
        expect(executed()).toEqual(["fill:email", "click:next", "fill:password", "click:login"]);
        expect(status()![0]).toMatchObject({ layout: "1000", stepCount: 4, submissions: 2 });
        expect(switches(reports)).toEqual([
          expect.objectContaining({ branch: "1000", layoutFrom: "2000", stepIndex: 2 }),
        ]);
      });
      it("keeps its own layout while its own password page shows", async () => {
        const { h, reports } = onEmail(
          [original, otherForm("2000")],
          ["passcode", "continue", "password", "login"],
        );
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
        expect(executed()).toEqual(["fill:email", "click:next", "fill:passcode", "click:continue"]);
        expect(status()![0]).toMatchObject({ layout: "2000" });
        expect(switches(reports)).toEqual([]);
      });
      it("resumes the layout it switched to in the next document", async () => {
        const { h } = onEmail([original, otherForm("2000")], [], { newDocument: true });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executed()).toEqual(["fill:email", "click:next"]));
        // The password page loads as a new document of the tab.
        fake.state.present = new Set(["password", "login"]);
        // Its submit loads the next document.
        fake.state.onExecute = async (message) => {
          const step = (message["operation"] as { step: LoginStep }).step;
          if (step.kind === "click") await new Promise(() => undefined);
        };
        expect(await h.hello({ documentId: "synthetic-document-2" }, false)).toMatchObject({
          ok: true,
        });
        await vi.waitFor(() =>
          expect(executed()).toEqual(["fill:email", "click:next", "fill:password", "click:login"]),
        );
        expect(h.recipes.recipe).toHaveBeenCalledWith(origin, "/signin/pwd", recipe.id, "2000");
        expect(status()![0]).toMatchObject({ layout: "1000", stepIndex: 3 });
        // The page after the password's submit resumes the layout the login switched to.
        fake.state.observedPath = "/home";
        fake.state.pageUrl = "https://login.example/home";
        fake.state.present = new Set(["authenticated"]);
        await h.hello({ documentId: "synthetic-document-3" }, false);
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
        expect(h.recipes.recipe).toHaveBeenLastCalledWith(origin, "/home", recipe.id, "1000");
      });
      it("switches on the email page's own path only by elements the advance made ready", async () => {
        const { h, reports } = onEmail(
          [inPlace("1000", "password", "login"), inPlace("2000", "passcode", "continue")],
          ["password", "login"],
          { nextPath: "/signin/id" },
        );
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
        expect(executed()).toEqual(["fill:email", "click:next", "fill:password", "click:login"]);
        expect(switches(reports)).toHaveLength(1);
        // Next measured the other layout's password form just before it.
        const next = fake.state.messages.find(
          (entry) =>
            entry.type === "login.execute" &&
            (entry as unknown as { operation: { stepIndex: number } }).operation.stepIndex === 1,
        ) as unknown as { siblings?: unknown[] };
        expect(next.siblings).toEqual([
          { require: "described-writable", targets: [target("password")] },
        ]);
      });
      it("does not switch on its path to a form that showed before the advance", async () => {
        const { h, reports } = onEmail(
          [inPlace("1000", "password", "login"), inPlace("2000", "passcode", "continue")],
          [],
          { nextPath: "/signin/id" },
        );
        // The email page shows the original layout's password input once the email is in.
        fake.state.onExecute = async (message) => {
          const step = (message["operation"] as { step: LoginStep }).step;
          fake.state.present = new Set(
            step.kind === "fill" ? ["email", "next", "password"] : ["email", "password", "login"],
          );
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ outcome: "unknown-submit" }]));
        expect(executed()).toEqual(["fill:email", "click:next"]);
        expect(switches(reports)).toEqual([]);
        expect(status()![0]).toMatchObject({ layout: "2000" });
      });
      it("does not switch to a layout the account's binding does not cover", async () => {
        // The original password page also asks for a code, which the saved binding lacks.
        const coded = parseLoginRecipe({
          ...original,
          slots: ["username", "password", "totp"],
          steps: [
            ...original.steps.slice(0, 2),
            {
              kind: "fill",
              path: "/signin/pwd",
              fields: [
                { slot: "password", target: target("password") },
                { slot: "totp", target: target("code") },
              ],
            },
            original.steps[3]!,
          ],
        });
        // The binding is saved for the first layout listed, the newer one here.
        const { h, reports } = onEmail([otherForm("2000"), coded], ["password", "code", "login"]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ outcome: "unknown-submit" }]));
        expect(executed()).toEqual(["fill:email", "click:next"]);
        expect(switches(reports)).toEqual([]);
        expect(status()![0]).toMatchObject({ layout: "2000" });
      });
      it("does not switch to a step that needs no element of the page", async () => {
        // The original layout waits for a banner to go before its button; nothing on the page
        // shows that it is the original's.
        const waiting = parseLoginRecipe({
          ...original,
          steps: [
            ...original.steps.slice(0, 3),
            {
              kind: "wait",
              path: "/signin/pwd",
              target: target("banner"),
              present: false,
              timeoutMs: 1000,
            },
            original.steps[3]!,
          ],
        });
        const continued = parseLoginRecipe({
          ...original,
          layout: "2000",
          steps: [
            ...original.steps.slice(0, 3),
            { kind: "click", path: "/signin/pwd", target: target("continue"), purpose: "submit" },
          ],
        });
        const { h, reports } = onEmail([waiting, continued], ["password"]);
        expect(await h.hello()).toEqual({ ok: true });
        // The button never shows, so the step fails as before, after its retries.
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "retry-limit" }]),
        );
        expect(executed()).toEqual(["fill:email", "click:next", "fill:password"]);
        expect(switches(reports)).toEqual([]);
        expect(status()![0]).toMatchObject({ layout: "2000" });
      });
      it("switches at a step it waits for when only the other layout's shows", async () => {
        // The layouts part at the password page's button: the newer one presses Continue.
        const continued = parseLoginRecipe({
          ...original,
          layout: "2000",
          steps: [
            ...original.steps.slice(0, 3),
            { kind: "click", path: "/signin/pwd", target: target("continue"), purpose: "submit" },
          ],
        });
        const { h, reports } = onEmail([original, continued], ["password", "login"]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
        expect(executed()).toEqual(["fill:email", "click:next", "fill:password", "click:login"]);
        expect(switches(reports)).toEqual([
          expect.objectContaining({ branch: "1000", layoutFrom: "2000", stepIndex: 3 }),
        ]);
      });
    });
  });
  it("still starts beside a marker whose missing elements show, as ADR 0029 reads it", async () => {
    // The marker was learned on a page that signs in on its own path, so it proves a sign-in
    // only while the password input is gone.
    shows(["password", "login", "authenticated"]);
    const used = parseLoginRecipe({
      ...twoPages(),
      completion: [{ target: target("authenticated"), absent: [target("password")] }],
    });
    const { h } = start([used]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executed()).toEqual(["fill:password", "click:login"]));
    expect(status()![0]).toMatchObject({ startStep: 2 });
  });
  it("starts the recipe whose first step shows over another recipe's later step", async () => {
    shows(["password", "login"]);
    // Generated before ADR 0049 for the password page shown alone.
    const own = parseLoginRecipe({
      ...recipe,
      id: "synthetic-password-page",
      slots: ["password"],
      steps: [
        {
          kind: "fill",
          path: "/signin/pwd",
          fields: [{ slot: "password", target: target("password") }],
        },
        { kind: "click", path: "/signin/pwd", target: target("login"), purpose: "submit" },
      ],
    });
    const { h, reports } = start([twoPages(), own]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ recipeId: own.id, stepCount: 2 });
    expect(executed()).toEqual(["fill:password", "click:login"]);
    expect(status()![0]!["startStep"]).toBeUndefined();
    expect(reports.find((entry) => entry.type === "start")).not.toHaveProperty("startStep");
  });
  it("lists the later steps for the document to watch, after the first steps", async () => {
    shows([]);
    const { h } = start([twoPages()]);
    const answer = (await h.hello({}, false)) as { starts?: unknown[] };
    expect(answer.starts).toEqual([
      { path: "/signin/id", require: "writable", targets: [target("email")] },
      { path: "/signin/pwd", require: "writable", targets: [target("password")], later: true },
    ]);
  });
});
