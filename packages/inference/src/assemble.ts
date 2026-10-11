import {
  loginRecipeSchema,
  loginStepEffect,
  type LoginObservation,
  type LoginRecipe,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";
import * as v from "valibot";

// Generated recipes are built one page at a time (ADR 0018): each validated page plan is
// appended as steps, and the completion target is added once the first sign-in is judged.

export type AssemblyRejection =
  /** The recipe already has a completion target, so it is no longer being generated. */
  | "already-complete"
  /** The recipe's last step submits, so no later page belongs to it. */
  | "not-advancing"
  | "origin-mismatch"
  /** The result breaks the recipe contract, such as its step, slot or submission bounds. */
  | "invalid-recipe";

export type CompletionRejection =
  | "already-complete"
  | "origin-mismatch"
  /** The marker is an element one of the recipe's own steps uses on that path. */
  | "step-target"
  /** The page still shows an element a step uses on that path: it is the login page again. */
  | "login-page";

const sameTarget = (left: LoginTarget, right: LoginTarget) =>
  left.by === right.by && left.value === right.value;
const effects = (steps: readonly LoginStep[]) =>
  steps.filter((step) => {
    const effect = loginStepEffect(step);
    return effect === "advance" || effect === "submit";
  }).length;
const stepTargets = (step: LoginStep) =>
  step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target];
const filledSlots = (steps: readonly LoginStep[]) =>
  steps.flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.slot) : []));

/**
 * Starts a recipe from the first page's steps, or appends a later page's steps to a
 * recipe whose last step advances. Slots are the ones the steps fill, so a binding
 * never has to cover a slot the recipe does not use. The revision is the next one; the
 * caller stores it with a conditional write.
 */
export function appendPageSteps(
  base: LoginRecipe | undefined,
  page: { id: string; origin: string; steps: readonly LoginStep[] },
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: AssemblyRejection } {
  if (base) {
    if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
    if (base.completion) return { ok: false, reason: "already-complete" };
    const last = base.steps.at(-1);
    if (!last || loginStepEffect(last) !== "advance") return { ok: false, reason: "not-advancing" };
  }
  const steps = [...(base?.steps ?? []), ...page.steps];
  const recipe = v.safeParse(loginRecipeSchema, {
    ...base,
    version: 1,
    id: base?.id ?? page.id,
    revision: (base?.revision ?? 0) + 1,
    origin: page.origin,
    slots: [...new Set(filledSlots(steps))],
    steps,
    maxSubmissions: Math.max(1, effects(steps)),
  });
  return recipe.success
    ? { ok: true, recipe: recipe.output }
    : { ok: false, reason: "invalid-recipe" };
}

/**
 * Adds the judged completion target to a generated recipe in its next revision. The
 * marker must be on the recipe's origin, must not be one of the recipe's own targets on
 * that path, and the page must not still show any element a step uses on that path: a
 * failed sign-in that returns to a login page then never counts as signed in.
 */
export function addCompletion(
  base: LoginRecipe,
  page: Pick<LoginObservation, "origin" | "path" | "candidates">,
  target: LoginTarget,
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: CompletionRejection } {
  if (base.completion) return { ok: false, reason: "already-complete" };
  if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
  const used = base.steps.filter((step) => step.path === page.path).flatMap(stepTargets);
  if (used.some((step) => sameTarget(step, target))) return { ok: false, reason: "step-target" };
  if (page.candidates.some((candidate) => used.some((step) => sameTarget(step, candidate.target))))
    return { ok: false, reason: "login-page" };
  return {
    ok: true,
    recipe: v.parse(loginRecipeSchema, {
      ...base,
      revision: base.revision + 1,
      completion: { path: page.path, target },
    }),
  };
}
