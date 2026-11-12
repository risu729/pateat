import { expect, it, vi } from "vitest";
import { BUSY_FRAMES, BUSY_FRAME_MS, NOTICE_MS } from "../../../src/login/badge";
import type { BadgeTestFixtures } from "../../../src/login/badge.test";

export function registerWritesNavigationCases({
  harness,
  attempt,
  start,
  origin,
  tabId,
  NONE,
  OTHER_TAB,
  choose,
  CHOICE,
  BUSY,
  FAILED,
  SUCCEEDED,
  UNSETTLED,
}: Pick<
  BadgeTestFixtures,
  | "harness"
  | "attempt"
  | "start"
  | "origin"
  | "tabId"
  | "NONE"
  | "OTHER_TAB"
  | "choose"
  | "CHOICE"
  | "BUSY"
  | "FAILED"
  | "SUCCEEDED"
  | "UNSETTLED"
>) {
  it("keeps tabs apart", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.spin(8);
    await h.flush();
    expect(h.view(7)).toMatchObject(FAILED);
    expect(h.view(8)).toMatchObject({ text: BUSY_FRAMES[0], ...BUSY });
  });

  it("writes only changed fields, and nothing when nothing changed", async () => {
    const h = harness();
    h.badge.choice(tabId, { count: 2, ask: "rejected-elsewhere" });
    await h.flush();
    h.badge.choice(tabId, { count: 3, ask: "rejected-elsewhere" });
    await h.flush();
    h.badge.choice(tabId, { count: 3, ask: "rejected-elsewhere" });
    await h.flush();
    expect(h.calls).toEqual([
      { tabId, text: "2", ...CHOICE, title: OTHER_TAB },
      { tabId, text: "3" },
    ]);
    // A change that is undone before its write runs writes nothing.
    h.badge.choice(tabId, { count: 4, ask: "rejected-elsewhere" });
    h.badge.choice(tabId, { count: 3, ask: "rejected-elsewhere" });
    await h.flush();
    expect(h.calls).toHaveLength(2);
    // Removing an absent note or choice draws nothing.
    h.badge.note(9, undefined);
    h.badge.choice(9, undefined);
    await h.flush();
    expect(h.calls).toHaveLength(2);
  });

  it("writes several draws of one tab as one write of the latest state", async () => {
    const h = harness();
    h.badge.note(tabId, "held");
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.choice(tabId, { count: 2 });
    h.badge.spin(8);
    await h.flush();
    expect(h.calls).toEqual([
      { tabId, text: "2", ...CHOICE, title: choose(2) },
      { tabId: 8, text: BUSY_FRAMES[0], ...BUSY, title: "Pateat: asking the AI…" },
    ]);
  });

  it("lands one tab's writes in order", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const h = harness({
      setBadge: async () => {
        if (first) {
          first = false;
          await slow;
        }
      },
    });
    h.badge.choice(tabId, { count: 1 });
    await h.flush();
    // Draws while the first write is in flight wait for it and then write once.
    h.badge.choice(tabId, { count: 2 });
    h.badge.choice(tabId, { count: 3 });
    h.badge.choice(8, { count: 1 });
    await h.flush();
    expect(h.calls.map((call) => [call.tabId, call.text])).toEqual([
      [tabId, "1"],
      [8, "1"],
    ]);
    release();
    await h.flush();
    expect(h.calls.map((call) => [call.tabId, call.text])).toEqual([
      [tabId, "1"],
      [8, "1"],
      [tabId, "3"],
    ]);
    // Only what changed since the landed write: the count and the tooltip that names it.
    expect(h.calls.at(-1)).toEqual({ tabId, text: "3", title: choose(3) });
  });

  it("rewrites every field after a failed write", async () => {
    let fail = true;
    const h = harness({
      setBadge: async () => {
        if (fail) throw new Error("No tab with id");
      },
    });
    h.badge.choice(tabId, { count: 1 });
    await h.flush();
    fail = false;
    h.badge.choice(tabId, { count: 2 });
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, text: "2", ...CHOICE, title: choose(2) });
  });

  it("sends every field again when a write fails while a later one waits", async () => {
    let reject!: (error: Error) => void;
    const failing = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    let first = true;
    const h = harness({
      setBadge: async () => {
        if (first) {
          first = false;
          await failing;
        }
      },
    });
    h.badge.choice(tabId, { count: 1 });
    await h.flush();
    h.badge.choice(tabId, { count: 2 });
    await h.flush();
    expect(h.calls).toHaveLength(1);
    reject(new Error("tab strip busy"));
    await h.flush();
    expect(h.calls).toEqual([
      { tabId, text: "1", ...CHOICE, title: choose(1) },
      { tabId, text: "2", ...CHOICE, title: choose(2) },
    ]);
  });

  // Chrome resets the tab's badge on navigation; a write already in flight when the page
  // of another origin is reported can land after that reset.
  it("clears a result whose write was in flight when another origin loaded", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const h = harness({
      setBadge: async () => {
        if (first) {
          first = false;
          await slow;
        }
      },
    });
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    expect(h.calls.at(-1)).toMatchObject(FAILED);
    h.badge.loaded(tabId, "https://other.example/");
    release();
    await h.flush();
    expect(h.calls.at(-1)).toMatchObject({ text: "" });
  });

  it("ignores an attempt report that changes no state, outcome or settlement", async () => {
    const h = harness();
    h.badge.observe(attempt({ state: "authenticated" }));
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(h.view()).toMatchObject(NONE);
    const count = h.calls.length;
    h.badge.observe(attempt({ state: "authenticated", stepIndex: 1 }));
    await h.flush();
    expect(h.calls).toHaveLength(count);

    // A settlement is a change; a new login starts afresh.
    h.badge.observe(attempt({ state: "awaiting-result", outcome: "unknown-submit" }));
    h.badge.observe(
      attempt({ state: "awaiting-result", outcome: "unknown-submit", settled: true }),
    );
    await h.flush();
    expect(h.view()).toMatchObject(UNSETTLED);
    h.badge.observe(start());
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.view()).toMatchObject(SUCCEEDED);
    // Another tab keeps its own last report.
    h.badge.observe(attempt({ tabId: 8, state: "authenticated" }));
    await h.flush();
    expect(h.view(8)).toMatchObject(SUCCEEDED);
  });

  it("rewrites the badge after a page loads and drops the result when the top origin changes", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/signin`);
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    const count = h.calls.length;

    h.badge.loaded(tabId, `${origin}/account`);
    await h.flush();
    expect(h.calls.slice(count)).toEqual([{ tabId, ...FAILED, title: expect.any(String) }]);

    // Two loads before the write runs write once.
    h.badge.loaded(tabId, `${origin}/a`);
    h.badge.loaded(tabId, `${origin}/b`);
    await h.flush();
    expect(h.calls).toHaveLength(count + 2);
    expect(h.calls.at(-1)).toEqual({ tabId, ...FAILED, title: expect.any(String) });

    // Chrome reset the badge; with the result dropped there is nothing to write.
    h.badge.loaded(tabId, "https://other.example/");
    h.badge.loaded(tabId, `${origin}/`);
    await h.flush();
    expect(h.calls).toHaveLength(count + 2);
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
    // What was written is forgotten, so the next badge writes every field.
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, ...SUCCEEDED, title: "Pateat: logged in." });
  });

  it("keeps a result through the first load after start, which only sets the baseline", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.loaded(tabId, "https://other.example/");
    await h.flush();
    expect(h.calls.at(-1)).toMatchObject(FAILED);
  });

  it("keeps a frame's result while the tab's top origin stays", async () => {
    const h = harness();
    h.badge.loaded(tabId, "https://shop.example/checkout");
    // A login in a cross-origin frame reports the frame's origin.
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    h.badge.loaded(tabId, "https://shop.example/checkout");
    h.badge.loaded(tabId, "https://shop.example/checkout#frame");
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    // The result belongs to the tab's top origin, not the frame's.
    expect(await h.storage.getValue()).toMatchObject({
      results: [[tabId, { origin: "https://shop.example" }]],
    });
  });

  it("gives a result reported before any load the report's origin", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({ results: [[tabId, { origin }]] });
  });

  it("drops the result when a readable page is followed by an unreadable one", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.loaded(tabId);
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
    // Unreadable pages count as one origin; a later readable one is a change.
    h.badge.observe(attempt({ outcome: "retry-limit" }));
    h.badge.loaded(tabId, "not a url");
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({ results: [[tabId, { kind: "failed" }]] });
    h.badge.loaded(tabId, `${origin}/`);
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("keeps a note and a choice on same-origin loads and drops them on a top-origin change", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.note(tabId, "held");
    await h.flush();
    h.badge.loaded(tabId, `${origin}/again`);
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, text: "", ...CHOICE, title: "held" });

    h.badge.choice(tabId, { count: 2 });
    await h.flush();
    h.badge.loaded(tabId, `${origin}/more`);
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, text: "2", ...CHOICE, title: choose(2) });

    const count = h.calls.length;
    h.badge.loaded(tabId, "https://other.example/");
    await h.flush();
    // Nothing is left to show, so Chrome's reset badge stays.
    expect(h.calls).toHaveLength(count);
    // The choice and note are gone: a spin's stop shows the plain tooltip.
    h.badge.spin(tabId)();
    await h.flush();
    expect(h.calls.at(-1)).toMatchObject(NONE);
  });

  it("keeps a spin through a top-origin change", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.spin(tabId);
    await h.flush();
    h.badge.loaded(tabId, "https://other.example/");
    await h.flush();
    expect(h.calls.at(-1)).toEqual({
      tabId,
      text: expect.any(String),
      ...BUSY,
      title: "Pateat: asking the AI…",
    });
  });

  it("writes nothing for a loaded tab with nothing to show", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.loaded(tabId);
    await h.flush();
    expect(h.calls).toEqual([]);
  });

  it("forgets a removed tab's choice, note, spin and result", async () => {
    const h = harness();
    h.badge.choice(tabId, { count: 2 });
    h.badge.note(tabId, "held");
    h.badge.spin(tabId);
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    h.badge.removed(tabId);
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 3);
    const count = h.calls.length;
    h.badge.loaded(tabId, `${origin}/`);
    await h.flush();
    // Nothing is left to show, so nothing is written.
    expect(h.calls).toHaveLength(count);
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("moves a replaced tab's badge to its new ID", async () => {
    const h = harness();
    h.badge.note(tabId, "held");
    h.badge.observe(attempt({ state: "authenticated" }));
    const stop = h.badge.spin(tabId);
    await h.flush();
    h.badge.replaced(8, tabId);
    await h.flush();
    expect(h.view(8)).toMatchObject({ ...BUSY, title: "Pateat: asking the AI…" });
    expect(await h.storage.getValue()).toEqual({
      results: [[8, expect.objectContaining({ kind: "succeeded", origin })]],
      busy: [8],
      statuses: [[8, { origin, login: { state: "authenticated" } }]],
    });

    // The moved spin still stops, and the moved success still expires.
    stop();
    await h.flush();
    expect(h.view(8)).toMatchObject(SUCCEEDED);
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(h.view(8)).toMatchObject({ text: "", title: "held" });

    h.badge.choice(tabId, { count: 2 });
    h.badge.replaced(9, tabId);
    await h.flush();
    expect(h.view(9)).toMatchObject({ text: "2", title: choose(2) });
    const count = h.calls.length;
    h.badge.replaced(9, 9);
    await h.flush();
    expect(h.calls).toHaveLength(count);
  });

  it("keeps a replaced tab's top origin", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.replaced(8, tabId);
    // The same origin in the new tab keeps the result; another origin drops it.
    h.badge.loaded(8, `${origin}/account`);
    await h.flush();
    expect(h.view(8)).toMatchObject(FAILED);
    h.badge.loaded(8, "https://other.example/");
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });
}
