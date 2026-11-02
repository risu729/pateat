import { loginAttemptStateSchema, loginOutcomeSchema } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { badgeResult } from "./badge";
import type { LoginReport } from "./runtime/report";

vi.mock("wxt/browser", () => ({ browser: { action: {} } }));

// Every login outcome in every attempt state, checked against the result badge of ADR 0038.
// A new outcome code fails here until the ADR's lists, and this file's, say which it is.

type Attempt = Extract<LoginReport, { type: "attempt" }>;

/** ADR 0038's lists for a login that ends `blocked`. */
const failed = [
  "credential-rejected",
  "structural-mismatch",
  "timeout",
  "retry-limit",
  "submission-limit",
  "value-mismatch",
  "fill-rejected",
  "wrong-account",
  "account-not-listed",
];
const unknown = [
  "unknown-submit",
  "challenge",
  "challenge-abandoned",
  "watch-abandoned",
  "left-origin",
];
const none = ["cancelled", "account-switched", "interrupted", "policy-changed"];

const flags = [false, true];
const cases = loginAttemptStateSchema.options.flatMap((state) =>
  [undefined, ...loginOutcomeSchema.options].flatMap((outcome) =>
    flags.flatMap((settled) =>
      flags.flatMap((unconfirmed) =>
        flags.flatMap((repeat) =>
          [undefined, "elements-timeout"].map((cause) => {
            const report: Attempt = {
              type: "attempt",
              tabId: 7,
              origin: "https://login.example",
              recipeId: "recipe",
              recipeRevision: 1,
              route: "password",
              state,
              stepIndex: 0,
              stepCount: 2,
              ...(outcome ? { outcome } : {}),
              ...(settled ? { settled: true as const } : {}),
              ...(unconfirmed ? { unconfirmed: true as const } : {}),
              ...(repeat ? { repeat: true as const } : {}),
              ...(cause ? { cause: cause as NonNullable<Attempt["cause"]> } : {}),
            };
            return { report, result: badgeResult(report, 0) };
          }),
        ),
      ),
    ),
  ),
);

const kind = (result: ReturnType<typeof badgeResult>) =>
  typeof result === "object" ? result.kind : result;

describe("the result badge, over every attempt report (ADR 0038)", () => {
  it("lists every outcome a blocked login can end with once", () => {
    const listed = [...failed, ...unknown, ...none];
    expect(listed.toSorted()).toEqual(
      loginOutcomeSchema.options.filter((outcome) => outcome !== "authenticated").toSorted(),
    );
  });

  it("shows a blocked login's outcome as its list says", () => {
    expect(
      cases
        .filter(({ report }) => report.state === "blocked" && !report.repeat && report.outcome)
        .filter(({ report, result }) => {
          const outcome = report.outcome!;
          const expected = failed.includes(outcome)
            ? "failed"
            : unknown.includes(outcome)
              ? "unsettled"
              : "clear";
          return outcome !== "authenticated" && kind(result) !== expected;
        })
        .slice(0, 5),
    ).toEqual([]);
  });

  it("shows a signed-in login as succeeded, or unsettled when not confirmed", () => {
    expect(
      cases
        .filter(({ report }) => report.state === "authenticated" && !report.repeat)
        .filter(
          ({ report, result }) => kind(result) !== (report.unconfirmed ? "unsettled" : "succeeded"),
        )
        .slice(0, 5),
    ).toEqual([]);
  });

  it("shows nothing for a repeated report, and only a brief result unless the login failed", () => {
    expect(
      cases
        .filter(
          ({ report, result }) =>
            (report.repeat && result !== undefined) ||
            (typeof result === "object" &&
              (result.kind === "failed") === (result.until !== undefined)),
        )
        .slice(0, 5),
    ).toEqual([]);
  });

  it("names a failure by its outcome and cause", () => {
    expect(
      cases
        .filter(
          ({ report, result }) =>
            typeof result === "object" &&
            result.kind === "failed" &&
            result.reason !==
              (report.cause ? `${report.outcome}: ${report.cause}` : report.outcome),
        )
        .slice(0, 5),
    ).toEqual([]);
  });

  it("shows a login still going on as unsettled only on a settled unknown result or a second factor", () => {
    expect(
      cases
        .filter(({ report }) => report.state !== "blocked" && report.state !== "authenticated")
        .filter(({ report, result }) => {
          const unsettled =
            !report.repeat &&
            ((report.settled === true && report.outcome === "unknown-submit") ||
              report.outcome === "challenge");
          return kind(result) !== (unsettled ? "unsettled" : undefined);
        })
        .slice(0, 5),
    ).toEqual([]);
  });

  it("shows no failure for a login that has not ended", () => {
    expect(
      cases
        .filter(
          ({ report, result }) =>
            report.state !== "blocked" &&
            report.state !== "authenticated" &&
            kind(result) === "failed",
        )
        .slice(0, 5),
    ).toEqual([]);
  });
});
