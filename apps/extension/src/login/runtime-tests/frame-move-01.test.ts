import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, itemId, uriMatch, harness } = createRuntimeTestHarness(fake);

// A sign-in form inside a frame of another site's page, as `idmsa.apple.com` inside
// `account.apple.com/sign-in` (#1378): after the sign-in, the frame hands its result to its
// page, which shows another page in the tab (ADR 0086).
describe("a login in a frame whose page is replaced (ADR 0086)", () => {
  const portal = "https://portal.example";
  const page = `${portal}/account`;
  const home = `${portal}/home`;
  type Stored = { state: string; outcome?: string; account: { origin: string }; watch?: object };
  const stored = () => (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Stored[];
  const record = () => stored().find((entry) => entry.account.origin === origin);
  const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const reads = () => fake.state.messages.filter((entry) => entry.type === "login.state");
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  const signedIn = { ...quiet, username: true };
  // Every URL matches the item but those of `evil.example`.
  const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
    ok: true,
    data: uriMatch({
      targetOrigin: new URL(url).origin,
      ...(new URL(url).hostname === "evil.example" ? { candidates: [] } : {}),
    }),
  }));
  /** The site answers the click with a page that proves nothing, as a code page. */
  const answerUnproven = () => {
    fake.state.onExecute = (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
        fake.state.observed = ["missing", "missing"];
      return Promise.resolve();
    };
  };
  const holdClicks = () => {
    fake.state.onExecute = (message) =>
      (message["operation"] as { step: { kind: string } }).step.kind === "click"
        ? new Promise(() => undefined)
        : Promise.resolve();
  };
  /** The tab's page announces, then its frame logs in. */
  const framed = async (reports?: LoginReport[]) => {
    const h = harness(
      { siteDefaults: [] },
      {
        allowedOrigins: [],
        uris,
        username: true,
        ...(reports ? { report: (entry: LoginReport) => reports.push(entry) } : {}),
      },
    );
    fake.state.tabUrls[1] = page;
    expect(await h.hello({ documentId: "page-one", url: page }, false)).toMatchObject({
      ok: false,
    });
    expect(
      await h.hello({ frameId: 3, documentId: "frame-one", tab: { id: 1, url: page } }),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(2));
    return h;
  };
  /** The tab shows a new page in place of the frame's page. */
  const replaced = (h: ReturnType<typeof harness>, url = home) => {
    fake.state.gone.add("frame-one");
    fake.state.tabUrls[1] = url;
    return h.hello({ documentId: "page-two", url }, false);
  };

  afterEach(() => {
    for (const listener of fake.state.removed.splice(0)) listener(1);
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
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.awaited = { ok: true };
    fake.state.gone = new Set();
    fake.state.goneFrames = new Set();
    fake.state.onPresent = undefined;
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    uris.mockClear();
  });

  it("completes on the new page that shows the account's username, and saves the choice", async () => {
    holdClicks();
    const h = await framed();
    fake.state.signs = signedIn;
    await replaced(h);
    expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(uris.mock.calls.map((call) => call[1])).toContain(home);
    expect(reads()).toHaveLength(2);
    // The choice is saved under the frame's origin, as for any login there (ADR 0017).
    await vi.waitFor(() =>
      expect(h.settings.settings.siteDefaults).toMatchObject([{ origin, itemId }]),
    );
    expect(executes()).toHaveLength(2);
  });

  it("completes on a quiet new page right after the password, without the username", async () => {
    holdClicks();
    const h = await framed();
    fake.state.signs = quiet;
    await replaced(h);
    expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(reads()).toHaveLength(2);
    expect(reads()[0]).not.toHaveProperty("account");
  });

  it("ends cancelled, as before, when the new page shows a password field", async () => {
    holdClicks();
    const h = await framed();
    fake.state.signs = { ...quiet, password: true };
    await replaced(h);
    expect(record()).toMatchObject({ state: "blocked", outcome: "cancelled" });
  });

  it("never reads a new page whose URL the item does not match", async () => {
    holdClicks();
    const reports: LoginReport[] = [];
    const h = await framed(reports);
    fake.state.signs = signedIn;
    await replaced(h, "https://evil.example/home");
    expect(record()).toMatchObject({ state: "blocked", outcome: "cancelled" });
    expect(reads()).toEqual([]);
    expect(reports).toContainEqual(
      expect.objectContaining({ type: "move", reason: "no-vault-match" }),
    );
  });

  it("never reads a new page more than 30 seconds after the step", async () => {
    holdClicks();
    const h = await framed();
    fake.state.signs = signedIn;
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
    onTestFinished(() => clock.mockRestore());
    await replaced(h);
    expect(record()).toMatchObject({ state: "blocked", outcome: "cancelled" });
    expect(reads()).toEqual([]);
  });

  it("completes during the watch of a page left to the person, as a code page", async () => {
    // The site asks for a code the person enters: the login settles and is watched.
    answerUnproven();
    fake.state.signs = { ...quiet, code: true };
    const h = await framed();
    await vi.waitFor(() => expect(record()).toMatchObject({ watch: {} }), { timeout: 8_000 });
    fake.state.signs = signedIn;
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 60_000);
    onTestFinished(() => clock.mockRestore());
    await replaced(h);
    expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" });
  }, 15_000);

  it("ends a watched login where it stopped when the new page proves nothing", async () => {
    answerUnproven();
    fake.state.signs = { ...quiet, code: true };
    const h = await framed();
    await vi.waitFor(() => expect(record()).toMatchObject({ watch: {} }), { timeout: 8_000 });
    fake.state.signs = quiet;
    // Past the password's 30 seconds, the watch reads the page for the username alone.
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 60_000);
    onTestFinished(() => clock.mockRestore());
    await replaced(h);
    expect(record()).toMatchObject({ state: "blocked", outcome: "unknown-submit" });
  }, 15_000);

  describe("when the page changes its URL in place, as a single-page site does", () => {
    it("reads the page once the frame is gone", async () => {
      holdClicks();
      const h = await framed();
      fake.state.signs = signedIn;
      fake.state.gone.add("frame-one");
      fake.state.goneFrames.add(3);
      fake.state.tabUrls[1] = home;
      fake.state.onReconnect = () => h.hello({ documentId: "page-one", url: home }, false);
      await h.login.tabLoaded({ id: 1, url: home } as never);
      await vi.waitFor(() =>
        expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" }),
      );
      expect(fake.state.reconnects).toEqual([{ tabId: 1, frameId: 0, documentId: "page-one" }]);
    });

    it("leaves a login whose frame still shows a document, also its next one", async () => {
      holdClicks();
      const h = await framed();
      fake.state.signs = signedIn;
      // The frame moved to its next document, which has not announced yet.
      fake.state.gone.add("frame-one");
      fake.state.tabUrls[1] = home;
      await h.login.tabLoaded({ id: 1, url: home } as never);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fake.state.reconnects).toEqual([]);
      expect(record()).toMatchObject({ state: "submit-intent" });
    });

    it("never takes a later announcement of the page for the move", async () => {
      holdClicks();
      const h = await framed();
      fake.state.signs = signedIn;
      // The page announces again without its frame having gone.
      fake.state.tabUrls[1] = home;
      expect(await h.hello({ documentId: "page-one", url: home }, false)).toMatchObject({
        ok: false,
      });
      expect(record()).toMatchObject({ state: "submit-intent" });
      expect(reads()).toEqual([]);
    });
  });
});
