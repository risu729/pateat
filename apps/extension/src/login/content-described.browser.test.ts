import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: () => undefined,
      },
    },
  },
}));
// The background refuses each announcement, so no login runs by itself.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return { ok: false, reason: "stale-document" };
  },
}));

const start = location.pathname;
let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
  history.replaceState(null, "", start);
});

/** Shows `html` on `/verify` and installs the content script; returns its token. */
async function open(html: string): Promise<string> {
  history.replaceState(null, "", "/verify");
  document.body.innerHTML = html;
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
  const token = sent[0]?.["token"];
  if (typeof token !== "string") throw new Error("The page did not announce itself");
  return token;
}
/** Sends `message` as the background does and returns the page's answer. */
function command(message: Record<string, unknown>): unknown {
  let value: unknown;
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (answer) => {
      value = answer;
    });
  return value;
}
const reports = () => sent.filter((message) => message["type"] === "login.document.described");

// ADR 0027 amendment of 2026-11-04.
describe("the watch for a page that described nothing", () => {
  it("says once that the page shows something, after it changes", async () => {
    const token = await open(`<main><p>Loading</p></main>`);
    expect(command({ version: 1, type: "login.extract.watch", token, timeoutMs: 60_000 })).toEqual({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reports()).toEqual([]);
    document.querySelector("main")!.innerHTML =
      `<h1>Verify your identity</h1><button type="button" id="verify">Verify</button>`;
    await vi.advanceTimersByTimeAsync(200);
    expect(reports()).toEqual([{ version: 1, type: "login.document.described", token }]);
    // Once: later changes say nothing more.
    document.querySelector("main")!.append(document.createElement("p"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reports()).toHaveLength(1);
  });
  it("says so once the page draws only click layers, as Endeavour's chooser", async () => {
    // ADR 0029 amendment of 2026-11-28: a page of click layers only may complete the login.
    const token = await open(`<main><p>Loading</p></main>`);
    command({ version: 1, type: "login.extract.watch", token, timeoutMs: 60_000, layers: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reports()).toEqual([]);
    document.querySelector("main")!.innerHTML =
      `<div tabindex="-1" style="position:absolute;left:10px;top:10px;width:100px;height:20px">
        <div tabindex="-1" style="position:absolute;inset:0;cursor:pointer"></div>
        <div tabindex="-1" style="position:absolute;inset:0;pointer-events:none">exit</div>
      </div>`;
    await vi.advanceTimersByTimeAsync(200);
    expect(reports()).toEqual([{ version: 1, type: "login.document.described", token }]);
  });
  it("says nothing of click layers only unless asked to", async () => {
    const token = await open(`<main><p>Loading</p></main>`);
    command({ version: 1, type: "login.extract.watch", token, timeoutMs: 60_000 });
    document.querySelector("main")!.innerHTML =
      `<div tabindex="-1" style="position:absolute;left:10px;top:10px;width:100px;height:20px">
        <div tabindex="-1" style="position:absolute;inset:0;cursor:pointer"></div>
        <div tabindex="-1" style="position:absolute;inset:0;pointer-events:none">exit</div>
      </div>`;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reports()).toEqual([]);
  });
  it("says it at once for a page that already shows something", async () => {
    const token = await open(`<main><button type="button" id="verify">Verify</button></main>`);
    command({ version: 1, type: "login.extract.watch", token, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reports()).toHaveLength(1);
  });
  it("says nothing for another document's token, after its time or after a cancel", async () => {
    const token = await open(`<main><p>Loading</p></main>`);
    // Another document's token starts nothing.
    expect(
      command({ version: 1, type: "login.extract.watch", token: "other-token", timeoutMs: 60_000 }),
    ).toBeUndefined();
    document.querySelector("main")!.innerHTML = `<button type="button" id="verify">Verify</button>`;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reports()).toEqual([]);
    document.querySelector("main")!.innerHTML = `<p>Loading</p>`;
    command({ version: 1, type: "login.extract.watch", token, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_500);
    document.querySelector("main")!.innerHTML = `<button type="button" id="verify">Verify</button>`;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reports()).toEqual([]);
    document.querySelector("main")!.innerHTML = `<p>Loading</p>`;
    command({ version: 1, type: "login.extract.watch", token, timeoutMs: 60_000 });
    command({ version: 1, type: "login.cancel", token });
    document.querySelector("main")!.innerHTML = `<button type="button" id="verify">Verify</button>`;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reports()).toEqual([]);
  });
});

// ADR 0026, amendment of 2026-11-20: the RP return's watch of a page that shows nothing.
describe("the watch for a page that shows nothing yet (`shown`)", () => {
  const watch = (token: string) =>
    command({ version: 1, type: "login.extract.watch", token, timeoutMs: 60_000, shown: true });
  it("says once that the page shows text, even with nothing to describe", async () => {
    const token = await open(`<main></main>`);
    expect(watch(token)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reports()).toEqual([]);
    document.querySelector("main")!.innerHTML = `<h1>Welcome back</h1>`;
    await vi.advanceTimersByTimeAsync(200);
    expect(reports()).toEqual([{ version: 1, type: "login.document.described", token }]);
  });
  it("says it at once for a shell whose only control is an icon link with a label", async () => {
    const token = await open(
      `<main><a href="/account" aria-label="Account"><svg width="24" height="24"></svg></a></main>`,
    );
    watch(token);
    await vi.advanceTimersByTimeAsync(0);
    expect(reports()).toHaveLength(1);
  });
});
