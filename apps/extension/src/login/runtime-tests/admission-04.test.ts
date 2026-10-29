import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type LoginRecipe, type LoginStep } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
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
  startsOf,
  recipe,
  userId,
  savedBinding,
  uriMatch,
  harness,
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

  describe("a tab that moves to another origin", () => {
    const second = "https://second.example";
    const secondUrl = `${second}/signin`;
    const secondRecipe = parseLoginRecipe({ ...recipe, id: "second-signin", origin: second });
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    type Stored = {
      id: string;
      state: string;
      outcome?: string;
      submissions: number;
      mutationIntent?: true;
      changedAt?: number;
    } & {
      account: { origin: string };
      document: { tabId: number; documentId: string };
    };
    const stored = () => (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Stored[];
    const at = (from: string) => stored().find((entry) => entry.account.origin === from);
    const twoSites = (live: Parameters<typeof harness>[1] = {}) => {
      const h = harness(
        {
          siteDefaults: [
            { origin, provider: "bitwarden", server: "cloud-us", userId, itemId },
            { origin: second, provider: "bitwarden", server: "cloud-us", userId, itemId },
          ],
          bindings: [savedBinding, { ...savedBinding, recipeId: secondRecipe.id, origin: second }],
        },
        { allowedOrigins: [origin, second], ...live },
      );
      h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
        path !== "/signin"
          ? undefined
          : from === origin
            ? recipe
            : from === second
              ? secondRecipe
              : undefined,
      );
      h.recipes.starts.mockImplementation(async (from: string) =>
        startsOf(
          from === origin ? [recipe.steps[0]!] : from === second ? [secondRecipe.steps[0]!] : [],
        ),
      );
      return h;
    };
    const navigate = (
      h: ReturnType<typeof harness>,
      url: string,
      documentId: string,
      start = true,
    ) => {
      fake.state.tabUrls[1] = url;
      return h.hello({ documentId, url }, start);
    };
    const holdClicks = (...from: string[]) => {
      fake.state.onExecute = (message) => {
        const operation = message["operation"] as {
          step: { kind: string };
          document: { origin: string };
        };
        return operation.step.kind === "click" && from.includes(operation.document.origin)
          ? new Promise(() => undefined)
          : Promise.resolve();
      };
    };

    describe("after Pateat answered the site's passkey request (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };

      describe("on another site, as a second factor after the password (ADR 0022)", () => {
        const console = "https://console.elsewhere.example/home";
        it("completes when the judge answers signed-in for the page", async () => {
          const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
            args[4]?.();
            return { verdict: "signed-in" };
          });
          holdClicks(origin);
          const h = twoSites({
            username: true,
            generation: {
              available: vi.fn<LoginGeneration["available"]>(async () => true),
              generate: vi.fn<LoginGeneration["generate"]>(),
              generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
              judge,
              slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
            },
          });
          const consoleHome = {
            ok: true,
            observation: {
              version: 1,
              origin: "https://console.elsewhere.example",
              path: "/home",
              language: "en",
              complete: true,
              candidates: [
                { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
              ],
            },
          };
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = quiet;
          fake.state.extracted = { "signed-in": consoleHome };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
          expect(judge).toHaveBeenCalledTimes(1);
          expect(judge.mock.calls[0]![3]).toEqual(consoleHome.observation);
          expect(executes()).toHaveLength(2);
        }, 15_000);
        it("ends left-origin when the answer came before the submission", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          h.login.passkeyAnswered(1, origin, "login.example");
          await new Promise((resolve) => setTimeout(resolve, 5));
          fake.state.signs = { ...quiet, username: true };
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
        it("ends left-origin when the password was filled but not submitted", async () => {
          // The password goes in with the identifier, but the click only advances, and the
          // site answers with a passkey as the sign-in itself.
          const advancing = parseLoginRecipe({
            ...recipe,
            steps: [
              recipe.steps[0]!,
              { kind: "click", path: "/signin", target: target("login"), purpose: "advance" },
            ],
          });
          holdClicks(origin);
          const h = twoSites({ username: true });
          h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
            from === origin && path === "/signin" ? advancing : undefined,
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
        it("ends left-origin when no password was sent before the answer", async () => {
          // An identifier step, then the passkey: the passkey is the sign-in itself.
          const identifier = parseLoginRecipe({
            ...recipe,
            slots: ["username"],
            steps: [
              {
                kind: "fill",
                path: "/signin",
                fields: [{ slot: "username", target: target("password") }],
              },
              { kind: "click", path: "/signin", target: target("login"), purpose: "advance" },
            ],
          });
          holdClicks(origin);
          const h = harness(
            {
              siteDefaults: [{ origin, provider: "bitwarden", server: "cloud-us", userId, itemId }],
              bindings: [{ ...savedBinding, slots: [{ slot: "username", field: "username" }] }],
            },
            { allowedOrigins: [origin], username: true },
          );
          h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
            from === origin && path === "/signin" ? identifier : undefined,
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
      });
      it("ends left-origin when the answer came before the submission", async () => {
        holdClicks(origin);
        const h = twoSites();
        h.login.passkeyAnswered(1, origin, "login.example");
        await new Promise((resolve) => setTimeout(resolve, 5));
        fake.state.signs = quiet;
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
    });
    describe("after a page of the site asked for a passkey (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      const auth = "https://auth.login.example";
      const item = { connectionId, itemId };
      const askedThere = async (live: Parameters<typeof harness>[1] = {}) => {
        holdClicks(origin);
        const h = twoSites(live);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = quiet;
        h.login.passkeyRequested(1, auth);
        expect(await navigate(h, `${auth}/passkey`, "auth-document", false)).toEqual({
          ok: false,
          reason: "stale-document",
        });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        return h;
      };
      it("completes when the tab comes back after the login's item answered there", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        const signedIn = vi.fn<(tabId: number, origin: string) => void>();
        const h = await askedThere({ report, signedIn });
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        expect(await h.login.active()).toBe(false);
        expect(executes()).toHaveLength(2);
        expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
          expect.objectContaining({
            type: "move",
            origin: auth,
            reason: "passkey-request",
            kept: true,
          }),
        );
        expect(signedIn.mock.calls.toSorted()).toEqual([
          [1, auth],
          [1, origin],
        ]);
      });
      it("keeps waiting while the page that asked announces again", async () => {
        const h = await askedThere();
        expect(await navigate(h, `${auth}/passkey`, "auth-document", false)).toMatchObject({
          ok: false,
        });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("leaves the move to the top page when a frame of the page that asked announces", async () => {
        const h = await askedThere();
        fake.state.tabUrls[1] = `${auth}/passkey`;
        await h.hello(
          {
            frameId: 3,
            documentId: "auth-frame",
            url: `${auth}/frame`,
            tab: { id: 1, url: `${auth}/passkey` },
          },
          false,
        );
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("ends left-origin when the page that asked shows a password field again", async () => {
        const h = await askedThere();
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, `${auth}/passkey`, "auth-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page after the answer asks for a passkey again", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        h.login.passkeyRequested(1, "https://www.login.example");
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page that asked stays open", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
        onTestFinished(() => void vi.useRealTimers());
        const h = await askedThere();
        await vi.advanceTimersByTimeAsync(61_000);
        vi.useRealTimers();
        await vi.waitFor(() =>
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" }),
        );
        expect(await h.login.active()).toBe(false);
      });
      it("completes on another host of the passkey's site", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("ends left-origin when another item answered there", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        const h = await askedThere({ report });
        h.login.passkeyAnswered(1, auth, "login.example", {
          connectionId,
          itemId: "80000000-0000-4000-8000-000000000009",
        });
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
          expect.objectContaining({ type: "move", origin, reason: "no-factor" }),
        );
      });
      it("ends left-origin when nothing answered there", async () => {
        const h = await askedThere();
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page after the answer shows a password field", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, `${origin}/signin`, "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page after the answer comes more than 30 seconds later", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
        onTestFinished(() => clock.mockRestore());
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("reads the tab's next page when the one it came back to went away", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        fake.state.gone = new Set(["callback-document"]);
        expect(await navigate(h, `${origin}/callback`, "callback-document", false)).toEqual({
          ok: false,
          reason: "stale-document",
        });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        await navigate(h, `${origin}/home`, "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("never completes on the account's username once such a page asked", async () => {
        const h = await askedThere();
        fake.state.signs = { ...quiet, username: true };
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page of another site asks for a passkey", async () => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = quiet;
        h.login.passkeyRequested(1, "https://auth.elsewhere.example");
        await navigate(h, "https://auth.elsewhere.example/passkey", "auth-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
    });
    describe("right after a password submission (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      const signedIn = { ...quiet, username: true };
      const reads = () => fake.state.messages.filter((entry) => entry.type === "login.state");
      const submitted = async () => {
        holdClicks(origin);
        const h = twoSites({ username: true });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = signedIn;
        return h;
      };
      it("completes when the site's other origin shows the account's username", async () => {
        const h = await submitted();
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        expect(await h.login.active()).toBe(false);
        // Read twice once loaded, each time with the username for the page's comparison.
        expect(reads()).toEqual([
          expect.objectContaining({ account: { username: "synthetic-secret" } }),
          expect.objectContaining({ account: { username: "synthetic-secret" } }),
        ]);
        expect(executes()).toHaveLength(2);
      });
      it("waits until the new page has loaded", async () => {
        const h = await submitted();
        fake.state.loaded = false;
        setTimeout(() => (fake.state.loaded = true), 1_500);
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        // Two readings while loading, then two once loaded.
        expect(reads()).toHaveLength(4);
      }, 10_000);
      it("reads again while the loaded page does not show the username yet", async () => {
        const h = await submitted();
        fake.state.signs = quiet;
        setTimeout(() => (fake.state.signs = signedIn), 1_500);
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        expect(reads()).toHaveLength(4);
      }, 10_000);
      it("ends left-origin when the new page does not show the username", async () => {
        const h = await submitted();
        fake.state.signs = quiet;
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toHaveLength(5);
      }, 10_000);
      it("ends left-origin without reading the page for an item without a username", async () => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = signedIn;
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toEqual([]);
      });
      it("saves the account choice and holds no other tab once it completes", async () => {
        holdClicks(origin);
        const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
        const h = harness(
          { siteDefaults: [], bindings: [] },
          { allowedOrigins: [], uris, username: true },
        );
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        expect(h.settings.settings.siteDefaults).toEqual([]);
        fake.state.signs = signedIn;
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        await vi.waitFor(() =>
          expect(h.settings.settings.siteDefaults).toMatchObject([{ origin, itemId }]),
        );
        // Another tab of the site logs in rather than being refused `origin-busy`.
        fake.state.onExecute = undefined;
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      });
      it("ends left-origin when the new page shows a password field", async () => {
        const h = await submitted();
        fake.state.signs = { ...signedIn, password: true };
        await navigate(h, "https://www.login.example/signin", "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page asks for a code", async () => {
        const h = await submitted();
        fake.state.signs = { ...signedIn, code: true };
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin on another registrable domain", async () => {
        const h = await submitted();
        await navigate(h, "https://elsewhere.example/home", "elsewhere-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toEqual([]);
      });
      it("ends left-origin when the move comes more than 30 seconds after the submission", async () => {
        const h = await submitted();
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
        onTestFinished(() => clock.mockRestore());
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toEqual([]);
      });
      describe("asks the judge once when the username does not show", () => {
        const www = "https://www.login.example";
        const movedHome = {
          ok: true,
          observation: {
            version: 1,
            origin: www,
            path: "/home",
            language: "en",
            complete: true,
            candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
          },
        };
        type JudgeAnswer = Awaited<ReturnType<LoginGeneration["judge"]>>;
        const judged = async (answer: () => Promise<JudgeAnswer>, runs?: LoginRecipe) => {
          const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
            args[4]?.();
            return answer();
          });
          const report = vi.fn<(entry: LoginReport) => void>();
          holdClicks(origin);
          const h = twoSites({
            username: true,
            report,
            generation: {
              available: vi.fn<LoginGeneration["available"]>(async () => true),
              generate: vi.fn<LoginGeneration["generate"]>(),
              generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
              judge,
              slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
            },
          });
          if (runs)
            h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
              from === origin && path === "/signin" ? runs : undefined,
            );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          fake.state.signs = quiet;
          fake.state.extracted = { "signed-in": movedHome };
          // The moved page shows the path it is described on.
          fake.state.observedPath = "/home";
          const judgements = () =>
            report.mock.calls.flatMap(([entry]) => (entry.type === "judge" ? [entry] : []));
          return { h, judge, judgements };
        };
        it("completes when the judge answers signed-in", async () => {
          const { h, judge, judgements } = await judged(async () => ({ verdict: "signed-in" }));
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
          expect(judge).toHaveBeenCalledTimes(1);
          expect(judge.mock.calls[0]!.slice(0, 4)).toEqual([
            recipe.id,
            recipe.revision,
            "password",
            movedHome.observation,
          ]);
          expect(judgements()).toEqual([
            expect.objectContaining({ verdict: "sent", origin: www, moved: true }),
            expect.objectContaining({ verdict: "signed-in", origin: www, moved: true }),
          ]);
          // Five readings for the username, then one more once the answer is back.
          expect(reads()).toHaveLength(6);
          expect(executes()).toHaveLength(2);
        }, 15_000);
        it("completes on a page judged signed-in before", async () => {
          const { h } = await judged(async () => ({
            verdict: "unclear",
            reason: "judged-signed-in",
          }));
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated" });
        }, 15_000);
        it("completes when the judge answers optional (ADR 0065)", async () => {
          const { h } = await judged(async () => ({ verdict: "optional" }));
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
          expect(at(origin)).not.toHaveProperty("unconfirmed");
        }, 15_000);
        it("ends left-origin on an optional page after the identifier alone", async () => {
          // The recipe submits the account's identifier only; the password comes later.
          const identifierOnly = parseLoginRecipe({
            ...recipe,
            slots: ["username"],
            steps: [
              {
                kind: "fill",
                path: "/signin",
                fields: [{ slot: "username", target: target("password") }],
              },
              recipe.steps[1]!,
            ],
          });
          const { h, judge } = await judged(async () => ({ verdict: "optional" }), identifierOnly);
          await navigate(h, `${www}/home`, "home-document", false);
          expect(judge).toHaveBeenCalledTimes(1);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it("ends left-origin when an optional page moved to another path", async () => {
          const { h } = await judged(async () => {
            fake.state.observedPath = "/verify";
            return { verdict: "optional" };
          });
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it("ends left-origin on an optional page whose description left out a choice", async () => {
          const { h } = await judged(async () => ({ verdict: "optional" }));
          fake.state.extracted = { "signed-in": { ...movedHome, inputLeftOut: true } };
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it("ends left-origin when an optional page then shows a code field", async () => {
          const { h } = await judged(async () => {
            fake.state.signs = { ...quiet, code: true };
            return { verdict: "optional" };
          });
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it.each([
          ["cannot decide", { verdict: "unclear" }],
          ["found the page undecided before", { verdict: "unclear", reason: "already-judged" }],
          ["answers challenge", { verdict: "challenge" }],
          ["is unreachable", { verdict: "retry", reason: "unreachable" }],
        ] as const)(
          "ends left-origin when the judge %s",
          async (_name, answer) => {
            const { h, judge, judgements } = await judged(async () => answer);
            await navigate(h, `${www}/home`, "home-document", false);
            expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
            expect(judge).toHaveBeenCalledTimes(1);
            expect(judgements().at(-1)).toMatchObject({ verdict: answer.verdict, moved: true });
          },
          15_000,
        );
        it("never marks a page beside the sign-in form on that origin", async () => {
          const { h, judge } = await judged(async () => ({ verdict: "unclear" }));
          fake.state.extracted = {
            "signed-in": {
              ok: true,
              observation: {
                ...movedHome.observation,
                path: "/signin",
                candidates: [
                  { id: "c1", role: "email", target: target("user"), group: "side" },
                  { id: "c2", role: "password", target: target("password"), group: "side" },
                  { id: "c3", role: "button", target: target("login"), group: "side" },
                  { id: "c4", role: "text", target: target("birth"), group: "box" },
                  { id: "c5", role: "button", target: target("submit"), group: "box" },
                ],
              },
            },
          };
          await navigate(h, `${www}/signin`, "signin-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
          expect(judge).toHaveBeenCalledTimes(1);
          // No branch, no partial description, no stop and no `beside`; the account's
          // slots come last.
          expect(judge.mock.calls[0]).toHaveLength(9);
          expect(judge.mock.calls[0]!.slice(5, 8)).toEqual([undefined, undefined, undefined]);
        }, 15_000);
        it("ends left-origin when the page shows a password field once the answer is back", async () => {
          const { h } = await judged(async () => {
            fake.state.signs = { ...quiet, password: true };
            return { verdict: "signed-in" };
          });
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it("ends left-origin when the page asks for a passkey while it is judged", async () => {
          let h: ReturnType<typeof harness> | undefined;
          ({ h } = await judged(async () => {
            h!.login.passkeyRequested(1, www);
            return { verdict: "signed-in" };
          }));
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it("logs a page it could not describe and sends nothing", async () => {
          const { h, judge, judgements } = await judged(async () => ({ verdict: "signed-in" }));
          fake.state.extracted = {};
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
          expect(judge).not.toHaveBeenCalled();
          expect(judgements()).toEqual([
            expect.objectContaining({ verdict: "not-sent", reason: "no-candidates", moved: true }),
          ]);
        }, 15_000);
        it("completes on a marker learned on that origin, without the judge", async () => {
          const learned = parseLoginRecipe({
            ...recipe,
            completion: [...recipe.completion!, { target: target("account"), origin: www }],
          });
          const { h, judge } = await judged(async () => ({ verdict: "unclear" }), learned);
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated" });
          expect(judge).not.toHaveBeenCalled();
          // Only the marker learned there is looked for on that page.
          expect(
            fake.state.messages.filter((entry) => entry.type === "login.observe").at(-1),
          ).toMatchObject({ targets: [target("account")] });
        }, 15_000);
        it("waits for the same document announcing again instead of judging it twice", async () => {
          let answer: (value: JudgeAnswer) => void = () => undefined;
          const { h, judge } = await judged(
            () => new Promise<JudgeAnswer>((resolve) => (answer = resolve)),
          );
          const first = navigate(h, `${www}/home`, "home-document", false);
          await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1), { timeout: 8_000 });
          const again = navigate(h, `${www}/home`, "home-document", false);
          // The second announcement reaches the move while the page is still being judged.
          await new Promise((resolve) => setTimeout(resolve, 200));
          answer({ verdict: "signed-in" });
          expect(await first).toEqual({ ok: false, reason: "stale-document" });
          await again;
          expect(judge).toHaveBeenCalledTimes(1);
          expect(at(origin)).toMatchObject({ state: "authenticated" });
        }, 15_000);
      });
      it("never completes on an http page of the site", async () => {
        const h = await submitted();
        // An http page is admitted (ADR 0050) but never stands for a login on HTTPS: the
        // login left its origin, as for a page of another site.
        expect(await navigate(h, "http://www.login.example/home", "home-document", false)).toEqual({
          ok: false,
          reason: "recipe-not-found",
        });
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toEqual([]);
      });
    });
    it("logs in again when the site's form shows again after it left", async () => {
      // site -> identity provider -> back to the site's login form (ADR 0022, ADR 0062).
      holdClicks(origin, second);
      const h = twoSites();
      const kinds = () =>
        executes().map(
          (entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
        );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
      // The site's record is released and its form logs in as on any visit.
      expect(await navigate(h, fake.state.pageUrl, "returned-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(6));
      expect(kinds()).toEqual(["fill", "click", "fill", "click", "fill", "click"]);
      expect(at(origin)).toMatchObject({ state: "submit-intent", submissions: 1 });
      expect(fake.state.badges[1]?.text ?? "").not.toMatch(/^\d+$/u);
      // Only the site's record was released; the identity provider's stays until its form shows.
      expect(at(second)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(h.fields).toHaveBeenCalledTimes(3);
    });
    it("never submits again when the tab returns to an origin it left", async () => {
      holdClicks(origin, second);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
      expect(at(second)).toMatchObject({ state: "submit-intent", submissions: 1 });
      // Back on a page of the first origin, which keeps its own ended record and only
      // watches for the login form (ADR 0021 D).
      expect(await navigate(h, fake.state.pageUrl, "returned-document", false)).toMatchObject({
        ok: false,
        reason: "logged-in",
      });
      expect(at(second)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
      });
      // And once more to the second origin, which also stays ended.
      expect(await navigate(h, secondUrl, "second-again", false)).toMatchObject({
        reason: "logged-in",
      });
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      expect(stored()).toHaveLength(2);
      expect(executes()).toHaveLength(4);
      expect(h.fields).toHaveBeenCalledTimes(2);
    });
    it("keeps another tab off an origin the tab left until the tab closes", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      fake.state.onExecute = undefined;
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
      for (const listener of fake.state.removed) listener(1);
      await vi.waitFor(() => expect(stored()).toEqual([]));
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab-again" })).toEqual({
        ok: true,
      });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([{ state: "authenticated", document: { tabId: 2 } }]),
      );
    });
    it("lets another tab log in once the tab's login authenticated", async () => {
      // The login form in another tab means the site's session has ended (ADR 0022).
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([
          { state: "authenticated", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
      expect(executes()).toHaveLength(4);
    });
    it.each(["wrong-account", "value-mismatch"] as const)(
      "lets another tab log in once Pateat stopped the tab's login as %s",
      async (reason) => {
        // Nothing was submitted, so another tab's login cannot submit the password twice.
        fake.state.executeReply = { ok: false, reason };
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: reason }),
        );
        fake.state.executeReply = undefined;
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(stored()).toMatchObject([
            { state: "blocked", outcome: reason, document: { tabId: 1 } },
            { state: "authenticated", document: { tabId: 2 } },
          ]),
        );
      },
    );
    it("lets another tab log in after a vault read failed before the page got anything", async () => {
      // The prepared fill never reached the page, so nothing can be in flight (ADR 0022).
      const h = twoSites();
      h.fields.mockRejectedValueOnce(new Error("synthetic vault failure"));
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "blocked",
          outcome: "policy-changed",
          submissions: 0,
        }),
      );
      expect(at(origin)?.mutationIntent).toBeUndefined();
      expect(executes()).toHaveLength(0);
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([
          { state: "blocked", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
    });
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
});
