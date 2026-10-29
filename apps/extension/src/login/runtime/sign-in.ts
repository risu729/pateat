import * as v from "valibot";
import {
  followPage,
  personAnswered,
  routeSignInPaths,
  routeSignInTargets,
  sameLoginDocument,
  sameLoginTarget,
  type LoginTarget,
} from "@pateat/contracts";
import { stateResultSchema, HELD_CLICK_WAIT_MS, type InPlaceNext } from "../wire";
import {
  decideSignInState,
  reachedReturnTarget,
  type ReshownMiss,
  type SignInDecision,
  type SignInSigns,
} from "../sign-in-state";
import type { AlertMiss } from "../../page/sign-in-state";
import { loginUsernameFieldId } from "../vault";
import { type Execution, type SignInReading } from "./types";
import { type AdvanceMiss } from "./report";
import { formAgain, sameMarkers, markerProof } from "./steps";
import {
  SIGN_IN_RECHECKS,
  SIGN_IN_RECHECK_MS,
  ADVANCE_LOG_TARGETS,
  WATCH_SETTLE_MS,
} from "./constants";
import { current, report, send, stepWaitMs, change } from "./attempt";
import { terminal } from "./attempt-state";
import { observe, reconcile, askAgain } from "./reconcile";
import { allowed } from "./plan-2";
import { learn } from "./judge";
import type { Runtime } from "./state";

/**
 * Reads and logs the sign-in state of ADR 0029 for a page no check explained: its signs
 * and what the ADR does with it. Returns the decision, `confirmed` only when a later
 * reading, a second apart, agrees in the fully loaded document, on the passkey route too
 * (ADR 0029 amendment of 2026-10-24). A login in a frame is not read, as the ADR reads
 * the top document.
 */
export async function signInState(
  rt: Runtime,
  run: Execution,
  advance?: AdvanceMiss,
): Promise<SignInReading | undefined> {
  let reading = await readSignInState(rt, run);
  let confirmed = false;
  // A decision counts once a later reading agrees in a fully loaded document, so a page
  // that is still redirecting or about to ask for a second factor is not settled; a
  // document still loading is read again, a second apart, up to `SIGN_IN_RECHECKS` times.
  // `unknown` changes nothing and is not read again, unless it is the sign-in form shown
  // again with nothing else, on which the tab asks again (ADR 0021 D). Each reading
  // depends on the time passed since the last, so they run one after another.
  /* eslint-disable no-await-in-loop */
  for (
    let recheck = 0;
    reading !== undefined &&
    (reading.decision !== "unknown" || formAgain(reading.signs)) &&
    recheck < SIGN_IN_RECHECKS;
    recheck++
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
    if (!current(rt, run) || terminal(run.metadata)) return undefined;
    const next = await readSignInState(rt, run);
    const agrees =
      next?.decision === reading.decision &&
      formAgain(next.signs) === formAgain(reading.signs) &&
      next.loaded;
    reading = next;
    if (agrees) {
      confirmed = true;
      break;
    }
  }
  /* eslint-enable no-await-in-loop */
  if (!reading) return undefined;
  report(rt, run.live.document, {
    type: "state",
    tabId: run.live.document.tabId,
    origin: run.live.document.origin,
    recipeId: run.recipe.id,
    recipeRevision: run.recipe.revision,
    route: run.metadata.route,
    ...reading.signs,
    decision: reading.decision,
    ...(run.metadata.settled ? { settled: true as const } : {}),
    ...reading.misses,
    ...advance,
  });
  return {
    decision: reading.decision,
    confirmed,
    ...(reading.signs.reshown ? { reshown: true as const } : {}),
    ...(formAgain(reading.signs) ? { formAgain: true as const } : {}),
    ...(reading.signs.s2 && !reading.signs.s4 ? { asksPassword: true as const } : {}),
  };
}

/**
 * Why an advance whose next step is on its own path (ADR 0013) was not confirmed, for the
 * log only (ADR 0019): the next step's first targets as measured just before the advance
 * (`unmeasured` without that measurement, as in another document after a worker restart
 * or for another operation), as read now with the same requirement, the check that
 * decided each reading now, and whether the page is on the step's path. Codes only.
 */
export async function advanceMiss(
  rt: Runtime,
  run: Execution,
  inPlace: InPlaceNext,
  path: string,
): Promise<AdvanceMiss | undefined> {
  const targets = inPlace.targets.slice(0, ADVANCE_LOG_TARGETS);
  const observed = await observe(
    rt,
    run,
    targets,
    targets.map(() => inPlace.require),
    { explain: true },
  );
  if (!observed?.checks) return undefined;
  const measured =
    run.inPlace && run.inPlace.operationId === run.metadata.operationId
      ? run.inPlace.before
      : undefined;
  return {
    advanceBefore: measured ? measured.slice(0, ADVANCE_LOG_TARGETS).join(".") : "unmeasured",
    advanceAfter: observed.targets.join("."),
    advanceWhy: observed.checks.join("."),
    advancePath: observed.path === path ? "same" : "other",
  };
}

/** Whether a sign-in target is the passkey route's button rather than a field (ADR 0027). */
export function passkeyButton(_rt: Runtime, run: Execution, target: LoginTarget): boolean {
  const button = run.metadata.route === "passkey" ? run.recipe.passkey?.target : undefined;
  return button !== undefined && sameLoginTarget(target, button);
}

/**
 * The page's signs of ADR 0029 and the decision they give, and whether the document has
 * finished loading. The username goes to the page's content script for its comparison
 * only.
 */
/**
 * Whether a signed-in marker of another layout of the login's recipe shows (ADR 0060),
 * read as the login's own markers are; `undefined` when the page could not be read.
 */
export async function otherLayoutsMarked(
  rt: Runtime,
  run: Execution,
): Promise<boolean | undefined> {
  const { recipe } = run;
  const layouts = await Promise.resolve(rt.recipes.layoutsOf?.(recipe.origin, recipe.id)).catch(
    () => undefined,
  );
  /* eslint-disable no-await-in-loop */
  for (const other of layouts ?? []) {
    if (other.layout === recipe.layout && sameMarkers(other, recipe)) continue;
    const proof = markerProof(other);
    if (!proof.targets.length) continue;
    const marked = await observe(rt, run, proof.targets, proof.shown, {
      links: proof.links,
      hidden: proof.hidden,
    });
    if (!marked) return undefined;
    if (proof.proves(marked.targets)) return true;
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

export async function readSignInState(
  rt: Runtime,
  run: Execution,
): Promise<
  | {
      signs: SignInSigns;
      decision: SignInDecision;
      loaded: boolean;
      /** The path the reading was taken on. */
      path: string;
      /** Why S1 is not read as the form shown again, or F2 not on it, for the log. */
      misses: { reshownMiss?: ReshownMiss; alertMiss?: AlertMiss };
    }
  | undefined
> {
  const { recipe, metadata } = run;
  if (run.live.topUrl !== undefined) return undefined;
  // Each marker shown, with the fields it needs gone counted even when hidden, as the
  // completion check counts them: a login form that hides itself again after a failed
  // sign-in is not a sign-in.
  // The markers are read on their own, so they never crowd out the sign-in fields.
  const proof = markerProof(recipe);
  const fills = routeSignInTargets(recipe, metadata.route).slice(0, 24);
  // Only a shown input counts as a field: another page may give a sign-in field's locator
  // to another element, as Wise's signed-in page gave its React ID to an empty div
  // (2026-10-12). The passkey route's button is no input and counts when shown.
  const observed = await observe(
    rt,
    run,
    fills,
    fills.map((target) => (passkeyButton(rt, run, target) ? "shown" : "shown-input")),
  );
  if (!observed) return undefined;
  const marked =
    proof.targets.length > 0
      ? await observe(rt, run, proof.targets, proof.shown, {
          links: proof.links,
          hidden: proof.hidden,
        })
      : undefined;
  if (proof.targets.length > 0 && !marked) return undefined;
  // The signed-in markers the recipe's other layouts learned count as well (ADR 0060): a
  // page of one layout's site may sign in to a page another layout learned.
  const otherMarked = await otherLayoutsMarked(rt, run);
  if (otherMarked === undefined) return undefined;
  const authorized = await allowed(rt, run);
  if (!authorized) return undefined;
  let username: string | undefined;
  // A login that stops before its item's missing password is not signed in by its
  // username in the header or navigation (E2): the page after the identifier may show it
  // before the sign-in (ADR 0036). The username is not read for it at all.
  const usernameField =
    metadata.stopAt === undefined
      ? loginUsernameFieldId(authorized.connection, metadata.account.itemId)
      : undefined;
  if (usernameField) {
    try {
      username = await rt.fields({
        account: metadata.account,
        connection: authorized.connection,
        fieldId: usernameField,
      });
    } catch {
      username = undefined;
    }
    if (!current(rt, run)) return undefined;
  }
  const s1 = observed.targets.slice(0, fills.length).some((state) => state === "unique");
  const { tabId, origin: pageOrigin } = run.live.document;
  const effect = rt.effects.get(tabId);
  // The sign-in form shown again in the first new top document after this attempt's
  // password submission, as by a site that answers a failed submission with its sign-in
  // page: its inputs' marks and the alerts next to it are read without the step's own
  // reading (owner, 2026-10-12 22:03 UTC). A later document, such as the person's own
  // retry, is not; nor is one after an advance or a passkey step. Without the step in
  // memory, as after a worker restart, it is not read.
  const reshownMiss: ReshownMiss | undefined =
    effect?.attemptId !== metadata.id
      ? "no-effect"
      : effect.passkey
        ? "passkey-step"
        : !effect.submits
          ? "not-submit"
          : sameLoginDocument(effect.document, run.live.document)
            ? "same-document"
            : effect.next === undefined
              ? "late"
              : effect.next !== run.live.document.documentId
                ? "later-document"
                : undefined;
  const reshown = s1 && reshownMiss === undefined;
  let response: unknown;
  try {
    response = await send(rt, run.live, {
      type: "login.state",
      ...(username ? { account: { username } } : {}),
      ...(reshown ? { fields: fills } : {}),
    });
  } catch {
    return undefined;
  }
  if (!current(rt, run)) return undefined;
  const parsed = v.safeParse(stateResultSchema, response);
  if (!parsed.success || !parsed.output.ok) return undefined;
  const page = parsed.output.signs;
  const requested = rt.passkeyRequests.get(`${tabId} ${pageOrigin}`);
  const answered = rt.passkeyAnswers.get(`${tabId} ${pageOrigin}`)?.at;
  const signInUrl = rt.signInUrls.get(tabId);
  const signs: SignInSigns = {
    s1,
    s2: page.password,
    s3: page.code,
    s4: page.captcha,
    // After a step that asked for a passkey itself, its request counts only while no
    // answer of Pateat's followed it: one still open, left to the browser, or another
    // after the answer (ADR 0029 amendment of 2026-10-24).
    s5:
      effect?.attemptId === metadata.id &&
      requested !== undefined &&
      requested >= effect.at &&
      (!effect.request || answered === undefined || answered < requested),
    // A failure counts only next to the sign-in fields.
    f1: s1 && page.invalid,
    f2: s1 && page.alert,
    e1: (marked !== undefined && proof.proves(marked.targets)) || otherMarked,
    e2: page.username === true,
    // The document's path now, which follows a route change of a single-page site.
    e3:
      signInUrl?.attemptId === metadata.id &&
      reachedReturnTarget(
        signInUrl.url,
        `${pageOrigin}${observed.path}`,
        routeSignInPaths(recipe, metadata.route),
      ),
    ...(reshown ? { reshown: true as const } : {}),
  };
  // Value-free reasons for the log: why the form was not read as shown again, or why no
  // alert beside it counted (ADR 0019).
  const misses =
    s1 && reshownMiss !== undefined
      ? { reshownMiss }
      : reshown && !signs.f2 && page.alertMiss !== undefined
        ? { alertMiss: page.alertMiss }
        : {};
  return {
    signs,
    decision: decideSignInState(signs),
    loaded: parsed.output.loaded,
    path: observed.path,
    misses,
  };
}

// State transitions, journal writes and DOM effects form an ordered protocol.
// Parallel execution would race policy checks or repeat submission side effects.
/* eslint-disable no-await-in-loop */
export async function reconcileBounded(rt: Runtime, run: Execution): Promise<void> {
  // An advance is confirmed by the next step's elements, which get the same wait as any
  // fill or click; other results keep the shorter observation budget.
  let until = Date.now() + (run.metadata.operationEffect === "advance" ? stepWaitMs(rt) : 3000);
  // A held click's button may show this long before the page is left to the person.
  const holdUntil = Date.now() + HELD_CLICK_WAIT_MS;
  const observing = () => ["awaiting-result", "reconciling"].includes(run.metadata.state);
  // Each round re-authorizes against settings, so the longer advance budget polls slower.
  const interval = run.metadata.operationEffect === "advance" ? 200 : 50;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  while (current(rt, run) && observing()) {
    const settle = Date.now() >= until;
    const held = await reconcile(rt, run, settle);
    if (!current(rt, run) || !observing()) return;
    // A held button gone means the person pressed it (ADR 0019); the site's answer to the
    // press is then waited for.
    if (!held) run.metadata = followPage(personAnswered(run.metadata));
    if (held) {
      if (Date.now() >= holdUntil) {
        await change(rt, run, {
          type: "OBSERVED",
          result: "challenge",
          document: run.live.document,
        });
        return;
      }
      // Once the button is gone, the result gets the usual budget.
      until = Math.max(until, Date.now() + 3000);
      await sleep(500);
      continue;
    }
    // A failed observation leaves the attempt for its next document to reconcile.
    if (settle) return;
    await sleep(interval);
  }
}

/**
 * Checks a new page of the tab while the login is watched after a `challenge` (ADR 0027),
 * reading only: it never fills or clicks. The login completes on a signed-in marker,
 * read for a short while as after a click, or on a confirmed sign-in state (ADR 0029: E1
 * to E3). A page with no sign of a sign-in going on and no evidence is judged, from the
 * watch's own pages: `signed-in` completes and `rejected` ends the login as a refused
 * password, while any other answer, a refusal or a spent budget leaves it watched, with a
 * warning in the log. The document the watch began in is not checked again.
 */
export async function watchPage(rt: Runtime, run: Execution, routed = false): Promise<void> {
  const { watch } = run.metadata;
  if (!watch || (run.live.document.documentId === watch.documentId && !routed)) return;
  const proof = markerProof(run.recipe);
  const watching = () => current(rt, run) && run.metadata.state === "watching";
  if (proof.targets.length > 0) {
    const until = Date.now() + WATCH_SETTLE_MS;
    for (;;) {
      const observed = await observe(rt, run, proof.targets, proof.shown, {
        links: proof.links,
        hidden: proof.hidden,
      });
      if (!observed || !watching()) return;
      if (proof.proves(observed.targets)) {
        await change(rt, run, {
          type: "OBSERVED",
          result: "authenticated",
          document: run.live.document,
        });
        return;
      }
      if (Date.now() >= until) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  } else await new Promise<void>((resolve) => setTimeout(resolve, WATCH_SETTLE_MS));
  if (!watching()) return;
  const state = await signInState(rt, run);
  if (!watching()) return;
  if (state?.decision === "signed-in" && state.confirmed) {
    await change(rt, run, {
      type: "OBSERVED",
      result: "authenticated",
      document: run.live.document,
    });
    return;
  }
  // The sign-in form shown again with a failure, in the first new document after the
  // submission, rejects the password even after the watch began (owner, 22:03 UTC).
  if (state?.decision === "rejected" && state.confirmed && state.reshown) {
    await change(rt, run, {
      type: "OBSERVED",
      result: "credential-rejected",
      document: run.live.document,
    });
    return;
  }
  // So does that form shown again with nothing else on it ask again, as when the
  // submitted page settled first.
  if (state?.formAgain && state.confirmed && state.decision === "unknown") {
    await askAgain(rt, run);
    return;
  }
  // Only a page with no sign of a sign-in going on is judged; an undecided answer never
  // completes a watched login, an optional page after the sign-in does (ADR 0065).
  if (state?.decision === "judge") await learn(rt, run, state);
}
