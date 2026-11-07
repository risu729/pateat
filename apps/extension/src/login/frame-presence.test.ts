import { describe, expect, it, vi } from "vitest";

type Listener = (message: unknown, sender: unknown, respond: (answer: unknown) => void) => boolean;
const listeners = vi.hoisted(() => new Set<Listener>());
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
  },
}));
const { answerFramePresence } = await import("./frame-presence");

describe("the frame's presence answer (ADR 0086)", () => {
  const ask = (message: unknown, sender: unknown = { id: "synthetic-extension" }) => {
    const answers: unknown[] = [];
    for (const listener of listeners) listener(message, sender, (answer) => answers.push(answer));
    return answers;
  };
  const present = { version: 1, type: "login.frame.present" };

  it("answers the worker from the document's start, until it is removed", () => {
    const remove = answerFramePresence();
    expect(ask(present)).toEqual([true]);
    remove();
    expect(ask(present)).toEqual([]);
  });

  it("answers neither a page nor another extension nor another message", () => {
    const remove = answerFramePresence();
    expect(ask(present, { id: "synthetic-extension", tab: { id: 1 } })).toEqual([]);
    expect(ask(present, { id: "other-extension" })).toEqual([]);
    expect(ask({ ...present, token: "synthetic-token" })).toEqual([]);
    expect(ask({ version: 1, type: "login.reconnect" })).toEqual([]);
    remove();
  });
});
