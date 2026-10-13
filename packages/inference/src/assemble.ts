import {
  extendsRecipe,
  fillRoles,
  handlerTargets,
  hasRedactedSegment,
  isTotpCode,
  loginEntryRecipeSchema,
  loginRecipeSchema,
  loginStepEffect,
  MAX_COMPLETION_MARKERS,
  passwordVariants,
  recipeTypesCode,
  refillsLoginSlot,
  routeFillTargets,
  sameLoginTarget as sameTarget,
  splitCodeInputs,
  type LoginAttributeTarget,
  type LoginEntryRecipe,
  type LoginObservation,
  type LoginRecipe,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";
import { loginMoveFits } from "@pateat/contracts/site";
import * as v from "valibot";
import { registersPasskey, type EntryTarget } from "./plan";

// Generated recipes are built one page at a time (ADR 0018): each validated page plan is
// appended as steps, and a signed-in marker is added once the first sign-in is judged.

export type AssemblyRejection =
  /** The recipe already has a signed-in marker, so it is no longer being generated. */
  | "already-complete"
  /** The recipe's last step submits, so no later page belongs to it. */
  | "not-advancing"
  /**
   * The later page fills a slot the recipe already fills, as an identifier form shown
   * again where it posted: it is not the next page of this sign-in.
   */
  | "slot-refilled"
  | "origin-mismatch"
  /** The result breaks the recipe contract, such as its step, slot or submission bounds. */
  | "invalid-recipe";

export type CompletionRejection =
  /** The marker is one of the recipe's markers of the page's origin already. */
  | "already-learned"
  /** The recipe has four markers already (ADR 0029). */
  | "marker-limit"
  | "origin-mismatch"
  /**
   * The marker is an element one of the recipe's own steps or handlers uses, on any path:
   * a marker proves a sign-in wherever it shows.
   */
  | "step-target"
  /** The marker is not an element of the judged page. */
  | "not-on-page"
  /**
   * The page still shows an element a step uses on that path, or a field any step
   * fills: it is a login page again.
   */
  | "login-page"
  /** The marker would break the recipe contract, such as its observation bound. */
  | "invalid-recipe";

const effects = (steps: readonly LoginStep[]) =>
  steps.filter((step) => {
    const effect = loginStepEffect(step);
    return effect === "advance" || effect === "submit";
  }).length;
const stepTargets = (step: LoginStep) =>
  step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target];
/** Every element a handler of the recipe uses on `path`: buttons and code fields. */
const handlerElements = (recipe: LoginRecipe, path: string) =>
  (recipe.handlers ?? []).filter((handler) => handler.path === path).flatMap(handlerTargets);
/** The code fields of the recipe's `totp` handlers on `path`. */
const codeFields = (recipe: LoginRecipe, path: string) =>
  (recipe.handlers ?? []).flatMap((handler) =>
    handler.kind === "totp" && handler.path === path ? [handler.field] : [],
  );
/**
 * Every element a route's step uses on `path`: each password variant's, and the passkey
 * route's button (ADR 0027).
 */
const routeTargets = (recipe: LoginRecipe, path: string) => [
  ...passwordVariants(recipe)
    .flatMap((variant) => variant.steps)
    .filter((step) => step.path === path)
    .flatMap(stepTargets),
  ...(recipe.passkey?.path === path ? [recipe.passkey.target] : []),
];
const filledSlots = (steps: readonly LoginStep[]) =>
  steps.flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.slot) : []));

/**
 * The recipe of a page's sign-in entry (ADR 0031): its origin, the page's path and the
 * link's locator, and nothing else. It never gains steps, so it is always built whole;
 * the caller stores it with a conditional write at `revision`.
 */
export function entryRecipe(page: {
  id: string;
  revision: number;
  origin: string;
  path: string;
  target: EntryTarget;
}): { ok: true; recipe: LoginEntryRecipe } | { ok: false; reason: "invalid-recipe" } {
  const recipe = v.safeParse(loginEntryRecipeSchema, {
    version: 1,
    id: page.id,
    revision: page.revision,
    origin: page.origin,
    entry: { path: page.path, target: page.target },
  });
  return recipe.success
    ? { ok: true, recipe: recipe.output }
    : { ok: false, reason: "invalid-recipe" };
}

/**
 * Starts a recipe from the first page's steps, or appends a later page's steps to a
 * recipe whose last step advances. Slots are the ones the steps fill, so a binding
 * never has to cover a slot the recipe does not use. A first page may also bring
 * `alternatives`, the steps of its other identifier sets, which become the password
 * route's other variants, and `passkey`, the start page's passkey sign-in button, which
 * becomes the `passkey` route (ADR 0027); a continuation needs a single-variant recipe and
 * a page with neither. The revision is the next one; the caller stores it with a
 * conditional write. The recipe keeps the first account switch a page names that is not
 * also one of its click targets or its passkey button.
 */
export function appendPageSteps(
  base: LoginRecipe | undefined,
  page: {
    id: string;
    origin: string;
    steps: readonly LoginStep[];
    alternatives?: readonly (readonly LoginStep[])[];
    accountSwitch?: LoginTarget;
    /** The start page's passkey sign-in button, the `passkey` route (ADR 0027). */
    passkey?: LoginTarget;
  },
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: AssemblyRejection } {
  const alternatives = page.alternatives ?? [];
  if (base) {
    if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
    if (base.completion) return { ok: false, reason: "already-complete" };
    const last = base.steps.at(-1);
    if (base.alternatives || !last || loginStepEffect(last) !== "advance")
      return { ok: false, reason: "not-advancing" };
    // Variants and routes all start on the start page, so a later page never brings its own.
    if (alternatives.length || page.passkey) return { ok: false, reason: "invalid-recipe" };
    if (refillsLoginSlot(base.steps, page.steps)) return { ok: false, reason: "slot-refilled" };
  }
  const steps = [...(base?.steps ?? []), ...page.steps];
  const variants = [steps, ...alternatives];
  const { accountSwitch: kept, ...rest } = base ?? {};
  const passkey = base?.passkey?.target ?? page.passkey;
  const accountSwitch = [kept, page.accountSwitch].find(
    (target) =>
      target !== undefined &&
      !(passkey && sameTarget(passkey, target)) &&
      !variants.some((variant) =>
        variant.some((step) => step.kind === "click" && sameTarget(step.target, target)),
      ),
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
    ...(alternatives.length
      ? {
          alternatives: alternatives.map((variant) => ({
            slots: [...new Set(filledSlots(variant))],
            steps: [...variant],
          })),
        }
      : {}),
    ...(page.passkey ? { passkey: { path: steps[0]!.path, target: page.passkey } } : {}),
    maxSubmissions: Math.max(1, ...variants.map(effects)),
  });
  return recipe.success
    ? { ok: true, recipe: recipe.output }
    : { ok: false, reason: "invalid-recipe" };
}

/**
 * Adds the judged signed-in marker to a generated recipe in its next revision (ADR 0029):
 * the first one, or one more after those learned before, up to four. A marker proves a
 * sign-in on any path, so it must be an element of the judged page and none of the
 * elements the recipe's steps, passkey route or handlers use on any path. The page must
 * not still show any element a step uses on its own path, nor a field any step fills on
 * any path: a failed sign-in that shows the login form again, on its own path or where
 * the form posted, is not learned as signed in. On a step's own path the marker also
 * lists that path's fill fields as `absent`, since the executor checks it after every
 * step and counts hidden elements. A page of another origin of the recipe's site, or of
 * another site for a recipe that types a TOTP code, which a login's tab moved to (ADR
 * 0022), stores that origin with its marker; the recipe's paths
 * are not that origin's, so its own steps' paths are not compared there.
 */
export function addCompletion(
  base: LoginRecipe,
  page: Pick<LoginObservation, "origin" | "path" | "candidates">,
  target: LoginTarget,
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: CompletionRejection } {
  const markers = base.completion ?? [];
  const moved = base.origin !== page.origin;
  if (
    markers.some(
      (marker) =>
        (marker.origin ?? base.origin) === page.origin && sameTarget(marker.target, target),
    )
  )
    return { ok: false, reason: "already-learned" };
  if (markers.length >= MAX_COMPLETION_MARKERS) return { ok: false, reason: "marker-limit" };
  if (moved && !loginMoveFits(base.origin, page.origin, recipeTypesCode(base)))
    return { ok: false, reason: "origin-mismatch" };
  if (!page.candidates.some((candidate) => sameTarget(candidate.target, target)))
    return { ok: false, reason: "not-on-page" };
  // Every variant's steps count, whichever one the judged login ran, and the passkey
  // route's button (ADR 0027).
  const steps = passwordVariants(base).flatMap((variant) => variant.steps);
  const own = [
    ...steps.flatMap(stepTargets),
    ...(base.passkey ? [base.passkey.target] : []),
    ...(base.handlers ?? []).flatMap(handlerTargets),
  ];
  if (own.some((element) => sameTarget(element, target)))
    return { ok: false, reason: "step-target" };
  // Buttons such as "Next" may recur on signed-in pages elsewhere; fill fields do not. A
  // `totp` handler's code field on this path shows its code page (ADR 0027).
  const loginElements = [
    ...(moved ? [] : routeTargets(base, page.path)),
    ...routeFillTargets(base, "password"),
    ...(moved ? [] : codeFields(base, page.path)),
  ];
  if (
    page.candidates.some((candidate) =>
      loginElements.some((element) => sameTarget(element, candidate.target)),
    )
  )
    return { ok: false, reason: "login-page" };
  const absent = steps
    .filter((step) => !moved && step.path === page.path && step.kind === "fill")
    .flatMap(stepTargets)
    .filter((field, index, all) => all.findIndex((other) => sameTarget(other, field)) === index);
  // A marker lists at most 4 absent elements; with more, nothing is learned rather than a
  // marker that a sign-in page could satisfy.
  if (absent.length > 4) return { ok: false, reason: "invalid-recipe" };
  const recipe = v.safeParse(loginRecipeSchema, {
    ...base,
    revision: base.revision + 1,
    completion: [
      ...markers,
      { target, ...(moved ? { origin: page.origin } : {}), ...(absent.length ? { absent } : {}) },
    ],
  });
  return recipe.success
    ? { ok: true, recipe: recipe.output }
    : { ok: false, reason: "invalid-recipe" };
}

export type HandlerRejection =
  | "origin-mismatch"
  /**
   * The page's path has a segment the extension replaced (`REDACTED_PATH_SEGMENT`), so
   * the handler's path would never match the page.
   */
  | "redacted-path"
  /** The button is not a button of the judged page. */
  | "not-on-page"
  /** The button registers, adds or sets up a passkey rather than signing in with one. */
  | "registration"
  /**
   * A `totp` handler's field is not an input the executor fills a TOTP code into, shorter
   * than 6 characters or one of several code inputs of its form, or its button is in
   * another form.
   */
  | "not-code-field"
  /**
   * The button is one of the recipe's step targets on that path, its account switch,
   * rejection or completion marker, or another handler's element there; or a `totp`
   * handler's field is a field the route fills.
   */
  | "step-target"
  /** The recipe already has a handler of this kind on that path. */
  | "duplicate"
  /** The result breaks the recipe contract, such as its handler bound. */
  | "invalid-recipe";

/**
 * Adds a handler for the judged page to a generated recipe in its next revision (ADR
 * 0027): a `passkey` handler for its security-key or passkey button, or a `totp` handler
 * for its TOTP code field and the button that submits it. The route's steps
 * are kept as they are, so a running login can take the result over (`extendsRecipe`).
 * The page may be on a route path: a second-factor form on the sign-in path still gets a
 * handler. A `totp` handler's button may even be the route's own submit button on that
 * path, as on a page that asks for the code in the sign-in form after the password, but
 * its field is never a field the route fills.
 */
export function addHandler(
  base: LoginRecipe,
  page: Pick<LoginObservation, "origin" | "path" | "candidates">,
  handler:
    | { kind: "passkey"; target: LoginTarget }
    | { kind: "totp"; field: LoginAttributeTarget; target: LoginTarget },
): { ok: true; recipe: LoginRecipe } | { ok: false; reason: HandlerRejection } {
  if (base.origin !== page.origin) return { ok: false, reason: "origin-mismatch" };
  if (hasRedactedSegment(page.path)) return { ok: false, reason: "redacted-path" };
  const button = page.candidates.find(
    (candidate) => candidate.role === "button" && sameTarget(candidate.target, handler.target),
  );
  if (!button) return { ok: false, reason: "not-on-page" };
  const handlers = base.handlers ?? [];
  if (handlers.some((entry) => entry.kind === handler.kind && entry.path === page.path))
    return { ok: false, reason: "duplicate" };
  const others = [
    ...(base.accountSwitch ? [base.accountSwitch] : []),
    ...(base.rejection ? [base.rejection] : []),
    ...(base.completion ?? []).map((marker) => marker.target),
    ...handlerElements(base, page.path),
  ];
  if (handler.kind === "passkey") {
    // The label, the text and an id, name or test ID locator all count.
    if (registersPasskey(button)) return { ok: false, reason: "registration" };
    if (
      [...routeTargets(base, page.path), ...others].some((element) =>
        sameTarget(element, handler.target),
      )
    )
      return { ok: false, reason: "step-target" };
  } else {
    const field = page.candidates.find(
      (candidate) =>
        (fillRoles as readonly string[]).includes(candidate.role) &&
        sameTarget(candidate.target, handler.field),
    );
    if (!field) return { ok: false, reason: "not-on-page" };
    // The judge's own checks, again: the executor fills a TOTP code only into such a field
    // (ADR 0013), and one per form with its button.
    if (!isTotpCode(page, field, button)) return { ok: false, reason: "not-code-field" };
    const fills = routeFillTargets(base, "password");
    // A split code's other inputs are filled too.
    const filled = (splitCodeInputs(page, field) ?? [field]).map((input) => input.target);
    if (
      [...fills, ...routeTargets(base, page.path), ...others].some((element) =>
        filled.some((input) => sameTarget(element, input)),
      ) ||
      [
        ...fills,
        ...(base.passkey?.path === page.path ? [base.passkey.target] : []),
        ...others,
      ].some((element) => sameTarget(element, handler.target))
    )
      return { ok: false, reason: "step-target" };
  }
  const recipe = v.safeParse(loginRecipeSchema, {
    ...base,
    revision: base.revision + 1,
    handlers: [...handlers, { ...handler, path: page.path }],
  });
  return recipe.success && extendsRecipe(base, recipe.output)
    ? { ok: true, recipe: recipe.output }
    : { ok: false, reason: "invalid-recipe" };
}
