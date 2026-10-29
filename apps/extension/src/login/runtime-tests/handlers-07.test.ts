import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginFieldTarget,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import type { PasskeyItem } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  reportedPath,
  origin,
  connectionId,
  itemId,
  snapshotId,
  sender,
  target,
  startsOf,
  recipe,
  userId,
  savedBinding,
  otherItemId,
  uriMatch,
  excludingLive,
  harness,
} = createRuntimeTestHarness(fake);

describe("second-factor page handlers chosen per account (ADR 0027)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
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
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.cardHints = undefined;
    fake.state.question = undefined;
  });
  const securityKey = { by: "text" as const, value: "Use security key" };
  const keyHandler = { kind: "passkey" as const, path: "/login/webauthn", target: securityKey };
  const { completion: _unlearned, ...unlearned } = recipe;
  const plain = parseLoginRecipe(unlearned);
  const home = [{ target: target("logout") }];
  void parseLoginRecipe({ ...unlearned, completion: home, handlers: [keyHandler] });
  void parseLoginRecipe({ ...unlearned, revision: 2, handlers: [keyHandler] });
  const withPasskey = vi.fn(async () => ({ passkey: true, discoverable: false }));
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const webauthnPage = observation("/login/webauthn", [
    { id: "c1", role: "button", target: securityKey, label: "Use security key" },
  ]);
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map(
        (entry) =>
          (
            entry as unknown as {
              operation: { step: { kind: string; target?: { value: string } } };
            }
          ).operation.step,
      );
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target?.value === value).length;
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown } | "hang">,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || !step.target) return;
      const next = pages[step.target.value];
      if (next === "hang") return new Promise<void>(() => undefined);
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };
  const toWebauthn = {
    path: "/login/webauthn",
    present: ["Use security key"],
    extracted: webauthnPage,
  };
  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  function generation(judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" })) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      // Like the service, it says just before the request leaves the device.
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  const editFields = (
    h: ReturnType<typeof harness>,
    edit: (fields: Record<string, unknown>[]) => Record<string, unknown>[],
  ) => {
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        item.fields = edit(item.fields as never) as never;
      }
      return response;
    });
  };
  async function until(check: () => boolean, maxMs = 200_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const settled = (state: string, outcome?: string) => () =>
    status()?.[0]?.["state"] === state &&
    (outcome === undefined || status()?.[0]?.["outcome"] === outcome);
  describe("the account's slots for the judge and a paired secret question", () => {
    const answerHandler = {
      kind: "detail" as const,
      path: "/question",
      fields: [{ detail: "secret-answer" as const, target: target("answer") }],
      target: target("next"),
    };
    const asked = parseLoginRecipe({
      ...unlearned,
      revision: 2,
      completion: home,
      handlers: [answerHandler],
    });
    const questionPage = observation("/question", [
      { id: "c1", role: "text", target: target("answer"), description: "母親の旧姓は？" },
      { id: "c2", role: "button", target: target("next"), label: "Next" },
    ]);
    const toQuestion = { path: "/question", present: ["answer", "next"], extracted: questionPage };
    const answerField = `custom.${snapshotId}.0`;
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    void {
      field: target("answer"),
      slot: "custom-1",
      shown: "母親の旧姓は？",
    };
    const answerFills = () =>
      fake.state.messages.filter(
        (entry) =>
          (entry.type === "login.execute" &&
            entry.values?.some((value) => value.slot === "detail")) ||
          entry.type === "login.detail.fill",
      );
    function clickToQuestion(
      started: () => ReturnType<typeof harness>,
      documentId: string,
      pages: Parameters<typeof onClick>[0] = {},
    ) {
      onClick({ login: toQuestion, ...pages });
      const click = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        await click(message, tabId);
        if (fake.state.observedPath !== "/question" || fake.state.pageUrl.endsWith("/question"))
          return;
        // The password page's document is gone.
        const { operation } = message as { operation: { document: { documentId: string } } };
        fake.state.gone.add(operation.document.documentId);
        fake.state.pageUrl = `${origin}/question`;
        setTimeout(() => void started().hello({ documentId }, false), 0);
      };
    }
    async function stoppedAtQuestion(
      questions: { field: LoginFieldTarget; slot: string; shown: string }[] | undefined,
      custom: CustomField[] = [{ name: "お母さんの旧姓", kind: "hidden" }],
    ) {
      vi.useFakeTimers();
      fake.state.question = "秘密の質問：母親の旧姓は？";
      clickToQuestion(() => h, "question-document");
      const answers: Awaited<ReturnType<LoginGeneration["judge"]>>[] = [
        { verdict: "challenge", recipe: asked, ...(questions ? { questions } : {}) },
      ];
      const service = generation(async () => answers.shift() ?? { verdict: "signed-in" });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        {},
        { passkeys: noPasskey, generation: service, report, username: true, custom },
      );
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"), 10_000);
      return { h, service, report };
    }
    const detailOf = (h: ReturnType<typeof harness>) =>
      h.login.handle({ version: 1, type: "login.detail.get", tabId: 1 }, popup);
    const fill = (h: ReturnType<typeof harness>) =>
      h.login.handle(
        {
          version: 1,
          type: "login.detail.fill",
          tabId: 1,
          documentId: "question-document",
          detail: "secret-answer",
          connectionId,
          itemId,
          fieldId: answerField,
        },
        popup,
      );
    it("matches a link with a stored question by that question only, not its field's name", async () => {
      vi.useFakeTimers();
      // The page shows the field's name, but not the question the owner confirmed for it.
      fake.state.question = "秘密の質問：お母さんの旧姓は？";
      clickToQuestion(() => h, "question-document", {
        next: { path: "/home", present: ["logout"], extracted: homePage },
      });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(
        {
          detailLinks: [
            {
              origin,
              provider: "bitwarden",
              server: "cloud-us",
              userId,
              itemId,
              detail: "secret-answer",
              source: { itemId, field: { custom: "お母さんの旧姓" } },
              question: "母親の旧姓は",
            },
          ],
        },
        {
          passkeys: noPasskey,
          generation: service,
          report,
          username: true,
          custom: [{ name: "お母さんの旧姓", kind: "hidden" }],
        },
      );
      h.recipes.recipe.mockResolvedValue(asked);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"), 10_000);
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.detail.question",
          names: [{ question: "母親の旧姓は" }],
        }),
      );
      expect(answerFills()).toEqual([]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain(answerField);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "handler", kind: "detail", outcome: "detail-unlinked" }),
      );
    });
    it("still offers a field named as the question with no pairing and no question stored", async () => {
      const { h } = await stoppedAtQuestion(undefined, [
        { name: "母親の旧姓は？", kind: "hidden" },
      ]);
      const answer = await detailOf(h);
      expect(answer).toMatchObject({
        offer: { details: [{ detail: "secret-answer", candidates: [{ fieldId: answerField }] }] },
      });
      expect(JSON.stringify(answer)).not.toContain('"question"');
      expect(await fill(h)).toEqual({ ok: true });
      expect(answerFills()).toEqual([
        expect.objectContaining({
          type: "login.detail.fill",
          fields: [expect.objectContaining({ question: { name: "母親の旧姓は？" } })],
        }),
      ]);
    });
  });
  describe("generation slots", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    const loginPage = observation("/signin", [
      { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
      { id: "c2", role: "password", target: target("password") },
      { id: "c3", role: "button", target: target("login"), label: "Sign in" },
    ]);
    const uris = async () => ({ ok: true as const, data: uriMatch() });
    it.each([
      ["is empty", {}, true],
      ["is excluded", excludingLive(["login.password"]), false],
    ])(
      "offers no password when the matching item's password %s",
      async (_label, excluded, empty) => {
        fake.state.extracted = { login: loginPage };
        const service = { ...generation(), available: vi.fn(async (): Promise<true> => true) };
        const h = harness(
          {
            ...unsaved,
            ...excluded,
          },
          { allowedOrigins: [], uris, username: true, custom: [], generation: service },
        );
        if (empty)
          editFields(h, (fields) =>
            fields.map((field) =>
              field["id"] === "login.password" ? { ...field, empty: true } : field,
            ),
          );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(service.generate.mock.calls[0]![0].slots).toEqual([
          expect.objectContaining({ id: "username", kind: "identifier" }),
        ]);
      },
    );
  });
  describe("passkey-only generation eligibility", () => {
    it("does not run the passkey button as a password fallback for a password-only item", async () => {
      const only = parseLoginRecipe({
        version: 1,
        id: "synthetic-passkey-only",
        revision: 1,
        origin,
        pageKind: "sign-in",
        slots: [],
        passkeyOnly: true,
        passkey: { path: "/signin", target: target("login") },
        steps: [{ kind: "click", purpose: "submit", path: "/signin", target: target("login") }],
        maxSubmissions: 1,
      });
      const h = harness({}, { passkeys: async () => ({ passkey: false, discoverable: false }) });
      h.recipes.recipe.mockResolvedValue(only);
      h.recipes.starts.mockResolvedValue(startsOf(only.steps));
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(clicks("login")).toBe(0);
      expect(h.fields).not.toHaveBeenCalled();
    });
    const showPasskey = (h: ReturnType<typeof harness>) =>
      h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          signIn: { path: reportedPath(fake.state.pageUrl), passkey: true },
        },
        sender(),
      );
    const passkeyOnlySetup = (
      passkeyItems: (origin: string) => Promise<readonly PasskeyItem[]>,
      candidates = uriMatch().candidates,
      overrides: Partial<LocalSettings> = {},
    ) => {
      const service = {
        available: vi.fn(async (): Promise<true> => true),
        generate: vi.fn<LoginGeneration["generate"]>(),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        judge: vi.fn<LoginGeneration["judge"]>(),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(),
      };
      const report = vi.fn<(report: LoginReport) => void>();
      const lookup = vi.fn(passkeyItems);
      const h = harness(
        { siteDefaults: [], bindings: [], ...overrides },
        {
          uris: async () => ({ ok: true as const, data: uriMatch({ candidates }) }),
          passkeyItems: lookup,
          generation: service,
          report,
        },
      );
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      const skipped = () =>
        report.mock.calls
          .map(([entry]) => entry)
          .filter((entry) => entry.type === "generation" && entry.outcome === "skipped");
      return { h, service, lookup, skipped };
    };
    it.each<[string, () => Promise<readonly PasskeyItem[]>]>([
      ["no passkey, as in a locked vault", async () => []],
      ["a passkey from a different item", async () => [{ connectionId, itemId: otherItemId }]],
      [
        "a lookup that fails",
        async () => {
          throw new Error("synthetic lookup failure");
        },
      ],
    ])("does not generate for %s", async (_, held) => {
      const { h, service, lookup, skipped } = passkeyOnlySetup(held);
      expect(await showPasskey(h)).not.toEqual({ ok: false, reason: "generating" });
      expect(lookup).toHaveBeenCalledOnce();
      expect(skipped()).toEqual([
        expect.objectContaining({ reason: "no-vault-match", detail: "no-passkey" }),
      ]);
      expect(service.generate).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });
    it("does not generate on a site whose passkey requests go to the browser (ADR 0007)", async () => {
      const { h, service, lookup, skipped } = passkeyOnlySetup(
        async () => [{ connectionId, itemId }],
        uriMatch().candidates,
        { passkeyBrowserSites: [{ hostname: new URL(origin).hostname }] },
      );
      expect(await showPasskey(h)).not.toEqual({ ok: false, reason: "generating" });
      // Pateat answers no passkey request there, so no item holds one it may use.
      expect(lookup).not.toHaveBeenCalled();
      expect(skipped()).toEqual([
        expect.objectContaining({ reason: "no-vault-match", detail: "no-passkey" }),
      ]);
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("refuses a page announced as both an identifier page and a passkey page", async () => {
      const { h, service, lookup, skipped } = passkeyOnlySetup(async () => [
        { connectionId, itemId },
      ]);
      const both = await h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          signIn: { path: reportedPath(fake.state.pageUrl), identifier: true, passkey: true },
        },
        sender(),
      );
      expect(both).not.toEqual({ ok: false, reason: "generating" });
      expect(skipped()).toEqual([]);
      expect(lookup).not.toHaveBeenCalled();
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("never looks up passkeys when no vault item matches the page", async () => {
      const { h, service, lookup, skipped } = passkeyOnlySetup(
        async () => [{ connectionId, itemId }],
        [],
      );
      expect(await showPasskey(h)).not.toEqual({ ok: false, reason: "generating" });
      expect(skipped()).toEqual([
        expect.objectContaining({ reason: "no-vault-match", detail: "no-item" }),
      ]);
      expect(lookup).not.toHaveBeenCalled();
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("sends a page with only a passkey button when one of several matching items holds a passkey", async () => {
      const { h, service, skipped } = passkeyOnlySetup(
        async () => [{ connectionId, itemId }],
        [
          { itemId, matches: [{ uriIndex: 0, match: 0 }] },
          { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
        ],
      );
      fake.state.extracted = {
        passkey: {
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
        },
      };
      service.generate.mockResolvedValue({ outcome: "abstained", reason: "ambiguous" });
      expect(await showPasskey(h)).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
      expect(service.generate.mock.calls[0]![0]).toMatchObject({ passkeyOnly: true, slots: [] });
      expect(skipped()).toEqual([]);
    });
    it("sends no fill slots only when the same eligible matching item holds a discoverable passkey", async () => {
      fake.state.extracted = {
        passkey: {
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
        },
      };
      const service = {
        available: vi.fn(async (): Promise<true> => true),
        generate: vi.fn<LoginGeneration["generate"]>(async () => ({
          outcome: "abstained",
          reason: "ambiguous",
        })),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        judge: vi.fn<LoginGeneration["judge"]>(),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(),
      };
      const h = harness(
        { siteDefaults: [], bindings: [] },
        {
          uris: async () => ({ ok: true as const, data: uriMatch() }),
          passkeyItems: async () => [{ connectionId, itemId }],
          generation: service,
        },
      );
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      await showPasskey(h);
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
      expect(service.generate.mock.calls[0]![0]).toMatchObject({ passkeyOnly: true, slots: [] });
      expect(service.generateEntry).not.toHaveBeenCalled();
      expect(fake.state.messages.filter((entry) => entry["type"] === "login.fill")).toEqual([]);
    });
  });
  describe("the item a running login uses", () => {
    it("is named only while the tab's login on that origin has not ended", async () => {
      onClick({ login: "hang" });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(clicks("login")).toBe(1));
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      expect(await h.login.loginAccount(1, "https://other.example")).toBeUndefined();
      expect(await h.login.loginAccount(2, origin)).toBeUndefined();
    });
    it("is not named once the login's result settled as unknown", async () => {
      vi.useFakeTimers();
      onClick({ login: { path: "/elsewhere", present: [] } });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("login") === 1);
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      await until(settled("reconciling", "unknown-submit"), 10_000);
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });
    it("keeps naming a running login's item after a worker restart", async () => {
      onClick({ login: "hang" });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(clicks("login")).toBe(1));
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness({}, { passkeys: withPasskey });
        expect(await restarted.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
        expect(status()).toMatchObject([{ state: "reconciling" }]);
        expect(await restarted.login.loginAccount(1, "https://other.example")).toBeUndefined();
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("does not name a settled login's item after a worker restart", async () => {
      vi.useFakeTimers();
      onClick({ login: { path: "/elsewhere", present: [] } });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 10_000);
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness({}, { passkeys: withPasskey });
        expect(await restarted.login.loginAccount(1, origin)).toBeUndefined();
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("is not named once the login ended", async () => {
      fake.state.present = undefined;
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });
  });
  describe("a passkey re-verification after the tab's login (ADR 0035)", () => {
    it("is not told while the tab's login runs", async () => {
      onClick({ login: "hang" });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(clicks("login")).toBe(1));
      // A running login answers its own requests (ADR 0027).
      expect(await h.login.passkeyReverification(1, origin)).toBe(false);
    });
    it("is told in the tab and origin of a login that signed in", async () => {
      fake.state.present = undefined;
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
      expect(await h.login.passkeyReverification(1, origin)).toBe(true);
      expect(await h.login.passkeyReverification(2, origin)).toBe(false);
      expect(await h.login.passkeyReverification(1, "https://other.example")).toBe(false);
    });
  });
  describe("with password route variants", () => {
    const fillOn = (path: string, slots: string[]) => ({
      kind: "fill" as const,
      path,
      fields: slots.map((slot) => ({ slot, target: target(slot) })),
    });
    const clickOn = (path: string, value: string, purpose: "advance" | "submit") => ({
      kind: "click" as const,
      path,
      target: target(value),
      purpose,
    });
    const variantBinding = (slots: SavedLoginBinding["slots"]): SavedLoginBinding => ({
      ...savedBinding,
      recipeId: "synthetic-variants",
      slots,
    });
    it("does not judge a page that shows another variant's field on that variant's path", async () => {
      vi.useFakeTimers();
      // The branch variant signs in on the start page; the member variant continues to
      // `/verify` for its PIN.
      const twoPaths = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-variants",
        slots: ["branch", "password"],
        steps: [fillOn("/signin", ["branch", "password"]), clickOn("/signin", "login", "submit")],
        alternatives: [
          {
            slots: ["member", "pin"],
            steps: [
              fillOn("/signin", ["member"]),
              clickOn("/signin", "next", "advance"),
              fillOn("/verify", ["pin"]),
              clickOn("/verify", "confirm", "submit"),
            ],
          },
        ],
        maxSubmissions: 2,
      });
      // The branch login lands on the member variant's PIN page.
      const pinPage = observation("/verify", [
        { id: "c1", role: "password", target: target("pin"), label: "PIN" },
      ]);
      onClick({ login: { path: "/verify", present: ["pin"], extracted: pinPage } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness(
        {
          bindings: [
            variantBinding([
              { slot: "branch", field: { custom: "Branch" } },
              { slot: "password", field: "password" },
            ]),
          ],
        },
        { passkeys: withPasskey, generation: service },
      );
      h.recipes.recipe.mockResolvedValue(twoPaths);
      // A readable sign-in state that shows no failure, so the page is looked at.
      fake.state.signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(status()![0]).toMatchObject({ variant: 0 });
      // The page is a sign-in page of the route, whichever variant ran, as the service
      // would also answer. It is described only to look for a form beside the sign-in
      // form (ADR 0061), which it does not show.
      expect(service.judge).not.toHaveBeenCalled();
      expect(
        fake.state.messages
          .filter((entry) => entry.type === "login.extract")
          .map((entry) => (entry as Record<string, unknown>)["page"]),
      ).toEqual(["signed-in"]);
    });
    it("takes a revision over on the variant the login runs and clicks the handler", async () => {
      vi.useFakeTimers();
      // Variant 0 has one step more than variant 1, so a handler inserted after the wrong
      // variant's steps would not follow the click that ran.
      const plainVariants = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-variants",
        slots: ["branch", "password"],
        steps: [
          fillOn("/signin", ["branch"]),
          fillOn("/signin", ["password"]),
          clickOn("/signin", "login", "submit"),
        ],
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [
              fillOn("/signin", ["contract", "password"]),
              clickOn("/signin", "login", "submit"),
            ],
          },
        ],
      });
      const takenVariants = parseLoginRecipe({
        ...plainVariants,
        revision: 2,
        handlers: [keyHandler],
      });
      onClick({ login: toWebauthn, "Use security key": toHome });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: takenVariants })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const h = harness(
        {
          bindings: [
            variantBinding([
              { slot: "contract", field: { custom: "Contract" } },
              { slot: "password", field: "password" },
            ]),
          ],
        },
        {
          passkeys: withPasskey,
          generation: service,
          custom: [{ name: "Contract", kind: "text" }],
        },
      );
      h.recipes.recipe.mockResolvedValue(plainVariants);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        route: "password",
        variant: 1,
        recipeRevision: 2,
        handlers: [{ index: 0, start: 2 }],
        stepCount: 3,
        maxSubmissions: 2,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "click"]);
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [plainVariants.id, 1, "password", webauthnPage.observation],
        [plainVariants.id, 2, "password", homePage.observation],
      ]);
    });
  });
  describe("a login watched after a step left to the person (ADR 0027)", () => {
    const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
    const described = (path: string) =>
      observation(path, [{ id: "c1", role: "link", target: target("help"), label: "Help" }]);
    const reports = vi.fn<(report: LoginReport) => void>();
    const judges = () =>
      reports.mock.calls.flatMap(([value]) =>
        value.type === "judge" && value.verdict !== "sent" ? [value] : [],
      );
    async function watched(
      verdicts: Awaited<ReturnType<LoginGeneration["judge"]>>["verdict"][] = [],
      chosen = plain,
      before?: (h: ReturnType<typeof harness>) => Promise<unknown>,
      live: Parameters<typeof harness>[1] = {},
    ) {
      vi.useFakeTimers();
      reports.mockClear();
      fake.state.signs = quiet;
      onClick({ login: { path: "/approve", present: [], extracted: described("/approve") } });
      const answers = ["challenge" as const, ...verdicts];
      const service = generation(async () => ({ verdict: answers.shift() ?? "unclear" }));
      const h = harness(
        {},
        { passkeys: withPasskey, generation: service, report: reports, ...live },
      );
      h.recipes.recipe.mockResolvedValue(chosen);
      await before?.(h);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"), 10_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      return { h, service };
    }
    async function open(
      h: ReturnType<typeof harness>,
      path: string,
      present: string[] = [],
      wait = 30_000,
    ) {
      fake.state.pageUrl = `${origin}${path}`;
      fake.state.observedPath = path;
      fake.state.present = new Set(present);
      fake.state.extracted = { "signed-in": described(path) };
      const answer = await h.hello({ documentId: `document${path.replaceAll("/", "-")}` }, false);
      await vi.advanceTimersByTimeAsync(wait);
      return answer;
    }
    it("completes on a later page the judge finds signed in, reading only", async () => {
      const { h, service } = await watched(["signed-in"]);
      const steps = executed().length;
      // The page of the approval itself is not read again.
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "duplicate-document" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      // A later page watches for the first step, which would release the login.
      expect(await open(h, "/home")).toEqual({ ok: true, starts: expect.any(Array) });
      expect(service.judge).toHaveBeenCalledTimes(2);
      expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
      expect(status()![0]).not.toHaveProperty("watch");
      expect(executed()).toHaveLength(steps);
      expect(judges().at(-1)).toMatchObject({ verdict: "signed-in", watched: true });
      // The login finished, so its form showing again logs in again, as on any visit
      // (ADR 0062).
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      const before = executed().length;
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(executed().length).toBeGreaterThan(before);
      expect(
        reports.mock.calls.filter(([entry]) => entry.type === "start" && entry.tabId === 1),
      ).toHaveLength(2);
      expect(fake.state.session["pateat.login-stopped-asks.v1"] ?? []).toEqual([]);
      expect(fake.state.session["pateat.login-rejected-asks.v1"] ?? []).toEqual([]);
    });
    it("reads a route the approval's own document takes, as a single-page site's (ADR 0027)", async () => {
      const { h, service } = await watched(["signed-in"]);
      const steps = executed().length;
      expect(status()).toMatchObject([{ watch: { path: "/approve" } }]);
      // A move to the path the login was read on, as the click's own route, reads nothing.
      fake.state.pageUrl = `${origin}/approve`;
      await h.login.handle(
        { version: 1, type: "login.document.moved", token: "synthetic-token" },
        sender(),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
      // The approval page routes to /home in place once the person approved.
      fake.state.pageUrl = `${origin}/home`;
      fake.state.observedPath = "/home";
      fake.state.extracted = { "signed-in": described("/home") };
      await h.login.handle(
        { version: 1, type: "login.document.moved", token: "synthetic-token" },
        sender(),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.judge).toHaveBeenCalledTimes(2);
      expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
      expect(executed()).toHaveLength(steps);
      expect(judges().at(-1)).toMatchObject({ verdict: "signed-in", watched: true });
    });
    it("completes as signed in on a later page the judge finds optional (ADR 0065)", async () => {
      const { h, service } = await watched(["optional"]);
      const steps = executed().length;
      await open(h, "/checkup");
      expect(service.judge).toHaveBeenCalledTimes(2);
      expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]);
      expect(status()![0]).not.toHaveProperty("unconfirmed");
      expect(executed()).toHaveLength(steps);
      expect(judges().at(-1)).toMatchObject({ verdict: "optional", watched: true });
    });
    it("hides the account's username from a watched page it judges", async () => {
      const { h, service } = await watched(
        ["signed-in"],
        plain,
        async (created) =>
          created.fields.mockImplementation(async ({ fieldId }) =>
            fieldId === "login.username" ? "taro.yamada" : "synthetic-secret",
          ),
        { username: true },
      );
      fake.state.pageUrl = `${origin}/home`;
      fake.state.observedPath = "/home";
      fake.state.present = new Set();
      fake.state.extracted = {
        "signed-in": observation("/home", [
          { id: "c1", role: "link", target: target("help"), label: "Help for taro.yamada" },
        ]),
      };
      await h.hello({ documentId: "document-home" }, false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.judge).toHaveBeenCalledTimes(2);
      expect(service.judge.mock.calls[1]![3].candidates).toEqual([
        { id: "c1", role: "link", target: target("help"), label: "Help for [account]" },
      ]);
      expect(JSON.stringify(service.judge.mock.calls)).not.toContain("taro");
      expect(status()).toMatchObject([{ state: "authenticated" }]);
    });
    it("completes on the recipe's completion without asking the judge", async () => {
      const completing = parseLoginRecipe({ ...unlearned, completion: home });
      const { h, service } = await watched([], completing);
      await open(h, "/home", ["logout"]);
      expect(status()).toMatchObject([{ state: "authenticated" }]);
      expect(service.judge).toHaveBeenCalledTimes(1);
    });
    it("completes on the sign-in state without asking the judge (ADR 0029)", async () => {
      const { h, service } = await watched();
      fake.state.signs = { ...quiet, username: true };
      await open(h, "/home");
      expect(status()).toMatchObject([{ state: "authenticated" }]);
      expect(service.judge).toHaveBeenCalledTimes(1);
    });
  });
});
