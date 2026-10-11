import { describe, expect, it, vi } from "vitest";
import { createPasskeyChooser, type ChooserBrowser } from "./chooser";

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
    // An answered request is gone.
    expect(await chooser.handle(load, { url: url.href, tab: { windowId: 41 } })).toEqual({
      ok: false,
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
});
