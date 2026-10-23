import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n";
import {
  BUSY_FRAMES,
  BUSY_FRAME_MS,
  BUSY_LIMIT_MS,
  LOGIN_BADGE_KEY,
  NOTICE_MS,
  badgeResult,
  countBadge,
  createLoginBadge,
  memoryBadgeStorage,
  setActionBadge,
  type BadgeDetails,
} from "./badge";
import type { LoginReport } from "./runtime";
import type { SiteCount } from "./site-count";

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
// The tooltip of a choice after a logout in another tab, whatever the count.
const OTHER_TAB =
  "Pateat: you were logged out of this site in another tab, or the site did not accept a login there. Click to choose an account.";
const choose = (count: number) => `Pateat: ${count} accounts match this page. Click to choose one.`;
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

  it("ignores a signed-in page sample (ADR 0029)", () => {
    const sample = {
      type: "sample" as const,
      tabId: 1,
      origin: "https://login.example",
      recipeId: "synthetic-recipe",
      recipeRevision: 1,
      route: "password" as const,
    };
    for (const outcome of [
      "sent",
      "kept",
      "recent",
      "gone",
      "refused",
      "not-sent",
      "failed",
    ] as const)
      expect(badgeResult({ ...sample, outcome }, now)).toBeUndefined();
  });

  it("ignores a recipe revoked for an item that cannot run it (ADR 0058 A)", () => {
    const revoke = {
      type: "revoke" as const,
      tabId: 1,
      origin: "https://login.example",
      recipeId: "gen-0123456789abcdef0123456789abcdef",
      recipeRevision: 3,
      route: "passkey" as const,
      detail: "password-empty:no-advance",
    };
    for (const outcome of ["revoked", "conflict", "not-due", "not-sent", "failed"] as const)
      expect(badgeResult({ ...revoke, outcome }, now)).toBeUndefined();
  });

  it("shows an unconfirmed completion as unsettled for four seconds", () => {
    expect(badgeResult(attempt({ state: "authenticated", unconfirmed: true }), now)).toEqual({
      kind: "unsettled",
      reason: "unconfirmed",
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

  it.each(["challenge-abandoned", "watch-abandoned", "left-origin", "challenge", "unknown-submit"])(
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

describe("badgeResult for refusals", () => {
  const refusal = (
    reason: string,
    fields: { detail?: string; repeat?: true; unrelated?: true } = {},
  ): LoginReport => ({ type: "refused", tabId, origin, reason, ...fields });

  it.each(["no-route", "field-unavailable", "storage-unavailable", "attempt-limit"])(
    "keeps a failure for a %s refusal, naming its detail",
    (reason) => {
      expect(badgeResult(refusal(reason), 1000)).toEqual({ kind: "failed", reason });
      expect(badgeResult(refusal(reason, { detail: "password-empty:no-passkey" }), 1000)).toEqual({
        kind: "failed",
        reason: `${reason}: password-empty:no-passkey`,
      });
      expect(badgeResult(refusal(reason, { repeat: true }), 1000)).toBeUndefined();
      expect(badgeResult(refusal(reason, { unrelated: true }), 1000)).toBeUndefined();
    },
  );

  it.each(["no-recipe", "logged-in", "account-ambiguous", "origin-busy", "tab-busy", "logged-out"])(
    "shows nothing for a %s refusal",
    (reason) => {
      expect(badgeResult(refusal(reason, { detail: "x" }), 1000)).toBeUndefined();
    },
  );
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
  it("writes its tooltips in the extension's language, again when it changes (ADR 0043)", async () => {
    const h = harness();
    h.badge.choice(tabId, { count: 2 });
    h.badge.note(
      8,
      "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 5 minutes and reload this page, to log in here.",
    );
    await h.flush();
    expect(h.view()).toMatchObject({ text: "2", title: choose(2) });
    await i18n.changeLanguage("ja");
    onTestFinished(async () => {
      await i18n.changeLanguage("en");
    });
    h.badge.relabel();
    await h.flush();
    expect(h.view()).toMatchObject({
      text: "2",
      title: "Pateat：2 件のアカウントがこのページに一致します。クリックして選んでください。",
    });
    expect(h.view(8).title).toBe(
      "Pateat：別のタブでこのサイトへのログインが進行中か、成功していません。ここでログインするには、そのタブを閉じるか、最大 5 分待ってからこのページを再読み込みしてください。",
    );
    // An outcome code stays as the log names it inside the translated text.
    h.badge.choice(tabId, undefined);
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    await h.flush();
    expect(h.view().title).toBe(
      "Pateat：ログインに成功しませんでした（credential-rejected）。詳しくはクリックしてください。",
    );
  });

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

    h.badge.choice(tabId, { count: 3, logout: "this-tab" });
    await h.flush();
    expect(h.view()).toEqual({
      text: "3",
      ...CHOICE,
      title: "Pateat: you were logged out of this site in this tab. Click to choose an account.",
    });

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

  it("keeps the tab's badge through a revocation report (ADR 0058 A)", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    await h.flush();
    const before = h.view();
    expect(before).toMatchObject(FAILED);
    for (const outcome of ["revoked", "failed"] as const)
      h.badge.observe({
        type: "revoke",
        tabId,
        origin: "https://login.example",
        recipeId: "gen-0123456789abcdef0123456789abcdef",
        recipeRevision: 3,
        route: "passkey",
        outcome,
        detail: "password-empty:no-advance",
      });
    await h.flush();
    expect(h.view()).toEqual(before);
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
    h.badge.choice(tabId, { count: 2, logout: "other-tab" });
    await h.flush();
    h.badge.choice(tabId, { count: 3, logout: "other-tab" });
    await h.flush();
    h.badge.choice(tabId, { count: 3, logout: "other-tab" });
    await h.flush();
    expect(h.calls).toEqual([
      { tabId, text: "2", ...CHOICE, title: OTHER_TAB },
      { tabId, text: "3" },
    ]);
    // A change that is undone before its write runs writes nothing.
    h.badge.choice(tabId, { count: 4, logout: "other-tab" });
    h.badge.choice(tabId, { count: 3, logout: "other-tab" });
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

  it("persists results and spinning tabs", async () => {
    const h = harness();
    expect(LOGIN_BADGE_KEY).toMatch(/^session:/);
    h.badge.observe(attempt({ outcome: "timeout", cause: "elements-timeout" }));
    const stop = h.badge.spin(8);
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, { kind: "failed", origin, reason: "timeout: elements-timeout" }]],
      busy: [8],
      statuses: [
        [
          tabId,
          { origin, login: { state: "blocked", outcome: "timeout", cause: "elements-timeout" } },
        ],
      ],
    });
    stop();
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, expect.objectContaining({ kind: "failed" })]],
      busy: [],
      statuses: [[tabId, expect.objectContaining({ origin })]],
    });
  });

  it("keeps that a login only filled the form after a logout", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "cancelled", reason: "fill-only" }));
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statuses: [
          [tabId, { origin, login: { state: "blocked", outcome: "cancelled", fillOnly: true } }],
        ],
      }),
    );
    // A later login of the tab that is not fill-only drops it.
    h.badge.observe(attempt({ state: "ready" }));
    await h.flush();
    expect(h.setValue).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: [[tabId, { origin, login: { state: "ready" } }]] }),
    );
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
        statuses: [],
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
      statuses: [],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.view(2)).toMatchObject(NONE);
    expect(await h.storage.getValue()).toEqual({
      results: [[1, { kind: "failed", origin, reason: "timeout" }]],
      busy: [],
      statuses: [],
    });
  });

  it("keeps a result reported before the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.badge.restore();
    await h.flush();
    expect(h.view()).toMatchObject(SUCCEEDED);
  });

  it("does not bring back a stored result for a tab whose login started during the restore", async () => {
    const h = harness({
      stored: {
        results: [
          [tabId, { kind: "failed", origin, reason: "timeout" }],
          [8, { kind: "failed", origin, reason: "timeout" }],
          [9, { kind: "failed", origin, reason: "timeout" }],
        ],
        busy: [],
        statuses: [],
      },
    });
    const restoring = h.badge.restore();
    h.badge.observe(start());
    h.badge.removed(8);
    await restoring;
    await h.flush();
    expect(h.view(tabId)).toMatchObject(NONE);
    expect(h.view(9)).toMatchObject(FAILED);
    expect(await h.storage.getValue()).toEqual({
      results: [[9, { kind: "failed", origin, reason: "timeout" }]],
      busy: [],
      // The started login is the tab's page status now.
      statuses: [[tabId, { origin, login: { state: "started" } }]],
    });
  });

  it("does not bring back a stored result for a tab whose top origin changed during the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    h.badge.loaded(tabId, `${origin}/`);
    const restoring = h.badge.restore();
    h.badge.loaded(tabId, "https://other.example/");
    await restoring;
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("does not bring back a stored result for a tab that first loaded another origin during the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    const restoring = h.badge.restore();
    h.badge.loaded(tabId, "https://other.example/");
    await restoring;
    await h.flush();
    expect(h.calls.filter((call) => call.text === "!")).toEqual([]);
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("keeps a stored result for a tab that loaded its origin during the restore", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    const restoring = h.badge.restore();
    h.badge.loaded(tabId, `${origin}/account`);
    await restoring;
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
  });

  it("clears a restored result when the tab's first load after the restore is another origin", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    await h.badge.restore();
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    h.badge.loaded(tabId, "https://other.example/");
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("keeps a restored result when the tab's first load after the restore is its origin", async () => {
    const h = harness({
      stored: {
        results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [],
      },
    });
    await h.badge.restore();
    await h.flush();
    const count = h.calls.length;
    h.badge.loaded(tabId, `${origin}/account`);
    await h.flush();
    expect(h.calls.slice(count)).toEqual([{ tabId, ...FAILED, title: expect.any(String) }]);
    expect(await h.storage.getValue()).toMatchObject({ results: [[tabId, { kind: "failed" }]] });
  });

  it.each([
    ["nothing", undefined],
    [
      "a malformed value",
      { results: [[1, { kind: "lost", origin, reason: "x" }]], busy: [], statuses: [] },
    ],
    ["a fractional tab", { results: [], busy: [1.5], statuses: [] }],
    [
      "a value without statuses",
      { results: [[1, { kind: "failed", origin, reason: "timeout" }]], busy: [] },
    ],
    [
      "a malformed status",
      {
        results: [[1, { kind: "failed", origin, reason: "timeout" }]],
        busy: [],
        statuses: [[1, { origin, generation: { outcome: "sent", page: "other" } }]],
      },
    ],
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

describe("page status", () => {
  type Generation = Extract<LoginReport, { type: "generation" }>;
  const report = (fields: Partial<Generation> & Pick<Generation, "outcome">): Generation => ({
    type: "generation",
    tabId,
    origin,
    ...fields,
  });

  it("records a login's start, then each state, outcome and cause", () => {
    const h = harness();
    expect(h.badge.status(tabId)).toBeUndefined();
    h.badge.observe(start());
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "started" } });
    h.badge.observe(attempt({ state: "executing" }));
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "executing" } });
    h.badge.observe(attempt({ outcome: "timeout", cause: "elements-timeout" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "blocked", outcome: "timeout", cause: "elements-timeout" },
    });
    // A new login starts afresh: no outcome or cause of the one before stays.
    h.badge.observe(start());
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "started" } });
    // Another tab keeps its own.
    h.badge.observe(attempt({ tabId: 8, state: "authenticated" }));
    expect(h.badge.status(8)).toEqual({ origin, login: { state: "authenticated" } });
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "started" } });
  });

  it("ignores repeat attempts, ordinary refusals and choices", () => {
    const h = harness();
    h.badge.observe(attempt({ state: "executing" }));
    h.badge.observe(attempt({ state: "authenticated", repeat: true }));
    h.badge.observe(attempt({ outcome: "timeout", repeat: true }));
    h.badge.observe(refused("no-recipe"));
    h.badge.observe({ type: "choice", tabId, origin, outcome: "saved" });
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "executing" } });
    h.badge.observe(refused("no-recipe"));
    expect(h.badge.status(8)).toBeUndefined();
  });

  it("records a model request and what came back, but not a skipped one", () => {
    const h = harness();
    h.badge.observe(report({ outcome: "skipped", reason: "sent" }));
    expect(h.badge.status(tabId)).toBeUndefined();
    h.badge.observe(report({ outcome: "sent" }));
    expect(h.badge.status(tabId)).toEqual({ origin, generation: { outcome: "sent" } });
    h.badge.observe(report({ outcome: "failed", reason: "invalid-output", check: "schema" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      generation: { outcome: "failed", reason: "invalid-output" },
    });
    // A skip leaves the last request as it was.
    h.badge.observe(report({ outcome: "skipped", reason: "not-connected" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      generation: { outcome: "failed", reason: "invalid-output" },
    });
  });

  it.each([
    ["a list of accounts", { page: "accounts" as const }, "accounts"],
    ["a sign-in entry", { page: "entry" as const }, "entry"],
    ["a continuation", { recipeId: "recipe", baseRevision: 1 }, "continuation"],
    [
      "a chooser's other branch page",
      { page: "other" as const, recipeId: "r", baseRevision: 1 },
      "continuation",
    ],
    ["a list of accounts after a recipe", { page: "accounts" as const, recipeId: "r" }, "accounts"],
    ["a sign-in page", {}, undefined],
  ])("tells %s apart", (_name, fields, page) => {
    const h = harness();
    h.badge.observe(report({ outcome: "recipe", ...fields }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      generation: page ? { outcome: "recipe", page } : { outcome: "recipe" },
    });
  });

  it("keeps a login and a model request of one origin together", () => {
    const h = harness();
    h.badge.observe(report({ outcome: "recipe" }));
    h.badge.observe(attempt({ state: "authenticated" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "authenticated" },
      generation: { outcome: "recipe" },
    });
    h.badge.observe(start());
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "started" },
      generation: { outcome: "recipe" },
    });
  });

  it("starts afresh for a report of another origin before any load", () => {
    const h = harness();
    h.badge.observe(attempt({ state: "authenticated" }));
    h.badge.observe(report({ origin: "https://other.example", outcome: "sent" }));
    expect(h.badge.status(tabId)).toEqual({
      origin: "https://other.example",
      generation: { outcome: "sent" },
    });
  });

  it("gives a frame's reports the tab's top origin and keeps them together", () => {
    const h = harness();
    h.badge.loaded(tabId, "https://shop.example/checkout");
    h.badge.observe(report({ outcome: "sent" }));
    h.badge.observe(attempt({ origin: "https://frame.example", state: "executing" }));
    expect(h.badge.status(tabId)).toEqual({
      origin: "https://shop.example",
      login: { state: "executing" },
      generation: { outcome: "sent" },
    });
  });

  it("keeps the status on same-origin loads and drops it on a top-origin change", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/signin`);
    h.badge.observe(attempt({ outcome: "credential-rejected" }));
    h.badge.loaded(tabId, `${origin}/again`);
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "blocked", outcome: "credential-rejected" },
    });
    h.badge.loaded(tabId, "https://other.example/");
    expect(h.badge.status(tabId)).toBeUndefined();
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });

    // A status without a result is dropped and saved too.
    h.badge.observe(report({ origin: "https://other.example", outcome: "sent" }));
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({ statuses: [[tabId, expect.anything()]] });
    h.badge.loaded(tabId);
    expect(h.badge.status(tabId)).toBeUndefined();
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("starts afresh after a top-origin change and back", () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(report({ outcome: "recipe" }));
    h.badge.loaded(tabId, "https://other.example/");
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(attempt({ state: "executing" }));
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "executing" } });
  });

  it("drops a removed tab's status", async () => {
    const h = harness();
    h.badge.observe(report({ outcome: "sent" }));
    await h.flush();
    h.setValue.mockClear();
    h.badge.removed(tabId);
    expect(h.badge.status(tabId)).toBeUndefined();
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(1);
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [] });
  });

  it("moves a replaced tab's status to its new ID", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.observe(report({ outcome: "abstained", reason: "no-form" }));
    h.badge.replaced(8, tabId);
    expect(h.badge.status(tabId)).toBeUndefined();
    expect(h.badge.status(8)).toEqual({
      origin,
      generation: { outcome: "abstained", reason: "no-form" },
    });
    await h.flush();
    expect(await h.storage.getValue()).toEqual({
      results: [],
      busy: [],
      statuses: [[8, { origin, generation: { outcome: "abstained", reason: "no-form" } }]],
    });
    // The new tab keeps the top origin: a later report merges, another origin drops it.
    h.badge.observe(attempt({ tabId: 8, origin: "https://frame.example", state: "executing" }));
    expect(h.badge.status(8)).toMatchObject({ origin, login: { state: "executing" } });
    h.badge.loaded(8, "https://other.example/");
    expect(h.badge.status(8)).toBeUndefined();
  });

  it("saves once per report, and not when the status stays", async () => {
    const h = harness();
    // A result and a status from one report share one save.
    h.badge.observe(attempt({ outcome: "timeout" }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(1);
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, { kind: "failed", origin, reason: "timeout" }]],
      busy: [],
      statuses: [[tabId, { origin, login: { state: "blocked", outcome: "timeout" } }]],
    });
    // A start clears the result and records the start: one save.
    h.badge.observe(start());
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(2);
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [],
      busy: [],
      statuses: [[tabId, { origin, login: { state: "started" } }]],
    });
    // A second start changes nothing.
    h.badge.observe(start());
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(2);
    // A status change without a result change saves once.
    h.badge.observe(report({ outcome: "sent" }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(3);
    // The same request again, a skip, or a repeat changes nothing.
    h.badge.observe(report({ outcome: "sent" }));
    h.badge.observe(report({ outcome: "skipped", reason: "sent" }));
    h.badge.observe(attempt({ state: "executing", repeat: true }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(3);
    // A failed request sets both result and status: one save.
    h.badge.observe(report({ outcome: "failed", reason: "invalid-output" }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(4);
    expect(h.setValue).toHaveBeenLastCalledWith({
      results: [[tabId, { kind: "failed", origin, reason: "generation failed: invalid-output" }]],
      busy: [],
      statuses: [
        [
          tabId,
          {
            origin,
            login: { state: "started" },
            generation: { outcome: "failed", reason: "invalid-output" },
          },
        ],
      ],
    });
  });

  const refusal = (
    reason: string,
    fields: { detail?: string; repeat?: true; unrelated?: true; tabId?: number } = {},
  ): LoginReport => ({ type: "refused", tabId, origin, reason, ...fields });

  it("records a refusal that stops a login until the next login starts", async () => {
    const h = harness();
    h.badge.observe(attempt({ outcome: "timeout" }));
    h.badge.observe(refusal("no-route", { detail: "password-empty:no-advance" }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "blocked", outcome: "timeout" },
      refused: { reason: "no-route", detail: "password-empty:no-advance" },
    });
    // Another such refusal replaces it.
    h.badge.observe(refusal("attempt-limit"));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "blocked", outcome: "timeout" },
      refused: { reason: "attempt-limit" },
    });
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({
      statuses: [[tabId, { refused: { reason: "attempt-limit" } }]],
    });
    h.badge.observe(start());
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "started" } });
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({
      statuses: [[tabId, { origin, login: { state: "started" } }]],
    });
  });

  it("drops a refusal once a login of the tab moves on, but not on a repeat attempt", () => {
    const h = harness();
    h.badge.observe(attempt({ state: "executing" }));
    h.badge.observe(refusal("storage-unavailable"));
    h.badge.observe(attempt({ state: "awaiting-result", repeat: true }));
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "executing" },
      refused: { reason: "storage-unavailable" },
    });
    h.badge.observe(attempt({ state: "authenticated" }));
    expect(h.badge.status(tabId)).toEqual({ origin, login: { state: "authenticated" } });
    // A model request leaves a refusal in place.
    h.badge.observe(refusal("no-route"));
    h.badge.observe(report({ outcome: "sent" }));
    expect(h.badge.status(tabId)?.refused).toEqual({ reason: "no-route" });
  });

  it("ignores ordinary, unrelated and repeat refusals", async () => {
    const h = harness();
    h.badge.observe(refusal("no-recipe"));
    h.badge.observe(refusal("logged-in"));
    h.badge.observe(refusal("no-route", { unrelated: true }));
    expect(h.badge.status(tabId)).toBeUndefined();
    await h.flush();
    expect(h.setValue).not.toHaveBeenCalled();

    h.badge.observe(refusal("field-unavailable", { detail: "custom" }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(1);
    expect(h.view()).toMatchObject(FAILED);
    // A repeat, even with another detail, is not kept and saves nothing.
    h.badge.observe(refusal("field-unavailable", { detail: "custom", repeat: true }));
    h.badge.observe(refusal("field-unavailable", { detail: "other", repeat: true }));
    h.badge.observe(refusal("attempt-limit", { repeat: true }));
    await h.flush();
    expect(h.setValue).toHaveBeenCalledTimes(1);
    expect(h.badge.status(tabId)?.refused).toEqual({
      reason: "field-unavailable",
      detail: "custom",
    });
    expect(h.view().title).toContain("field-unavailable: custom");
    // A repeat on another tab records nothing there either.
    h.badge.observe(refusal("no-route", { repeat: true, tabId: 8 }));
    expect(h.badge.status(8)).toBeUndefined();
  });

  it("records a logout of the tab, and whether the site rejected the login", async () => {
    const h = harness();
    const logout = (rejected?: true): LoginReport => ({
      type: "logout",
      tabId,
      origin,
      recipeId: "recipe",
      recipeRevision: 1,
      ...(rejected ? { rejected } : {}),
    });
    h.badge.observe(report({ outcome: "recipe" }));
    h.badge.observe(attempt({ state: "authenticated" }));
    h.badge.observe(logout());
    expect(h.badge.status(tabId)).toEqual({
      origin,
      login: { state: "logged-out" },
      generation: { outcome: "recipe" },
    });
    h.badge.observe(logout(true));
    expect(h.badge.status(tabId)?.login).toEqual({ state: "logged-out", outcome: "rejected" });
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({
      statuses: [[tabId, { login: { state: "logged-out", outcome: "rejected" } }]],
    });
    // The same logout again saves nothing; a new login replaces it.
    h.setValue.mockClear();
    h.badge.observe(logout(true));
    await h.flush();
    expect(h.setValue).not.toHaveBeenCalled();
    h.badge.observe(start());
    expect(h.badge.status(tabId)?.login).toEqual({ state: "started" });
  });

  it("tells whether a model request for the tab is in flight, as its spin shows", async () => {
    const h = harness();
    expect(h.badge.asking(tabId)).toBe(false);
    const first = h.badge.spin(tabId);
    const second = h.badge.spin(tabId);
    expect(h.badge.asking(tabId)).toBe(true);
    expect(h.badge.asking(8)).toBe(false);
    first();
    expect(h.badge.asking(tabId)).toBe(true);
    second();
    expect(h.badge.asking(tabId)).toBe(false);
    // A spin moves with a replaced tab and ends on its own after two minutes.
    h.badge.spin(tabId);
    h.badge.replaced(8, tabId);
    expect(h.badge.asking(tabId)).toBe(false);
    expect(h.badge.asking(8)).toBe(true);
    await vi.advanceTimersByTimeAsync(BUSY_LIMIT_MS);
    expect(h.badge.asking(8)).toBe(false);
    // A closed tab asks nothing.
    h.badge.spin(9);
    h.badge.removed(9);
    expect(h.badge.asking(9)).toBe(false);
  });

  it("does not restore a spin a stopped worker left as a request in flight", async () => {
    const h = harness({ stored: { results: [], busy: [tabId], statuses: [] } });
    await h.badge.restore();
    expect(h.badge.asking(tabId)).toBe(false);
  });

  // Netflix in the owner's Chrome (value-free log): the page went to the AI, a recipe came
  // back, and the login was refused as the only item has neither a password nor a passkey.
  // The spin ended without a badge before.
  it.each([
    ["after the spin ends", false],
    ["while the spin still runs", true],
  ])("shows a failure for a recipe the vault item cannot use, %s", async (_name, during) => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/login`);
    const stop = h.badge.spin(tabId);
    h.badge.observe(report({ outcome: "sent" }));
    await h.flush();
    expect(h.view()).toMatchObject({ ...BUSY, title: "Pateat: asking the AI…" });
    h.badge.observe(report({ outcome: "recipe" }));
    if (!during) stop();
    h.badge.observe(refusal("no-route", { detail: "password-empty:no-passkey" }));
    if (during) stop();
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    expect(h.view().title).toBe(
      "Pateat: the login did not succeed (no-route: password-empty:no-passkey). Click for details.",
    );
    // A failure stays.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.view()).toMatchObject(FAILED);
    expect(h.badge.status(tabId)).toEqual({
      origin,
      refused: { reason: "no-route", detail: "password-empty:no-passkey" },
      generation: { outcome: "recipe" },
    });
    expect(await h.storage.getValue()).toEqual({
      results: [[tabId, { kind: "failed", origin, reason: "no-route: password-empty:no-passkey" }]],
      busy: [],
      statuses: [
        [
          tabId,
          {
            origin,
            generation: { outcome: "recipe" },
            refused: { reason: "no-route", detail: "password-empty:no-passkey" },
          },
        ],
      ],
    });
  });

  it("restores a stored refusal", async () => {
    const status = {
      origin,
      refused: { reason: "no-route", detail: "password-empty:no-passkey" },
      generation: { outcome: "recipe" },
    };
    const h = harness({ stored: { results: [], busy: [], statuses: [[tabId, status]] } });
    await h.badge.restore();
    expect(h.badge.status(tabId)).toEqual(status);
  });

  const stored = (statuses: unknown[], results: unknown[] = []) => ({
    stored: { results, busy: [], statuses },
  });
  const kept = { origin, login: { state: "blocked", outcome: "timeout" } };

  it("restores stored statuses, and the next load compares with their origin", async () => {
    const h = harness(
      stored([
        [tabId, kept],
        [8, { origin: "https://other.example", generation: { outcome: "sent", page: "entry" } }],
      ]),
    );
    await h.badge.restore();
    expect(h.badge.status(tabId)).toEqual(kept);
    expect(h.badge.status(8)).toEqual({
      origin: "https://other.example",
      generation: { outcome: "sent", page: "entry" },
    });
    await h.flush();
    expect(await h.storage.getValue()).toMatchObject({
      statuses: [
        [tabId, kept],
        [8, {}],
      ],
    });
    // A status writes no badge.
    expect(h.calls).toEqual([]);

    // The restore seeded the top origin: a same-origin load keeps the status, another drops it.
    h.badge.loaded(tabId, `${origin}/account`);
    expect(h.badge.status(tabId)).toEqual(kept);
    h.badge.loaded(tabId, "https://elsewhere.example/");
    expect(h.badge.status(tabId)).toBeUndefined();
    // And a frame's later report takes the seeded top origin.
    h.badge.observe(attempt({ tabId: 8, state: "executing" }));
    expect(h.badge.status(8)).toEqual({
      origin: "https://other.example",
      login: { state: "executing" },
      generation: { outcome: "sent", page: "entry" },
    });
  });

  it("keeps a status recorded before or during the restore", async () => {
    const h = harness(
      stored([
        [tabId, kept],
        [8, kept],
        [9, kept],
        [10, kept],
      ]),
    );
    h.badge.observe(report({ outcome: "sent" }));
    const restoring = h.badge.restore();
    h.badge.observe(attempt({ tabId: 8, state: "executing" }));
    h.badge.removed(9);
    await restoring;
    expect(h.badge.status(tabId)).toEqual({ origin, generation: { outcome: "sent" } });
    expect(h.badge.status(8)).toEqual({ origin, login: { state: "executing" } });
    expect(h.badge.status(9)).toBeUndefined();
    expect(h.badge.status(10)).toEqual(kept);
  });

  it("does not bring back a status for a tab whose top origin differs", async () => {
    const h = harness(
      stored([
        [tabId, kept],
        [8, kept],
        [9, kept],
      ]),
    );
    h.badge.loaded(tabId, "https://other.example/");
    const restoring = h.badge.restore();
    h.badge.loaded(8, "https://other.example/");
    h.badge.loaded(9, `${origin}/account`);
    await restoring;
    expect(h.badge.status(tabId)).toBeUndefined();
    expect(h.badge.status(8)).toBeUndefined();
    expect(h.badge.status(9)).toEqual(kept);
    await h.flush();
    expect(await h.storage.getValue()).toEqual({ results: [], busy: [], statuses: [[9, kept]] });
  });

  it("does not bring back a status for a tab replaced during the restore", async () => {
    const h = harness(stored([[8, kept]]));
    const restoring = h.badge.restore();
    h.badge.replaced(8, tabId);
    await restoring;
    expect(h.badge.status(8)).toBeUndefined();
  });

  it("restores a status beside the tab's result", async () => {
    const h = harness(
      stored([[tabId, kept]], [[tabId, { kind: "failed", origin, reason: "timeout" }]]),
    );
    await h.badge.restore();
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    expect(h.badge.status(tabId)).toEqual(kept);
  });
});

it("retains unconfirmed popup details across a worker restart after the notice expires", async () => {
  const h = harness();
  h.badge.observe(attempt({ state: "authenticated", outcome: "authenticated", unconfirmed: true }));
  await h.flush();
  expect(h.view()).toMatchObject(UNSETTLED);
  await vi.advanceTimersByTimeAsync(NOTICE_MS);
  expect(h.view().text).toBe("");
  const restarted = harness({ stored: await h.storage.getValue() });
  await restarted.badge.restore();
  expect(restarted.badge.status(tabId)).toEqual({
    origin,
    login: { state: "authenticated", outcome: "authenticated", unconfirmed: true },
  });
});

describe("site count", () => {
  const TEAL = { color: "#115e59", textColor: "#ffffff" };
  const GRAY = { color: "#cbd5e1", textColor: "#1e293b" };
  const counted = (usable: number, matching = usable, more: Partial<SiteCount> = {}) =>
    ({ kind: "count", count: { usable, matching, unevaluated: 0, ...more } }) as const;

  it("shows the usable count in teal and how many more are excluded", async () => {
    const h = harness();
    h.badge.count(tabId, origin, counted(2, 3, { excluded: "items" }));
    await h.flush();
    expect(h.view()).toEqual({
      text: "2",
      ...TEAL,
      title: "Pateat: 2 accounts for this site. 1 more is excluded in settings.",
    });
    // Quarantined items are named as waiting for a review, not as excluded.
    expect(countBadge(counted(1, 3, { excluded: "review" })).title).toBe(
      "Pateat: 1 account for this site. 2 more wait for a custom-field review in settings.",
    );
    expect(countBadge(counted(1, 3, { excluded: "items-review" })).title).toBe(
      "Pateat: 1 account for this site. 2 more are excluded or wait for a custom-field review in settings.",
    );
  });

  it.each([
    ["site", "this site is excluded in settings"],
    ["items", "they are excluded in settings"],
    ["review", "they wait for a custom-field review in settings"],
  ] as const)("shows matches that are all excluded (%s) in gray", async (excluded, why) => {
    const h = harness();
    h.badge.count(tabId, origin, counted(0, 3, { excluded }));
    await h.flush();
    expect(h.view()).toEqual({
      text: "3",
      ...GRAY,
      title: `Pateat: 3 accounts match this site, but none can be used: ${why}.`,
    });
  });

  it("writes the count's sentences in Japanese without spaces between them (ADR 0043)", () => {
    const ja = i18n.getFixedT("ja");
    expect(countBadge(counted(2, 3, { excluded: "review", unevaluated: 1 }), ja).title).toBe(
      "Pateat：このサイトのアカウントは 2 件です。ほかに 1 件が設定でカスタムフィールドの確認待ちです。1 件のアイテムを確認できませんでした。",
    );
    expect(countBadge(counted(0, 1, { excluded: "site" }), ja).title).toBe(
      "Pateat：このサイトに一致するアカウントが 1 件ありますが、このサイトは設定で除外されているため使えません。",
    );
    expect(countBadge({ kind: "unchecked", reason: "locked" }, ja).title).toBe(
      "Pateat：保管庫がロックされているため、このサイトのアカウントを数えていません。",
    );
  });

  it("caps the number at 99+ and notes items whose rules could not be checked", async () => {
    const h = harness();
    h.badge.count(tabId, origin, counted(120, 120, { unevaluated: 1 }));
    await h.flush();
    expect(h.view()).toEqual({
      text: "99+",
      ...TEAL,
      title: "Pateat: 120 accounts for this site. 1 item could not be checked.",
    });
    expect(countBadge(counted(1)).title).toBe("Pateat: 1 account for this site.");
  });

  it("shows no number for no match or a vault it could not check, saying why", async () => {
    const h = harness();
    h.badge.count(tabId, origin, counted(0));
    await h.flush();
    expect(h.view()).toMatchObject({ text: "", title: "Pateat: no account for this site." });
    h.badge.count(tabId, origin, { kind: "unchecked", reason: "not-opened" });
    await h.flush();
    expect(h.view()).toMatchObject({
      text: "",
      title:
        "Pateat: the vault has not been opened since Pateat restarted, so this site's accounts were not counted.",
    });
    // A count a login or a page check stopped says it is tried again, not blank.
    expect(countBadge({ kind: "unchecked", reason: "busy" })).toEqual({
      title:
        "Pateat: a login or a page check was using the vault, so this site's accounts were not counted yet.",
    });
    h.badge.count(tabId, origin, undefined);
    await h.flush();
    expect(h.view()).toMatchObject(NONE);
  });

  it("a waiting choice and a brief result win over the count, which comes back", async () => {
    const h = harness();
    h.badge.count(tabId, origin, counted(2));
    h.badge.choice(tabId, { count: 2 });
    await h.flush();
    expect(h.view()).toMatchObject({
      text: "2",
      ...CHOICE,
      title: "Pateat: 2 accounts match this page. Click to choose one.",
    });
    h.badge.choice(tabId, undefined);
    await h.flush();
    expect(h.view()).toMatchObject({ text: "2", ...TEAL });
    h.badge.observe(attempt({ state: "authenticated" }));
    await h.flush();
    expect(h.view()).toMatchObject(SUCCEEDED);
    await vi.advanceTimersByTimeAsync(NOTICE_MS);
    expect(h.view()).toMatchObject({ text: "2", ...TEAL });
  });

  it("a spin and a failure win over the count until they end (ADR 0038)", async () => {
    const h = harness();
    h.badge.count(tabId, origin, counted(2));
    const stop = h.badge.spin(tabId);
    await h.flush();
    expect(h.view()).toMatchObject(BUSY);
    stop();
    await h.flush();
    expect(h.view()).toMatchObject({ text: "2", ...TEAL });
    h.badge.observe(attempt({ state: "blocked", outcome: "credential-rejected" }));
    await h.flush();
    expect(h.view()).toMatchObject(FAILED);
    // A new login clears the failure, and the count shows again.
    h.badge.observe(start());
    await h.flush();
    expect(h.view()).toMatchObject({ text: "2", ...TEAL });
  });

  it("keeps a held login's tooltip over the count's title", async () => {
    const h = harness();
    h.badge.count(tabId, origin, counted(1));
    h.badge.note(tabId, "held");
    await h.flush();
    expect(h.view()).toMatchObject({ text: "1", ...TEAL, title: "held" });
  });

  it("is written again after a load of the same origin and dropped for another", async () => {
    const h = harness();
    h.badge.loaded(tabId, `${origin}/`);
    h.badge.count(tabId, origin, counted(2));
    await h.flush();
    const writes = h.calls.length;
    h.badge.loaded(tabId, `${origin}/next`);
    await h.flush();
    expect(h.calls.length).toBeGreaterThan(writes);
    expect(h.view()).toMatchObject({ text: "2", ...TEAL });
    // A count for the page before does not land on the new one.
    h.badge.loaded(tabId, "https://other.example/");
    h.badge.count(tabId, origin, counted(5));
    await h.flush();
    expect(h.view().text).not.toBe("5");
    h.badge.count(tabId, "https://other.example", counted(1));
    await h.flush();
    expect(h.view()).toMatchObject({ text: "1", ...TEAL });
  });

  it("moves with a replaced tab and goes with a closed one", async () => {
    const h = harness();
    h.badge.count(tabId, origin, counted(3));
    h.badge.replaced(8, tabId);
    await h.flush();
    expect(h.view(8)).toMatchObject({ text: "3", ...TEAL });
    h.badge.removed(8);
    h.badge.loaded(8, `${origin}/`);
    await h.flush();
    expect(h.view(8).text).toBe("3");
    expect(h.calls.filter((call) => call.tabId === 8)).toHaveLength(1);
  });
});
