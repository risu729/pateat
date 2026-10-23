import { describe, expect, it, vi } from "vitest";
import { createPasskeyChooser, MAX_WRONG_PASSWORDS, type ChooserBrowser } from "./chooser";

const pageUrl = "chrome-extension://synthetic/passkey-picker.html";
const entries = [
  { item: "Work", userName: "alice", account: "Personal" },
  { item: "Home", userName: "bob" },
];

/** `null` makes the browser answer without a window ID. */
function fakeBrowser(windowId: number | null = 41) {
  const windowRemoved: Array<(windowId: number) => void> = [];
  const tabRemoved: Array<(tabId: number) => void> = [];
  let keptAlive = 0;
  const browser = {
    pageUrl,
    createWindow: vi.fn<ChooserBrowser["createWindow"]>(async () => ({
      id: windowId ?? undefined,
    })),
    removeWindow: vi.fn<ChooserBrowser["removeWindow"]>(async () => {}),
    tabWindowBounds: vi.fn<ChooserBrowser["tabWindowBounds"]>(async () => ({
      left: 100,
      top: 50,
      width: 1240,
      height: 900,
    })),
    focusTab: vi.fn<ChooserBrowser["focusTab"]>(async () => {}),
    onWindowRemoved: (listener: (windowId: number) => void) => windowRemoved.push(listener),
    onTabRemoved: (listener: (tabId: number) => void) => tabRemoved.push(listener),
    keepAlive<T>(work: Promise<T>) {
      keptAlive += 1;
      return work;
    },
  } satisfies ChooserBrowser;
  return {
    browser,
    keptAlive: () => keptAlive,
    closeWindow: (id: number) => windowRemoved.forEach((listener) => listener(id)),
    closeTab: (id: number) => tabRemoved.forEach((listener) => listener(id)),
  };
}

async function open(
  chooser: ReturnType<typeof createPasskeyChooser>,
  signal = new AbortController().signal,
) {
  const answer = chooser.choose({
    tabId: 7,
    origin: "https://login.example.com",
    rpId: "example.com",
    entries,
    replacesDefault: false,
    signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return answer;
}

/** The URL the window was opened with, as the page reports it in `sender.url`. */
const openedUrl = (browser: ReturnType<typeof fakeBrowser>["browser"]) =>
  browser.createWindow.mock.calls[0]![0].url;

describe("passkey chooser window", () => {
  it("opens one centred popup and serves its view only to that window", async () => {
    const { browser, keptAlive } = fakeBrowser();
    const chooser = createPasskeyChooser(browser);
    const answer = open(chooser);
    await vi.waitFor(() => expect(browser.createWindow).toHaveBeenCalledOnce());
    const options = browser.createWindow.mock.calls[0]![0];
    expect(options).toMatchObject({ type: "popup", focused: true, width: 440, height: 520 });
    expect(options.left).toBe(500);
    expect(options.top).toBe(177);
    const url = new URL(options.url);
    expect(url.pathname).toBe("/passkey-picker.html");
    const request = url.searchParams.get("request")!;
    expect(browser.tabWindowBounds).toHaveBeenCalledWith(7);
    expect(keptAlive()).toBe(1);

    const load = { version: 1, type: "passkey-chooser.load", request };
    expect(await chooser.handle(load, { url: url.href, tab: { windowId: 99 } })).toEqual({
      ok: false,
    });
    expect(
      await chooser.handle(load, {
        url: `${pageUrl}?request=${crypto.randomUUID()}`,
        tab: { windowId: 41 },
      }),
    ).toEqual({ ok: false });
    expect(
      chooser.handle(load, { url: "chrome-extension://synthetic/options.html" }),
    ).toBeUndefined();
    expect(await chooser.handle(load, { url: url.href, tab: { windowId: 41 } })).toEqual({
      ok: true,
      view: {
        origin: "https://login.example.com",
        rpId: "example.com",
        entries,
        replacesDefault: false,
      },
    });

    const reply = await chooser.handle(
      {
        version: 1,
        type: "passkey-chooser.answer",
        request,
        answer: { kind: "chosen", index: 1, makeDefault: true },
      },
      { url: url.href, tab: { windowId: 41 } },
    );
    expect(reply).toEqual({ ok: true });
    expect(await answer).toEqual({ kind: "chosen", index: 1, makeDefault: true });
    expect(browser.removeWindow).toHaveBeenCalledWith(41);
    expect(browser.focusTab).not.toHaveBeenCalled();
    // An answered request is gone.
    expect(await chooser.handle(load, { url: url.href, tab: { windowId: 41 } })).toEqual({
      ok: false,
    });
  });

  it("tells the window that the site is paused (ADR 0062)", async () => {
    const { browser } = fakeBrowser();
    const chooser = createPasskeyChooser(browser);
    void chooser.choose({
      tabId: 7,
      origin: "https://login.example.com",
      rpId: "example.com",
      entries: [entries[0]!],
      replacesDefault: true,
      paused: true,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(browser.createWindow).toHaveBeenCalledOnce());
    const url = openedUrl(browser);
    const request = new URL(url).searchParams.get("request");
    expect(
      await chooser.handle(
        { version: 1, type: "passkey-chooser.load", request },
        { url, tab: { windowId: 41 } },
      ),
    ).toEqual({
      ok: true,
      view: {
        origin: "https://login.example.com",
        rpId: "example.com",
        entries: [entries[0]],
        replacesDefault: true,
        paused: true,
      },
    });
  });

  it("refuses an index outside the list", async () => {
    const { browser } = fakeBrowser();
    const chooser = createPasskeyChooser(browser);
    void open(chooser);
    await vi.waitFor(() => expect(browser.createWindow).toHaveBeenCalledOnce());
    const url = openedUrl(browser);
    const request = new URL(url).searchParams.get("request");
    expect(
      await chooser.handle(
        {
          version: 1,
          type: "passkey-chooser.answer",
          request,
          answer: { kind: "chosen", index: 2, makeDefault: false },
        },
        { url, tab: { windowId: 41 } },
      ),
    ).toEqual({ ok: false });
  });

  it("reports a closed window, and closes the window when the tab or the request goes away", async () => {
    const first = fakeBrowser();
    const chooser = createPasskeyChooser(first.browser);
    const closed = open(chooser);
    await vi.waitFor(() => expect(first.browser.createWindow).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.closeWindow(41);
    expect(await closed).toEqual({ kind: "closed" });
    expect(first.browser.removeWindow).not.toHaveBeenCalled();
    // The page gets focus back for the browser's own prompt.
    expect(first.browser.focusTab).toHaveBeenCalledWith(7);

    const tabGone = open(chooser);
    await vi.waitFor(() => expect(first.browser.createWindow).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.closeTab(7);
    expect(await tabGone).toEqual({ kind: "closed" });
    expect(first.browser.removeWindow).toHaveBeenCalledWith(41);

    const controller = new AbortController();
    const aborted = open(chooser, controller.signal);
    await vi.waitFor(() => expect(first.browser.createWindow).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await aborted).toEqual({ kind: "closed" });
    expect(first.browser.removeWindow).toHaveBeenCalledTimes(2);
  });

  it("holds one window at a time and reports a window that could not open", async () => {
    const { browser } = fakeBrowser();
    const chooser = createPasskeyChooser(browser);
    void open(chooser);
    expect(await open(chooser)).toEqual({ kind: "unavailable" });

    const failing = fakeBrowser(null);
    expect(await open(createPasskeyChooser(failing.browser))).toEqual({ kind: "unavailable" });
    const throwing = fakeBrowser();
    throwing.browser.createWindow.mockRejectedValueOnce(new Error("no window"));
    expect(await open(createPasskeyChooser(throwing.browser))).toEqual({ kind: "unavailable" });
  });

  it("closes a window that finished opening after its request ended", async () => {
    const { browser } = fakeBrowser();
    let created!: (value: { id: number }) => void;
    browser.createWindow.mockReturnValueOnce(new Promise((resolve) => (created = resolve)));
    const controller = new AbortController();
    const chooser = createPasskeyChooser(browser);
    const answer = open(chooser, controller.signal);
    controller.abort();
    expect(await answer).toEqual({ kind: "closed" });
    created({ id: 52 });
    await vi.waitFor(() => expect(browser.removeWindow).toHaveBeenCalledWith(52));
  });

  it("notices a window the user closed before the browser reported its ID", async () => {
    const { browser, closeWindow } = fakeBrowser();
    let created!: (value: { id: number }) => void;
    browser.createWindow.mockReturnValueOnce(new Promise((resolve) => (created = resolve)));
    const answer = open(createPasskeyChooser(browser));
    closeWindow(63);
    created({ id: 63 });
    expect(await answer).toEqual({ kind: "closed" });
    expect(browser.removeWindow).not.toHaveBeenCalled();
  });

  it("hands the answer back only once the window is gone", async () => {
    const { browser } = fakeBrowser();
    let removed!: () => void;
    browser.removeWindow.mockReturnValueOnce(new Promise<void>((resolve) => (removed = resolve)));
    const chooser = createPasskeyChooser(browser);
    let settled = false;
    void open(chooser).then(() => (settled = true));
    await vi.waitFor(() => expect(browser.createWindow).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const url = openedUrl(browser);
    const request = new URL(url).searchParams.get("request");
    await chooser.handle(
      { version: 1, type: "passkey-chooser.answer", request, answer: { kind: "browser" } },
      { url, tab: { windowId: 41 } },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    removed();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it("does not hold the request when the window never finishes closing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { browser } = fakeBrowser();
      browser.removeWindow.mockReturnValueOnce(new Promise<void>(() => {}));
      browser.focusTab.mockReturnValueOnce(new Promise<void>(() => {}));
      const chooser = createPasskeyChooser(browser);
      const answer = chooser.choose({
        tabId: 7,
        origin: "https://login.example.com",
        rpId: "example.com",
        entries,
        replacesDefault: false,
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => expect(browser.createWindow).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      const url = openedUrl(browser);
      const request = new URL(url).searchParams.get("request");
      await chooser.handle(
        { version: 1, type: "passkey-chooser.answer", request, answer: { kind: "browser" } },
        { url, tab: { windowId: 41 } },
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await answer).toEqual({ kind: "browser" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("master password re-prompt in the chooser window", () => {
  const sender = (url: string) => ({ url, tab: { windowId: 41 } });
  async function asking(
    verify: ((index: number, password: string) => Promise<boolean>) | undefined,
    purpose?: "login",
  ) {
    const { browser } = fakeBrowser();
    const chooser = createPasskeyChooser(browser);
    const answer = chooser.choose({
      tabId: 7,
      origin: "https://login.example.com",
      rpId: "example.com",
      entries: [{ item: "Work", reprompt: true }, { item: "Home" }],
      ...(verify ? { verify } : {}),
      replacesDefault: false,
      ...(purpose ? { purpose } : {}),
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const url = browser.createWindow.mock.calls[0]?.[0].url;
    const request = url && new URL(url).searchParams.get("request");
    const check = (index: number, password: string) =>
      chooser.handle(
        {
          version: 1,
          type: "passkey-chooser.verify",
          request,
          index,
          password,
          makeDefault: false,
        },
        sender(url!),
      );
    const choose = (index: number) =>
      chooser.handle(
        {
          version: 1,
          type: "passkey-chooser.answer",
          request,
          answer: { kind: "chosen", index, makeDefault: false },
        },
        sender(url!),
      );
    return { browser, chooser, answer, url, request, check, choose };
  }

  it("opens no window for a re-prompt entry it cannot check", async () => {
    const { browser, answer } = await asking(undefined);
    expect(await answer).toEqual({ kind: "unavailable" });
    expect(browser.createWindow).not.toHaveBeenCalled();
  });

  it("uses a re-prompt entry only once its master password is right", async () => {
    const verify = vi.fn(async (_index: number, password: string) => password === "right");
    const { answer, check, choose, chooser, url, request } = await asking(verify);
    expect(
      await chooser.handle({ version: 1, type: "passkey-chooser.load", request }, sender(url!)),
    ).toMatchObject({ ok: true, view: { entries: [{ item: "Work", reprompt: true }, {}] } });
    // Choosing it without the password, or checking a password for another entry, is refused.
    expect(await choose(0)).toEqual({ ok: false });
    expect(await check(1, "right")).toEqual({ ok: false });
    expect(await check(0, "wrong")).toEqual({ ok: true, matches: false });
    expect(await check(0, "right")).toEqual({ ok: true, matches: true });
    expect(await answer).toEqual({ kind: "chosen", index: 0, makeDefault: false });
    expect(verify).toHaveBeenCalledWith(0, "right");
  });

  it("still chooses an entry without re-prompt directly", async () => {
    const { answer, choose } = await asking(async () => false);
    expect(await choose(1)).toEqual({ ok: true });
    expect(await answer).toEqual({ kind: "chosen", index: 1, makeDefault: false });
  });

  it("checks one password at a time", async () => {
    let finish!: (matches: boolean) => void;
    const { answer, check } = await asking(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    const first = check(0, "first");
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(await check(0, "second")).toEqual({ ok: false });
    finish(true);
    expect(await first).toEqual({ ok: true, matches: true });
    expect(await answer).toMatchObject({ kind: "chosen", index: 0 });
  });

  it("ends the request after five wrong passwords", async () => {
    const { answer, check } = await asking(async () => false);
    // One check at a time, as the window sends them.
    for (let attempt = 1; attempt < MAX_WRONG_PASSWORDS; attempt += 1)
      // eslint-disable-next-line no-await-in-loop
      expect(await check(0, `guess-${attempt}`)).toEqual({ ok: true, matches: false });
    expect(await check(0, "guess-last")).toEqual({ ok: false });
    expect(await answer).toEqual({ kind: "closed" });
  });

  it("ends the request when the vault cannot check the password", async () => {
    const { answer, check } = await asking(async () => {
      throw new Error("vault-unavailable");
    });
    expect(await check(0, "right")).toEqual({ ok: false });
    expect(await answer).toEqual({ kind: "unavailable" });
  });

  it("answers a login's window only through the password check", async () => {
    const { answer, check, choose } = await asking(async () => true, "login");
    expect(await choose(1)).toEqual({ ok: false });
    expect(await check(0, "right")).toEqual({ ok: true, matches: true });
    expect(await answer).toMatchObject({ kind: "chosen", index: 0 });
  });
});
