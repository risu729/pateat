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
// the passkey it names right after the person's own sign-in step in the tab, when no login
// of the tab answers it (ADR 0034 amendment of 2026-11-17).
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
  type Harness = ReturnType<typeof harness>;
  const page = (documentId: string, path: string, frameId = 0) =>
    ({
      id: "synthetic-extension",
      tab: { id: 1 },
      frameId,
      documentId,
      origin,
      url: `${origin}${path}`,
    }) as never;
  /** The tab's top page announces on `path`, showing no step that starts a login. */
  async function show(h: Harness, documentId: string, path: string) {
    fake.state.tabUrls[1] = `${origin}${path}`;
    await h.hello({ documentId, url: `${origin}${path}` }, false);
  }
  /** The person sends a sign-in form of the page, as the content script reports it. */
  const step = (h: Harness, documentId: string, path: string, frameId = 0) =>
    h.login.handle(
      { version: 1, type: "login.document.person-step", token: "synthetic-token", path },
      page(documentId, path, frameId),
    );
  /** The person's step on the email page, then the password page that asks. */
  async function arrive(h: Harness, documentId = "password-page", from = "/signin") {
    await show(h, `before-${documentId}`, from);
    await step(h, `before-${documentId}`, from);
    await show(h, documentId, "/signin/password");
  }
  const ask = (
    h: Harness,
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
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it("answers Money Forward's flow: the person sends the email, the password page asks", async () => {
    const h = harness();
    await show(h, "email", "/signin");
    await step(h, "email", "/signin");
    // Asked on load, before its page announced: it waits for the announcement only.
    const request = ask(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(request.decided()).toBeUndefined();
    await show(h, "password-page", "/signin/password");
    expect(await decide(request)).toMatchObject({ kind: "named" });
    expect(request.at()! - request.since).toBeLessThan(1_000);
    // The step is used up: the page's next request is handed on.
    expect(await decide(ask(h))).toEqual(handedOn);
  });

  it("is answered in the step's own page once it moved to another path", async () => {
    const h = harness();
    await show(h, "single-page", "/signin");
    await step(h, "single-page", "/signin");
    await show(h, "single-page", "/signin/password");
    expect(await decide(ask(h, { documentId: "single-page" }))).toMatchObject({ kind: "named" });
  });

  it("hands the reviewer's probes on: no step of the person, or one long ago", async () => {
    const h = harness();
    // The home page and then, a day later, a re-authentication page.
    await show(h, "home", "/");
    later(24 * 60 * 60 * 1000);
    await show(h, "reauth", "/settings/reauth");
    expect(await decide(ask(h, { documentId: "reauth", path: "/settings/reauth" }))).toEqual(
      handedOn,
    );
    // The sign-in page seen with no action, then the password page.
    await show(h, "seen", "/signin");
    await show(h, "after-seen", "/signin/password");
    expect(await decide(ask(h, { documentId: "after-seen" }))).toEqual(handedOn);
    // A password sent, then the page moving in place hours later.
    await show(h, "app", "/signin");
    await step(h, "app", "/signin");
    later(3 * 60 * 60 * 1000);
    await show(h, "app", "/settings/confirm");
    expect(await decide(ask(h, { documentId: "app", path: "/settings/confirm" }))).toEqual(
      handedOn,
    );
  });

  it("counts no submit the person did not make, nor a frame's", async () => {
    const h = harness();
    // A submit by anyone, as a script's, is reported only as submitted.
    await show(h, "scripted", "/signin");
    await h.login.handle(
      { version: 1, type: "login.document.submitted", token: "synthetic-token" },
      page("scripted", "/signin"),
    );
    await show(h, "after-script", "/signin/password");
    expect(await decide(ask(h, { documentId: "after-script" }))).toEqual(handedOn);
    // A frame's form, as a payment provider's.
    await show(h, "with-frame", "/signin");
    await step(h, "frame", "/pay", 3);
    await show(h, "after-frame", "/signin/password");
    expect(await decide(ask(h, { documentId: "after-frame" }))).toEqual(handedOn);
  });

  it("follows a step only into the next page of its origin, within a minute", async () => {
    const h = harness();
    await show(h, "email", "/signin");
    await step(h, "email", "/signin");
    await show(h, "next", "/signin/password");
    // Not a page after the next.
    await show(h, "after-next", "/signin/password");
    expect(await decide(ask(h, { documentId: "after-next" }))).toEqual(handedOn);
    // Nor the next page a minute after the step.
    await show(h, "late-email", "/signin");
    await step(h, "late-email", "/signin");
    later(60_000);
    await show(h, "late", "/signin/password");
    expect(await decide(ask(h, { documentId: "late" }))).toEqual(handedOn);
  });

  it("is handed on at once on an origin without a recipe, unless the person stepped", async () => {
    const h = harness();
    h.recipes.starts.mockResolvedValue([]);
    await show(h, "no-step", "/signin/password");
    expect(await decide(ask(h, { documentId: "no-step" }))).toEqual({
      kind: "delegate",
      reason: "no-recipe",
    });
    await arrive(h, "after-step", "/login");
    expect(await decide(ask(h, { documentId: "after-step" }))).toMatchObject({ kind: "named" });
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
    h.recipes.starts.mockResolvedValue([
      { path: "/signin", steps: [recipe.steps[0]!], later: [{ path: "/signin/next" }] } as never,
    ]);
    const onPath = async (documentId: string, path: string) => {
      await arrive(h, documentId);
      fake.state.tabUrls[1] = `${origin}${path}`;
      return decide(ask(h, { documentId, path }));
    };
    const before = { kind: "delegate", reason: "no-login" };
    await arrive(h);
    expect(await decide(ask(h, { namesCredentials: false }))).toEqual(before);
    // The recipe's start, a later step, a sign-in entry (ADR 0031) and a verification
    // recipe's page (ADR 0035) are a recipe's.
    expect(await onPath("start", "/signin")).toEqual(before);
    expect(await onPath("later", "/signin/next")).toEqual(before);
    expect(await onPath("entry", "/signin/entry")).toEqual(before);
    h.recipes.routes.mockResolvedValue([
      parseLoginRecipe({
        ...recipe,
        id: "synthetic-confirm",
        pageKind: "confirm",
        steps: recipe.steps.map((each) => ({ ...each, path: "/signin/password" })),
      }),
    ]);
    expect(await onPath("confirm", "/signin/password")).toEqual(before);
    h.recipes.routes.mockResolvedValue([]);
    // The page that tells nothing of its path counts as a recipe's too.
    await arrive(h, "unknown");
    fake.state.tabUrls[1] = "chrome://newtab/";
    expect(await decide(ask(h, { documentId: "unknown", path: "not-a-path" }))).toEqual(before);
    // The same request on the password page, where no recipe starts, is answered.
    await arrive(h, "password");
    expect(await decide(ask(h, { documentId: "password" }))).toMatchObject({ kind: "named" });
  });

  it("leaves its answer to a login that runs in its tab", async () => {
    const h = harness();
    await show(h, "email", "/signin");
    await step(h, "email", "/signin");
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
    // Once no login runs, here stopped by a pause and a resume, the page's next request
    // after the person's step is answered by its named passkey.
    const paused = setPause(h, true);
    release();
    await paused;
    await setPause(h, false);
    await arrive(h, "later");
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
    // A page that shows no first step keeps it.
    await show(h, "account", "/account");
    expect(await h.login.passkeyReverification(1, origin, "settings", true)).toBe(true);
    // The sign-in page shows its first step again, as after a logout.
    fake.state.tabUrls[1] = "https://login.example/signin";
    await h.hello({ documentId: "signed-out", url: "https://login.example/signin" });
    expect(await h.login.passkeyReverification(1, origin, "settings", true)).toBe(false);
  });
});
