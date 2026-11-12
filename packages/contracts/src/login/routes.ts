import { type LoginStep, type LoginTarget, sameLoginTarget, loginStepEffect } from "./targets";
import {
  type LoginRecipe,
  variantsOf,
  passkeyStep,
  type LoginRoute,
  TOTP_HANDLER_SLOT,
  type LoginHandler,
  detailSlot,
} from "./route-schema";
import { detailFieldInputs } from "./details";
import * as v from "valibot";
import type { VaultItemMetadata } from "../settings";
import { canonicalJson } from "../canonical-json";

/**
 * One way through a route, as the executor records it when a login starts (ADR 0027).
 * `variant` indexes the password route's variants: 0 is the recipe's own `slots` and
 * `steps`, 1 to 3 its `alternatives`. The `passkey` route has no variants.
 */
// SSO parent metadata has no native executable route choice.
export type LoginRouteChoice = { route: "password"; variant: number } | { route: "passkey" };
/** One identifier set of the password route: the slots it fills and its steps. */
export type PasswordVariant = { slots: string[]; steps: LoginStep[] };
/** The password route's variants in order: the recipe's own, then its alternatives. */
export function passwordVariants(recipe: LoginRecipe): PasswordVariant[] {
  return recipe.passkeyOnly ? [] : variantsOf(recipe);
}
/**
 * Whether the recipe's `passkey` route answers the start page's own conditional passkey
 * request (ADR 0034): a recipe without a passkey button has no button to click.
 */
export function passkeyAnswersRequest(recipe: LoginRecipe): boolean {
  return recipe.passkey === undefined;
}
/**
 * The one step of a `passkey` route that answers the start page's own request (ADR 0034):
 * it stands for that answer as a submit on the password route's first element, on the
 * start path, and is never sent to the page. A login that started at a later step answers
 * on that step's page, so `from` is that step (ADR 0049).
 */
function requestStep(recipe: LoginRecipe, from?: LoginStep): LoginStep {
  const first = from ?? recipe.steps[0]!;
  return {
    kind: "click",
    path: first.path,
    target: first.kind === "fill" ? first.fields[0]!.target : first.target,
    purpose: "submit",
  };
}
/**
 * The chosen route's steps. The `passkey` route clicks its button, or without one answers
 * the start page's own request (ADR 0034), on the page of `from` when the login started at
 * that later step (ADR 0049).
 */
export function routeSteps(
  recipe: LoginRecipe,
  choice: LoginRouteChoice,
  from?: LoginStep,
): LoginStep[] {
  if (choice.route === "passkey")
    return [recipe.passkey ? passkeyStep(recipe.passkey) : requestStep(recipe, from)];
  return passwordVariants(recipe)[choice.variant]?.steps ?? [];
}
/**
 * The slots the chosen route fills; a binding for a login on it covers exactly these. The
 * `passkey` route fills none.
 */
export function routeSlots(recipe: LoginRecipe, choice: LoginRouteChoice): string[] {
  return choice.route === "password" ? (passwordVariants(recipe)[choice.variant]?.slots ?? []) : [];
}
/** Every slot of every route and variant, each once, in order. */
export function recipeSlots(recipe: LoginRecipe): string[] {
  return [...new Set(passwordVariants(recipe).flatMap((variant) => variant.slots))];
}
/**
 * Every fill target of a route, over all its variants, each once. A page that still shows
 * one is a sign-in page of the route, whichever variant ran, so it is not judged.
 */
export function routeFillTargets(recipe: LoginRecipe, route: LoginRoute): LoginTarget[] {
  if (route !== "password") return [];
  const targets = passwordVariants(recipe).flatMap((variant) =>
    variant.steps.flatMap((step) =>
      step.kind === "fill" ? step.fields.map((field) => field.target) : [],
    ),
  );
  return targets.filter(
    (target, index) => targets.findIndex((other) => sameLoginTarget(other, target)) === index,
  );
}
/**
 * Every path a route's steps use, over all its variants, each once. A `passkey` route
 * that answers the start page's request uses the start path (ADR 0034).
 */
export function routePaths(recipe: LoginRecipe, route: LoginRoute): string[] {
  if (route === "passkey") return [recipe.passkey?.path ?? recipe.steps[0]!.path];
  return [
    ...new Set(
      passwordVariants(recipe).flatMap((variant) => variant.steps.map((step) => step.path)),
    ),
  ];
}
/**
 * Elements whose presence on one of {@link routeSignInPaths} shows the page is still a
 * sign-in page, so it is not judged (ADR 0027): every fill target of the `password` route,
 * and on the `passkey` route also its button, which stays while its passkey exchange
 * runs. The `passkey` route counts the password form too: a start page that shows it
 * again after the click is still the sign-in page, not a page to learn from. A `passkey`
 * route without a button counts the password form only (ADR 0034).
 */
export function routeSignInTargets(recipe: LoginRecipe, route: LoginRoute): LoginTarget[] {
  const fills = routeFillTargets(recipe, "password");
  if (route !== "passkey" || !recipe.passkey) return fills;
  const button = recipe.passkey.target;
  return [button, ...fills.filter((target) => !sameLoginTarget(target, button))];
}
/**
 * The paths on which {@link routeSignInTargets} show a sign-in page and the judge is told
 * are the login's (ADR 0027): the route's own paths, and on the `passkey` route also every
 * path of the `password` route, whose form it starts beside.
 */
export function routeSignInPaths(recipe: LoginRecipe, route: LoginRoute): string[] {
  if (route !== "passkey") return routePaths(recipe, route);
  return [...new Set([...routePaths(recipe, "passkey"), ...routePaths(recipe, "password")])];
}
/**
 * The first step of every route and variant: a new login starts once any of them is
 * ready on the page. All of them are on the recipe's start path; the `passkey` route's
 * click comes first.
 */
export function recipeStartSteps(recipe: LoginRecipe): LoginStep[] {
  return [
    ...(recipe.passkey ? [passkeyStep(recipe.passkey)] : []),
    ...passwordVariants(recipe).map((variant) => variant.steps[0]!),
  ];
}
/**
 * The later steps a new login may start at when none of the recipe's first steps shows
 * (ADR 0049): each `password` variant's `fill` steps after its first, other than one that
 * fills only a TOTP code, which a running login's handler or route step answers. `index`
 * is the step's position in its variant. A `fill` step that fills the password together
 * with an account identifier, first or later, may also start with its password alone
 * (`partial`), as a site that remembers the account shows its sign-in form with the
 * password input alone (Duolingo, 2026-10-24); `absent` lists the targets it drops, which
 * must not show then.
 */
export function laterStartSteps(recipe: LoginRecipe): {
  variant: number;
  index: number;
  step: Extract<LoginStep, { kind: "fill" }>;
  partial?: true;
  absent?: LoginTarget[];
}[] {
  return passwordVariants(recipe).flatMap((variant, variantIndex) =>
    variant.steps.flatMap((step, index) => {
      if (step.kind !== "fill") return [];
      const whole =
        index > 0 && step.fields.some((field) => field.slot !== TOTP_HANDLER_SLOT)
          ? [{ variant: variantIndex, index, step }]
          : [];
      const partial = passwordOnly(step);
      if (!partial) return whole;
      const absent = step.fields
        .filter((field) => field.slot !== "password")
        .map((field) => field.target);
      return [
        ...whole,
        { variant: variantIndex, index, step: partial, partial: true as const, absent },
      ];
    }),
  );
}
/**
 * A `fill` step with only its password fields (ADR 0049), when it also fills an account
 * identifier, such as the username or a branch and account number; otherwise undefined.
 * A TOTP field it fills is dropped too.
 */
export function passwordOnly(
  step: Extract<LoginStep, { kind: "fill" }>,
): Extract<LoginStep, { kind: "fill" }> | undefined {
  const kept = step.fields.filter((field) => field.slot === "password");
  return kept.length > 0 &&
    step.fields.some((field) => field.slot !== "password" && field.slot !== TOTP_HANDLER_SLOT)
    ? { ...step, fields: kept }
    : undefined;
}
/**
 * Whether the recipe offers the route. A passkey-only recipe has no password route
 * (ADR 0053); every other recipe has it.
 */
export function recipeHasRoute(recipe: LoginRecipe, route: LoginRoute): boolean {
  return route === "passkey"
    ? recipe.passkey !== undefined
    : route === "password" && passwordVariants(recipe).length > 0;
}
/**
 * The route a new login takes (ADR 0027), in the owner's order: `passkey` when the item
 * holds a discoverable passkey and the recipe has the route's button, or the start page
 * asked for a passkey by itself (`pageRequest`, ADR 0034); otherwise, from whether the
 * item's binding fills each password variant in order (`fits[variant]`), the first
 * fitting variant, when the item has a password. Undefined means `no-route`, unless an
 * item without a password may take the `password` route up to its password, or to the end
 * of a route that fills none (`passwordStopOrMiss`, ADR 0036).
 */
// SSO (ADR 0026) comes between the passkey and password routes once it exists.
export function chooseLoginRoute(
  recipe: LoginRecipe,
  facts: Pick<LoginItemFacts, "password" | "discoverablePasskey">,
  fits: readonly boolean[],
  pageRequest = false,
): LoginRouteChoice | undefined {
  if ((recipe.passkey || pageRequest) && facts.discoverablePasskey) return { route: "passkey" };
  if (!facts.password) return undefined;
  const variant = passwordVariants(recipe).findIndex((_, index) => fits[index] === true);
  return variant === -1 ? undefined : { route: "password", variant };
}
/**
 * The route the item would take that the recipe lacks (ADR 0058 A), for a new login whose
 * plan found no route from the item's facts: `passkey` when the item holds a discoverable
 * passkey, the page is one the passkey scripts run on (`passkeyPage`, ADR 0050) and the
 * recipe has no passkey button; else `password` when the item holds a password and the
 * recipe has no `password` variant. A recipe generated again for the page may have that
 * route. A passkey that is not discoverable never counts.
 */
export function heldRouteMissing(
  recipe: LoginRecipe,
  facts: Pick<LoginItemFacts, "password" | "discoverablePasskey">,
  passkeyPage: boolean,
): LoginRoute | undefined {
  if (facts.discoverablePasskey && passkeyPage && !recipeHasRoute(recipe, "passkey"))
    return "passkey";
  if (facts.password && !recipeHasRoute(recipe, "password")) return "password";
  return undefined;
}
/**
 * Why a `password` login of an item without a password does not go on to a passkey (ADR
 * 0036), for the log: the item holds a password or no usable passkey (`no-passkey`), the
 * recipe has alternatives (`alternatives`), the route is not `password`, or it fills none
 * of `passwordSlots` and its last step does not advance (`no-password-step`), no `advance`
 * step comes before the first step that fills one (`no-advance`), or a step before the
 * stop fills one of `lacking` (`fills-lacking`).
 */
export type PasswordStopMiss =
  | "no-passkey"
  | "alternatives"
  | "no-password-step"
  | "no-advance"
  | "fills-lacking";
/**
 * Where a `password` login of an item without a password stops (ADR 0036), or why it takes
 * no route ({@link PasswordStopMiss}). The stop is the index of the route's first step that
 * fills one of `passwordSlots`, the slots its binding reads from the item's empty password.
 * A route that fills none of them and whose last step is an `advance`, as an
 * identifier-first recipe whose page after the identifier is not generated yet, stops
 * just past its last step: the stop is the route's step count. The login runs the steps
 * before the stop and never that step or a later one. It stops only when the item holds a
 * usable passkey, the recipe has no alternatives, an `advance` step comes before the stop,
 * and no step before it fills one of `lacking`, the slots whose values the item lacks. On
 * a chooser's route (`chooserRoute`, ADR 0028) its click on the list is that `advance`, and
 * the stop lies in or just past the branch the click leads to. The login's own scope, the
 * tab's top document, is the caller's to check.
 */
export function passwordStopOrMiss(
  recipe: LoginRecipe,
  choice: LoginRouteChoice,
  facts: Pick<LoginItemFacts, "password" | "passkey">,
  passwordSlots: readonly string[],
  lacking: readonly string[],
): { stop: number } | { miss: PasswordStopMiss } {
  if (facts.password || !facts.passkey) return { miss: "no-passkey" };
  if (recipe.alternatives) return { miss: "alternatives" };
  if (choice.route !== "password") return { miss: "no-password-step" };
  const steps = routeSteps(recipe, choice);
  const fills = (step: LoginStep, slots: readonly string[]) =>
    step.kind === "fill" && step.fields.some((field) => slots.includes(field.slot));
  const filling = steps.findIndex((step) => fills(step, passwordSlots));
  const last = steps.at(-1);
  const stop =
    filling === -1 && last !== undefined && loginStepEffect(last) === "advance"
      ? steps.length
      : filling;
  if (stop === -1) return { miss: "no-password-step" };
  const before = steps.slice(0, stop);
  if (!before.some((step) => loginStepEffect(step) === "advance")) return { miss: "no-advance" };
  return before.some((step) => fills(step, lacking)) ? { miss: "fills-lacking" } : { stop };
}
/**
 * The steps a handler runs: a `passkey` handler's click, a `password` handler's click that
 * advances to the password page (ADR 0048), an `authenticator` handler's click that
 * advances to the code page (ADR 0081), a `totp` handler's fill of the code into its
 * field, or a `detail` handler's fill of its field at `field`, every input of a split
 * value at once (ADR 0061), followed by the click on its submit button. A `totp` handler
 * without a button runs one fill that submits through the code's own input (ADR 0027
 * amendment of 2026-10-23): nothing is clicked.
 */
export function handlerSteps(handler: LoginHandler, field = 0): LoginStep[] {
  if (handler.kind === "totp") {
    const code = [{ slot: TOTP_HANDLER_SLOT, target: handler.field }];
    if (!handler.target)
      return [{ kind: "fill", path: handler.path, fields: code, effect: "submit", event: "input" }];
    return [
      { kind: "fill", path: handler.path, fields: code, effect: "prepare" },
      { kind: "click", path: handler.path, target: handler.target, purpose: "submit" },
    ];
  }
  const click: LoginStep = {
    kind: "click",
    path: handler.path,
    target: handler.target,
    purpose: handler.kind === "password" || handler.kind === "authenticator" ? "advance" : "submit",
  };
  if (handler.kind !== "detail") return [click];
  // A value split over several inputs fills them all in one step (ADR 0061).
  const fills = detailFieldInputs(handler.fields[field] ?? handler.fields[0]!).map(
    (input, index) => ({ slot: detailSlot(index), target: input.target }),
  );
  return [{ kind: "fill", path: handler.path, fields: fills, effect: "prepare" }, click];
}
/**
 * What the login's vault item holds (ADR 0027), read locally once when a login starts and
 * kept in its attempt. Facts are never sent to the service or a model.
 */
export const loginItemFactsSchema = v.strictObject({
  /** A non-empty password the account may fill. */
  password: v.boolean(),
  /** A TOTP secret the account may fill. */
  totp: v.boolean(),
  /** Any usable passkey for an RP ID the origin may use. */
  passkey: v.boolean(),
  /** A discoverable passkey among them; a key registered only as a second factor is not. */
  discoverablePasskey: v.boolean(),
});
export type LoginItemFacts = v.InferOutput<typeof loginItemFactsSchema>;
/**
 * The fact each handler kind requires. A `detail` handler requires none of the item's
 * own: it needs a linked value for one of its inputs, checked when it is entered (ADR
 * 0061).
 */
export const handlerFact = {
  passkey: "passkey",
  password: "password",
  totp: "totp",
  // It goes on to the code page: only a login that can type the item's TOTP presses it.
  authenticator: "totp",
  detail: undefined,
} as const satisfies Record<LoginHandler["kind"], keyof LoginItemFacts | undefined>;
/** The field a fill of `fieldId` reads: a Linked field's built-in source, or the field itself. */
export function loginFieldSource(item: Pick<VaultItemMetadata, "fields">, fieldId: string): string {
  const field = item.fields.find((entry) => entry.id === fieldId);
  return (field?.kind === "linked" ? field.linkedFieldId : undefined) ?? fieldId;
}
/**
 * The password and TOTP facts from the catalog's value-free `empty` flags and the
 * account's allowed (not excluded) field IDs. An allowed Linked field that reads the
 * built-in field counts like the built-in field.
 */
export function loginFieldFacts(
  item: Pick<VaultItemMetadata, "fields">,
  allowedFieldIds: readonly string[],
): Pick<LoginItemFacts, "password" | "totp"> {
  const has = (fieldId: string) =>
    allowedFieldIds.some((allowed) => loginFieldSource(item, allowed) === fieldId) &&
    item.fields.some((field) => field.id === fieldId && field.empty !== true);
  return { password: has("login.password"), totp: has("login.totp-code") };
}
/**
 * Whether `next` only adds to `previous` (ADR 0027): a newer revision of the same recipe and
 * layout (ADR 0060) whose routes and route steps are unchanged, and whose handlers and
 * signed-in markers extend the old ones in order. A revision that only changed another
 * layout of the recipe is one. A running login takes over only such a
 * revision, so its recorded steps and entered handlers keep their meaning.
 */
export function extendsRecipe(previous: LoginRecipe, next: LoginRecipe): boolean {
  if (
    next.id !== previous.id ||
    next.origin !== previous.origin ||
    next.layout !== previous.layout ||
    next.revision <= previous.revision
  )
    return false;
  const before = previous.handlers ?? [];
  const after = next.handlers ?? [];
  const markers = previous.completion ?? [];
  const nextMarkers = next.completion ?? [];
  // JSON drops the undefined members, so only the fixed parts are compared.
  const fixed = (recipe: LoginRecipe) => ({
    ...recipe,
    revision: undefined,
    handlers: undefined,
    completion: undefined,
  });
  return (
    canonicalJson(fixed(previous)) === canonicalJson(fixed(next)) &&
    after.length >= before.length &&
    before.every((handler, index) => canonicalJson(handler) === canonicalJson(after[index])) &&
    nextMarkers.length >= markers.length &&
    markers.every((marker, index) => canonicalJson(marker) === canonicalJson(nextMarkers[index]))
  );
}
/**
 * Whether `added` steps fill a slot that `steps` already fill. A later page appended to a
 * recipe never fills such a slot again (ADR 0018): a page that asks for the same account
 * again, such as the identifier form shown again with an error, is not a next page.
 */
export function refillsLoginSlot(
  steps: readonly LoginStep[],
  added: readonly LoginStep[],
): boolean {
  const filled = new Set(
    steps.flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.slot) : [])),
  );
  return added.some(
    (step) => step.kind === "fill" && step.fields.some((field) => filled.has(field.slot)),
  );
}
/**
 * Whether `next` continues `previous` on the page after its final `advance` step (ADR
 * 0018): a newer revision of the same recipe and layout (ADR 0060) whose steps are
 * `previous`'s steps followed by at least one more, none of which fills a slot
 * `previous`'s steps already fill. `previous` has no completion and no alternatives and
 * ends in an advance; `next` has no alternatives. The page kind (ADR 0035), the `passkey`
 * route and the rejection are unchanged, the handlers extend the old ones in order, the
 * account switch is unchanged or newly added, and signed-in markers may be new. A running
 * login at its final advance takes over only such a revision, so the steps it ran keep
 * their meaning. With `replacesLast`, `next`'s steps are `previous`'s without its final
 * `advance` click, then a page's steps that replace it (`replacesClick`, ADR 0018
 * amendment of 2026-11-03), since that click never ran.
 */
export function continuesRecipe(
  previous: LoginRecipe,
  next: LoginRecipe,
  { replacesLast = false }: { replacesLast?: boolean } = {},
): boolean {
  const last = previous.steps.at(-1);
  // With `replacesLast`, the page's steps take the place of `previous`'s last step.
  const kept = replacesLast ? previous.steps.slice(0, -1) : previous.steps;
  if (
    next.id !== previous.id ||
    next.origin !== previous.origin ||
    next.layout !== previous.layout ||
    next.revision <= previous.revision ||
    previous.completion !== undefined ||
    previous.alternatives !== undefined ||
    next.alternatives !== undefined ||
    !last ||
    loginStepEffect(last) !== "advance" ||
    next.steps.length <= kept.length ||
    (replacesLast && !replacesClick(last, next.steps.slice(kept.length)))
  )
    return false;
  const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  const before = previous.handlers ?? [];
  const after = next.handlers ?? [];
  return (
    kept.every((step, index) => same(step, next.steps[index])) &&
    !refillsLoginSlot(kept, next.steps.slice(kept.length)) &&
    previous.slots.every((slot) => next.slots.includes(slot)) &&
    next.maxSubmissions >= previous.maxSubmissions &&
    previous.pageKind === next.pageKind &&
    previous.passkeyOnly === next.passkeyOnly &&
    same(previous.passkey ?? null, next.passkey ?? null) &&
    same(previous.rejection ?? null, next.rejection ?? null) &&
    (previous.accountSwitch === undefined || same(previous.accountSwitch, next.accountSwitch)) &&
    after.length >= before.length &&
    before.every((handler, index) => same(handler, after[index]))
  );
}
/**
 * Whether `steps`, a continued page's, may replace the recipe's final `advance` click
 * `last` whose button stayed disabled while a password input opened (ADR 0018 amendment
 * of 2026-11-03): they fill the built-in `password` slot and click the same element as
 * `last` only as their last step, since a disabled button would stall them again.
 */
export function replacesClick(last: LoginStep, steps: readonly LoginStep[]): boolean {
  const end = steps.at(-1);
  return (
    last.kind === "click" &&
    end?.kind === "click" &&
    sameLoginTarget(end.target, last.target) &&
    steps
      .slice(0, -1)
      .every((step) => step.kind !== "click" || !sameLoginTarget(step.target, last.target)) &&
    steps.some(
      (step) => step.kind === "fill" && step.fields.some((field) => field.slot === "password"),
    )
  );
}
