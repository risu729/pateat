import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, itemId, otherItemId, connectionId, uriMatch, harness } =
  createRuntimeTestHarness(fake);

// The popup and a login that waits in a frame of the tab's page, as the sign-in form
// `idmsa.apple.com` embeds in `account.apple.com/sign-in` (ADR 0086, delivery 2).
describe("the popup for a login in a frame (ADR 0086)", () => {
  const portal = "https://portal.example";
  const page = `${portal}/account`;
  const popup = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/popup.html",
  } as never;
  const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  const both = [
    { itemId, matches: [{ uriIndex: 0, match: 0 as const }] },
    { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 as const }] },
  ];
  /** Both URLs match the items, unless the tab shows `evil.example`. */
  const uris = (candidates?: typeof both) =>
    vi.fn<LiveUriMatcher>(async (_connection, url) => ({
      ok: true,
      data: uriMatch({
        targetOrigin: new URL(url).origin,
        ...(new URL(url).hostname === "evil.example"
          ? { candidates: [] }
          : candidates
            ? { candidates }
            : {}),
      }),
    }));
  const frame = (top = page) => {
    fake.state.tabUrls[1] = top;
    return { frameId: 3, documentId: "frame-one", tab: { id: 1, url: top } };
  };
  const ask = (h: ReturnType<typeof harness>, type: string) =>
    h.login.handle({ version: 1, type, tabId: 1 }, popup);

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
  });

  it("offers the choice that waits in a frame for the frame's origin, and logs in with the pick", async () => {
    const h = harness({ siteDefaults: [], bindings: [] }, { allowedOrigins: [], uris: uris(both) });
    await h.hello({ documentId: "page-one", url: page }, false);
    expect(await h.hello(frame())).toEqual({ ok: false, reason: "account-ambiguous" });
    expect(await ask(h, "login.choice.get")).toMatchObject({
      ok: true,
      origin,
      documentId: "frame-one",
      frame: true,
      candidates: [
        { connectionId, itemId },
        { connectionId, itemId: otherItemId },
      ],
    });
    fake.state.onReconnect = () => h.hello(frame());
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "frame-one",
          connectionId,
          itemId: otherItemId,
          makeDefault: false,
        },
        popup,
      ),
    ).toEqual({ ok: true });
    // The frame itself announces again and logs in with the pick.
    expect(fake.state.reconnects).toEqual([{ tabId: 1, frameId: 3, documentId: "frame-one" }]);
    await vi.waitFor(() => expect(executes()).toHaveLength(2));
    expect(h.fields.mock.calls[0]![0]).toMatchObject({ account: { itemId: otherItemId } });
  });

  it("says which frame is not logged in to because the tab's page does not match", async () => {
    const h = harness({}, { allowedOrigins: [], uris: uris() });
    const evil = "https://evil.example/";
    fake.state.tabUrls[1] = evil;
    await h.hello({ documentId: "page-one", url: evil }, false);
    expect(await h.hello(frame(evil))).toEqual({ ok: false, reason: "frame-top-mismatch" });
    expect(await ask(h, "login.status.get")).toMatchObject({
      ok: true,
      origin: "https://evil.example",
      mismatchedFrame: { origin },
    });
    expect(executes()).toEqual([]);
  });

  it("names no frame for a page whose frame logs in", async () => {
    fake.state.onExecute = () => new Promise(() => undefined);
    const h = harness({}, { allowedOrigins: [], uris: uris() });
    await h.hello({ documentId: "page-one", url: page }, false);
    expect(await h.hello(frame())).toEqual({ ok: true });
    expect(await ask(h, "login.status.get")).not.toHaveProperty("mismatchedFrame");
  });

  it("asks for an account in the frame after its sign-in form showed again (ADR 0021 D)", async () => {
    // The site answers the submission with its sign-in form, without a mark, in the
    // frame's next document.
    fake.state.signs = (message) =>
      message["fields"] ? { ...quiet, password: true, username: false } : quiet;
    fake.state.present = new Set(["user", "password", "login"]);
    const h = harness({ siteDefaults: [] }, { allowedOrigins: [], uris: uris() });
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
      fake.state.gone.add("frame-one");
      setTimeout(
        () =>
          void h.hello({ frameId: 3, documentId: "frame-two", tab: { id: 1, url: page } }, false),
        0,
      );
    };
    await h.hello({ documentId: "page-one", url: page }, false);
    expect(await h.hello(frame())).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([{ tabId: 1, origin }]),
      { timeout: 8_000 },
    );
    // The frame's document is asked to announce again, not the tab's page.
    expect(fake.state.reconnects).toContainEqual({
      tabId: 1,
      frameId: 3,
      documentId: "frame-two",
    });
    expect(
      await h.hello({ frameId: 3, documentId: "frame-two", tab: { id: 1, url: page } }),
    ).toEqual({ ok: false, reason: "account-asked" });
    expect(await ask(h, "login.choice.get")).toMatchObject({
      ok: true,
      origin,
      documentId: "frame-two",
      ask: "rejected",
      frame: true,
    });
    expect(executes()).toHaveLength(2);
  }, 12_000);
});
