import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, uriMatch, harness } = createRuntimeTestHarness(fake);

// A login in a frame whose page is replaced (ADR 0086), when the tab's pages announce more
// than once, go away before they are read, or are judged, and when the frame is read after
// its step as the tab's page is.
describe("a login in a frame, read on its own frame and its tab's pages (ADR 0086)", () => {
  const portal = "https://portal.example";
  const page = `${portal}/account`;
  const home = `${portal}/home`;
  type Stored = { state: string; outcome?: string; account: { origin: string }; watch?: object };
  const stored = () => (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Stored[];
  const record = () => stored().find((entry) => entry.account.origin === origin);
  const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  const signedIn = { ...quiet, username: true };
  /** Holds the item match of the tab's new page while set, as a slow vault. */
  let held: Promise<unknown> | undefined;
  const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => {
    if (held && new URL(url).pathname === "/home") await held;
    return { ok: true, data: uriMatch({ targetOrigin: new URL(url).origin }) };
  });
  const holdClicks = () => {
    fake.state.onExecute = (message) =>
      (message["operation"] as { step: { kind: string } }).step.kind === "click"
        ? new Promise(() => undefined)
        : Promise.resolve();
  };
  function generation(judge: LoginGeneration["judge"]) {
    const abstained = async () => ({ outcome: "abstained", reason: "ambiguous" }) as const;
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(abstained),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(abstained),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  /** The tab's page announces, then its frame logs in. */
  const framed = async (
    options: { reports?: LoginReport[]; generation?: ReturnType<typeof generation> } = {},
  ) => {
    const h = harness(
      { siteDefaults: [] },
      {
        allowedOrigins: [],
        uris,
        username: true,
        ...(options.generation ? { generation: options.generation } : {}),
        ...(options.reports
          ? { report: (entry: LoginReport) => options.reports?.push(entry) }
          : {}),
      },
    );
    fake.state.tabUrls[1] = page;
    await h.hello({ documentId: "page-one", url: page }, false);
    expect(
      await h.hello({ frameId: 3, documentId: "frame-one", tab: { id: 1, url: page } }),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(2));
    return h;
  };
  /** The tab shows a new page in place of the frame's page. */
  const replaced = (h: ReturnType<typeof harness>, documentId = "page-two", url = home) => {
    fake.state.gone.add("frame-one");
    fake.state.goneFrames.add(3);
    fake.state.tabUrls[1] = url;
    return h.hello({ documentId, url }, false);
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
    held = undefined;
    uris.mockClear();
  });

  it("reads the new page when it announces again while its first hello is checked", async () => {
    holdClicks();
    const h = await framed();
    fake.state.signs = signedIn;
    const gate = Promise.withResolvers<void>();
    held = gate.promise;
    const first = replaced(h);
    await vi.waitFor(() => expect(uris.mock.calls.map((call) => call[1])).toContain(home));
    held = undefined;
    // The page announces again, as when its form appears, before the first check ends.
    const again = h.hello({ documentId: "page-two", url: home }, false);
    gate.resolve();
    await Promise.all([first, again]);
    await vi.waitFor(() =>
      expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" }),
    );
    expect(executes()).toHaveLength(2);
  });

  it("leaves the login to the tab's next page when the new page went away unread", async () => {
    holdClicks();
    const reports: LoginReport[] = [];
    const h = await framed({ reports });
    fake.state.signs = signedIn;
    // The new page is gone before it could be read.
    fake.state.gone.add("page-two");
    await replaced(h);
    expect(record()).toMatchObject({ state: "submit-intent" });
    expect(reports).toContainEqual(expect.objectContaining({ type: "move", reason: "page-gone" }));
    await replaced(h, "page-three", `${portal}/home?welcome`);
    expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" });
  });

  it("completes on the new page the judge reads as signed in", async () => {
    holdClicks();
    const service = generation(async () => ({ verdict: "signed-in" }));
    const h = await framed({ generation: service });
    fake.state.signs = quiet;
    fake.state.extracted = {
      "signed-in": {
        ok: true,
        observation: {
          version: 1,
          origin: portal,
          path: "/home",
          language: "en",
          complete: true,
          candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
        },
      },
    };
    await replaced(h);
    await vi.waitFor(() =>
      expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" }),
    );
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(executes()).toHaveLength(2);
  });

  it("counts a frame that does not answer within a second as still there", async () => {
    holdClicks();
    const h = await framed();
    fake.state.signs = signedIn;
    fake.state.gone.add("frame-one");
    fake.state.onPresent = () => new Promise(() => undefined);
    fake.state.tabUrls[1] = home;
    await h.login.tabLoaded({ id: 1, url: home } as never);
    expect(fake.state.reconnects).toEqual([]);
    expect(record()).toMatchObject({ state: "submit-intent" });
  });

  it("completes a watched login on the tab's new page after a worker restart", async () => {
    // The site asks for a code the person enters: the login settles and is watched.
    fake.state.onExecute = (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
        fake.state.observed = ["missing", "missing"];
      return Promise.resolve();
    };
    fake.state.signs = { ...quiet, code: true };
    await framed();
    await vi.waitFor(() => expect(record()).toMatchObject({ watch: {} }), { timeout: 8_000 });
    // The worker restarts: a new runtime reads the stored login and knows no document. The
    // tab is still open.
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => [{ id: 1 }] as never;
    onTestFinished(() => {
      fake.browser.tabs.query = query;
    });
    const restarted = harness({ siteDefaults: [] }, { allowedOrigins: [], uris, username: true });
    fake.state.signs = signedIn;
    await replaced(restarted);
    await vi.waitFor(() =>
      expect(record()).toMatchObject({ state: "authenticated", outcome: "authenticated" }),
    );
  }, 15_000);

  const presences = () =>
    fake.state.messages.filter((entry) => entry.type === "login.frame.present");

  it("never asks the frame while the tab's page announces again around it", async () => {
    holdClicks();
    const h = await framed();
    expect(await h.hello({ documentId: "page-one", url: page }, false)).toMatchObject({
      ok: false,
    });
    expect(presences()).toEqual([]);
    expect(record()).toMatchObject({ state: "submit-intent" });
  });

  it.each([
    ["shows a document", undefined],
    // The frame's document went away before it answered, as one swapped for its next.
    ["is between its documents", () => Promise.reject(new Error("The message port closed."))],
  ])(
    "keeps a watched login after a worker restart when its frame %s",
    async (_label, onPresent) => {
      fake.state.onExecute = (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind === "click")
          fake.state.observed = ["missing", "missing"];
        return Promise.resolve();
      };
      fake.state.signs = { ...quiet, code: true };
      await framed();
      await vi.waitFor(() => expect(record()).toMatchObject({ watch: {} }), { timeout: 8_000 });
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      onTestFinished(() => {
        fake.browser.tabs.query = query;
      });
      const restarted = harness({ siteDefaults: [] }, { allowedOrigins: [], uris, username: true });
      fake.state.onPresent = onPresent;
      fake.state.signs = signedIn;
      // The same page announces again; its frame has not yet.
      await restarted.hello({ documentId: "page-one", url: page }, false);
      expect(presences()).toHaveLength(1);
      expect(record()).toMatchObject({ state: "reconciling", watch: {} });
      // Only the restart's own announcement request reached the tab.
      expect(fake.state.reconnects).toEqual([{ tabId: 1 }]);
    },
    15_000,
  );

  it("rejects the sign-in form shown again in the frame's next document", async () => {
    // The site answers the submission with its sign-in page, in the frame's next document.
    fake.state.signs = (message) =>
      message["fields"] ? { ...quiet, password: true, invalid: true } : quiet;
    const h = harness({ siteDefaults: [] }, { allowedOrigins: [], uris, username: true });
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
      fake.state.gone.add("frame-one");
      setTimeout(
        () =>
          void h.hello({ frameId: 3, documentId: "frame-two", tab: { id: 1, url: page } }, false),
        0,
      );
    };
    // The sign-in form shows in both of the frame's documents.
    fake.state.present = new Set(["user", "password", "login"]);
    fake.state.tabUrls[1] = page;
    await h.hello({ documentId: "page-one", url: page }, false);
    await h.hello({ frameId: 3, documentId: "frame-one", tab: { id: 1, url: page } });
    await vi.waitFor(
      () => expect(record()).toMatchObject({ state: "blocked", outcome: "credential-rejected" }),
      { timeout: 8_000 },
    );
    // The fields' marks were read in the frame's next document.
    expect(fake.state.messages).toContainEqual(
      expect.objectContaining({ type: "login.state", fields: expect.any(Array) }),
    );
    expect(executes()).toHaveLength(2);
  }, 10_000);
});
