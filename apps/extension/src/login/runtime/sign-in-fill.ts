import {
  attemptPlan,
  fillOnlyStep,
  loginStepEffect,
  routeFillTargets,
  resolvePagePermission,
  type LoginStep,
  type LoginRecipe,
} from "@pateat/contracts";
import { loginReadiness } from "../wire";
import { change, current, send, report, publish } from "./attempt";
import { observe } from "./reconcile";
import { allowed } from "./plan-2";
import { confirmPage, confirmSigns } from "./markers";
import { enterHandler } from "./handlers";
import { askContinuation, cachedRoute, continueWith, recordedContinuation } from "./continuation";
import { pathNow } from "./steps";
import { LOGIN_STEP_WAIT_MS } from "../wire";
import type { Execution, LiveDocument } from "./types";
import { WATCH_MS, CONTINUATION_STABLE_MS } from "./constants";
import type { Runtime } from "./state";

/** Includes no click, keypad, code or fill whose own event advances/submits. */
const safe = (step: LoginStep) => step.kind !== "click" && fillOnlyStep(step) !== undefined;

/** A valid pick is document/attempt scoped; stale popup state grants nothing. */
export function explicitlyPicked(rt: Runtime, live: LiveDocument): boolean {
  const pick = rt.picked.get(live.document.tabId);
  const record =
    rt.attempts.get(live.document.tabId)?.metadata ??
    rt.persisted.get(`${live.document.tabId} ${live.document.origin}`);
  return Boolean(
    pick &&
    !pick.site &&
    pick.origin === live.document.origin &&
    (pick.attemptId === undefined
      ? pick.documentId === live.document.documentId
      : record?.id === pick.attemptId && !record.signInFill),
  );
}

/** Entry clicks are also forbidden by the site's/profile's autofill setting. */
export async function automaticFill(rt: Runtime, live: LiveDocument): Promise<boolean> {
  if (explicitlyPicked(rt, live)) return false;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  return (
    !snapshot.ok ||
    resolvePagePermission(snapshot.snapshot.settings, live.url, "sign-in")?.permission !== "auto"
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
  const index = plan.findIndex(
    (entry, at) => at > run.metadata.stepIndex && entry.step.kind === "fill" && safe(entry.step),
  );
  if (run.metadata.fillBaseline?.stepIndex === run.metadata.stepIndex) return;
  let shown: boolean;
  if (index < 0) {
    const fills = routeFillTargets(run.recipe, "password").slice(0, 24);
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
 * Wait at a forbidden action until the next known field actually appears on a new
 * document/path, or changes from not ready to ready in this document. No click event,
 * mutation alone, elapsed time, or model verdict advances the plan.
 */
export async function fillBoundary(rt: Runtime, run: Execution): Promise<boolean> {
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
    if (!(await allowed(rt, run))) return false;
    const plan = attemptPlan(run.recipe, run.metadata) ?? [];
    const index = plan.findIndex(
      (entry, at) => at > run.metadata.stepIndex && entry.step.kind === "fill" && safe(entry.step),
    );
    const next = index < 0 ? undefined : plan[index]!.step;
    const baseline = run.metadata.fillBaseline;
    if (next && baseline?.nextStep !== index) {
      await change(rt, run, {
        type: "FILL_BASELINE",
        nextStep: index,
        path: pathNow(run.live),
        ready: await ready(rt, run, next),
      });
      continue;
    }
    if (
      next &&
      baseline &&
      (await ready(rt, run, next)) &&
      (baseline.documentId !== run.live.document.documentId ||
        baseline.path !== pathNow(run.live) ||
        !baseline.ready)
    ) {
      await change(rt, run, { type: "FILL_PROGRESS", stepIndex: index });
      return current(rt, run);
    }
    // Already learned ordinary handlers remain usable. Code and click-only handlers
    // are deliberately left to the person; no existing schema proves a code will not
    // submit at its last digit, even when the recipe also names a button.
    if (await enterHandler(rt, run, pathNow(run.live))) return current(rt, run);
    if (!current(rt, run) || run.metadata.state !== "ready") return false;
    if (await fillContinuation(rt, run)) return current(rt, run);
    if (!current(rt, run)) return false;
    // The content script observes the document's own signals; timeout bounds only the
    // message so policy changes/cancellation are rechecked even on a quiet page.
    run.fillWaiting = true;
    let response: unknown;
    try {
      response = await send(rt, run.live, {
        type: "login.fill.change",
        timeoutMs: LOGIN_STEP_WAIT_MS,
      }).catch(() => undefined);
    } finally {
      delete run.fillWaiting;
    }
    if (!response || !current(rt, run)) return false;
  }
  /* eslint-enable no-await-in-loop */
  return false;
}

/** Continue a final advance after the person/page exposed the missing input. */
async function fillContinuation(rt: Runtime, run: Execution): Promise<boolean> {
  const { metadata, recipe } = run;
  const step = attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.step;
  if (
    !rt.generation ||
    !rt.uris ||
    metadata.route !== "password" ||
    metadata.variant !== 0 ||
    metadata.handlers.length ||
    metadata.chooser ||
    metadata.stopAt !== undefined ||
    metadata.stepIndex + 1 !== metadata.stepCount ||
    !step ||
    step.kind !== "click" ||
    loginStepEffect(step) !== "advance" ||
    recipe.completion ||
    recipe.alternatives
  )
    return false;
  const fills = routeFillTargets(recipe, "password").slice(0, 23);
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

export const isFillAction = safe;

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
