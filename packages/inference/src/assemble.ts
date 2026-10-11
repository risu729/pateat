import {
  extendsRecipe,
  loginRecipeSchema,
  loginStepEffect,
  sameLoginTarget as sameTarget,
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
  /** The marker is an element one of the recipe's own steps or handlers uses on that path. */
  | "step-target"
  /** The marker is not an element of the judged page. */
  | "not-on-page"
  /**
   * The page still shows an element a step uses on that path, or a field any step
   * fills: it is a login page again.
   */
  | "login-page"
  /** The completion would break the recipe contract, such as its observation bound. */
  | "invalid-recipe";

const effects = (steps: readonly LoginStep[]) =>
  steps.filter((step) => {
    const effect = loginStepEffect(step);
    return effect === "advance" || effect === "submit";
  }).length;
const stepTargets = (step: LoginStep) =>
  step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target];
const handlerTargets = (recipe: LoginRecipe, path: string) =>
  (recipe.handlers ?? []).filter((handler) => handler.path === path).map(({ target }) => target);
const filledSlots = (steps: readonly LoginStep[]) =>
  steps.flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.slot) : []));

/**
 * Starts a recipe from the first page's steps, or appends a later page's steps to a
 * recipe whose last step advances. Slots are the ones the steps fill, so a binding
 * never has to cover a slot the recipe does not use. The revision is the next one; the
 * caller stores it with a conditional write. The recipe keeps the first account switch a
 * page names that is not also one of its click targets.
 */
export function appendPageSteps(
  base: LoginRecipe | undefined,
  page: {
    id: string;
    origin: string;
    steps: readonly LoginStep[];
    accountSwitch?: LoginTarget;
  },
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: AssemblyRejection } {
  if (base) {
    if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
    if (base.completion) return { ok: false, reason: "already-complete" };
    const last = base.steps.at(-1);
    if (!last || loginStepEffect(last) !== "advance") return { ok: false, reason: "not-advancing" };
  }
  const steps = [...(base?.steps ?? []), ...page.steps];
  const { accountSwitch: kept, ...rest } = base ?? {};
  const accountSwitch = [kept, page.accountSwitch].find(
    (target) =>
      target !== undefined &&
      !steps.some((step) => step.kind === "click" && sameTarget(step.target, target)),
  );
  const recipe = v.safeParse(loginRecipeSchema, {
    ...rest,
    ...(accountSwitch ? { accountSwitch } : {}),
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
 * marker must be an element of the judged page on the recipe's origin and not one of
 * the recipe's own targets on that path. The page must not still show any element a
 * step uses on that path, nor a field any step fills on any path: a failed sign-in that
 * shows the login form again, on its own path or where the form posted, is not learned
 * as signed in. On a step's own path the completion also lists that path's fill fields
 * as `absent`, since the executor checks it after every step and counts hidden elements.
 */
export function addCompletion(
  base: LoginRecipe,
  page: Pick<LoginObservation, "origin" | "path" | "candidates">,
  target: LoginTarget,
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: CompletionRejection } {
  if (base.completion) return { ok: false, reason: "already-complete" };
  if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
  if (!page.candidates.some((candidate) => sameTarget(candidate.target, target)))
    return { ok: false, reason: "not-on-page" };
  const used = base.steps.filter((step) => step.path === page.path).flatMap(stepTargets);
  if ([...used, ...handlerTargets(base, page.path)].some((element) => sameTarget(element, target)))
    return { ok: false, reason: "step-target" };
  // Buttons such as "Next" may recur on signed-in pages elsewhere; fill fields do not.
  const fields = base.steps.flatMap((step) =>
    step.kind === "fill" ? step.fields.map((field) => field.target) : [],
  );
  const loginElements = [...used, ...fields];
  if (
    page.candidates.some((candidate) =>
      loginElements.some((element) => sameTarget(element, candidate.target)),
    )
  )
    return { ok: false, reason: "login-page" };
  const absent = base.steps
    .filter((step) => step.path === page.path && step.kind === "fill")
    .flatMap(stepTargets)
    .filter((field, index, all) => all.findIndex((other) => sameTarget(other, field)) === index);
  const recipe = v.safeParse(loginRecipeSchema, {
    ...base,
    revision: base.revision + 1,
    completion: { path: page.path, target, ...(absent.length ? { absent } : {}) },
  });
  return recipe.success
    ? { ok: true, recipe: recipe.output }
    : { ok: false, reason: "invalid-recipe" };
}

export type HandlerRejection =
  | "origin-mismatch"
  /** The button is not a button of the judged page. */
  | "not-on-page"
  /** The button registers, adds or sets up a passkey rather than signing in with one. */
  | "registration"
  /**
   * The button is one of the recipe's step targets on that path, its account switch,
   * rejection or completion marker.
   */
  | "step-target"
  /** The recipe already has a handler of this kind on that path. */
  | "duplicate"
  /** The result breaks the recipe contract, such as its handler bound. */
  | "invalid-recipe";

/**
 * Words of a button that registers or adds a passkey ("Add a passkey", "Set up security
 * key", "パスキーを登録"). The judge is told not to name one; this local check also
 * refuses it, and can refuse a sign-in button whose text happens to match.
 */
const registration = /\b(?:add|register|create|set\s*up|new|enrol?l)\b|登録|追加|作成/iu;
/**
 * A locator value as words: `addPasskey`, `register_key` and `#set-up-key` read as
 * "add Passkey", "register key" and "set up key".
 */
const words = (value: string) =>
  value.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll(/[^\p{L}\p{N}]+/gu, " ");

/**
 * Adds a `passkey` handler for the judged page's security-key or passkey button to a
 * generated recipe in its next revision (ADR 0027). The route's steps are kept as they
 * are, so a running login can take the result over (`extendsRecipe`). The page may be
 * on a route path: a second-factor form on the sign-in path still gets a handler.
 */
export function addHandler(
  base: LoginRecipe,
  page: Pick<LoginObservation, "origin" | "path" | "candidates">,
  handler: { kind: "passkey"; target: LoginTarget },
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: HandlerRejection } {
  if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
  const button = page.candidates.find(
    (candidate) => candidate.role === "button" && sameTarget(candidate.target, handler.target),
  );
  if (!button) return { ok: false, reason: "not-on-page" };
  // The label, the text and an id, name or test ID locator all count.
  if (
    [button.label, button.target.value].some(
      (text) => text !== undefined && registration.test(words(text)),
    )
  )
    return { ok: false, reason: "registration" };
  const used = [
    ...base.steps.filter((step) => step.path === page.path).flatMap(stepTargets),
    ...(base.accountSwitch ? [base.accountSwitch] : []),
    ...(base.rejection ? [base.rejection] : []),
    ...(base.completion ? [base.completion.target] : []),
  ];
  if (used.some((element) => sameTarget(element, handler.target)))
    return { ok: false, reason: "step-target" };
  const handlers = base.handlers ?? [];
  if (handlers.some((entry) => entry.kind === handler.kind && entry.path === page.path))
    return { ok: false, reason: "duplicate" };
  const recipe = v.safeParse(loginRecipeSchema, {
    ...base,
    revision: base.revision + 1,
    handlers: [...handlers, { kind: handler.kind, path: page.path, target: handler.target }],
  });
  return recipe.success && extendsRecipe(base, recipe.output)
    ? { ok: true, recipe: recipe.output }
    : { ok: false, reason: "invalid-recipe" };
}
