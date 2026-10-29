import { describe, expect, it } from "vitest";
import type { LoginAttemptMetadata } from "@pateat/contracts";
import { heldElsewhere, sharesCookies, signedInElsewhere, siteHeldElsewhere } from "./hold-policy";

const origin = "https://login.example.com";
const now = 4_000_000;

function record(overrides: Partial<LoginAttemptMetadata> = {}): LoginAttemptMetadata {
  return {
    version: 1,
    id: "attempt-2",
    recipeId: "recipe",
    recipeRevision: 1,
    policyRevision: 1,
    account: { origin, connectionId: "connection", itemId: "item" },
    route: "password",
    facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
    handlers: [],
    document: { origin, tabId: 2, frameId: 0, documentId: "document-2" },
    state: "executing",
    stepIndex: 0,
    stepCount: 1,
    submissions: 1,
    maxSubmissions: 1,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    changedAt: now,
    timing: { since: now, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
    ...overrides,
  };
}

const states = [
  "detected",
  "ready",
  "executing",
  "submit-intent",
  "awaiting-result",
  "reconciling",
  "retryable",
  "watching",
  "authenticated",
  "blocked",
] as const;

describe("record holds", () => {
  it.each(states)("holds another tab for recent %s, except a completed login", (state) => {
    const expected = state !== "authenticated";
    expect(heldElsewhere([record({ state })], new Map(), 1, origin, now)).toBe(expected);
    expect(siteHeldElsewhere([record({ state })], new Map(), 1, "example.com", now)).toBe(expected);
  });

  it.each([
    [-1, false],
    [0, true],
    [299_999, true],
    [300_000, false],
    [300_001, false],
  ] as const)("uses an exclusive five-minute hold at age %i", (age, expected) => {
    expect(heldElsewhere([record({ changedAt: now - age })], new Map(), 1, origin, now)).toBe(
      expected,
    );
  });

  it("uses epoch zero when a record has no changed time", () => {
    const entry = record({ changedAt: undefined });
    expect(heldElsewhere([entry], new Map(), 1, origin, 0)).toBe(true);
    expect(heldElsewhere([entry], new Map(), 1, origin, 299_999)).toBe(true);
    expect(heldElsewhere([entry], new Map(), 1, origin, 300_000)).toBe(false);
  });

  it.each([
    ["policy-changed", false],
    ["value-mismatch", false],
    ["wrong-account", false],
    ["account-switched", false],
    ["retry-limit", false],
    ["account-not-listed", false],
    ["credential-rejected", true],
    ["challenge", true],
    ["unknown-submit", true],
    ["submission-limit", true],
    ["timeout", true],
    ["cancelled", true],
    ["interrupted", true],
  ] as const)("treats blocked %s according to what may still be in flight", (outcome, expected) => {
    expect(heldElsewhere([record({ state: "blocked", outcome })], new Map(), 1, origin, now)).toBe(
      expected,
    );
  });

  it.each([
    { state: "executing", fillOnly: true },
    { state: "blocked", outcome: "interrupted", submissions: 0 },
    { state: "blocked", outcome: "cancelled", submissions: 0 },
  ] satisfies Partial<LoginAttemptMetadata>[])(
    "releases a non-submitting record: %j",
    (overrides) => {
      expect(heldElsewhere([record(overrides)], new Map(), 1, origin, now)).toBe(false);
    },
  );

  it.each([
    { mutationIntent: true },
    { settled: true },
    { operationKind: "click", operationId: "click-in-flight" },
  ] satisfies Partial<LoginAttemptMetadata>[])(
    "retains a stopped record with unresolved effects: %j",
    (overrides) => {
      const entry = record({ state: "blocked", outcome: "policy-changed", ...overrides });
      expect(heldElsewhere([entry], new Map(), 1, origin, now)).toBe(true);
    },
  );

  it.each([
    [-1, false],
    [0, true],
    [599_999, true],
    [600_000, false],
    [600_001, false],
  ] as const)("keeps a watch beyond an expired ordinary hold at watch age %i", (age, expected) => {
    const entry = record({
      state: "watching",
      changedAt: now - 1_000_000,
      watch: { since: now - age, documentId: "document-2", pages: 0 },
    });
    expect(heldElsewhere([entry], new Map(), 1, origin, now)).toBe(expected);
  });

  it("retains an ordinary hold after its watch expires and a live watch for a fill-only record", () => {
    const expiredWatch = { since: now - 600_000, documentId: "document-2", pages: 0 };
    expect(heldElsewhere([record({ watch: expiredWatch })], new Map(), 1, origin, now)).toBe(true);
    const watched = record({
      state: "watching",
      fillOnly: true,
      watch: { since: now, documentId: "document-2", pages: 0 },
    });
    expect(heldElsewhere([watched], new Map(), 1, origin, now)).toBe(true);
  });

  it("excludes the caller and distinguishes an origin hold from a registrable-site hold", () => {
    expect(heldElsewhere([record()], new Map(), 2, origin, now)).toBe(false);
    expect(siteHeldElsewhere([record()], new Map(), 2, "example.com", now)).toBe(false);
    expect(heldElsewhere([record()], new Map(), 1, "https://accounts.example.com", now)).toBe(
      false,
    );
    expect(siteHeldElsewhere([record()], new Map(), 1, "example.com", now)).toBe(true);
    expect(siteHeldElsewhere([record()], new Map(), 1, "unrelated.com", now)).toBe(false);
  });

  it("accepts a one-shot iterable and leaves records and window kinds unchanged", () => {
    const entry = record();
    const frozen = structuredClone(entry);
    const kinds = new Map([
      [1, false],
      [2, false],
    ]);
    function* entries() {
      yield entry;
    }
    expect(heldElsewhere(entries(), kinds, 1, origin, now)).toBe(true);
    expect(entry).toEqual(frozen);
    expect([...kinds]).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it("keeps private-hosted sites separate and excludes malformed origins", () => {
    const hosted = record({
      account: {
        origin: "https://a.project.pages.dev",
        connectionId: "connection",
        itemId: "item",
      },
    });
    expect(siteHeldElsewhere([hosted], new Map(), 1, "project.pages.dev", now)).toBe(true);
    expect(siteHeldElsewhere([hosted], new Map(), 1, "other.pages.dev", now)).toBe(false);
    const invalid = record({
      account: { origin: "not a URL", connectionId: "connection", itemId: "item" },
    });
    expect(siteHeldElsewhere([invalid], new Map(), 1, "example.com", now)).toBe(false);
  });
});

describe("recent signed-in records", () => {
  it.each(states)("only suppresses generation for authenticated, not %s", (state) => {
    expect(signedInElsewhere([record({ state })], new Map(), 1, origin, now)).toBe(
      state === "authenticated",
    );
  });

  it.each([
    [-1, false],
    [0, true],
    [3_599_999, true],
    [3_600_000, false],
    [3_600_001, false],
  ] as const)("expires an authenticated record at one hour, at age %i", (age, expected) => {
    expect(
      signedInElsewhere(
        [record({ state: "authenticated", changedAt: now - age })],
        new Map(),
        1,
        origin,
        now,
      ),
    ).toBe(expected);
  });

  it("requires a known completion time, another tab and the same origin", () => {
    expect(
      signedInElsewhere(
        [record({ state: "authenticated", changedAt: undefined })],
        new Map(),
        1,
        origin,
        now,
      ),
    ).toBe(false);
    const entry = record({ state: "authenticated" });
    expect(signedInElsewhere([entry], new Map(), 2, origin, now)).toBe(false);
    expect(signedInElsewhere([entry], new Map(), 1, "https://accounts.example.com", now)).toBe(
      false,
    );
  });
});

// Rows and columns are unknown, normal, private. Unknown can share either session.
const sharing = [
  [true, true, true],
  [true, true, false],
  [true, false, true],
] as const;
const kinds = [undefined, false, true] as const;
const partitions = kinds.flatMap((a, first) =>
  kinds.flatMap((b, second) =>
    kinds.map((c, third) => ({ values: [a, b, c], indexes: [first, second, third] })),
  ),
);

describe("all 27 window-kind assignments over three tabs", () => {
  it.each(partitions)(
    "preserves the hand-specified sharing relation for $values",
    ({ values, indexes }) => {
      const windows = new Map<number, boolean>();
      values.forEach((value, index) => {
        if (value !== undefined) windows.set(index + 1, value);
      });
      for (const caller of [0, 1, 2])
        for (const other of [0, 1, 2])
          expect(sharesCookies(windows, caller + 1, other + 1)).toBe(
            sharing[indexes[caller]!]![indexes[other]!],
          );

      // Every subset of the three tabs may have a record, including the caller's own tab.
      for (let mask = 0; mask < 8; mask++) {
        const records = [0, 1, 2]
          .filter((index) => (mask & (1 << index)) !== 0)
          .map((index) =>
            record({
              document: {
                origin,
                tabId: index + 1,
                frameId: 0,
                documentId: `document-${index + 1}`,
              },
            }),
          );
        for (const caller of [0, 1, 2]) {
          const sharingPeers = [0, 1, 2].filter(
            (other) => other !== caller && sharing[indexes[caller]!]![indexes[other]!],
          );
          const expected = sharingPeers.some((other) => (mask & (1 << other)) !== 0);
          expect(heldElsewhere(records, windows, caller + 1, origin, now)).toBe(expected);
          expect(siteHeldElsewhere(records, windows, caller + 1, "example.com", now)).toBe(
            expected,
          );
          const completed = records.map((entry) => ({ ...entry, state: "authenticated" as const }));
          expect(signedInElsewhere(completed, windows, caller + 1, origin, now)).toBe(expected);
        }
      }
    },
  );
});
