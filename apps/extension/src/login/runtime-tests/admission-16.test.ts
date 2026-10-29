import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginEntryRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import { createRecipeRepairs } from "../repair";
import type { LoginPauses } from "../pause";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import type { PasskeyItem } from "../../passkeys/runtime";
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

    describe("a site's sign-in entry (ADR 0031)", () => {
      beforeEach(realTime);
      const entryUrl = `${origin}/?return_to=%2Fbookmarks`;
      const loginUrl = "https://accounts.login.example/login";
      const entryRecipe: LoginEntryRecipe = {
        version: 1,
        id: "synthetic-entry",
        revision: 2,
        origin,
        entry: { path: "/", target: { by: "text", value: "Login" } },
      };
      const entryPage = {
        ok: true,
        observation: {
          ...page("/", [
            {
              id: "c1",
              role: "link",
              target: { by: "text", value: "Create account" },
              label: "Create account",
            },
            { id: "c2", role: "link", target: { by: "text", value: "Login" }, label: "Login" },
          ]).observation,
        },
      };
      const inspected = (overrides: Record<string, unknown> = {}) => ({
        ok: true,
        state: "unique",
        href: loginUrl,
        url: fake.state.pageUrl,
        ...overrides,
      });

      const setup = (
        options: {
          entries?: LoginEntryRecipe[];
          overrides?: Partial<LocalSettings>;
          uris?: LiveUriMatcher;
          passkeyItems?: (origin: string) => Promise<readonly PasskeyItem[]>;
          pauses?: LoginPauses;
          otherUsername?: boolean;
          repairs?: boolean;
        } = {},
      ) => {
        fake.state.extracted = { entry: entryPage };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          { ...unsaved, ...options.overrides },
          {
            allowedOrigins: [],
            uris: options.uris ?? uris,
            username: true,
            ...(options.otherUsername ? { otherUsername: true } : {}),
            custom: [],
            generation: service,
            report,
            ...(options.entries ? { entries: options.entries } : {}),
            ...(options.passkeyItems ? { passkeyItems: options.passkeyItems } : {}),
            ...(options.pauses ? { pauses: options.pauses } : {}),
            ...(options.repairs
              ? {
                  repairs: createRecipeRepairs({
                    read: async () => fake.state.storage["repairs"],
                    write: async (value) => {
                      fake.state.storage["repairs"] = value;
                    },
                  }),
                }
              : {}),
          },
        );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        const reports = (type: LoginReport["type"]) =>
          report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === type);
        return { service, h, report, reports };
      };
      const sent = (type: string) =>
        (fake.state.messages as Record<string, unknown>[]).filter(
          (entry) => entry["type"] === type,
        );
      const blocks = () => fake.state.storage["pateat.login-entry-blocks.v1"];
      const presses = () => fake.state.session["pateat.login-entry-presses.v1"];
      beforeEach(() => {
        fake.state.pageUrl = entryUrl;
        fake.state.entry = {
          hosts: { ok: true, hosts: ["login.example", "accounts.login.example", "other.example"] },
          inspect: undefined,
          press: { ok: true },
          check: { ok: true, signIn: true, start: false, signUp: false },
        };
        fake.state.onPress = undefined;
      });
      afterEach(() => {
        vi.useRealTimers();
      });
      describe("the page after the press", () => {
        const pressed = async (options: Parameters<typeof setup>[0] = {}) => {
          fake.state.entry.inspect = inspected();
          const context = setup({ entries: [entryRecipe], ...options });
          expect(await context.h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() =>
            expect(context.reports("entry")).toEqual([
              expect.objectContaining({ outcome: "pressed" }),
            ]),
          );
          return context;
        };
        const next = { documentId: "next-page", url: loginUrl } as const;
        it("lets a login page of the site go on as any login page", async () => {
          const { h, reports } = await pressed();
          fake.state.pageUrl = loginUrl;
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toEqual([
            expect.objectContaining({ starts: [], timeoutMs: 10_000 }),
          ]);
          expect(reports("entry")).toHaveLength(1);
          expect(blocks()).toBeUndefined();
          expect(presses()).toEqual([expect.objectContaining({ checked: true })]);
          // Checked once: the next announcement is not checked again.
          await h.hello(next, false);
          expect(sent("login.entry.check")).toHaveLength(1);
        });
        it.each([
          [
            "a sign-up form",
            { url: loginUrl, check: { ok: true, signIn: true, start: false, signUp: true } },
            "sign-up",
          ],
          [
            "a page without a sign-in input",
            { url: loginUrl, check: { ok: true, signIn: false, start: false, signUp: false } },
            "no-sign-in",
          ],
          ["another site", { url: "https://other.example/oauth" }, "left-site"],
        ] as const)(
          "blocks the revision on %s and never sends that page",
          async (_label, option, reason) => {
            const { h, reports, service } = await pressed();
            if ("check" in option) fake.state.entry.check = option.check;
            fake.state.pageUrl = option.url;
            expect(await h.hello({ ...next, url: option.url }, false)).toMatchObject({
              ok: false,
              reason: "entry-blocked",
            });
            expect(reports("entry")[1]).toEqual({
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "blocked",
              reason,
            });
            expect(blocks()).toEqual([
              { recipeId: entryRecipe.id, revision: 2, reason, blockedAt: expect.any(String) },
            ]);
            // The blocked page is refused on each announcement, never offered for generation.
            expect(
              await h.login.handle(
                {
                  version: 1,
                  type: "login.document.ready",
                  token: "synthetic-token",
                  signIn: { path: new URL(option.url).pathname },
                },
                sender({ ...next, url: option.url }),
              ),
            ).toMatchObject({ reason: "entry-blocked" });
            expect(service.available).not.toHaveBeenCalled();
            // The blocked revision is not pressed again, even after the tab's limit.
            for (const listener of fake.state.removed.splice(0)) listener(1);
            fake.state.pageUrl = entryUrl;
            fake.state.messages = [];
            const again = setup({ entries: [entryRecipe] });
            expect(await again.h.hello({ documentId: "again" }, false)).toMatchObject({
              reason: "entry",
            });
            await vi.waitFor(() => expect(again.reports("entry")).toHaveLength(1));
            expect(again.reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "blocked",
            });
            expect(sent("login.entry.press")).toEqual([]);
          },
        );
        it("takes a same-document URL change as the next page", async () => {
          const { h, reports } = await pressed();
          fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: false };
          fake.state.pageUrl = `${origin}/?return_to=%2Fbookmarks#login`;
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry-blocked" });
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
        });
        it("blocks a press whose tab showed no next page within 10 seconds", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { reports } = await pressed();
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
          expect(blocks()).toEqual([expect.objectContaining({ reason: "no-sign-in" })]);
        });
        it("blocks a press whose tab went to another site without announcing", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { reports } = await pressed();
          fake.state.tabUrls[1] = "https://other.example/excluded";
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "left-site" });
        });
        it("checks the next page of a press a restarted worker finds in the session", async () => {
          await pressed();
          // A new worker reads the press the old one stored; the old one is never asked again.
          fake.state.messages = [];
          fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: true };
          const restarted = setup({ entries: [entryRecipe] });
          fake.state.pageUrl = loginUrl;
          expect(await restarted.h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
          expect(restarted.reports("entry")).toEqual([
            expect.objectContaining({ outcome: "blocked", reason: "sign-up" }),
          ]);
        });
        it("checks only the pressing tab's top document after the pressed page", async () => {
          const { h, reports } = await pressed();
          fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: false };
          // The pressed document announcing again on the pressed URL is not the next page.
          await h.hello({}, false);
          // Nor is a frame of the tab, or a page of the site in another tab.
          fake.state.pageUrl = loginUrl;
          await h.hello(
            { frameId: 3, documentId: "frame", url: loginUrl, tab: { id: 1, url: loginUrl } },
            false,
          );
          fake.state.tabUrls[2] = loginUrl;
          expect(
            await h.hello({ tab: { id: 2 }, documentId: "other-tab", url: loginUrl }, false),
          ).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toEqual([]);
          expect(blocks()).toBeUndefined();
          expect(presses()).toEqual([expect.not.objectContaining({ checked: true })]);
          expect(reports("entry")).not.toContainEqual(
            expect.objectContaining({ outcome: "blocked" }),
          );
          // The tab's own next top document is still checked.
          fake.state.entry.check = { ok: true, signIn: true, start: false, signUp: false };
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toHaveLength(1);
          expect(presses()).toEqual([expect.objectContaining({ checked: true })]);
        });
        it("blocks only the pressed revision of its recipe, and presses a newer revision", async () => {
          const blockedAt = "2026-10-12T07:00:00.000Z";
          const otherBlock = {
            recipeId: "other-entry",
            revision: 2,
            reason: "left-site",
            blockedAt,
          };
          // A block of an older revision of the same recipe, and one of another recipe.
          fake.state.storage["pateat.login-entry-blocks.v1"] = [
            otherBlock,
            { recipeId: entryRecipe.id, revision: 1, reason: "sign-up", blockedAt },
          ];
          const { h, reports } = await pressed();
          fake.state.entry.check = { ok: true, signIn: true, start: false, signUp: true };
          fake.state.pageUrl = loginUrl;
          expect(await h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
          // The older revision's block gives way; the other recipe's block stays.
          expect(blocks()).toEqual([
            otherBlock,
            {
              recipeId: entryRecipe.id,
              revision: 2,
              reason: "sign-up",
              blockedAt: expect.any(String),
            },
          ]);
          // The recipe sync brings revision 3, which the block of revision 2 does not hold.
          h.recipes.entries.mockResolvedValue([{ ...entryRecipe, revision: 3 }]);
          fake.state.pageUrl = entryUrl;
          fake.state.tabUrls[2] = entryUrl;
          expect(
            await h.hello({ tab: { id: 2 }, documentId: "revision-3", url: entryUrl }, false),
          ).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(3));
          expect(reports("entry")[2]).toMatchObject({
            tabId: 2,
            recipeRevision: 3,
            outcome: "pressed",
          });
        });
        it("checks in time a press a restarted worker finds unchecked, and leaves a checked one", async () => {
          const pressedAt = new Date(Date.now() - 30_000).toISOString();
          const press = (tabId: number, checked: boolean) => ({
            tabId,
            origin,
            recipeId: entryRecipe.id,
            revision: 2,
            pressedAt,
            documentId: `pressed-${tabId}`,
            url: entryUrl,
            ...(checked ? { checked: true } : {}),
          });
          fake.state.session["pateat.login-entry-presses.v1"] = [press(1, false), press(2, true)];
          // Both tabs still show the pressed page; no next page announced before the restart.
          const { reports } = setup({ entries: [entryRecipe] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "blocked",
              reason: "no-sign-in",
            },
          ]);
          expect(presses()).toEqual([
            expect.objectContaining({ tabId: 1, checked: true }),
            expect.objectContaining({ tabId: 2, checked: true }),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(reports("entry")).toHaveLength(1);
        });
        it("settles a press whose next page's check was lost, once the timer comes due again", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { h, reports } = await pressed();
          let fail!: () => void;
          fake.state.entry.check = new Promise((_resolve, reject) => {
            fail = () => reject(new Error("Receiving end does not exist."));
          });
          fake.state.pageUrl = loginUrl;
          const answer = h.hello(next, false);
          await vi.waitFor(() => expect(sent("login.entry.check")).toHaveLength(1));
          // The press's timer comes due while the check runs and leaves the press to it.
          await vi.advanceTimersByTimeAsync(15_000);
          expect(reports("entry")).toHaveLength(1);
          fail();
          expect(await answer).not.toMatchObject({ reason: "entry-blocked" });
          // The tab shows another page of the site, which gets the step wait once more.
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toEqual({
            type: "entry",
            tabId: 1,
            origin,
            recipeId: entryRecipe.id,
            recipeRevision: 2,
            outcome: "blocked",
            reason: "no-sign-in",
          });
          expect(blocks()).toEqual([expect.objectContaining({ reason: "no-sign-in" })]);
        });
        it("settles a press as no-sign-in when its next page comes too late, but lets that page go on", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { h, reports } = await pressed();
          // The clock moves past the press's wait and the step wait before any timer runs.
          vi.setSystemTime(Date.now() + 25_000);
          fake.state.pageUrl = loginUrl;
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toEqual([]);
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
          expect(blocks()).toEqual([expect.objectContaining({ reason: "no-sign-in" })]);
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(reports("entry")).toHaveLength(2);
        });
        it("lets a page on another site that comes too late go on, and settles the press as no-sign-in", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { h, reports } = await pressed();
          vi.setSystemTime(Date.now() + 25_000);
          const elsewhere = "https://other.example/oauth";
          fake.state.pageUrl = elsewhere;
          expect(await h.hello({ ...next, url: elsewhere }, false)).not.toMatchObject({
            reason: "entry-blocked",
          });
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
        });
        it.each([
          ["no URL yet", ""],
          ["a URL that does not parse", "not a URL"],
        ])("waits once more for a tab with %s, then blocks the press", async (_label, url) => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { reports } = await pressed();
          fake.state.tabUrls[1] = url;
          await vi.advanceTimersByTimeAsync(10_000);
          expect(reports("entry")).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
        });
        it("refuses every announcement of a page that blocked the press, also one that overtook its check", async () => {
          const { h, reports } = await pressed();
          let answer!: (value: unknown) => void;
          fake.state.entry.check = new Promise((resolve) => {
            answer = resolve;
          });
          fake.state.pageUrl = loginUrl;
          const first = h.hello(next, false);
          await vi.waitFor(() => expect(sent("login.entry.check")).toHaveLength(1));
          const second = h.hello(next, false);
          answer({ ok: true, signIn: true, start: false, signUp: true });
          expect(await first).toMatchObject({ reason: "stale-document" });
          expect(await second).toMatchObject({ reason: "entry-blocked" });
          expect(await h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toHaveLength(1);
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "sign-up" });
        });
        it("keeps other recipes' blocks when the device's blocks cannot be read, and blocks in this worker", async () => {
          const otherBlock = {
            recipeId: "other-entry",
            revision: 2,
            reason: "left-site",
            blockedAt: "2026-10-12T07:00:00.000Z",
          };
          fake.state.storage["pateat.login-entry-blocks.v1"] = [otherBlock];
          // A restarted worker finds the press and has not read the device's blocks yet.
          fake.state.session["pateat.login-entry-presses.v1"] = [
            {
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              revision: 2,
              pressedAt: new Date().toISOString(),
              documentId: "pressed-document",
              url: entryUrl,
            },
          ];
          fake.state.entry.check = { ok: true, signIn: true, start: false, signUp: true };
          const local = fake.browser.storage.local;
          const get = local.get;
          const failing = vi
            .spyOn(local, "get")
            .mockImplementation(async (keys: string | string[]) =>
              [keys].flat().includes("pateat.login-entry-blocks.v1")
                ? Promise.reject(new Error("storage unavailable"))
                : get(keys),
            );
          try {
            const { h, reports } = setup({ entries: [entryRecipe] });
            fake.state.pageUrl = loginUrl;
            expect(await h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
            expect(reports("entry")).toEqual([
              {
                type: "entry",
                tabId: 1,
                origin,
                recipeId: entryRecipe.id,
                recipeRevision: 2,
                outcome: "blocked",
                reason: "sign-up",
                detail: "storage-unavailable",
              },
            ]);
            expect(blocks()).toEqual([otherBlock]);
            failing.mockRestore();
            // The device's blocks read again do not hold it, but this worker does.
            fake.state.pageUrl = entryUrl;
            fake.state.tabUrls[2] = entryUrl;
            fake.state.entry.inspect = inspected();
            expect(
              await h.hello({ tab: { id: 2 }, documentId: "other-tab", url: entryUrl }, false),
            ).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
            expect(reports("entry")[1]).toMatchObject({
              tabId: 2,
              outcome: "refused",
              reason: "blocked",
            });
            expect(sent("login.entry.press")).toEqual([]);
          } finally {
            failing.mockRestore();
          }
        });
      });
    });
    it.each([
      ["the extractor's refusal", { ok: false, reason: "no-locator" }, "no-locator"],
      ["an answer that fails its check", { ok: true }, "extract-failed"],
    ] as const)(
      "logs %s when the page cannot be described",
      async (_name, extracted, reason) => {
        vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
        onTestFinished(() => void vi.useRealTimers());
        fake.state.extracted = { login: extracted };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() =>
          expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
        );
        // Read ten times a second apart, as a form rendered in steps or fading in may still
        // settle, and logged once.
        await vi.advanceTimersByTimeAsync(9_000);
        await vi.waitFor(() =>
          expect(report).toHaveBeenCalledWith({
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason,
          }),
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fake.state.messages.filter((entry) => entry.type === "login.extract")).toHaveLength(
          10,
        );
        expect(report.mock.calls.filter(([value]) => value.type === "generation")).toHaveLength(1);
        expect(service.generate).not.toHaveBeenCalled();
      },
      10_000,
    );
    it("stops at once for a cancelled document", async () => {
      fake.state.extracted = { login: { ok: false, reason: "cancelled" } };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "generation", outcome: "skipped", reason: "cancelled" }),
        ),
      );
      expect(fake.state.messages.filter((entry) => entry.type === "login.extract")).toHaveLength(1);
    });
    it("reads a page again that could not be described yet", async () => {
      fake.state.extracted = { login: { ok: false, reason: "no-locator" } };
      const service = generation();
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      // The form finishes rendering before the next read.
      fake.state.extracted = { login: loginPage };
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalled(), { timeout: 4_000 });
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        observation: loginPage.observation,
      });
    }, 10_000);
    it("sends a page whose form still fades in seconds after it offers itself", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
      onTestFinished(() => void vi.useRealTimers());
      // The form's fields are transparent while an ancestor waits to fade in.
      fake.state.extracted = {
        login: {
          ...loginPage,
          observation: { ...loginPage.observation, complete: false },
          gap: "unfillable-field",
        },
      };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(service.generate).not.toHaveBeenCalled();
      // The form is opaque about five seconds after the offer.
      fake.state.extracted = { login: loginPage };
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        observation: loginPage.observation,
      });
      expect(report).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "generation", outcome: "skipped" }),
      );
    }, 10_000);
    it("offers nothing for a page sent recently, a path a recipe starts on, a frame or an incomplete description", async () => {
      const service = generation({ available: async () => "sent" as const });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      // The log says once per document why a page with no recipe is not sent.
      const generations = () =>
        report.mock.calls.flatMap(([value]) => (value.type === "generation" ? [value] : []));
      expect(generations()).toEqual([
        { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "sent" },
      ]);

      service.available.mockResolvedValue(true);
      // Recipes that start on this path (two, so neither is selected), or an unreadable cache.
      fake.state.extracted = { login: loginPage };
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!, generated.steps[0]!]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      h.recipes.starts.mockRejectedValue(new Error("cache"));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(service.generate).not.toHaveBeenCalled();

      // The extractor's gap says why, without page text (ADR 0019).
      fake.state.extracted = {
        login: {
          ...loginPage,
          observation: { ...loginPage.observation, complete: false },
          gap: "unlocated-button",
        },
      };
      vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
      onTestFinished(() => void vi.useRealTimers());
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      await vi.advanceTimersByTimeAsync(9_000);
      await vi.waitFor(() =>
        expect(generations().at(-1)).toEqual({
          type: "generation",
          tabId: 1,
          origin,
          outcome: "skipped",
          reason: "incomplete-observation",
          detail: "unlocated-button",
        }),
      );
      expect(service.generate).not.toHaveBeenCalled();

      fake.state.tabUrls = { 1: "https://top.example/" };
      expect(
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "frame-token",
            signIn: { path: "/" },
          },
          sender({
            frameId: 3,
            documentId: "frame-document",
            tab: { id: 1, url: "https://login.example/" },
          }),
        ),
        // A frame is never sent, only asked to report a verification it shows (ADR 0035).
      ).toEqual({ ok: false, reason: "recipe-not-found", frame: true });
      expect(service.generate).not.toHaveBeenCalled();
    }, 10_000);
  });
});
