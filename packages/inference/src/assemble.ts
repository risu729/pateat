import {
  loginRecipeSchema,
  loginStepEffect,
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
  /** The result exceeds the recipe contract's step, slot or submission bounds. */
  | "too-long";

const sameTarget = (left: LoginTarget, right: LoginTarget) =>
  left.by === right.by && left.value === right.value;
const effects = (steps: readonly LoginStep[]) =>
  steps.filter((step) => {
    const effect = loginStepEffect(step);
    return effect === "advance" || effect === "submit";
  }).length;

/**
 * Starts a recipe from the first page's steps, or appends a later page's steps to a
 * recipe whose last step advances. The revision is the next one; the caller stores it
 * with a conditional write.
 */
export function appendPageSteps(
  base: LoginRecipe | undefined,
  page: { id: string; origin: string; slots: readonly string[]; steps: readonly LoginStep[] },
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: AssemblyRejection } {
  if (base) {
    if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
    if (base.completion) return { ok: false, reason: "already-complete" };
    const last = base.steps.at(-1);
    if (!last || loginStepEffect(last) !== "advance") return { ok: false, reason: "not-advancing" };
  }
  const steps = [...(base?.steps ?? []), ...page.steps];
  const slots = [...new Set([...(base?.slots ?? []), ...page.slots])];
  const recipe = v.safeParse(loginRecipeSchema, {
    version: 1,
    id: base?.id ?? page.id,
    revision: (base?.revision ?? 0) + 1,
    origin: page.origin,
    slots,
    steps,
    maxSubmissions: Math.max(1, effects(steps)),
  });
  return recipe.success ? { ok: true, recipe: recipe.output } : { ok: false, reason: "too-long" };
}

/**
 * Adds the judged completion target to a generated recipe in its next revision. A target
 * that one of the recipe's own steps uses on the same path cannot prove a sign-in.
 */
export function addCompletion(
  base: LoginRecipe,
  completion: { path: string; target: LoginTarget },
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: "already-complete" | "step-target" } {
  if (base.completion) return { ok: false, reason: "already-complete" };
  const reused = base.steps.some(
    (step) =>
      step.path === completion.path &&
      (step.kind === "fill"
        ? step.fields.some((field) => sameTarget(field.target, completion.target))
        : sameTarget(step.target, completion.target)),
  );
  if (reused) return { ok: false, reason: "step-target" };
  return {
    ok: true,
    recipe: v.parse(loginRecipeSchema, { ...base, revision: base.revision + 1, completion }),
  };
}
