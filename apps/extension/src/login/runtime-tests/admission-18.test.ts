import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import { createLoginBadge, memoryBadgeStorage, type LoginBadge } from "../badge";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, itemId, target, recipe, userId, uriMatch, harness } =
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

      void parseLoginRecipe({
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
      it("does not send a page with a failure shown beside the sign-in form", async () => {
        fake.state.extracted = { "signed-in": besidePage };
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
        h.recipes.recipe.mockResolvedValue(generated);
        lightbox();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "blocked" }]), {
          timeout: 6_000,
        });
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);
    });
    it("does not send a page that shows a sign-in field on another path (S1)", async () => {
      fake.state.extracted = { "signed-in": homePage };
      fake.state.signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
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
        // The form shows again elsewhere; its field may be left out of the description.
        fake.state.present = new Set(["user"]);
        fake.state.observedPath = "/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(service.judge).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "sign-in-shown" }),
      );
    }, 10_000);
    describe("the sign-in state (ADR 0029)", () => {
      it("logs a passkey request after the submission, but not one before it", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
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
        // The sign-in page's own request, before the submission, does not count.
        h.login.passkeyRequested(1, origin);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          setTimeout(() => h.login.passkeyRequested(1, origin), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s1: false, s5: true, decision: "continuing" })]);
      }, 10_000);
      it("does not count a passkey request made before the submission", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
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
        h.login.passkeyRequested(1, origin);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s5: false, decision: "judge" })]);
      }, 10_000);
      it("does not count a passkey request of another origin", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
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
          setTimeout(() => h.login.passkeyRequested(1, "https://other.example"), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s5: false, decision: "judge" })]);
      }, 10_000);
      const noSigns = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      async function judged(
        answer: Awaited<ReturnType<LoginGeneration["judge"]>>,
        signs: typeof noSigns = noSigns,
        answering?: () => void,
        described: unknown = homePage,
      ) {
        fake.state.extracted = { "signed-in": described };
        fake.state.signs = signs;
        const service = generation({
          judge: async () => {
            answering?.();
            return answer;
          },
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const signedIn = vi.fn<(tabId: number, origin: string) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
          signedIn,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 8_000 });
        const judges = () =>
          report.mock.calls.flatMap(([value]) =>
            value.type === "judge" && value.verdict !== "sent" ? [value] : [],
          );
        return { judges, service, report, h, signedIn };
      }
      it.each([
        [{ verdict: "unclear" }, false],
        [{ verdict: "unclear", reason: "already-judged" }, false],
        [{ verdict: "unclear", reason: "judgement-limit" }, false],
        [{ verdict: "unclear", reason: "daily-limit" }, false],
        [{ verdict: "unclear", reason: "monthly-limit" }, false],
        [{ verdict: "unclear", reason: "judged-signed-in" }, true],
        [{ verdict: "signed-in" }, true],
      ] as const)(
        "ends a quiet judged page (%j), confirmed=%s, with only confirmed sign-in effects",
        async (answer, confirmed) => {
          const { judges, service, report, h, signedIn } = await judged(answer);
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]),
          );
          const ended = (status() as Record<string, unknown>[])[0];
          const attempt = report.mock.calls
            .flatMap(([entry]) => (entry.type === "attempt" ? [entry] : []))
            .at(-1);
          if (confirmed) {
            expect(ended).not.toHaveProperty("unconfirmed");
            expect(attempt).not.toHaveProperty("unconfirmed");
            await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledOnce());
            expect(h.settings.settings.siteDefaults).toEqual([
              expect.objectContaining({ origin, userId, itemId }),
            ]);
            expect(signedIn.mock.calls).toEqual([[1, origin]]);
          } else {
            expect(ended).toHaveProperty("unconfirmed", true);
            expect(attempt).toMatchObject({ state: "authenticated", unconfirmed: true });
            expect(h.store.update).not.toHaveBeenCalled();
            expect(h.settings.settings.siteDefaults).toEqual([]);
            expect(signedIn).not.toHaveBeenCalled();
          }
          expect(judges()).toEqual([
            expect.objectContaining({
              verdict: answer.verdict,
              ...(answer.verdict === "unclear" ? { completed: true } : {}),
            }),
          ]);
          expect(judges()[0]).not.toHaveProperty("disabledLeftOut");
          expect(judges()[0]).not.toHaveProperty("notCompleted");
          // A description that left nothing out is sent without the mark; the account's
          // slots come last (owner 2026-10-23).
          expect(service.judge.mock.calls[0]).toHaveLength(9);
          expect(service.judge.mock.calls[0]!.slice(5, 8)).toEqual([
            undefined,
            undefined,
            undefined,
          ]);
          expect(service.judge.mock.calls[0]![8]).toEqual(expect.any(Array));
        },
        12_000,
      );
      const disabledLeftOut = { ...homePage, disabledLeftOut: true };
      it("judges a page that left out a disabled field and completes it on signed-in", async () => {
        const { judges, service, report } = await judged(
          { verdict: "signed-in" },
          noSigns,
          undefined,
          disabledLeftOut,
        );
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]),
        );
        // The description goes as it is, and the request says a field was left out.
        expect(service.judge.mock.calls[0]![3]).toEqual(homePage.observation);
        expect(service.judge.mock.calls[0]!.slice(5)).toEqual([
          undefined,
          true,
          undefined,
          expect.any(Array),
        ]);
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toEqual([
          expect.objectContaining({ verdict: "sent", disabledLeftOut: true }),
          expect.objectContaining({ verdict: "signed-in", disabledLeftOut: true }),
        ]);
        expect(judges()[0]).not.toHaveProperty("notCompleted");
      }, 12_000);
      it.each([undefined, "already-judged", "daily-limit"])(
        "does not complete a page that left out a disabled field the judge did not decide (%s)",
        async (reason) => {
          const { judges } = await judged(
            { verdict: "unclear", ...(reason ? { reason } : {}) },
            noSigns,
            undefined,
            disabledLeftOut,
          );
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          );
          expect(judges()).toEqual([
            expect.objectContaining({
              verdict: "unclear",
              disabledLeftOut: true,
              notCompleted: "disabled-left-out",
            }),
          ]);
          expect(judges()[0]).not.toHaveProperty("completed");
        },
        12_000,
      );
      it("names no left-out field for an undecided answer that would not complete anyway", async () => {
        const { judges } = await judged(
          { verdict: "unclear", reason: "timeout" },
          noSigns,
          undefined,
          disabledLeftOut,
        );
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        );
        expect(judges()).toEqual([
          expect.objectContaining({ verdict: "unclear", reason: "timeout", disabledLeftOut: true }),
        ]);
        expect(judges()[0]).not.toHaveProperty("notCompleted");
      }, 12_000);
      it("rejects a page that left out a disabled field as usual", async () => {
        await judged({ verdict: "rejected" }, noSigns, undefined, disabledLeftOut);
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
        );
      }, 12_000);
      it("never completes on a page judged challenge before", async () => {
        await judged({ verdict: "unclear", reason: "judged-challenge" });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
      }, 12_000);
      it.each(["timeout", "judged-rejected", "judgement-unanswered"])(
        "never completes on %s",
        async (reason) => {
          const { judges } = await judged({ verdict: "unclear", reason });
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          );
          expect(judges()[0]).not.toHaveProperty("completed");
        },
        12_000,
      );
      it("keeps a page undecided when a sign shows by the time the judge answers", async () => {
        const { judges } = await judged({ verdict: "unclear" }, noSigns, () => {
          fake.state.signs = { ...noSigns, code: true };
        });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        );
        expect(judges()[0]).not.toHaveProperty("completed");
      }, 12_000);
      it("leaves another sign-in step the judge did not decide to the person", async () => {
        const { judges } = await judged({ verdict: "unclear" }, { ...noSigns, code: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(judges()[0]).not.toHaveProperty("completed");
      }, 12_000);
      it("rejects on a failure shown next to the sign-in fields, comparing the username in the page", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, password: true, alert: true, username: false };
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
        expect(await h.hello()).toEqual({ ok: true });
        // A second reading agrees, so the login is rejected without asking the judge.
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
          { timeout: 8_000 },
        );
        expect(report).toHaveBeenCalledWith({
          type: "state",
          tabId: 1,
          origin,
          recipeId: generated.id,
          recipeRevision: generated.revision,
          route: "password",
          ...{ s1: true, s2: true, s3: false, s4: false, s5: false, f1: false, f2: true },
          ...{ e1: false, e2: false, e3: false },
          decision: "rejected",
          // Read against its own reading at the step, not as a form shown again.
          reshownMiss: "same-document",
        });
        // The username goes to the page for its comparison only.
        expect(fake.state.messages.find((entry) => entry.type === "login.state")?.account).toEqual({
          username: "synthetic-secret",
        });
        // The submitted document is compared with its own reading, never asked for fields.
        expect(
          fake.state.messages.filter(
            (entry) => entry.type === "login.state" && entry.fields !== undefined,
          ),
        ).toEqual([]);
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);
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
      it.each([
        ["a sign-in field marked invalid (F1)", { invalid: true }, { f1: true, f2: false }],
        ["an alert (F2)", { alert: true }, { f1: false, f2: true }],
      ])(
        "rejects the sign-in form shown again in a new document with %s",
        async (_label, shown, flags) => {
          const { service, states } = await reshown({ ...noSigns, password: true, ...shown });
          await vi.waitFor(
            () =>
              expect(status()).toMatchObject([
                { state: "blocked", outcome: "credential-rejected" },
              ]),
            { timeout: 8_000 },
          );
          expect(states()).toEqual([
            expect.objectContaining({ s1: true, s4: false, ...flags, reshown: true }),
          ]);
          expect(states()[0]).toMatchObject({ decision: "rejected" });
          expect(service.judge).not.toHaveBeenCalled();
        },
        12_000,
      );
      it("asks for an account once the sign-in form shows again in a new document without a mark", async () => {
        // Seen on github.com on 2026-10-13: its "Incorrect username or password" page was read
        // as unknown, the login was watched, and the popup offered no account. The page says
        // why no alert beside the form counted, value-free, for the log.
        const { service, states, report, h } = await reshown({
          ...noSigns,
          password: true,
          alertMiss: "other-form",
        });
        await vi.waitFor(() => expect(status()).toEqual([]), { timeout: 8_000 });
        expect(states()).toEqual([
          expect.objectContaining({ s1: true, f1: false, f2: false, reshown: true }),
        ]);
        expect(states()[0]).toMatchObject({ decision: "unknown", alertMiss: "other-form" });
        expect(states()[0]).not.toHaveProperty("reshownMiss");
        // The attempt that settles on it says the sign-in form still showed.
        expect(
          report.mock.calls.flatMap(([value]) =>
            value.type === "attempt" && value.outcome === "unknown-submit" && value.settled
              ? [value]
              : [],
          ),
        ).toEqual([expect.objectContaining({ cause: "sign-in-shown" })]);
        expect(service.judge).not.toHaveBeenCalled();
        expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        // The page is asked to announce again, and asks once its first step shows.
        expect(fake.state.reconnects).toContainEqual({
          tabId: 1,
          frameId: 0,
          documentId: "document-again",
        });
        const executes = fake.state.messages.filter((entry) => entry.type === "login.execute");
        expect(await h.hello({ documentId: "document-again" })).toEqual({
          ok: false,
          reason: "account-asked",
        });
        expect(fake.state.badges[1]).toEqual({
          text: "1",
          title:
            "Pateat: the site did not accept the last login in this tab. Click to choose an account.",
        });
        // Nothing is filled or pressed on that page again.
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual(
          executes,
        );
      }, 12_000);
      it("never rejects the sign-in form shown again in a new document with a CAPTCHA", async () => {
        const { states } = await reshown({
          ...noSigns,
          password: true,
          captcha: true,
          invalid: true,
          alert: true,
        });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 8_000 },
        );
        expect(states()).toEqual([
          expect.objectContaining({ s1: true, s4: true, f1: true, f2: true, reshown: true }),
        ]);
        expect(states()[0]).toMatchObject({ decision: "unknown" });
      }, 12_000);
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
      it("does not read the submitted document again when a restarted worker resumes the settled login there", async () => {
        // Seen on a bank's sign-in page on 2026-10-17: the click had no effect, the login
        // settled as unknown in the submitted document, and after each worker restart that
        // document announced again and was read and sent to the judge again. The watch's own
        // document is not read again; a restart keeps the watch (ADR 0027).
        const tabBadge = createLoginBadge({
          setBadge: vi.fn(async () => undefined),
          storage: memoryBadgeStorage(),
        });
        const { states, service, report } = await settledFirst([], 0, tabBadge);
        const [settledRecord] = status() as { watch: { documentId: string; since: number } }[];
        expect(settledRecord!.watch).toMatchObject({ documentId: "synthetic-document" });
        const popup = {
          id: "synthetic-extension",
          url: "chrome-extension://synthetic-extension/popup.html",
        } as never;
        const ask = (at: ReturnType<typeof harness>) =>
          at.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup);
        const judges = () => report.mock.calls.filter(([value]) => value.type === "judge");
        const reads = () => fake.state.messages.filter((entry) => entry.type === "login.state");
        const before = { states: states().length, judges: judges().length, reads: reads().length };
        const reported = report.mock.calls.length;
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          // The badge keeps the tab's page status across the restart, as its storage does.
          const restarted = harness(unsaved, {
            allowedOrigins: [],
            uris,
            username: true,
            generation: service,
            badge: tabBadge,
            report: (entry) => {
              tabBadge.observe(entry);
              report(entry);
            },
          });
          restarted.recipes.recipe.mockResolvedValue(generated);
          // The same document announces again, its form still filled.
          expect(await restarted.hello()).toEqual({ ok: true });
          // Longer than the observation budget a reconcile of the page would take.
          await new Promise((resolve) => setTimeout(resolve, 3_500));
          expect(states()).toHaveLength(before.states);
          expect(judges()).toHaveLength(before.judges);
          expect(reads()).toHaveLength(before.reads);
          // The resumed login is logged only as a quiet repeat.
          expect(
            report.mock.calls
              .slice(reported)
              .flatMap(([value]) => (value.type === "attempt" ? [value] : [])),
          ).toEqual([
            expect.objectContaining({
              state: "reconciling",
              outcome: "unknown-submit",
              repeat: true,
            }),
          ]);
          expect(status()).toMatchObject([
            {
              state: "reconciling",
              outcome: "unknown-submit",
              settled: true,
              watch: settledRecord!.watch,
            },
          ]);
          // The popup shows it as watched, not as logging in.
          expect(await ask(restarted)).toMatchObject({
            ok: true,
            login: { state: "reconciling", outcome: "unknown-submit", settled: true },
          });
          expect(service.judge).not.toHaveBeenCalled();
          // After the watch's 10 minutes, the next page of the tab ends the login where it
          // stopped, as before.
          const now = Date.now.bind(Date);
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 10 * 60_000 + 1000);
          onTestFinished(() => clock.mockRestore());
          fake.state.gone.add("synthetic-document");
          await restarted.hello({ documentId: "document-1" }, false);
          await vi.waitFor(
            () => expect(status()).toMatchObject([{ state: "blocked", outcome: "unknown-submit" }]),
            { timeout: 8_000 },
          );
          expect(judges()).toHaveLength(before.judges);
          expect(await ask(restarted)).toMatchObject({
            ok: true,
            login: { state: "blocked", outcome: "unknown-submit" },
          });
        } finally {
          fake.browser.tabs.query = query;
        }
      }, 30_000);
    });
  });
});
