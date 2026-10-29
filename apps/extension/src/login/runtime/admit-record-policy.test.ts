import { describe, expect, it } from "vitest";
import type { LoginAttemptMetadata } from "@pateat/contracts";
import { nextRecordStep, type RecordPage, type RecordPhase } from "./admit-record-policy";

const origin = "https://login.example.com";
const now = 4_000_000;
const phases: RecordPhase[] = [
  "fill-only",
  "watch",
  "abandon-watch",
  "pause",
  "finished",
  "finished-confirmed",
  "stopped",
  "submitted",
  "submitted-confirmed",
  "submitted-withdrawn",
  "done",
];

function record(overrides: Partial<LoginAttemptMetadata> = {}): LoginAttemptMetadata {
  return {
    version: 1,
    id: "attempt",
    recipeId: "recipe",
    recipeRevision: 1,
    policyRevision: 1,
    account: { origin, connectionId: "connection", itemId: "item" },
    route: "password",
    facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
    handlers: [],
    document: { origin, tabId: 1, frameId: 0, documentId: "earlier" },
    state: "executing",
    stepIndex: 0,
    stepCount: 1,
    submissions: 1,
    maxSubmissions: 1,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    changedAt: now - 300_000,
    timing: { since: now, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
    ...overrides,
  };
}

function page(overrides: Partial<RecordPage> = {}): RecordPage {
  return {
    frameId: 0,
    documentId: "current",
    showsFirstStep: true,
    hasTopUrl: false,
    paused: false,
    probe: false,
    pickedAttemptId: undefined,
    ...overrides,
  };
}

describe("ordered record phases", () => {
  it.each(phases)("finishes immediately with no record at %s", (phase) => {
    expect(nextRecordStep(undefined, page(), { phase }, now)).toEqual({ kind: "done" });
  });

  it("visits the ordinary phases once, skipping read phases that do not apply", () => {
    const entry = record();
    const input = page();
    const expected = [
      ["fill-only", { kind: "advance", next: "watch" }],
      ["watch", { kind: "advance", next: "abandon-watch" }],
      ["abandon-watch", { kind: "advance", next: "pause" }],
      ["pause", { kind: "advance", next: "finished" }],
      ["finished", { kind: "advance", next: "stopped" }],
      ["stopped", { kind: "advance", next: "submitted" }],
      ["submitted", { kind: "advance", next: "done" }],
      ["done", { kind: "done" }],
    ] as const;
    for (const [phase, action] of expected)
      expect(nextRecordStep(entry, input, { phase }, now)).toEqual(action);
  });

  it.each([
    ["executing", false],
    ["watching", false],
    ["blocked", true],
    ["authenticated", true],
  ] as const)("forgets fill-only %s only after it ends", (state, forget) => {
    expect(
      nextRecordStep(record({ state, fillOnly: true }), page(), { phase: "fill-only" }, now),
    ).toEqual({ kind: forget ? "forget-fill-only" : "advance", next: "watch" });
    expect(nextRecordStep(record({ state }), page(), { phase: "fill-only" }, now)).toEqual({
      kind: "advance",
      next: "watch",
    });
  });

  it.each([
    [-1, "end-watch"],
    [0, "advance"],
    [599_999, "advance"],
    [600_000, "end-watch"],
  ] as const)("ends a watch at age %i, including clock rollback", (age, kind) => {
    const entry = record({
      state: "watching",
      watch: { since: now - age, documentId: "watch-page", pages: 0 },
    });
    expect(nextRecordStep(entry, page(), { phase: "watch" }, now)).toEqual({
      kind,
      next: "abandon-watch",
    });
  });

  it("uses the updated record after expiry before abandonment or a pause is considered", () => {
    const watched = record({
      state: "watching",
      watch: { since: now - 600_000, documentId: "watch-page", pages: 0 },
    });
    expect(nextRecordStep(watched, page({ paused: true }), { phase: "watch" }, now)).toEqual({
      kind: "end-watch",
      next: "abandon-watch",
    });
    const ended = record({ state: "blocked", outcome: "timeout", watch: undefined });
    expect(
      nextRecordStep(
        ended,
        page({ paused: true }),
        { phase: "abandon-watch", watchEnded: "watch-page" },
        now,
      ),
    ).toEqual({ kind: "advance", next: "pause" });
    expect(
      nextRecordStep(
        ended,
        page({ paused: true }),
        { phase: "pause", watchEnded: "watch-page" },
        now,
      ),
    ).toEqual({ kind: "advance", next: "finished" });
    expect(
      nextRecordStep(ended, page(), { phase: "submitted", watchEnded: "watch-page" }, now),
    ).toEqual({
      kind: "read-confirm",
      read: true,
      rejectedHere: false,
      next: "submitted-confirmed",
    });
  });

  it.each([
    [0, true, "current", "abandon-watch"],
    [0, false, "current", "advance"],
    [1, true, "current", "advance"],
    [0, true, "watch-page", "advance"],
  ] as const)(
    "abandons only a new top document showing the first step: %j/%j/%s",
    (frameId, showsFirstStep, documentId, kind) => {
      const watched = record({
        state: "watching",
        watch: { since: now, documentId: "watch-page", pages: 0 },
      });
      expect(
        nextRecordStep(
          watched,
          page({ frameId, showsFirstStep, documentId }),
          { phase: "abandon-watch" },
          now,
        ),
      ).toEqual({ kind, next: "pause" });
    },
  );

  it.each([
    ["executing", true, undefined, false, "stop-paused"],
    ["executing", true, "other-attempt", false, "stop-paused"],
    ["executing", true, "attempt", false, "advance"],
    ["executing", false, undefined, false, "advance"],
    ["executing", true, undefined, true, "advance"],
    ["blocked", true, undefined, false, "advance"],
    ["authenticated", true, undefined, false, "advance"],
  ] as const)(
    "honors the paused-page exemption for the exact popup attempt: %j",
    (state, paused, pickedAttemptId, watched, kind) => {
      const entry = record({
        state,
        ...(watched ? { watch: { since: now, documentId: "earlier", pages: 0 } } : {}),
      });
      expect(
        nextRecordStep(entry, page({ paused, pickedAttemptId }), { phase: "pause" }, now),
      ).toEqual({ kind, next: "finished" });
    },
  );
});

describe("finished records precede stopped records", () => {
  it("handles wrong-account as finished before its overlapping stopped classification", () => {
    const entry = record({ state: "blocked", outcome: "wrong-account", submissions: 0 });
    expect(nextRecordStep(entry, page(), { phase: "finished" }, now)).toEqual({
      kind: "read-confirm",
      read: true,
      rejectedHere: false,
      next: "finished-confirmed",
    });
    expect(nextRecordStep(entry, page(), { phase: "stopped" }, now)).toEqual({
      kind: "advance",
      next: "submitted",
    });
  });

  it.each([
    [0, 0, "read-confirm"],
    [0, 1, "advance"],
    [1, 0, "advance"],
    [1, 1, "advance"],
  ] as const)(
    "requires both records and current pages to be top-level: %i/%i",
    (oldFrame, frameId, kind) => {
      const entry = record({
        state: "authenticated",
        document: { origin, tabId: 1, frameId: oldFrame, documentId: "earlier" },
      });
      const action = nextRecordStep(entry, page({ frameId }), { phase: "finished" }, now);
      expect(action.kind).toBe(kind);
      expect(action).toHaveProperty(
        "next",
        kind === "read-confirm" ? "finished-confirmed" : "stopped",
      );
    },
  );

  it.each([
    ["credential-rejected", "current", false, false, true],
    ["credential-rejected", "earlier", false, true, false],
    ["credential-rejected", "earlier", true, false, false],
    ["wrong-account", "current", false, true, false],
    ["wrong-account", "current", true, false, false],
  ] as const)(
    "keeps confirmation explicit when it skips a read: %s/%s/%j",
    (outcome, documentId, hasTopUrl, read, rejectedHere) => {
      const entry = record({
        state: "blocked",
        outcome,
        document: { origin, tabId: 1, frameId: 0, documentId },
      });
      expect(nextRecordStep(entry, page({ hasTopUrl }), { phase: "finished" }, now)).toEqual({
        kind: "read-confirm",
        read,
        rejectedHere,
        next: "finished-confirmed",
      });
    },
  );

  it.each([
    [false, undefined, false, "keep-watching"],
    [false, false, false, "keep-watching"],
    [false, true, false, "keep-watching"],
    [true, undefined, false, "release-finished"],
    [true, false, false, "release-finished"],
    [true, true, false, "keep-watching"],
    [false, undefined, true, "release-finished"],
    [false, false, true, "release-finished"],
    [false, true, true, "release-finished"],
    [true, undefined, true, "release-finished"],
    [true, false, true, "release-finished"],
    [true, true, true, "release-finished"],
  ] as const)(
    "uses latched confirmation and same-page rejection: %j/%j/%j",
    (showsFirstStep, confirm, rejectedHere, kind) => {
      const action = nextRecordStep(
        record({ state: "authenticated" }),
        page({ showsFirstStep }),
        { phase: "finished-confirmed", confirm, rejectedHere },
        now,
      );
      expect(action).toEqual(
        kind === "keep-watching" ? { kind, reason: "logged-in" } : { kind, next: "stopped" },
      );
    },
  );

  it.each([
    ["policy-changed", 0, "earlier", "release-stopped"],
    ["policy-changed", 0, "current", "advance"],
    ["policy-changed", 1, "earlier", "advance"],
    ["wrong-account", 0, "earlier", "advance"],
    ["account-switched", 0, "earlier", "advance"],
    ["credential-rejected", 0, "earlier", "advance"],
  ] as const)(
    "releases only a non-submitting stopped login on a new document: %s/%i/%s",
    (outcome, submissions, documentId, kind) => {
      const entry = record({
        state: "blocked",
        outcome,
        submissions,
        document: { origin, tabId: 1, frameId: 0, documentId },
      });
      expect(nextRecordStep(entry, page(), { phase: "stopped" }, now)).toEqual({
        kind,
        next: "submitted",
      });
    },
  );
});

describe("submitted records and asynchronous inputs", () => {
  it.each([
    [-1, "read-confirm"],
    [0, "advance"],
    [299_999, "advance"],
    [300_000, "read-confirm"],
  ] as const)(
    "does not refresh an expired hold or one from a future clock at age %i",
    (age, kind) => {
      const entry = record({ state: "blocked", outcome: "timeout", changedAt: now - age });
      const action = nextRecordStep(entry, page(), { phase: "submitted" }, now);
      expect(action.kind).toBe(kind);
      expect(action).toHaveProperty(
        "next",
        kind === "read-confirm" ? "submitted-confirmed" : "done",
      );
    },
  );

  it.each([
    ["timeout", 1, 0, 0, "read-confirm"],
    ["timeout", 0, 0, 0, "advance"],
    ["timeout", 1, 1, 0, "advance"],
    ["timeout", 1, 0, 1, "advance"],
    ["account-switched", 1, 0, 0, "advance"],
    ["wrong-account", 1, 0, 0, "advance"],
    ["credential-rejected", 1, 0, 0, "advance"],
  ] as const)(
    "keeps frame, finished-login and account-switch exclusions: %s/%i/%i/%i",
    (outcome, submissions, oldFrame, frameId, kind) => {
      const entry = record({
        state: "blocked",
        outcome,
        submissions,
        document: { origin, tabId: 1, frameId: oldFrame, documentId: "earlier" },
      });
      expect(nextRecordStep(entry, page({ frameId }), { phase: "submitted" }, now).kind).toBe(kind);
    },
  );

  it.each([
    [undefined, "advance"],
    ["current", "advance"],
    ["watch-page", "read-confirm"],
  ] as const)(
    "uses the old watch document latch on the original login document: %j",
    (watchEnded, kind) => {
      const entry = record({
        state: "blocked",
        outcome: "timeout",
        document: { origin, tabId: 1, frameId: 0, documentId: "current" },
      });
      expect(nextRecordStep(entry, page(), { phase: "submitted", watchEnded }, now).kind).toBe(
        kind,
      );
    },
  );

  it("keeps skipped submitted confirmation as an explicit stale-check boundary", () => {
    const entry = record({ state: "blocked", outcome: "timeout" });
    expect(nextRecordStep(entry, page({ hasTopUrl: true }), { phase: "submitted" }, now)).toEqual({
      kind: "read-confirm",
      read: false,
      rejectedHere: false,
      next: "submitted-confirmed",
    });
  });

  it.each([
    [false, undefined, false, true],
    [false, false, false, true],
    [false, true, false, false],
    [true, undefined, false, false],
    [true, false, false, false],
    [true, true, false, false],
    [false, undefined, true, false],
    [false, false, true, false],
    [false, true, true, false],
    [true, undefined, true, false],
    [true, false, true, false],
    [true, true, true, false],
  ] as const)(
    "reads withdrawn only when the page has no first step, confirmation or probe: %j/%j/%j",
    (showsFirstStep, confirm, probe, read) => {
      expect(
        nextRecordStep(
          record(),
          page({ showsFirstStep, probe }),
          { phase: "submitted-confirmed", confirm },
          now,
        ),
      ).toEqual({ kind: "read-withdrawn", read, next: "submitted-withdrawn" });
    },
  );

  it.each([
    [false, undefined, undefined, "keep-watching"],
    [false, false, false, "keep-watching"],
    [false, true, false, "keep-watching"],
    [true, undefined, false, "ask-after-stop"],
    [true, false, false, "ask-after-stop"],
    [true, true, false, "keep-watching"],
    [false, undefined, true, "ask-after-stop"],
    [false, true, true, "ask-after-stop"],
    [true, false, true, "ask-after-stop"],
  ] as const)(
    "latches withdrawn and confirmation answers before keeping or releasing: %j/%j/%j",
    (showsFirstStep, confirm, withdrawn, kind) => {
      const action = nextRecordStep(
        record(),
        page({ showsFirstStep }),
        { phase: "submitted-withdrawn", confirm, withdrawn },
        now,
      );
      expect(action).toEqual(
        kind === "keep-watching" ? { kind, reason: "login-stopped" } : { kind, next: "done" },
      );
    },
  );

  it("does not mutate record, page or latched inputs in any phase", () => {
    const entry = record({ state: "blocked", outcome: "timeout" });
    const input = Object.freeze(page());
    const before = structuredClone(entry);
    Object.freeze(entry);
    for (const phase of phases) {
      const seen = Object.freeze({
        phase,
        confirm: false,
        withdrawn: true,
        watchEnded: "watch-page",
      });
      nextRecordStep(entry, input, seen, now);
      expect(seen).toEqual({ phase, confirm: false, withdrawn: true, watchEnded: "watch-page" });
    }
    expect(entry).toEqual(before);
    expect(input).toEqual(page());
  });
});
