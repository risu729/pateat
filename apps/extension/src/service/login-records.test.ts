import { describe, expect, it, vi } from "vitest";
import type { LoginReport } from "../login/runtime";
import { createLoginRecords, loginRecordOf, type LoginRecordSent } from "./login-records";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// Synthetic reports, recipes and service only; nothing leaves the test.

const BUILD = "1c42ad3e9f0b5d7a6c4e2f1a3b5d7e9f0a1c3e5d";
const CONNECTION: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const TIMES = {
  totalMs: 9_000,
  serviceMs: 2_600,
  networkMs: 200,
  personMs: 4_000,
  pageMs: 1_500,
  otherMs: 900,
};

type AttemptReport = Extract<LoginReport, { type: "attempt" }>;
type Overrides = { [K in keyof AttemptReport]?: AttemptReport[K] | undefined };
/** A login that just signed in, with its times. */
function ended(overrides: Overrides = {}): LoginReport {
  return {
    type: "attempt",
    tabId: 7,
    origin: "https://bank.example",
    recipeId: "gen-0123",
    recipeRevision: 3,
    route: "password",
    variant: 0,
    state: "authenticated",
    stepIndex: 2,
    stepCount: 2,
    outcome: "authenticated",
    reason: "signed-in",
    url: "https://bank.example/home?user=someone",
    times: TIMES,
    ...overrides,
  } as LoginReport;
}

describe("loginRecordOf", () => {
  it("sends the codes, the build and the times, never the URL, origin, reason or typing", () => {
    expect(loginRecordOf(ended(), BUILD)).toEqual({
      recipeId: "gen-0123",
      record: {
        version: 1,
        revision: 3,
        outcome: "authenticated",
        extensionBuild: BUILD,
        totalMs: 9_000,
        serviceMs: 2_600,
        networkMs: 200,
        personMs: 4_000,
        pageMs: 1_500,
      },
    });
  });

  it("keeps the chooser branch and a listed cause of a blocked login", () => {
    expect(
      loginRecordOf(
        ended({
          state: "blocked",
          outcome: "structural-mismatch",
          cause: "target-missing",
          branch: "other",
        }),
        "development",
      ),
    ).toMatchObject({
      record: {
        branch: "other",
        outcome: "structural-mismatch",
        cause: "target-missing",
        extensionBuild: "development",
      },
    });
    // A watch that ran out ends blocked with what it left (ADR 0027).
    expect(
      loginRecordOf(
        ended({ state: "blocked", outcome: "challenge-abandoned", watched: true }),
        BUILD,
      ),
    ).toMatchObject({ record: { outcome: "challenge-abandoned" } });
  });

  it("sends nothing for a login that did not end with its times, or that #761 leaves out", () => {
    const none: LoginReport[] = [
      // Not ended: no times.
      ended({ state: "reconciling", outcome: "unknown-submit", settled: true, times: undefined }),
      ended({ state: "watching", outcome: "challenge", times: undefined }),
      // A repeat report of an ended login carries no times; one with them is still a repeat.
      ended({ repeat: true }),
      // No service recipe revision.
      ended({ recipeRevision: 0 }),
      ended({ recipeId: "not a recipe" }),
      // Runs only part of the revision.
      ended({ reason: "fill-only" }),
      ended({ stop: "password" }),
      // Settings, the vault or the account changed under the login, or a cancel without cause.
      ended({ state: "blocked", outcome: "policy-changed" }),
      ended({ state: "blocked", outcome: "account-switched" }),
      ended({ state: "blocked", outcome: "cancelled" }),
    ];
    for (const report of none) expect(loginRecordOf(report, BUILD)).toBeUndefined();
    expect(
      loginRecordOf({ type: "refused", tabId: 7, origin: "https://bank.example" } as never, BUILD),
    ).toBeUndefined();
  });
});

function setup(
  options: {
    connection?: ServiceConnection | undefined;
    answer?: () => Promise<OutcomeResult>;
  } = {},
) {
  const answer = options.answer ?? (async (): Promise<OutcomeResult> => ({ kind: "kept" }));
  const reportLogin = vi.fn<ServiceTransport["reportLogin"]>(() => answer());
  const logged: LoginRecordSent[] = [];
  const connection = "connection" in options ? options.connection : CONNECTION;
  const records = createLoginRecords({
    service: { connection: async () => connection },
    transport: { reportLogin },
    build: BUILD,
    report: (sent) => logged.push(sent),
  });
  return { records, reportLogin, logged };
}

describe("createLoginRecords", () => {
  it("sends every ended login once, not only a revision's first", async () => {
    const { records, reportLogin, logged } = setup();
    records.observe(ended());
    records.observe(ended({ times: { ...TIMES, totalMs: 3_000, personMs: 0 } }));
    records.observe(ended({ repeat: true }));
    await vi.waitFor(() => expect(logged).toHaveLength(2));
    expect(reportLogin.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [CONNECTION.origin, CONNECTION.credential, "gen-0123"],
      [CONNECTION.origin, CONNECTION.credential, "gen-0123"],
    ]);
    expect(reportLogin.mock.calls.map((call) => call[3].totalMs)).toEqual([9_000, 3_000]);
    expect(logged).toEqual([
      { recipeId: "gen-0123", revision: 3, result: "kept" },
      { recipeId: "gen-0123", revision: 3, result: "kept" },
    ]);
  });

  it("names a record the contract refuses instead of sending it", () => {
    // A build the contract does not accept, or a time over its day.
    expect(loginRecordOf(ended(), "Release 1")).toEqual({
      recipeId: "gen-0123",
      invalid: { revision: 3 },
    });
    expect(
      loginRecordOf(ended({ branch: "other", times: { ...TIMES, totalMs: 86_400_001 } }), BUILD),
    ).toEqual({ recipeId: "gen-0123", invalid: { revision: 3, branch: "other" } });
  });

  it("logs a record the contract refuses as failed:invalid-record without sending it", async () => {
    const reportLogin = vi.fn<ServiceTransport["reportLogin"]>();
    const logged: LoginRecordSent[] = [];
    const records = createLoginRecords({
      service: { connection: async () => CONNECTION },
      transport: { reportLogin },
      build: "Release 1",
      report: (sent) => logged.push(sent),
    });
    records.observe(ended());
    await vi.waitFor(() =>
      expect(logged).toEqual([
        { recipeId: "gen-0123", revision: 3, result: "failed:invalid-record" },
      ]),
    );
    expect(reportLogin).not.toHaveBeenCalled();
  });

  it("sends nothing without a paired service or with a rejected device", async () => {
    const unpaired = setup({ connection: undefined });
    unpaired.records.observe(ended());
    const rejected = setup({ connection: { ...CONNECTION, rejected: true } });
    rejected.records.observe(ended());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unpaired.reportLogin).not.toHaveBeenCalled();
    expect(rejected.reportLogin).not.toHaveBeenCalled();
  });

  it("logs a failure and never retries it or throws into the login", async () => {
    const { records, reportLogin, logged } = setup({
      answer: async () => ({ kind: "failed", error: "unreachable" }),
    });
    records.observe(ended({ branch: "other" }));
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toEqual({
      recipeId: "gen-0123",
      revision: 3,
      branch: "other",
      result: "failed:unreachable",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reportLogin).toHaveBeenCalledTimes(1);

    const throwing = setup({
      answer: async () => {
        throw new Error("synthetic");
      },
    });
    expect(() => throwing.records.observe(ended())).not.toThrow();
    await vi.waitFor(() =>
      expect(throwing.logged).toEqual([expect.objectContaining({ result: "failed:threw" })]),
    );
    const broken = createLoginRecords({
      service: {
        connection: async () => {
          throw new Error("synthetic");
        },
      },
      transport: { reportLogin },
      build: BUILD,
      report: () => {
        throw new Error("synthetic");
      },
    });
    expect(() => broken.observe(ended())).not.toThrow();
  });
});
