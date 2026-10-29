import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type LoginRecipe } from "@pateat/contracts";
import { type LoginBadge } from "../badge";
import type { LoginGeneration, LoginReport } from "../runtime";
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
    void page("/signin", [
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

    describe("the sign-in state (ADR 0029)", () => {
      const noSigns = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };

      async function reshown(signs: typeof noSigns & { alertMiss?: string }) {
        fake.state.extracted = { "signed-in": homePage };
        // The submitted document never shows a failure; only the new one can.
        fake.state.signs = (message) =>
          message["fields"] ? { ...signs, username: false } : { ...noSigns, username: false };
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
          // The site answers the submission with its sign-in page, as a new document.
          fake.state.gone.add("synthetic-document");
          setTimeout(() => void h.hello({ documentId: "document-again" }, false), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        const states = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
        await vi.waitFor(() => expect(states().length).toBeGreaterThan(0), { timeout: 8_000 });
        // Only the re-shown document is asked for its sign-in fields' marks.
        const reads = fake.state.messages.filter((entry) => entry.type === "login.state");
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((entry) => Array.isArray(entry.fields))).toBe(true);
        return { service, states, report, h };
      }
      async function settledFirst(pages: (typeof noSigns)[], afterMs = 0, badge?: LoginBadge) {
        fake.state.extracted = { "signed-in": homePage };
        let shown = { ...noSigns, password: true };
        fake.state.signs = (message) =>
          message["fields"] ? { ...shown, username: false } : { ...noSigns, password: true };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          ...(badge
            ? {
                badge,
                report: (entry: LoginReport) => {
                  badge.observe(entry);
                  report(entry);
                },
              }
            : { report }),
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        expect(await h.hello()).toEqual({ ok: true });
        const states = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
        // A slow answer: the submitted document's reading settles the login first.
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([
              { state: "reconciling", outcome: "unknown-submit", settled: true },
            ]),
          { timeout: 8_000 },
        );
        expect(states()).toEqual([
          expect.objectContaining({ s1: true, decision: "unknown", reshownMiss: "same-document" }),
        ]);
        expect(states()[0]).not.toHaveProperty("reshown");
        if (afterMs > 0) {
          const now = Date.now.bind(Date);
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + afterMs);
          onTestFinished(() => clock.mockRestore());
        }
        // Each page is read before the next one loads, so they run one after another.
        /* eslint-disable no-await-in-loop */
        for (const [index, signs] of pages.entries()) {
          shown = signs;
          fake.state.gone.add(index === 0 ? "synthetic-document" : `document-${index}`);
          await h.hello({ documentId: `document-${index + 1}` }, false);
          await vi.waitFor(() => expect(states().length).toBeGreaterThan(index + 1), {
            timeout: 8_000,
          });
        }
        /* eslint-enable no-await-in-loop */
        return { states, service, report, h };
      }
      it("reads a route the submitted document took after it settled, as Duolingo's /learn", async () => {
        // Seen on Duolingo's "Welcome Back!" page on 2026-10-25 (00:57 UTC): the sign-in
        // form still showed when the submitted document was read, the login settled as
        // unknown, and the single-page site then routed to /learn in the same document,
        // signed in, which was never read (ADR 0027 amendment of 2026-10-25).
        const { states, h, service } = await settledFirst([]);
        expect(status()).toMatchObject([{ watch: { path: "/signin" } }]);
        const moved = (from: Record<string, unknown> = {}) =>
          h.login.handle(
            { version: 1, type: "login.document.moved", token: "synthetic-token" },
            sender(from),
          );
        // A move the page reports without another path reads nothing again.
        await moved();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(states()).toHaveLength(1);
        fake.state.pageUrl = `${origin}/learn`;
        fake.state.observedPath = "/learn";
        fake.state.present = new Set();
        fake.state.signs = () => ({ ...noSigns, username: true });
        // Another document of the tab is not the watch's own.
        await moved({ documentId: "other-document" });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(states()).toHaveLength(1);
        await moved();
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        expect(states()[1]).toMatchObject({ e2: true, decision: "signed-in", settled: true });
        expect(service.judge).not.toHaveBeenCalled();
      }, 20_000);
      it("reads that route once a restarted worker resumes the settled login in its document", async () => {
        // As in the owner's Chrome, where /learn first showed when the restarted worker's
        // document announced again (00:58:02 UTC).
        const { states, service, report } = await settledFirst([]);
        fake.state.pageUrl = `${origin}/learn`;
        fake.state.observedPath = "/learn";
        fake.state.present = new Set();
        fake.state.signs = () => ({ ...noSigns, username: true });
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        onTestFinished(() => {
          fake.browser.tabs.query = query;
        });
        const restarted = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        restarted.recipes.recipe.mockResolvedValue(generated);
        expect(await restarted.hello({}, false)).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        expect(states()[1]).toMatchObject({ e2: true, decision: "signed-in", settled: true });
      }, 20_000);
      it("rejects the sign-in form shown again after the submitted document settled", async () => {
        // A slow answer, still well within 30 seconds of the submission.
        const { states, service } = await settledFirst([
          { ...noSigns, password: true, invalid: true },
        ]);
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
          { timeout: 8_000 },
        );
        expect(states()[1]).toMatchObject({
          f1: true,
          reshown: true,
          settled: true,
          decision: "rejected",
        });
        expect(service.judge).not.toHaveBeenCalled();
      }, 20_000);
      it("asks for an account when the form shows again without a mark after the submitted document settled", async () => {
        await settledFirst([{ ...noSigns, password: true }]);
        await vi.waitFor(() => expect(status()).toEqual([]), { timeout: 8_000 });
        expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.reconnects).toContainEqual({
          tabId: 1,
          frameId: 0,
          documentId: "document-1",
        });
      }, 20_000);
      it.each([
        ["a code input", { code: true }],
        ["a CAPTCHA", { captcha: true }],
      ])(
        "keeps watching the sign-in form shown again with %s beside it",
        async (_label, extra) => {
          const { states } = await reshown({ ...noSigns, password: true, ...extra });
          await vi.waitFor(
            () =>
              expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
            { timeout: 8_000 },
          );
          expect(states()[0]).toMatchObject({ reshown: true, decision: "unknown" });
          expect(fake.state.session["pateat.login-rejected-asks.v1"] ?? []).toEqual([]);
        },
        12_000,
      );
      it("reads only the first new document after the submission as the form shown again", async () => {
        // The person's own retry in the form shown again loads a third document. A code input
        // beside the form keeps the login watched rather than asking again.
        const { states } = await settledFirst([
          { ...noSigns, password: true, code: true },
          { ...noSigns, password: true, invalid: true, alert: true },
        ]);
        expect(states()[1]).toMatchObject({ reshown: true, decision: "unknown" });
        expect(states()[2]).toMatchObject({
          f1: false,
          f2: false,
          decision: "unknown",
          reshownMiss: "later-document",
        });
        expect(states()[2]).not.toHaveProperty("reshown");
        const reads = fake.state.messages.filter((entry) => entry.type === "login.state");
        expect(reads.at(-1)).not.toHaveProperty("fields");
        expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]);
      }, 30_000);
      it("never reads a new document more than 30 seconds after the submission as its answer", async () => {
        // The login settled and is watched; the person's own later attempt loads the
        // sign-in form with an error.
        const { states } = await settledFirst(
          [{ ...noSigns, password: true, invalid: true, alert: true }],
          31_000,
        );
        expect(states()[1]).toMatchObject({
          s1: true,
          f1: false,
          f2: false,
          decision: "unknown",
          reshownMiss: "late",
        });
        expect(states()[1]).not.toHaveProperty("reshown");
        expect(
          fake.state.messages.filter(
            (entry) => entry.type === "login.state" && entry.fields !== undefined,
          ),
        ).toEqual([]);
        expect(status()).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", settled: true },
        ]);
      }, 20_000);
      it("rejects the sign-in form shown again after a page judged challenge", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = (message) =>
          message["fields"]
            ? { ...noSigns, password: true, alert: true, username: false }
            : { ...noSigns, username: false };
        const service = generation({ judge: async () => ({ verdict: "challenge" }) });
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
          // The submitted document shows an approval page first.
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          { timeout: 8_000 },
        );
        // The site then answers with its sign-in form and an error, as a new document.
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.observedPath = "/signin";
        fake.state.gone.add("synthetic-document");
        await h.hello({ documentId: "document-again" }, false);
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
          { timeout: 10_000 },
        );
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])).at(-1),
        ).toMatchObject({ f2: true, reshown: true, decision: "rejected" });
        expect(service.judge).toHaveBeenCalledTimes(1);
      }, 20_000);
      it("never reads the sign-in form shown again after an advance as a rejection", async () => {
        const advancing = parseLoginRecipe({
          ...generated,
          steps: [
            {
              kind: "fill",
              path: "/signin",
              fields: [{ slot: "username", target: target("user") }],
            },
            { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
            {
              kind: "fill",
              path: "/next",
              fields: [{ slot: "password", target: target("password") }],
            },
            { kind: "click", path: "/next", target: target("login"), purpose: "submit" },
          ],
          maxSubmissions: 2,
        });
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = (message) =>
          message["fields"]
            ? { ...noSigns, alert: true, invalid: true, username: false }
            : { ...noSigns, username: false };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(advancing);
        fake.state.present = new Set(["user", "next"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // Next loads an unexpected page that shows the username form again.
          fake.state.present = new Set(["user"]);
          fake.state.observedPath = "/signin/again";
          fake.state.gone.add("synthetic-document");
          setTimeout(() => void h.hello({ documentId: "document-again" }, false), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        const states = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
        await vi.waitFor(() => expect(states().length).toBeGreaterThan(0), { timeout: 16_000 });
        expect(states()[0]).toMatchObject({
          s1: true,
          f1: false,
          f2: false,
          decision: "unknown",
          reshownMiss: "not-submit",
        });
        expect(states()[0]).not.toHaveProperty("reshown");
        expect(
          fake.state.messages.filter(
            (entry) => entry.type === "login.state" && entry.fields !== undefined,
          ),
        ).toEqual([]);
        expect(status()).not.toMatchObject([{ outcome: "credential-rejected" }]);
      }, 25_000);
      it("logs reaching the return target the sign-in page's URL named, before the judge", async () => {
        fake.state.pageUrl = `${origin}/signin?return_to=%2Fhome`;
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = noSigns;
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
          // The click loads the return target in a new document.
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          fake.state.pageUrl = `${origin}/home`;
          setTimeout(() => void h.hello({ documentId: "document-home" }, false), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        const states = report.mock.calls.flatMap(([value]) =>
          value.type === "state" ? [value] : [],
        );
        expect(states).toEqual([
          expect.objectContaining({ s1: false, s5: false, e3: true, decision: "signed-in" }),
        ]);
        // Read twice, a second apart, and completed without a model call.
        expect(fake.state.messages.filter((entry) => entry.type === "login.state")).toHaveLength(2);
        expect(service.judge).not.toHaveBeenCalled();
      }, 12_000);
      it("completes when the username shows in the header, without the judge", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
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
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "state", e2: true, decision: "signed-in" }),
        );
        expect(service.judge).not.toHaveBeenCalled();
      }, 12_000);
      it("waits for the document to finish loading before it completes", async () => {
        realTime();
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
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
            expect(
              fake.state.messages.filter((entry) => entry.type === "login.state").length,
            ).toBeGreaterThanOrEqual(3),
          { timeout: 10_000, interval: 10 },
        );
        expect(status()).not.toMatchObject([{ state: "authenticated" }]);
        fake.state.loaded = true;
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 4_000,
        });
        expect(service.judge).not.toHaveBeenCalled();
      }, 20_000);
      it("leaves the page to the judge when the document never finishes loading", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 16_000 });
        expect(status()).not.toMatchObject([{ state: "authenticated" }]);
      }, 20_000);
      it("leaves the page to the judge when the second reading shows no evidence", async () => {
        realTime();
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
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
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        // The header changes after the first reading, as on a page still redirecting.
        await vi.waitFor(
          () =>
            expect(
              fake.state.messages.filter((entry) => entry.type === "login.state"),
            ).toHaveLength(1),
          { timeout: 6_000, interval: 10 },
        );
        fake.state.signs = noSigns;
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 8_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ e2: false, decision: "judge" })]);
      }, 12_000);
    });
    describe("signed-in page samples (ADR 0029, owner 2026-10-18 08:05 UTC)", () => {
      const marked = parseLoginRecipe({ ...generated, completion: [{ target: target("logout") }] });
      const signedInPage = {
        ...homePage,
        observation: { ...homePage.observation, headerText: "Signed in as my2@example.com" },
      };
      type Sample = NonNullable<LoginGeneration["samplePage"]>;
      function sampling(before?: () => void, answer?: Sample, afterDescribed?: () => void) {
        const descriptions: unknown[] = [];
        const samplePage = vi.fn<Sample>(
          answer ??
            (async (_sample, describePage, sending) => {
              before?.();
              const described = await describePage();
              descriptions.push(described);
              if ("unsent" in described) return { outcome: "not-sent", reason: described.unsent };
              afterDescribed?.();
              const stop = await sending?.();
              if (stop) return { outcome: "not-sent", reason: stop };
              return { outcome: "kept" };
            }),
        );
        const service = { ...generation(), samplePage };
        return { service, samplePage, descriptions };
      }
      async function signIn(
        service: LoginGeneration,
        login: LoginRecipe = marked,
        shown = ["logout"],
        created?: (h: ReturnType<typeof harness>) => void,
      ) {
        fake.state.extracted = { "signed-in": signedInPage };
        fake.state.observedPath = "/signin";
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        created?.(h);
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(login);
        h.recipes.starts.mockResolvedValue(startsOf([login.steps[0]!]));
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set(shown);
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        const samples = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "sample" ? [value] : []));
        return { h, report, samples };
      }
      it("sends the page its marker completed, described as for the judge, after the login ended", async () => {
        let atSample: unknown;
        let readsBefore = 0;
        let h: ReturnType<typeof harness> | undefined;
        const usernameReads = () =>
          h!.fields.mock.calls.filter(([request]) => request.fieldId === "login.username").length;
        const { service, samplePage, descriptions } = sampling(() => {
          atSample = status();
          readsBefore = usernameReads();
        });
        const { report, samples } = await signIn(service, marked, ["logout"], (created) => {
          h = created;
        });
        await vi.waitFor(() => expect(samples()).toHaveLength(2), { timeout: 5_000 });
        expect(samplePage).toHaveBeenCalledTimes(1);
        expect(samplePage.mock.calls[0]![0]).toEqual({
          recipeId: marked.id,
          revision: marked.revision,
          route: "password",
        });
        // The login had ended before the sample was asked for.
        expect(atSample).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
        // The judge's description, with the account's username hidden (ADR 0016), and the
        // account's slots as the judge request carries them (owner 2026-10-23).
        expect(descriptions).toEqual([
          {
            observation: { ...homePage.observation, headerText: "Signed in as [account]" },
            slots: [
              expect.objectContaining({
                id: "username",
                valueShape: expect.objectContaining({ length: "my2@example.com".length }),
              }),
              expect.objectContaining({ id: "password" }),
              // A Text field's shape, read from its synthetic value; never the value.
              expect.objectContaining({
                id: "custom-1",
                fieldName: "Branch",
                valueShape: expect.objectContaining({ length: "synthetic-secret".length }),
              }),
            ],
          },
        ]);
        expect(JSON.stringify(descriptions)).not.toContain("my2@example.com");
        expect(JSON.stringify(descriptions)).not.toContain("synthetic-secret");
        // The username read to hide it gives the slot its shape: it is read once.
        expect(usernameReads() - readsBefore).toBe(1);
        expect(service.judge).not.toHaveBeenCalled();
        expect(samples()).toEqual([
          expect.objectContaining({ type: "sample", recipeId: marked.id, outcome: "sent" }),
          expect.objectContaining({ type: "sample", recipeId: marked.id, outcome: "kept" }),
        ]);
        expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "exception" }));
      }, 12_000);
      it("never samples a login the judge decided", async () => {
        const { service, samplePage } = sampling();
        service.judge.mockImplementation(async (...args) => {
          args[4]?.();
          return { verdict: "signed-in" };
        });
        // The recipe has no marker yet: the judge completes the login.
        await signIn(service, generated);
        expect(service.judge).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(samplePage).not.toHaveBeenCalled();
      }, 12_000);
      it("never samples a login completed without its marker", async () => {
        const { service, samplePage } = sampling();
        // The username shows in the header (E2) while the marker does not show.
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
          username: true,
        };
        await signIn(service, marked, []);
        expect(service.judge).not.toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(samplePage).not.toHaveBeenCalled();
      }, 12_000);
      it("sends nothing for a site a rule paused since the login started", async () => {
        let h: ReturnType<typeof harness> | undefined;
        const { service, descriptions } = sampling(() => {
          h!.settings.settings.excludedSites = [
            { hostname: "login.example", includeSubdomains: false },
          ];
        });
        const signedIn = await signIn(service, marked, ["logout"], (created) => (h = created));
        await vi.waitFor(() => expect(signedIn.samples()).toHaveLength(1), { timeout: 5_000 });
        expect(descriptions).toEqual([{ unsent: "paused" }]);
        expect(signedIn.samples()).toEqual([
          expect.objectContaining({ outcome: "not-sent", reason: "paused" }),
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
      }, 12_000);
      it("sends nothing for a site a rule paused after its page was described", async () => {
        let h: ReturnType<typeof harness> | undefined;
        const { service, descriptions } = sampling(undefined, undefined, () => {
          h!.settings.settings.excludedSites = [
            { hostname: "login.example", includeSubdomains: false },
          ];
        });
        const signedIn = await signIn(service, marked, ["logout"], (created) => (h = created));
        await vi.waitFor(() => expect(signedIn.samples()).toHaveLength(1), { timeout: 5_000 });
        expect(descriptions).toHaveLength(1);
        expect(descriptions[0]).toHaveProperty("observation");
        // The last check before the request stops it; `sent` is never reported.
        expect(signedIn.samples()).toEqual([
          expect.objectContaining({ outcome: "not-sent", reason: "paused" }),
        ]);
      }, 12_000);
    });
  });
});
