// The sign-in state of ADR 0029 for the page after an effect step that no check explained.
// On the `password` route a confirmed decision acts (delivery 2); `unknown` only logs.

/** The signs read from the page (ADR 0029). */
export interface SignInSigns {
  /** S1: one of the route's sign-in elements shows. */
  readonly s1: boolean;
  /** S2: a shown password input that is not for a new password. */
  readonly s2: boolean;
  /** S3: a shown input for a one-time code. */
  readonly s3: boolean;
  /** S4: a shown CAPTCHA widget. */
  readonly s4: boolean;
  /** S5: the top document asked for a passkey, outside conditional mediation, after the step. */
  readonly s5: boolean;
  /** F1: an input became `aria-invalid="true"` in the submitted document. */
  readonly f1: boolean;
  /** F2: an alert shows new text in the submitted document. */
  readonly f2: boolean;
  /** E1: the recipe's signed-in marker shows, on any path. */
  readonly e1: boolean;
  /** E2: the username shows in the page header or navigation. */
  readonly e2: boolean;
  /** E3: the page is the same-origin return target the sign-in page's URL named. */
  readonly e3: boolean;
}

/**
 * What ADR 0029 would do with the page: `rejected` (a failure shows next to the sign-in
 * fields), `unknown` (the sign-in fields show), `continuing` (another sign-in step shows;
 * the judge learns a handler), `signed-in` (evidence without a model call) or `judge` (no
 * sign and no evidence; the judge decides, and an undecided answer completes).
 */
export type SignInDecision = "rejected" | "unknown" | "continuing" | "signed-in" | "judge";

export function decideSignInState(signs: SignInSigns): SignInDecision {
  if (signs.s1) return signs.f1 || signs.f2 ? "rejected" : "unknown";
  if (signs.s2 || signs.s3 || signs.s4 || signs.s5) return "continuing";
  if (signs.e1 || signs.e2 || signs.e3) return "signed-in";
  return "judge";
}

/**
 * E3: whether `current` is a same-origin URL or path that a query value of `start`, the
 * sign-in page's URL, names, as `?return_to=/settings` or `?next=https%3A%2F%2F…`. Any
 * parameter name counts. A target that is `/`, one of `excluded` (the sign-in paths) or
 * the sign-in page's own path does not count, as a failed sign-in may land there too.
 * Paths are compared without the query.
 */
export function reachedReturnTarget(
  start: string,
  current: string,
  excluded: readonly string[],
): boolean {
  let startUrl: URL;
  let currentUrl: URL;
  try {
    startUrl = new URL(start);
    currentUrl = new URL(current);
  } catch {
    return false;
  }
  if (currentUrl.origin !== startUrl.origin) return false;
  const path = currentUrl.pathname;
  if (path === "/" || path === startUrl.pathname || excluded.includes(path)) return false;
  for (const value of startUrl.searchParams.values()) {
    // A protocol-relative `//host/path` names another origin.
    if (!/^\/(?!\/)|^https?:/iu.test(value)) continue;
    let target: URL;
    try {
      target = new URL(value, startUrl.origin);
    } catch {
      continue;
    }
    if (target.origin === startUrl.origin && target.pathname === path) return true;
  }
  return false;
}
