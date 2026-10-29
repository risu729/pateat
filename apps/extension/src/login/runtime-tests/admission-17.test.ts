import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, sender, target, startsOf, recipe, uriMatch, harness } =
  createRuntimeTestHarness(fake);

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
    const homePage = page("/home", [
      { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
    ]);
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

    it("counts a frame or a secret answer that looks like a verification, never sending it (ADR 0035)", async () => {
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      let matched = true;
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () =>
          matched
            ? { ok: true as const, data: uriMatch() }
            : { ok: true as const, data: uriMatch({ candidates: [] }) },
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      const skips = () =>
        report.mock.calls.flatMap(([value]) =>
          value.type === "generation" && value.outcome === "skipped" ? [value] : [],
        );
      const unoffered = (why: string, from: Record<string, unknown> = {}) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: String(from["token"] ?? "synthetic-token"),
            unoffered: { path: String(from["path"] ?? "/signin"), why },
          },
          sender(from),
        );
      // A page offered for generation that ends its wait with a `type="text"` answer.
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await unoffered("text-answer")).toMatchObject({ generate: true });
      expect(skips()).toEqual([
        { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "text-answer" },
      ]);
      // A frame inside another site's page: asked to report, then counted, never sent.
      fake.state.tabUrls = { 1: "https://top.example/" };
      const frame = {
        frameId: 3,
        documentId: "frame-document",
        token: "frame-token",
        path: "/",
        url: "https://login.example/",
        tab: { id: 1, url: "https://top.example/" },
      };
      expect(
        await h.login.handle(
          { version: 1, type: "login.document.ready", token: "frame-token" },
          sender(frame),
        ),
      ).toEqual({ ok: false, reason: "recipe-not-found", frame: true });
      expect(await unoffered("frame", frame)).toMatchObject({ frame: true });
      expect(skips().at(-1)).toEqual({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "frame",
      });
      // A frame whose page would not be sent now, as one sent recently, is not asked.
      service.available.mockResolvedValueOnce("sent");
      expect(
        await h.login.handle(
          { version: 1, type: "login.document.ready", token: "held-token" },
          sender({ ...frame, documentId: "held-frame", token: "held-token", frameId: 4 }),
        ),
      ).toEqual({ ok: false, reason: "recipe-not-found" });
      // Without a vault match neither counts: the answer is logged as nothing offered.
      matched = false;
      fake.state.tabUrls = {};
      expect(await h.hello({ documentId: "other-page" }, false)).toMatchObject({ generate: true });
      expect(await unoffered("text-answer", { documentId: "other-page" })).toMatchObject({
        generate: true,
      });
      expect(skips().at(-1)).toEqual({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "nothing-offered",
        detail: "text-answer",
      });
      // Right after this tab's password submit, the answer is part of that sign-in: not counted.
      matched = true;
      await h.login.handle(
        { version: 1, type: "login.document.submitted", token: "synthetic-token" },
        sender({ documentId: "other-page" }),
      );
      expect(await h.hello({ documentId: "question" }, false)).toMatchObject({ generate: true });
      await unoffered("text-answer", { documentId: "question" });
      expect(skips().at(-1)).toEqual({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "nothing-offered",
        detail: "after-sign-in",
      });
      expect(skips().filter((skip) => skip.reason === "text-answer")).toHaveLength(1);
      expect(skips().filter((skip) => skip.reason === "frame")).toHaveLength(1);
      expect(service.generate).not.toHaveBeenCalled();
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("offers the page an account switch leads to when no recipe starts on its path", async () => {
      const service = generation();
      const h = harness({}, { uris, username: true, generation: service });
      const switching = parseLoginRecipe({
        ...recipe,
        accountSwitch: { by: "text", value: "Use another account" },
      });
      h.recipes.recipe.mockImplementation(async (_origin, path) =>
        path === "/signin" ? switching : undefined,
      );
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
      );
      fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch"),
      );
      // The switch leads to an email page; the origin's only recipe starts on `/signin`.
      fake.state.pageUrl = "https://login.example/signin/id";
      expect(await h.hello({ documentId: "next-page" }, false)).toEqual({
        ok: false,
        reason: "recipe-not-found",
        starts: [expect.objectContaining({ path: "/signin" })],
        generate: true,
      });
      expect(service.available).toHaveBeenCalledWith(origin, "/signin/id");
    });
    it("offers no page of a tab whose attempt ended without a switch", async () => {
      const service = generation();
      const h = harness({}, { uris, username: true, generation: service });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
      );
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "wrong-account" }]),
      );
      fake.state.pageUrl = "https://login.example/signin/id";
      expect(await h.hello({ documentId: "next-page" }, false)).not.toHaveProperty("generate");
      // Another tab on the same page, without an attempt, is offered.
      expect(await h.hello({ documentId: "other-tab", tab: { id: 2 } }, false)).toMatchObject({
        generate: true,
      });
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("learns the completion from the page after the final submission", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        // The click signs in: the form goes and the next page shows a sign-out button.
        fake.state.present = new Set(["logout"]);
        fake.state.observedPath = "/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledWith(
        generated.id,
        generated.revision,
        "password",
        homePage.observation,
        expect.any(Function),
        undefined,
        undefined,
        undefined,
        expect.any(Array),
      );
      // The automatic choice is saved with its built-in binding once signed in.
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalled());
      expect(h.settings.settings.bindings).toEqual([
        expect.objectContaining({
          recipeId: generated.id,
          slots: [
            { slot: "username", field: "username" },
            { slot: "password", field: "password" },
          ],
        }),
      ]);
    }, 10_000);
    it("spins the tab's icon while the page after the submission is judged", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const stop = vi.fn();
      const spin = vi.fn((_tabId: number) => stop);
      const service = generation({
        judge: async () => {
          expect(stop).not.toHaveBeenCalled();
          return { verdict: "signed-in" };
        },
      });
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        spin,
      });
      h.recipes.recipe.mockResolvedValue(generated);
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        fake.state.present = new Set(["logout"]);
        fake.state.observedPath = "/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(spin.mock.calls).toEqual([[1]]);
      expect(stop).toHaveBeenCalledTimes(1);
    }, 10_000);
    it.each([
      ["rejected", { state: "blocked", outcome: "credential-rejected" }],
      ["challenge", { state: "watching", outcome: "challenge" }],
      ["unclear", { state: "reconciling", outcome: "unknown-submit" }],
    ] as const)(
      "settles a %s judgement without saving the account",
      async (verdict, expected) => {
        fake.state.extracted = { "signed-in": homePage };
        const service = generation({
          judge: async () => ({ verdict, ...(verdict === "unclear" ? { reason: "timeout" } : {}) }),
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([expected]), { timeout: 6_000 });
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(h.store.update).not.toHaveBeenCalled();
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toEqual([
          {
            type: "judge",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            route: "password",
            verdict: "sent",
          },
          {
            type: "judge",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            route: "password",
            verdict,
            ...(verdict === "unclear" ? { reason: "timeout" } : {}),
          },
        ]);
        // The log's last word on the login: it ended, or its result settled as unknown.
        expect(report.mock.calls.at(-1)![0]).toMatchObject({
          type: "attempt",
          ...expected,
          ...(verdict === "unclear" ? { settled: true } : {}),
        });
        expect(
          report.mock.calls.filter(([value]) => value.type === "attempt" && value.settled),
        ).toHaveLength(verdict === "unclear" ? 1 : 0);
      },
      10_000,
    );
    it.each([
      [
        "an incomplete description",
        { ...homePage, gap: "unfillable-field" as const },
        "unfillable-field",
      ],
      ["a refused description", { ok: false, reason: "no-candidates" }, "no-candidates"],
    ])(
      "reports why it does not send %s",
      async (_label, extracted, reason) => {
        fake.state.extracted = {
          "signed-in":
            "observation" in extracted
              ? { ...extracted, observation: { ...extracted.observation, complete: false } }
              : extracted,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(service.judge).not.toHaveBeenCalled();
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toContainEqual({
          type: "judge",
          tabId: 1,
          origin,
          recipeId: generated.id,
          recipeRevision: generated.revision,
          route: "password",
          verdict: "not-sent",
          reason,
        });
      },
      10_000,
    );
    it("does not send the page while the recipe's fields are still shown", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      // A readable sign-in state that shows no failure, so the page is looked at.
      fake.state.signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(service.judge).not.toHaveBeenCalled();
      // The page is described only to look for a form beside the sign-in form (ADR 0061),
      // once, and nothing of it is sent.
      expect(
        fake.state.messages
          .filter((entry) => entry.type === "login.extract")
          .map((entry) => (entry as Record<string, unknown>)["page"]),
      ).toEqual(["signed-in"]);
      // The log says why.
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "sign-in-shown" }),
      );
    }, 10_000);
    it("sends the page when a field's locator names an element that is no input there", async () => {
      // 2026-10-12: Wise's signed-in page gave the password field's React ID to an empty div.
      fake.state.extracted = {
        "signed-in": page("/signin", [
          { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
        ]),
      };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind !== "click") return;
        fake.state.present = new Set(["user", "password", "logout"]);
        fake.state.unusable = new Set(["user", "password"]);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledTimes(1);
      // Only an input counts as the sign-in field, shown for the sign-in state.
      const requires = fake.state.messages
        .filter((entry) => entry.type === "login.observe")
        .map((entry) => (entry as Record<string, unknown>)["require"]);
      expect(requires).toContainEqual(["shown-input", "shown-input"]);
      expect(requires).toContainEqual(expect.arrayContaining(["input", "input"]));
    }, 10_000);
    it("sends a page whose path may carry a token with that segment as [id]", async () => {
      const accountHome = page("/[id]/home", [
        { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
      ]);
      fake.state.extracted = { "signed-in": accountHome };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        fake.state.present = new Set(["logout"]);
        fake.state.observedPath = "/0123456789abcdef0123456789abcdef/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledWith(
        generated.id,
        generated.revision,
        "password",
        accountHome.observation,
        expect.any(Function),
        undefined,
        undefined,
        undefined,
        expect.any(Array),
      );
    }, 10_000);
    describe("a page beside the sign-in form (ADR 0061)", () => {
      const besidePage = page("/signin", [
        {
          id: "c1",
          role: "email",
          target: target("user"),
          autocomplete: "username",
          group: "side",
        },
        { id: "c2", role: "password", target: target("password"), group: "side" },
        { id: "c3", role: "button", target: target("login"), label: "Sign in", group: "side" },
        {
          id: "c4",
          role: "text",
          target: target("birth"),
          label: "Birth year and month",
          maxLength: 6,
          group: "box",
        },
        {
          id: "c5",
          role: "text",
          target: target("phone"),
          label: "Last 4 phone digits",
          maxLength: 4,
          group: "box",
        },
        { id: "c6", role: "button", target: target("submit"), label: "Log in", group: "box" },
      ]);
      const lightbox = () => {
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: LoginStep }).step.kind !== "click") return;
          fake.state.present = new Set(["user", "password", "login", "birth", "phone", "submit"]);
        };
      };
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      const judgeReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
        report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : []));
      const withDetail = parseLoginRecipe({
        ...generated,
        revision: 2,
        handlers: [
          {
            kind: "detail",
            path: "/signin",
            fields: [
              { detail: "birth-date", format: "yyyymm", target: target("birth") },
              { detail: "phone-last-4", target: target("phone") },
            ],
            target: target("submit"),
          },
        ],
      });
      it("sends the page marked beside, as one judged page of the step", async () => {
        fake.state.extracted = { "signed-in": besidePage };
        // The sign-in fields still show, so the sign-in state is unknown (S1, ADR 0029).
        fake.state.signs = quiet;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        lightbox();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(service.judge.mock.calls[0]!.slice(0, 4)).toEqual([
          generated.id,
          generated.revision,
          "password",
          besidePage.observation,
        ]);
        // No branch and no partial description; the account's slots, then `beside`.
        expect(service.judge.mock.calls[0]!.slice(5)).toEqual([
          undefined,
          undefined,
          undefined,
          expect.any(Array),
          true,
        ]);
        // It counts as any judged page of the step.
        expect(status()).toMatchObject([{ judged: { pages: 1 } }]);
        expect(judgeReports(report)).toEqual([
          expect.objectContaining({ verdict: "sent", beside: true }),
          expect.objectContaining({ verdict: "unclear", beside: true }),
        ]);
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])).at(-1),
        ).toMatchObject({ decision: "unknown" });
      }, 10_000);
      it("takes over the detail handler the page added and leaves it to the person", async () => {
        fake.state.extracted = { "signed-in": besidePage };
        fake.state.signs = quiet;
        const service = generation({
          judge: async () => ({ verdict: "challenge", recipe: withDetail }),
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        lightbox();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          { timeout: 6_000 },
        );
        expect(status()).toMatchObject([{ recipeRevision: 2 }]);
        expect(judgeReports(report)).toContainEqual(
          expect.objectContaining({ verdict: "challenge", takenOver: true, beside: true }),
        );
        // No link holds the values yet (ADR 0061, delivery 1): nothing is filled.
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "handler", kind: "detail", outcome: "detail-unlinked" }),
        );
        expect(
          fake.state.messages.filter(
            (entry) =>
              entry.type === "login.execute" &&
              ((entry as Record<string, unknown>)["operation"] as { step: LoginStep }).step.kind ===
                "fill",
          ),
        ).toHaveLength(1);
      }, 10_000);
      it.each([
        ["the sign-in form alone", loginPage],
        [
          "the other inputs in the sign-in form",
          page(
            "/signin",
            besidePage.observation.candidates.map((candidate) => ({
              ...(candidate as object),
              group: "side",
            })),
          ),
        ],
        [
          "no button in the other form",
          page("/signin", besidePage.observation.candidates.slice(0, 5)),
        ],
      ])(
        "does not send a page with %s",
        async (_label, extracted) => {
          fake.state.extracted = { "signed-in": extracted };
          fake.state.signs = quiet;
          const service = generation({ judge: async () => ({ verdict: "unclear" }) });
          const report = vi.fn<(report: LoginReport) => void>();
          const h = harness(unsaved, {
            allowedOrigins: [],
            uris,
            username: true,
            generation: service,
            report,
          });
          h.recipes.recipe.mockResolvedValue(generated);
          lightbox();
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(
            () =>
              expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
            { timeout: 6_000 },
          );
          expect(service.judge).not.toHaveBeenCalled();
          expect(judgeReports(report)).toEqual([
            expect.objectContaining({ verdict: "not-sent", reason: "sign-in-shown" }),
          ]);
          // A page not sent spends none of the step's pages.
          expect((status() as Record<string, unknown>[])[0]).not.toHaveProperty("judged");
        },
        10_000,
      );
      it("does not send it again for a path that has a detail handler", async () => {
        fake.state.extracted = { "signed-in": besidePage };
        fake.state.signs = quiet;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        // The handler's inputs are not there, so it is not entered.
        h.recipes.recipe.mockResolvedValue(
          parseLoginRecipe({
            ...withDetail,
            handlers: [
              {
                ...withDetail.handlers![0]!,
                fields: [{ detail: "card-last-4", target: target("card") }],
              },
            ],
          }),
        );
        lightbox();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(service.judge).not.toHaveBeenCalled();
        expect(judgeReports(report)).toEqual([
          expect.objectContaining({ verdict: "not-sent", reason: "sign-in-shown" }),
        ]);
      }, 10_000);
      it("does not send it from a login in a frame", async () => {
        fake.state.extracted = { "signed-in": besidePage };
        fake.state.signs = quiet;
        // The tab's page around the frame is another site's, which the item matches too.
        const top = "https://portal.example/account";
        fake.state.tabUrls[1] = top;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: vi.fn<LiveUriMatcher>(async (_connection, url) => ({
            ok: true,
            data: uriMatch({ targetOrigin: new URL(url).origin }),
          })),
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        lightbox();
        expect(
          await h.hello({ frameId: 3, documentId: "frame-document", tab: { id: 1, url: top } }),
        ).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(judgeReports(report)).toEqual([
              expect.objectContaining({ verdict: "not-sent", reason: "sign-in-shown" }),
            ]),
          { timeout: 6_000 },
        );
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);
      it("ends rejected rather than entering a learned detail handler beside a failure", async () => {
        fake.state.extracted = { "signed-in": besidePage };
        // A wrong password: the sign-in form shows again with its failure, beside the form
        // the path's handler was learned from.
        fake.state.signs = { ...quiet, password: true, alert: true };
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(withDetail);
        lightbox();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
          { timeout: 6_000 },
        );
        expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "handler" }));
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);
    });
  });
});
