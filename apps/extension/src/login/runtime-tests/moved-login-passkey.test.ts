import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, harness } = createRuntimeTestHarness(fake);

// ADR 0036 amendment of 2026-11-17 (owner's option D): a passkey request on the page a
// running login's tab moved to, soon after the login's last step, is that login's.
describe("the passkey request of a page a login moved to", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0)) listener(1);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
  });
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "synthetic-email-first",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
      {
        kind: "fill",
        path: "/password",
        fields: [{ slot: "password", target: target("password") }],
      },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  async function until(check: () => boolean, maxMs = 60_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  /** A login whose Next moved its tab away: the click never answers. */
  const moved = async () => {
    vi.useFakeTimers();
    const h = harness({}, { username: true, report: vi.fn() });
    h.recipes.recipe.mockResolvedValue(emailFirst);
    fake.state.onExecute = (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      return step.kind === "click" ? new Promise(() => undefined) : Promise.resolve();
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    fake.state.signs = {
      password: false,
      code: false,
      captcha: false,
      invalid: false,
      alert: false,
    };
    return h;
  };
  const item = { connectionId, itemId };

  it("is the login's on another origin of its site", async () => {
    const h = await moved();
    const auth = "https://auth.login.example";
    h.login.passkeyRequested(1, auth);
    expect(await h.login.movedLogin(1, auth, "auth-document")).toEqual({
      ...item,
      origin,
      sameSite: true,
    });
    // A login of the page's own origin is found as a running login instead, even when that
    // origin asked too.
    h.login.passkeyRequested(1, origin);
    expect(await h.login.movedLogin(1, origin, "auth-document")).toBeUndefined();
  });

  it("names a page of another site as such, for the RP's list to decide (ADR 0084)", async () => {
    const h = await moved();
    const auth = "https://auth.elsewhere.example";
    h.login.passkeyRequested(1, auth);
    expect(await h.login.movedLogin(1, auth, "auth-document")).toEqual({
      ...item,
      origin,
      sameSite: false,
    });
  });

  it("is no longer the login's more than 30 seconds after its last step", async () => {
    const h = await moved();
    const auth = "https://auth.login.example";
    await vi.advanceTimersByTimeAsync(31_000);
    h.login.passkeyRequested(1, auth);
    expect(await h.login.movedLogin(1, auth, "auth-document")).toBeUndefined();
  });

  it("is the login's when the page announced itself first, while the move is still checked", async () => {
    const h = await moved();
    const auth = "https://auth.login.example";
    fake.state.tabUrls[1] = `${auth}/passkey`;
    let result: unknown;
    void h
      .hello({ documentId: "auth-document", url: `${auth}/passkey` }, false)
      .then((value) => (result = value));
    // The page asks as it loads, a second after its announcement, before the login's check
    // of the move (a few seconds) ends it.
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBeUndefined();
    expect(status()![0]).toMatchObject({ state: "submit-intent" });
    h.login.passkeyRequested(1, auth);
    expect(await h.login.movedLogin(1, auth, "auth-document")).toEqual({
      ...item,
      origin,
      sameSite: true,
    });
    // The page then holds the login while its request is answered, so the login neither
    // ends nor starts again there.
    await until(() => result !== undefined);
    expect(result).toEqual({ ok: false, reason: "stale-document" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(status()![0]).toMatchObject({ state: "submit-intent" });
  });

  it("completes on the next quiet page after its item answered there", async () => {
    const h = await moved();
    const auth = "https://auth.login.example";
    h.login.passkeyRequested(1, auth);
    expect(await h.login.movedLogin(1, auth, "auth-document")).toMatchObject(item);
    const visit = async (url: string, documentId: string) => {
      fake.state.tabUrls[1] = url;
      let result: unknown;
      void h.hello({ documentId, url }, false).then((value) => (result = value));
      await until(() => result !== undefined);
      return result;
    };
    expect(await visit(`${auth}/passkey`, "auth-document")).toEqual({
      ok: false,
      reason: "stale-document",
    });
    h.login.passkeyAnswered(1, auth, "login.example", item);
    await visit(`${origin}/callback`, "callback-document");
    await until(() => status()![0]!["state"] === "authenticated");
    expect(status()![0]).toMatchObject({ state: "authenticated", outcome: "authenticated" });
  });

  it("is not a login's that ended on the page before the request", async () => {
    const h = await moved();
    const auth = "https://auth.elsewhere.example";
    fake.state.tabUrls[1] = `${auth}/welcome`;
    let result: unknown;
    void h
      .hello({ documentId: "auth-document", url: `${auth}/welcome` }, false)
      .then((value) => (result = value));
    await until(() => result !== undefined);
    expect(status()![0]).toMatchObject({ state: "blocked", outcome: "left-origin" });
    h.login.passkeyRequested(1, auth);
    expect(await h.login.movedLogin(1, auth, "auth-document")).toBeUndefined();
  });
});
