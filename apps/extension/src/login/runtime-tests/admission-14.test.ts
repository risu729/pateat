import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginEntryRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import { createRecipeRepairs } from "../repair";
import type { LoginPauses } from "../pause";
import type { LoginGeneration, LoginReport } from "../runtime";
import type { PasskeyItem } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  sender,
  target,
  startsOf,
  recipe,
  otherItemId,
  uriMatch,
  harness,
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
      const entryHello = (h: ReturnType<typeof harness>, from: Record<string, unknown> = {}) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            entry: { path: new URL(String(from["url"] ?? fake.state.pageUrl)).pathname },
          },
          sender(from),
        );
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
        it("sends no page whose site was paused while it was read (ADR 0062)", async () => {
          let pausedTill: number | undefined;
          const { service, h, reports } = setup({
            pauses: {
              until: async () => pausedTill,
              pause: async () => pausedTill,
              resume: async () => false,
              clearIncognito: async () => undefined,
            },
          });
          expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
          // The person pauses the site while its page is read for generation.
          fake.state.extracted = {
            get entry() {
              pausedTill = Date.now() + 60_000;
              return entryPage;
            },
          };
          expect(await entryHello(h)).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() => expect(sent("login.reconnect")).toHaveLength(1));
          expect(sent("login.extract")).toHaveLength(1);
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason: "paused", page: "entry" }),
          ]);
        });
        it("sends a page whose URL names another path of its site, without slots", async () => {
          const { service, h, reports } = setup();
          expect(await h.hello({}, false)).toEqual({
            ok: false,
            reason: "recipe-not-found",
            starts: [],
            generate: true,
            entry: true,
          });
          service.generateEntry.mockImplementation(async (_request, sentNow) => {
            sentNow?.();
            return { outcome: "recipe", recipe: entryRecipe };
          });
          expect(await entryHello(h)).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() => expect(sent("login.reconnect")).toHaveLength(1));
          // Only the hosts on the page's site go back to the extractor.
          expect(sent("login.extract")).toEqual([
            expect.objectContaining({
              page: "entry",
              onSite: ["login.example", "accounts.login.example"],
            }),
          ]);
          expect(service.generateEntry).toHaveBeenCalledWith(
            { version: 1, observation: entryPage.observation },
            expect.any(Function),
          );
          expect(service.generate).not.toHaveBeenCalled();
          // Only the matching item's username is read, to hide it (owner 2026-10-23 11:48 UTC).
          expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
            "login.username",
          ]);
          expect(reports("generation")).toEqual([
            { type: "generation", tabId: 1, origin, outcome: "sent", page: "entry" },
            { type: "generation", tabId: 1, origin, outcome: "recipe", page: "entry" },
          ]);
        });
        describe("the matching items' usernames (owner 2026-10-23 11:48 UTC)", () => {
          const both = async () => ({
            ok: true as const,
            data: uriMatch({
              candidates: [itemId, otherItemId].map((id) => ({
                itemId: id,
                matches: [{ uriIndex: 0, match: 0 }],
              })),
            }),
          });
          const usernames = (
            h: ReturnType<typeof harness>,
            values: Record<string, string | Error>,
          ) =>
            h.fields.mockImplementation(async ({ account, fieldId }) => {
              if (fieldId !== "login.username") return "synthetic-secret";
              const value = values[account.itemId];
              if (value instanceof Error) throw value;
              return value;
            });
          const greeting = (path = "/") => ({
            ok: true,
            observation: {
              ...page(path, [
                {
                  id: "c1",
                  role: "link",
                  target: { by: "text", value: "Not taro.yamada?" },
                  label: "Not taro.yamada?",
                },
                {
                  id: "c2",
                  role: "link",
                  target: { by: "text", value: "Login" },
                  label: "Log in again, Taro.Yamada",
                },
              ]).observation,
              title: "taro.yamada - Example",
              headings: ["Welcome back, @TARO.YAMADA"],
            },
          });
          it("hides them from the page sent, and sends no slot", async () => {
            const { service, h } = setup({ uris: both, otherUsername: true });
            usernames(h, { [itemId]: "taro.yamada", [otherItemId]: "hanako" });
            fake.state.extracted = { entry: greeting() };
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            expect(await entryHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(service.generateEntry).toHaveBeenCalledOnce());
            const [request] = service.generateEntry.mock.calls[0]!;
            expect(request).toEqual({
              version: 1,
              observation: {
                ...greeting().observation,
                // A link whose locator holds a username is left out; its label is hidden.
                candidates: [
                  {
                    id: "c2",
                    role: "link",
                    target: { by: "text", value: "Login" },
                    label: "Log in again, [account]",
                  },
                ],
                title: "[account] - Example",
                headings: ["Welcome back, [account]"],
              },
            });
            expect(JSON.stringify(service.generateEntry.mock.calls).toLowerCase()).not.toContain(
              "taro",
            );
            // Each matching item's username is read once, and nothing else of the vault.
            expect(
              h.fields.mock.calls.map(([read]) => [read.account.itemId, read.fieldId]),
            ).toEqual([
              [itemId, "login.username"],
              [otherItemId, "login.username"],
            ]);
          });
          it.each([
            ["a username that cannot be read", "username-unread", "/", new Error("locked")],
            ["a username in the path", "username-shown", "/taro.yamada", "hanako"],
          ] as const)("sends no page with %s", async (_label, reason, path, other) => {
            fake.state.pageUrl = `${origin}${path}?return_to=%2Fbookmarks`;
            const { service, h, reports } = setup({ uris: both, otherUsername: true });
            usernames(h, { [itemId]: "taro.yamada", [otherItemId]: other });
            fake.state.extracted = { entry: greeting(path) };
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            expect(await entryHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() =>
              expect(reports("generation")).toEqual([
                { type: "generation", tabId: 1, origin, outcome: "skipped", reason, page: "entry" },
              ]),
            );
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(JSON.stringify(reports("generation")).toLowerCase()).not.toContain("taro");
          });
          it("sends no page whose only link names a username", async () => {
            const { service, h, reports } = setup();
            usernames(h, { [itemId]: "taro.yamada" });
            fake.state.extracted = {
              entry: {
                ok: true,
                observation: {
                  ...page("/", [
                    { id: "c1", role: "button", target: { by: "text", value: "Menu" } },
                    {
                      id: "c2",
                      role: "link",
                      target: { by: "text", value: "taro.yamada" },
                      label: "taro.yamada",
                    },
                  ]).observation,
                },
              },
            };
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            await entryHello(h);
            await vi.waitFor(() =>
              expect(reports("generation")).toEqual([
                expect.objectContaining({
                  outcome: "skipped",
                  reason: "no-entry-link",
                  page: "entry",
                }),
              ]),
            );
            expect(service.generateEntry).not.toHaveBeenCalled();
          });
        });
        describe("beside a passkey button (ADR 0053, owner 2026-10-19 22:44 UTC)", () => {
          const passkeyEntryHello = (h: ReturnType<typeof harness>) =>
            h.login.handle(
              {
                version: 1,
                type: "login.document.ready",
                token: "synthetic-token",
                signIn: { path: "/", passkey: true },
                entry: { path: "/" },
              },
              sender(),
            );
          it("sends the entry, as without the button, when no matching item holds a passkey", async () => {
            const passkeyItems = vi.fn(async () => []);
            const { service, h, reports } = setup({ passkeyItems });
            expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
            service.generateEntry.mockImplementation(async (_request, sentNow) => {
              sentNow?.();
              return { outcome: "recipe", recipe: entryRecipe };
            });
            expect(await passkeyEntryHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(sent("login.reconnect")).toHaveLength(1));
            expect(passkeyItems).toHaveBeenCalledOnce();
            expect(sent("login.extract")).toEqual([expect.objectContaining({ page: "entry" })]);
            expect(service.generate).not.toHaveBeenCalled();
            // Logged as the entry alone: the missing passkey is not the outcome.
            expect(reports("generation")).toEqual([
              { type: "generation", tabId: 1, origin, outcome: "sent", page: "entry" },
              { type: "generation", tabId: 1, origin, outcome: "recipe", page: "entry" },
            ]);
          });
          it("sends the entry when only some matching items hold a passkey", async () => {
            // The recipe is shared: an item without a passkey could not run a passkey-only
            // one, while every item can use the entry.
            const { service, h, reports } = setup({
              uris: async () => ({
                ok: true as const,
                data: uriMatch({
                  candidates: [
                    { itemId, matches: [{ uriIndex: 0, match: 0 }] },
                    { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
                  ],
                }),
              }),
              passkeyItems: async () => [{ connectionId, itemId }],
            });
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            service.generateEntry.mockImplementation(async (_request, sentNow) => {
              sentNow?.();
              return { outcome: "recipe", recipe: entryRecipe };
            });
            expect(await passkeyEntryHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(service.generateEntry).toHaveBeenCalledOnce());
            expect(service.generate).not.toHaveBeenCalled();
            expect(reports("generation")).not.toContainEqual(
              expect.objectContaining({ outcome: "skipped" }),
            );
          });
          it("sends the passkey-only page when every matching item holds a passkey", async () => {
            const { service, h } = setup({
              uris: async () => ({
                ok: true as const,
                data: uriMatch({
                  candidates: [
                    { itemId, matches: [{ uriIndex: 0, match: 0 }] },
                    { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
                  ],
                }),
              }),
              passkeyItems: async () => [
                { connectionId, itemId },
                { connectionId, itemId: otherItemId },
              ],
            });
            fake.state.extracted = {
              entry: entryPage,
              passkey: {
                ok: true,
                observation: {
                  ...page("/", [
                    {
                      id: "key",
                      role: "button",
                      label: "Sign in with a passkey",
                      target: target("key"),
                    },
                  ]).observation,
                },
              },
            };
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            expect(await passkeyEntryHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
            expect(service.generate.mock.calls[0]![0]).toMatchObject({ passkeyOnly: true });
            expect(service.generateEntry).not.toHaveBeenCalled();
          });
          it("leaves a page that went away during the passkey lookup", async () => {
            let answer!: (items: readonly PasskeyItem[]) => void;
            const passkeyItems = vi.fn(
              () =>
                new Promise<readonly PasskeyItem[]>((resolve) => {
                  answer = resolve;
                }),
            );
            const { service, h, reports } = setup({ passkeyItems });
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            const pending = passkeyEntryHello(h);
            await vi.waitFor(() => expect(passkeyItems).toHaveBeenCalledOnce());
            // The tab closes before the vault answers.
            for (const listener of fake.state.removed) listener(1);
            answer([]);
            expect(await pending).toEqual({ ok: false, reason: "stale-document" });
            // Neither the entry nor the passkey page is sent, and nothing is logged for it.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(service.generate).not.toHaveBeenCalled();
            expect(reports("generation")).toEqual([]);
          });
          it("sends the passkey-only page instead when a matching item holds a passkey", async () => {
            const { service, h } = setup({ passkeyItems: async () => [{ connectionId, itemId }] });
            fake.state.extracted = {
              entry: entryPage,
              passkey: {
                ok: true,
                observation: {
                  ...page("/", [
                    {
                      id: "key",
                      role: "button",
                      label: "Sign in with a passkey",
                      target: target("key"),
                    },
                  ]).observation,
                },
              },
            };
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            expect(await passkeyEntryHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
            expect(service.generate.mock.calls[0]![0]).toMatchObject({
              passkeyOnly: true,
              slots: [],
            });
            expect(sent("login.extract")).toEqual([expect.objectContaining({ page: "passkey" })]);
            expect(service.generateEntry).not.toHaveBeenCalled();
          });
        });
        it.each([
          // entry.test.ts reads every other kind of return target.
          ["the bare top page", `${origin}/`],
          ["another site's URL", `${origin}/?return_to=https%3A%2F%2Fevil.example%2Fx`],
        ])("offers no entry for %s, and logs a page announced anyway", async (_label, url) => {
          fake.state.pageUrl = url;
          const { service, h, reports } = setup();
          const readiness = await h.hello({}, false);
          expect(readiness).toMatchObject({ generate: true });
          expect(readiness).not.toHaveProperty("entry");
          expect(await entryHello(h)).toMatchObject({ ok: false, reason: "recipe-not-found" });
          expect(service.generateEntry).not.toHaveBeenCalled();
          // A refused page reads nothing of the vault, not even a username to hide.
          expect(h.fields).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            {
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason: "no-return-target",
              page: "entry",
            },
          ]);
        });
        it("offers the page again once a return target names another host of the site", async () => {
          fake.state.pageUrl = `${origin}/?return_to=https%3A%2F%2Faccounts.login.example%2Fsettings`;
          const { h } = setup();
          expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
        });
        it.each([
          [
            "no vault item matches",
            { uris: async () => ({ ok: true as const, data: uriMatch({ candidates: [] }) }) },
            "no-vault-match",
          ],
        ] as const)("sends nothing when %s", async (_label, options, reason) => {
          const { service, h, reports } = setup(options);
          expect(await h.hello({}, false)).toMatchObject({ entry: true });
          expect(await entryHello(h)).toMatchObject({ ok: false, reason: "recipe-not-found" });
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(h.fields).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason, page: "entry" }),
          ]);
        });
        it("never sends the tab's next page of the origin after a password form was submitted", async () => {
          const { service, h, reports } = setup();
          await h.login.handle(
            { version: 1, type: "login.document.submitted", token: "synthetic-token" },
            sender(),
          );
          expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
            entry: true,
          });
          await entryHello(h, { documentId: "after-sign-in" });
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(h.fields).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
          ]);
          // The page after that one may be sent.
          expect(await h.hello({ documentId: "later" }, false)).toMatchObject({ entry: true });
          expect(await entryHello(h, { documentId: "later" })).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() => expect(service.generateEntry).toHaveBeenCalledTimes(1));
        });
        it("sends no page that is held in the retry window or lists no link", async () => {
          const held = setup();
          held.service.available.mockResolvedValue("sent");
          expect(await held.h.hello({}, false)).not.toHaveProperty("entry");
          expect(held.reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason: "sent" }),
          ]);
          const buttons = setup();
          fake.state.extracted = {
            entry: {
              ok: true,
              observation: {
                ...page("/", [
                  {
                    id: "c1",
                    role: "button",
                    target: { by: "text", value: "Menu" },
                    label: "Menu",
                  },
                ]).observation,
              },
            },
          };
          expect(await buttons.h.hello({ documentId: "buttons" }, false)).toMatchObject({
            entry: true,
          });
          expect(await entryHello(buttons.h, { documentId: "buttons" })).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() =>
            expect(buttons.reports("generation")).toEqual([
              expect.objectContaining({ outcome: "skipped", reason: "no-entry-link" }),
            ]),
          );
          expect(buttons.service.generateEntry).not.toHaveBeenCalled();
        });
        it.each([
          // A description with a field is no entry page.
          ["/", true, "not-entry"],
          // One of another path describes another page.
          ["/other", false, "path-changed"],
        ] as const)(
          "logs why a described entry page is not sent (%s, ADR 0019)",
          async (path, withField, detail) => {
            const link = {
              id: "c1",
              role: "link",
              target: { by: "text", value: "Log in" },
              label: "Log in",
            };
            const field = { id: "c2", role: "text", target: { by: "id", value: "q" } };
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: page(path, withField ? [link, field] : [link]) };
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            await entryHello(h);
            await vi.waitFor(() =>
              expect(reports("generation")).toEqual([
                expect.objectContaining({
                  outcome: "skipped",
                  reason: "incomplete-observation",
                  page: "entry",
                  detail,
                }),
              ]),
            );
            expect(service.generateEntry).not.toHaveBeenCalled();
          },
        );
        it("counts an entry recipe's path as a recipe start, so the page is never sent", async () => {
          fake.state.entry.inspect = inspected();
          const { service, h } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          expect(service.available).not.toHaveBeenCalled();
          expect(service.generateEntry).not.toHaveBeenCalled();
        });
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
          it("sends a page that lists an account by email as a list, never also as an entry", async () => {
            const { service, h, reports } = setup();
            // A list by email is sent for an email username (ADR 0028).
            h.fields.mockImplementation(async ({ fieldId }) =>
              fieldId === "login.username" ? "risu@example.com" : "synthetic-secret",
            );
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
            expect(await bothHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(reports("generation")).toHaveLength(2));
            expect(sent("login.extract")).toEqual([expect.objectContaining({ page: "accounts" })]);
            expect(service.generate).toHaveBeenCalledTimes(1);
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(reports("generation")).toEqual([
              expect.objectContaining({ outcome: "sent", page: "accounts" }),
              expect.objectContaining({ outcome: "abstained", page: "accounts" }),
            ]);
          });
          it("sends neither a list nor an entry on a page whose path holds the username", async () => {
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            fake.state.pageUrl = `${origin}/risu729?return_to=%2Fbookmarks`;
            h.fields.mockImplementation(async ({ fieldId }) =>
              fieldId === "login.username" ? "risu729" : "synthetic-secret",
            );
            const pathHello = (names: string[]) =>
              h.login.handle(
                {
                  version: 1,
                  type: "login.document.ready",
                  token: "synthetic-token",
                  list: { path: "/risu729", names },
                  entry: { path: "/risu729" },
                },
                sender(),
              );
            expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
            // Whether a shown text names the item or not (owner 2026-10-12 19:45 UTC).
            expect(await pathHello(["risu729", "Edit"])).toMatchObject({ ok: false });
            expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({
              generate: true,
            });
            expect(
              await h.login.handle(
                {
                  version: 1,
                  type: "login.document.ready",
                  token: "synthetic-token",
                  list: { path: "/risu729", names: ["Edit"] },
                  entry: { path: "/risu729" },
                },
                sender({ documentId: "next-page" }),
              ),
            ).toMatchObject({ ok: false });
            expect(service.generate).not.toHaveBeenCalled();
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(sent("login.extract")).toEqual([]);
            expect(reports("generation")).toEqual([
              expect.objectContaining({
                outcome: "skipped",
                reason: "no-listed-account",
                detail: "username-in-path",
              }),
              expect.objectContaining({
                outcome: "skipped",
                reason: "no-listed-account",
                detail: "username-in-path",
              }),
            ]);
          });
          it("sends the page as an entry when no listed short text names a matching item", async () => {
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            h.fields.mockImplementation(async ({ fieldId }) =>
              fieldId === "login.username" ? "synthetic-user" : "synthetic-secret",
            );
            expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
            expect(await bothHello(h, ["Help", "Create account"])).toEqual({
              ok: false,
              reason: "generating",
            });
            await vi.waitFor(() => expect(service.generateEntry).toHaveBeenCalledTimes(1));
            expect(service.generate).not.toHaveBeenCalled();
            expect(sent("login.extract")).toEqual([expect.objectContaining({ page: "entry" })]);
            await vi.waitFor(() => expect(reports("generation")).toHaveLength(3));
            expect(reports("generation")).toEqual([
              // At debug level: the short texts named no item.
              expect.objectContaining({
                outcome: "skipped",
                reason: "no-listed-account",
                detail: "no-name-match",
              }),
              expect.objectContaining({ outcome: "sent", page: "entry" }),
              expect.objectContaining({ outcome: "abstained", page: "entry" }),
            ]);
          });
        });
      });
    });
  });
});
