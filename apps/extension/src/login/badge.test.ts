import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_FRAMES,
  BUSY_FRAME_MS,
  BUSY_LIMIT_MS,
  LOGIN_BADGE_KEY,
  NOTICE_MS,
  badgeResult,
  createLoginBadge,
  memoryBadgeStorage,
  setActionBadge,
  type BadgeDetails,
} from "./badge";
import type { LoginReport } from "./runtime";

const action = vi.hoisted(() => ({
  setBadgeText: vi.fn(async (_details: unknown) => undefined),
  setBadgeBackgroundColor: vi.fn(async (_details: unknown) => undefined),
  setBadgeTextColor: vi.fn(async (_details: unknown) => undefined),
  setTitle: vi.fn(async (_details: unknown) => undefined),
}));
vi.mock("wxt/browser", () => ({ browser: { action } }));

type Attempt = Extract<LoginReport, { type: "attempt" }>;
const origin = "https://login.example";
const tabId = 7;

function attempt(fields: Partial<Attempt> = {}): Attempt {
  return {
    type: "attempt",
    tabId,
    origin,
    recipeId: "recipe",
    recipeRevision: 1,
    route: "password",
    state: "blocked",
    stepIndex: 0,
    stepCount: 2,
    ...fields,
  };
}
const start = (fields: { tabId?: number; origin?: string } = {}): LoginReport => ({
  type: "start",
  tabId,
  origin,
  recipeId: "recipe",
  recipeRevision: 1,
  route: "password",
  ...fields,
});
const refused = (reason: string, repeat?: true): LoginReport => ({
  type: "refused",
  tabId,
  origin,
  reason,
  ...(repeat ? { repeat } : {}),
});
const generation = (
  outcome: Extract<LoginReport, { type: "generation" }>["outcome"],
  reason?: string,
): LoginReport => ({ type: "generation", tabId, origin, outcome, ...(reason ? { reason } : {}) });

const NONE = { text: "", title: "Pateat" };
const CHOICE = { color: "#8a5a00", textColor: "#ffffff" };
const BUSY = { color: "#4f46e5", textColor: "#ffffff" };
const FAILED = { text: "!", color: "#b91c1c", textColor: "#ffffff" };
const SUCCEEDED = { text: "✓", color: "#15803d", textColor: "#ffffff" };
const UNSETTLED = { text: "!", color: "#facc15", textColor: "#1e293b" };

function harness(
  options: { stored?: unknown; setBadge?: (d: BadgeDetails) => Promise<void> } = {},
) {
  const calls: BadgeDetails[] = [];
  const storage = memoryBadgeStorage();
  if (options.stored !== undefined) void storage.setValue(options.stored);
  const setValue = vi.spyOn(storage, "setValue");
  const setBadge = vi.fn(async (details: BadgeDetails) => {
    calls.push(details);
    await options.setBadge?.(details);
  });
  const badge = createLoginBadge({ setBadge, storage, now: () => Date.now() });
  // The tab's badge as Chrome would show it, after every write so far.
  const view = (id = tabId) =>
    calls
      .filter((call) => call.tabId === id)
      .reduce<Omit<BadgeDetails, "tabId">>(
        (all, { text, color, textColor, title }) => ({
          ...all,
          ...(text === undefined ? {} : { text }),
          ...(color === undefined ? {} : { color }),
          ...(textColor === undefined ? {} : { textColor }),
          ...(title === undefined ? {} : { title }),
        }),
        {},
      );
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { badge, calls, storage, setValue, setBadge, view, flush };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T19:28:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("badgeResult", () => {
  const now = 1000;
  it("clears on a start and shows a success briefly", () => {
    expect(badgeResult(start(), now)).toBe("clear");
    expect(badgeResult(attempt({ state: "authenticated" }), now)).toEqual({
      kind: "succeeded",
      reason: "authenticated",
      until: now + NOTICE_MS,
    });
  });

  it.each([
    "credential-rejected",
    "structural-mismatch",
    "timeout",
    "retry-limit",
    "submission-limit",
    "value-mismatch",
    "fill-rejected",
    "wrong-account",
    "account-not-listed",
  ])("keeps a failure for blocked %s, naming its cause", (outcome) => {
    expect(badgeResult(attempt({ outcome }), now)).toEqual({ kind: "failed", reason: outcome });
    expect(badgeResult(attempt({ outcome, cause: "elements-timeout" }), now)).toEqual({
      kind: "failed",
      reason: `${outcome}: elements-timeout`,
    });
  });

  it.each(["challenge-abandoned", "watch-abandoned", "left-origin"])(
    "shows blocked %s as unsettled",
    (outcome) => {
      expect(badgeResult(attempt({ outcome }), now)).toEqual({
        kind: "unsettled",
        reason: outcome,
        until: now + NOTICE_MS,
      });
    },
  );

  it.each(["cancelled", "account-switched", "interrupted", "policy-changed", undefined])(
    "clears for blocked %s",
    (outcome) => {
      expect(badgeResult(attempt(outcome ? { outcome } : {}), now)).toBe("clear");
    },
  );

  it("shows a settled unknown submission or a challenge of a running login as unsettled", () => {
    const unsettled = (reason: string) => ({ kind: "unsettled", reason, until: now + NOTICE_MS });
    expect(
      badgeResult(
        attempt({ state: "awaiting-result", outcome: "unknown-submit", settled: true }),
        now,
      ),
    ).toEqual(unsettled("unknown-submit"));
    expect(badgeResult(attempt({ state: "watching", outcome: "challenge" }), now)).toEqual(
      unsettled("challenge"),
    );
    expect(
      badgeResult(attempt({ state: "awaiting-result", outcome: "unknown-submit" }), now),
    ).toBeUndefined();
    expect(badgeResult(attempt({ state: "executing" }), now)).toBeUndefined();
  });

  it("ignores repeat reports", () => {
    expect(badgeResult(attempt({ state: "authenticated", repeat: true }), now)).toBeUndefined();
    expect(badgeResult(attempt({ outcome: "timeout", repeat: true }), now)).toBeUndefined();
    expect(badgeResult(refused("storage-unavailable", true), now)).toBeUndefined();
  });

  it("fails on unavailable storage and failed generation only", () => {
    expect(badgeResult(refused("storage-unavailable"), now)).toEqual({
      kind: "failed",
      reason: "storage-unavailable",
    });
    expect(badgeResult(refused("no-recipe"), now)).toBeUndefined();
    expect(badgeResult(generation("failed", "invalid-output"), now)).toEqual({
      kind: "failed",
      reason: "generation failed: invalid-output",
    });
    expect(badgeResult(generation("unavailable"), now)).toEqual({
      kind: "failed",
      reason: "generation unavailable",
    });
    expect(badgeResult(generation("sent"), now)).toBeUndefined();
    expect(badgeResult(generation("abstained", "no-form"), now)).toBeUndefined();
    expect(badgeResult({ type: "choice", tabId, origin, outcome: "saved" }, now)).toBeUndefined();
  });
});

describe("setActionBadge", () => {
  it("writes only the given fields", async () => {
    await setActionBadge({ tabId, text: "!", title: "t" });
    expect(action.setBadgeText).toHaveBeenCalledWith({ tabId, text: "!" });
    expect(action.setTitle).toHaveBeenCalledWith({ tabId, title: "t" });
    expect(action.setBadgeBackgroundColor).not.toHaveBeenCalled();
    expect(action.setBadgeTextColor).not.toHaveBeenCalled();
    await setActionBadge({ tabId, color: "#000000", textColor: "#ffffff" });
    expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId, color: "#000000" });
    expect(action.setBadgeTextColor).toHaveBeenCalledWith({ tabId, color: "#ffffff" });
  });
});

describe("login badge", () => {
  it("shows the waiting account choice over a spin, a spin over a result, and a note otherwise", async () => {
    const h = harness();
    h.badge.note(tabId, "Pateat: held.");
    await h.flush();
    expect(h.view()).toMatchObject({ text: "", title: "Pateat: held." });

    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    expect(h.view().title).toContain("credential-rejected");

    const stop = h.badge.spin(tabId);
    await h.flush();
    expect(h.view()).toMatchObject({ text: BUSY_FRAMES[0], ...BUSY });

    h.badge.choice(tabId, { count: 3, title: "Pateat: choose an account." });
    await h.flush();
    expect(h.view()).toEqual({ text: "3", ...CHOICE, title: "Pateat: choose an account." });

    h.badge.choice(tabId, undefined);
    await h.flush();
    expect(h.view()).toMatchObject({ text: BUSY_FRAMES[0], ...BUSY });

    stop();
    await h.flush();
    // A failure stays.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.view()).toMatchObject(FAILED);

    h.badge.observe(start());
    await h.flush();
    expect(h.view()).toMatchObject({ text: "", title: "Pateat: held." });
    h.badge.note(tabId, undefined);
    await h.flush();
    expect(h.view()).toMatchObject(NONE);
  });

  it("spins a braille frame every 100 ms and stops with the last overlapping spin", async () => {
    const h = harness();
    const first = h.badge.spin(tabId);
    const second = h.badge.spin(tabId);
    await h.flush();
    expect(h.calls).toEqual([
      { tabId, text: BUSY_FRAMES[0], ...BUSY, title: "Pateat: asking the AI…" },
    ]);
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * BUSY_FRAMES.length);
    expect(h.calls.slice(1).map((call) => call.text)).toEqual([
      ...BUSY_FRAMES.slice(1),
      BUSY_FRAMES[0],
    ]);
    // Each frame writes only the text.
    expect(h.calls.slice(1).every((call) => Object.keys(call).join() === "tabId,text")).toBe(true);

    first();
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS);
    expect(h.view().color).toBe(BUSY.color);
    second();
    await h.flush();
    // Colours stay; only the text and title clear.
    expect(h.calls.at(-1)).toEqual({ tabId, ...NONE });
    const count = h.calls.length;
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 5);
    expect(h.calls).toHaveLength(count);
    // A second stop does nothing.
    second();
    await h.flush();
    expect(h.calls).toHaveLength(count);
  });

  it("stops a spin on its own after two minutes", async () => {
    const h = harness();
    h.badge.spin(tabId);
    await vi.advanceTimersByTimeAsync(BUSY_LIMIT_MS - BUSY_FRAME_MS);
    expect(h.view().color).toBe(BUSY.color);
    expect(h.view().text).not.toBe("");
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS);
    expect(h.view()).toMatchObject(NONE);
    const count = h.calls.length;
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 3);
    expect(h.calls).toHaveLength(count);
  });

  it("shows a success and an unsettled result for four seconds", async () => {
    const h = harness();
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.view()).toEqual({ ...SUCCEEDED, title: "Pateat: logged in." });
    await vi.advanceTimersByTimeAsync(NOTICE_MS - 1);
    expect(h.view()).toMatchObject(SUCCEEDED);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.view()).toMatchObject(NONE);

    h.badge.observe(attempt({ outcome: "watch-abandoned" }));
    await h.flush();
    expect(h.view()).toMatchObject(UNSETTLED);
    expect(h.view().title).toContain("watch-abandoned");
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(h.view()).toMatchObject(NONE);
  });

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
    h.badge.choice(tabId, { count: 2, title: "choose" });
    h.badge.choice(tabId, { count: 3, title: "choose" });
    h.badge.choice(tabId, { count: 3, title: "choose" });
    await h.flush();
    expect(h.calls).toEqual([
      { tabId, text: "2", ...CHOICE, title: "choose" },
      { tabId, text: "3" },
    ]);
    // Removing an absent note or choice draws nothing.
    h.badge.note(9, undefined);
    h.badge.choice(9, undefined);
    await h.flush();
    expect(h.calls).toHaveLength(2);
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
    h.badge.choice(tabId, { count: 1, title: "choose" });
    h.badge.choice(tabId, { count: 2, title: "choose" });
    await h.flush();
    expect(h.calls.map((call) => call.text)).toEqual(["1"]);
    release();
    await h.flush();
    expect(h.calls.map((call) => call.text)).toEqual(["1", "2"]);
  });

  it("rewrites every field after a failed write", async () => {
    let fail = true;
    const h = harness({
      setBadge: async () => {
        if (fail) throw new Error("No tab with id");
      },
    });
    h.badge.choice(tabId, { count: 1, title: "choose" });
    await h.flush();
    fail = false;
    h.badge.choice(tabId, { count: 2, title: "choose" });
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, text: "2", ...CHOICE, title: "choose" });
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

  it("rewrites the badge after a page loads and drops a result of another origin", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    const count = h.calls.length;

    h.badge.loaded(tabId, `${origin}/account`);
    await h.flush();
    expect(h.calls.slice(count)).toEqual([{ tabId, ...FAILED, title: expect.any(String) }]);

    h.badge.loaded(tabId);
    h.badge.loaded(tabId, "not a url");
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    expect(h.calls).toHaveLength(count + 3);

    // Chrome reset the badge; with the result dropped there is nothing to write.
    h.badge.loaded(tabId, "https://other.example/");
    h.badge.loaded(tabId, `${origin}/`);
    await h.flush();
    expect(h.calls).toHaveLength(count + 3);
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [] });
    // What was written is forgotten, so the next badge writes every field.
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, ...SUCCEEDED, title: "Pateat: logged in." });
  });

  it("writes the note of a tab whose result another origin dropped", async () => {
    const h = harness();
    h.badge.note(tabId, "held");
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    h.badge.loaded(tabId, "https://other.example/");
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, text: "", ...CHOICE, title: "held" });
  });

  it("writes nothing for a loaded tab with nothing to show", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.loaded(tabId);
    await h.flush();
    expect(h.calls).toEqual([]);
  });

  it("rewrites a spin and a choice after a page loads", async () => {
    const h = harness();
    h.badge.choice(tabId, { count: 2, title: "choose" });
    await h.flush();
    h.badge.loaded(tabId, "https://other.example/");
    await h.flush();
    expect(h.calls.at(-1)).toEqual({ tabId, text: "2", ...CHOICE, title: "choose" });
  });

  it("forgets a removed tab's choice, note, spin and result", async () => {
    const h = harness();
    h.badge.choice(tabId, { count: 2, title: "choose" });
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
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [] });
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
    });

    // The moved spin still stops, and the moved success still expires.
    stop();
    await h.flush();
    expect(h.view(8)).toMatchObject(SUCCEEDED);
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(h.view(8)).toMatchObject({ text: "", title: "held" });

    h.badge.choice(tabId, { count: 2, title: "choose" });
    h.badge.replaced(9, tabId);
    await h.flush();
    expect(h.view(9)).toMatchObject({ text: "2", title: "choose" });
    const count = h.calls.length;
    h.badge.replaced(9, 9);
    await h.flush();
    expect(h.calls).toHaveLength(count);
  });

  it("persists results and spinning tabs", async () => {
    const h = harness();
    expect(LOGIN_BADGE_KEY).toMatch(/^session:/);
    h.badge.observe(attempt({ outcome: "timeout", cause: "elements-timeout" }));
    const stop = h.badge.spin(8);
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, { kind: "failed", origin, reason: "timeout: elements-timeout" }]],
      busy: [8],
    });
    stop();
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, expect.objectContaining({ kind: "failed" })]],
      busy: [],
    });
  });

  it("restores unexpired results and clears the spins a stopped worker left", async () => {
    const now = Date.now();
    const h = harness({
      stored: {
        results: [
          [1, { kind: "failed", origin, reason: "timeout" }],
          [2, { kind: "succeeded", origin, reason: "authenticated", until: now + 1000 }],
          [3, { kind: "unsettled", origin, reason: "left-origin", until: now - 1 }],
        ],
        busy: [4],
      },
    });
    await h.badge.restore();
    await h.flush();
    expect(h.view(1)).toMatchObject(FAILED);
    expect(h.view(2)).toMatchObject(SUCCEEDED);
    expect(h.view(3)).toMatchObject(NONE);
    expect(h.view(4)).toMatchObject(NONE);
    expect(await h.storage.getValue()).toEqual({
      results: [
        [1, { kind: "failed", origin, reason: "timeout" }],
        [2, { kind: "succeeded", origin, reason: "authenticated", until: now + 1000 }],
      ],
      busy: [],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.view(2)).toMatchObject(NONE);
    expect(await h.storage.getValue()).toEqual({
      results: [[1, { kind: "failed", origin, reason: "timeout" }]],
      busy: [],
    });
  });

  it("keeps a result reported before the restore", async () => {
    const h = harness({
      stored: { results: [[tabId, { kind: "failed", origin, reason: "timeout" }]], busy: [] },
    });
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.badge.restore();
    await h.flush();
    expect(h.view()).toMatchObject(SUCCEEDED);
  });

  it.each([
    ["nothing", undefined],
    ["a malformed value", { results: [[1, { kind: "lost", origin, reason: "x" }]], busy: [] }],
    ["a fractional tab", { results: [], busy: [1.5] }],
    ["a string", "busy"],
  ])("ignores %s in storage", async (_name, stored) => {
    const h = harness(stored === undefined ? {} : { stored });
    await h.badge.restore();
    await h.flush();
    expect(h.calls).toEqual([]);
  });

  it("ignores storage that cannot be read", async () => {
    const h = harness();
    vi.spyOn(h.storage, "getValue").mockRejectedValue(new Error("storage"));
    await expect(h.badge.restore()).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it("keeps drawing when storage cannot be written", async () => {
    const h = harness();
    h.setValue.mockRejectedValue(new Error("quota"));
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.observe(start());
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.view()).toMatchObject(SUCCEEDED);
    expect(h.setValue).toHaveBeenCalledTimes(3);
  });
});
