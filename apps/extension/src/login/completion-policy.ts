import type { LoginRoute } from "@pateat/contracts";
import type { SignInDecision } from "./sign-in-state";

type JudgeVerdict = "signed-in" | "rejected" | "challenge" | "optional" | "unclear" | "retry";
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

/**
 * Whether an undecided page can complete, pending a fresh reading after the judge. An
 * optional page after the sign-in (ADR 0065) completes, watched or not, only on the
 * `password` route once this attempt sent the account's credential (`sent`), without a
 * stop before a missing password, with no radio button, select or text area left out of
 * its description (`inputLeftOut`), and while the page shows no sign and no evidence.
 */
export function undecidedCandidate({
  verdict,
  reason,
  reading,
  watched,
  route,
  stopAt,
  sent = false,
  inputLeftOut = false,
}: {
  verdict: JudgeVerdict;
  reason?: string | undefined;
  reading?: Reading | undefined;
  watched: boolean;
  route: LoginRoute;
  stopAt?: number | undefined;
  sent?: boolean;
  inputLeftOut?: boolean;
}): { completes: boolean; stopHeld: boolean } {
  const optional = verdict === "optional";
  const undecided = verdict === "unclear";
  // A login stopped before its missing password needs the judge's own signed-in answer
  // (ADR 0036), including a path it found signed in before; an optional page does not
  // count (ADR 0065).
  const stopHeld = (undecided || optional) && stopAt !== undefined && reason !== "judged-signed-in";
  const quiet = reading?.confirmed === true && reading.decision === "judge";
  if (optional)
    return {
      completes: quiet && sent && route !== "passkey" && !inputLeftOut && !stopHeld,
      stopHeld,
    };
  // The `passkey` route completes as the `password` route does (owner, 2026-10-24 22:45
  // UTC, ADR 0029 amendment of 2026-10-24).
  const completes = undecided && quiet && !watched && UNDECIDED_COMPLETES.has(reason) && !stopHeld;
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
  path,
}: {
  completes: boolean;
  stopHeld: boolean;
  again?: { decision: SignInDecision; loaded: boolean; path?: string } | undefined;
  disabledLeftOut?: boolean;
  /**
   * An optional page's path (ADR 0065), which the fresh reading must still be on; left out
   * for an undecided page, which ADR 0029 lets route on while it is judged.
   */
  path?: string;
}): { completes: boolean; notCompleted: "disabled-left-out" | "password-empty" | undefined } {
  if (completes)
    completes =
      again?.loaded === true &&
      (path === undefined || again.path === path) &&
      (again.decision === "judge" || again.decision === "signed-in");
  const notCompleted =
    completes && disabledLeftOut ? "disabled-left-out" : stopHeld ? "password-empty" : undefined;
  return { completes: completes && notCompleted === undefined, notCompleted };
}

/** A confirmed sign of another sign-in step (S2 to S5) without the sign-in fields. */
const continuing = (reading: Reading | undefined) =>
  reading?.confirmed === true && reading.decision === "continuing";

/**
 * Outcome of an ordinary judged page; move and stop pages have their own rules. An optional
 * page that did not complete fails closed (ADR 0065): a `challenge` once the attempt sent its
 * credential, as when it shows a sign of a sign-in step or changed before the fresh reading;
 * before that, as on the page after an identifier, it is not known to be signed in at all.
 */
export function judgedCompletionResult({
  verdict,
  reason,
  reading,
  completes,
  stopHeld,
  route,
  stopAt,
  sent = false,
}: {
  verdict: JudgeVerdict;
  reason?: string | undefined;
  reading?: Reading | undefined;
  completes: boolean;
  stopHeld: boolean;
  route: LoginRoute;
  stopAt?: number | undefined;
  sent?: boolean;
}): {
  result: "authenticated" | "credential-rejected" | "challenge" | "unknown";
  confirmed: boolean;
} {
  if (verdict === "signed-in" || completes)
    return {
      result: "authenticated",
      confirmed:
        verdict === "signed-in" ||
        verdict === "optional" ||
        (verdict === "unclear" && reason === "judged-signed-in"),
    };
  const result =
    verdict === "rejected"
      ? "credential-rejected"
      : verdict === "challenge" ||
          (verdict === "optional" && sent) ||
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
