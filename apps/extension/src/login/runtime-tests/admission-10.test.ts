import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginGeneration, LoginReport } from "../runtime";
import { loginReadiness } from "../wire";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  reportedPath,
  origin,
  sender,
  target,
  startsOf,
  recipe,
  uriMatch,
  harness,
  shownHello,
  realTime,
} = createRuntimeTestHarness(fake);

describe("production login document admission", () => {
  afterEach(() => {
    // Close every test's tabs, so no attempt left reconciling answers a later test.
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2, 3, 4]) listener(tabId);
    fake.state.replaced.length = 0;
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
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
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
    fake.state.incognito = new Set();
    fake.state.openTabs = undefined;
  });

  void parseLoginRecipe({
    ...recipe,
    slots: ["branch", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "branch", target: target("branch") },
          { slot: "password", target: target("password") },
        ],
      },
      recipe.steps[1],
    ],
  });

  describe("a recipe with several layouts (ADR 0060)", () => {
    const older = parseLoginRecipe({ ...recipe, layout: "1000" });
    const newer = parseLoginRecipe({
      ...recipe,
      layout: "2000",
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: target("passcode") }],
        },
        { kind: "click", path: "/signin", target: target("continue"), purpose: "submit" },
      ],
    });
    const executes = () =>
      fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
        operation: { step: { kind: string; fields?: { target: unknown }[]; target?: unknown } };
      }[];
    const filled = () => executes()[0]?.operation.step.fields?.[0]?.target;
    const withLayouts = (
      h: ReturnType<typeof harness>,
      layouts: { recipe: typeof recipe; language?: "ja" | "en"; createdAt: number }[],
    ) => {
      const listed = vi.fn(async (at: string, path: string) =>
        at === origin && path === "/signin" ? layouts : [],
      );
      const of = vi.fn(async () => layouts.map((entry) => entry.recipe));
      Object.assign(h.recipes, { layouts: listed, layoutsOf: of });
      // By ID the cache answers the newest layout, or the one asked for.
      h.recipes.recipe.mockImplementation(
        async (at: string, path: string, _id?: string, layout?: string) =>
          at === origin && path === "/signin"
            ? (layouts.find((entry) => entry.recipe.layout === layout)?.recipe ??
              layouts.at(-1)!.recipe)
            : undefined,
      );
      return { listed, of };
    };
    const helloIn = (h: ReturnType<typeof harness>, language?: "ja" | "en") => {
      if (language)
        fake.state.extracted["login"] = {
          ok: true,
          observation: { version: 1, origin, path: "/signin", language, complete: true },
        };
      return h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          start: { path: "/signin" },
        },
        sender(),
      );
    };
    const extracts = () => fake.state.messages.filter((entry) => entry.type === "login.extract");
    it("prefers a layout whose start page shows whole over one that shows more", async () => {
      // The older layout has more elements, a passkey button and a contract-number form
      // that still show, but its own submit button does not; the newer one shows whole.
      const larger = parseLoginRecipe({
        ...recipe,
        layout: "1000",
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "password", target: target("passcode") }],
          },
          { kind: "click", path: "/signin", target: target("old-submit"), purpose: "submit" },
        ],
        passkey: { path: "/signin", target: target("passkey") },
        alternatives: [
          {
            slots: ["contract"],
            steps: [
              {
                kind: "fill",
                path: "/signin",
                fields: [{ slot: "contract", target: target("contract") }],
              },
              { kind: "click", path: "/signin", target: target("old-submit"), purpose: "submit" },
            ],
          },
        ],
      });
      fake.state.present = new Set(["passcode", "passkey", "contract", "continue"]);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      withLayouts(h, [
        { recipe: larger, language: "ja", createdAt: 1000 },
        { recipe: newer, language: "en", createdAt: 500 },
      ]);
      expect(await helloIn(h, "ja")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).not.toEqual([]));
      // The older shows three elements and the newer two, but only the newer misses none:
      // it runs, whatever the language or age.
      expect(
        report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "start"),
      ).toMatchObject({ layout: "2000", layouts: 2 });
      expect(extracts()).toEqual([]);
    });
    it("prefers a layout whose first step shows whole over fewer missing elements", async () => {
      // The newer layout's first step lacks its field; the older one's shows, though its
      // submit button does not.
      fake.state.present = new Set(["password", "continue"]);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      withLayouts(h, [
        { recipe: older, createdAt: 1000 },
        { recipe: newer, createdAt: 2000 },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).not.toEqual([]));
      expect(filled()).toEqual(target("password"));
    });
    it("runs the next layout when the account's plan fails on the first", async () => {
      // The older layout fills a custom field into the same form, which the item does not
      // hold.
      const asking = parseLoginRecipe({
        ...recipe,
        layout: "1000",
        slots: ["PIN"],
        steps: [
          { kind: "fill", path: "/signin", fields: [{ slot: "PIN", target: target("passcode") }] },
          { kind: "click", path: "/signin", target: target("continue"), purpose: "submit" },
        ],
      });
      // Both layouts show whole, and the older one is in the page's language, so it comes
      // first; a layout that fitted the page less would not be tried at all.
      fake.state.present = new Set(["passcode", "continue"]);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      withLayouts(h, [
        { recipe: asking, language: "ja", createdAt: 1000 },
        { recipe: newer, createdAt: 2000 },
      ]);
      expect(await helloIn(h, "ja")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).not.toEqual([]));
      expect(filled()).toEqual(target("passcode"));
      expect(
        report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "start"),
      ).toMatchObject({ layout: "2000", layouts: 2 });
      expect(extracts()).toMatchObject([{ page: "login" }]);
    });
    it("keeps the first layout's refusal when no layout's plan passes", async () => {
      const h = harness({ siteDefaults: [], bindings: [] }, { allowedOrigins: [] });
      withLayouts(h, [
        { recipe: older, createdAt: 1000 },
        { recipe: newer, createdAt: 2000 },
      ]);
      const single = harness({ siteDefaults: [], bindings: [] }, { allowedOrigins: [] });
      single.recipes.recipe.mockResolvedValue(newer);
      const alone = await single.hello({ documentId: "alone" });
      expect(alone).toMatchObject({ ok: false });
      expect(await h.hello()).toEqual(alone);
      expect(executes()).toEqual([]);
    });
  });
  describe("on a page without a recipe", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    const generated = parseLoginRecipe({
      version: 1,
      id: "gen-synthetic",
      revision: 1,
      origin,
      pageKind: "sign-in",
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [
            { slot: "username", target: target("user") },
            { slot: "password", target: target("password") },
          ],
        },
        { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
      ],
      maxSubmissions: 1,
    });
    const page = (path: string, candidates: unknown[]) => ({
      ok: true,
      observation: { version: 1, origin, path, language: "en", complete: true, candidates },
    });
    const loginPage = page("/signin", [
      { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
      { id: "c2", role: "password", target: target("password") },
      { id: "c3", role: "button", target: target("login"), label: "Sign in" },
    ]);
    void page("/home", [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }]);
    function generation(implementation: Partial<LoginGeneration> = {}) {
      return {
        available: vi.fn<LoginGeneration["available"]>(
          implementation.available ?? (async () => true),
        ),
        // Like the service, each says just before the request leaves the device.
        generate: vi.fn<LoginGeneration["generate"]>(async (request, sent) => {
          sent?.();
          return (
            implementation.generate ??
            (async () => ({ outcome: "abstained", reason: "ambiguous" }) as const)
          )(request);
        }),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(async (request, sent) => {
          sent?.();
          return (
            implementation.generateEntry ??
            (async () => ({ outcome: "abstained", reason: "ambiguous" }) as const)
          )(request);
        }),
        judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
          args[4]?.();
          return (implementation.judge ?? (async () => ({ verdict: "unclear" }) as const))(...args);
        }),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(
          implementation.slotFields ?? (async () => undefined),
        ),
      };
    }
    const uris = async () => ({ ok: true as const, data: uriMatch() });
    const status = () => fake.state.storage["pateat.login-attempts.v5"];
    it("sends a matching sign-in page for generation and runs the returned recipe", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      // An item without custom fields offers only built-in slots.
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      // The first announcement only offers generation; nothing reads the vault yet.
      expect(await h.hello({}, false)).toEqual({
        ok: false,
        reason: "recipe-not-found",
        starts: [],
        generate: true,
      });
      expect(h.store.handle).not.toHaveBeenCalled();
      service.generate.mockImplementation(async () => {
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        return { outcome: "recipe", recipe: generated };
      });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
      );
      expect(service.available).toHaveBeenCalledWith(origin, "/signin");
      // Only slots the matching item can fill are offered.
      // The username's shape goes with its slot; the value itself never does.
      expect(service.generate).toHaveBeenCalledWith(
        {
          version: 1,
          observation: loginPage.observation,
          // No marker of the origin and no username shows (ADR 0035).
          signedIn: false,
          slots: [
            expect.objectContaining({
              id: "username",
              kind: "identifier",
              valueShape: { length: 16, classes: ["ascii-letter", "ascii-symbol"], email: false },
            }),
            expect.not.objectContaining({ valueShape: expect.anything() }),
          ],
        },
        expect.any(Function),
      );
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.username"]);
      // The document announces again and starts the generated recipe at once.
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          2,
        ),
      );
      expect(fake.state.messages.find((entry) => entry.type === "login.execute")?.values).toEqual([
        { slot: "username", value: "synthetic-secret" },
        { slot: "password", value: "synthetic-secret", secret: "password" },
      ]);
    });
    it("counts the first page's generation in the login's own times (ADR 0019)", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ reason: "recipe-not-found" });
      const timing = { roundTripMs: 40, serverMs: 30, networkMs: 10, modelMs: 25 };
      service.generate.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        return { outcome: "recipe", recipe: generated, timing };
      });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
      );
      // The request's own timing goes to its log line.
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "generation", outcome: "recipe", timing }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      // The attempt starts after the generation, which its time still holds.
      await vi.waitFor(() =>
        expect(status()).toMatchObject([
          {
            timing: {
              since: expect.any(Number),
              serviceMs: expect.any(Number),
              networkMs: 10,
              personMs: 0,
            },
          },
        ]),
      );
      const [record] = status() as { timing: { serviceMs: number } }[];
      expect(record!.timing.serviceMs).toBeGreaterThanOrEqual(35);
    });
    it("generates a tenant's page under its [id] path and runs it on another tenant's page (ADR 0039)", async () => {
      const tenantPath = "/[id]/oauth2/authorize";
      const tenantPage = page(tenantPath, loginPage.observation.candidates);
      const tenantRecipe = parseLoginRecipe({
        ...generated,
        id: "gen-tenant",
        steps: generated.steps.map((step) => ({ ...step, path: tenantPath })),
      });
      fake.state.pageUrl =
        "https://login.example/123e4567-e89b-12d3-a456-426614174000/oauth2/authorize";
      fake.state.observedPath = tenantPath;
      fake.state.extracted = { login: tenantPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
        urls: true,
      });
      let stored = false;
      // The cache selects a recipe by the path as observations carry it.
      h.recipes.recipe.mockImplementation(async (_origin, path) =>
        stored && path === tenantPath ? tenantRecipe : undefined,
      );
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      service.generate.mockImplementation(async () => {
        stored = true;
        h.recipes.starts.mockResolvedValue(startsOf([tenantRecipe.steps[0]!]));
        return { outcome: "recipe", recipe: tenantRecipe };
      });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
      );
      // The retry window and the request carry the replaced path, never the tenant's ID.
      expect(service.available).toHaveBeenCalledWith(origin, tenantPath);
      expect(service.generate).toHaveBeenCalledWith(
        expect.objectContaining({ observation: tenantPage.observation }),
        expect.any(Function),
      );
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("123e4567");
      // The local log keeps the page's own URL (owner decision 2026-10-13).
      expect(
        report.mock.calls.some(([entry]) => entry.url?.includes("123e4567-e89b") === true),
      ).toBe(true);

      // Another tenant's page starts the same recipe at once, and is not offered again.
      const offered = service.available.mock.calls.length;
      fake.state.pageUrl =
        "https://login.example/89abcdef-0123-4567-89ab-cdef01234567/oauth2/authorize";
      const announced = await h.hello({ documentId: "other-tenant" }, false);
      expect(announced).toMatchObject({ starts: [expect.objectContaining({ path: tenantPath })] });
      expect(announced).not.toHaveProperty("generate");
      expect(await h.hello({ documentId: "other-tenant" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          2,
        ),
      );
      expect(
        fake.state.messages
          .filter((entry) => entry.type === "login.execute")
          .map(
            (entry) => (entry as { operation?: { step: { path: string } } }).operation?.step.path,
          ),
      ).toEqual([tenantPath, tenantPath]);
      expect(service.available).toHaveBeenCalledTimes(offered);
      expect(service.generate).toHaveBeenCalledTimes(1);
    });
    it("logs a page sent for generation, then the answer", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      const generations = () =>
        report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "generation");
      await vi.waitFor(() => expect(generations()).toHaveLength(2));
      expect(generations()).toEqual([
        { type: "generation", tabId: 1, origin, outcome: "sent", signedIn: false },
        {
          type: "generation",
          tabId: 1,
          origin,
          outcome: "abstained",
          reason: "ambiguous",
          signedIn: false,
        },
      ]);
    });
    it("tells generation the page shows a marker the origin's recipes learned (ADR 0035)", async () => {
      fake.state.extracted = { login: loginPage };
      // Another page's recipe of the origin learned the marker, which shows here.
      fake.state.present = new Set(["authenticated"]);
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      const elsewhere = parseLoginRecipe({
        ...recipe,
        id: "gen-elsewhere",
        steps: recipe.steps.map((step) => ({ ...step, path: "/account/login" })),
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      h.recipes.routes.mockResolvedValue([elsewhere]);
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      expect(service.generate.mock.calls[0]![0]).toMatchObject({ signedIn: true });
      expect(fake.state.messages.find((entry) => entry.type === "login.observe")?.targets).toEqual([
        target("authenticated"),
      ]);
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "generation", outcome: "abstained", signedIn: true }),
        ),
      );
    });
    it("tells generation the page shows a matching item's username, which stays on the device (ADR 0035)", async () => {
      fake.state.extracted = { login: loginPage };
      fake.state.signs = (message) => ({
        password: true,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
        username:
          (message["account"] as { username?: string } | undefined)?.username ===
          "synthetic-secret",
      });
      const service = generation();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      expect(service.generate.mock.calls[0]![0]).toMatchObject({ signedIn: true });
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
    });
    it("never sends a page generated as a verification again, nor logs in there (ADR 0035)", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      const confirm = parseLoginRecipe({
        ...generated,
        pageKind: "unclear",
        completion: [{ target: target("account") }],
      });
      // Nothing of the recipe shows yet, so its signed-in marker does not either.
      fake.state.present = new Set();
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      h.recipes.routes.mockResolvedValue([confirm]);
      const confirming = loginReadiness(confirm.steps[0]!);
      const watching = { ok: false, reason: "recipe-not-found", starts: [], confirm: confirming };
      expect(await h.hello({}, false)).toEqual(watching);
      // The document reports the page's first step shown, and whether its form shows an amount.
      expect(
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            shown: { path: reportedPath(fake.state.pageUrl), amount: true },
          },
          sender(),
        ),
      ).toEqual(watching);
      expect(await h.signIn()).toEqual(watching);
      expect(service.available).not.toHaveBeenCalled();
      expect(service.generate).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(
          report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused"),
        ).toEqual([
          {
            type: "refused",
            tabId: 1,
            origin,
            reason: "not-started",
            detail: "confirm-unsupported",
            recipeId: generated.id,
            recipeRevision: generated.revision,
            pageKind: "unclear",
            amount: true,
            e1: false,
            e2: false,
          },
        ]),
      );
      // Only the matching item's username is read, for E2; nothing is filled.
      expect(h.fields.mock.calls.map(([source]) => source.fieldId)).toEqual(["login.username"]);
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual([]);
      // The person submits the page's form; a message from another document counts for nothing.
      const submitted = {
        version: 1,
        type: "login.document.person-submitted",
        token: "synthetic-token",
      };
      await h.login.handle(submitted, sender({ documentId: "other" }));
      await h.login.handle(submitted, sender());
      // Neither E1 nor E2 showed, so the tab's next page is read for E1, here once it renders.
      fake.state.pageUrl = `${origin}/done`;
      await h.hello({ documentId: "done" }, false);
      fake.state.present = new Set(["account"]);
      await vi.waitFor(() =>
        expect(
          report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "confirm-left"),
        ).toEqual([
          {
            type: "confirm-left",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            pageKind: "unclear",
            personSubmitted: true,
            nextE1: true,
          },
        ]),
      );
    });
    it("logs a page Pateat does not fill as left without a next page when its tab closes (ADR 0035)", async () => {
      fake.state.extracted = { login: loginPage };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: generation(),
        report,
      });
      const confirm = parseLoginRecipe({
        ...generated,
        pageKind: "confirm",
        completion: [{ target: target("account") }],
      });
      fake.state.present = new Set();
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      h.recipes.routes.mockResolvedValue([confirm]);
      await h.hello({}, false);
      // Without its first step shown, the page is not logged, nor is its visit.
      fake.state.pageUrl = `${origin}/other`;
      await h.hello({ documentId: "other" }, false);
      fake.state.pageUrl = `${origin}/signin`;
      await h.hello({ documentId: "again" }, false);
      await shownHello(h, { documentId: "again" });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "refused", detail: "confirm-unsupported" }),
        ),
      );
      for (const removed of fake.state.removed) removed(1);
      await vi.waitFor(() =>
        expect(
          report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "confirm-left"),
        ).toEqual([
          {
            type: "confirm-left",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            pageKind: "confirm",
            personSubmitted: false,
          },
        ]),
      );
    });
    function confirmHarness(live: { urls?: boolean; matched?: boolean } = {}) {
      fake.state.extracted = { login: loginPage };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({
          ok: true as const,
          data: live.matched === false ? uriMatch({ candidates: [] }) : uriMatch(),
        }),
        username: true,
        custom: [],
        generation: generation(),
        report,
        ...(live.urls ? { urls: true } : {}),
      });
      const confirm = parseLoginRecipe({
        ...generated,
        pageKind: "confirm",
        completion: [{ target: target("account") }],
      });
      // Nothing of the recipe shows, so neither does its signed-in marker.
      fake.state.present = new Set();
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      h.recipes.routes.mockResolvedValue([confirm]);
      const entries = <T extends LoginReport["type"]>(type: T) =>
        report.mock.calls.flatMap(([entry]) =>
          entry.type === type ? [entry as Extract<LoginReport, { type: T }>] : [],
        );
      /** The page at `url` in a new document, its first step shown, and its entry logged. */
      const visit = async (documentId: string, url = `${origin}/signin`) => {
        const logged = entries("refused").length;
        fake.state.pageUrl = url;
        await h.hello({ documentId }, false);
        await shownHello(h, { documentId });
        await vi.waitFor(() => expect(entries("refused")).toHaveLength(logged + 1), 7_000);
        return entries("refused").at(-1);
      };
      const left = {
        type: "confirm-left",
        tabId: 1,
        origin,
        recipeId: generated.id,
        recipeRevision: generated.revision,
        pageKind: "confirm",
      } as const;
      const refused = {
        type: "refused",
        tabId: 1,
        origin,
        reason: "not-started",
        detail: "confirm-unsupported",
        recipeId: generated.id,
        recipeRevision: generated.revision,
        pageKind: "confirm",
        e1: false,
      } as const;
      return { h, entries, visit, left, refused };
    }
    it("logs the URL of a page Pateat does not fill and of the tab's previous page of its origin only (ADR 0035)", async () => {
      const { h, entries, visit, left, refused } = confirmHarness({ urls: true });
      // The previous page is the same document before its path changed in place.
      fake.state.pageUrl = `${origin}/home?tab=1`;
      await h.hello({ documentId: "home" }, false);
      expect(await visit("home")).toEqual({
        ...refused,
        e2: false,
        url: `${origin}/signin`,
        previousUrl: `${origin}/home?tab=1`,
      });
      // A page of another origin next is no sign-in on this one.
      fake.state.pageUrl = "https://elsewhere.example/";
      await h.hello({ documentId: "elsewhere" }, false);
      await vi.waitFor(() =>
        expect(entries("confirm-left")).toEqual([
          { ...left, personSubmitted: false, nextE1: false, url: `${origin}/signin` },
        ]),
      );
      // Nor is it the previous page of the next one on this origin.
      expect(await visit("back")).toEqual({ ...refused, e2: false, url: `${origin}/signin` });
      // A page Pateat does not admit in between is not read, so it ends the visit without a
      // next page, and the page before it is not the previous page of the one after.
      fake.state.granted = false;
      fake.state.pageUrl = `${origin}/home`;
      expect(await h.hello({ documentId: "blocked" }, false)).toEqual({
        ok: false,
        reason: "unauthorized-document",
      });
      await vi.waitFor(() =>
        expect(entries("confirm-left").at(-1)).toEqual({
          ...left,
          personSubmitted: false,
          url: `${origin}/signin`,
        }),
      );
      fake.state.granted = true;
      expect(await visit("after")).toEqual({ ...refused, e2: false, url: `${origin}/signin` });
      // A discarded tab loads its page again in a new tab, so the page was not left.
      for (const replaced of fake.state.replaced) replaced(5, 1);
      for (let flush = 0; flush < 5; flush++)
        // oxlint-disable-next-line no-await-in-loop -- each turn lets a pending log run
        await new Promise((resolve) => setImmediate(resolve));
      expect(entries("confirm-left")).toHaveLength(2);
    });
    it("reads the next page for E1 without a vault match, but not one that went before its first reading (ADR 0035)", async () => {
      const { h, entries, visit, left, refused } = confirmHarness({ matched: false });
      // E2 is not read without a matching item, so the next page is read for E1.
      expect(await visit("verify")).toEqual(refused);
      const submitted = {
        version: 1,
        type: "login.document.person-submitted",
        token: "synthetic-token",
      };
      // A frame's submit is not the page's.
      await h.login.handle(submitted, sender({ documentId: "verify", frameId: 2 }));
      fake.state.pageUrl = `${origin}/done`;
      await h.hello({ documentId: "done" }, false);
      fake.state.present = new Set(["account"]);
      await vi.waitFor(() =>
        expect(entries("confirm-left")).toEqual([
          { ...left, personSubmitted: false, nextE1: true },
        ]),
      );
      // On the real clock, the next page goes while the page's own readings wait a second.
      realTime();
      fake.state.present = new Set();
      fake.state.pageUrl = `${origin}/signin`;
      await h.hello({ documentId: "again" }, false);
      await shownHello(h, { documentId: "again" });
      // The left page's late submit counts for nothing.
      await h.login.handle(submitted, sender({ documentId: "verify" }));
      fake.state.pageUrl = `${origin}/done`;
      await h.hello({ documentId: "done-again" }, false);
      fake.state.pageUrl = `${origin}/gone`;
      await h.hello({ documentId: "gone" }, false);
      await vi.waitFor(
        () =>
          expect(entries("confirm-left")).toEqual([
            { ...left, personSubmitted: false, nextE1: true },
            { ...left, personSubmitted: false },
          ]),
        3_000,
      );
      expect(entries("refused")).toHaveLength(2);
    });
    it("logs neither E1 nor E2 for a page gone before its first reading, nor reads its next page (ADR 0035)", async () => {
      const { h, entries, left, refused } = confirmHarness();
      // The matching item's username is read slowly, and the person leaves meanwhile.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.fields.mockImplementation(async () => {
        await held;
        return "synthetic-user";
      });
      fake.state.pageUrl = `${origin}/signin`;
      await h.hello({ documentId: "verify" }, false);
      await shownHello(h, { documentId: "verify" });
      await vi.waitFor(() => expect(h.fields).toHaveBeenCalled());
      fake.state.present = new Set(["account"]);
      fake.state.pageUrl = `${origin}/done`;
      await h.hello({ documentId: "done" }, false);
      release();
      await vi.waitFor(() =>
        expect(entries("confirm-left")).toEqual([{ ...left, personSubmitted: false }]),
      );
      const { e1: _unread, ...unread } = refused;
      expect(entries("refused")).toEqual([unread]);
    });
    it("logs a return in place to a page Pateat does not fill as a new visit (ADR 0035)", async () => {
      const { h, entries, visit, left, refused } = confirmHarness({ urls: true });
      expect(await visit("app")).toEqual({ ...refused, e2: false, url: `${origin}/signin` });
      await h.login.handle(
        { version: 1, type: "login.document.person-submitted", token: "synthetic-token" },
        sender({ documentId: "app" }),
      );
      // The same document moves on in place, as the content script announces.
      fake.state.present = new Set(["account"]);
      fake.state.pageUrl = `${origin}/done`;
      await h.hello({ documentId: "app" }, false);
      await vi.waitFor(() =>
        expect(entries("confirm-left")).toEqual([
          { ...left, personSubmitted: true, nextE1: true, url: `${origin}/signin` },
        ]),
      );
      // Back on the page in place: a new visit, whose previous page is the one it left.
      fake.state.present = new Set();
      expect(await visit("app")).toEqual({
        ...refused,
        e2: false,
        url: `${origin}/signin`,
        previousUrl: `${origin}/done`,
      });
      fake.state.pageUrl = `${origin}/home`;
      await h.hello({ documentId: "app" }, false);
      await vi.waitFor(() =>
        expect(entries("confirm-left").at(-1)).toEqual({
          ...left,
          personSubmitted: false,
          nextE1: false,
          url: `${origin}/signin`,
        }),
      );
      expect(entries("confirm-left")).toHaveLength(2);
    });
  });
});
