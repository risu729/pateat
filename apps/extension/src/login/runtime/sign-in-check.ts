import * as v from "valibot";
import {
  attemptPlan,
  attemptUsesCode,
  handlerFact,
  handlerSteps,
  handlerTargets,
  pagesLeft,
  loginObservationSchema,
  loginStepEffect,
  passkeyAnswersRequest,
  passwordVariants,
  routeSignInPaths,
  routeSignInTargets,
  sameLoginDocument,
  sameLoginTarget,
  transitionLoginAttempt,
  type LoginAttemptEvent,
  type LoginObservation,
  chooserClickBranch,
  type ChooserBranch,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { extractResultSchema, stateResultSchema } from "../wire";
import { signedInPath } from "../../observation/extract";
import {
  decideSignInState,
  reachedReturnTarget,
  type ReshownMiss,
  type SignInDecision,
  type SignInSigns,
} from "../sign-in-state";
import { judgedCompletionResult, settleCompletion, undecidedCandidate } from "../completion-policy";
import type { AlertMiss } from "../../page/sign-in-state";
import { loginUsernameFieldId } from "../vault";
import {
  advancingToStop,
  answeredAtStop,
  autoSubmitted,
  effectful,
  type Execution,
  formAgain,
  handlerOrder,
  inPlaceNext,
  markerProof,
  pastStop,
  recordKey,
  REQUEST_HOLD_MS,
  SIGN_IN_RECHECK_MS,
  SIGN_IN_RECHECKS,
  type SignInReading,
  stepTargets,
  stopsPastPlan,
  terminal,
} from "./model";
import { codeFieldOf } from "./recipes";
import type { LoginReport } from "./reports";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * The page after a login's effect step: reconciling its result, reading and judging its
 * sign-in state (ADR 0029), learning markers, and entering handlers.
 */
export function createSignInCheck(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    effects,
    persisted,
    logouts,
    rejectedAsks,
    logoutFills,
    quietly,
    attempts,
    picked,
    report,
    send,
    fields,
    passkeyRequests,
    signInUrls,
    settings,
    generation,
    spinning,
  } = shared;
  /**
   * How a page that does not prove the sign-in ends the login: as itself on the `password`
   * route, and always as `challenge` on the `passkey` route, which never falls back to
   * typing the password (ADR 0027). A login that stops before its item's missing password
   * ends an unproven page as `challenge` too, watched (ADR 0036).
   */
  const unproven = (run: Execution, result: "credential-rejected" | "challenge" | "unknown") =>
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
  async function reconcile(run: Execution, settleUnknown = false): Promise<"held" | undefined> {
    const nextIndex =
      run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance"
        ? run.metadata.stepIndex + 1
        : run.metadata.stepIndex;
    const plan = attemptPlan(run.recipe, run.metadata) ?? [];
    // A login with a stop never goes on past it (ADR 0036).
    const next = pastStop(run.metadata, nextIndex) ? undefined : plan[nextIndex]?.step;
    // An advance on the next step's own path is confirmed only by that step's elements
    // being ready, as it waits for them, and only if they were not ready before it ran.
    const inPlace =
      run.metadata.operationEffect === "advance"
        ? inPlaceNext(run.recipe, run.metadata, run.metadata.stepIndex)
        : undefined;
    const nextTargets = inPlace ? inPlace.targets : next ? stepTargets(next) : [];
    const { rejection } = run.recipe;
    const proof = markerProof(run.recipe);
    const checks = [...proof.targets, ...(rejection ? [rejection] : [])];
    const targets = [...checks, ...nextTargets];
    const observed = await runtime.observe(
      run,
      targets,
      [
        ...proof.shown,
        ...(rejection ? ["present" as const] : []),
        ...nextTargets.map(() => inPlace?.require ?? ("present" as const)),
      ],
      proof.links.length > 0 ? proof.links : undefined,
    );
    if (!observed) return undefined;
    // Without a marker only the sign-in state below proves a sign-in.
    if (proof.proves(observed.targets)) {
      await runtime.change(run, {
        type: "OBSERVED",
        result: "authenticated",
        document: run.live.document,
      });
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
        await runtime.fallBack(run, "sign-in-rejected");
        return undefined;
      }
      await runtime.change(run, {
        type: "OBSERVED",
        result: unproven(run, "credential-rejected"),
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
      await runtime.change(run, {
        type: "OBSERVED",
        result: "continue",
        document: run.live.document,
      });
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
        await runtime.change(run, continuation);
        return undefined;
      }
    }
    let continued: Awaited<ReturnType<typeof runtime.continueOn>> = "none";
    // After a passkey answer at the stop, the sign-in form still showing means the site has
    // not signed in: it may still be checking the assertion for a while, then the login
    // ends at its stop (ADR 0036). A stop just past the plan's last step has no form of its
    // own; its page is held below instead.
    const stop = answeredAtStop(run.metadata) ? plan[run.metadata.stopAt!] : undefined;
    if (stop) {
      const stopFields = stepTargets(stop.step);
      const form = await runtime.observe(
        run,
        stopFields,
        stopFields.map(() => "shown" as const),
      );
      if (!form) return undefined;
      if (form.path === stop.step.path && form.targets.some((state) => state === "unique")) {
        if (run.answeredAt !== undefined && Date.now() - run.answeredAt < REQUEST_HOLD_MS)
          return "held";
        await runtime.change(
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
        inFlight !== undefined &&
        inFlight.handler === undefined &&
        run.metadata.route === "passkey";
      // After answering the page's own request, the start page's sign-in form still
      // showing on its path means the site has not signed in: it may still be exchanging
      // the assertion in this document for a while, then the login falls back to its
      // password variant (ADR 0034).
      if (inFlight && routeClick && passkeyAnswersRequest(run.recipe)) {
        let shows: boolean;
        if (run.chooser) {
          // A chooser login's start page is its list, read as its click's wait reads it,
          // since the click's target names no element by itself (ADR 0028).
          if (!(await runtime.allowed(run))) return undefined;
          const list = await runtime.waitFor(run, runtime.listReadiness(run.chooser), 1);
          if (!runtime.current(run) || list === "gone") return undefined;
          shows = list === "ready";
        } else {
          const form = await runtime.observe(run, stepTargets(inFlight.step), ["shown"]);
          if (!form) return undefined;
          shows = form.path === inFlight.step.path && form.targets[0] === "unique";
        }
        if (shows) {
          if (run.answeredAt !== undefined && Date.now() - run.answeredAt < REQUEST_HOLD_MS)
            return "held";
          await runtime.fallBack(run, "sign-in-shown");
          return undefined;
        }
      } else if (inFlight && (run.heldClick === run.metadata.stepIndex || routeClick)) {
        const clicked = await runtime.observe(run, stepTargets(inFlight.step));
        if (!clicked) return undefined;
        if (clicked.targets.some((state) => state !== "missing")) {
          if (run.heldClick === run.metadata.stepIndex) return "held";
          if (clicked.path === inFlight.step.path) {
            await runtime.change(run, {
              type: "OBSERVED",
              result: "challenge",
              document: run.live.document,
            });
            return undefined;
          }
        }
      }
      if (await enterHandler(run, observed.path)) return undefined;
      // The page after the final advance before a stop just past the plan's last step that
      // asks for a passkey takes the login to that stop at once (ADR 0036).
      if (advancingToStop(run.metadata) && asksPasskey(run) && (await toStop(run)))
        return undefined;
      continued = await runtime.continueOn(run);
      if (continued === "moved") return undefined;
    }
    if (!settleUnknown) return undefined;
    // Otherwise that page is continued as any login's, or judged once the step's wait ran
    // out, and the login goes on to its stop when neither moved it on. An advance the record
    // cannot go on from, as one that failed before its intent, ends here unjudged.
    if (advancingToStop(run.metadata) && !canReachStop(run)) {
      await runtime.change(run, {
        type: "OBSERVED",
        result: unproven(run, "unknown"),
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
      (Date.now() - run.answeredAt < REQUEST_HOLD_MS || (await showsNothing(run)))
    )
      return runtime.current(run) ? "held" : undefined;
    const state = effectful(run.metadata) ? await signInState(run) : undefined;
    if (!runtime.current(run) || terminal(run.metadata)) return undefined;
    // Evidence of a sign-in completes the login without a model call, and a failure shown
    // next to the sign-in fields rejects it (ADR 0029).
    if (state?.confirmed && (state.decision === "signed-in" || state.decision === "rejected")) {
      await runtime.change(run, {
        type: "OBSERVED",
        result: state.decision === "signed-in" ? "authenticated" : "credential-rejected",
        document: run.live.document,
      });
      return undefined;
    }
    // A sign-in page after the final advance is never judged: the judge cannot learn
    // anything from it (ADR 0018).
    if (continued === "qualified") notJudged(run, "continuation");
    else if (await learn(run, state)) return undefined;
    // A login before a stop just past its plan's last step goes on to it (ADR 0036).
    if (await toStop(run)) return undefined;
    // A page that was not judged settles as unknown, whatever its signs (ADR 0029). One
    // that still showed the sign-in form (S1) without a failure that acted says so in the
    // log, as `sign-in-shown`.
    const result = unproven(run, "unknown");
    await runtime.change(
      run,
      { type: "OBSERVED", result, document: run.live.document },
      undefined,
      result === "unknown" && (state?.decision === "unknown" || state?.decision === "rejected")
        ? "sign-in-shown"
        : undefined,
    );
    // The sign-in form shown again in the first new page after the password submission,
    // with nothing else on it, means the login did not go through: the tab asks at once.
    if (state?.formAgain && state.confirmed && state.decision === "unknown") await askAgain(run);
    return undefined;
  }
  /**
   * Whether the page after the final `advance` before a stop just past the plan's last step
   * asked for a passkey after that step (ADR 0036): its document's request waits, having
   * come after the step, or the passkey bridge answered one since it.
   */
  function asksPasskey(run: Execution): boolean {
    const effect = effects.get(run.live.document.tabId);
    const parked = runtime.parkedFor(run.live.document);
    return (
      runtime.bridgeAnswer(run) !== undefined ||
      (parked !== undefined && effect?.attemptId === run.metadata.id && parked.since >= effect.at)
    );
  }
  /** Whether the record of such a login can go on from its final advance to its stop. */
  function canReachStop(run: Execution): boolean {
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
  async function toStop(run: Execution): Promise<boolean> {
    if (!advancingToStop(run.metadata) || !canReachStop(run)) return false;
    await runtime.change(run, {
      type: "OBSERVED",
      result: "continue",
      document: run.live.document,
    });
    return true;
  }
  /**
   * Releases a login whose submission the site answered with its sign-in form again, as
   * after a logout: the tab asks for an account instead of watching, and the page that
   * showed the form is never filled again (ADR 0021 D, amended 2026-10-13). Nothing is
   * submitted again by itself. Its page is asked to announce again, so it asks once a
   * recipe's first step is ready there, or may be sent for a recipe like any sign-in page.
   */
  async function askAgain(run: Execution): Promise<void> {
    if (!runtime.current(run) || run.live.document.frameId !== 0) return;
    const { metadata } = run;
    const { document } = run.live;
    const { tabId } = document;
    const key = recordKey(tabId, document.origin);
    if (persisted.get(key)?.id !== metadata.id) return;
    const page = `${tabId} ${document.documentId}`;
    const asked = { logout: logouts.has(key), rejected: rejectedAsks.has(key) };
    const unfilled = !logoutFills.has(page);
    logouts.add(key);
    rejectedAsks.add(key);
    if (unfilled) {
      logoutFills.add(page);
      for (const old of logoutFills) {
        if (logoutFills.size <= 256) break;
        logoutFills.delete(old);
      }
    }
    try {
      await runtime.saveSession();
    } catch {
      // The login stays watched, as before.
      if (!asked.logout) logouts.delete(key);
      if (!asked.rejected) rejectedAsks.delete(key);
      if (unfilled) logoutFills.delete(page);
      return;
    }
    if (!runtime.current(run) || persisted.get(key)?.id !== metadata.id) {
      // The page went meanwhile: the login stays as it was, and so does the tab.
      if (!asked.logout) logouts.delete(key);
      if (!asked.rejected) rejectedAsks.delete(key);
      if (unfilled) logoutFills.delete(page);
      await quietly(runtime.saveSession);
      return;
    }
    attempts.delete(tabId);
    if (picked.get(tabId)?.attemptId === metadata.id) {
      picked.delete(tabId);
      void quietly(runtime.saveSession);
    }
    report(document, {
      type: "logout",
      tabId,
      origin: document.origin,
      recipeId: metadata.recipeId,
      recipeRevision: metadata.recipeRevision,
      rejected: true,
    });
    await runtime.forget(key).catch(() => undefined);
    runtime.reviewRequests();
    await browser.tabs
      .sendMessage(
        tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: 0, documentId: document.documentId },
      )
      .catch(() => undefined);
  }
  /** Whether the page has nothing a signed-in page's description could carry. */
  async function showsNothing(run: Execution): Promise<boolean> {
    const extracted = v.safeParse(
      extractResultSchema,
      await send(run.live, { type: "login.extract", page: "signed-in" }).catch(() => undefined),
    );
    return extracted.success && !extracted.output.ok && extracted.output.reason === "no-candidates";
  }
  /**
   * Reads and logs the sign-in state of ADR 0029 for a page no check explained: its signs
   * and what the ADR does with it. Returns the decision, `confirmed` only when a later
   * reading, a second apart, agrees in the fully loaded document. On the passkey route,
   * where anything the route's checks do not prove ends `challenge`, the reading is not
   * read again and never confirmed, so it is logged only. A login in a frame is not read,
   * as the ADR reads the top document.
   */
  async function signInState(run: Execution): Promise<SignInReading | undefined> {
    let reading = await readSignInState(run);
    let confirmed = false;
    // A decision counts once a later reading agrees in a fully loaded document, so a page
    // that is still redirecting or about to ask for a second factor is not settled; a
    // document still loading is read again, a second apart, up to `SIGN_IN_RECHECKS` times.
    // `unknown` changes nothing and is not read again, unless it is the sign-in form shown
    // again with nothing else, on which the tab asks again (ADR 0021 D). Each reading
    // depends on the time passed since the last, so they run one after another.
    /* eslint-disable no-await-in-loop */
    if (run.metadata.route !== "passkey")
      for (
        let recheck = 0;
        reading !== undefined &&
        (reading.decision !== "unknown" || formAgain(reading.signs)) &&
        recheck < SIGN_IN_RECHECKS;
        recheck++
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
        if (!runtime.current(run) || terminal(run.metadata)) return undefined;
        const next = await readSignInState(run);
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
    report(run.live.document, {
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
    });
    return {
      decision: reading.decision,
      confirmed,
      ...(reading.signs.reshown ? { reshown: true as const } : {}),
      ...(formAgain(reading.signs) ? { formAgain: true as const } : {}),
    };
  }
  /** Whether a sign-in target is the passkey route's button rather than a field (ADR 0027). */
  function passkeyButton(run: Execution, target: LoginTarget): boolean {
    const button = run.metadata.route === "passkey" ? run.recipe.passkey?.target : undefined;
    return button !== undefined && sameLoginTarget(target, button);
  }
  /**
   * The page's signs of ADR 0029 and the decision they give, and whether the document has
   * finished loading. The username goes to the page's content script for its comparison
   * only.
   */
  async function readSignInState(run: Execution): Promise<
    | {
        signs: SignInSigns;
        decision: SignInDecision;
        loaded: boolean;
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
    const observed = await runtime.observe(
      run,
      fills,
      fills.map((target) => (passkeyButton(run, target) ? "shown" : "shown-input")),
    );
    if (!observed) return undefined;
    const marked =
      proof.targets.length > 0
        ? await runtime.observe(run, proof.targets, proof.shown, proof.links)
        : undefined;
    if (proof.targets.length > 0 && !marked) return undefined;
    const authorized = await runtime.allowed(run);
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
        username = await fields({
          account: metadata.account,
          connection: authorized.connection,
          fieldId: usernameField,
        });
      } catch {
        username = undefined;
      }
      if (!runtime.current(run)) return undefined;
    }
    const s1 = observed.targets.slice(0, fills.length).some((state) => state === "unique");
    const { tabId, origin: pageOrigin } = run.live.document;
    const effect = effects.get(tabId);
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
      response = await send(run.live, {
        type: "login.state",
        ...(username ? { account: { username } } : {}),
        ...(reshown ? { fields: fills } : {}),
      });
    } catch {
      return undefined;
    }
    if (!runtime.current(run)) return undefined;
    const parsed = v.safeParse(stateResultSchema, response);
    if (!parsed.success || !parsed.output.ok) return undefined;
    const page = parsed.output.signs;
    const requested = passkeyRequests.get(`${tabId} ${pageOrigin}`);
    const signInUrl = signInUrls.get(tabId);
    const signs: SignInSigns = {
      s1,
      s2: page.password,
      s3: page.code,
      s4: page.captcha,
      s5:
        effect?.attemptId === metadata.id &&
        !effect.passkey &&
        requested !== undefined &&
        requested >= effect.at,
      // A failure counts only next to the sign-in fields.
      f1: s1 && page.invalid,
      f2: s1 && page.alert,
      e1: marked !== undefined && proof.proves(marked.targets),
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
    return { signs, decision: decideSignInState(signs), loaded: parsed.output.loaded, misses };
  }
  /**
   * Enters a handler of the recipe on this path all of whose elements show (ADR 0027).
   * Several shown: the first not yet entered whose fact the item has, a `passkey` handler
   * before a `totp` handler, as the routes put the passkey first and it types nothing. A
   * `totp` handler is never entered by a login that already types a code, and needs the
   * item's built-in TOTP field. Returns whether the attempt moved on: to the handler's
   * steps, or to `challenge` when no shown handler qualifies or the attempt's budget has
   * no room for it. At a login's stop before its item's missing password (`stop`, ADR
   * 0036), only a `passkey` handler is entered, before the stop step, and the login ends
   * there with `stop.end` instead.
   */
  async function enterHandler(
    run: Execution,
    path: string,
    stop?: { end: () => Promise<void> },
  ): Promise<boolean> {
    // A fresh handler's elements must be usable: its code field a shown writable input and
    // its button shown, enabled or not, as a Verify button disabled until the code is typed
    // is; so a hidden code input rendered with the sign-in form never stands for a code
    // page. The click step itself waits for the button to be enabled. A `totp` handler whose
    // button is also a route step's on this path, as in a form that asks for the code after
    // the password, needs every fill field of the route there gone: while one shows, the
    // page is still the sign-in page. A handler that already ran counts as shown again
    // whenever its elements are there, hidden or disabled, so it never runs twice.
    const routeFields = passwordVariants(run.recipe)
      .flatMap((variant) => variant.steps)
      .filter((step) => step.path === path)
      .flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.target) : []))
      .filter(
        (target, index, all) => all.findIndex((other) => sameLoginTarget(other, target)) === index,
      );
    const routeClicks = passwordVariants(run.recipe)
      .flatMap((variant) => variant.steps)
      .filter((step) => step.path === path)
      .flatMap((step) => (step.kind === "click" ? [step.target] : []));
    // A login that may still type its password, on the `password` route without a stop, never
    // enters a `passkey` handler on a path where its plan still has a route step to run that
    // fills the password, nor while a fill field of the route shows on this path, as one
    // learned beside the password field at another login's stop (ADR 0036): the button never
    // pre-empts the password it types, even while the page swaps its identifier for its
    // password field. A route step still to run that fills only another slot, as a code on
    // the page after the password, does not keep it out. A login with a stop, recorded when
    // it started and kept whatever the vault later holds, never types it.
    const typesPassword = run.metadata.route === "password" && run.metadata.stopAt === undefined;
    // The first plan step not yet run: the one after the step in flight, or the current one.
    const unrun =
      run.metadata.operationId === undefined ? run.metadata.stepIndex : run.metadata.stepIndex + 1;
    const passwordAhead =
      typesPassword &&
      (attemptPlan(run.recipe, run.metadata) ?? []).some(
        (entry, index) =>
          index >= unrun &&
          entry.handler === undefined &&
          entry.step.kind === "fill" &&
          entry.step.path === path &&
          entry.step.fields.some((field) => field.slot === "password"),
      );
    const entries = (run.recipe.handlers ?? []).flatMap((handler, index) => {
      if (
        handler.path !== path ||
        (stop && handler.kind !== "passkey") ||
        (passwordAhead && handler.kind === "passkey")
      )
        return [];
      const ran = run.metadata.handlers.some((entered) => entered.index === index);
      const sameForm =
        !ran &&
        ((handler.kind === "totp" &&
          routeClicks.some((target) => sameLoginTarget(target, handler.target))) ||
          (handler.kind === "passkey" && typesPassword));
      const targets = handlerTargets(handler);
      return [
        {
          handler,
          index,
          targets: [...targets, ...(sameForm ? routeFields : [])],
          require: [
            ...(ran
              ? targets.map(() => "present" as const)
              : handler.kind === "totp"
                ? (["writable", "shown"] as const)
                : (["shown"] as const)),
            ...(sameForm ? routeFields.map(() => "writable" as const) : []),
          ],
          own: targets.length,
        },
      ];
    });
    if (!entries.length) return false;
    // A separate observation, so the recipe's own bound of 24 elements still holds; past it,
    // the handlers that do not fit are not entered.
    let room = 24;
    const observable = entries.filter((entry) => {
      if (entry.targets.length > room) return false;
      room -= entry.targets.length;
      return true;
    });
    if (!observable.length) return false;
    const observed = await runtime.observe(
      run,
      observable.flatMap((entry) => entry.targets),
      observable.flatMap((entry) => entry.require),
    );
    if (!observed || observed.path !== path) return false;
    let offset = 0;
    const shown = observable
      .filter((entry) => {
        const states = observed.targets.slice(offset, offset + entry.targets.length);
        offset += entry.targets.length;
        return (
          states.length === entry.targets.length &&
          states.slice(0, entry.own).every((state) => state === "unique") &&
          states.slice(entry.own).every((state) => state !== "unique")
        );
      })
      .sort((left, right) => handlerOrder[left.handler.kind] - handlerOrder[right.handler.kind]);
    if (!shown.length) return false;
    const reportHandler = (
      entry: (typeof entries)[number],
      outcome: Extract<LoginReport, { type: "handler" }>["outcome"],
    ) =>
      report(run.live.document, {
        type: "handler",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: run.recipe.id,
        recipeRevision: run.recipe.revision,
        handler: entry.index,
        kind: entry.handler.kind,
        outcome,
        steps: handlerSteps(entry.handler).length,
      });
    const challenge = () =>
      stop
        ? stop.end()
        : runtime.change(run, {
            type: "OBSERVED",
            result: "challenge",
            document: run.live.document,
          });
    // A handler page shown again after its handler ran is left to the person, and so is a
    // second code in one login, so a wrong code or key is never retried into a lockout.
    const refusal = (entry: (typeof entries)[number]) =>
      run.metadata.handlers.some((entered) => entered.index === entry.index)
        ? ("shown-again" as const)
        : !run.metadata.facts[handlerFact[entry.handler.kind]]
          ? ("missing-fact" as const)
          : entry.handler.kind === "totp" && attemptUsesCode(run.recipe, run.metadata)
            ? ("code-used" as const)
            : undefined;
    const fresh = shown.find((entry) => refusal(entry) === undefined);
    if (!fresh) {
      reportHandler(shown[0]!, refusal(shown[0]!)!);
      await challenge();
      return true;
    }
    if (fresh.handler.kind === "totp") {
      // The code comes from the item's built-in TOTP field, which the account must allow.
      const authorized = await runtime.allowed(run);
      if (!authorized) return true;
      const code = codeFieldOf(
        authorized.connection,
        run.metadata.account.itemId,
        authorized.bindings,
        run.recipe,
      );
      if (!code || !authorized.fieldIds.includes(code)) {
        reportHandler(fresh, "missing-fact");
        await challenge();
        return true;
      }
    }
    const steps = handlerSteps(fresh.handler);
    const event: LoginAttemptEvent = {
      type: "HANDLER",
      handler: fresh.index,
      steps: steps.length,
      effects: steps.filter((step) => {
        const effect = loginStepEffect(step);
        return effect === "advance" || effect === "submit";
      }).length,
      document: run.live.document,
    };
    // At a stop the attempt stays ready either way: only an entered handler counts.
    const entered = transitionLoginAttempt(run.metadata, event);
    if (entered.state !== "ready" || entered.handlers.length === run.metadata.handlers.length) {
      reportHandler(fresh, "no-room");
      await challenge();
      return true;
    }
    reportHandler(fresh, "entered");
    await runtime.change(run, event);
    return true;
  }
  /**
   * After a `totp` handler's fill, whether the page moved on by itself before the click
   * found its button (ADR 0027): to another path, or to a signed-in marker or the rejection
   * without the button. A button still shown is clicked once as planned.
   */
  async function submittedByPage(
    run: Execution,
    click: Extract<LoginStep, { kind: "click" }>,
  ): Promise<boolean> {
    const { rejection } = run.recipe;
    const proof = markerProof(run.recipe);
    const observed = await runtime.observe(
      run,
      [click.target, ...proof.targets, ...(rejection ? [rejection] : [])],
      ["present", ...proof.shown, ...(rejection ? ["present" as const] : [])],
      proof.links.length > 0 ? [false, ...proof.links] : undefined,
    );
    if (!observed || !runtime.current(run)) return false;
    if (observed.path !== click.path) return true;
    if (observed.targets[0] === "unique") return false;
    return (
      proof.proves(observed.targets, 1) ||
      (rejection !== undefined && observed.targets[1 + proof.targets.length] === "unique")
    );
  }
  /**
   * The page submitted a TOTP code by itself, a `totp` handler's or a route step's: the
   * code's click counts as done, and the page is settled as after a click. The code is
   * never filled again.
   * Returns whether the attempt took it.
   */
  async function codeSubmitted(run: Execution): Promise<boolean> {
    await runtime.change(run, autoSubmitted(run.recipe, run.metadata));
    if (
      !runtime.current(run) ||
      run.metadata.state !== "reconciling" ||
      run.metadata.operationKind !== "click"
    )
      return false;
    // Held as after the click: a page that shows "Verifying" with the button still there
    // is neither judged nor settled while it verifies.
    run.heldClick = run.metadata.stepIndex;
    await runtime.reconcileBounded(run);
    return true;
  }
  /**
   * After an effect step that no check explained, sends the resulting page so the
   * service can judge it and learn a signed-in marker or a handler (ADR 0018, ADR 0027).
   * Returns whether the attempt settled or moved on. A page that still shows the route's
   * fields on one of its paths, or a signed-in marker, is not sent. At most
   * `MAX_JUDGED_PAGES` pages count per effect step, and as many again while the login is
   * watched (ADR 0027): a page counts in the attempt once its complete description is in
   * hand, before the request, so a restart cannot resend without bound, and is given back
   * only for a temporary refusal before any model call.
   */
  /** Logs why the page was not sent to the judge, as a code: never page text. */
  function notJudged(run: Execution, reason: string): false {
    report(run.live.document, {
      type: "judge",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: run.recipe.id,
      recipeRevision: run.recipe.revision,
      route: run.metadata.route,
      verdict: "not-sent",
      reason,
      ...(run.metadata.watch ? { watched: true as const } : {}),
    });
    return false;
  }
  /**
   * The usernames hidden from a judged page: those of the items that match it, as for a
   * page sent for generation, and the login's own account's even when it does not match
   * the page's URL. `undefined` when one cannot be read.
   */
  async function judgedUsernames(run: Execution): Promise<string[] | undefined> {
    const { connectionId, itemId } = run.metadata.account;
    const scope = await runtime.generationSlotsFor(run.live).catch(() => undefined);
    let reads = scope ? runtime.usernameReads(scope) : [];
    if (
      !scope?.items.some(
        ({ connection, item }) => connection.id === connectionId && item.id === itemId,
      )
    ) {
      const snapshot = await settings.handle({ version: 1, type: "settings.get" });
      if (!snapshot.ok) return undefined;
      const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
      const item = connection?.items.find((entry) => entry.id === itemId);
      if (!connection || !item) return undefined;
      reads = [
        ...reads,
        ...runtime.usernameReads({
          items: [{ connection, item }],
          settings: snapshot.snapshot.settings,
        }),
      ];
    }
    return runtime.readUsernames(run.live.document.origin, reads);
  }
  /**
   * The page's description for the judge, on `path`, with the usernames of the items that
   * match it and the login's own hidden; or why it is not sent (`unsent`), or nothing when
   * the run was superseded meanwhile.
   */
  async function describeForJudge(
    run: Execution,
    path: string,
  ): Promise<
    { observation: LoginObservation; disabledLeftOut: boolean } | { unsent: string } | undefined
  > {
    let observation: LoginObservation | undefined;
    let unsent = "unreachable";
    let disabledLeftOut = false;
    try {
      const extracted = v.safeParse(
        extractResultSchema,
        await send(run.live, { type: "login.extract", page: "signed-in" }),
      );
      const parsed =
        extracted.success && extracted.output.ok
          ? v.safeParse(loginObservationSchema, extracted.output.observation)
          : undefined;
      if (!extracted.success || !parsed?.success)
        unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "invalid-page";
      else if (!parsed.output.complete)
        unsent = (extracted.output.ok && extracted.output.gap) || "incomplete";
      else if (
        parsed.output.origin !== run.live.document.origin ||
        // The description carries the path with any token-like segment replaced.
        parsed.output.path !== signedInPath(path)
      )
        unsent = "page-changed";
      else {
        observation = parsed.output;
        disabledLeftOut = extracted.output.ok && extracted.output.disabledLeftOut === true;
      }
    } catch {
      // The page could not be asked: `unreachable`.
    }
    if (!runtime.current(run)) return undefined;
    if (!observation) return { unsent };
    // A judged page can show the identifier just entered: the usernames of the items that
    // match it, and the login's own, are hidden first.
    const usernames = await judgedUsernames(run).catch(() => undefined);
    const hidden = runtime.hideUsernames(observation, usernames);
    if (!runtime.current(run)) return undefined;
    if ("reason" in hidden) return { unsent: hidden.reason };
    return { observation: hidden.observation, disabledLeftOut };
  }
  async function learn(run: Execution, reading?: SignInReading): Promise<boolean> {
    const { recipe, metadata } = run;
    const { operationId } = metadata;
    if (!generation || !effectful(metadata) || !operationId) return false;
    const notSent = (reason: string) => notJudged(run, reason);
    if (pagesLeft(metadata, operationId) <= 0) return notSent("page-limit");
    // Every variant's fill fields and paths count, as on the service, which is never told
    // the variant; on the passkey route, its button and the password form, on its path and
    // the password route's (ADR 0027).
    const paths = routeSignInPaths(recipe, metadata.route);
    const marker = (recipe.completion ?? [])
      .filter((entry) => entry.origin === undefined)
      .map((entry) => entry.target);
    const fills = routeSignInTargets(recipe, metadata.route).slice(0, 24 - marker.length);
    // A hidden marker proves nothing and does not keep the page from the judge.
    const remaining = await runtime.observe(
      run,
      [...fills, ...marker],
      [
        ...fills.map((target) => (passkeyButton(run, target) ? "present" : "input")),
        ...marker.map(() => "shown" as const),
      ],
      marker.length > 0 ? [...fills.map(() => false), ...marker.map(() => true)] : undefined,
    );
    if (!remaining) {
      // A superseded run or a refused one (logged with its own cause) says nothing here.
      if (runtime.current(run) && !terminal(run.metadata)) notSent("unreachable");
      return false;
    }
    // A route's sign-in field shows on another path too (S1): such a page is never complete
    // (ADR 0029), and the description may leave the field out when no locator names it.
    if (
      reading?.decision === "unknown" ||
      reading?.decision === "rejected" ||
      (paths.includes(remaining.path) &&
        remaining.targets
          .slice(0, fills.length)
          .some((state) => state !== "missing" && state !== "unusable"))
    )
      return notSent("sign-in-shown");
    // A marker shows, but the completion check did not prove the sign-in: more than one
    // match, or an element it needs gone is there.
    if (
      remaining.targets
        .slice(fills.length)
        .some((state) => state === "unique" || state === "ambiguous")
    )
      return notSent("marker-shown");
    const described = await describeForJudge(run, remaining.path);
    if (!described) return true;
    // A page that cannot be described completely is not sent and does not count.
    if ("unsent" in described) return notSent(described.unsent);
    const { observation, disabledLeftOut } = described;
    const left = pagesLeft(run.metadata, operationId);
    await runtime.change(run, { type: "JUDGING", operationId });
    if (!runtime.current(run)) return true;
    if (pagesLeft(run.metadata, operationId) !== left - 1) return false;
    const watchedPage = run.metadata.watch !== undefined;
    const reportJudge = (
      verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
      detail: {
        reason?: string;
        takenOver?: boolean;
        completed?: true;
        notCompleted?: "disabled-left-out" | "password-empty";
      } = {},
    ) =>
      report(run.live.document, {
        type: "judge",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        route: metadata.route,
        verdict,
        ...detail,
        ...(watchedPage ? { watched: true as const } : {}),
        ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
      });
    // A chooser login's branch, and whether the description left a disabled field out
    // (ADR 0029); each is passed only when there is one.
    const branch = metadata.chooser ? chooserClickBranch(metadata.chooser.click) : undefined;
    const judgedTail: [(ChooserBranch | undefined)?, true?] = disabledLeftOut
      ? [branch, true]
      : branch
        ? [branch]
        : [];
    const spin = spinning(run.live.document.tabId);
    const {
      verdict,
      reason,
      recipe: added,
    } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        // The service knows no `passkey` route on a recipe without its button; the page's
        // own request is answered beside the password form, which the service checks for
        // that route the same way (ADR 0034).
        metadata.route === "passkey" && passkeyAnswersRequest(recipe) ? "password" : metadata.route,
        observation,
        spin.sent(() => reportJudge("sent")),
        ...judgedTail,
      )
      .finally(spin.stop);
    if (!runtime.current(run)) {
      reportJudge(verdict, {
        ...(reason ? { reason } : {}),
        ...(added ? { takenOver: false } : {}),
      });
      return true;
    }
    // A temporary refusal, such as a busy service, gives the page back.
    if (verdict === "retry") await runtime.change(run, { type: "UNJUDGED", operationId });
    // A page with no sign and no evidence completes when the judge cannot decide, unless
    // the login is watched (ADR 0027); one with a sign of another sign-in step goes to the
    // person, as does a page judged `challenge` before (ADR 0029).
    const candidate = undecidedCandidate({
      verdict,
      reason,
      reading,
      watched: run.metadata.watch !== undefined,
      route: run.metadata.route,
      stopAt: run.metadata.stopAt,
    });
    let again: Awaited<ReturnType<typeof readSignInState>>;
    // The judge's answer can take a while: the page completes only if, once the answer is
    // back, it has loaded and still shows no sign of a sign-in going on.
    if (candidate.completes) {
      again = await readSignInState(run);
      if (!runtime.current(run)) {
        reportJudge(verdict, { ...(reason ? { reason } : {}) });
        return true;
      }
    }
    const { completes, notCompleted } = settleCompletion({
      ...candidate,
      again,
      disabledLeftOut,
    });
    // Reported before the takeover's own entries, once whether it is taken over is known.
    let reported = false;
    // A watched login only reads its pages; it never runs a learned handler (ADR 0027).
    const movedOn =
      verdict === "challenge" &&
      added !== undefined &&
      run.metadata.state !== "watching" &&
      runtime.current(run) &&
      (await runtime.takeOver(run, added, remaining.path, () => {
        reported = true;
        reportJudge(verdict, { takenOver: true });
      }));
    if (!reported)
      reportJudge(verdict, {
        ...(reason ? { reason } : {}),
        ...(added ? { takenOver: false } : {}),
        ...(completes ? { completed: true } : {}),
        ...(notCompleted ? { notCompleted } : {}),
      });
    if (movedOn || !runtime.current(run)) return true;
    const result = judgedCompletionResult({
      verdict,
      reason,
      reading,
      completes,
      stopHeld: candidate.stopHeld,
      route: run.metadata.route,
      stopAt: run.metadata.stopAt,
    });
    // The page after the final advance before a stop just past the plan's last step, not
    // found signed in or rejected and with no handler taken over, takes the login to its
    // stop, where the page's passkey request is answered (ADR 0036).
    if (result === "challenge" && (await toStop(run))) return true;
    await runtime.change(run, { type: "OBSERVED", result, document: run.live.document });
    return true;
  }
  return {
    enterHandler,
    reconcile,
    signInState,
    askAgain,
    learn,
    submittedByPage,
    codeSubmitted,
    describeForJudge,
  };
}
