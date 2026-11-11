import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "./state";
import type { LiveDocument } from "./types";
import { endManual, manualPending, MANUAL_START_MS, type ManualStart } from "./manual-scope";
import { frameKey } from "./steps";

function harness() {
  const top: LiveDocument = {
    document: { origin: "https://portal.example", tabId: 1, frameId: 0, documentId: "top" },
    seenAt: 0,
    timing: { since: 0, serviceMs: 0, networkMs: 0, personMs: 0 },
    token: "top-token",
    url: "https://portal.example/account",
    path: "/account",
  };
  const live: LiveDocument = {
    document: { origin: "https://login.example", tabId: 1, frameId: 3, documentId: "selected" },
    seenAt: 0,
    timing: { since: 0, serviceMs: 0, networkMs: 0, personMs: 0 },
    token: "frame-token",
    url: "https://login.example/login",
    path: "/login",
    topUrl: top.url,
  };
  const pick = {
    tabId: 1,
    origin: live.document.origin,
    documentId: "selected",
    connectionId: "connection",
    itemId: "item",
    makeDefault: false,
    manual: true as const,
    waitedMs: 0,
  };
  const pending: ManualStart = {
    document: live.document,
    url: live.url,
    path: live.path,
    topUrl: top.url,
    topDocumentId: "top",
    expiresAt: Date.now() + MANUAL_START_MS,
    status: { requestId: "request", state: "evaluating" },
    pick,
  };
  const rt = {
    documents: new Map([
      [frameKey(top.document), top],
      [frameKey(live.document), live],
    ]),
    manualStarts: new Map([[1, pending]]),
    picked: new Map([[1, pick]]),
  };
  return { top, live, pick, pending, rt: rt as unknown as Runtime };
}
afterEach(() => vi.restoreAllMocks());

describe("pending manual authority", () => {
  it("requires the installed pick object, so an await before arming grants no authority", () => {
    const h = harness();
    expect(manualPending(h.rt, h.live)).toBe(h.pending);
    h.rt.picked.delete(1);
    expect(manualPending(h.rt, h.live)).toBeUndefined();
    h.rt.picked.set(1, { ...h.pick });
    expect(manualPending(h.rt, h.live)).toBeUndefined();
    expect(h.pending.pick).toBe(h.pick);
  });

  it("neither borrows nor cancels a selected frame's pending pick for a sibling", () => {
    const h = harness();
    const sibling = {
      ...h.live,
      document: { ...h.live.document, frameId: 4, documentId: "sibling" },
    };
    expect(manualPending(h.rt, sibling)).toBeUndefined();
    expect(h.rt.picked.get(1)).toBe(h.pick);
    expect(h.pending.status.state).toBe("evaluating");
    expect(manualPending(h.rt, h.live)).toBe(h.pending);
  });

  it.each(["url", "path", "document", "top-document", "top-url"] as const)(
    "invalidates changed %s before any admission",
    (change) => {
      const h = harness();
      if (change === "url") h.live.url += "?next=1";
      if (change === "path") h.live.path = "/different";
      if (change === "document")
        h.live.document = { ...h.live.document, documentId: "replacement" };
      if (change === "top-document") h.top.document = { ...h.top.document, documentId: "new-top" };
      if (change === "top-url") h.live.topUrl += "?next=1";
      expect(manualPending(h.rt, h.live)).toBeUndefined();
      expect(h.rt.picked.has(1)).toBe(false);
      expect(h.pending.pick).toBeUndefined();
      expect(h.pending.status).toEqual({
        requestId: "request",
        state: "blocked",
        reason: "page-changed",
      });
    },
  );

  it("expires at the bound even when no timer callback ran", () => {
    const h = harness();
    vi.spyOn(Date, "now").mockReturnValue(h.pending.expiresAt);
    expect(manualPending(h.rt, h.live)).toBeUndefined();
    expect(h.rt.picked.has(1)).toBe(false);
    expect(h.pending.status).toEqual({
      requestId: "request",
      state: "blocked",
      reason: "timed-out",
    });
  });

  it("an old generation or timer callback cannot cancel a replacement request", () => {
    const h = harness();
    const next = {
      ...h.pending,
      pick: { ...h.pick },
      status: { requestId: "new", state: "evaluating" as const },
    };
    h.rt.manualStarts.set(1, next);
    h.rt.picked.set(1, next.pick);
    endManual(h.rt, 1, "timed-out", h.pending);
    expect(h.rt.manualStarts.get(1)).toBe(next);
    expect(h.rt.picked.get(1)).toBe(next.pick);
    expect(next.status).toEqual({ requestId: "new", state: "evaluating" });
  });

  it("retires pending authority without removing an attached attempt pick", () => {
    const h = harness();
    const attached = { ...h.pick, attemptId: "attempt" };
    h.pending.pick = attached;
    h.rt.picked.set(1, attached);
    expect(manualPending(h.rt, h.live)).toBeUndefined();
    endManual(h.rt, 1, undefined, h.pending);
    expect(h.rt.picked.get(1)).toBe(attached);
    expect(h.pending.pick).toBeUndefined();
    expect(h.pending.status).toEqual({ requestId: "request", state: "started" });
  });
});
