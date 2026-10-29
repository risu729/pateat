import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

    describe("a page that lists accounts (ADR 0028)", () => {
      const listPage = {
        ok: true,
        observation: {
          ...page("/signin", [
            {
              id: "c1",
              role: "button",
              target: { by: "text", value: "Use another profile" },
              label: "Use another profile",
            },
          ]).observation,
          accounts: ["[account]"],
        },
      };
      const listHello = (
        h: ReturnType<typeof harness>,
        names?: string[],
        from: Record<string, unknown> = {},
      ) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            list: { path: "/signin", ...(names ? { names } : {}) },
          },
          sender(from),
        );
      const setup = (live: Partial<Parameters<typeof harness>[1]> = {}) => {
        fake.state.extracted = { accounts: listPage };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          custom: [],
          generation: service,
          report,
          ...live,
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        // A list by email is sent only for an email username, unless it shows a control
        // for another account.
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu@example.com" : "synthetic-secret",
        );
        const generations = () =>
          report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "generation");
        return { service, h, generations };
      };
      it("sends a list of names that name no item when it shows a control for another account", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu@example.com" : "synthetic-secret",
        );
        const otherHello = () =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/signin", names: ["taro.yamada", "Help"], other: true },
            },
            sender(),
          );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await otherHello()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        // Every shown text goes back to be hidden, as a possible account name.
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
          names: ["taro.yamada", "Help"],
        });
        expect(generations()).not.toContainEqual(
          expect.objectContaining({ reason: "no-listed-account" }),
        );
        expect(JSON.stringify(fake.state.messages)).not.toContain("risu@example.com");
      });
      it("reads no list on a page whose path holds a matching item's username", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu729" : "synthetic-secret",
        );
        // A signed-in page under the account's own name, as a pull request page whose
        // comment shows its author beside its buttons (owner 2026-10-12 19:45 UTC).
        const url = `${origin}/risu729/pateat/pull/1`;
        fake.state.pageUrl = url;
        const pathHello = (list: Record<string, unknown>) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/risu729/pateat/pull/1", ...list },
            },
            sender({ url }),
          );
        expect(await h.hello({ url }, false)).toMatchObject({ generate: true });
        expect(await pathHello({ names: ["risu729", "Edit"] })).toMatchObject({
          ok: false,
          reason: "recipe-not-found",
        });
        // Not even an email list is read there.
        expect(await h.hello({ url, documentId: "email-page" }, false)).toMatchObject({
          generate: true,
        });
        expect(
          await h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/risu729/pateat/pull/1" },
            },
            sender({ url, documentId: "email-page" }),
          ),
        ).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "username-in-path",
          },
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "username-in-path",
          },
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        expect(service.generate).not.toHaveBeenCalled();
        // The usernames were read for the email list too.
        expect(h.fields).toHaveBeenCalledWith(
          expect.objectContaining({ fieldId: "login.username" }),
        );
      });
      it("logs a shown email address that is no entry, and sends only names", async () => {
        const { service, h, generations } = setup();
        const missed = (from: Record<string, unknown>, names?: string[]) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/signin", ...(names ? { names } : {}), missed: "not-rendered" },
            },
            sender(from),
          );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await missed({})).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "not-a-list",
            detail: "not-rendered",
          },
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        // With texts beside buttons, those are still compared with the usernames.
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu729" : "synthetic-secret",
        );
        expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({ generate: true });
        expect(await missed({ documentId: "next-page" }, ["risu729"])).toEqual({
          ok: false,
          reason: "generating",
        });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      });
      it("offers no page where a stored list starts, and watches for the list there", async () => {
        const { service, h } = setup();
        const other = { by: "text" as const, value: "Use another profile" };
        h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: [], list: [other] }]);
        expect(await h.hello({}, false)).toEqual({
          ok: false,
          reason: "recipe-not-found",
          starts: [{ path: "/signin", require: "clickable", targets: [other], accounts: true }],
        });
        expect(await listHello(h)).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(service.available).not.toHaveBeenCalled();
        expect(service.generate).not.toHaveBeenCalled();
      });
      it("never sends the tab's next page of the origin after a password form was submitted", async () => {
        const { service, h, generations } = setup();
        expect(
          await h.login.handle(
            { version: 1, type: "login.document.submitted", token: "synthetic-token" },
            sender(),
          ),
        ).toBeUndefined();
        expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
          generate: true,
        });
        expect(await listHello(h, undefined, { documentId: "after-sign-in" })).not.toEqual({
          ok: false,
          reason: "generating",
        });
        expect(generations()).toEqual([
          { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "after-sign-in" },
        ]);
        // The page after that one may be sent.
        expect(await h.hello({ documentId: "later" }, false)).toMatchObject({ generate: true });
        expect(await listHello(h, undefined, { documentId: "later" })).toEqual({
          ok: false,
          reason: "generating",
        });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      });
      it("never sends the tab's next page as one asking for an identifier alone (ADR 0016)", async () => {
        const { h, generations } = setup();
        const identifierHello = (documentId: string) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              signIn: { path: new URL(fake.state.pageUrl).pathname, identifier: true },
            },
            sender({ documentId }),
          );
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender(),
        );
        expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
          generate: true,
        });
        expect(await identifierHello("after-sign-in")).not.toEqual({
          ok: false,
          reason: "generating",
        });
        expect(generations()).toEqual([
          { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "after-sign-in" },
        ]);
        expect(await h.hello({ documentId: "later" }, false)).toMatchObject({ generate: true });
        // The page after that one may be sent.
        expect(await identifierHello("later")).toEqual({ ok: false, reason: "generating" });
      });
      it("never sends the tab's next page as a passkey-only page (ADR 0053)", async () => {
        const passkeyItems = vi.fn(async () => [{ connectionId, itemId }]);
        const { h, generations } = setup({ passkeyItems });
        const passkeyHello = (documentId: string) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              signIn: { path: new URL(fake.state.pageUrl).pathname, passkey: true },
            },
            sender({ documentId }),
          );
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender(),
        );
        expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
          generate: true,
        });
        expect(await passkeyHello("after-sign-in")).not.toEqual({
          ok: false,
          reason: "generating",
        });
        expect(generations()).toEqual([
          { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "after-sign-in" },
        ]);
        // The vault is not asked for passkeys for a page that is not sent.
        expect(passkeyItems).not.toHaveBeenCalled();
        expect(await h.hello({ documentId: "later" }, false)).toMatchObject({ generate: true });
        expect(await passkeyHello("later")).toEqual({ ok: false, reason: "generating" });
        expect(passkeyItems).toHaveBeenCalledOnce();
      });
      describe("beside a passkey button (ADR 0053, owner 2026-10-19 22:44 UTC)", () => {
        const passkeyPage = {
          ok: true,
          observation: {
            version: 1,
            origin,
            path: "/signin",
            language: "en",
            complete: true,
            candidates: [
              { id: "key", role: "button", label: "Sign in with a passkey", target: target("key") },
            ],
          },
        };
        const passkeyListHello = (
          h: ReturnType<typeof harness>,
          names: string[],
          from: Record<string, unknown> = {},
        ) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              signIn: { path: "/signin", passkey: true },
              list: { path: "/signin", names },
            },
            sender(from),
          );
        const named = (live: Partial<Parameters<typeof harness>[1]>) => {
          const shown = setup(live);
          fake.state.extracted = { accounts: listPage, passkey: passkeyPage };
          shown.h.fields.mockImplementation(async ({ fieldId }) =>
            fieldId === "login.username" ? "risu729" : "synthetic-secret",
          );
          return shown;
        };
        const extracted = () =>
          fake.state.messages.filter((entry) => entry.type === "login.extract");
        it("sends the passkey-only page when a matching item holds a passkey", async () => {
          const passkeyItems = vi.fn(async () => [{ connectionId, itemId }]);
          const { service, h, generations } = named({ passkeyItems });
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          expect(await passkeyListHello(h, ["Help"])).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
          expect(service.generate.mock.calls[0]![0]).toMatchObject({
            passkeyOnly: true,
            slots: [],
          });
          expect(extracted()).toEqual([expect.objectContaining({ page: "passkey" })]);
          expect(generations()).not.toContainEqual(expect.objectContaining({ outcome: "skipped" }));
        });
        for (const [offered, announce] of [
          ["passkey button", (h: ReturnType<typeof harness>) => passkeyListHello(h, ["Help"])],
          ["list of accounts", (h: ReturnType<typeof harness>) => listHello(h, ["@risu729"])],
        ] as const)
          it(`sends a page offered as a ${offered} that shows a sign-in form by then as a sign-in page`, async () => {
            const passkeyItems = vi.fn(async () => [{ connectionId, itemId }]);
            const { service, h, generations } = named({ passkeyItems });
            fake.state.extracted = { login: loginPage };
            expect(await h.hello({}, false)).toMatchObject({ generate: true });
            expect(await announce(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
            const request = service.generate.mock.calls[0]![0];
            expect(request).not.toHaveProperty("passkeyOnly");
            expect(request.observation).toEqual(loginPage.observation);
            expect(request.slots.map((slot) => slot.id)).toContain("password");
            expect(extracted()).toEqual([
              expect.objectContaining({
                page: offered === "passkey button" ? "passkey" : "accounts",
              }),
              expect.objectContaining({ page: "login" }),
            ]);
            // Sent as a recipe's first page, with its signed-in hint and no `page`.
            expect(generations()).toContainEqual({
              type: "generation",
              tabId: 1,
              origin,
              outcome: "sent",
              signedIn: false,
            });
          });
        it("never sends a page offered as a passkey button whose only field is no sign-in input", async () => {
          vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
          onTestFinished(() => void vi.useRealTimers());
          const passkeyItems = vi.fn(async () => [{ connectionId, itemId }]);
          const { service, h, generations } = named({ passkeyItems });
          // A search box rendered after the offer: its description would be accepted.
          fake.state.extracted = { login: loginPage };
          fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: false };
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          expect(await passkeyListHello(h, ["Help"])).toEqual({ ok: false, reason: "generating" });
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() =>
            expect(generations()).toEqual([
              { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "no-candidates" },
            ]),
          );
          expect(service.generate).not.toHaveBeenCalled();
          expect(extracted()).not.toContainEqual(expect.objectContaining({ page: "login" }));
        });
        it("handles the list as without the button for an item without a passkey", async () => {
          const passkeyItems = vi.fn(async () => []);
          const { service, h, generations } = named({ passkeyItems });
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          // No shown text names the item: logged as for the list alone, not `no-passkey`.
          expect(await passkeyListHello(h, ["Help"])).toMatchObject({
            ok: false,
            reason: "recipe-not-found",
          });
          expect(generations()).toEqual([
            {
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason: "no-listed-account",
              detail: "no-name-match",
            },
          ]);
          expect(service.generate).not.toHaveBeenCalled();
          // A text that names the item sends the page as a list of accounts.
          expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({
            generate: true,
          });
          expect(await passkeyListHello(h, ["@risu729"], { documentId: "next-page" })).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
          expect(service.generate.mock.calls[0]![0]).not.toHaveProperty("passkeyOnly");
          expect(extracted()).toEqual([
            expect.objectContaining({ page: "accounts", names: ["@risu729"] }),
          ]);
          expect(passkeyItems).toHaveBeenCalledTimes(2);
        });
        it("logs no-passkey for a page whose list is only for the log", async () => {
          const passkeyItems = vi.fn(async () => []);
          const { service, h, generations } = named({ passkeyItems });
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          // A support address in the footer is no list of accounts, so there is nothing to
          // use instead of the passkey button.
          expect(
            await h.login.handle(
              {
                version: 1,
                type: "login.document.ready",
                token: "synthetic-token",
                signIn: { path: "/signin", passkey: true },
                list: { path: "/signin", missed: "page-chrome" },
              },
              sender(),
            ),
          ).toMatchObject({ ok: false, reason: "recipe-not-found" });
          expect(generations()).toEqual([
            {
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason: "no-vault-match",
              detail: "no-passkey",
            },
          ]);
          expect(passkeyItems).toHaveBeenCalledOnce();
          expect(service.generate).not.toHaveBeenCalled();
        });
        it("never sends the tab's next page, as without the button", async () => {
          const passkeyItems = vi.fn(async () => [{ connectionId, itemId }]);
          const { service, h, generations } = named({ passkeyItems });
          await h.login.handle(
            { version: 1, type: "login.document.submitted", token: "synthetic-token" },
            sender(),
          );
          expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
            generate: true,
          });
          expect(
            await passkeyListHello(h, ["@risu729"], { documentId: "after-sign-in" }),
          ).not.toEqual({ ok: false, reason: "generating" });
          // A list of names alone is ordinary browsing, so nothing is logged for it.
          expect(generations()).toEqual([]);
          expect(passkeyItems).not.toHaveBeenCalled();
          expect(service.generate).not.toHaveBeenCalled();
        });
      });
      it("sends a list that loads more than a minute after the submission", async () => {
        const { service, h, generations } = setup();
        const at = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(at);
        onTestFinished(() => clock.mockRestore());
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender(),
        );
        // A single-page app signed in and out in one document; the reload comes later.
        clock.mockReturnValue(at + 61_000);
        expect(await h.hello({ documentId: "reloaded" }, false)).toMatchObject({ generate: true });
        expect(await listHello(h, undefined, { documentId: "reloaded" })).toEqual({
          ok: false,
          reason: "generating",
        });
        clock.mockRestore();
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(generations()).not.toContainEqual(
          expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
        );
      });
      it.each([
        ["just under a minute", 59_000],
        ["after the clock went back", -1_000],
      ])("still skips a list that loads %s", async (_, offset) => {
        const { service, h, generations } = setup();
        const at = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(at);
        onTestFinished(() => clock.mockRestore());
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender(),
        );
        clock.mockReturnValue(at + offset);
        expect(await h.hello({ documentId: "reloaded" }, false)).toMatchObject({ generate: true });
        await listHello(h, undefined, { documentId: "reloaded" });
        expect(generations()).toContainEqual(
          expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
        );
        expect(service.generate).not.toHaveBeenCalled();
      });
      describe("while another tab's login of the origin authenticated (owner 2026-10-17)", () => {
        const signedInTab = async (age: number) => {
          fake.state.tabUrls[2] = fake.state.pageUrl;
          const login = harness();
          expect(await login.hello({ tab: { id: 2 }, documentId: "tab-2" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
              { state: "authenticated", document: { tabId: 2 } },
            ]),
          );
          const [record] = fake.state.storage["pateat.login-attempts.v5"] as Record<
            string,
            unknown
          >[];
          fake.state.storage["pateat.login-attempts.v5"] = [
            { ...record, changedAt: Date.now() - age },
          ];
          const query = fake.browser.tabs.query;
          fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
          onTestFinished(() => {
            fake.browser.tabs.query = query;
          });
        };
        it("never sends a list of accounts shown in another tab within the hour", async () => {
          await signedInTab(59 * 60_000);
          const { service, h, generations } = setup();
          expect(await h.hello({ documentId: "dashboard" }, false)).toMatchObject({
            generate: true,
          });
          expect(await listHello(h, undefined, { documentId: "dashboard" })).not.toEqual({
            ok: false,
            reason: "generating",
          });
          expect(generations()).toEqual([
            {
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason: "signed-in-elsewhere",
            },
          ]);
          expect(service.generate).not.toHaveBeenCalled();
        });
        it.each([
          ["an hour after it", 60 * 60_000],
          ["after the clock went back", -1_000],
        ])("sends the list %s", async (_, age) => {
          await signedInTab(age);
          const { service, h, generations } = setup();
          expect(await h.hello({ documentId: "dashboard" }, false)).toMatchObject({
            generate: true,
          });
          expect(await listHello(h, undefined, { documentId: "dashboard" })).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
          expect(generations()).not.toContainEqual(
            expect.objectContaining({ reason: "signed-in-elsewhere" }),
          );
        });
        it("sends the list while a tab of the origin asks after a rejected login (ADR 0062)", async () => {
          await signedInTab(60_000);
          fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 3, origin }];
          const { service, h } = setup();
          expect(await h.hello({ documentId: "chooser" }, false)).toMatchObject({
            generate: true,
          });
          expect(await listHello(h, undefined, { documentId: "chooser" })).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        });
      });
    });
    describe("a site's sign-in entry (ADR 0031)", () => {
      beforeEach(realTime);
      const entryUrl = `${origin}/?return_to=%2Fbookmarks`;

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
        it("sends no page of a paused site (ADR 0062)", async () => {
          const { service, h, reports } = setup();
          expect(await setPause(h, true)).toEqual({ ok: true, until: expect.any(Number) });
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
          expect(await entryHello(h)).toEqual({ ok: false, reason: "recipe-not-found" });
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(service.generate).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason: "paused" }),
          ]);
          // Once resumed, the page is offered again.
          expect(await setPause(h, false)).toEqual({ ok: true });
          expect(await h.hello({ documentId: "after-resume" }, false)).toMatchObject({
            generate: true,
            entry: true,
          });
        });
      });
    });
  });
});
