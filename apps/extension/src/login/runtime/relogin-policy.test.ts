import { describe, expect, it } from "vitest";
import type { LoginAttemptMetadata } from "@pateat/contracts";
import { countSignIn, countsAsRelogin, reloginLimited, reloginTimes } from "./relogin-policy";
import type { Relogins } from "./session-schemas";

const now = 2_000_000;
const site = "example.com";
const origin = "https://login.example.com";
const normal = "normal example.com";
const privateKey = "incognito example.com";

function completions(at: number[], incognito = false, domain = site): Relogins {
  return { site: domain, incognito, at };
}

function record(
  state: LoginAttemptMetadata["state"],
  extra: Partial<LoginAttemptMetadata> = {},
): LoginAttemptMetadata {
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
    document: { origin, tabId: 1, frameId: 0, documentId: "document" },
    state,
    stepIndex: 0,
    stepCount: 1,
    submissions: 1,
    maxSubmissions: 1,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    timing: { since: now, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
    ...extra,
  };
}

describe("the ten-minute automatic-sign-in window", () => {
  it.each([
    [-1, false],
    [0, true],
    [599_999, true],
    [600_000, false],
    [600_001, false],
  ] as const)("keeps two completions at age %i only within the window", (age, expected) => {
    const times = [now - age, now - age];
    const history = new Map([[normal, completions(times)]]);
    expect(reloginTimes(history, site, false, now)).toEqual(expected ? times : []);
    expect(reloginLimited(history, origin, false, now)).toBe(expected);
  });

  it("drops future entries after a clock rollback without changing stored times", () => {
    const history = new Map([[normal, completions([now - 10, now + 1])]]);
    expect(reloginTimes(history, site, false, now)).toEqual([now - 10]);
    expect(reloginLimited(history, origin, false, now)).toBe(false);
    expect(history.get(normal)?.at).toEqual([now - 10, now + 1]);
  });

  it("preserves completion order and duplicates instead of sorting or deduplicating", () => {
    const history = new Map([[normal, completions([now, now - 10])]]);
    const recent = reloginTimes(history, site, false, now);
    expect(recent).toEqual([now, now - 10]);
    expect(recent).not.toBe(history.get(normal)?.at);
    const duplicates = new Map([[normal, completions([now, now])]]);
    expect(reloginLimited(duplicates, origin, false, now)).toBe(true);
  });

  it("has no limit for absent history or just one completion", () => {
    expect(reloginTimes(new Map(), site, false, now)).toEqual([]);
    expect(reloginLimited(new Map(), origin, false, now)).toBe(false);
    expect(reloginLimited(new Map([[normal, completions([now])]]), origin, false, now)).toBe(false);
  });

  it("shares a registrable domain across schemes, ports and subdomains", () => {
    const history = new Map([[normal, completions([now - 1, now])]]);
    for (const url of [
      "https://accounts.example.com",
      "http://www.example.com:8080",
      "https://example.com/path",
    ])
      expect(reloginLimited(history, url, false, now)).toBe(true);
    expect(reloginLimited(history, "https://unrelated.com", false, now)).toBe(false);
  });

  it("keeps normal and private session counts separate in both directions", () => {
    const normalHistory = new Map([[normal, completions([now - 1, now])]]);
    expect(reloginLimited(normalHistory, origin, false, now)).toBe(true);
    expect(reloginLimited(normalHistory, origin, true, now)).toBe(false);
    const privateHistory = new Map([[privateKey, completions([now - 1, now], true)]]);
    expect(reloginLimited(privateHistory, origin, false, now)).toBe(false);
    expect(reloginLimited(privateHistory, origin, true, now)).toBe(true);
  });

  it("uses private suffixes and multi-label public suffixes as distinct sites", () => {
    const history = new Map([
      ["normal project.pages.dev", completions([now, now], false, "project.pages.dev")],
      ["normal example.co.uk", completions([now, now], false, "example.co.uk")],
    ]);
    expect(reloginLimited(history, "https://login.project.pages.dev", false, now)).toBe(true);
    expect(reloginLimited(history, "https://other.pages.dev", false, now)).toBe(false);
    expect(reloginLimited(history, "https://login.example.co.uk", false, now)).toBe(true);
    expect(reloginLimited(history, "https://different.co.uk", false, now)).toBe(false);
  });

  it.each(["not a URL", "https://com", "file:///tmp/login"])(
    "ignores an origin without a registrable site: %s",
    (url) => {
      const history = new Map([[normal, completions([now, now])]]);
      expect(reloginLimited(history, url, false, now)).toBe(false);
      const counted = countSignIn(history, url, false, now);
      expect(counted).toEqual(history);
      expect(counted).not.toBe(history);
    },
  );
});

describe("counting a completion without mutating the input", () => {
  it("retains only the last two valid times and creates a fresh record and array", () => {
    const prior = completions([now - 100, now - 50]);
    const other = completions([now - 20], true);
    Object.freeze(prior.at);
    Object.freeze(prior);
    Object.freeze(other.at);
    Object.freeze(other);
    const history = new Map([
      [normal, prior],
      [privateKey, other],
    ]);
    const before = [...history];
    const counted = countSignIn(history, origin, false, now);
    expect(counted.get(normal)).toEqual(completions([now - 50, now]));
    expect(counted.get(normal)).not.toBe(prior);
    expect(counted.get(normal)?.at).not.toBe(prior.at);
    expect(counted.get(privateKey)).toBe(other);
    expect([...counted.keys()]).toEqual([privateKey, normal]);
    expect([...history]).toEqual(before);
    expect(history.get(normal)?.at).toEqual([now - 100, now - 50]);
  });

  it("forgets expired and future times before appending, and creates the requested partition", () => {
    const history = new Map([[normal, completions([now - 600_000, now + 1])]]);
    const counted = countSignIn(history, "https://accounts.example.com", false, now);
    expect(counted.get(normal)).toEqual(completions([now]));
    const privateCounted = countSignIn(counted, origin, true, now + 1);
    expect(privateCounted.get(normal)).toEqual(completions([now]));
    expect(privateCounted.get(privateKey)).toEqual(completions([now + 1], true));
    expect(counted.has(privateKey)).toBe(false);
  });

  it("refreshes an existing site's insertion order before evicting the oldest other site", () => {
    const history = new Map<string, Relogins>();
    for (let index = 0; index < 256; index++)
      history.set(`normal site-${index}.test`, completions([now - 1], false, `site-${index}.test`));
    const refreshed = countSignIn(history, "https://site-0.test", false, now);
    expect(refreshed.size).toBe(256);
    expect([...refreshed.keys()].slice(-1)).toEqual(["normal site-0.test"]);
    const extended = countSignIn(refreshed, "https://site-256.test", false, now);
    expect(extended.size).toBe(256);
    expect(extended.has("normal site-0.test")).toBe(true);
    expect(extended.has("normal site-1.test")).toBe(false);
    expect([...extended.keys()].slice(0, 2)).toEqual(["normal site-2.test", "normal site-3.test"]);
    expect([...extended.keys()].slice(-2)).toEqual(["normal site-0.test", "normal site-256.test"]);
    expect([...history.keys()].slice(0, 2)).toEqual(["normal site-0.test", "normal site-1.test"]);
  });

  it.each([
    [0, 1, 0],
    [255, 256, 0],
    [256, 256, 1],
    [257, 256, 2],
    [258, 256, 3],
  ] as const)("caps %i existing entries at %i after insertion", (size, expectedSize, removed) => {
    const history = new Map<string, Relogins>();
    for (let index = 0; index < size; index++)
      history.set(`normal site-${index}.test`, completions([now], false, `site-${index}.test`));
    const counted = countSignIn(history, origin, false, now);
    expect(counted.size).toBe(expectedSize);
    expect([...counted.keys()]).toEqual([
      ...Array.from(
        { length: size - removed },
        (_, index) => `normal site-${index + removed}.test`,
      ),
      normal,
    ]);
    expect(history.size).toBe(size);
  });
});

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
const automaticCompletions = new Set([
  "detected/authenticated",
  "ready/authenticated",
  "executing/authenticated",
  "submit-intent/authenticated",
  "awaiting-result/authenticated",
  "reconciling/authenticated",
  "retryable/authenticated",
  "watching/authenticated",
  "blocked/authenticated",
]);
const picks = [
  { picked: undefined, counted: true },
  { picked: "different-attempt", counted: true },
  { picked: "attempt", counted: false },
];
const transitions = states.flatMap((previous) => states.map((next) => ({ previous, next })));

describe("all 100 state pairs for automatic completion eligibility", () => {
  it.each(transitions)(
    "$previous to $next counts once, unless this exact attempt was picked",
    ({ previous, next }) => {
      for (const { picked, counted } of picks)
        for (const undecided of [false, true]) {
          const before = record(previous);
          const after = record(next, undecided ? { unconfirmed: true } : {});
          const beforeCopy = structuredClone(before);
          const afterCopy = structuredClone(after);
          const expected = automaticCompletions.has(`${previous}/${next}`) && counted;
          expect(countsAsRelogin(before, after, picked)).toBe(expected);
          expect(before).toEqual(beforeCopy);
          expect(after).toEqual(afterCopy);
        }
    },
  );

  it("does not confuse a previous attempt's picked ID with the newly authenticated attempt", () => {
    expect(
      countsAsRelogin(
        record("executing", { id: "old-attempt" }),
        record("authenticated"),
        "old-attempt",
      ),
    ).toBe(true);
    expect(
      countsAsRelogin(
        record("executing", { id: "old-attempt" }),
        record("authenticated"),
        "attempt",
      ),
    ).toBe(false);
  });
});
