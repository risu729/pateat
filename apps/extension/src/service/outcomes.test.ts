import { describe, expect, it, vi } from "vitest";
import type { LoginReport } from "../login/runtime";
import {
  createLoginOutcomes,
  loginOutcomeOf,
  MAX_OUTCOME_SENDS,
  OUTCOME_RETRY_MS,
  PENDING_OUTCOME_MS,
  type LoginOutcomeSent,
} from "./outcomes";
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
  const state = {
    connection: "connection" in options ? options.connection : CONNECTION,
    now: 1_000,
  };
  const logged: LoginOutcomeSent[] = [];
  const outcomes = createLoginOutcomes({
    service: { connection: async () => state.connection },
    transport: { reportOutcome },
    storage,
    report: (sent) => logged.push(sent),
    now: () => state.now,
  });
  /** Lets the queued work run. */
  const settle = () => outcomes.flush();
  return { outcomes, reportOutcome, storage, settle, stored: () => stored, state, logged };
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
      loginOutcomeOf(
        attempt({
          state: "blocked",
          outcome: "cancelled",
          cause: "page-changed",
          settled: undefined,
        }),
      )?.report,
    ).toEqual({ version: 1, revision: 3, outcome: "cancelled", cause: "page-changed", step: 1 });
  });

  it("reports a watched login only when its watch ends (ADR 0027)", () => {
    // Where it stopped: a step left to the person, or a result settled as unknown.
    expect(
      loginOutcomeOf(
        attempt({ state: "watching", outcome: "challenge", settled: undefined, watched: true }),
      ),
    ).toBeUndefined();
    expect(loginOutcomeOf(attempt({ watched: true }))).toBeUndefined();
    // How the watch ended: signed in, abandoned, or ended where it stopped.
    expect(
      loginOutcomeOf(
        attempt({ state: "authenticated", outcome: "authenticated", settled: undefined }),
      )?.report,
    ).toEqual({ version: 1, revision: 3, outcome: "authenticated", step: 1 });
    expect(
      loginOutcomeOf(
        attempt({ state: "blocked", outcome: "challenge-abandoned", settled: undefined }),
      )?.report.outcome,
    ).toBe("challenge-abandoned");
    expect(
      loginOutcomeOf(attempt({ state: "blocked", outcome: "unknown-submit", settled: undefined }))
        ?.report,
    ).toEqual({ version: 1, revision: 3, outcome: "unknown-submit", step: 1 });
  });

  it("lets a listed cause take precedence over the settled flag", () => {
    expect(loginOutcomeOf(attempt({ cause: "sign-in-shown" }))?.report.cause).toBe("sign-in-shown");
  });

  it.each([
    ["a login without a recipe revision", { recipeRevision: 0 }],
    ["a login still running", { state: "executing", outcome: undefined, settled: undefined }],
    ["a login that retries", { state: "retryable", outcome: "timeout", settled: undefined }],
    ["a fill-only login", { state: "blocked", outcome: "cancelled", reason: "fill-only" }],
    ["a login stopped before a missing password", { state: "watching", stop: "password" }],
    [
      "a login of an item without a password that failed before its stop",
      {
        state: "blocked",
        outcome: "structural-mismatch",
        cause: "target-missing",
        stop: "password",
      },
    ],
    ["a cancel without a cause", { state: "blocked", outcome: "cancelled", settled: undefined }],
    [
      "a cancel with a cause outside the list",
      { state: "blocked", outcome: "cancelled", cause: "settings-saved", settled: undefined },
    ],
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
          outcome: "interrupted",
          cause: "settings-saved",
          settled: undefined,
        }),
      )?.report,
    ).toEqual({ version: 1, revision: 3, outcome: "interrupted", step: 1 });
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
    const { outcomes, reportOutcome, storage, settle, state } = setup({ connection: undefined });
    outcomes.observe(attempt());
    await settle();
    expect(reportOutcome).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    // Pairing later sends nothing for the login that ended before it.
    state.connection = CONNECTION;
    await settle();
    expect(reportOutcome).not.toHaveBeenCalled();
    // The revision's next ended login, once paired, is its first report.
    outcomes.observe(attempt({ state: "authenticated", outcome: "authenticated" }));
    await settle();
    expect(reportOutcome.mock.calls.map((call) => call[3].outcome)).toEqual(["authenticated"]);
    const rejected = setup({ connection: { ...CONNECTION, rejected: true } });
    rejected.outcomes.observe(attempt());
    await rejected.settle();
    expect(rejected.reportOutcome).not.toHaveBeenCalled();
  });

  it("keeps a report the service could not take and sends it once a minute on", async () => {
    let answer: OutcomeResult = { kind: "failed", error: "unreachable" };
    const { outcomes, reportOutcome, settle, state, stored } = setup({
      answer: async () => answer,
    });
    outcomes.observe(attempt());
    await settle();
    // One attempt now; the flush the test itself makes waits a minute after the failure.
    expect(reportOutcome).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ entries: [{ revision: 3, pending: { revision: 3 } }] });
    // Another ended login a minute on, of the same revision here, sends what is pending
    // without a flush, and the revision is not reported again.
    state.now += OUTCOME_RETRY_MS;
    answer = { kind: "kept" };
    outcomes.observe(attempt({ state: "authenticated", outcome: "authenticated" }));
    await vi.waitFor(() => expect(reportOutcome).toHaveBeenCalledTimes(2));
    expect(reportOutcome.mock.calls.at(-1)![3]).toMatchObject({ outcome: "unknown-submit" });
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(2);
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
    expect(reportOutcome).toHaveBeenCalledTimes(2);
  });

  it("sends nothing more for a repeat of an ended login", async () => {
    const { outcomes, reportOutcome, storage } = setup();
    // A report left pending, as by an earlier outage, and no failure since.
    await storage.write({
      version: 1,
      entries: [
        {
          service: CONNECTION.origin,
          deviceId: CONNECTION.deviceId,
          recipeId: "gen-0123",
          revision: 2,
          at: 1_000,
          pending: { version: 1, revision: 2, outcome: "authenticated", step: 1 },
        },
      ],
    });
    // Each new document of a held tab repeats its ended login; none sends.
    outcomes.observe(
      attempt({
        recipeRevision: 2,
        state: "authenticated",
        outcome: "authenticated",
        settled: undefined,
        repeat: true,
      }),
    );
    outcomes.observe(
      attempt({ state: "blocked", outcome: "policy-changed", settled: undefined, repeat: true }),
    );
    await vi.waitFor(() => expect(storage.read).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reportOutcome).not.toHaveBeenCalled();
    // A repeat of a revision this device never recorded is still its first report.
    outcomes.observe(
      attempt({
        recipeRevision: 4,
        state: "blocked",
        outcome: "structural-mismatch",
        settled: undefined,
        repeat: true,
      }),
    );
    await vi.waitFor(() => expect(reportOutcome).toHaveBeenCalledTimes(2));
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([2, 4]);
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

  it("sends a backlog a few at a time, and one request a minute while it fails", async () => {
    let answer: OutcomeResult = { kind: "failed", error: "rate-limited" };
    const { outcomes, reportOutcome, settle, state } = setup({ answer: async () => answer });
    for (let revision = 1; revision <= MAX_OUTCOME_SENDS + 2; revision += 1)
      outcomes.observe(attempt({ recipeRevision: revision }));
    await settle();
    // The first ended login tried the oldest report; the failure held off every run after.
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([1]);
    state.now += OUTCOME_RETRY_MS - 1;
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(1);
    state.now += 1;
    await settle();
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([1, 1]);
    reportOutcome.mockClear();
    state.now += OUTCOME_RETRY_MS;
    answer = { kind: "kept" };
    await settle();
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([1, 2, 3, 4, 5]);
    // Kept reports hold nothing off.
    await settle();
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("sends what is pending at an ended login it reports nothing for", async () => {
    let answer: OutcomeResult = { kind: "failed", error: "unreachable" };
    const { outcomes, reportOutcome, state } = setup({ answer: async () => answer });
    outcomes.observe(attempt());
    await vi.waitFor(() => expect(reportOutcome).toHaveBeenCalledTimes(1));
    state.now += OUTCOME_RETRY_MS;
    answer = { kind: "kept" };
    outcomes.observe(
      attempt({
        recipeRevision: 9,
        state: "blocked",
        outcome: "policy-changed",
        settled: undefined,
      }),
    );
    await vi.waitFor(() => expect(reportOutcome).toHaveBeenCalledTimes(2));
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([3, 3]);
  });

  it("drops a report still pending after 14 days and keeps its revision reported", async () => {
    const { outcomes, reportOutcome, settle, state, stored } = setup({
      answer: async () => ({ kind: "failed", error: "unreachable" }),
    });
    outcomes.observe(attempt());
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(1);
    state.now += PENDING_OUTCOME_MS;
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(2);
    state.now += OUTCOME_RETRY_MS;
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual({
      version: 1,
      entries: [expect.not.objectContaining({ pending: expect.anything() })],
    });
    outcomes.observe(attempt({ state: "authenticated", outcome: "authenticated" }));
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(2);
  });

  it("stops at a report the service answers unexpectedly and puts it behind the others", async () => {
    const { outcomes, reportOutcome, settle, state, stored, logged } = setup();
    reportOutcome.mockResolvedValue({ kind: "failed", error: "unreachable" });
    outcomes.observe(attempt({ recipeRevision: 1 }));
    outcomes.observe(attempt({ recipeRevision: 2, branch: "other" }));
    await settle();
    expect(reportOutcome).toHaveBeenCalledTimes(1);
    // A 5xx or an HTML error page for revision 1 ends the run and moves it last.
    reportOutcome.mockImplementation(async (_origin, _credential, _id, report) =>
      report.revision === 1 ? { kind: "failed", error: "unexpected-response" } : { kind: "kept" },
    );
    state.now += OUTCOME_RETRY_MS;
    await settle();
    expect(stored()).toMatchObject({
      entries: [
        { revision: 2, pending: { revision: 2 } },
        { revision: 1, pending: { revision: 1 } },
      ],
    });
    state.now += OUTCOME_RETRY_MS;
    await settle();
    // One request per run while revision 1 fails; revision 2 is not held back by it.
    expect(reportOutcome.mock.calls.map((call) => call[3].revision)).toEqual([1, 1, 2, 1]);
    expect(stored()).toMatchObject({
      entries: [{ revision: 2 }, { revision: 1, pending: { revision: 1 } }],
    });
    expect((stored() as { entries: object[] }).entries[0]).not.toHaveProperty("pending");
    // The local log gets one value-free line per request (ADR 0019).
    expect(logged).toEqual([
      { recipeId: "gen-0123", revision: 1, result: "failed:unreachable" },
      { recipeId: "gen-0123", revision: 1, result: "failed:unexpected-response" },
      { recipeId: "gen-0123", revision: 2, branch: "other", result: "kept" },
      { recipeId: "gen-0123", revision: 1, result: "failed:unexpected-response" },
    ]);
  });

  it("never throws into the login when sending or storage fails", async () => {
    const failing = setup({
      answer: async () => {
        throw new Error("synthetic transport failure");
      },
    });
    expect(() => failing.outcomes.observe(attempt())).not.toThrow();
    await expect(failing.settle()).resolves.toBeUndefined();
    expect(failing.logged.map((sent) => sent.result)).toEqual(["failed:threw"]);

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
