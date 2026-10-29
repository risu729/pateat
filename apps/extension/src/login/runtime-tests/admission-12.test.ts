import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings } from "@pateat/contracts";
import { vaultFailure } from "../../vault/record";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
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
  otherItemId,
  uriMatch,
  liveAccountPolicy,
  excludingLive,
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

    it("sends the username's shape only when every matching item agrees", async () => {
      fake.state.extracted = { login: loginPage };
      const both = async () => ({
        ok: true as const,
        data: uriMatch({
          candidates: [itemId, otherItemId].map((id) => ({
            itemId: id,
            matches: [{ uriIndex: 0, match: 0 }],
          })),
        }),
      });
      const read: string[] = [];
      const sentShape = async (
        usernames: Record<string, string | Error | undefined>,
        options: { overrides?: Partial<LocalSettings>; uris?: LiveUriMatcher } = {},
      ) => {
        const service = generation();
        const h = harness(
          { ...unsaved, ...options.overrides },
          {
            allowedOrigins: [],
            uris: options.uris ?? both,
            username: true,
            otherUsername: true,
            custom: [],
            generation: service,
          },
        );
        read.length = 0;
        h.fields.mockImplementation(async ({ account }) => {
          read.push(account.itemId);
          const value = usernames[account.itemId];
          if (value instanceof Error) throw value;
          return value;
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        return service.generate.mock.calls[0]![0].slots.find((slot) => slot.id === "username")!
          .valueShape;
      };
      const digits = (length: number) => ({ length, classes: ["ascii-digit"], email: false });
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "00005678" })).toEqual(
        digits(8),
      );
      // Different lengths or an unchecked item send no shape.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "0000123456" })).toBe(
        undefined,
      );
      // Same length but other characters, or an email, is a different shape.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "abcd1234" })).toBe(undefined);
      expect(await sentShape({ [itemId]: "a@b.test", [otherItemId]: "ab.cdefg" })).toBe(undefined);
      // A username too long to shape cannot be compared, so nothing is sent.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "1".repeat(1025) })).toBe(
        undefined,
      );
      expect(
        await sentShape(
          { [itemId]: "00001234", [otherItemId]: "00005678" },
          {
            uris: async () => ({
              ok: true as const,
              data: uriMatch({ unavailableItemIds: [otherItemId] }),
            }),
          },
        ),
      ).toBe(undefined);
      // An empty or excluded username does not count, and an excluded one is never read.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "" })).toEqual(digits(8));
      const excluded = excludingLive(["login.username"], otherItemId);
      expect(
        await sentShape(
          { [itemId]: "00001234", [otherItemId]: "0000123456" },
          { overrides: excluded },
        ),
      ).toEqual(digits(8));
      expect(read).toEqual([itemId]);
    });
    describe("the account's own usernames", () => {
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
        values: Record<string, string | Error> = {
          [itemId]: "Taro.Yamada",
          [otherItemId]: "an",
        },
      ) =>
        h.fields.mockImplementation(async ({ account, fieldId }) => {
          if (fieldId !== "login.username") return "synthetic-secret";
          const value = values[account.itemId];
          if (value instanceof Error) throw value;
          return value;
        });
      const shownPage = (path: string) =>
        page(path, [
          { id: "c1", role: "email", target: target("user"), label: "Email for taro.yamada" },
          { id: "c2", role: "password", target: target("password"), label: "Password" },
          { id: "c3", role: "button", target: target("login"), label: "Sign in" },
          {
            id: "c4",
            role: "link",
            target: { by: "text", value: "Not TARO.YAMADA?" },
            label: "Not TARO.YAMADA?",
          },
          { id: "c5", role: "link", target: target("other"), label: "Use another account" },
        ]);
      const withHeadings = (shown: ReturnType<typeof page>, headings: string[]) => ({
        ...shown,
        observation: { ...shown.observation, title: "ｔａｒｏ．ｙａｍａｄａ - Example", headings },
      });
      it("hides them from a page sent for generation", async () => {
        fake.state.extracted = {
          login: withHeadings(shownPage("/signin"), ["Welcome back, @Taro.Yamada", "an"]),
        };
        const service = generation();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: both,
          username: true,
          otherUsername: true,
          custom: [],
          generation: service,
        });
        usernames(h);
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        const { observation } = service.generate.mock.calls[0]![0];
        expect(observation.title).toBe("[account] - Example");
        // A username shorter than three characters, such as "an", is not looked for.
        expect(observation.headings).toEqual(["Welcome back, [account]", "an"]);
        expect(observation.candidates.map((candidate) => [candidate.id, candidate.label])).toEqual([
          ["c1", "Email for [account]"],
          ["c2", "Password"],
          ["c3", "Sign in"],
          ["c5", "Use another account"],
        ]);
        expect(JSON.stringify(service.generate.mock.calls).toLowerCase()).not.toContain("taro");
        // Each username is read once, for its shape and for hiding it.
        expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
          "login.username",
          "login.username",
        ]);
      });
      it.each([
        ["a username that cannot be read", "username-unread", new Error("locked")],
        ["a submit button that names a username", "username-shown", "hanako"],
      ] as const)("sends no page with %s", async (_label, reason, other) => {
        fake.state.extracted = {
          login: page("/signin", [
            { id: "c1", role: "email", target: target("user"), group: "f1" },
            { id: "c2", role: "password", target: target("password"), group: "f1" },
            {
              id: "c3",
              role: "button",
              target: { by: "text", value: "Log in as taro.yamada" },
              group: "f1",
            },
          ]),
        };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: both,
          username: true,
          otherUsername: true,
          custom: [],
          generation: service,
          report,
        });
        usernames(h, { [itemId]: "taro.yamada", [otherItemId]: other });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() =>
          expect(report).toHaveBeenCalledWith({
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason,
          }),
        );
        expect(service.generate).not.toHaveBeenCalled();
        expect(JSON.stringify(report.mock.calls).toLowerCase()).not.toContain("taro");
      });
      it("reads no username of an item that holds none, and still sends the page", async () => {
        fake.state.extracted = { login: withHeadings(shownPage("/signin"), ["Hi taro.yamada"]) };
        const service = generation();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: both,
          username: true,
          otherUsername: "empty",
          custom: [],
          generation: service,
        });
        // The other item's username field is present with no value, which resolves as
        // missing: reading it would fail, so it is never read.
        usernames(h, { [itemId]: "taro.yamada" });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        expect(service.generate.mock.calls[0]![0].observation.headings).toEqual(["Hi [account]"]);
        expect(h.fields.mock.calls.map(([request]) => request.account.itemId)).toEqual([itemId]);
      });
      it("hides them, and the login's own, from the judged page", async () => {
        let signedIn = false;
        const matching = async () =>
          signedIn ? { ok: true as const, data: uriMatch({ candidates: [] }) } : uris();
        fake.state.extracted = {
          "signed-in": page("/home", [
            { id: "c1", role: "button", target: target("logout"), label: "Sign out taro.yamada" },
            {
              id: "c2",
              role: "link",
              target: { by: "text", value: "taro.yamada" },
              label: "taro.yamada",
            },
          ]),
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: matching,
          username: true,
          generation: service,
          report,
        });
        usernames(h, { [itemId]: "taro.yamada" });
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // The page after the sign-in matches no item by its URL; the login's own is hidden.
          signedIn = true;
          fake.state.present = new Set(["logout"]);
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(service.judge).toHaveBeenCalledTimes(1);
        const observation = service.judge.mock.calls[0]![3];
        expect(observation.candidates).toEqual([
          { id: "c1", role: "button", target: target("logout"), label: "Sign out [account]" },
        ]);
        expect(JSON.stringify(service.judge.mock.calls).toLowerCase()).not.toContain("taro");
        expect(JSON.stringify(report.mock.calls).toLowerCase()).not.toContain("taro");
      }, 10_000);
      it("judges no page whose usernames cannot be read", async () => {
        let signedIn = false;
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
        h.fields.mockImplementation(async ({ fieldId }) => {
          if (signedIn && fieldId === "login.username") throw new Error("locked");
          return "synthetic-secret";
        });
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          signedIn = true;
          fake.state.present = new Set(["logout"]);
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(report).toHaveBeenCalledWith(
              expect.objectContaining({
                type: "judge",
                verdict: "not-sent",
                reason: "username-unread",
              }),
            ),
          { timeout: 6_000 },
        );
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);
    });
    it("sends nothing when no vault item matches the page", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch({ candidates: [] }) }),
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "no-vault-match",
        detail: "no-item",
      });
      expect(service.generate).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });
    it("logs why the vault could not tell whether an item matches", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => vaultFailure("crypto-locked"),
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "vault-unavailable",
        detail: "crypto-locked",
      });
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("logs a sign-in page not sent because every vault connection is turned off", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const disabled = { ...unsaved, accountPolicies: [liveAccountPolicy({ enabled: false })] };
      const h = harness(disabled, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "connection-disabled",
      });
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("logs a page not offered while the service is not connected", async () => {
      const service = generation({ available: async () => "not-connected" });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "not-connected",
      });
    });
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
      it("logs a page offered for generation that showed nothing to send, at debug level", async () => {
        const { service, h, generations } = setup();
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        // The first announcement logs nothing: the page may still show a list.
        expect(generations()).toEqual([]);
        const unoffered = (why: string, from: Record<string, unknown> = {}) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              unoffered: { path: "/signin", why },
            },
            sender(from),
          );
        expect(await unoffered("no-list")).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "nothing-offered",
            detail: "no-list",
          },
        ]);
        expect(service.generate).not.toHaveBeenCalled();
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        // Another path than the document's is not logged for it.
        expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({ generate: true });
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            unoffered: { path: "/elsewhere", why: "no-list" },
          },
          sender({ documentId: "next-page" }),
        );
        expect(generations()).toHaveLength(1);
        // The tab's next document after a submitted password form says so.
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender({ documentId: "next-page" }),
        );
        expect(await h.hello({ documentId: "after" }, false)).toMatchObject({ generate: true });
        await unoffered("no-list", { documentId: "after" });
        expect(generations().at(-1)).toMatchObject({
          reason: "nothing-offered",
          detail: "after-sign-in",
        });
        // A reason outside the list is refused by the message schema.
        expect(await unoffered("other", { documentId: "next-page" })).toBeUndefined();
      });
      it("logs why a shown control for another account did not count", async () => {
        const { h, generations } = setup();
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            list: { path: "/signin", names: ["Help"], otherMiss: "other-holds-name" },
          },
          sender(),
        );
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "other-holds-name",
          },
        ]);
      });
      it("sends a list with an email as a list, logging it as one", async () => {
        const { service, h, generations } = setup();
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(generations()).toHaveLength(2));
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
        });
        expect(
          fake.state.messages.find((entry) => entry.type === "login.extract"),
        ).not.toHaveProperty("names");
        expect(service.generate).toHaveBeenCalledWith(
          expect.objectContaining({ observation: listPage.observation }),
          expect.any(Function),
        );
        expect(generations()).toEqual([
          { type: "generation", tabId: 1, origin, outcome: "sent", page: "accounts" },
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "abstained",
            reason: "ambiguous",
            page: "accounts",
          },
        ]);
      });
      it("sends a list without slots or value shapes (owner 2026-10-23 11:48 UTC)", async () => {
        // The item offers a custom Text field, which a form would be sent with.
        const { service, h } = setup({ custom: [{ name: "支店番号", kind: "text" }] });
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
        const [request] = service.generate.mock.calls[0]!;
        expect(request.slots).toEqual([]);
        expect(JSON.stringify(request)).not.toContain("valueShape");
        expect(JSON.stringify(request)).not.toContain("支店番号");
        // Only the username is read, to compare and hide it; no custom field for its shape.
        expect(new Set(h.fields.mock.calls.map(([read]) => read.fieldId))).toEqual(
          new Set(["login.username"]),
        );
      });
      it("sends a list by email for a username that is not one only with a control for another account", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu729" : "synthetic-secret",
        );
        const emailHello = (documentId: string, other?: true) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/signin", ...(other ? { other } : {}) },
            },
            sender({ documentId }),
          );
        // As on myUNSW: no address on the page can be compared with the username.
        expect(await h.hello({ documentId: "bare" }, false)).toMatchObject({ generate: true });
        expect(await emailHello("bare")).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "no-email-username",
          },
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        expect(service.generate).not.toHaveBeenCalled();
        // With a control to sign in with another account, the list is sent for it.
        expect(await h.hello({ documentId: "other" }, false)).toMatchObject({ generate: true });
        expect(await emailHello("other", true)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
        });
        expect(generations()).toContainEqual(
          expect.objectContaining({ outcome: "sent", page: "accounts" }),
        );
        expect(JSON.stringify(fake.state.messages)).not.toContain("risu729");
      });
      it("sends a list by email without a control for another account for an email username", async () => {
        const { service, h, generations } = setup({
          uris: async () => ({
            ok: true,
            data: uriMatch({
              candidates: [itemId, otherItemId].map((id) => ({
                itemId: id,
                matches: [{ uriIndex: 0, match: 0 }],
              })),
            }),
          }),
          otherUsername: true,
        });
        // One matching item's username is an email; the other's is not.
        h.fields.mockImplementation(async ({ fieldId, account }) =>
          fieldId !== "login.username"
            ? "synthetic-secret"
            : account.itemId === itemId
              ? "risu729"
              : "risu@example.com",
        );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(generations()).not.toContainEqual(
          expect.objectContaining({ reason: "no-listed-account" }),
        );
        // Both usernames were read for their shape.
        expect(
          new Set(
            h.fields.mock.calls
              .filter(([request]) => request.fieldId === "login.username")
              .map(([request]) => request.account.itemId),
          ),
        ).toEqual(new Set([itemId, otherItemId]));
      });
      it("logs a complete description without accounts on a list as a mismatch (ADR 0019)", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
        onTestFinished(() => void vi.useRealTimers());
        const { service, h, generations } = setup();
        fake.state.extracted = {
          accounts: {
            ok: true,
            observation: page("/signin", listPage.observation.candidates).observation,
          },
        };
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() =>
          expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
        );
        // Read up to ten times a second apart before it is logged.
        await vi.advanceTimersByTimeAsync(9_000);
        await vi.waitFor(() =>
          expect(generations()).toEqual([
            {
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason: "incomplete-observation",
              detail: "list-mismatch",
            },
          ]),
        );
        expect(service.generate).not.toHaveBeenCalled();
      });
      it("sends a list of names only when one names a matching item's username", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "Risu729" : "synthetic-secret",
        );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h, ["Help", "Create new account"])).toMatchObject({
          ok: false,
          reason: "recipe-not-found",
        });
        // A page offered only by its short texts is mostly ordinary browsing: logged at
        // debug level.
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
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        // Another page whose shown text is the username, ignoring case and a leading `@`.
        expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({ generate: true });
        expect(await listHello(h, ["@risu729", "Help"], { documentId: "next-page" })).toEqual({
          ok: false,
          reason: "generating",
        });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        // Only the matching text goes back, to be hidden; the username itself never does.
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
          names: ["@risu729"],
        });
        expect(JSON.stringify(fake.state.messages)).not.toContain("Risu729");
      });
    });
  });
});
