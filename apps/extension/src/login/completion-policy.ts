import type { LoginRoute } from "@pateat/contracts";
import type { SignInDecision } from "./sign-in-state";

type JudgeVerdict = "signed-in" | "rejected" | "challenge" | "unclear" | "retry";
type Reading = { decision: SignInDecision; confirmed: boolean };

/**
 * Why the judge gave no verdict that still completes a page with no sign and no evidence
 * (ADR 0029): the model could not decide (no reason), the path was judged before, as
 * undecided or signed in, or a spending or judgement limit applies. A page judged
 * `challenge` or `rejected` before, an unanswered request, a failure, a conflict or a
 * missing service does not.
 */
const UNDECIDED_COMPLETES = new Set([
  undefined,
  "already-judged",
  "judged-signed-in",
  "judgement-limit",
  "daily-limit",
  "monthly-limit",
]);

/** Whether an undecided page can complete, pending a fresh reading after the judge. */
export function undecidedCandidate({
  verdict,
  reason,
  reading,
  watched,
  route,
  stopAt,
}: {
  verdict: JudgeVerdict;
  reason?: string | undefined;
  reading?: Reading | undefined;
  watched: boolean;
  route: LoginRoute;
  stopAt?: number | undefined;
}): { completes: boolean; stopHeld: boolean } {
  const undecided = verdict === "unclear";
  // A login stopped before its missing password needs the judge's own signed-in answer
  // (ADR 0036), including a path it found signed in before.
  const stopHeld = undecided && stopAt !== undefined && reason !== "judged-signed-in";
  const completes =
    undecided &&
    reading?.confirmed === true &&
    reading.decision === "judge" &&
    !watched &&
    route !== "passkey" &&
    UNDECIDED_COMPLETES.has(reason) &&
    !stopHeld;
  return { completes, stopHeld };
}

/**
 * The judge may take a while: the fresh page must be loaded without a sign-in step.
 * A disabled field left out of its description prevents undecided completion (ADR 0029).
 */
export function settleCompletion({
  completes,
  stopHeld,
  again,
  disabledLeftOut,
}: {
  completes: boolean;
  stopHeld: boolean;
  again?: { decision: SignInDecision; loaded: boolean } | undefined;
  disabledLeftOut?: boolean;
}): { completes: boolean; notCompleted: "disabled-left-out" | "password-empty" | undefined } {
  if (completes)
    completes =
      again?.loaded === true && (again.decision === "judge" || again.decision === "signed-in");
  const notCompleted =
    completes && disabledLeftOut ? "disabled-left-out" : stopHeld ? "password-empty" : undefined;
  return { completes: completes && notCompleted === undefined, notCompleted };
}

/** A confirmed sign of another sign-in step (S2 to S5) without the sign-in fields. */
const continuing = (reading: Reading | undefined) =>
  reading?.confirmed === true && reading.decision === "continuing";

/** Outcome of an ordinary judged page; move and stop pages have their own rules. */
export function judgedCompletionResult({
  verdict,
  reason,
  reading,
  completes,
  stopHeld,
  route,
  stopAt,
}: {
  verdict: JudgeVerdict;
  reason?: string | undefined;
  reading?: Reading | undefined;
  completes: boolean;
  stopHeld: boolean;
  route: LoginRoute;
  stopAt?: number | undefined;
}): {
  result: "authenticated" | "credential-rejected" | "challenge" | "unknown";
  confirmed: boolean;
} {
  if (verdict === "signed-in" || completes)
    return {
      result: "authenticated",
      confirmed:
        verdict === "signed-in" || (verdict === "unclear" && reason === "judged-signed-in"),
    };
  const result =
    verdict === "rejected"
      ? "credential-rejected"
      : verdict === "challenge" ||
          reason === "judged-challenge" ||
          (verdict === "unclear" && continuing(reading)) ||
          stopHeld
        ? "challenge"
        : "unknown";
  // Unproven passkey pages always challenge; a missing-password stop challenges an
  // unknown page too (ADR 0027, ADR 0036), as elsewhere in the runtime.
  return {
    result:
      route === "passkey" || (stopAt !== undefined && result === "unknown") ? "challenge" : result,
    confirmed: false,
  };
}
