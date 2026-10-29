import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../../crypto/wire";
import type { LoginReport } from "../runtime/report";
import type { ConditionalDecision, PasskeyItem } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  target,
  recipe,
  userId,
  otherItemId,
  uriMatch,
  harness,
  realTime,
} = createRuntimeTestHarness(fake);

describe("the start page's own passkey request (ADR 0034)", () => {
  beforeEach(realTime);
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
    // The base recipe has no passkey button: the page asks for a passkey by itself.
    fake.state.present = new Set(["password", "login"]);
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });
  const discoverable = () => vi.fn(async () => ({ passkey: true, discoverable: true }));

  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target.value === value).length;
  const fills = () => executed().filter((step) => step.kind === "fill").length;
  const signsInOnClick = () => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "login")
        fake.state.present = new Set(["authenticated"]);
    };
  };
  function start(
    used: LoginRecipe = recipe,
    live: Parameters<typeof harness>[1] = {},
    overrides: Partial<LocalSettings> = {},
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(overrides, { passkeys: discoverable(), report, ...live });
    h.recipes.recipe.mockResolvedValue(used);
    return { h, report };
  }
  const ask = (
    h: ReturnType<typeof harness>,
    change: Partial<{ tabId: number; origin: string; documentId: string }> = {},
  ) => {
    const controller = new AbortController();
    let decided: ConditionalDecision | undefined;
    const decision = h.login
      .conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: controller.signal,
        ...change,
      })
      .then((value) => (decided = value));
    return { controller, decision, decided: () => decided };
  };
  const flush = async () => {
    for (let index = 0; index < 10; index++)
      // eslint-disable-next-line no-await-in-loop
      await (vi.isFakeTimers()
        ? vi.advanceTimersByTimeAsync(0)
        : new Promise((resolve) => setTimeout(resolve, 0)));
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

  const routeChanges = (report: ReturnType<typeof start>["report"]) =>
    report.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === "attempt" && "routeChange" in entry)
      .map((entry) => (entry as { route: string; routeChange?: string }).routeChange);
  describe("while the tab asks for an account (ADR 0062)", () => {
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    const matching = { allowedOrigins: [], uris: async () => ({ ok: true as const, data: both }) };
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const choice = (h: ReturnType<typeof harness>, tabId = 1) =>
      h.login.handle({ version: 1, type: "login.choice.get", tabId }, popup);
    const pick = (
      h: ReturnType<typeof harness>,
      overrides: Partial<{ tabId: number; documentId: string; itemId: string }> = {},
    ) =>
      h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "signed-out",
          connectionId,
          itemId: otherItemId,
          makeDefault: false,
          ...overrides,
        },
        popup,
      );

    const asked = async (live: Parameters<typeof harness>[1] = {}) => {
      fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
      const started = start(recipe, { ...matching, ...live }, { siteDefaults: [], bindings: [] });
      const { h } = started;
      expect(await h.hello({ documentId: "signed-out" })).toEqual({
        ok: false,
        reason: "account-asked",
      });
      expect(await choice(h)).toMatchObject({ documentId: "signed-out", ask: "rejected" });
      fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
      return started;
    };

    it("hands a waiting request on soon after a pick whose page does not announce again", async () => {
      vi.useFakeTimers();
      const { h } = await asked();
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      await until(() => request.decided() !== undefined, 4_500);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    });
    it("keeps a request whose choice is offered again soon after a pick that started no login", async () => {
      vi.useFakeTimers();
      const { h, report } = await asked();
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      // The pick's reconnect gets no announcement, so it starts nothing.
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      // The document announces again a moment later and is asked again.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await h.hello({ documentId: "signed-out" })).toEqual({
        ok: false,
        reason: "account-asked",
      });
      expect(await choice(h)).toMatchObject({ documentId: "signed-out", ask: "rejected" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request.decided()).toBeUndefined();
      const filled = fills();
      fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
      expect(await pick(h)).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId: otherItemId },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "passkey",
        account: { connectionId, itemId: otherItemId },
      });
      expect(fills()).toBe(filled);
      expect(routeChanges(report)).toEqual([]);
    });
    it("hands on a request of a document asked without an ask, even while its pick is pending", async () => {
      vi.useFakeTimers();
      const { h } = start(recipe, matching, { siteDefaults: [], bindings: [] });
      // Several accounts match and none is the default: the popup asks, with no ask reason.
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(await choice(h)).toMatchObject({ ok: true, documentId: "synthetic-document" });
      expect(await choice(h)).not.toHaveProperty("ask");
      const request = ask(h);
      await flush();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(request.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
      expect(await choice(h)).toMatchObject({ ok: true, documentId: "synthetic-document" });
      // A second request is picked for meanwhile; the page announces again only later.
      const again = ask(h);
      await flush();
      fake.state.onReconnect = () =>
        new Promise((resolve) => setTimeout(() => resolve(h.hello()), 5_000));
      signsInOnClick();
      const picking = pick(h, { documentId: "synthetic-document" });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(again.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(again.decided()).toEqual({ kind: "delegate", reason: "no-login" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await picking).toEqual({ ok: true });
      // The pick's login, finding no request, takes the password.
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "password",
        account: { connectionId, itemId: otherItemId },
      });
    });
    it("keeps a request of a document asked after the tab's stopped login, and answers it with the pick", async () => {
      vi.useFakeTimers();
      const first = start(recipe, matching);
      // The login stops after its click, as when the page leaves while submitting.
      fake.state.onExecute = (message) =>
        (message["operation"] as { step: LoginStep }).step.kind === "click"
          ? new Promise(() => undefined)
          : Promise.resolve();
      expect(await first.h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "submit-intent", 5_000);
      const [record] = status()!;
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        fake.state.storage["pateat.login-attempts.v5"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "policy-changed",
            mutationIntent: undefined,
            operationId: undefined,
            operationKind: undefined,
            operationEffect: undefined,
          },
        ];
        fake.state.onExecute = undefined;
        // A restarted worker sees the form show again in a later page of the tab.
        const { h, report } = start(recipe, matching);
        const request = ask(h, { documentId: "next-page" });
        await flush();
        expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await until(() => fake.state.badges[1]?.text === "2", 5_000);
        expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(request.decided()).toBeUndefined();
        const filled = fills();
        fake.state.onReconnect = () => h.hello({ documentId: "next-page" });
        expect(await pick(h, { documentId: "next-page" })).toEqual({ ok: true });
        await until(() => request.decided() !== undefined, 5_000);
        expect(request.decided()).toMatchObject({
          kind: "answer",
          item: { connectionId, itemId: otherItemId },
        });
        fake.state.present = new Set(["authenticated"]);
        (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
        await until(settled("authenticated"), 20_000);
        expect(status()![0]).toMatchObject({
          route: "passkey",
          account: { connectionId, itemId: otherItemId },
        });
        expect(fills()).toBe(filled);
        expect(clicks("login")).toBe(1);
        expect(routeChanges(report)).toEqual([]);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("still withholds after four minutes with an item lookup given, and never looks items up", async () => {
      vi.useFakeTimers();
      const passkeyItems = vi.fn(async () => [{ connectionId, itemId: otherItemId }]);
      const { h } = await asked({ passkeyItems });
      const sent = executed().length;
      const request = ask(h, { documentId: "signed-out" });
      await flush();
      await vi.advanceTimersByTimeAsync(235_000);
      expect(request.decided()).toBeUndefined();
      await until(() => request.decided() !== undefined, 10_000);
      expect(request.decided()).toEqual({ kind: "withhold" });
      expect(executed()).toHaveLength(sent);
      expect(passkeyItems).not.toHaveBeenCalled();
    });
  });
  describe("while the tab offers a popup choice outside a logout (ADR 0034 rule 5)", () => {
    const thirdItemId = "80000000-0000-4000-8000-000000000003";
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const choice = (h: ReturnType<typeof harness>, tabId = 1) =>
      h.login.handle({ version: 1, type: "login.choice.get", tabId }, popup);
    const pick = (
      h: ReturnType<typeof harness>,
      overrides: Partial<{ documentId: string; itemId: string; makeDefault: boolean }> = {},
    ) =>
      h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "synthetic-document",
          connectionId,
          itemId,
          makeDefault: false,
          ...overrides,
        },
        popup,
      );
    const holding = () =>
      vi.fn<(origin: string) => Promise<readonly PasskeyItem[]>>(async () => [
        { connectionId, itemId },
      ]);
    function deferred() {
      let answer!: (items: readonly PasskeyItem[]) => void;
      const lookup = vi.fn<(origin: string) => Promise<readonly PasskeyItem[]>>(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      return { lookup, answer: (items: readonly PasskeyItem[]) => answer(items) };
    }
    function choosing(
      live: Parameters<typeof harness>[1] = {},
      used: LoginRecipe = recipe,
      data: () => UriCandidates = () => both,
    ) {
      return start(
        used,
        { allowedOrigins: [], uris: async () => ({ ok: true as const, data: data() }), ...live },
        { siteDefaults: [], bindings: [] },
      );
    }
    async function offered(h: ReturnType<typeof harness>, documentId = "synthetic-document") {
      expect(await h.hello({ documentId })).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(await choice(h)).toMatchObject({ ok: true, documentId });
      expect(await choice(h)).not.toHaveProperty("logout");
    }
    async function answeredWithPick(
      h: ReturnType<typeof harness>,
      request: ReturnType<typeof ask>,
      report: ReturnType<typeof start>["report"],
    ) {
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h)).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({
        kind: "answer",
        item: { connectionId, itemId },
      });
      expect(status()![0]).toMatchObject({
        route: "passkey",
        state: "submit-intent",
        submissions: 1,
        account: { connectionId, itemId },
      });
      fake.state.present = new Set(["authenticated"]);
      (request.decided() as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({ route: "passkey", account: { connectionId, itemId } });
      expect(executed()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(
        report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "start"),
      ).toEqual([expect.objectContaining({ route: "passkey", account: "pick" })]);
      expect(routeChanges(report)).toEqual([]);
    }
    async function stillWaits(request: ReturnType<typeof ask>, ms = 10_000) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(request.decided()).toBeUndefined();
    }
    async function handedOnSoon(request: ReturnType<typeof ask>) {
      await vi.advanceTimersByTimeAsync(2_500);
      expect(request.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_600);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    }
    it("keeps a request that comes after the choice, and answers it with a picked item's passkey", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      // Nothing is looked up before a request of the document waits.
      expect(passkeyItems).not.toHaveBeenCalled();
      const request = ask(h);
      await flush();
      expect(passkeyItems.mock.calls).toEqual([[origin]]);
      await stillWaits(request);
      await answeredWithPick(h, request, report);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
    });
    it("keeps a request that came first once the choice is offered within three seconds", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      const request = ask(h);
      await flush();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(request.decided()).toBeUndefined();
      await offered(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await stillWaits(request);
      await answeredWithPick(h, request, report);
    });
    it.each<[string, readonly PasskeyItem[]]>([
      ["no item", []],
      [
        "only items not offered",
        [
          { connectionId, itemId: thirdItemId },
          { connectionId: "another-connection", itemId },
        ],
      ],
    ])("hands a request on after three seconds when %s holds a passkey", async (_label, held) => {
      vi.useFakeTimers();
      const passkeyItems = vi.fn(async () => held);
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });
    it("hands a request on after three seconds when the lookup fails", async () => {
      vi.useFakeTimers();
      const passkeyItems = vi.fn(async (): Promise<readonly PasskeyItem[]> => {
        throw new Error("synthetic lookup failure");
      });
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await handedOnSoon(request);
    });
    it("keeps a request while the lookup runs past three seconds, and hands it on once it finds none", async () => {
      vi.useFakeTimers();
      const { lookup, answer } = deferred();
      const { h } = choosing({ passkeyItems: lookup });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      expect(lookup).toHaveBeenCalledTimes(1);
      answer([]);
      // Handed on at once: the three seconds have long passed.
      await flush();
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
    });
    it("keeps a request whose slow lookup finds an offered item with a passkey", async () => {
      vi.useFakeTimers();
      const { lookup, answer } = deferred();
      const { h, report } = choosing({ passkeyItems: lookup });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      answer([{ connectionId, itemId }]);
      await flush();
      await stillWaits(request);
      await answeredWithPick(h, request, report);
    });
    it("logs a picked item without a passkey in with the password, then withholds", async () => {
      vi.useFakeTimers();
      const passkeys = vi.fn(async (account: unknown) =>
        (account as { itemId: string }).itemId === otherItemId
          ? { passkey: false, discoverable: false }
          : { passkey: true, discoverable: true },
      );
      const { h, report } = choosing({ passkeyItems: holding(), passkeys });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      signsInOnClick();
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, { itemId: otherItemId })).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({
        route: "password",
        account: { connectionId, itemId: otherItemId },
      });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toEqual({ kind: "withhold" });
      expect(fills()).toBe(1);
      expect(clicks("login")).toBe(1);
      expect(routeChanges(report)).toEqual([]);
    });
    it("hands a request on once a picked item's password login ended without signing in", async () => {
      vi.useFakeTimers();
      const passkeys = vi.fn(async () => ({ passkey: false, discoverable: false }));
      const { h } = choosing(
        { passkeyItems: holding(), passkeys },
        parseLoginRecipe({ ...recipe, rejection: target("rejected") }),
      );
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "click") fake.state.present = new Set(["password", "login", "rejected"]);
      };
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, { itemId: otherItemId })).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "blocked", 20_000);
      expect(status()![0]).toMatchObject({ route: "password" });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "login-ended" });
    });
    it("hands a request on four minutes after it came without a pick, instead of withholding it", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await vi.advanceTimersByTimeAsync(239_000);
      expect(request.decided()).toBeUndefined();
      await until(() => request.decided() !== undefined, 10_000);
      expect(request.decided()).toEqual({ kind: "delegate", reason: "no-pick" });
      expect(executed()).toEqual([]);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      // A pick afterwards signs in with the password.
      signsInOnClick();
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h)).toEqual({ ok: true });
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({ route: "password", account: { connectionId, itemId } });
    });
    it("hands a request on three seconds after a new top document replaces the choice", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      // The tab navigated: the new page is offered a choice of its own.
      await offered(h, "next-page");
      await handedOnSoon(request);
      // Without a request of the new page, its choice is not looked up.
      expect(passkeyItems).toHaveBeenCalledTimes(1);
    });
    it.each(["saved", "synced"] as const)(
      "hands a request on three seconds after a site default is %s for the origin",
      async (source) => {
        vi.useFakeTimers();
        const { h } = choosing({ passkeyItems: holding() });
        await offered(h);
        const request = ask(h);
        await flush();
        await stillWaits(request);
        // A change of settings that saves no default for the origin keeps the request.
        h.login.settingsChanged(source);
        await flush();
        await stillWaits(request, 5_000);
        h.settings.settings.siteDefaults.push({
          origin,
          provider: "bitwarden",
          server: "cloud-us",
          userId,
          itemId,
        });
        h.login.settingsChanged(source);
        await flush();
        await handedOnSoon(request);
        expect(executed()).toEqual([]);
      },
    );
    it("hands a request on three seconds after the passkey chooser saves a site default", async () => {
      vi.useFakeTimers();
      const { h } = choosing({ passkeyItems: holding() });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      // Nothing saved yet: the request keeps waiting.
      h.login.siteDefaultSaved();
      await flush();
      await stillWaits(request, 5_000);
      h.settings.settings.siteDefaults.push({
        origin,
        provider: "bitwarden",
        server: "cloud-us",
        userId,
        itemId,
      });
      h.login.siteDefaultSaved();
      await flush();
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });
    it("hands a request on three seconds after another tab's pick saves a site default", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      // Another tab of the site is offered the same accounts, and its page asks for a passkey.
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "account-ambiguous",
      });
      expect(await choice(h, 2)).toMatchObject({ ok: true, documentId: "other-tab" });
      const request = ask(h, { tabId: 2, documentId: "other-tab" });
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await stillWaits(request);
      // The first tab's pick signs in with the password and saves its account as the default.
      signsInOnClick();
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, { makeDefault: true })).toEqual({ ok: true });
      await until(() => h.settings.settings.siteDefaults.some((entry) => entry.origin === origin));
      expect(request.decided()).toBeUndefined();
      await handedOnSoon(request);
    });
    it("hands a request on after three seconds when a site default was saved before its check", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      // Saved without the runtime being told, as when the save raced the refusal.
      h.settings.settings.siteDefaults.push({
        origin,
        provider: "bitwarden",
        server: "cloud-us",
        userId,
        itemId,
      });
      const request = ask(h);
      await flush();
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });
    it("checks the same choice again once a check found no passkey", async () => {
      vi.useFakeTimers();
      // The first check finds none, as with a locked vault; the next one finds the item.
      const passkeyItems = vi.fn(async (): Promise<readonly PasskeyItem[]> => []);
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      const first = ask(h);
      await flush();
      await handedOnSoon(first);
      passkeyItems.mockResolvedValue([{ connectionId, itemId }]);
      const request = ask(h);
      await flush();
      // A new request alone does not check the same choice again.
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await offered(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(2);
      await stillWaits(request);
      await answeredWithPick(h, request, report);
    });
    it("hands a request on three seconds after a frame's choice replaces the page's", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.tabUrls[1] = fake.state.pageUrl;
      expect(
        await h.hello({
          frameId: 3,
          documentId: "frame-document",
          tab: { id: 1, url: fake.state.pageUrl },
        }),
      ).toEqual({
        ok: false,
        reason: "account-ambiguous",
      });
      expect(await choice(h)).toMatchObject({ ok: true, documentId: "frame-document" });
      await handedOnSoon(request);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
    });
    it("keeps a request whose page's choice is offered again within three seconds of a frame's", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.tabUrls[1] = fake.state.pageUrl;
      expect(
        await h.hello({
          frameId: 3,
          documentId: "frame-document",
          tab: { id: 1, url: fake.state.pageUrl },
        }),
      ).toEqual({
        ok: false,
        reason: "account-ambiguous",
      });
      await vi.advanceTimersByTimeAsync(1_500);
      await offered(h);
      await flush();
      await stillWaits(request);
      // The frame's choice dropped the page's check, so it is looked up again.
      expect(passkeyItems).toHaveBeenCalledTimes(2);
      await answeredWithPick(h, request, report);
    });
    describe("after a worker restart", () => {
      async function restarted(passkeyItems: ReturnType<typeof holding>) {
        const first = choosing({ passkeyItems });
        await offered(first.h);
        const again = choosing({ passkeyItems });
        const request = ask(again.h);
        await flush();
        return { ...again, request };
      }
      it("keeps a request once the popup brings the choice back", async () => {
        vi.useFakeTimers();
        const passkeyItems = holding();
        const { h, report, request } = await restarted(passkeyItems);
        expect(passkeyItems).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        fake.state.onReconnect = () => h.hello();
        expect(await choice(h)).toMatchObject({ ok: true, documentId: "synthetic-document" });
        await flush();
        expect(passkeyItems).toHaveBeenCalledTimes(1);
        await stillWaits(request);
        await answeredWithPick(h, request, report);
      });
      it("hands a request on after three seconds when the choice cannot be brought back", async () => {
        vi.useFakeTimers();
        const passkeyItems = holding();
        const { h, request } = await restarted(passkeyItems);
        await vi.advanceTimersByTimeAsync(1_000);
        fake.state.onReconnect = async () => ({ ok: false });
        expect(await choice(h)).toMatchObject({ ok: false, reason: "no-choice" });
        await until(() => request.decided() !== undefined, 3_000);
        expect(request.decided()).toEqual({ kind: "delegate", reason: "no-login" });
        expect(passkeyItems).not.toHaveBeenCalled();
      });
    });
    it("hands a request on soon after a pick that starts no login", async () => {
      vi.useFakeTimers();
      const { h } = choosing({ passkeyItems: holding() });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      await handedOnSoon(request);
      expect(executed()).toEqual([]);
    });
    it("keeps a request whose choice is offered again soon after a pick that started no login", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h, report } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h);
      await flush();
      await stillWaits(request);
      fake.state.onReconnect = async () => ({ ok: false });
      expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
      await vi.advanceTimersByTimeAsync(1_000);
      await offered(h);
      await flush();
      await stillWaits(request);
      // The same choice offered again keeps its check.
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      await answeredWithPick(h, request, report);
    });
    it("hands a request on after three seconds on a recipe with a passkey button", async () => {
      vi.useFakeTimers();
      const { completion: _unlearned, ...unlearned } = recipe;
      const routed = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-passkey-route",
        passkey: { path: "/signin", target: { by: "text", value: "Sign in with a passkey" } },
      });
      fake.state.present = new Set(["password", "login", "Sign in with a passkey"]);
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems }, routed);
      await offered(h);
      const request = ask(h);
      await flush();
      await handedOnSoon(request);
      expect(passkeyItems).not.toHaveBeenCalled();
    });
    it("hands on a request of another document of the tab while the choice is offered", async () => {
      vi.useFakeTimers();
      const passkeyItems = holding();
      const { h } = choosing({ passkeyItems });
      await offered(h);
      const request = ask(h, { documentId: "other-document" });
      await flush();
      await handedOnSoon(request);
      expect(passkeyItems).not.toHaveBeenCalled();
    });
    it("looks up a choice once, again for other accounts, and only inside a vault hold", async () => {
      vi.useFakeTimers();
      // Holds without waiting for a vault check, as the lookup takes; an announcement
      // takes its own.
      let held = 0;
      const vault = {
        refreshIfStale: vi.fn(),
        enter: vi.fn(async (waitForCheck: boolean) => {
          if (!waitForCheck) held += 1;
          let left = false;
          return () => {
            if (left || waitForCheck) return;
            left = true;
            held -= 1;
          };
        }),
      };
      const insideHold: number[] = [];
      const passkeyItems = vi.fn(async (): Promise<readonly PasskeyItem[]> => {
        insideHold.push(held);
        return [{ connectionId, itemId }];
      });
      let data = both;
      const { h } = choosing(
        { passkeyItems, vault, extraItems: [{ id: thirdItemId, custom: [] }] },
        recipe,
        () => data,
      );
      await offered(h);
      const request = ask(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      expect(insideHold).toEqual([1]);
      expect(vault.enter).toHaveBeenLastCalledWith(false);
      expect(held).toBe(0);
      // The same choice offered again is not looked up again.
      await offered(h);
      await flush();
      await stillWaits(request);
      expect(passkeyItems).toHaveBeenCalledTimes(1);
      // A choice of other accounts is.
      data = uriMatch({
        candidates: [
          { itemId, matches: [{ uriIndex: 0, match: 0 }] },
          { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
          { itemId: thirdItemId, matches: [{ uriIndex: 0, match: 0 }] },
        ],
      });
      await offered(h);
      await flush();
      expect(passkeyItems).toHaveBeenCalledTimes(2);
      expect(insideHold).toEqual([1, 1]);
      expect(held).toBe(0);
      await stillWaits(request);
    });
    it("keeps a request picked for while the lookup runs, and answers it once the item is found", async () => {
      vi.useFakeTimers();
      const { lookup, answer } = deferred();
      const { h, report } = choosing({ passkeyItems: lookup });
      await offered(h);
      const request = ask(h);
      await flush();
      // The page announces again only five seconds after the pick.
      fake.state.onReconnect = () =>
        new Promise((resolve) => setTimeout(() => resolve(h.hello()), 5_000));
      const picking = pick(h);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(request.decided()).toBeUndefined();
      answer([{ connectionId, itemId }]);
      await flush();
      expect(request.decided()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await picking).toEqual({ ok: true });
      await until(() => request.decided() !== undefined, 5_000);
      expect(request.decided()).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
      expect(status()![0]).toMatchObject({ route: "passkey", account: { connectionId, itemId } });
      expect(routeChanges(report)).toEqual([]);
    });
  });
});
