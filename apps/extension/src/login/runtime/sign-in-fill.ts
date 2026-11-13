import * as v from "valibot";
import {
  attemptPlan,
  fillOnlyStep,
  loginStepEffect,
  routeFillTargets,
  type LoginStep,
  type LoginRecipe,
} from "@pateat/contracts";
import { LOGIN_STEP_WAIT_MS, loginReadiness } from "../wire";
import { change, current, send, report, publish } from "./attempt";
import { observe } from "./reconcile";
import { confirmPage, confirmSigns } from "./markers";
import { enterHandler } from "./handlers";
import { askContinuation, cachedRoute, continueWith, recordedContinuation } from "./continuation";
import { pathNow } from "./steps";
import type { Execution, LiveDocument } from "./types";
import { WATCH_MS, CONTINUATION_STABLE_MS } from "./constants";
import { explicitlyPicked, signInPermission } from "./page-permission";
import type { Runtime } from "./state";

/** At most this many targets go in one `login.observe` (its schema's bound). */
const OBSERVED_TARGETS_MAX = 24;

/** The document's answer to `login.fill.change`; `timedOut` when only its bound passed. */
const fillChangeSchema = v.object({ ok: v.boolean(), timedOut: v.optional(v.literal(true)) });

/** Includes no click, keypad, code or fill whose own event advances/submits. */
export function isFillAction(step: LoginStep): boolean {
  return step.kind !== "click" && fillOnlyStep(step) !== undefined;
}

/**
 * Whether the page only fills, pressing nothing, as its site or its tab's site sets
 * `sign-in` to `fill` and the person picked no account for it in the popup (ADR 0035).
 * Settings that cannot be read press nothing either.
 */
export async function passiveSignIn(rt: Runtime, live: LiveDocument): Promise<boolean> {
  if (explicitlyPicked(rt, live.document)) return false;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  return !snapshot.ok || signInPermission(snapshot.snapshot.settings, live).permission !== "auto";
}

/** The plan index of the first safe fill after the attempt's current step, or -1. */
function nextFill(run: Execution): number {
  const plan = attemptPlan(run.recipe, run.metadata) ?? [];
  return plan.findIndex(
    (entry, at) =>
      at > run.metadata.stepIndex && entry.step.kind === "fill" && isFillAction(entry.step),
  );
}

async function ready(rt: Runtime, run: Execution, step: LoginStep): Promise<boolean> {
  const readiness = loginReadiness(step);
  const observed = await observe(
    rt,
    run,
    readiness.targets,
    readiness.targets.map(() => readiness.require),
  );
  return (
    observed !== undefined &&
    observed.path === step.path &&
    observed.targets.length === readiness.targets.length &&
    observed.targets.every((entry) => entry === "unique")
  );
}

/** Capture the next page before the fill can cause the site to reveal it. */
export async function fillBaseline(rt: Runtime, run: Execution): Promise<void> {
  const plan = attemptPlan(run.recipe, run.metadata) ?? [];
  const index = nextFill(run);
  if (run.metadata.fillBaseline?.stepIndex === run.metadata.stepIndex) return;
  let shown: boolean;
  if (index < 0) {
    const fills = routeFillTargets(run.recipe, "password").slice(0, OBSERVED_TARGETS_MAX);
    const observed = await observe(
      rt,
      run,
      fills,
      fills.map(() => "writable"),
      { signIn: true },
    );
    if (!observed) return;
    const slots = new Set(
      run.recipe.steps.flatMap((entry) =>
        entry.kind === "fill" ? entry.fields.map((field) => field.slot) : [],
      ),
    );
    shown =
      (observed.signIn?.password === true && !slots.has("password")) ||
      (observed.signIn?.identifier === true &&
        !slots.has("username") &&
        !observed.targets.some((entry) => entry === "unique"));
  } else shown = await ready(rt, run, plan[index]!.step);
  if (!current(rt, run)) return;
  await change(rt, run, {
    type: "FILL_BASELINE",
    nextStep: index < 0 ? plan.length : index,
    path: pathNow(run.live),
    ready: shown,
  });
}

/**
 * The final `advance` click a generated page may still continue once the person or the
 * page exposes the missing input (ADR 0018, ADR 0035), or undefined when the attempt
 * cannot be continued that way.
 */
function continuationStep(
  rt: Runtime,
  run: Execution,
): Extract<LoginStep, { kind: "click" }> | undefined {
  const { metadata, recipe } = run;
  const step = attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.step;
  return rt.generation &&
    rt.uris &&
    metadata.route === "password" &&
    metadata.variant === 0 &&
    !metadata.handlers.length &&
    !metadata.chooser &&
    metadata.stopAt === undefined &&
    metadata.stepIndex + 1 === metadata.stepCount &&
    step?.kind === "click" &&
    loginStepEffect(step) === "advance" &&
    !recipe.completion &&
    !recipe.alternatives
    ? step
    : undefined;
}

/** A learned `detail` handler (ADR 0061) not entered yet, whose page may still follow. */
const detailAhead = (run: Execution) =>
  (run.recipe.handlers ?? []).some(
    (handler, index) =>
      handler.kind === "detail" && !run.metadata.handlers.some((entry) => entry.index === index),
  );

/**
 * Wait at a forbidden action until the next known field actually appears on a new
 * document/path, or changes from not ready to ready in this document. No click event,
 * mutation alone, elapsed time, or model verdict advances the plan. With nothing left
 * that it could fill, the attempt ends at once: the person goes on with the site's steps,
 * and the attempt neither waits for them nor resumes on the pages after them.
 */
export async function fillBoundary(rt: Runtime, run: Execution): Promise<boolean> {
  // The next step is checked when the boundary is reached, as on a new document, and
  // again each time the document answers that it may show; never while it is quiet.
  let check = true;
  /* eslint-disable no-await-in-loop */
  while (current(rt, run) && run.metadata.state === "ready") {
    const age = Date.now() - (run.metadata.fillSince ?? 0);
    if (age < 0 || age >= WATCH_MS) {
      await change(
        rt,
        run,
        { type: "FILL_EXPIRED" },
        undefined,
        undefined,
        undefined,
        "sign-in-fill-expired",
      );
      return false;
    }
    const index = nextFill(run);
    const next = index < 0 ? undefined : attemptPlan(run.recipe, run.metadata)?.[index]?.step;
    if (!next) {
      if (!continuationStep(rt, run) && !detailAhead(run)) {
        await change(
          rt,
          run,
          { type: "FILL_DONE" },
          undefined,
          undefined,
          undefined,
          "sign-in-fill",
        );
        return false;
      }
      // Already learned ordinary handlers remain usable. Code and click-only handlers
      // are deliberately left to the person; no existing schema proves a code will not
      // submit at its last digit, even when the recipe also names a button.
      if (await enterHandler(rt, run, pathNow(run.live))) return current(rt, run);
      if (!current(rt, run) || run.metadata.state !== "ready") return false;
      if (await fillContinuation(rt, run)) return current(rt, run);
      if (!current(rt, run)) return false;
      // The content script observes the document's own signals; timeout bounds only the
      // message, so the observations above recheck the policy even on a quiet page.
      const response = await send(rt, run.live, {
        type: "login.fill.change",
        timeoutMs: LOGIN_STEP_WAIT_MS,
      }).catch(() => undefined);
      if (!response || !current(rt, run)) return false;
      continue;
    }
    const baseline = run.metadata.fillBaseline;
    if (baseline?.nextStep !== index) {
      await change(rt, run, {
        type: "FILL_BASELINE",
        nextStep: index,
        path: pathNow(run.live),
        ready: await ready(rt, run, next),
      });
      continue;
    }
    if (
      check &&
      (await ready(rt, run, next)) &&
      (baseline.documentId !== run.live.document.documentId ||
        baseline.path !== pathNow(run.live) ||
        !baseline.ready)
    ) {
      await change(rt, run, { type: "FILL_PROGRESS", stepIndex: index });
      return current(rt, run);
    }
    if (check && (await enterHandler(rt, run, pathNow(run.live)))) return current(rt, run);
    if (!current(rt, run) || run.metadata.state !== "ready") return false;
    // Ready already before the fill in this document and on this path: only a move to
    // another path can show it anew.
    const settled =
      baseline.ready &&
      baseline.documentId === run.live.document.documentId &&
      baseline.path === pathNow(run.live);
    // The document answers once the next step shows (or its path moves, when it showed
    // already), with its timeout only as the bound. Nothing reads the settings or the
    // vault while it waits; the step is checked under the current policy once it shows.
    const answer = v.safeParse(
      fillChangeSchema,
      await send(rt, run.live, {
        type: "login.fill.change",
        timeoutMs: LOGIN_STEP_WAIT_MS,
        readiness: loginReadiness(next),
        ...(settled ? { settled: true } : {}),
      }).catch(() => undefined),
    );
    if (!answer.success || !answer.output.ok || !current(rt, run)) return false;
    check = answer.output.timedOut !== true;
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

/** Continue a final advance after the person/page exposed the missing input. */
async function fillContinuation(rt: Runtime, run: Execution): Promise<boolean> {
  const { metadata, recipe } = run;
  const step = continuationStep(rt, run);
  if (!step) return false;
  // One target of the observation is the step's own button.
  const fills = routeFillTargets(recipe, "password").slice(0, OBSERVED_TARGETS_MAX - 1);
  const observed = await observe(
    rt,
    run,
    [...fills, step.target],
    [...fills.map(() => "writable" as const), "shown"],
    { signIn: true },
  );
  if (!observed?.signIn?.loaded) return false;
  const slots = new Set(
    recipe.steps.flatMap((entry) =>
      entry.kind === "fill" ? entry.fields.map((field) => field.slot) : [],
    ),
  );
  const byPassword = observed.signIn.password === true && !slots.has("password");
  const byIdentifier =
    observed.signIn.identifier === true &&
    !slots.has("username") &&
    !observed.targets.slice(0, fills.length).some((entry) => entry === "unique");
  const baseline = metadata.fillBaseline;
  if (
    !(byPassword || byIdentifier) ||
    !baseline ||
    baseline.nextStep !== metadata.stepCount ||
    (baseline.documentId === run.live.document.documentId &&
      baseline.path === observed.path &&
      baseline.ready)
  ) {
    delete run.qualified;
    return false;
  }
  const operationId = `fill:${metadata.stepIndex}`;
  if (run.qualified?.operationId !== operationId || run.qualified.path !== observed.path) {
    run.qualified = { operationId, path: observed.path, since: Date.now() };
    return false;
  }
  if (Date.now() - run.qualified.since < CONTINUATION_STABLE_MS) return false;
  const recorded = metadata.continuation;
  const replacesLast =
    recorded && "before" in recorded
      ? true
      : recorded && "after" in recorded
        ? false
        : observed.path === step.path && observed.targets[fills.length] === "unique";
  const key: { before: number } | { after: number } = replacesLast
    ? { before: metadata.stepIndex }
    : { after: metadata.stepIndex };
  const options = { replacesLast };
  if (recordedContinuation(run, key)) {
    const cached = await cachedRoute(rt, run, observed.path).catch(() => undefined);
    return Boolean(cached && (await continueWith(rt, run, cached, undefined, undefined, options)));
  }
  const sent = await askContinuation(rt, run, {
    key,
    path: observed.path,
    byPassword,
    byIdentifier,
    unsent: (reason, detail) =>
      report(rt, run.live.document, {
        type: "generation",
        tabId: run.live.document.tabId,
        origin: recipe.origin,
        outcome: "skipped",
        reason,
        ...(detail ? { detail } : {}),
        recipeId: recipe.id,
        baseRevision: recipe.revision,
      }),
  });
  if (typeof sent === "string") return false;
  const { answer, reportGeneration, settle } = sent;
  settle();
  if (!current(rt, run) || answer.outcome !== "recipe") {
    reportGeneration();
    if (current(rt, run) && "retry" in answer && answer.retry)
      await change(
        rt,
        run,
        "after" in key
          ? { type: "FILL_UNCONTINUED", after: key.after }
          : { type: "UNCONTINUED", ...key },
      );
    return false;
  }
  let reported = false;
  const taken = await continueWith(
    rt,
    run,
    answer.recipe,
    () => {
      reported = true;
      reportGeneration(true);
    },
    undefined,
    options,
  );
  if (!reported) reportGeneration(false, "not-continued");
  return taken;
}

/** Off still observes the page-kind evaluation; it never selects or fills an account. */
export async function pageOff(
  rt: Runtime,
  live: LiveDocument,
  recipe: LoginRecipe,
  permissionSource: "site" | "default",
  amount?: boolean,
) {
  const visit = confirmPage(rt, live, recipe);
  if (live.notStarted !== "page-off") {
    live.notStarted = "page-off";
    visit.logged = confirmSigns(rt, live).then((signs) => {
      report(rt, live.document, {
        type: "refused",
        tabId: live.document.tabId,
        origin: live.document.origin,
        reason: "page-off",
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        pageKind: recipe.pageKind,
        permissionSource,
        ...(amount === undefined ? {} : { amount }),
        ...signs,
        url: live.url,
      });
      return signs.e1 === false && signs.e2 !== true;
    });
    void visit.logged.catch(() => undefined);
  }
  live.state = "denied";
  live.reason = "page-off";
  await publish(rt, live);
  return { ok: false, reason: "page-off", confirm: visit.first };
}
