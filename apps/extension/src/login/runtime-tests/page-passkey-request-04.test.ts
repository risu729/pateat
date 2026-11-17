import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, recipe, harness, setPause, target } = createRuntimeTestHarness(fake);

// A conditional request that names its credentials on a path where no recipe starts, as
// Money Forward's password page asks for the typed address's passkeys (#1673): answered by
// the passkey it names when its page follows the person's sign-in step in the tab and no
// login of the tab answers it (ADR 0034 amendment of 2026-11-17).
describe("a conditional request that names its credentials (ADR 0034, 2026-11-17)", () => {
  afterEach(() => {
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
    // The recipe starts on /signin; the page that asks is the password page after it.
    fake.state.pageUrl = "https://login.example/signin/password";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin/password";
    fake.state.present = new Set(["password", "login"]);
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.openTabs = [1];
  });
  /** The tab's top page announces on `path`, showing no step that starts a login. */
  async function show(h: ReturnType<typeof harness>, documentId: string, path: string) {
    fake.state.tabUrls[1] = `${origin}${path}`;
    await h.hello({ documentId, url: `${origin}${path}` }, false);
  }
  /** The person's sign-in step on `from`, then the password page that asks. */
  async function arrive(
    h: ReturnType<typeof harness>,
    documentId = "password-page",
    from = "/signin",
  ) {
    await show(h, `before-${documentId}`, from);
    await show(h, documentId, "/signin/password");
  }
  const ask = (
    h: ReturnType<typeof harness>,
    change: Partial<{ documentId: string; path: string; namesCredentials: boolean }> = {},
  ) => {
    let decided: ConditionalDecision | undefined;
    let at: number | undefined;
    const decision = h.login
      .conditionalRequest({
        tabId: 1,
        origin,
        documentId: "password-page",
        signal: new AbortController().signal,
        incognito: false,
        path: "/signin/password",
        namesCredentials: true,
        ...change,
      })
      .then((value) => {
        at = Date.now();
        decided = value;
        return value;
      });
    return { decision, decided: () => decided, at: () => at, since: Date.now() };
  };
  async function decide(request: ReturnType<typeof ask>) {
    for (let spent = 0; request.decided() === undefined; spent += 100) {
      if (spent > 10_000) throw new Error("Not decided in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
    return request.decided();
  }
  const handedOn = { kind: "delegate", reason: "no-login", named: true };

  it("is answered as soon as its page, after the sign-in step, announced", async () => {
    const h = harness();
    // Asked before its page announced, as on load: it waits for the announcement.
    const request = ask(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(request.decided()).toBeUndefined();
    await arrive(h);
    expect(await decide(request)).toMatchObject({ kind: "named" });
    // Not after the wait for a login, which is only its bound (ADR 0082).
    expect(request.at()! - request.since).toBeLessThan(1_000);
    // Asked after its page announced, it is answered at once too.
    await arrive(h, "next-page");
    const next = ask(h, { documentId: "next-page" });
    expect(await decide(next)).toMatchObject({ kind: "named" });
    expect(next.at()! - next.since).toBeLessThan(1_000);
  });

  it("follows a later step a login may start at, or a sign-in entry, as a start", async () => {
    const entry = {
      version: 1 as const,
      id: "synthetic-entry",
      revision: 1,
      origin,
      entry: { path: "/welcome", target: target("sign-in") },
    };
    const h = harness({}, { entries: [entry] });
    h.recipes.starts.mockResolvedValue([
      { path: "/signin", steps: [recipe.steps[0]!], later: [{ path: "/signin/next" }] } as never,
    ]);
    await arrive(h, "after-entry", "/welcome");
    expect(await decide(ask(h, { documentId: "after-entry" }))).toMatchObject({ kind: "named" });
    await arrive(h, "after-later", "/signin/next");
    expect(await decide(ask(h, { documentId: "after-later" }))).toMatchObject({ kind: "named" });
  });

  it("is handed on when its page follows no sign-in step, as on load", async () => {
    const h = harness();
    // The tab's first page: no page before it.
    await show(h, "password-page", "/signin/password");
    const loaded = ask(h);
    expect(await decide(loaded)).toEqual(handedOn);
    expect(loaded.at()! - loaded.since).toBeLessThan(1_000);
    // After a page that is no sign-in step.
    await show(h, "help", "/help");
    await show(h, "after-help", "/signin/password");
    expect(await decide(ask(h, { documentId: "after-help" }))).toEqual(handedOn);
    // A page that never announces is handed on at the bound.
    const silent = ask(h, { documentId: "silent" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(silent.decided()).toBeUndefined();
    expect(await decide(silent)).toEqual(handedOn);
  });

  it("is handed on at once on an origin without a recipe, unless a sign-in form was submitted", async () => {
    const h = harness();
    h.recipes.starts.mockResolvedValue([]);
    await arrive(h);
    expect(await decide(ask(h))).toEqual({ kind: "delegate", reason: "no-recipe" });
    // The person submitted a sign-in form on the page before.
    await show(h, "form", "/login");
    await h.login.handle(
      { version: 1, type: "login.document.submitted", token: "synthetic-token" },
      {
        id: "synthetic-extension",
        tab: { id: 1 },
        frameId: 0,
        documentId: "form",
        origin,
        url: `${origin}/login`,
      } as never,
    );
    await show(h, "after-submit", "/signin/password");
    expect(await decide(ask(h, { documentId: "after-submit" }))).toMatchObject({ kind: "named" });
  });

  it("is handed on as before when it names none, or a recipe starts on its path", async () => {
    const entry = {
      version: 1 as const,
      id: "synthetic-entry",
      revision: 1,
      origin,
      entry: { path: "/signin/entry", target: target("sign-in") },
    };
    const h = harness({}, { entries: [entry] });
    await arrive(h);
    expect(await decide(ask(h, { namesCredentials: false }))).toEqual({
      kind: "delegate",
      reason: "no-login",
    });
    // The recipe's own start page, a sign-in entry's page (ADR 0031) and a verification
    // recipe's page (ADR 0035) are a recipe's.
    fake.state.tabUrls[1] = "https://login.example/signin";
    expect(await decide(ask(h, { documentId: "start", path: "/signin" }))).toEqual({
      kind: "delegate",
      reason: "no-login",
    });
    fake.state.tabUrls[1] = "https://login.example/signin/entry";
    expect(await decide(ask(h, { documentId: "entry", path: "/signin/entry" }))).toEqual({
      kind: "delegate",
      reason: "no-login",
    });
    fake.state.tabUrls[1] = "https://login.example/signin/password";
    h.recipes.routes.mockResolvedValue([
      parseLoginRecipe({
        ...recipe,
        id: "synthetic-confirm",
        pageKind: "confirm",
        steps: recipe.steps.map((step) => ({ ...step, path: "/signin/password" })),
      }),
    ]);
    expect(await decide(ask(h, { documentId: "confirm" }))).toEqual({
      kind: "delegate",
      reason: "no-login",
    });
    h.recipes.routes.mockResolvedValue([]);
    // The page that tells nothing of its path counts as a recipe's too.
    fake.state.tabUrls[1] = "chrome://newtab/";
    expect(await decide(ask(h, { documentId: "unknown", path: "not-a-path" }))).toEqual({
      kind: "delegate",
      reason: "no-login",
    });
    // The same request on the password page, where no recipe starts, is answered.
    await arrive(h, "password");
    expect(await decide(ask(h, { documentId: "password" }))).toMatchObject({ kind: "named" });
  });

  it("leaves its answer to a login that runs in its tab", async () => {
    const h = harness();
    // A login of the tab's sign-in page runs, waiting for its first step's fill.
    let release!: () => void;
    fake.state.onExecute = () => new Promise<void>((resolve) => (release = resolve));
    fake.state.tabUrls[1] = "https://login.example/signin";
    expect(await h.hello({ documentId: "sign-in", url: "https://login.example/signin" })).toEqual({
      ok: true,
    });
    fake.state.tabUrls[1] = "https://login.example/signin/password";
    // Handed on at the bound, flagged as a request this path decided.
    expect(await decide(ask(h))).toEqual(handedOn);
    // Once no login runs, here stopped by a pause and a resume, the page's next request is
    // answered by its named passkey.
    const paused = setPause(h, true);
    release();
    await paused;
    await setPause(h, false);
    await show(h, "later", "/signin/password");
    expect(await decide(ask(h, { documentId: "later" }))).toMatchObject({ kind: "named" });
  });

  it("is handed on while the site is paused, and answered once it resumes", async () => {
    const h = harness();
    await arrive(h);
    await setPause(h, true);
    expect(await decide(ask(h))).toEqual({ kind: "delegate", reason: "paused" });
    await setPause(h, false);
    await arrive(h, "resumed");
    expect(await decide(ask(h, { documentId: "resumed" }))).toMatchObject({ kind: "named" });
  });

  it("is handed on when a pause starts while it is looked at", async () => {
    const h = harness();
    // The site is paused while the request reads the origin's recipes, before it waits.
    h.recipes.starts.mockImplementationOnce(async () => {
      await setPause(h, true);
      return [{ path: "/signin", steps: [recipe.steps[0]!] }];
    });
    const request = ask(h, { documentId: "unannounced" });
    await vi.advanceTimersByTimeAsync(500);
    expect(request.decided()).toEqual({ kind: "delegate", reason: "paused" });
  });

  it("is checked against the path its page shows before the answer leaves", async () => {
    const h = harness();
    await arrive(h);
    const decision = (await decide(ask(h))) as Extract<ConditionalDecision, { kind: "named" }>;
    expect(await decision.stillOnPath?.()).toBe(true);
    fake.state.tabUrls[1] = "https://login.example/account";
    expect(await decision.stillOnPath?.()).toBe(false);
  });

  it("is a re-verification after its own sign-in, until a recipe's first step shows", async () => {
    const h = harness();
    const item = { connectionId: "connection", itemId: "item" };
    h.login.passkeyAnswered(1, origin, "login.example", item, {
      silent: true,
      incognito: false,
      documentId: "password-page",
    });
    // Another page of the tab asking by name is a re-verification; the page it signed in,
    // and a request that names nothing, are not.
    expect(await h.login.passkeyReverification(1, origin, "account", true)).toBe(true);
    expect(await h.login.passkeyReverification(1, origin, "password-page", true)).toBe(false);
    expect(await h.login.passkeyReverification(1, origin, "account")).toBe(false);
    // The sign-in page shows its first step again, as after a logout.
    fake.state.tabUrls[1] = "https://login.example/signin";
    await h.hello({ documentId: "signed-out", url: "https://login.example/signin" });
    expect(await h.login.passkeyReverification(1, origin, "account", true)).toBe(false);
  });
});
