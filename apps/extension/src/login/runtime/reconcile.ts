import * as v from "valibot";
import {
  attemptPlan,
  passkeyAnswersRequest,
  transitionLoginAttempt,
  type LoginAttemptEvent,
  type LoginMarkerTarget,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  awaitResultSchema,
  extractResultSchema,
  observationSchema,
  type LoginReadiness,
  type TargetRequirement,
} from "../wire";
import { type Execution } from "./types";
import { allowed } from "./plan-2";
import { send, current, stepWaitMs, change, saveSession } from "./attempt";
import { probeMode, REQUEST_HOLD_MS } from "./constants";
import {
  pastStop,
  effectful,
  stopsPastPlan,
  answeredAtStop,
  advancingToStop,
  terminal,
} from "./attempt-state";
import { inPlaceNext, stepTargets, markerProof, recordKey, documentKey } from "./steps";
import { sampleSignedIn, notJudged, learn } from "./judge";
import { fallBack, parkedFor, bridgeAnswer, reviewRequests } from "./passkey";
import { switchLayout, continueOn } from "./continuation";
import { listOf, listReadiness } from "./markers";
import { enterHandler } from "./handlers";
import { advanceMiss, signInState } from "./sign-in";
import { repairLaterStep } from "./repair-run";
import { addAskFill } from "./relogin";
import { quietly, forget } from "./session-store";
import type { Runtime } from "./state";

export async function observe(
  rt: Runtime,
  run: Execution,
  targets: LoginMarkerTarget[],
  require?: TargetRequirement[],
  {
    links,
    hidden,
    signIn = false,
    explain = false,
  }: { links?: boolean[]; hidden?: boolean[]; signIn?: boolean; explain?: boolean } = {},
) {
  // Exclusion/default/policy checks precede even metadata observation.
  if (!(await allowed(rt, run))) return undefined;
  const response = await send(rt, run.live, {
    type: "login.observe",
    path: run.live.path,
    targets,
    ...(require ? { require } : {}),
    ...(links ? { links } : {}),
    ...(hidden ? { hidden } : {}),
    ...(signIn ? { signIn: true } : {}),
    ...(explain ? { explain: true } : {}),
  });
  if (!current(rt, run)) return undefined;
  const parsed = v.safeParse(observationSchema, response);
  if (probeMode && parsed.success) run.live.observations = (run.live.observations ?? 0) + 1;
  if (parsed.success)
    run.readPath = { documentId: run.live.document.documentId, path: parsed.output.path };
  return parsed.success ? parsed.output : undefined;
}

/**
 * Asks the document to wait for a step's elements. A document that went away or was
 * cancelled leaves the attempt as it is; its replacement document resumes it.
 */
export async function waitFor(
  rt: Runtime,
  run: Execution,
  readiness: LoginReadiness,
  timeoutMs = stepWaitMs(rt),
): Promise<"ready" | "timeout" | "gone"> {
  try {
    const response = await send(rt, run.live, {
      type: "login.await",
      readiness,
      timeoutMs,
    });
    const parsed = v.safeParse(awaitResultSchema, response);
    if (!parsed.success) return "gone";
    return parsed.output.ok ? "ready" : parsed.output.reason === "timeout" ? "timeout" : "gone";
  } catch {
    return "gone";
  }
}

/**
 * How a page that does not prove the sign-in ends the login: as itself on the `password`
 * route, and always as `challenge` on the `passkey` route, which never falls back to
 * typing the password (ADR 0027). A login that stops before its item's missing password
 * ends an unproven page as `challenge` too, watched (ADR 0036).
 */
export const unproven = (
  _rt: Runtime,
  run: Execution,
  result: "credential-rejected" | "challenge" | "unknown",
) =>
  run.metadata.route === "passkey" || (run.metadata.stopAt !== undefined && result === "unknown")
    ? "challenge"
    : result;

/**
 * Checks the page after an effect step: the signed-in markers, the rejection, the plan's next
 * step, then a handler on the page (ADR 0027), and once the result would settle as
 * unknown, the sign-in state (ADR 0029) before the judge. Returns `held` while a held click's button
 * still shows in the document that clicked it, or while the sign-in form still shows after
 * a passkey answer, so the page is neither judged nor settled yet. A login with a stop
 * goes on at most to it (ADR 0036). The page after the final `advance` before a stop just
 * past the plan's last step takes the login to that stop at once when it asks for a
 * passkey (`asksPasskey`); otherwise it is continued as any login's page, or judged once
 * the step's wait ran out, and the login goes on to its stop when neither moved it on.
 */
export async function reconcile(
  rt: Runtime,
  run: Execution,
  settleUnknown = false,
): Promise<"held" | undefined> {
  const nextIndex =
    run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance"
      ? run.metadata.stepIndex + 1
      : run.metadata.stepIndex;
  const plan = attemptPlan(run.recipe, run.metadata) ?? [];
  // A login with a stop never goes on past it (ADR 0036).
  const next = pastStop(run.metadata, nextIndex) ? undefined : plan[nextIndex]?.step;
  // An advance on the next step's own path is confirmed only by that step's elements
  // being ready, as it waits for them and as the page's description sees them, and only
  // if they were not ready that way before it ran.
  const inPlace =
    run.metadata.operationEffect === "advance"
      ? inPlaceNext(run.recipe, run.metadata, run.metadata.stepIndex)
      : undefined;
  const nextTargets = inPlace ? inPlace.targets : next ? stepTargets(next) : [];
  const { rejection } = run.recipe;
  const proof = markerProof(run.recipe);
  const checks = [...proof.targets, ...(rejection ? [rejection] : [])];
  const targets = [...checks, ...nextTargets];
  const observed = await observe(
    rt,
    run,
    targets,
    [
      ...proof.shown,
      ...(rejection ? ["present" as const] : []),
      ...nextTargets.map(() => inPlace?.require ?? "present"),
    ],
    proof.links.length > 0 ? { links: proof.links, hidden: proof.hidden } : {},
  );
  if (!observed) return undefined;
  // Without a marker only the sign-in state below proves a sign-in.
  if (proof.proves(observed.targets)) {
    const before = run.metadata;
    await change(rt, run, {
      type: "OBSERVED",
      result: "authenticated",
      document: run.live.document,
    });
    // A repeat login's page may be sampled, in the background (ADR 0029).
    sampleSignedIn(rt, run, before, observed.path);
    return undefined;
  }
  const rejectionIndex = proof.targets.length;
  const rejected = rejection !== undefined && observed.targets[rejectionIndex] === "unique";
  if (!rejected) delete run.staleRejection;
  if (rejected && !run.staleRejection) {
    // A site that refused the passkey answer gets the password instead (ADR 0034).
    if (
      effectful(run.metadata) &&
      run.metadata.route === "passkey" &&
      passkeyAnswersRequest(run.recipe)
    ) {
      // The banner still shows when the password is submitted in this document.
      run.staleRejection = true;
      await fallBack(rt, run, "sign-in-rejected");
      return undefined;
    }
    await change(rt, run, {
      type: "OBSERVED",
      result: unproven(rt, run, "credential-rejected"),
      document: run.live.document,
    });
    return undefined;
  }
  // A login back at a stop just past its plan's last step, as after a restart or in a new
  // document, stands there again: no step's elements show the stop (ADR 0036).
  if (
    stopsPastPlan(run.metadata) &&
    run.metadata.stepIndex === run.metadata.stopAt &&
    run.metadata.operationId === undefined
  ) {
    await change(rt, run, { type: "OBSERVED", result: "continue", document: run.live.document });
    return undefined;
  }
  const offset = rejectionIndex + (rejection ? 1 : 0);
  if (
    next &&
    observed.path === next.path &&
    nextTargets.length &&
    observed.targets.slice(offset).every((state) => state === "unique") &&
    // A pending click advances only after evidence of its configured next page: another
    // path, or on the same path, next elements the advance made ready. A click that
    // submits never continues on its own path.
    (!(run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance") ||
      plan[run.metadata.stepIndex]?.step.path !== next.path ||
      (inPlace !== undefined &&
        run.inPlace !== undefined &&
        run.inPlace.operationId === run.metadata.operationId &&
        run.inPlace.before.every((state) => state === "missing" || state === "unusable")))
  ) {
    const continuation: LoginAttemptEvent = {
      type: "OBSERVED",
      result: "continue",
      document: run.live.document,
    };
    // Remaining fields alone do not prove that an uncertain input effect finished.
    const candidate = transitionLoginAttempt(run.metadata, continuation);
    if (candidate.state === "ready" || candidate.state === "retryable") {
      await change(rt, run, continuation);
      return undefined;
    }
  }
  // Where the recipe's layouts part, the page may show another layout's next step instead
  // of the login's own: the login goes on with that layout (ADR 0060).
  const ownShows =
    next !== undefined &&
    observed.path === next.path &&
    nextTargets.length > 0 &&
    observed.targets.slice(offset).every((state) => state === "unique");
  if (!ownShows && (await switchLayout(rt, run))) return undefined;
  if (!current(rt, run)) return undefined;
  let continued: Awaited<ReturnType<typeof continueOn>> = "none";
  // After a passkey answer at the stop, the sign-in form still showing means the site has
  // not signed in: it may still be checking the assertion for a while, then the login
  // ends at its stop (ADR 0036). A stop just past the plan's last step has no form of its
  // own; its page is held below instead.
  const stop = answeredAtStop(run.metadata) ? plan[run.metadata.stopAt!] : undefined;
  if (stop) {
    const stopFields = stepTargets(stop.step);
    const form = await observe(
      rt,
      run,
      stopFields,
      stopFields.map(() => "shown" as const),
    );
    if (!form) return undefined;
    if (form.path === stop.step.path && form.targets.some((state) => state === "unique")) {
      if (run.answeredAt !== undefined && Date.now() - run.answeredAt < REQUEST_HOLD_MS)
        return "held";
      await change(
        rt,
        run,
        { type: "OBSERVED", result: "challenge", document: run.live.document },
        undefined,
        undefined,
        undefined,
        "password-empty",
      );
      return undefined;
    }
  }
  if (effectful(run.metadata)) {
    // A held click, a handler's or the passkey route's, is not judged while its button
    // still shows in the document that clicked it, whatever path a same-document URL
    // change has moved it to: a WebAuthn exchange or a chooser the person answers can
    // take a while (ADR 0027). A new document that shows a handler's button again goes
    // to the person through the handler's own check below; one that shows the passkey
    // route's button again on its path, as after a reload back to the start page, goes
    // to the person at once: it is never clicked again or judged.
    const inFlight = plan[run.metadata.stepIndex];
    const routeClick =
      inFlight !== undefined && inFlight.handler === undefined && run.metadata.route === "passkey";
    // The page after a `password` handler's click that asks for the password is continued
    // before the click's hold is read, since the button may stay beside the password form;
    // such a page is not held, judged or handled (ADR 0048).
    const choseByPassword =
      inFlight?.handler !== undefined &&
      run.recipe.handlers?.[inFlight.handler]?.kind === "password";
    if (choseByPassword) {
      continued = await continueOn(rt, run);
      if (continued === "moved") return undefined;
    }
    const asksPassword = continued === "qualified";
    // After answering the page's own request, the start page's sign-in form still
    // showing on its path means the site has not signed in: it may still be exchanging
    // the assertion in this document for a while, then the login falls back to its
    // password variant (ADR 0034).
    if (!asksPassword && inFlight && routeClick && passkeyAnswersRequest(run.recipe)) {
      let shows: boolean;
      const onList = listOf(rt, run);
      if (onList) {
        // A chooser login's start page is its list, read as its click's wait reads it,
        // since the click's target names no element by itself (ADR 0028).
        if (!(await allowed(rt, run))) return undefined;
        const list = await waitFor(rt, run, listReadiness(rt, onList.chooser), 1);
        if (!current(rt, run) || list === "gone") return undefined;
        shows = list === "ready";
      } else {
        const form = await observe(rt, run, stepTargets(inFlight.step), ["shown"]);
        if (!form) return undefined;
        shows = form.path === inFlight.step.path && form.targets[0] === "unique";
      }
      if (shows) {
        if (run.answeredAt !== undefined && Date.now() - run.answeredAt < REQUEST_HOLD_MS)
          return "held";
        await fallBack(rt, run, "sign-in-shown");
        return undefined;
      }
    } else if (
      !asksPassword &&
      inFlight &&
      (run.heldClick === run.metadata.stepIndex || routeClick)
    ) {
      // A button the page only hid counts as gone, as an app that moved on in the same
      // document and kept its old view there hidden.
      const clickTargets = stepTargets(inFlight.step);
      const clicked = await observe(
        rt,
        run,
        clickTargets,
        clickTargets.map(() => "shown" as const),
      );
      if (!clicked) return undefined;
      if (clicked.targets.some((state) => state !== "missing" && state !== "unusable")) {
        if (run.heldClick === run.metadata.stepIndex) return "held";
        if (clicked.path === inFlight.step.path) {
          await change(rt, run, {
            type: "OBSERVED",
            result: "challenge",
            document: run.live.document,
          });
          return undefined;
        }
      }
    }
    if (!asksPassword && (await enterHandler(rt, run, observed.path))) return undefined;
    // The page after the final advance before a stop just past the plan's last step that
    // asks for a passkey takes the login to that stop at once (ADR 0036).
    if (advancingToStop(run.metadata) && asksPasskey(rt, run) && (await toStop(rt, run)))
      return undefined;
    if (!choseByPassword) {
      continued = await continueOn(rt, run);
      if (continued === "moved") return undefined;
    }
  }
  if (!settleUnknown) return undefined;
  // Otherwise that page is continued as any login's, or judged once the step's wait ran
  // out, and the login goes on to its stop when neither moved it on. An advance the record
  // cannot go on from, as one that failed before its intent, ends here unjudged.
  if (advancingToStop(run.metadata) && !canReachStop(rt, run)) {
    await change(rt, run, {
      type: "OBSERVED",
      result: unproven(rt, run, "unknown"),
      document: run.live.document,
    });
    return undefined;
  }
  // After answering the page's own request, a page still on the start page's path may be
  // exchanging the assertion before the site moves on, with its form already gone: it is
  // not judged until the request's hold ends, nor while it shows nothing to describe, as
  // a loader does, until the held click's wait ends (ADR 0034).
  // So is the page after an answer at a login's stop, on the path of the step it stopped at,
  // or for a stop just past the plan's last step, on the path it answered on (ADR 0036).
  const answered = plan[run.metadata.stepIndex];
  const answeredPath =
    answered === undefined
      ? answeredAtStop(run.metadata)
        ? run.answeredPath
        : undefined
      : answered.handler === undefined
        ? answered.step.path
        : undefined;
  if (
    ((run.metadata.route === "passkey" && passkeyAnswersRequest(run.recipe)) ||
      answeredAtStop(run.metadata)) &&
    answeredPath !== undefined &&
    observed.path === answeredPath &&
    run.answeredAt !== undefined &&
    (Date.now() - run.answeredAt < REQUEST_HOLD_MS || (await showsNothing(rt, run)))
  )
    return current(rt, run) ? "held" : undefined;
  // An advance on the next step's own path that was never confirmed says why in the log,
  // in a top document, the only one whose sign-in state is read.
  const advance =
    inPlace && next && run.live.topUrl === undefined
      ? await advanceMiss(rt, run, inPlace, next.path)
      : undefined;
  if (!current(rt, run) || terminal(run.metadata)) return undefined;
  const state = effectful(run.metadata) ? await signInState(rt, run, advance) : undefined;
  if (!current(rt, run) || terminal(run.metadata)) return undefined;
  // Evidence of a sign-in completes the login without a model call, on the passkey route
  // too (owner, 2026-10-24), and a failure shown next to the sign-in fields rejects it
  // (ADR 0029); the passkey route rejects no credential, and goes on as before.
  if (
    state?.confirmed &&
    (state.decision === "signed-in" ||
      (state.decision === "rejected" && run.metadata.route !== "passkey"))
  ) {
    await change(rt, run, {
      type: "OBSERVED",
      result: state.decision === "signed-in" ? "authenticated" : "credential-rejected",
      document: run.live.document,
    });
    return undefined;
  }
  // A sign-in page after the final advance is never judged: the judge cannot learn
  // anything from it (ADR 0018).
  if (continued === "qualified") notJudged(rt, run, "continuation");
  else if (await learn(rt, run, state)) return undefined;
  // A login before a stop just past its plan's last step goes on to it (ADR 0036).
  if (await toStop(rt, run)) return undefined;
  // A page that was not judged settles as unknown, whatever its signs (ADR 0029). One
  // that still showed the sign-in form (S1) without a failure that acted says so in the
  // log, as `sign-in-shown`.
  const result = unproven(rt, run, "unknown");
  // A password page on the next step's path after an advance whose next step never showed
  // there is sent for repair (ADR 0041 section 4).
  const stale =
    result === "unknown" &&
    state?.decision === "continuing" &&
    state.asksPassword &&
    run.metadata.operationEffect === "advance" &&
    next !== undefined &&
    observed.path === next.path
      ? nextIndex
      : undefined;
  await change(
    rt,
    run,
    { type: "OBSERVED", result, document: run.live.document },
    undefined,
    result === "unknown" && (state?.decision === "unknown" || state?.decision === "rejected")
      ? "sign-in-shown"
      : undefined,
  );
  if (stale !== undefined) void repairLaterStep(rt, run, stale).catch(() => undefined);
  // The sign-in form shown again in the first new page after the password submission,
  // with nothing else on it, means the login did not go through: the tab asks at once.
  if (state?.formAgain && state.confirmed && state.decision === "unknown") await askAgain(rt, run);
  return undefined;
}

/**
 * Whether the page after the final `advance` before a stop just past the plan's last step
 * asked for a passkey after that step (ADR 0036): its document's request waits, having
 * come after the step, or the passkey bridge answered one since it.
 */
export function asksPasskey(rt: Runtime, run: Execution): boolean {
  const effect = rt.effects.get(run.live.document.tabId);
  const parked = parkedFor(rt, run.live.document);
  return (
    bridgeAnswer(rt, run) !== undefined ||
    (parked !== undefined && effect?.attemptId === run.metadata.id && parked.since >= effect.at)
  );
}

/** Whether the record of such a login can go on from its final advance to its stop. */
export function canReachStop(_rt: Runtime, run: Execution): boolean {
  const candidate = transitionLoginAttempt(run.metadata, {
    type: "OBSERVED",
    result: "continue",
    document: run.live.document,
  });
  return candidate.state === "ready" || candidate.state === "retryable";
}

/**
 * Takes such a login from its final advance to its stop, where it waits for the page's
 * passkey request (ADR 0036). Returns whether it went there.
 */
export async function toStop(rt: Runtime, run: Execution): Promise<boolean> {
  if (!advancingToStop(run.metadata) || !canReachStop(rt, run)) return false;
  await change(rt, run, { type: "OBSERVED", result: "continue", document: run.live.document });
  return true;
}

/**
 * Releases a login whose submission the site answered with its sign-in form again, as
 * after a rejection: the tab, and the origin's other tabs, ask for an account instead of
 * watching, and the page that showed the form is never filled again (ADR 0021 D, amended
 * 2026-10-13). Nothing is submitted again by itself. Its page is asked to announce again,
 * so it asks once a recipe's first step is ready there, or may be sent for a recipe like
 * any sign-in page.
 */
export async function askAgain(rt: Runtime, run: Execution): Promise<void> {
  if (!current(rt, run) || run.live.document.frameId !== 0) return;
  const { metadata } = run;
  const { document } = run.live;
  const { tabId } = document;
  const key = recordKey(tabId, document.origin);
  if (rt.persisted.get(key)?.id !== metadata.id) return;
  const page = documentKey(document);
  const asked = rt.rejectedAsks.has(key);
  const unfilled = !rt.askFills.has(page);
  rt.rejectedAsks.add(key);
  if (unfilled) addAskFill(rt, page);
  try {
    await saveSession(rt);
  } catch {
    // The login stays watched, as before.
    if (!asked) rt.rejectedAsks.delete(key);
    if (unfilled) rt.askFills.delete(page);
    return;
  }
  if (!current(rt, run) || rt.persisted.get(key)?.id !== metadata.id) {
    // The page went meanwhile: the login stays as it was, and so does the tab.
    if (!asked) rt.rejectedAsks.delete(key);
    if (unfilled) rt.askFills.delete(page);
    await quietly(rt, () => saveSession(rt));
    return;
  }
  rt.attempts.delete(tabId);
  if (rt.picked.get(tabId)?.attemptId === metadata.id) {
    rt.picked.delete(tabId);
    void quietly(rt, () => saveSession(rt));
  }
  await forget(rt, key).catch(() => undefined);
  reviewRequests(rt);
  await browser.tabs
    .sendMessage(
      tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: 0, documentId: document.documentId },
    )
    .catch(() => undefined);
}

/**
 * Whether Pateat's answer to the passkey request of this attempt's latest step that asked
 * for one went back after that step, on the page's origin or the recipe's, also when a
 * handler's steps ran after it (ADR 0029 amendment of 2026-10-24).
 */
export function passkeyStepAnswered(rt: Runtime, run: Execution): boolean {
  const { tabId, origin: pageOrigin } = run.live.document;
  const effect = rt.effects.get(tabId);
  const requestAt = effect?.attemptId === run.metadata.id ? effect.requestAt : undefined;
  if (requestAt === undefined) return false;
  return [pageOrigin, run.recipe.origin].some(
    (from) => (rt.passkeyAnswers.get(`${tabId} ${from}`)?.at ?? -1) >= requestAt,
  );
}

/** Whether the page has nothing a signed-in page's description could carry. */
export async function showsNothing(rt: Runtime, run: Execution): Promise<boolean> {
  const extracted = v.safeParse(
    extractResultSchema,
    await send(rt, run.live, { type: "login.extract", page: "signed-in" }).catch(() => undefined),
  );
  return extracted.success && !extracted.output.ok && extracted.output.reason === "no-candidates";
}
