import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import {
  BUSY_LIMIT_MS,
  NOTICE_MS,
  badgeResult,
  countBadge,
  createLoginBadge,
  memoryBadgeStorage,
  setActionBadge,
  type BadgeDetails,
} from "./badge";
import type { LoginReport } from "./runtime/report";
import type { SiteCount } from "./site-count";
import { registerPersistenceCases } from "../../test/login/badge/persistence-cases";
import { registerPresentationCases } from "../../test/login/badge/presentation-cases";
import { registerStatusRecordingCases } from "../../test/login/badge/status-recording-cases";
import { registerWritesNavigationCases } from "../../test/login/badge/writes-navigation-cases";

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
// The tooltip of a choice after a rejection in another tab, whatever the count.
const OTHER_TAB =
  "Pateat: the site did not accept a login in another tab. Click to choose an account.";
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

export type BadgeTestFixtures = {
  harness: typeof harness;
  attempt: typeof attempt;
  start: typeof start;
  origin: typeof origin;
  tabId: typeof tabId;
  NONE: typeof NONE;
  choose: typeof choose;
  CHOICE: typeof CHOICE;
  BUSY: typeof BUSY;
  FAILED: typeof FAILED;
  SUCCEEDED: typeof SUCCEEDED;
  UNSETTLED: typeof UNSETTLED;
  OTHER_TAB: typeof OTHER_TAB;
  refused: typeof refused;
};

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

  it("ignores a repair claimed for an item that cannot run its recipe (ADR 0058 A)", () => {
    const unfit = {
      type: "unfit" as const,
      tabId: 1,
      origin: "https://login.example",
      recipeId: "gen-0123456789abcdef0123456789abcdef",
      recipeRevision: 3,
      route: "passkey" as const,
      detail: "password-empty:no-advance",
    };
    for (const outcome of ["claimed", "not-due", "not-sent"] as const)
      expect(badgeResult({ ...unfit, outcome }, now)).toBeUndefined();
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

  it.each([
    "no-recipe",
    "logged-in",
    "account-ambiguous",
    "account-asked",
    "relogin-limit",
    "origin-busy",
    "tab-busy",
  ])("shows nothing for a %s refusal", (reason) => {
    expect(badgeResult(refusal(reason, { detail: "x" }), 1000)).toBeUndefined();
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
  registerPresentationCases({
    harness,
    attempt,
    start,
    origin,
    tabId,
    NONE,
    choose,
    CHOICE,
    BUSY,
    FAILED,
    SUCCEEDED,
    UNSETTLED,
  });

  registerWritesNavigationCases({
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
  });

  registerPersistenceCases({ harness, attempt, start, origin, tabId, NONE, FAILED, SUCCEEDED });
});

describe("page status", () => {
  type Generation = Extract<LoginReport, { type: "generation" }>;
  const report = (fields: Partial<Generation> & Pick<Generation, "outcome">): Generation => ({
    type: "generation",
    tabId,
    origin,
    ...fields,
  });

  registerStatusRecordingCases({ harness, attempt, start, refused, origin, tabId, report });

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
    ["not-allowed", "this site is not an allowed site in settings"],
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
