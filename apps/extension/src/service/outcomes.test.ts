import { describe, expect, it, vi } from "vitest";
import type { LoginReport } from "../login/runtime";
import { createLoginOutcomes, loginOutcomeOf, MAX_OUTCOME_SENDS } from "./outcomes";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// Synthetic reports, recipes and service only; nothing leaves the test.

const CONNECTION: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};

type AttemptReport = Extract<LoginReport, { type: "attempt" }>;
type Overrides = { [K in keyof AttemptReport]?: AttemptReport[K] | undefined };
function attempt(overrides: Overrides = {}): LoginReport {
  return {
    type: "attempt",
    tabId: 7,
    origin: "https://bank.example",
    recipeId: "gen-0123",
    recipeRevision: 3,
    route: "password",
    variant: 0,
    state: "reconciling",
    stepIndex: 1,
    stepCount: 2,
    operation: "click",
    effect: "submit",
    outcome: "unknown-submit",
    settled: true,
    url: "https://bank.example/login?user=someone",
    ...overrides,
  } as LoginReport;
}

function setup(
  options: {
    connection?: ServiceConnection | undefined;
    answer?: () => Promise<OutcomeResult>;
  } = {},
) {
  let stored: unknown;
  const storage = {
    read: vi.fn(async () => structuredClone(stored)),
    write: vi.fn(async (value: unknown) => {
      stored = structuredClone(value);
    }),
  };
  const answer = options.answer ?? (async (): Promise<OutcomeResult> => ({ kind: "kept" }));
  const reportOutcome = vi.fn<ServiceTransport["reportOutcome"]>(() => answer());
  const connection = "connection" in options ? options.connection : CONNECTION;
  const outcomes = createLoginOutcomes({
    service: { connection: async () => connection },
    transport: { reportOutcome },
    storage,
    now: () => 1_000,
  });
  /** Lets the queued work run. */
  const settle = () => outcomes.flush();
  return { outcomes, reportOutcome, storage, settle, stored: () => stored };
}

describe("loginOutcomeOf", () => {
  it("sends codes and numbers only, never the URL, origin, reason or account", () => {
    expect(
      loginOutcomeOf(attempt({ reason: "no-receiver", unconfirmed: true, handler: 1 })),
    ).toEqual({
      recipeId: "gen-0123",
      report: { version: 1, revision: 3, outcome: "unknown-submit", cause: "settled", step: 1 },
    });
  });

  it("keeps a listed cause and the chooser branch", () => {
    expect(
      loginOutcomeOf(
        attempt({
          state: "blocked",
          outcome: "structural-mismatch",
          cause: "target-missing",
          settled: undefined,
          branch: "other",
          stepIndex: 0,
        }),
      )?.report,
    ).toEqual({
      version: 1,
      revision: 3,
      branch: "other",
      outcome: "structural-mismatch",
      cause: "target-missing",
      step: 0,
    });
    expect(
      loginOutcomeOf(
        attempt({ state: "authenticated", outcome: "authenticated", settled: undefined }),
      )?.report,
    ).toEqual({ version: 1, revision: 3, outcome: "authenticated", step: 1 });
    expect(
      loginOutcomeOf(
        attempt({
          state: "authenticated",
          outcome: "authenticated",
          settled: undefined,
          unconfirmed: true,
        }),
      )?.report.cause,
    ).toBe("unconfirmed");
    expect(
      loginOutcomeOf(attempt({ state: "watching", outcome: "challenge", settled: undefined }))
        ?.report,
    ).toEqual({ version: 1, revision: 3, outcome: "challenge", step: 1 });
  });

  it.each([
    ["a login without a recipe revision", { recipeRevision: 0 }],
    ["a login still running", { state: "executing", outcome: undefined, settled: undefined }],
    ["a login that retries", { state: "retryable", outcome: "timeout", settled: undefined }],
    ["a fill-only login", { state: "blocked", outcome: "cancelled", reason: "fill-only" }],
    ["a login stopped before a missing password", { state: "watching", stop: "password" }],
    [
      "a login stopped by a settings change",
      { state: "blocked", outcome: "policy-changed", cause: "settings-synced" },
    ],
    ["an account switch", { state: "blocked", outcome: "account-switched" }],
    ["an unknown outcome", { state: "blocked", outcome: "made-up" }],
  ] as [string, Overrides][])("reports nothing for %s", (_, overrides) => {
    expect(loginOutcomeOf(attempt(overrides))).toBeUndefined();
  });

  it("reports nothing but attempts", () => {
    expect(
      loginOutcomeOf({ type: "refused", tabId: 7, origin: "https://bank.example", reason: "x" }),
    ).toBeUndefined();
  });

  it("drops a cause outside the list", () => {
    expect(
      loginOutcomeOf(
        attempt({
          state: "blocked",
          outcome: "cancelled",
          cause: "settings-saved",
          settled: undefined,
        }),
      )?.report,
    ).toEqual({ version: 1, revision: 3, outcome: "cancelled", step: 1 });
  });
});

describe("createLoginOutcomes", () => {
  it("reports the first ended login of each revision once", async () => {
    const { outcomes, reportOutcome, settle } = setup();
    outcomes.observe(attempt());
    // Later reports of the same revision: a repeat, the watch's end, another tab's login.
    outcomes.observe(attempt({ repeat: true }));
    outcomes.observe(attempt({ state: "authenticated", outcome: "authenticated", tabId: 8 }));
    await settle();
    expect(reportOutcome.mock.calls).toEqual([
      [
        CONNECTION.origin,
        CONNECTION.credential,
        "gen-0123",
        { version: 1, revision: 3, outcome: "unknown-submit", cause: "settled", step: 1 },
      ],
    ]);
    // A new revision, and a chooser branch of it, are each reported once more.
    outcomes.observe(attempt({ recipeRevision: 4 }));
    outcomes.observe(attempt({ recipeRevision: 4, branch: "account" }));
    outcomes.observe(attempt({ recipeRevision: 4 }));
    await settle();
    expect(reportOutcome.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ revision: 3 }),
      { version: 1, revision: 4, outcome: "unknown-submit", cause: "settled", step: 1 },
      {
        version: 1,
        revision: 4,
        branch: "account",
        outcome: "unknown-submit",
        cause: "settled",
        step: 1,
      },
    ]);
  });

  it("reports nothing without a paired service, nor later once it is paired", async () => {
    const { outcomes, reportOutcome, storage, settle } = setup({ connection: undefined });
    outcomes.observe(attempt());
    await settle();
    expect(reportOutcome).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    const rejected = setup({ connection: { ...CONNECTION, rejected: true } });
    rejected.outcomes.observe(attempt());
    await rejected.settle();
    expect(rejected.reportOutcome).not.toHaveBeenCalled();
  });

  it("keeps a report the service could not take and sends it once at the next flush", async () => {
    let answer: OutcomeResult = { kind: "failed", error: "unreachable" };
    const { outcomes, reportOutcome, settle, stored } = setup({ answer: async () => answer });
    outcomes.observe(attempt());
    await settle();
    // One attempt now and one at the flush the test itself makes; never a retry loop.
    expect(reportOutcome).toHaveBeenCalledTimes(2);
    expect(stored()).toMatchObject({ entries: [{ revision: 3, pending: { revision: 3 } }] });
    // The same revision ending again is not reported again, even while pending.
    outcomes.observe(attempt({ state: "authenticated", outcome: "authenticated" }));
    answer = { kind: "kept" };
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(3);
    expect(reportOutcome.mock.calls.at(-1)![3]).toMatchObject({ outcome: "unknown-submit" });
    expect(stored()).toEqual({
      version: 1,
      entries: [
        {
          service: CONNECTION.origin,
          deviceId: CONNECTION.deviceId,
          recipeId: "gen-0123",
          revision: 3,
          at: 1_000,
        },
      ],
    });
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(3);
  });

  it("drops a report the service refused, and keeps one for a rejected device", async () => {
    const refused = setup({ answer: async () => ({ kind: "refused" }) });
    refused.outcomes.observe(attempt());
    await refused.settle();
    await refused.settle();
    expect(refused.reportOutcome).toHaveBeenCalledTimes(1);
    const rejected = setup({ answer: async () => ({ kind: "rejected" }) });
    rejected.outcomes.observe(attempt());
    await rejected.settle();
    expect(rejected.stored()).toMatchObject({ entries: [{ pending: { revision: 3 } }] });
  });

  it("sends a backlog a few at a time, stopping at the first failure", async () => {
    let answer: OutcomeResult = { kind: "failed", error: "rate-limited" };
    const { outcomes, reportOutcome, settle } = setup({ answer: async () => answer });
    for (let revision = 1; revision <= MAX_OUTCOME_SENDS + 2; revision += 1)
      outcomes.observe(attempt({ recipeRevision: revision }));
    await settle();
    // Each ended login and the flush tried the oldest pending report once.
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual(
      Array.from({ length: MAX_OUTCOME_SENDS + 3 }, () => 1),
    );
    reportOutcome.mockClear();
    answer = { kind: "kept" };
    await settle();
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never throws into the login when sending or storage fails", async () => {
    const failing = setup({
      answer: async () => {
        throw new Error("synthetic transport failure");
      },
    });
    expect(() => failing.outcomes.observe(attempt())).not.toThrow();
    await expect(failing.settle()).resolves.toBeUndefined();

    const broken = setup();
    broken.storage.read.mockRejectedValue(new Error("synthetic storage failure"));
    expect(broken.outcomes.observe(attempt())).toBeUndefined();
    await expect(broken.settle()).resolves.toBeUndefined();
    // A revision that could not be recorded is not sent, so it can never be sent twice.
    expect(broken.reportOutcome).not.toHaveBeenCalled();

    const unwritable = setup();
    unwritable.storage.write.mockRejectedValue(new Error("synthetic storage failure"));
    unwritable.outcomes.observe(attempt());
    await unwritable.settle();
    expect(unwritable.reportOutcome).not.toHaveBeenCalled();
  });

  it("ignores stored entries that do not parse", async () => {
    const { outcomes, reportOutcome, storage, settle } = setup();
    await storage.write({ version: 0, entries: "x" });
    outcomes.observe(attempt());
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(1);
  });
});
