import type { LoginTarget } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners, watch } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
  watch: { starts: [] as Record<string, unknown>[], generate: false },
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
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return sent.length === 1
      ? { ok: false, reason: "form-not-ready", starts: watch.starts, generate: watch.generate }
      : { ok: false, reason: "generating" };
  },
}));

let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  watch.starts = [];
  watch.generate = false;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});
const starts = () => sent.filter((message) => message["start"]);
const offers = () => sent.filter((message) => message["signIn"]);
function startAt(target: LoginTarget) {
  watch.starts = [{ path: location.pathname, require: "writable", targets: [target] }];
}
async function install() {
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
}
function cancel() {
  const token = sent[0]?.["token"];
  for (const listener of listeners)
    listener(
      { version: 1, type: "login.cancel", token },
      { id: "synthetic-extension" },
      () => undefined,
    );
}

describe("the page watch after only an attribute changes", () => {
  it.each([
    ["aria-label", '<input id="field" aria-label="Not ready">', "#field", "aria-label", "Password"],
    [
      "aria-labelledby",
      '<span id="before">Not ready</span><span id="after">Password</span><input id="field" aria-labelledby="before">',
      "#field",
      "aria-labelledby",
      "after",
    ],
    [
      "placeholder",
      '<input id="field" placeholder="Not ready">',
      "#field",
      "placeholder",
      "Password",
    ],
    [
      "a label's for",
      '<label id="label" for="missing">Password</label><input id="field">',
      "#label",
      "for",
      "field",
    ],
  ])(
    "announces a start whose accessible name is supplied by %s",
    async (_name, html, selector, attribute, value) => {
      document.body.innerHTML = html;
      startAt({ by: "accessible-name", value: "Password" });
      await install();
      expect(starts()).toEqual([]);
      document.querySelector(selector)!.setAttribute(attribute, value);
      // Well before either the one-second offer decision or a retry timer.
      await vi.advanceTimersByTimeAsync(150);
      expect(starts()).toEqual([expect.objectContaining({ start: { path: location.pathname } })]);
    },
  );

  it.each([false, true])(
    "rechecks CSS visibility driven by data-* attributes (shadow root: %s)",
    async (shadow) => {
      const html =
        '<style>input:not([data-ready]) { display: none; }</style><input id="field" type="password">';
      let root: Document | ShadowRoot = document;
      if (shadow) {
        document.body.innerHTML = '<div id="host"></div>';
        root = document.querySelector("#host")!.attachShadow({ mode: "open" });
        root.innerHTML = html;
      } else document.body.innerHTML = html;
      startAt({ by: "id", value: "field" });
      await install();
      expect(starts()).toEqual([]);
      root.querySelector("input")!.setAttribute("data-ready", "yes");
      await vi.advanceTimersByTimeAsync(150);
      expect(starts()).toHaveLength(1);
    },
  );

  it("keeps first-step checks at least 100 ms apart during an attribute animation", async () => {
    document.body.innerHTML = '<input id="field" type="password" readonly>';
    startAt({ by: "id", value: "field" });
    await install();
    const input = document.querySelector("input")!;
    const rects = input.getClientRects.bind(input);
    const reads: number[] = [];
    // Keep the real layout check and record when a watched start reads the input.
    vi.spyOn(input, "getClientRects").mockImplementation(() => {
      reads.push(Date.now());
      return rects();
    });
    let tick = 0;
    const animation = setInterval(() => input.setAttribute("data-clock", String(++tick)), 10);
    await vi.advanceTimersByTimeAsync(450);
    clearInterval(animation);
    const checked = [...new Set(reads)];
    expect(checked.length).toBeGreaterThanOrEqual(3);
    expect(checked.length).toBeLessThanOrEqual(5);
    expect(checked.slice(1).every((time, index) => time - checked[index]! >= 100)).toBe(true);
    expect(starts()).toEqual([]);
  });

  it("restarts the one-second quiet wait for unrelated attributes", async () => {
    document.body.innerHTML = "<main><button>Sign in with a passkey</button></main>";
    watch.generate = true;
    await install();
    await vi.advanceTimersByTimeAsync(400);
    document.querySelector("main")!.setAttribute("data-render", "finished");
    await vi.advanceTimersByTimeAsync(600);
    expect(offers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(offers()).toEqual([
      expect.objectContaining({ signIn: { path: location.pathname, passkey: true } }),
    ]);
  });

  it("retains the five-second cap while unrelated attributes never become quiet", async () => {
    document.body.innerHTML = "<main><button>Sign in with a passkey</button></main>";
    watch.generate = true;
    let tick = 0;
    const animation = setInterval(
      () => document.querySelector("main")!.setAttribute("data-clock", String(++tick)),
      200,
    );
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(offers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    clearInterval(animation);
    expect(offers()).toHaveLength(1);
    expect(offers()[0]).toMatchObject({ signIn: { path: location.pathname, passkey: true } });
  });

  it.each(["cancel", "uninstall"])(
    "ends pending attribute checks and quiet decisions on %s",
    async (stop) => {
      document.body.innerHTML =
        '<input id="field" readonly><button>Sign in with a passkey</button>';
      startAt({ by: "id", value: "field" });
      watch.generate = true;
      await install();
      if (stop === "cancel") cancel();
      else {
        uninstall?.();
        uninstall = undefined;
      }
      document.querySelector("input")!.removeAttribute("readonly");
      document.querySelector("button")!.setAttribute("data-clock", "changed");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(starts()).toEqual([]);
      expect(offers()).toEqual([]);
    },
  );
});
