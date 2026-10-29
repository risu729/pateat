import * as v from "valibot";
import {
  attemptPlan,
  attemptRouteChoice,
  builtInLoginSlots,
  continuesRecipe,
  extendsRecipe,
  isFieldExcluded,
  handlerSlots,
  loginFieldSource,
  loginStepEffect,
  passwordStopOrMiss,
  MAX_ATTEMPT_SUBMISSIONS,
  routeFillTargets,
  routeSteps,
  runsLogin,
  sameLoginTarget,
  transitionLoginAttempt,
  type LoginAttemptEvent,
  type LoginObservation,
  isLoginRouteRecipe,
  chooserRoute,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginRouteChoice,
  type PasswordStopMiss,
  type LoginStep,
} from "@pateat/contracts";
import { extractResultSchema, loginReadiness } from "../wire";
import { type Execution, type GenerationScope } from "./types";
import { change, current, report, send, spinning, spend } from "./attempt";
import { enterHandler } from "./handlers";
import { waitFor, observe } from "./reconcile";
import {
  inPlaceNext,
  stepTargets,
  logCode,
  acceptedObservation,
  branchField,
  outcomeFields,
} from "./steps";
import { planFor } from "./plan";
import { probeMode, CONTINUATION_WAIT_MS, CONTINUATION_STABLE_MS } from "./constants";
import { stopsPastPlan } from "./attempt-state";
import { generationSlotsFor, usernameReads, customSlots } from "./generation-scope";
import { readUsernames, usernameShape, hideUsernames } from "./markers";
import { type GenerationOutcome } from "./report";
import type { Runtime } from "./state";

/**
 * The first login takes over the revision its judged page added a handler to and runs
 * the handler on the page it is on (ADR 0027). Only a revision that keeps the routes and
 * their steps is taken over. Returns whether the attempt moved on.
 */
export async function takeOver(
  rt: Runtime,
  run: Execution,
  answered: LoginRecipe | LoginChooserRecipe,
  path: string,
  taking: () => void,
  stop?: { end: () => Promise<void> },
): Promise<boolean> {
  const next = routeOf(rt, run, answered);
  if (!next || next.id !== run.recipe.id || !extendsRecipe(run.recipe, next)) return false;
  const event: LoginAttemptEvent = { type: "REVISED", recipeRevision: next.revision };
  if (transitionLoginAttempt(run.metadata, event).recipeRevision !== next.revision) return false;
  taking();
  // The recipe is replaced before the record that names its revision is written.
  run.recipe = next;
  if (!isLoginRouteRecipe(answered)) run.chooser = answered;
  await change(rt, run, event);
  return current(rt, run) && (await enterHandler(rt, run, path, stop));
}

/**
 * The route a login runs of a recipe the service sent or the cache holds: a chooser
 * login's is the route of its click on the chooser (ADR 0028), and a chooser is never
 * another login's.
 */
export function routeOf(
  _rt: Runtime,
  run: Execution,
  next: LoginRecipe | LoginChooserRecipe | undefined,
): LoginRecipe | undefined {
  if (!next) return undefined;
  const click = run.metadata.chooser?.click;
  if (isLoginRouteRecipe(next)) return click ? undefined : next;
  return click ? chooserRoute(next, click) : undefined;
}

/** The newest cached revision of a login's own recipe, as the route it runs. */
export async function cachedRoute(
  rt: Runtime,
  run: Execution,
  path: string,
): Promise<LoginRecipe | undefined> {
  const { origin: pageOrigin } = run.live.document;
  // The layout the login started on (ADR 0060).
  const { layout } = run.metadata;
  if (!run.metadata.chooser) return rt.recipes.recipe(pageOrigin, path, run.recipe.id, layout);
  return routeOf(rt, run, await rt.recipes.chooser?.(pageOrigin, path, run.recipe.id, layout));
}

/**
 * The other layouts of a login's recipe it may run from plan step `at` on (ADR 0060),
 * newest first: each whose steps before `at` are the login's own, with a different step
 * at `at`. Only a `password` login on its recipe's own steps (variant 0) has any, with no
 * handler entered, no stop, no chooser and not only filling, past its first step: the
 * layouts were told apart there already.
 */
export async function siblingsAt(rt: Runtime, run: Execution, at: number): Promise<LoginRecipe[]> {
  const { metadata, recipe } = run;
  if (
    !rt.recipes.layoutsOf ||
    metadata.layout === undefined ||
    metadata.route !== "password" ||
    metadata.variant !== 0 ||
    metadata.handlers.length > 0 ||
    metadata.chooser !== undefined ||
    metadata.stopAt !== undefined ||
    metadata.fillOnly === true ||
    at < 1
  )
    return [];
  const plan = attemptPlan(recipe, metadata);
  if (!plan || plan.length !== metadata.stepCount) return [];
  const layouts = await Promise.resolve(rt.recipes.layoutsOf(recipe.origin, recipe.id)).catch(
    () => [],
  );
  const stepsOf = (entries: { step: LoginStep }[]) =>
    JSON.stringify(entries.map((entry) => entry.step));
  const before = stepsOf(plan.slice(0, at));
  const own = plan[at] && stepsOf([plan[at]]);
  return layouts
    .filter((other) => {
      if (
        other.id !== recipe.id ||
        other.layout === undefined ||
        other.layout === metadata.layout ||
        other.revision < metadata.recipeRevision ||
        !runsLogin(other)
      )
        return false;
      const steps = attemptPlan(other, metadata);
      return (
        steps !== undefined &&
        steps.length > at &&
        stepsOf(steps.slice(0, at)) === before &&
        stepsOf([steps[at]!]) !== own
      );
    })
    .sort((left, right) => Number(right.layout) - Number(left.layout));
}

/**
 * Switches the login to another layout of its recipe at the step where they part (ADR
 * 0060), when the page shows that layout's step there and not the login's own: after an
 * effect step that may have advanced, the step after it, confirmed as the login's own next
 * step would be (on its path, or on the advance's path by elements the advance made
 * ready); with nothing in flight, the step at hand, ready to run. The account's plan must
 * pass on that layout. Returns whether the login switched; the newest layout that fits
 * wins.
 */
// The layouts are tried in order, each against the page as it is now.
/* eslint-disable no-await-in-loop */
export async function switchLayout(rt: Runtime, run: Execution): Promise<boolean> {
  const { metadata } = run;
  const inFlight = metadata.operationId !== undefined;
  if (
    inFlight &&
    !(
      (metadata.operationKind === "click" || metadata.operationEffect === "advance") &&
      metadata.mutationIntent === true &&
      metadata.submissions > 0
    )
  )
    return false;
  if (!inFlight && metadata.retryRequired === true) return false;
  // A click left to the person is theirs to press first.
  if (inFlight && run.heldClick === metadata.stepIndex) return false;
  const at = inFlight ? metadata.stepIndex + 1 : metadata.stepIndex;
  // Past the login's own last step only an advance goes on (`LAYOUT`'s guard).
  if (at >= metadata.stepCount && metadata.operationEffect !== "advance") return false;
  const siblings = await siblingsAt(rt, run, at);
  if (!current(rt, run)) return false;
  const done = inFlight ? attemptPlan(run.recipe, metadata)?.[metadata.stepIndex]?.step : undefined;
  for (const sibling of siblings) {
    const step = attemptPlan(sibling, metadata)![at]!.step;
    let shows: boolean;
    if (!inFlight) {
      // As the step would wait for its elements before it runs; a step that needs none
      // shows nothing of the layout.
      const readiness = loginReadiness(step);
      if (!readiness.targets.length) continue;
      const waited = await waitFor(rt, run, readiness, 1);
      if (!current(rt, run) || waited === "gone") return false;
      shows = waited === "ready";
    } else {
      // An advance on the step's own path is confirmed only by elements it made ready, as
      // the login's own next step is (ADR 0013).
      const inPlace =
        done?.path === step.path ? inPlaceNext(sibling, metadata, metadata.stepIndex) : undefined;
      const measured =
        run.siblingsInPlace && run.siblingsInPlace.operationId === metadata.operationId
          ? run.siblingsInPlace.siblings.find((entry) => entry.layout === sibling.layout)
          : undefined;
      if (
        done?.path === step.path &&
        !(
          inPlace &&
          measured?.before.length === inPlace.targets.length &&
          measured.before.every((state) => state === "missing" || state === "unusable")
        )
      )
        continue;
      const targets = inPlace ? inPlace.targets : stepTargets(step);
      if (!targets.length) continue;
      const observed = await observe(
        rt,
        run,
        targets,
        targets.map(() => inPlace?.require ?? "present"),
      );
      if (!observed) return false;
      shows = observed.path === step.path && observed.targets.every((state) => state === "unique");
    }
    if (!shows) continue;
    // The account's binding and fields must fit the layout's route, as at a login's start.
    const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
    if (!current(rt, run)) return false;
    if (!snapshot.ok || snapshot.snapshot.revision !== run.metadata.policyRevision) return false;
    const plan = await planFor(rt, snapshot, run.live, sibling, {
      route: { route: "password", variant: 0 },
    });
    if (!current(rt, run) || run.metadata !== metadata) return false;
    if (
      !plan.ok ||
      plan.account.connectionId !== metadata.account.connectionId ||
      plan.account.itemId !== metadata.account.itemId
    )
      continue;
    const event: LoginAttemptEvent = {
      type: "LAYOUT",
      layout: sibling.layout!,
      recipeRevision: sibling.revision,
      steps: attemptPlan(sibling, metadata)!.length,
      // What the login holds beyond its recipe's budget, as the submissions a passkey
      // answer spent before it fell back to the password (ADR 0034), stays with it.
      maxSubmissions: Math.min(
        MAX_ATTEMPT_SUBMISSIONS,
        sibling.maxSubmissions + Math.max(0, metadata.maxSubmissions - run.recipe.maxSubmissions),
      ),
      document: run.live.document,
    };
    if (transitionLoginAttempt(metadata, event).layout !== sibling.layout) continue;
    // The recipe is replaced before the record that names its layout is written.
    run.recipe = sibling;
    // The account's choice is saved for the layout the login signs in on.
    if (plan.choice) run.choice = plan.choice;
    else delete run.choice;
    delete run.inPlace;
    delete run.siblingsInPlace;
    delete run.qualified;
    await change(rt, run, event);
    return true;
  }
  return false;
}

/* eslint-enable no-await-in-loop */
/**
 * Whether the attempt's in-flight step is the final `advance` step of a recipe that can be
 * continued on the page it leads to (ADR 0018): a `password` route login on the recipe's
 * own steps (variant 0), in the tab's own page, with recipe generation configured, whose
 * recipe has no completion and no alternatives. A login of an item without a password
 * asks only when its stop lies just past that advance (ADR 0036). A `password` handler's
 * click counts as that advance when it is the plan's last step and the recipe's own last
 * step is an advance (ADR 0048).
 */
export function continuable(rt: Runtime, run: Execution): boolean {
  const { metadata, recipe } = run;
  if (
    !rt.generation ||
    !rt.uris ||
    (probeMode && metadata.account.origin === rt.vars.origin) ||
    // A fill-only login ends before any advance (ADR 0021 D).
    metadata.fillOnly === true ||
    metadata.route !== "password" ||
    metadata.variant !== 0 ||
    (metadata.stopAt !== undefined && !stopsPastPlan(metadata)) ||
    run.live.document.frameId !== 0 ||
    run.live.topUrl !== undefined ||
    metadata.operationId === undefined ||
    metadata.operationEffect !== "advance" ||
    recipe.completion !== undefined ||
    recipe.alternatives !== undefined
  )
    return false;
  const plan = attemptPlan(recipe, metadata);
  const inFlight = plan?.[metadata.stepIndex];
  return (
    plan !== undefined &&
    plan.length === metadata.stepCount &&
    metadata.stepIndex + 1 === plan.length &&
    inFlight !== undefined &&
    (inFlight.handler === undefined || recipe.handlers?.[inFlight.handler]?.kind === "password") &&
    loginStepEffect(inFlight.step) === "advance" &&
    recipe.steps.at(-1) !== undefined &&
    loginStepEffect(recipe.steps.at(-1)!) === "advance"
  );
}

/**
 * After a recipe's final `advance` step, sends the page it led to so the service appends
 * that page's steps, and takes the continued revision over (ADR 0018). The page qualifies
 * once it has finished loading and has shown, for a second on one path, a sign-in input
 * for a built-in slot the recipe does not fill yet, other than the recipe's own fields: a
 * password input, or, while none of the recipe's fill fields is writable on the page, a
 * username or email input. A complete description of it that shows such an input is sent
 * once per effect step, offering only the slots the recipe does not fill yet: the request
 * is recorded in the attempt first, and given back for a later document to send when the
 * generation claim was freed or the request was not sent (`retry`). A later document of the login waits
 * for an answer still on its way. Returns `moved` once the attempt moved on or this document is no longer
 * current, `qualified` for a qualifying page that was not continued (yet), which is never
 * judged, and `none` for any other page.
 */
export async function continueOn(
  rt: Runtime,
  run: Execution,
): Promise<"none" | "qualified" | "moved"> {
  if (!continuable(rt, run) || !rt.generation) return "none";
  const { recipe, metadata } = run;
  const operationId = metadata.operationId!;
  const fills = routeFillTargets(recipe, "password").slice(0, 24);
  const observed = await observe(
    rt,
    run,
    fills,
    fills.map(() => "writable" as const),
    { signIn: true },
  );
  if (!current(rt, run)) return "moved";
  if (!observed) return "none";
  const filled = new Set(
    recipe.steps.flatMap((step) =>
      step.kind === "fill" ? step.fields.map((field) => field.slot) : [],
    ),
  );
  const shown = observed.signIn;
  const byPassword = shown?.password === true && !filled.has("password");
  // A page that asks for the account again, such as the identifier form shown again
  // where it posted, shows one of the recipe's fill fields writable, on any path. A
  // revealed password input below the identifier the recipe filled still qualifies.
  const byIdentifier =
    shown?.identifier === true &&
    !filled.has("username") &&
    !observed.targets.some((target) => target === "unique");
  if (shown?.loaded !== true || !(byPassword || byIdentifier)) {
    if (run.qualified?.operationId === operationId) delete run.qualified;
    return "none";
  }
  const now = Date.now();
  if (run.qualified?.operationId !== operationId || run.qualified.path !== observed.path)
    run.qualified = { operationId, path: observed.path, since: now };
  const state = run.qualified;
  const refuse = () => {
    run.continuationRefused = operationId;
    return "qualified" as const;
  };
  /** Logs once per document why the qualifying page is not sent (yet). */
  const unsent = (reason: string, detail?: string) => {
    if (run.live.generationSkip !== reason) {
      run.live.generationSkip = reason;
      report(rt, run.live.document, {
        type: "generation",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        outcome: "skipped",
        reason,
        ...(detail ? { detail } : {}),
        recipeId: recipe.id,
        baseRevision: recipe.revision,
      });
    }
    return "qualified" as const;
  };
  if (run.continuationRefused === operationId) return "qualified";
  // Spent for this step. A revision that continues the recipe and reached the cache, as
  // after a restart during the request, is taken over; so is an answer an earlier
  // document of the login still waits for, or that arrived after it was left. While that
  // answer is on its way this document waits for it, past the step's ten seconds.
  if (metadata.continuation?.operationId === operationId) {
    const fromCache = async (): Promise<"moved" | "refused" | "none"> => {
      const cached = await cachedRoute(rt, run, observed.path).catch(() => undefined);
      if (!current(rt, run)) return "moved";
      if (!cached || cached.revision <= recipe.revision || !continuesRecipe(recipe, cached))
        return "none";
      if ((await continueWith(rt, run, cached)) || !current(rt, run)) return "moved";
      return "refused";
    };
    const cached = await fromCache();
    if (cached === "moved") return "moved";
    if (cached === "refused") return refuse();
    const earlier = rt.continuations.get(metadata.id);
    if (earlier?.operationId !== operationId) return "qualified";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      earlier.answer,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CONTINUATION_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!current(rt, run)) return "moved";
    if (rt.continuations.get(metadata.id) === earlier) rt.continuations.delete(metadata.id);
    if (answer?.outcome === "recipe") {
      if ((await continueWith(rt, run, answer.recipe)) || !current(rt, run)) return "moved";
    } else if (answer?.retry) {
      // Given back, as the earlier document would have: this one sends it again.
      await change(rt, run, { type: "UNCONTINUED", operationId });
      return current(rt, run) ? "qualified" : "moved";
    } else if (!answer) {
      // No answer in time; only the cache can still bring it.
      return (await fromCache()) === "moved" ? "moved" : "qualified";
    }
    return refuse();
  }
  if (now - state.since < CONTINUATION_STABLE_MS) return "qualified";
  // The fields the recipe already filled, on any path, may show again read-only, as an
  // email a password page on another path of the same document keeps (#831).
  const known = recipe.steps
    .flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.target) : []))
    .slice(0, 24);
  let observation: LoginObservation | undefined;
  let missing = "extract-failed";
  // Why a described page is not sent, for the log (ADR 0019).
  let detail: string | undefined;
  try {
    const extracted = v.safeParse(
      extractResultSchema,
      await send(rt, run.live, {
        type: "login.extract",
        page: "login",
        ...(known.length ? { known } : {}),
      }),
    );
    // The content script's refusal, such as `no-locator` or `extract-error`, as for a
    // first page; `extract-failed` for an answer that fails its check or never came.
    if (extracted.success && !extracted.output.ok) {
      missing = extracted.output.reason;
      if (extracted.output.detail) detail = logCode(extracted.output.detail);
    } else if (extracted.success && extracted.output.ok) {
      const accepted = acceptedObservation(extracted.output, {
        origin: run.live.document.origin,
        path: observed.path,
      });
      if ("observation" in accepted) observation = accepted.observation;
      else {
        missing = "incomplete-observation";
        detail = accepted.detail;
      }
    }
  } catch {
    observation = undefined;
  }
  if (!current(rt, run)) return "moved";
  // An incomplete description is not sent and does not count; a later round tries again.
  if (!observation) return unsent(missing, detail);
  // The description must show the input the page qualified with, which it can leave out
  // where the two read the page differently, as an input in a form the description does
  // not keep. The page must then qualify for another second before it is read again.
  const fillTargets = recipe.steps.flatMap((step) =>
    step.kind === "fill" ? step.fields.map((field) => field.target) : [],
  );
  const described = observation.candidates.some(
    (candidate) =>
      (byPassword &&
        candidate.role === "password" &&
        candidate.autocomplete !== "new-password" &&
        candidate.autocomplete !== "one-time-code") ||
      (byIdentifier &&
        (candidate.role === "email" ||
          candidate.autocomplete === "username" ||
          candidate.autocomplete === "email") &&
        !fillTargets.some((target) => sameLoginTarget(target, candidate.target))),
  );
  if (!described) {
    state.since = Date.now();
    return unsent("field-not-described");
  }
  // The login's own item must match the page, as for a recipe's first page (ADR 0016).
  const scope = await generationSlotsFor(rt, run.live).catch(() => undefined);
  if (!current(rt, run)) return "moved";
  // The tab or the vault could not answer now, or no item matches; a later round asks again.
  if (!scope) return unsent("no-vault-match");
  if (
    !scope.items.some(
      ({ connection, item }) =>
        connection.id === metadata.account.connectionId && item.id === metadata.account.itemId,
    )
  ) {
    // A connection that did not answer or an item whose URI rules were not evaluated may
    // still hold it: a later round asks again.
    if (!scope.complete) return unsent("scope-incomplete");
    unsent("no-vault-match");
    return refuse();
  }
  const pageOrigin = run.live.document.origin;
  // A slot the recipe already fills is not offered again, so the model cannot map it to a
  // field the page still shows (the service refuses such a page too).
  // A login that stops before its item's missing password offers the password slot too,
  // so the page can be continued up to its password step, which this login never runs
  // (ADR 0036). Only the slot goes out, never a value.
  const offered =
    metadata.stopAt !== undefined &&
    !scope.slots.some((slot) => slot.id === "password") &&
    ownPasswordField(rt, scope, metadata.account)
      ? [...scope.slots, builtInLoginSlots.password]
      : scope.slots;
  const slots = offered.filter((slot) => !filled.has(slot.id));
  // Likewise a custom field the recipe's generated slot map already names (ADR 0027).
  const named = await Promise.resolve(rt.generation.slotFields(recipe.id)).catch(() => undefined);
  const offers = scope.offers.filter(
    (offer) =>
      !named?.some(
        ({ field }) =>
          typeof field !== "string" &&
          field.custom === offer.reference.custom &&
          field.position === offer.reference.position &&
          field.count === offer.reference.count,
      ),
  );
  const usernames = await readUsernames(rt, pageOrigin, usernameReads(rt, scope));
  const shape = usernames && usernameShape(rt, scope, usernames);
  // The page after an `advance` step can show the identifier just entered.
  const hidden = hideUsernames(rt, observation, usernames, run.live);
  if (!current(rt, run)) return "moved";
  // A username that could not be read now may be read on a later round; one that shows
  // where it cannot be hidden shows again.
  if ("reason" in hidden) {
    unsent(hidden.reason);
    return hidden.reason === "username-unread" ? "qualified" : refuse();
  }
  const custom = await customSlots(rt, pageOrigin, { ...scope, offers });
  if (!current(rt, run)) return "moved";
  if (!slots.length && !custom.length) {
    unsent("no-slots");
    return refuse();
  }
  // Recorded before the request, so a restart never sends this step's page again.
  await change(rt, run, { type: "CONTINUING", operationId });
  // Left during the write, the record may hold `CONTINUING` with nothing sent: fail-closed,
  // the step's page then settles `unknown` unless the cache brings the continuation.
  if (!current(rt, run)) return "moved";
  if (run.metadata.continuation?.operationId !== operationId) return refuse();
  // The page that asks, logged when its request leaves the device (ADR 0019).
  const page = run.live.document;
  const spin = spinning(rt, page.tabId);
  const askedAt = Date.now();
  const asked = rt.generation
    .generate(
      {
        version: 1,
        observation: hidden.observation,
        slots: [
          ...slots.map((slot) =>
            slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
          ),
          ...custom,
        ],
        base: { recipeId: recipe.id, revision: recipe.revision },
        // The page continues the login's layout (ADR 0060); a chooser login's is its
        // branch's next page (ADR 0028).
        ...branchField(metadata),
      },
      spin.sent(() =>
        report(rt, page, {
          type: "generation",
          tabId: page.tabId,
          origin: pageOrigin,
          outcome: "sent",
          recipeId: recipe.id,
          baseRevision: recipe.revision,
        }),
      ),
    )
    .finally(spin.stop)
    // A thrown request frees its claim, so it is given back like any request that did not
    // reach the model.
    .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error", retry: true }))
    // Counted once, for whichever document of the login takes the answer (ADR 0019).
    .then((answer) => {
      if (answer.outcome !== "skipped") spend(rt, metadata.id, Date.now() - askedAt, answer.timing);
      return answer;
    });
  // Kept in memory for a later document of this login, which the form may post to
  // before the answer arrives.
  const request = { operationId, answer: asked };
  rt.continuations.set(metadata.id, request);
  const answer = await asked;
  const reportGeneration = (takenOver?: boolean, notTakenOver?: string) =>
    report(rt, run.live.document, {
      type: "generation",
      tabId: run.live.document.tabId,
      origin: pageOrigin,
      ...outcomeFields(answer),
      recipeId: recipe.id,
      baseRevision: recipe.revision,
      ...(takenOver === undefined ? {} : { takenOver }),
      ...(notTakenOver === undefined ? {} : { notTakenOver }),
    });
  // Left meanwhile: the attempt's next document uses the answer.
  if (!current(rt, run)) {
    reportGeneration();
    return "moved";
  }
  if (rt.continuations.get(metadata.id) === request) rt.continuations.delete(metadata.id);
  run.continuationRefused = operationId;
  if (answer.outcome !== "recipe") {
    reportGeneration();
    // A request that did not reach the model, or was not sent, gives the request back
    // for the attempt's next document to send.
    if (answer.retry) await change(rt, run, { type: "UNCONTINUED", operationId });
    return current(rt, run) ? "qualified" : "moved";
  }
  let reported = false;
  let taken = false;
  // Why the login did not take the revision over, always logged (ADR 0019).
  let refusal = "not-recorded";
  try {
    taken = await continueWith(
      rt,
      run,
      answer.recipe,
      () => {
        reported = true;
        reportGeneration(true);
      },
      (reason) => {
        refusal = reason;
      },
    );
  } finally {
    // Not taken over, or the `CONTINUED` write failed.
    if (!reported) reportGeneration(false, refusal);
  }
  if (taken || !current(rt, run)) return "moved";
  // A chooser the other branch changed meanwhile comes back without this branch's page
  // (ADR 0028): the login takes that revision over and sends the page again against it.
  const newer = routeOf(rt, run, answer.recipe);
  if (
    run.metadata.chooser &&
    !isLoginRouteRecipe(answer.recipe) &&
    newer &&
    extendsRecipe(run.recipe, newer) &&
    newer.steps.length === run.recipe.steps.length
  ) {
    const revised: LoginAttemptEvent = { type: "REVISED", recipeRevision: newer.revision };
    if (transitionLoginAttempt(run.metadata, revised).recipeRevision === newer.revision) {
      run.recipe = newer;
      run.chooser = answer.recipe;
      await change(rt, run, revised);
      if (!current(rt, run)) return "moved";
      await change(rt, run, { type: "UNCONTINUED", operationId });
      if (!current(rt, run)) return "moved";
      delete run.continuationRefused;
      delete run.qualified;
    }
  }
  return "qualified";
}

/**
 * Whether the login's own item, among a page's matching items, has a password field the
 * account may use, empty or not (ADR 0036).
 */
export function ownPasswordField(
  _rt: Runtime,
  scope: GenerationScope,
  owner: { connectionId: string; itemId: string },
): boolean {
  return scope.items.some(
    ({ connection, item }) =>
      connection.id === owner.connectionId &&
      item.id === owner.itemId &&
      item.fields.some((field) => field.id === "login.password") &&
      !isFieldExcluded(scope.settings, scope.catalog, connection.id, item.id, "login.password"),
  );
}

/**
 * The new stop, in the attempt's plan, of a login whose stop lay just past its plan's
 * last step, once `next` continues its recipe (ADR 0036): the continued step that first
 * fills a slot reading a password (the `password` slot, the item's password directly or
 * through a Linked field, or a hidden custom field), or just past the continued steps
 * when they fill none and end with an `advance`. Otherwise why the continuation has no
 * such stop, as `fills-lacking` for one that first fills another value the item lacks.
 */
export function continuedStop(
  _rt: Runtime,
  run: Execution,
  next: LoginRecipe,
  route: LoginRouteChoice,
  plan: Extract<Awaited<ReturnType<typeof planFor>>, { ok: true }>,
): number | PasswordStopMiss {
  const { facts } = run.metadata;
  const item = plan.connection.items.find((entry) => entry.id === plan.account.itemId);
  const slots = plan.binding.slots.map(({ slot, fieldId }) => ({
    slot,
    source: item ? loginFieldSource(item, fieldId) : fieldId,
    hidden: item?.fields.find((field) => field.id === fieldId)?.kind === "hidden",
  }));
  const passwordSlots = slots
    .filter(
      ({ slot, source, hidden }) => slot === "password" || source === "login.password" || hidden,
    )
    .map(({ slot }) => slot);
  const lacking = slots
    .filter(
      ({ source }) =>
        (source === "login.password" && !facts.password) ||
        (source === "login.totp-code" && !facts.totp),
    )
    .map(({ slot }) => slot);
  const found = passwordStopOrMiss(next, route, facts, passwordSlots, lacking);
  const known = routeSteps(run.recipe, route).length;
  if (!("stop" in found)) return found.miss;
  // A password step among the steps already run: no such stop is reachable, since those
  // steps were checked to fill no password when the login started, and no `PasswordStopMiss`
  // fits it better; the continued steps hold no step the login could still stop at.
  if (found.stop < known) return "no-password-step";
  // Entered handlers' steps all come before the continued ones.
  return found.stop + (run.metadata.stepCount - known);
}

/**
 * The login at its final `advance` step takes over the revision that continues its recipe
 * on the page it is on (ADR 0018, "use immediately"): only a revision that keeps the steps
 * it ran (`continuesRecipe`), and only when a dry run of the recorded route on it resolves
 * to the attempt's own account. Its earlier steps never run again; the account choice to
 * save after `authenticated` is derived again, so it covers the new slots too, filling
 * the ones a saved binding lacks (ADR 0027, amended 2026-10-19). Returns whether the
 * attempt moved on; otherwise `refused` gets a value-free code for why, for the log.
 */
export async function continueWith(
  rt: Runtime,
  run: Execution,
  next: LoginRecipe | LoginChooserRecipe,
  taking?: () => void,
  refused?: (reason: string) => void,
): Promise<boolean> {
  const refuse = (reason: string) => {
    refused?.(reason);
    return false;
  };
  const route = attemptRouteChoice(run.metadata);
  const answered = next;
  const converted = routeOf(rt, run, next);
  if (!current(rt, run)) return refuse("left");
  if (!converted) return refuse("route-missing");
  if (route.route !== "password") return refuse("route-not-password");
  if (converted.id !== run.recipe.id) return refuse("recipe-changed");
  if (!continuesRecipe(run.recipe, converted)) return refuse("not-continued");
  next = converted;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!current(rt, run)) return refuse("left");
  if (!snapshot.ok) return refuse("settings-unavailable");
  if (snapshot.snapshot.revision !== run.metadata.policyRevision)
    return refuse("settings-revision");
  const plan = await planFor(rt, snapshot, run.live, next, {
    route,
    handlerSlots: handlerSlots(next, run.metadata),
  });
  if (!current(rt, run)) return refuse("left");
  // The plan's own refusal, such as `binding-slots-mismatch` or `field-missing`.
  if (!plan.ok) return refuse(plan.reason);
  if (
    plan.account.connectionId !== run.metadata.account.connectionId ||
    plan.account.itemId !== run.metadata.account.itemId
  )
    return refuse("account-changed");
  const added = routeSteps(next, route).slice(routeSteps(run.recipe, route).length);
  // A login whose stop lay just past its plan moves it to the continued step that fills a
  // password, or past them again; one the continuation cannot stop in is not taken over.
  const stopAt =
    run.metadata.stopAt === undefined ? undefined : continuedStop(rt, run, next, route, plan);
  if (typeof stopAt === "string") {
    run.stopMiss = stopAt;
    return refuse(`stop:${stopAt}`);
  }
  const event: LoginAttemptEvent = {
    type: "CONTINUED",
    recipeRevision: next.revision,
    steps: added.length,
    effects: added.filter((step) => {
      const effect = loginStepEffect(step);
      return effect === "advance" || effect === "submit";
    }).length,
    document: run.live.document,
    ...(stopAt === undefined ? {} : { stopAt }),
  };
  try {
    if (transitionLoginAttempt(run.metadata, event).state !== "ready") return refuse("not-ready");
  } catch {
    // More steps or effects than one page may add.
    return refuse("budget-exceeded");
  }
  // The recipe is replaced before the record that names its revision is written.
  run.recipe = next;
  if (!isLoginRouteRecipe(answered)) run.chooser = answered;
  if (plan.choice) run.choice = plan.choice;
  else delete run.choice;
  delete run.qualified;
  delete run.stopMiss;
  await change(rt, run, event);
  // Reported as taken over only once the record names the new revision.
  if (run.metadata.recipeRevision === next.revision) taking?.();
  return current(rt, run) && run.metadata.state === "ready";
}
