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
let title = "";
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  title = document.title;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.title = title;
});

/** The page's answer to `login.detail.card` for the input `target` names. */
function asked(target: { by: string; value: string }, path = location.pathname) {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  let answer: unknown;
  for (const listener of listeners)
    listener(
      { version: 1, type: "login.detail.card", token, path, target },
      { id: "synthetic-extension" },
      (value) => (answer = value),
    );
  return answer;
}

describe("login.detail.card (ADR 0061, owner 2026-10-23 12:26 UTC)", () => {
  it("answers only the last four digits and brands shown beside the input and in the title", async () => {
    // Synthetic numbers only.
    document.body.innerHTML = `<form><div>
        <p>Enter the security code of your VISA card •••• 9876</p>
        <input name="code" maxlength="3"></div><button>Next</button></form>`;
    document.title = "Card ending in 5555";
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    const answer = asked({ by: "name", value: "code" });
    expect(answer).toEqual({ ok: true, last4: ["9876", "5555"], brands: ["Visa"] });
    // The page's text never leaves the document.
    expect(JSON.stringify([answer, sent])).not.toContain("security code");
  });

  it("answers no hints for another path or an input it cannot fill", async () => {
    document.body.innerHTML = `<form><p>VISA ****9876</p>
        <input name="code" disabled><button>Next</button></form>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(asked({ by: "name", value: "code" })).toEqual({ ok: true, last4: [], brands: [] });
    expect(asked({ by: "name", value: "code" }, "/elsewhere")).toEqual({
      ok: true,
      last4: [],
      brands: [],
    });
  });
});
