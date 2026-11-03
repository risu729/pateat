import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { harness } = createRuntimeTestHarness(fake);

describe("when a login's time starts again (ADR 0019)", () => {
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
  it("starts the time again when the page moves in place to its sign-in", async () => {
    // A single-page site: its home page is seen first, and the person moves to its
    // sign-in page in the same document a minute later (owner 2026-11-03).
    const signInUrl = fake.state.pageUrl;
    fake.state.pageUrl = "https://login.example/home";
    const h = harness();
    await h.hello({ url: fake.state.pageUrl }, false);
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => void vi.useRealTimers());
    const moved = Date.now() + 60_000;
    vi.setSystemTime(moved);
    fake.state.pageUrl = signInUrl;
    expect(await h.hello({ url: signInUrl })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated" },
      ]),
    );
    expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
      { timing: { since: moved } },
    ]);
  });
  it("starts the time again when the document shows its form again after a login", async () => {
    // A single-page site signs out in place an hour after its login, and shows its form
    // again in the same document (owner 2026-11-03).
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated" },
      ]),
    );
    const [first] = fake.state.storage["pateat.login-attempts.v5"] as { id: string }[];
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => void vi.useRealTimers());
    const shownAgain = Date.now() + 3_600_000;
    vi.setSystemTime(shownAgain);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated", timing: { since: shownAgain } },
      ]),
    );
    const [second] = fake.state.storage["pateat.login-attempts.v5"] as { id: string }[];
    expect(second!.id).not.toBe(first!.id);
  });
  it("starts the time again for a form shown after a login and moves in place", async () => {
    // A single-page site moves to its home page after the login, back to its sign-in
    // page later, and only then shows its form again (owner 2026-11-03).
    const signInUrl = fake.state.pageUrl;
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated" },
      ]),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => void vi.useRealTimers());
    fake.state.pageUrl = "https://login.example/home";
    await h.hello({ url: fake.state.pageUrl }, false);
    const back = Date.now() + 60_000;
    vi.setSystemTime(back);
    fake.state.pageUrl = signInUrl;
    await h.hello({ url: signInUrl }, false);
    const shownAgain = back + 3_600_000;
    vi.setSystemTime(shownAgain);
    expect(await h.hello({ url: signInUrl })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated", timing: { since: shownAgain } },
      ]),
    );
  });
  it("keeps the time of a page that shows its form later on the same path", async () => {
    const h = harness();
    const seen = Date.now();
    await h.hello({}, false);
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime(seen + 2_000);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated" },
      ]),
    );
    const [record] = fake.state.storage["pateat.login-attempts.v5"] as {
      timing: { since: number };
    }[];
    expect(record!.timing.since).toBeLessThan(seen + 2_000);
  });
});
