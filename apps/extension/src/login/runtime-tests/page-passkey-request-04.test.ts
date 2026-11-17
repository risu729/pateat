import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, recipe, harness, setPause } = createRuntimeTestHarness(fake);

// A conditional request that names its credentials on a path where no recipe starts, as
// Money Forward's password page asks for the typed address's passkeys (#1673): answered by
// the passkey it names once no login of the tab answers it (ADR 0034 amendment of
// 2026-11-17).
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
  const ask = (
    h: ReturnType<typeof harness>,
    change: Partial<{ documentId: string; path: string; namesCredentials: boolean }> = {},
  ) => {
    let decided: ConditionalDecision | undefined;
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
      .then((value) => (decided = value));
    return { decision, decided: () => decided };
  };
  async function decide(request: ReturnType<typeof ask>) {
    for (let spent = 0; request.decided() === undefined; spent += 100) {
      if (spent > 10_000) throw new Error("Not decided in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
    return request.decided();
  }

  it("is answered by its named passkey once no login of its document starts", async () => {
    const h = harness();
    const request = ask(h);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(request.decided()).toBeUndefined();
    expect(await decide(request)).toMatchObject({ kind: "named" });
    // On an origin without any recipe it is too, after the same wait.
    const elsewhere = ask(h, { documentId: "elsewhere" });
    fake.state.tabUrls[1] = "https://login.example/signin/password";
    h.recipes.starts.mockResolvedValue([]);
    expect(await decide(elsewhere)).toMatchObject({ kind: "named" });
  });

  it("is handed on as before when it names none, or a recipe starts on its path", async () => {
    const h = harness();
    expect(await decide(ask(h, { namesCredentials: false }))).toEqual({
      kind: "delegate",
      reason: "no-login",
    });
    // The recipe's own start page, a verification recipe's page (ADR 0035) and a sign-in
    // entry's page (ADR 0031) are a recipe's.
    fake.state.tabUrls[1] = "https://login.example/signin";
    expect(await decide(ask(h, { documentId: "start", path: "/signin" }))).toEqual({
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
    fake.state.tabUrls[1] = "https://login.example/signin/password";
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
    expect(await decide(ask(h))).toEqual({ kind: "delegate", reason: "no-login" });
    // Once no login runs, here stopped by a pause and a resume, the page's next request is
    // answered by its named passkey.
    const paused = setPause(h, true);
    release();
    await paused;
    await setPause(h, false);
    expect(await decide(ask(h, { documentId: "later" }))).toMatchObject({ kind: "named" });
  });

  it("is handed on while the site is paused, and answered once it resumes", async () => {
    const h = harness();
    await setPause(h, true);
    expect(await decide(ask(h))).toEqual({ kind: "delegate", reason: "paused" });
    await setPause(h, false);
    expect(await decide(ask(h, { documentId: "resumed" }))).toMatchObject({ kind: "named" });
  });

  it("is checked against the path its page shows before the answer leaves", async () => {
    const h = harness();
    fake.state.tabUrls[1] = "https://login.example/signin/password";
    const decision = (await decide(ask(h))) as Extract<ConditionalDecision, { kind: "named" }>;
    expect(await decision.stillOnPath?.()).toBe(true);
    fake.state.tabUrls[1] = "https://login.example/account";
    expect(await decision.stillOnPath?.()).toBe(false);
  });
});
