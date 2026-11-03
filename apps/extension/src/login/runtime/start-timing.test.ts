import { afterEach, describe, expect, it, vi } from "vitest";
import { startTiming } from "./attempt";
import type { Runtime } from "./state";
import type { LiveDocument } from "./types";

const now = 10_000_000;
const document = { origin: "https://login.example", tabId: 1, frameId: 0, documentId: "doc" };
const chosen = { connectionId: "connection", itemId: "item" };

function setup(since: number, waitedMs: number) {
  const live = {
    document,
    token: "token",
    url: "https://login.example/signin",
    path: "/signin",
    seenAt: since,
    timing: { since, serviceMs: 0, networkMs: 0, personMs: 0 },
  } as unknown as LiveDocument;
  const pick = {
    tabId: 1,
    origin: document.origin,
    documentId: "doc",
    ...chosen,
    makeDefault: false,
    waitedMs,
  };
  const rt = { entryPresses: new Map(), picked: new Map([[1, pick]]) } as unknown as Runtime;
  return { rt, live };
}

describe("startTiming", () => {
  afterEach(() => vi.useRealTimers());

  it("counts the popup pick as the person's time", () => {
    vi.useFakeTimers({ now });
    const { rt, live } = setup(now - 8000, 5000);
    expect(startTiming(rt, live, chosen)).toMatchObject({ since: now - 8000, personMs: 5000 });
  });

  // A choice first offered before the document's time started again, as after the vault
  // was unlocked, never counts more person time than the login took (ADR 0019).
  it("counts no person time from before the login's time started", () => {
    vi.useFakeTimers({ now });
    const { rt, live } = setup(now - 2000, 60_000);
    expect(startTiming(rt, live, chosen)).toMatchObject({ since: now - 2000, personMs: 2000 });
  });
});
