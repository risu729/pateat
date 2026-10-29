import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type LoginRecipe } from "@pateat/contracts";
import { createRecipeRepairs } from "../repair";
import { statusResponseSchema } from "../choice-wire";
import { createLoginBadge, memoryBadgeStorage } from "../badge";
import type { GenerationOutcome, LoginReport } from "../runtime/report";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, sender, target, startsOf, recipe, uriMatch, harness, realTime } =
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

    it("still sends a page on a chooser branch's first-page path, which is a sign-in page (ADR 0028)", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
      });
      // `routes` lists a chooser's branches too; one starting on this path never holds it back.
      const branch = parseLoginRecipe({ ...generated, id: "gen-branch", pageKind: "sign-in" });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      h.recipes.routes.mockResolvedValue([branch]);
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    });
    describe("a generated recipe whose start page no longer matches (ADR 0041)", () => {
      const missing = [target("user"), target("password")];
      const repairedRecipe = parseLoginRecipe({
        ...generated,
        revision: 2,
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "username", target: target("login-id") },
              { slot: "password", target: target("passcode") },
            ],
          },
          { kind: "click", path: "/signin", target: target("go"), purpose: "submit" },
        ],
      });
      const missHello = (
        h: { login: { handle(message: unknown, sender: unknown): Promise<unknown> } },
        documentId: string,
        /** What the page says it missed; `null` for a page that says nothing. */
        miss: Record<string, unknown> | null = { missing, status: 200 },
      ) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            shown: { path: "/signin", ...(miss ? { miss } : {}) },
          },
          sender({ documentId }),
        );
      function setup(answer?: () => Promise<GenerationOutcome>) {
        fake.state.extracted = { login: loginPage };
        const service = generation(answer ? { generate: answer } : {});
        const report = vi.fn<(report: LoginReport) => void>();
        const repairs = createRecipeRepairs({
          read: async () => fake.state.storage["repairs"],
          write: async (value) => {
            fake.state.storage["repairs"] = value;
          },
        });
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          custom: [],
          generation: service,
          repairs,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        const repairLog = () =>
          report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "repair" || entry.type === "generation");
        return { service, h, repairLog };
      }
      it("sends the start page for repair on the first load that misses", async () => {
        const { service, h, repairLog } = setup(async () => {
          h.recipes.recipe.mockResolvedValue(repairedRecipe);
          h.recipes.starts.mockResolvedValue(startsOf([repairedRecipe.steps[0]!]));
          return { outcome: "recipe", recipe: repairedRecipe };
        });
        expect(await missHello(h, "load-1")).toMatchObject({ reason: "form-not-ready" });
        await vi.waitFor(() =>
          expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
        );
        expect(service.generate).toHaveBeenCalledWith(
          expect.objectContaining({
            observation: loginPage.observation,
            repair: { recipeId: generated.id, revision: 1 },
            // A start page is a recipe's first page, so it carries the hint (ADR 0035).
            signedIn: false,
          }),
          expect.any(Function),
        );
        expect(repairLog()).toEqual([
          {
            type: "repair",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: 1,
            outcome: "due",
          },
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "sent",
            page: "repair",
            recipeId: generated.id,
            baseRevision: 1,
            signedIn: false,
          },
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "recipe",
            page: "repair",
            recipeId: generated.id,
            baseRevision: 1,
            pageKind: "sign-in",
            signedIn: false,
          },
        ]);
        // The page announces again and runs the repaired recipe at once.
        expect(await h.hello({ documentId: "load-1" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(
            fake.state.messages.filter((entry) => entry.type === "login.execute"),
          ).toHaveLength(2),
        );
      });
      it("does not send an error status or a slow page", async () => {
        const { service, h, repairLog } = setup();
        // A maintenance page answered 503 on the login page's URL.
        await missHello(h, "down", { missing, status: 503 });
        // Elements found once but not usable yet, as on a slow page.
        await missHello(h, "slow", { missing: [], status: 200 });
        // An older page that did not say what it missed.
        await missHello(h, "quiet", null);
        await vi.waitFor(() => expect(repairLog()).toHaveLength(3));
        expect(repairLog().map((entry) => "reason" in entry && entry.reason)).toEqual([
          "status",
          "unusable",
          "no-detail",
        ]);
        expect(service.generate).not.toHaveBeenCalled();
      });
      it("sends no page where a signed-in marker the recipe learned shows", async () => {
        const { service, h, repairLog } = setup();
        const signedIn = {
          ...generated,
          revision: 2,
          completion: [{ target: target("sign-out") }],
        };
        h.recipes.recipe.mockResolvedValue(signedIn);
        // A signed-in page on the start path, as a profile form with an email input.
        fake.state.observed = ["unique"];
        await missHello(h, "load-1");
        await vi.waitFor(() => expect(repairLog()).toHaveLength(1));
        expect(repairLog()[0]).toMatchObject({ outcome: "skipped", reason: "signed-in" });
        expect(
          fake.state.messages.filter((entry) => entry.type === "login.observe").at(-1),
        ).toMatchObject({ targets: [target("sign-out")] });
        // Without the marker, the page is sent.
        fake.state.observed = ["missing"];
        await missHello(h, "load-2");
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      });
      it("holds a recipe the service answered without a new revision for the day", async () => {
        const { service, h, repairLog } = setup(async () => ({
          outcome: "abstained",
          reason: "no-login-form",
        }));
        await missHello(h, "load-1");
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        // The model abstained, as on a maintenance page answered 200 that kept an input: the
        // recipe stays, and no other repair is sent the same UTC day.
        await vi.waitFor(() =>
          expect(fake.state.storage["repairs"]).toMatchObject({
            recipes: [{ recipeId: generated.id, held: expect.any(Number) }],
          }),
        );
        for (const listener of fake.state.removed) listener(1);
        await missHello(h, "load-2");
        await vi.waitFor(() =>
          expect(repairLog().at(-1)).toMatchObject({ outcome: "skipped", reason: "held" }),
        );
        expect(service.generate).toHaveBeenCalledTimes(1);
      });
      it("sends a start page that became a list of accounts as a list (ADR 0041 section 6)", async () => {
        const { service, h } = setup();
        const shown = page("/signin", [
          { id: "c1", role: "button", target: target("other"), label: "Use another account" },
        ]);
        const listPage = { ...shown, observation: { ...shown.observation, accounts: ["[email]"] } };
        fake.state.extracted = { accounts: listPage };
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            shown: { path: "/signin", miss: { missing, status: 200 }, accounts: true },
          },
          sender({ documentId: "list" }),
        );
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(service.generate).toHaveBeenCalledWith(
          expect.objectContaining({
            observation: listPage.observation,
            repair: { recipeId: generated.id, revision: 1 },
          }),
          expect.any(Function),
        );
        expect(service.generate.mock.calls[0]![0]).not.toHaveProperty("signedIn");
      });
      it("holds a recipe the service answered back unchanged for the day", async () => {
        // The answer equaled a layout the recipe already has, so the service wrote nothing.
        const { service, h, repairLog } = setup(async () => ({
          outcome: "recipe",
          recipe: generated,
        }));
        await missHello(h, "load-1");
        await vi.waitFor(() =>
          expect(fake.state.storage["repairs"]).toMatchObject({
            recipes: [{ recipeId: generated.id, held: expect.any(Number) }],
          }),
        );
        for (const listener of fake.state.removed) listener(1);
        await missHello(h, "load-2");
        await vi.waitFor(() =>
          expect(repairLog().at(-1)).toMatchObject({ outcome: "skipped", reason: "held" }),
        );
        expect(service.generate).toHaveBeenCalledTimes(1);
      });
      it("does not hold a recipe whose request found another in flight", async () => {
        const { service, h } = setup(async () => ({ outcome: "unavailable", reason: "busy" }));
        await missHello(h, "load-1");
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        for (const listener of fake.state.removed) listener(1);
        await missHello(h, "load-2");
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(2));
      });
    });
    it("spins the tab's icon from the page's send until its answer", async () => {
      fake.state.extracted = { login: loginPage };
      let answer!: (outcome: GenerationOutcome) => void;
      const service = generation({
        generate: () =>
          new Promise<GenerationOutcome>((resolve) => {
            answer = resolve;
          }),
      });
      const stop = vi.fn();
      const spin = vi.fn((_tabId: number) => stop);
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        spin,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(spin).not.toHaveBeenCalled();
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(spin).toHaveBeenCalledWith(1));
      expect(stop).not.toHaveBeenCalled();
      answer({ outcome: "abstained", reason: "ambiguous" });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      expect(spin).toHaveBeenCalledTimes(1);
    });
    it("stops the spin when the request fails after it was sent", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation({
        generate: async () => {
          throw new Error("network");
        },
      });
      const stop = vi.fn();
      const spin = vi.fn((_tabId: number) => stop);
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        spin,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      expect(spin.mock.calls).toEqual([[1]]);
    });
    it("tells the popup that the page went to the AI, then what came back", async () => {
      // The popup is polled while the request is out; on the fake clock the spin's own limit
      // could pass between two polls.
      realTime();
      fake.state.extracted = { login: loginPage };
      let answer!: (outcome: GenerationOutcome) => void;
      const service = generation({
        generate: () =>
          new Promise<GenerationOutcome>((resolve) => {
            answer = resolve;
          }),
      });
      const tabBadge = createLoginBadge({
        setBadge: vi.fn(async () => undefined),
        storage: memoryBadgeStorage(),
      });
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        badge: tabBadge,
        report: (entry) => tabBadge.observe(entry),
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const ask = () => h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup);
      expect(await ask()).toEqual({ ok: true, origin, recipe: "none" });
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await ask()).toMatchObject({ ok: true, origin, recipe: "none" });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      // The badge spins while the request is out, so the popup knows it is in flight.
      await vi.waitFor(async () =>
        expect(await ask()).toEqual({
          ok: true,
          origin,
          recipe: "none",
          asking: true,
          page: expect.objectContaining({ state: "generating" }),
          generation: { outcome: "sent" },
        }),
      );
      expect(tabBadge.asking(1)).toBe(true);
      answer({ outcome: "abstained", reason: "ambiguous" });
      await vi.waitFor(async () =>
        expect(await ask()).toMatchObject({
          generation: { outcome: "abstained", reason: "ambiguous" },
        }),
      );
      // The spin ended with the answer, though the page may still say `generating`.
      const after = await ask();
      expect(after).not.toHaveProperty("asking");
      expect(tabBadge.asking(1)).toBe(false);
    });
    it("logs why a page was described without a field", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
      onTestFinished(() => void vi.useRealTimers());
      fake.state.extracted = {
        login: {
          ok: false,
          reason: "no-candidates",
          detail: "n2.d0.text-hidden-attr.password-hidden-attr",
        },
      };
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
      await h.signIn();
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      await vi.advanceTimersByTimeAsync(9_000);
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "generation",
            outcome: "skipped",
            reason: "no-candidates",
            detail: "n2.d0.text-hidden-attr.password-hidden-attr",
          }),
        ),
      );
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("clips a page's over-long refusal reason to the popup's limit", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
      onTestFinished(() => void vi.useRealTimers());
      // The content script's refusal reason is any text it sent.
      const reason = `extract-${"x".repeat(300)}`;
      fake.state.extracted = { login: { ok: false, reason } };
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
      await h.signIn();
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      await vi.advanceTimersByTimeAsync(9_000);
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "generation", outcome: "skipped", reason }),
        ),
      );
      expect(service.generate).not.toHaveBeenCalled();
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const answer = await h.login.handle(
        { version: 1, type: "login.status.get", tabId: 1 },
        popup,
      );
      // The popup's client parses the answer, so it must stay within its schema.
      const parsed = v.parse(statusResponseSchema, answer);
      expect(parsed).toMatchObject({ ok: true, origin, recipe: "none" });
      expect(parsed.ok && parsed.page?.generationSkip).toBe(reason.slice(0, 200));
    }, 10_000);
    it("logs a page that stopped answering before it was sent", async () => {
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
      // The page stops answering, as while it is replaced.
      fake.state.gone.add("synthetic-document");
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith({
          type: "generation",
          tabId: 1,
          origin,
          outcome: "skipped",
          reason: "unreachable",
          detail: "no-receiver",
        }),
      );
      expect(service.generate).not.toHaveBeenCalled();
    });
    describe("pages that announced while the request was in flight", () => {
      function pending(report?: (report: LoginReport) => void) {
        fake.state.extracted = { login: loginPage };
        const service = generation();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          custom: [],
          generation: service,
          ...(report ? { report } : {}),
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        let release!: () => void;
        const answered = new Promise<void>((resolve) => {
          release = resolve;
        });
        service.generate.mockImplementation(async (_request, sent) => {
          sent?.();
          await answered;
          h.recipes.recipe.mockImplementation(async (at: string, path: string) =>
            at === origin && path === "/signin" ? generated : undefined,
          );
          h.recipes.starts.mockImplementation(async (at: string) =>
            at === origin ? startsOf([generated.steps[0]!]) : [],
          );
          return { outcome: "recipe", recipe: generated };
        });
        return { h, service, release };
      }
      const signInFrom = (h: ReturnType<typeof harness>, from: Record<string, unknown>) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            signIn: { path: new URL(String(from["url"] ?? fake.state.pageUrl)).pathname },
          },
          sender(from),
        );
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
      it("starts a page that replaced the document in its tab", async () => {
        const { h, service, release } = pending();
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        // The tab loads the page again; the page is still being sent, so it gets nothing.
        service.available.mockResolvedValue("sending");
        expect(await signInFrom(h, { documentId: "replacement" })).toEqual({
          ok: false,
          reason: "recipe-not-found",
        });
        release();
        // Only the page the tab shows now is asked to announce again, once.
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual([
            { tabId: 1, frameId: 0, documentId: "replacement" },
          ]),
        );
        expect(await h.hello({ documentId: "replacement" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(
            fake.state.messages.filter((entry) => entry.type === "login.execute"),
          ).toHaveLength(2),
        );
        expect(service.generate).toHaveBeenCalledTimes(1);
      });
      it("starts the same page in another tab", async () => {
        const { h, service, release } = pending();
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        service.available.mockResolvedValue("sending");
        expect(await signInFrom(h, { tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: false,
          reason: "recipe-not-found",
        });
        release();
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual(
            expect.arrayContaining([
              { tabId: 1, frameId: 0, documentId: "synthetic-document" },
              { tabId: 2, frameId: 0, documentId: "other-tab" },
            ]),
          ),
        );
        expect(fake.state.reconnects).toHaveLength(2);
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      });
      const cache = (h: ReturnType<typeof harness>, value: LoginRecipe | undefined) => {
        h.recipes.recipe.mockImplementation(async (at: string, path: string) =>
          at === origin && path === "/signin" ? value : undefined,
        );
        h.recipes.starts.mockImplementation(async (at: string) =>
          at === origin && value ? startsOf([value.steps[0]!]) : [],
        );
      };
      async function loggedIn(h: ReturnType<typeof harness>) {
        cache(h, recipe);
        expect(await h.hello({ tab: { id: 2 }, documentId: "done" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "authenticated" },
          ]),
        );
        cache(h, undefined);
      }
      async function generate(
        h: ReturnType<typeof harness>,
        service: ReturnType<typeof generation>,
        release: () => void,
        during: () => Promise<void> = async () => undefined,
      ) {
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        service.available.mockResolvedValue("sending");
        await during();
        release();
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toContainEqual({
            tabId: 1,
            frameId: 0,
            documentId: "synthetic-document",
          }),
        );
        await settle();
      }
      it("leaves pages of another path or origin, and a frame on the same path", async () => {
        const { h, service, release } = pending();
        await generate(h, service, release, async () => {
          fake.state.tabUrls[2] = `${origin}/home`;
          expect(
            await signInFrom(h, {
              tab: { id: 2 },
              documentId: "other-path",
              url: `${origin}/home`,
            }),
          ).toEqual({ ok: false, reason: "recipe-not-found" });
          fake.state.tabUrls[3] = "https://other.example/signin";
          expect(
            await signInFrom(h, {
              tab: { id: 3 },
              documentId: "other-origin",
              url: "https://other.example/signin",
            }),
          ).toMatchObject({ ok: false });
          expect(
            await signInFrom(h, {
              tab: { id: 4, url: fake.state.pageUrl },
              frameId: 5,
              documentId: "framed",
            }),
          ).toMatchObject({ ok: false, reason: "recipe-not-found" });
        });
        expect(fake.state.reconnects).toHaveLength(1);
      });
      it("leaves the page that carries its tab's login, also once it finished", async () => {
        const { h, service, release } = pending();
        await loggedIn(h);
        await generate(h, service, release);
        expect(fake.state.reconnects).toHaveLength(1);
      });
      it("starts a new page of a tab whose earlier login finished", async () => {
        const { h, service, release } = pending();
        await loggedIn(h);
        await generate(h, service, release, async () => {
          expect(await signInFrom(h, { tab: { id: 2 }, documentId: "after-login" })).toMatchObject({
            ok: false,
            reason: "logged-in",
          });
        });
        expect(fake.state.reconnects).toHaveLength(2);
        expect(fake.state.reconnects).toContainEqual({
          tabId: 2,
          frameId: 0,
          documentId: "after-login",
        });
      });
      it("leaves the page of a tab whose frame runs a login", async () => {
        const { h, service, release } = pending();
        // The frame's login waits on its first step, so it keeps running.
        fake.state.onExecute = (_message, tabId) =>
          tabId === 2 ? new Promise<void>(() => undefined) : Promise.resolve();
        cache(h, recipe);
        expect(
          await h.hello({
            tab: { id: 2, url: fake.state.pageUrl },
            frameId: 5,
            documentId: "frame",
          }),
        ).toEqual({
          ok: true,
        });
        await vi.waitFor(() =>
          expect(fake.state.messages.map((entry) => entry.type)).toContain("login.execute"),
        );
        cache(h, undefined);
        await generate(h, service, release, async () => {
          expect(await signInFrom(h, { tab: { id: 2 }, documentId: "around-frame" })).toEqual({
            ok: false,
            reason: "tab-busy",
          });
        });
        expect(fake.state.reconnects).toHaveLength(1);
      });
      it.each([
        ["at info while the tab still shows the page", undefined, {}],
        ["at debug once the tab moved on", `${origin}/home`, { unrelated: true }],
      ] as const)(
        "logs a page that could not be asked to announce again %s",
        async (_name, moved, level) => {
          const report = vi.fn<(report: LoginReport) => void>();
          const { h, service, release } = pending(report);
          expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
          // The page stops answering after it was sent, as when its content script is gone.
          fake.state.gone.add("synthetic-document");
          if (moved) fake.state.tabUrls[1] = moved;
          release();
          await vi.waitFor(() =>
            expect(report).toHaveBeenCalledWith({
              type: "refused",
              tabId: 1,
              origin,
              reason: "reconnect-failed",
              ...level,
            }),
          );
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({ type: "generation", outcome: "recipe" }),
          );
          expect(report).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "generation", outcome: "skipped" }),
          );
        },
      );
    });
  });
});
