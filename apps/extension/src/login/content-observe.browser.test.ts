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
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return { ok: false, reason: "stale-document" };
  },
}));

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
});

/** The page's answer to a `login.observe` with these targets and flags. */
async function observe(command: Record<string, unknown>) {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  let answer: unknown;
  for (const listener of listeners)
    listener(
      { version: 1, type: "login.observe", token, path: location.pathname, ...command },
      { id: "synthetic-extension" },
      (value) => (answer = value),
    );
  return answer as { targets: string[] };
}

describe("login.observe's hidden flags (ADR 0037 amendment of 2026-10-22)", () => {
  it("counts a hidden copy only for a target flagged hidden, as a marker", async () => {
    document.body.innerHTML = `<header><a name="account" href="/account">Account</a></header>
      <div hidden><a name="account" href="/account">Account</a>
        <input name="pw" type="password"><input name="pw" type="password"></div>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    const account = { by: "name", value: "account" };
    const pw = { by: "name", value: "pw" };
    expect(await observe({ targets: [account, pw], require: ["shown", "present"] })).toMatchObject({
      targets: ["unique", "missing"],
    });
    // A marker and the element it needs missing count every copy.
    expect(
      await observe({
        targets: [account, pw],
        require: ["shown", "present"],
        hidden: [true, true],
      }),
    ).toMatchObject({ targets: ["ambiguous", "ambiguous"] });
  });
});
