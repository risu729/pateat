import { describe, expect, it } from "vitest";
import { judgedCompletionResult, settleCompletion, undecidedCandidate } from "./completion-policy";

const candidate = {
  verdict: "unclear",
  reading: { decision: "judge", confirmed: true },
  watched: false,
  route: "password",
} as const;

describe("undecidedCandidate", () => {
  it.each([
    [undefined, true],
    ["already-judged", true],
    ["judged-signed-in", true],
    ["judgement-limit", true],
    ["daily-limit", true],
    ["monthly-limit", true],
    ["judged-challenge", false],
    ["judged-rejected", false],
    ["judgement-unanswered", false],
    ["busy", false],
    ["failed", false],
    ["timeout", false],
    ["unreachable", false],
    ["not-connected", false],
    ["device-rejected", false],
    ["invalid-output", false],
    ["conflict", false],
    ["unpaired", false],
    ["unsupported-page", false],
    ["page-limit", false],
    ["unknown-reason", false],
  ])("ADR 0029: reason %s gives completes=%s", (reason, completes) => {
    expect(undecidedCandidate({ ...candidate, reason })).toEqual({
      completes,
      stopHeld: false,
    });
  });

  it.each([
    { watched: true },
    { route: "passkey" as const },
    { reading: undefined },
    { reading: { decision: "judge" as const, confirmed: false } },
    { reading: { decision: "continuing" as const, confirmed: true } },
    { reading: { decision: "unknown" as const, confirmed: true } },
    { reading: { decision: "rejected" as const, confirmed: true } },
    { reading: { decision: "signed-in" as const, confirmed: true } },
    { verdict: "retry" as const },
    { verdict: "signed-in" as const },
    { verdict: "rejected" as const },
    { verdict: "challenge" as const },
  ])("does not complete an ineligible page: %j", (change) => {
    expect(undecidedCandidate({ ...candidate, ...change })).toEqual({
      completes: false,
      stopHeld: false,
    });
  });

  it.each([
    undefined,
    "already-judged",
    "judged-signed-in",
    "judgement-limit",
    "daily-limit",
    "monthly-limit",
  ])("never completes a watched or passkey page for reason %s", (reason) => {
    expect(undecidedCandidate({ ...candidate, reason, watched: true })).toEqual({
      completes: false,
      stopHeld: false,
    });
    expect(undecidedCandidate({ ...candidate, reason, route: "passkey" })).toEqual({
      completes: false,
      stopHeld: false,
    });
  });

  it.each([
    [undefined, false, true],
    ["already-judged", false, true],
    ["judged-signed-in", true, false],
    ["judged-challenge", false, true],
  ])("ADR 0036: a password stop with reason %s", (reason, completes, stopHeld) => {
    expect(undecidedCandidate({ ...candidate, stopAt: 0, reason })).toEqual({
      completes,
      stopHeld,
    });
  });

  it.each(["signed-in", "rejected", "challenge", "retry"] as const)(
    "does not hold a decided or retry verdict %s at a password stop",
    (verdict) => {
      expect(undecidedCandidate({ ...candidate, verdict, stopAt: 0 })).toEqual({
        completes: false,
        stopHeld: false,
      });
    },
  );
});

describe("an optional page after the sign-in (ADR 0065)", () => {
  const verdicts = [
    { verdict: "optional" },
    { verdict: "unclear", reason: "judged-optional" },
  ] as const;

  it.each(verdicts)("completes confirmed, watched or not, on either route: %j", (answer) => {
    for (const change of [{}, { watched: true }, { route: "passkey" as const }, { stopAt: 0 }]) {
      const { completes, stopHeld } = undecidedCandidate({ ...candidate, ...answer, ...change });
      expect({ completes, stopHeld }).toEqual({ completes: true, stopHeld: false });
      expect(judgedCompletionResult({ ...answer, completes, stopHeld, route: "password" })).toEqual(
        { result: "authenticated", confirmed: true },
      );
    }
  });

  it.each(verdicts)("fails closed as a challenge on a page with a sign: %j", (answer) => {
    for (const reading of [
      undefined,
      { decision: "judge" as const, confirmed: false },
      { decision: "continuing" as const, confirmed: true },
      { decision: "unknown" as const, confirmed: true },
      { decision: "rejected" as const, confirmed: true },
      { decision: "signed-in" as const, confirmed: true },
    ]) {
      const { completes, stopHeld } = undecidedCandidate({ ...candidate, ...answer, reading });
      expect(completes).toBe(false);
      expect(
        judgedCompletionResult({ ...answer, reading, completes, stopHeld, route: "password" }),
      ).toEqual({ result: "challenge", confirmed: false });
    }
  });

  it("fails closed when the fresh reading shows a sign or a disabled field was left out", () => {
    const optional = undecidedCandidate({ ...candidate, verdict: "optional" });
    for (const settled of [
      settleCompletion({ ...optional, again: { decision: "continuing", loaded: true } }),
      settleCompletion({ ...optional, again: { decision: "judge", loaded: false } }),
      settleCompletion({
        ...optional,
        again: { decision: "judge", loaded: true },
        disabledLeftOut: true,
      }),
    ]) {
      expect(
        judgedCompletionResult({
          verdict: "optional",
          completes: settled.completes,
          stopHeld: false,
          route: "password",
        }).result,
      ).toBe("challenge");
    }
  });
});

describe("settleCompletion", () => {
  it.each([
    [undefined, false],
    [{ decision: "judge", loaded: false }, false],
    [{ decision: "signed-in", loaded: false }, false],
    [{ decision: "judge", loaded: true }, true],
    [{ decision: "signed-in", loaded: true }, true],
    [{ decision: "unknown", loaded: true }, false],
    [{ decision: "continuing", loaded: true }, false],
    [{ decision: "rejected", loaded: true }, false],
  ] as const)("requires a quiet loaded re-reading: %j", (again, completes) => {
    expect(settleCompletion({ completes: true, stopHeld: false, again })).toEqual({
      completes,
      notCompleted: undefined,
    });
  });

  it.each([
    [true, false, true, false, "disabled-left-out"],
    [true, false, false, true, undefined],
    [false, false, true, false, undefined],
    [false, true, false, false, "password-empty"],
    [false, true, true, false, "password-empty"],
  ] as const)(
    "settles candidate=%s stopHeld=%s disabledLeftOut=%s",
    (candidateCompletes, stopHeld, disabledLeftOut, completes, notCompleted) => {
      expect(
        settleCompletion({
          completes: candidateCompletes,
          stopHeld,
          disabledLeftOut,
          again: { decision: "judge", loaded: true },
        }),
      ).toEqual({ completes, notCompleted });
    },
  );

  it("does not report a disabled omission when the re-reading prevents completion", () => {
    expect(
      settleCompletion({
        completes: true,
        stopHeld: false,
        disabledLeftOut: true,
        again: { decision: "continuing", loaded: true },
      }),
    ).toEqual({ completes: false, notCompleted: undefined });
  });
});

describe("judgedCompletionResult", () => {
  const result = {
    verdict: "unclear",
    completes: false,
    stopHeld: false,
    route: "password",
  } as const;

  it.each([
    [{ verdict: "signed-in" }, "authenticated", true],
    [{ completes: true }, "authenticated", false],
    [{ completes: true, reason: "already-judged" }, "authenticated", false],
    [{ completes: true, reason: "judgement-limit" }, "authenticated", false],
    [{ completes: true, reason: "daily-limit" }, "authenticated", false],
    [{ completes: true, reason: "monthly-limit" }, "authenticated", false],
    [{ completes: true, reason: "judged-signed-in" }, "authenticated", true],
    [{ verdict: "rejected" }, "credential-rejected"],
    [{ verdict: "challenge" }, "challenge"],
    [{ reason: "judged-challenge" }, "challenge"],
    [{ reading: { decision: "continuing", confirmed: true } }, "challenge"],
    [{ reading: { decision: "continuing", confirmed: false } }, "unknown"],
    [{ verdict: "retry", reading: { decision: "continuing", confirmed: true } }, "unknown"],
    [{ stopHeld: true }, "challenge"],
    [{}, "unknown"],
    [{ route: "passkey" }, "challenge"],
    [{ route: "passkey", verdict: "rejected" }, "challenge"],
    [{ route: "passkey", verdict: "signed-in" }, "authenticated", true],
    [{ stopAt: 0 }, "challenge"],
    [{ stopAt: 0, verdict: "rejected" }, "credential-rejected"],
    [{ stopAt: 0, verdict: "signed-in" }, "authenticated", true],
  ] as const)(
    "selects ADR 0029's outcome: %j → %s (confirmed=%s)",
    (change, expected, confirmed = false) => {
      expect(judgedCompletionResult({ ...result, ...change })).toEqual({
        result: expected,
        confirmed,
      });
    },
  );
});
