// A confirmation's own master password window (ADR 0035 delivery 3): it holds no tab
// while open, and only its answer for the same vault account fills the page.
import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
// The number of windows still to open for another vault account.
const window = vi.hoisted(() => ({ otherAccount: 0 }));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
// A window already open for the document may have been asked for another vault account.
vi.mock(import("../runtime/master-password"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    openPasswordWindow: (...args: Parameters<typeof actual.openPasswordWindow>) => {
      const entry = actual.openPasswordWindow(...args);
      if (window.otherAccount <= 0) return entry;
      window.otherAccount -= 1;
      return { ...entry, connectionId: "another-connection" };
    },
  };
});
vi.stubEnv("MODE", "production");
const { confirmationFixture } = await import("./confirmation-fixture");
const { LOGIN_STEP_WAIT_MS } = await import("../wire");
const { DECLINED_KEPT } = await import("../runtime/confirm-state");
const {
  popup,
  origin,
  shownHello,
  otherItemId,
  connectionId,
  confirmations,
  authenticated,
  configure,
  announce,
  settled,
} = confirmationFixture(fake);
const statuses = () =>
  fake.state.messages
    .filter((entry) => entry.type === "login.status")
    .map((entry) => entry["outcome"]);
/** The document moves in place to `path`, and announces it when asked to. */
const moveTo = (path: string) => {
  fake.state.pageUrl = `${origin}${path}`;
  fake.state.observedPath = path;
};

type Answer = "verified" | "closed" | "unavailable";

async function asking() {
  window.otherAccount = 0;
  const answers: PromiseWithResolvers<Answer>[] = [];
  const ask = vi.fn(async () => {
    const answer = Promise.withResolvers<Answer>();
    answers.push(answer);
    return answer.promise;
  });
  const { h, options, original } = await authenticated({ askMasterPassword: ask });
  // The item asks for its master password from now on, as a re-prompt item would.
  options.reprompt = true;
  h.settings.settings.repromptSites = [{ hostname: "login.example", includeSubdomains: false }];
  configure(h);
  fake.state.onReconnect = () => announce(h);
  expect(await announce(h)).toMatchObject({ reason: "confirm-fill" });
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  return { h, ask, answers, original };
}

describe("a confirmation's master password window", () => {
  it("holds no tab while open, and fills once the vault accepts the password", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    // Other frames, Log in now and an account switch are not refused as busy meanwhile.
    expect(
      await h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
    ).not.toMatchObject({ reason: "login-running" });
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.switch.start",
          tabId: 1,
          connectionId,
          itemId: otherItemId,
          makeDefault: false,
        },
        popup,
      ),
    ).not.toEqual({ ok: false, reason: "in-progress" });
    // Announcing again opens no second window.
    await announce(h);
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(h.fields).not.toHaveBeenCalled();
    answers[0]!.resolve("verified");
    await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it.each(["closed", "unavailable"] as const)(
    "fills nothing when the window is %s",
    async (answer) => {
      const { h, answers, original } = await asking();
      answers[0]!.resolve(answer);
      await settled(h);
      await vi.waitFor(() => expect(h.fields).not.toHaveBeenCalled());
      expect(fake.state.reconnects).toEqual([]);
      expect(confirmations()).toEqual([]);
      expect(original).toHaveLength(1);
    },
  );

  it("asks for its own vault account once a window answered for another one ends", async () => {
    // The window open for the document, as its login's, was asked for another account.
    window.otherAccount = 1;
    const ask = vi.fn(async (): Promise<Answer> => "verified");
    const { h, options } = await authenticated({ askMasterPassword: ask });
    options.reprompt = true;
    h.settings.settings.repromptSites = [{ hostname: "login.example", includeSubdomains: false }];
    configure(h);
    fake.state.onReconnect = () => announce(h);
    await announce(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(fake.state.reconnects).toHaveLength(1);
  });

  it("asks again at the next announcement when the window was unavailable", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    answers[0]!.resolve("unavailable");
    await vi.waitFor(() => expect(statuses()).toContain("confirm-fill-stopped"));
    await announce(h);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    answers[1]!.resolve("verified");
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
  });

  it("leaves the page to the person once the window is closed, until the document moves elsewhere", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    answers[0]!.resolve("closed");
    await vi.waitFor(() => expect(statuses()).toContain("confirm-fill-stopped"));
    // The report of the page's first step, a reconnect and another announcement of the
    // same document and path start no work: nothing can open the window again.
    expect(await shownHello(h, { documentId: "confirmation-document" })).toMatchObject({
      reason: "confirm-fill",
    });
    expect(await announce(h)).toMatchObject({ reason: "confirm-fill" });
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(1);
    // A later visit of the verification, after the document moved on in place, asks again.
    moveTo("/dashboard");
    await announce(h);
    moveTo("/confirm");
    await announce(h);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    await settled(h);
    expect(confirmations()).toEqual([]);
  });

  it("opens no window closed on a page that comes back from the back/forward cache", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    answers[0]!.resolve("closed");
    await vi.waitFor(() => expect(statuses()).toContain("confirm-fill-stopped"));
    moveTo("/home");
    await h.hello({ documentId: "next-document" }, false);
    moveTo("/confirm");
    expect(await announce(h)).toMatchObject({ reason: "confirm-fill" });
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("keeps no accepted password for a later visit once the document announced another path", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    // The person moved on in place before answering: the reconnect announces another path.
    moveTo("/dashboard");
    answers[0]!.resolve("verified");
    await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
    await settled(h);
    expect(confirmations()).toEqual([]);
    // The same document shows the verification again later: its window opens again.
    moveTo("/confirm");
    await announce(h);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    await settled(h);
    expect(confirmations()).toEqual([]);
  });

  it("keeps no accepted password for a document that announced another path before the answer", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    moveTo("/dashboard");
    await announce(h);
    answers[0]!.resolve("verified");
    // Only once the answer was handled can the verification's next visit ask again.
    moveTo("/confirm");
    await vi.waitFor(async () => {
      await announce(h);
      expect(ask).toHaveBeenCalledTimes(2);
    });
    await settled(h);
    expect(fake.state.reconnects).toEqual([]);
    expect(confirmations()).toEqual([]);
  });

  it("keeps an accepted password no longer than a step's wait", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    // The document's reconnect does not reach the worker in time.
    fake.state.onReconnect = undefined;
    answers[0]!.resolve("verified");
    await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + LOGIN_STEP_WAIT_MS);
    await announce(h);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    await settled(h);
    expect(confirmations()).toEqual([]);
  });

  it("remembers the closed windows of only the tab's latest pages it left", async () => {
    const { h, ask, answers } = await asking();
    await settled(h);
    const stopped = () => statuses().filter((entry) => entry === "confirm-fill-stopped");
    answers[0]!.resolve("closed");
    await vi.waitFor(() => expect(stopped()).toHaveLength(1));
    // Each later page of the tab is a verification whose window the person closes too,
    // one after another.
    /* eslint-disable no-await-in-loop */
    for (let page = 1; page <= DECLINED_KEPT; page++) {
      await announce(h, { documentId: `confirmation-${page}` });
      await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(page + 1));
      answers[page]!.resolve("closed");
      await vi.waitFor(() => expect(stopped()).toHaveLength(page + 1));
    }
    /* eslint-enable no-await-in-loop */
    moveTo("/home");
    await h.hello({ documentId: "next-document" }, false);
    moveTo("/confirm");
    // The latest page, back from the back/forward cache, keeps its window closed.
    expect(await announce(h, { documentId: `confirmation-${DECLINED_KEPT}` })).toMatchObject({
      reason: "confirm-fill",
    });
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(DECLINED_KEPT + 1);
    // The oldest one is no longer remembered: it asks again.
    await announce(h);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(DECLINED_KEPT + 2));
    await settled(h);
    expect(confirmations()).toEqual([]);
  });
});
