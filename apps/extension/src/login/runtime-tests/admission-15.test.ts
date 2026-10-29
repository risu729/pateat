import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const {
  origin,
  itemId,
  sender,
  target,
  startsOf,
  recipe,
  userId,
  savedBinding,
  uriMatch,
  harness,
  setPause,
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

  describe("on a page without a recipe", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    void parseLoginRecipe({
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
      describe("sending the page", () => {
        describe("on a page that also lists accounts (ADR 0028)", () => {
          const listPage = {
            ok: true,
            observation: { ...entryPage.observation, accounts: ["[account]"] },
          };
          const bothHello = (
            h: ReturnType<typeof harness>,
            names?: string[],
            from: Record<string, unknown> = {},
          ) =>
            h.login.handle(
              {
                version: 1,
                type: "login.document.ready",
                token: "synthetic-token",
                list: { path: "/", ...(names ? { names } : {}) },
                entry: { path: "/" },
              },
              sender(from),
            );
          it("sends neither after a password form was submitted, logging it once", async () => {
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            await h.login.handle(
              { version: 1, type: "login.document.submitted", token: "synthetic-token" },
              sender(),
            );
            const from = { documentId: "after-sign-in" };
            expect(await h.hello(from, false)).toMatchObject({ entry: true });
            expect(await bothHello(h, ["Help"], from)).not.toEqual({
              ok: false,
              reason: "generating",
            });
            expect(service.generate).not.toHaveBeenCalled();
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(sent("login.extract")).toEqual([]);
            expect(reports("generation")).toEqual([
              expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
            ]);
          });
        });
      });
      describe("an entry whose link no longer shows (ADR 0041 section 6)", () => {
        const generatedEntry: LoginEntryRecipe = { ...entryRecipe, id: `gen-${"e".repeat(32)}` };
        it("sends the page for repair as an entry page", async () => {
          fake.state.entry.inspect = inspected({ state: "missing", href: undefined });
          const { service, h, reports } = setup({ entries: [generatedEntry], repairs: true });
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(service.generateEntry).toHaveBeenCalledTimes(1));
          expect(service.generateEntry).toHaveBeenCalledWith(
            {
              version: 1,
              observation: entryPage.observation,
              repair: { recipeId: generatedEntry.id, revision: 2 },
            },
            expect.any(Function),
          );
          expect(service.generate).not.toHaveBeenCalled();
          expect(reports("repair")).toEqual([
            expect.objectContaining({ recipeId: generatedEntry.id, outcome: "due" }),
          ]);
          expect(reports("entry")).toEqual([
            expect.objectContaining({ outcome: "refused", reason: "target-missing" }),
          ]);
        });
        it("sends a page that asks for a sign-in now as a form, and nothing for an error status", async () => {
          fake.state.entry.inspect = inspected({
            state: "missing",
            href: undefined,
            shows: "sign-in",
          });
          const { service, h } = setup({ entries: [generatedEntry], repairs: true });
          fake.state.extracted = {
            login: page("/", [
              {
                id: "c1",
                role: "password",
                target: { by: "id", value: "password" },
                label: "Password",
              },
              { id: "c2", role: "button", target: { by: "id", value: "go" }, label: "Sign in" },
            ]),
          };
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
          expect(service.generate).toHaveBeenCalledWith(
            expect.objectContaining({ repair: { recipeId: generatedEntry.id, revision: 2 } }),
            expect.any(Function),
          );
          expect(service.generateEntry).not.toHaveBeenCalled();

          // A maintenance page answered 503 is never sent.
          fake.state.entry.inspect = inspected({ state: "missing", href: undefined, status: 503 });
          const down = setup({ entries: [generatedEntry], repairs: true });
          expect(await down.h.hello({ documentId: "down" }, false)).toMatchObject({
            reason: "entry",
          });
          await vi.waitFor(() =>
            expect(down.reports("repair")).toEqual([
              expect.objectContaining({ outcome: "skipped", reason: "status" }),
            ]),
          );
          expect(down.service.generateEntry).not.toHaveBeenCalled();
          expect(down.service.generate).not.toHaveBeenCalled();
        });
      });
      describe("pressing the entry", () => {
        it("presses the one on-site link after its checks and stores the press first", async () => {
          fake.state.entry.inspect = inspected();
          let stored: unknown;
          fake.state.onPress = () => {
            stored = presses();
          };
          const { h, reports } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "pressed",
            },
          ]);
          expect(sent("login.entry.inspect")).toEqual([
            expect.objectContaining({ target: entryRecipe.entry.target, timeoutMs: 10_000 }),
          ]);
          expect(sent("login.entry.press")).toEqual([
            expect.objectContaining({
              target: entryRecipe.entry.target,
              href: loginUrl,
              url: entryUrl,
            }),
          ]);
          expect(stored).toEqual([
            {
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              revision: 2,
              pressedAt: expect.any(String),
              documentId: "synthetic-document",
              url: entryUrl,
              // The login on the next page takes the entry page's time over (ADR 0019).
              timing: { since: expect.any(Number), serviceMs: 0, networkMs: 0, personMs: 0 },
            },
          ]);
          // The press is no attempt: nothing is recorded, held or read from the vault.
          expect(fake.state.storage["pateat.login-attempts.v5"] ?? []).toEqual([]);
          expect(h.fields).not.toHaveBeenCalled();
        });
        it.each([
          ["a page that names no return target", { url: `${origin}/` }, "no-return-target"],
          ["a missing link", { inspect: { state: "missing" } }, "target-missing"],
          ["a link named twice", { inspect: { state: "ambiguous" } }, "target-ambiguous"],
          ["a button", { inspect: { refusal: "not-link", href: undefined } }, "not-link"],
          ["a script link", { inspect: { refusal: "script-link" } }, "script-link"],
          ["a link that opens a new tab", { inspect: { refusal: "new-window" } }, "new-window"],
          ["a link with only an image", { inspect: { refusal: "no-text" } }, "no-text"],
          [
            "an `http:` link",
            { inspect: { href: "http://accounts.login.example/login" } },
            "link-not-https",
          ],
          [
            "a link to another site",
            { inspect: { href: "https://other.example/login" } },
            "link-off-site",
          ],
          [
            "a link naming another site in its query",
            { inspect: { href: `${loginUrl}?next=%2F%5Cevil.example%2F` } },
            "link-query-off-site",
          ],
          [
            "a page whose URL changed while it was inspected",
            { inspect: { url: `${origin}/` } },
            "no-return-target",
          ],
          [
            "a destination on an excluded site",
            {
              overrides: {
                excludedSites: [{ hostname: "accounts.login.example", includeSubdomains: false }],
              },
            },
            "destination-excluded",
          ],
          [
            "no vault item matching the page",
            { uris: async () => ({ ok: true as const, data: uriMatch({ candidates: [] }) }) },
            "no-vault-match",
          ],
          [
            "a blocked revision",
            {
              block: {
                recipeId: "synthetic-entry",
                revision: 2,
                reason: "sign-up",
                blockedAt: "2026-10-12T07:30:04.000Z",
              },
            },
            "blocked",
          ],
          [
            "a link the page changed before the click",
            { press: { ok: false, reason: "target-changed" } },
            "target-changed",
          ],
          [
            "a page that navigated between the check and the click",
            { press: { ok: false, reason: "page-changed" } },
            "page-changed",
          ],
          [
            "a document that went away before the click",
            { press: { ok: false, reason: "cancelled" } },
            "cancelled",
          ],
          [
            "a page inspected on another origin of the site",
            { inspect: { url: "https://accounts.login.example/?return_to=%2Fbookmarks" } },
            "page-changed",
          ],
          [
            "a page inspected on another path of the origin",
            { inspect: { url: `${origin}/other?return_to=%2Fbookmarks` } },
            "page-changed",
          ],
          [
            "a link whose userinfo names the site",
            { inspect: { href: "https://login.example@other.example/login" } },
            "link-off-site",
          ],
          [
            "a link naming another site in a second query value",
            { inspect: { href: `${loginUrl}?next=%2Fok&next=https%3A%2F%2Fother.example%2F` } },
            "link-query-off-site",
          ],
          [
            "a link whose `href` does not parse",
            { inspect: { href: "not a URL" } },
            "link-off-site",
          ],
          [
            "a link to the page itself, only at another fragment",
            { inspect: { href: `${entryUrl}#login` } },
            "link-same-page",
          ],
          [
            "a link whose query key names another site",
            { inspect: { href: `${loginUrl}?https%3A%2F%2Fother.example%2F` } },
            "link-query-off-site",
          ],
          ["a link that downloads", { inspect: { refusal: "download" } }, "download"],
        ] as const)("refuses %s, logging why", async (_label, options, reason) => {
          const option = options as {
            url?: string;
            inspect?: Record<string, unknown>;
            overrides?: Partial<LocalSettings>;
            uris?: LiveUriMatcher;
            block?: Record<string, unknown>;
            press?: unknown;
          };
          if (option.url) fake.state.pageUrl = option.url;
          fake.state.entry.inspect = inspected(option.inspect);
          if (option.press) fake.state.entry.press = option.press;
          if (option.block) fake.state.storage["pateat.login-entry-blocks.v1"] = [option.block];
          const { h, reports } = setup({
            entries: [entryRecipe],
            ...(option.overrides ? { overrides: option.overrides } : {}),
            ...(option.uris ? { uris: option.uris } : {}),
          });
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "refused",
              reason,
            },
          ]);
          expect(sent("login.entry.press")).toHaveLength(option.press ? 1 : 0);
          // A press that clicked nothing does not count against the tab's limit.
          expect(presses() ?? []).toEqual([]);
        });
        it("refuses a press while the recipe changed or a frame announces", async () => {
          fake.state.entry.inspect = inspected();
          const { h, reports } = setup({ entries: [entryRecipe] });
          // A frame never presses; it gets no entry recipe at all.
          expect(
            await h.hello(
              { frameId: 3, documentId: "frame", tab: { id: 1, url: entryUrl } },
              false,
            ),
          ).toEqual({ ok: false, reason: "recipe-not-found" });
          expect(sent("login.entry.inspect")).toEqual([]);
          // The cache moved on to a newer revision before the press.
          h.recipes.entries.mockResolvedValueOnce([entryRecipe]);
          h.recipes.entries.mockResolvedValue([{ ...entryRecipe, revision: 3 }]);
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")[0]).toMatchObject({
            outcome: "refused",
            reason: "recipe-changed",
          });
        });
        describe("with a login of the site", () => {
          const saved = {
            siteDefaults: [
              { origin, provider: "bitwarden" as const, server: "cloud-us", userId, itemId },
            ],
            bindings: [savedBinding],
          };
          const signin = `${origin}/signin`;
          const withLogin = () => {
            fake.state.entry.inspect = inspected();
            const context = setup({ entries: [entryRecipe], overrides: saved });
            context.h.recipes.recipe.mockImplementation(async (_at, path) =>
              path === "/signin" ? recipe : undefined,
            );
            context.h.recipes.starts.mockResolvedValue(startsOf([recipe.steps[0]!]));
            return context;
          };
          it("refuses a press in a tab that already ran a login on the site", async () => {
            // The entry page is another origin of the login's site.
            const www = "https://www.login.example";
            const wwwEntry = { ...entryRecipe, origin: www };
            fake.state.entry.inspect = inspected({ url: `${www}/?return_to=%2Fbookmarks` });
            const context = setup({
              entries: [wwwEntry],
              overrides: saved,
              uris: async (_connection, url) => ({
                ok: true,
                data: uriMatch({ targetOrigin: new URL(url).origin }),
              }),
            });
            const { h, reports } = context;
            h.recipes.recipe.mockImplementation(async (at, path) =>
              at === origin && path === "/signin" ? recipe : undefined,
            );
            h.recipes.starts.mockImplementation(async (at) =>
              at === origin ? startsOf([recipe.steps[0]!]) : [],
            );
            fake.state.tabUrls[1] = signin;
            expect(await h.hello({ documentId: "login", url: signin })).toEqual({ ok: true });
            await vi.waitFor(() =>
              expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
                { state: "authenticated" },
              ]),
            );
            const entryAt = `${www}/?return_to=%2Fbookmarks`;
            fake.state.tabUrls[1] = entryAt;
            expect(await h.hello({ documentId: "entry", url: entryAt }, false)).toMatchObject({
              reason: "entry",
            });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              origin: www,
              outcome: "refused",
              reason: "site-record",
            });
          });
          it("refuses a press while the site is paused (ADR 0062)", async () => {
            fake.state.entry.inspect = inspected();
            const { h, reports } = setup({ entries: [entryRecipe] });
            await setPause(h, true);
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({ outcome: "refused", reason: "paused" });
            expect(sent("login.entry.press")).toEqual([]);
          });
          it("refuses a press while another tab's login holds the site", async () => {
            const { h, reports } = withLogin();
            // The other tab's login stays on its first step.
            fake.state.onExecute = () => new Promise(() => undefined);
            fake.state.tabUrls[2] = signin;
            await h.hello({ tab: { id: 2 }, documentId: "login", url: signin });
            await vi.waitFor(() => expect(sent("login.execute")).toHaveLength(1));
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({ outcome: "refused", reason: "site-held" });
          });
        });
        it("presses at most once per tab in 10 minutes", async () => {
          const recent = new Date(Date.now() - 5 * 60_000).toISOString();
          const old = new Date(Date.now() - 11 * 60_000).toISOString();
          const stored = (pressedAt: string) => [
            {
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              revision: 2,
              pressedAt,
              documentId: "earlier-document",
              url: entryUrl,
              checked: true,
            },
          ];
          fake.state.entry.inspect = inspected();
          fake.state.session["pateat.login-entry-presses.v1"] = stored(recent);
          const limited = setup({ entries: [entryRecipe] });
          expect(await limited.h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(limited.reports("entry")).toHaveLength(1));
          expect(limited.reports("entry")[0]).toMatchObject({
            outcome: "refused",
            reason: "press-limit",
          });
          // Another tab is not limited by this one's press.
          expect(
            await limited.h.hello({ tab: { id: 2 }, documentId: "other-tab" }, false),
          ).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(limited.reports("entry")).toHaveLength(2));
          expect(limited.reports("entry")[1]).toMatchObject({ tabId: 2, outcome: "pressed" });
          for (const listener of fake.state.removed.splice(0))
            for (const tab of [1, 2]) listener(tab);
          fake.state.session = { "pateat.login-entry-presses.v1": stored(old) };
          const later = setup({ entries: [entryRecipe] });
          expect(await later.h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(later.reports("entry")).toHaveLength(1));
          expect(later.reports("entry")[0]).toMatchObject({ outcome: "pressed" });
        });
        it("refuses another document's press while one is checked, and logs a refusal once", async () => {
          let release!: () => void;
          fake.state.entry.inspect = new Promise((resolve) => {
            release = () => resolve(inspected({ state: "missing" }));
          });
          const { h, reports } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          // The same document announcing again leaves the running check alone.
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          expect(await h.hello({ documentId: "next" }, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")[0]).toMatchObject({ outcome: "refused", reason: "in-progress" });
          // The first document was replaced meanwhile, so its press stops without a click.
          release();
          await vi.waitFor(() => expect(sent("login.entry.inspect")).toHaveLength(1));
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(sent("login.entry.press")).toEqual([]);
          expect(reports("entry")).toHaveLength(1);
        });
        it("takes a press the page never answered as none, checks no next page and limits the tab", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          fake.state.entry.inspect = inspected();
          // The document gave no answer to the press, so nothing says the link was clicked.
          fake.state.onPress = () => {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          };
          const { h, reports } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "refused",
              reason: "unconfirmed",
            },
          ]);
          // It still counts against the tab's limit, but no check of a next page is due.
          expect(presses()).toEqual([
            expect.objectContaining({ tabId: 1, recipeId: entryRecipe.id, checked: true }),
          ]);
          await vi.advanceTimersByTimeAsync(30_000);
          expect(reports("entry")).toHaveLength(1);
          expect(blocks()).toBeUndefined();
          fake.state.onPress = undefined;
          fake.state.pageUrl = loginUrl;
          await h.hello({ documentId: "next-page", url: loginUrl }, false);
          expect(sent("login.entry.check")).toEqual([]);
          // The tab comes back to the entry page in a new document: the same worker refuses.
          fake.state.pageUrl = entryUrl;
          expect(await h.hello({ documentId: "back-again" }, false)).toMatchObject({
            reason: "entry",
          });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "refused", reason: "press-limit" });
          expect(sent("login.entry.press")).toHaveLength(1);
        });
        it("logs a refusal the document repeats as a repeat, and a new document's afresh", async () => {
          fake.state.entry.inspect = inspected({ state: "missing" });
          const { h, reports } = setup({ entries: [entryRecipe] });
          const refusal = {
            type: "entry",
            tabId: 1,
            origin,
            recipeId: entryRecipe.id,
            recipeRevision: 2,
            outcome: "refused",
            reason: "target-missing",
          };
          for (const [count, documentId] of [
            [1, "synthetic-document"],
            [2, "synthetic-document"],
            [3, "other-document"],
          ] as const) {
            // eslint-disable-next-line no-await-in-loop
            expect(await h.hello({ documentId }, false)).toMatchObject({ reason: "entry" });
            // eslint-disable-next-line no-await-in-loop
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(count));
          }
          expect(reports("entry")).toEqual([refusal, { ...refusal, repeat: true }, refusal]);
        });
        it("logs why it stops when the tab cannot be read or shows another origin", async () => {
          fake.state.entry.inspect = inspected();
          const { h, reports } = setup({ entries: [entryRecipe] });
          // Every read of the tab after the entry recipe was looked up is the press's.
          let failing = false;
          const entries = h.recipes.entries.getMockImplementation()!;
          h.recipes.entries.mockImplementation(async (at) => {
            const found = await entries(at);
            if (found.length) failing = true;
            return found;
          });
          const get = fake.browser.tabs.get;
          const read = vi.spyOn(fake.browser.tabs, "get").mockImplementation(async (id: number) => {
            if (failing) throw new Error("No tab with id.");
            return get(id);
          });
          try {
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "tab-unavailable",
            });
          } finally {
            read.mockRestore();
          }
          // The tab already shows another origin when the press starts.
          h.recipes.entries.mockImplementation(async (at) => {
            const found = await entries(at);
            if (found.length) fake.state.tabUrls[1] = "https://other.example/";
            return found;
          });
          expect(await h.hello({ documentId: "moved" }, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "refused", reason: "page-changed" });
          expect(sent("login.entry.inspect")).toEqual([]);
        });
        it("refuses, logging why, when the device's blocks cannot be read, and reads them again", async () => {
          fake.state.entry.inspect = inspected();
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
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "storage-unavailable",
            });
            expect(sent("login.entry.inspect")).toEqual([]);
            failing.mockRestore();
            // A failed read is not kept: the next document reads the blocks again.
            expect(await h.hello({ documentId: "later" }, false)).toMatchObject({
              reason: "entry",
            });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
            expect(reports("entry")[1]).toMatchObject({ outcome: "pressed" });
          } finally {
            failing.mockRestore();
          }
        });
        it("refuses, logging why, when the press cannot be stored, and clicks nothing", async () => {
          fake.state.entry.inspect = inspected();
          const session = fake.browser.storage.session;
          const set = session.set;
          const failing = vi
            .spyOn(session, "set")
            .mockImplementation(async (values: Record<string, unknown>) =>
              Array.isArray(values["pateat.login-entry-presses.v1"]) &&
              (values["pateat.login-entry-presses.v1"] as unknown[]).length > 0
                ? Promise.reject(new Error("storage unavailable"))
                : set(values),
            );
          try {
            const { h, reports } = setup({ entries: [entryRecipe] });
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "storage-unavailable",
            });
            expect(sent("login.entry.press")).toEqual([]);
            expect(presses() ?? []).toEqual([]);
          } finally {
            failing.mockRestore();
          }
        });
      });
    });
  });
});
