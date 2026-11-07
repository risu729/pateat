import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

// The test page runs in Vitest's frame, which these tests hide and show as a page around a
// sign-in frame does (ADR 0086).
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
// The background answers the first announcement that the page may be sent for generation,
// and any later one that it is being sent.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return sent.length === 1
      ? { ok: false, reason: "recipe-not-found", starts: [], generate: true }
      : { ok: false, reason: "generating" };
  },
}));

const container = window.frameElement as HTMLElement | null;
let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  container?.style.removeProperty("display");
  document.body.innerHTML = "";
});

const form = `<form><label>Email <input id="user" name="user" autocomplete="username"></label>
  <label>Password <input id="pass" name="pass" type="password"></label>
  <button id="login">Sign in</button></form>`;
const offers = () => sent.slice(1);
/** Sends `message` as the background does and returns the page's answer. */
function command(message: Record<string, unknown>): unknown {
  let value: unknown;
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (answer) => {
      value = answer;
    });
  return value;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe("a sign-in form in a frame (ADR 0086)", () => {
  it("runs in a frame", () => {
    expect(container).not.toBeNull();
  });

  it("is offered only once its frame shows in the tab's page", async () => {
    container!.style.display = "none";
    document.body.innerHTML = form;
    uninstall = installLoginContent();
    await settle();
    expect(sent).toHaveLength(1);
    expect(offers()).toEqual([]);
    container!.style.removeProperty("display");
    await vi.waitFor(() =>
      expect(offers()).toEqual([
        expect.objectContaining({ type: "login.document.ready", signIn: expect.anything() }),
      ]),
    );
  });

  it("describes its page to send only while its frame shows", async () => {
    document.body.innerHTML = form;
    uninstall = installLoginContent();
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const token = sent[0]!["token"];
    const extract = (shown: boolean) =>
      command({
        version: 1,
        type: "login.extract",
        token,
        page: "login",
        ...(shown ? { shown: true } : {}),
      }) as { ok: boolean; reason?: string };
    expect(extract(true)).toMatchObject({ ok: true });
    container!.style.display = "none";
    expect(extract(true)).toEqual({ ok: false, reason: "frame-hidden" });
    // A page read for another purpose, as after a step, is still read.
    expect(extract(false)).not.toMatchObject({ reason: "frame-hidden" });
    container!.style.removeProperty("display");
    expect(extract(true)).toMatchObject({ ok: true });
  });
});
