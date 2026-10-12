import * as v from "valibot";
import {
  parseSiteUrl,
  resolveSiteAccount,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultItemMetadata,
} from "./settings";

export const loginIdentifierSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
const identifier = loginIdentifierSchema;
const revision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);
export const loginOriginSchema = v.pipe(
  v.string(),
  v.maxLength(300),
  v.check((value) => parseSiteUrl(value)?.origin === value, "Use an exact HTTP(S) origin"),
);
const path = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(300),
  v.regex(/^\/(?!\/)[^?#\\\s]*$/),
  v.check(
    (value) => new URL(value, "https://example.test").pathname === value,
    "Use an exact canonical path",
  ),
);
/** An exact canonical URL path, as recipe steps and observations carry it. */
export const loginPathSchema = path;
const unique = (values: string[]) => new Set(values).size === values.length;

/**
 * An attribute locator: the element whose `id`, `name` or `data-testid` equals the
 * value. `id` and `name` take any ASCII except whitespace and control characters, as
 * ASP.NET (`ctl00$Main$txtUserId`) and Rails (`user[login]`) names need; the executor
 * compares attribute strings, so the value never becomes a selector.
 */
export const loginAttributeTargetSchema = v.variant("by", [
  v.strictObject({
    by: v.picklist(["id", "name"]),
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(120), v.regex(/^[\x21-\x7e]+$/u)),
  }),
  v.strictObject({
    by: v.literal("test-id"),
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(120), v.regex(/^[a-zA-Z0-9_.:-]+$/)),
  }),
]);
/**
 * A button locator: the one button whose text equals the value. The text is a
 * `<button>`'s rendered text, an `<input type="submit|button">`'s value, an
 * `<input type="image">`'s alt, or the rendered text of an `<a>` that runs a script
 * instead of following a link (no `href` but an `onclick` or `role="button"`, a
 * `javascript:` URL, or an empty or fragment-only `href` with either), with whitespace
 * collapsed to single spaces and format characters removed. Native buttons are matched
 * first; such links only when no native button shows the text. It matches buttons only,
 * so fills never use it; a recipe's `accountSwitch` and completion target alone also
 * match another `<a href>` link by its rendered text (or an image-only link's `alt`)
 * when no button shows it.
 */
export const loginTextTargetSchema = v.strictObject({
  by: v.literal("text"),
  value: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(120),
    v.regex(/^[^\s\p{Cc}\p{Cf}]+(?: [^\s\p{Cc}\p{Cf}]+)*$/u),
  ),
});
/** An allowlisted element locator; recipes cannot supply CSS, code, URLs or values. */
export const loginTargetSchema = v.variant("by", [
  ...loginAttributeTargetSchema.options,
  loginTextTargetSchema,
]);
const fields = v.pipe(
  v.array(v.strictObject({ slot: identifier, target: loginAttributeTargetSchema })),
  v.minLength(1),
  v.maxLength(20),
  v.check((entries) => unique(entries.map((entry) => entry.slot)), "Duplicate fill slots"),
  v.check(
    (entries) => unique(entries.map((entry) => JSON.stringify(entry.target))),
    "Duplicate fill targets",
  ),
);
export const loginStepSchema = v.variant("kind", [
  v.pipe(
    v.strictObject({
      kind: v.literal("fill"),
      path,
      fields,
      effect: v.optional(v.picklist(["prepare", "advance", "submit"]), "prepare"),
      event: v.optional(v.picklist(["input", "change"])),
    }),
    v.check(
      (step) =>
        step.effect === "prepare"
          ? step.event === undefined
          : step.fields.length === 1 && step.event !== undefined,
      "Effectful fill requires one field and one trigger event",
    ),
  ),
  v.strictObject({
    kind: v.literal("click"),
    path,
    target: loginTargetSchema,
    purpose: v.picklist(["advance", "submit"]),
  }),
  v.strictObject({
    kind: v.literal("wait"),
    path,
    target: loginTargetSchema,
    present: v.boolean(),
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(15000)),
  }),
  v.strictObject({
    kind: v.literal("assert"),
    path,
    target: loginTargetSchema,
    present: v.boolean(),
  }),
]);
const stepTargetCount = (step: v.InferOutput<typeof loginStepSchema>) =>
  step.kind === "fill" ? step.fields.length : 1;
/**
 * Ways a start page offers to sign in (ADR 0027); one is chosen from the item's facts
 * when a login starts. `password` runs the recipe's steps; `passkey` clicks the start
 * page's passkey sign-in button.
 */
export const loginRouteSchema = v.picklist(["password", "passkey"]);
/**
 * A branch on the page that appears after an effect step (ADR 0027), entered when its
 * path matches and all its elements show, and run only for an item with the handler's
 * fact. Its steps follow from its kind. `passkey` clicks a button such as "Use security
 * key"; `totp` fills the item's TOTP code into `field` and clicks `target`, its submit
 * button.
 */
export const loginHandlerSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("passkey"), path, target: loginTargetSchema }),
  v.pipe(
    v.strictObject({
      kind: v.literal("totp"),
      path,
      field: loginAttributeTargetSchema,
      target: loginTargetSchema,
    }),
    v.check(
      (handler) =>
        handler.field.by !== handler.target.by || handler.field.value !== handler.target.value,
      "The code field cannot be its submit button",
    ),
  ),
]);
const handlerKey = (handler: v.InferOutput<typeof loginHandlerSchema>) =>
  `${handler.kind} ${handler.path}`;
const recipeSlotList = v.pipe(
  v.array(identifier),
  v.minLength(1),
  v.maxLength(20),
  v.check(unique, "Duplicate recipe slots"),
);
const routeStepList = v.pipe(v.array(loginStepSchema), v.minLength(1), v.maxLength(32));
/** At most 3 alternatives, so a password route has at most 4 variants (ADR 0027). */
export const MAX_PASSWORD_ALTERNATIVES = 3;
const stepEffects = (steps: readonly v.InferOutput<typeof loginStepSchema>[]) =>
  steps.filter(
    (step) => step.kind === "click" || (step.kind === "fill" && step.effect !== "prepare"),
  ).length;
const filledSlotsOf = (steps: readonly v.InferOutput<typeof loginStepSchema>[]) => [
  ...new Set(
    steps.flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.slot) : [])),
  ),
];
/** Variant 0 is the recipe's own `slots` and `steps`; the alternatives follow in order. */
const variantsOf = (recipe: {
  slots: string[];
  steps: v.InferOutput<typeof loginStepSchema>[];
  alternatives?: { slots: string[]; steps: v.InferOutput<typeof loginStepSchema>[] }[] | undefined;
}) => [{ slots: recipe.slots, steps: recipe.steps }, ...(recipe.alternatives ?? [])];
const targetKey = (target: v.InferOutput<typeof loginTargetSchema>) => JSON.stringify(target);
/**
 * Every element a handler uses, in the order its steps use them: a `totp` handler's code
 * field, then its button. The handler is entered only when all of them show (ADR 0027).
 */
export function handlerTargets(
  handler: v.InferOutput<typeof loginHandlerSchema>,
): v.InferOutput<typeof loginTargetSchema>[] {
  return handler.kind === "totp" ? [handler.field, handler.target] : [handler.target];
}
/** The `passkey` route's one step: a click on its button that submits. */
const passkeyStep = (passkey: {
  path: string;
  target: v.InferOutput<typeof loginTargetSchema>;
}): v.InferOutput<typeof loginStepSchema> => ({
  kind: "click",
  path: passkey.path,
  target: passkey.target,
  purpose: "submit",
});
export const loginRecipeSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    id: identifier,
    revision,
    origin: loginOriginSchema,
    /** The slots of the password route's first variant (variant 0). */
    slots: recipeSlotList,
    /** The password route's first variant (variant 0): its steps. */
    steps: routeStepList,
    /**
     * Further variants of the password route (ADR 0027), one per other identifier set the
     * start page offers, such as a contract number beside a branch and account number.
     * Each names the slots its fill steps use; the executor takes the first variant the
     * item's binding fills.
     */
    alternatives: v.optional(
      v.pipe(
        v.array(v.strictObject({ slots: recipeSlotList, steps: routeStepList })),
        v.minLength(1),
        v.maxLength(MAX_PASSWORD_ALTERNATIVES),
      ),
    ),
    /**
     * The `passkey` route (ADR 0027): the start page's button that signs in with a
     * discoverable passkey, such as "Sign in with a passkey". The route clicks it and fills
     * nothing; the passkey request it causes is answered by the bridge with the login's
     * own item.
     */
    passkey: v.optional(v.strictObject({ path, target: loginTargetSchema })),
    // A generated recipe has no completion until the page after its first sign-in is
    // judged (ADR 0018); until then no attempt with it can end authenticated.
    completion: v.optional(
      v.strictObject({
        path,
        target: loginTargetSchema,
        /**
         * Elements that must be missing as well, such as the sign-in fields of a page that
         * signs in on its own path. A learned completion lists them, so a login page that
         * still holds a hidden "Sign out" element never counts as signed in.
         */
        absent: v.optional(
          v.pipe(
            v.array(loginTargetSchema),
            v.minLength(1),
            v.maxLength(4),
            v.check(
              (targets) => unique(targets.map((target) => JSON.stringify(target))),
              "Duplicate absent targets",
            ),
          ),
        ),
      }),
    ),
    rejection: v.optional(loginTargetSchema),
    /**
     * The button or link that switches to another account, such as "Use another account"
     * on a password page for a remembered account. When a fill finds the page showing
     * another account than the selected one, the executor clicks it once and ends the
     * attempt, so a recipe that starts on the page it leads to can log in (owner
     * decision, 2026-10-11).
     */
    accountSwitch: v.optional(loginTargetSchema),
    /**
     * Second-factor pages learned from judged pages (ADR 0027), one per kind and path.
     * They are only ever appended, so a running login's entered handlers keep their index.
     */
    handlers: v.optional(
      v.pipe(
        v.array(loginHandlerSchema),
        v.minLength(1),
        v.maxLength(16),
        v.check((handlers) => unique(handlers.map(handlerKey)), "Duplicate handlers"),
      ),
    ),
    // Counts route steps only; an entered handler adds its own effects to the attempt.
    maxSubmissions: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
  }),
  v.check(
    (recipe) =>
      variantsOf(recipe).every((variant) =>
        variant.steps.every(
          (step) =>
            step.kind !== "fill" ||
            step.fields.every((field) => variant.slots.includes(field.slot)),
        ),
      ),
    "Unknown semantic slot",
  ),
  v.check(
    (recipe) =>
      variantsOf(recipe).every((variant) => stepEffects(variant.steps) <= recipe.maxSubmissions),
    "Effect attempt budget is too small",
  ),
  v.check(
    (recipe) =>
      variantsOf(recipe).every(({ steps }) =>
        steps.every(
          (step, index) =>
            step.kind !== "fill" ||
            step.effect === "prepare" ||
            !steps
              .slice(index + 1)
              .find((next) => next.path === step.path && next.kind === "click"),
        ),
      ),
    "Input-triggered effects cannot have a fallback click on the same path",
  ),
  // Variants are told apart by their slots, and every variant starts on the recipe's start
  // page. Each one submits, so a later page can never continue one variant of several.
  v.check(
    (recipe) =>
      !recipe.alternatives ||
      variantsOf(recipe).every(({ slots, steps }) => {
        const filled = filledSlotsOf(steps);
        return (
          filled.length === slots.length &&
          slots.every((slot) => filled.includes(slot)) &&
          steps[0]!.path === recipe.steps[0]!.path &&
          loginStepEffect(steps.at(-1)!) === "submit"
        );
      }),
    "Each variant fills exactly its slots, starts on the start path and submits",
  ),
  v.check(
    (recipe) =>
      variantsOf(recipe).every((variant, index, all) =>
        all.every(
          (other, otherIndex) =>
            otherIndex === index || !variant.slots.every((slot) => other.slots.includes(slot)),
        ),
      ),
    "A variant's slots repeat or are a subset of another variant's",
  ),
  // An element is filled as one slot whatever the variant, and no two variants fill the
  // same elements, so an ambiguous mapping never becomes two variants.
  v.check((recipe) => {
    if (!recipe.alternatives) return true;
    const filled = variantsOf(recipe).map(({ steps }) =>
      steps.flatMap((step) =>
        step.kind === "fill"
          ? step.fields.map((field) => ({
              key: `${step.path}\n${targetKey(field.target)}`,
              slot: field.slot,
            }))
          : [],
      ),
    );
    const slotOf = new Map<string, string>();
    for (const { key, slot } of filled.flat()) {
      if ((slotOf.get(key) ?? slot) !== slot) return false;
      slotOf.set(key, slot);
    }
    const keys = filled.map((entries) => new Set(entries.map((entry) => entry.key)));
    return keys.every((set, index) =>
      keys.every(
        (other, otherIndex) =>
          otherIndex === index ||
          set.size !== other.size ||
          [...set].some((key) => !other.has(key)),
      ),
    );
  }, "A fill target maps to several slots, or two variants fill the same targets"),
  // A binding covers one variant, and bindings hold at most 20 slots.
  v.check(
    (recipe) => new Set(variantsOf(recipe).flatMap((variant) => variant.slots)).size <= 20,
    "Too many recipe slots",
  ),
  // The executor checks the result elements and the next step's elements in one
  // observation of at most 24 elements.
  v.check(
    (recipe) =>
      Math.max(
        0,
        ...variantsOf(recipe).flatMap((variant) => variant.steps.map(stepTargetCount)),
        ...(recipe.passkey ? [stepTargetCount(passkeyStep(recipe.passkey))] : []),
      ) +
        (recipe.completion ? 1 + (recipe.completion.absent?.length ?? 0) : 0) +
        (recipe.rejection ? 1 : 0) <=
      24,
    "Too many result elements to observe with a step",
  ),
  // The switch is clicked instead of signing in, so it must not be a step's own button.
  v.check((recipe) => {
    if (!recipe.accountSwitch) return true;
    const key = targetKey(recipe.accountSwitch);
    return ![
      ...variantsOf(recipe).flatMap((variant) =>
        variant.steps.flatMap((step) => (step.kind === "click" ? [step.target] : [])),
      ),
      ...(recipe.handlers ?? []).flatMap(handlerTargets),
      ...(recipe.rejection ? [recipe.rejection] : []),
    ].some((target) => targetKey(target) === key);
  }, "Account switch target is a step or rejection target"),
  // The completion and rejection are checked after every step, so a variant's own element
  // must never prove or refuse the sign-in.
  v.check((recipe) => {
    if (!recipe.alternatives) return true;
    const used = variantsOf(recipe).flatMap((variant) =>
      variant.steps.flatMap((step) =>
        (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target]).map(
          (target) => ({ path: step.path, key: targetKey(target) }),
        ),
      ),
    );
    return (
      !used.some(
        (entry) =>
          recipe.completion &&
          entry.path === recipe.completion.path &&
          entry.key === targetKey(recipe.completion.target),
      ) && !used.some((entry) => recipe.rejection && entry.key === targetKey(recipe.rejection))
    );
  }, "Completion or rejection target is a variant's step target"),
  // A handler's element showing would otherwise prove the sign-in on its own page.
  v.check(
    (recipe) =>
      !recipe.completion ||
      !(recipe.handlers ?? []).some(
        (handler) =>
          handler.path === recipe.completion!.path &&
          handlerTargets(handler).some(
            (target) => targetKey(target) === targetKey(recipe.completion!.target),
          ),
      ),
    "Completion target is a handler target",
  ),
  // A `totp` handler types a code into a field of its own: never one a route step uses on
  // its path, such as the password input of a form that asks for the code after it.
  v.check(
    (recipe) =>
      !(recipe.handlers ?? []).some(
        (handler) =>
          handler.kind === "totp" &&
          variantsOf(recipe).some((variant) =>
            variant.steps.some(
              (step) =>
                step.path === handler.path &&
                (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target])
                  .map(targetKey)
                  .includes(targetKey(handler.field)),
            ),
          ),
      ),
    "The code field is a route step target",
  ),
  // The passkey route starts on the start page, beside the password route.
  v.check(
    (recipe) => !recipe.passkey || recipe.passkey.path === recipe.steps[0]!.path,
    "The passkey route must start on the start path",
  ),
  // Its button is an element of its own: no password variant's step uses it on the start
  // page, and it never switches the account, proves or refuses the sign-in, or answers a
  // handler there.
  v.check((recipe) => {
    const { passkey } = recipe;
    if (!passkey) return true;
    const key = targetKey(passkey.target);
    const onPath = (entries: { path: string; target: v.InferOutput<typeof loginTargetSchema> }[]) =>
      entries.some((entry) => entry.path === passkey.path && targetKey(entry.target) === key);
    return (
      !onPath(
        variantsOf(recipe).flatMap((variant) =>
          variant.steps.flatMap((step) =>
            (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target]).map(
              (target) => ({ path: step.path, target }),
            ),
          ),
        ),
      ) &&
      !onPath(
        (recipe.handlers ?? []).flatMap((handler) =>
          handlerTargets(handler).map((target) => ({ path: handler.path, target })),
        ),
      ) &&
      !onPath(recipe.completion ? [recipe.completion] : []) &&
      ![recipe.accountSwitch, recipe.rejection].some(
        (target) => target !== undefined && targetKey(target) === key,
      )
    );
  }, "Passkey target is a step, handler, completion, rejection or account switch target"),
);
export const loginAccountSchema = v.strictObject({
  origin: loginOriginSchema,
  connectionId: identifier,
  itemId: identifier,
});
/**
 * The fields one login reads, resolved on this device. A login on the `passkey` route
 * fills nothing, so its binding has no slots (ADR 0027); a synced binding always has some.
 */
export const loginAccountBindingSchema = v.strictObject({
  ...loginAccountSchema.entries,
  slots: v.pipe(
    v.array(v.strictObject({ slot: identifier, fieldId: identifier })),
    v.maxLength(20),
    v.check((entries) => unique(entries.map((entry) => entry.slot)), "Duplicate binding slots"),
  ),
});
export const loginDocumentSchema = v.strictObject({
  origin: loginOriginSchema,
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  frameId: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  documentId: identifier,
});
export const loginOperationSchema = v.strictObject({
  version: v.literal(1),
  attemptId: identifier,
  operationId: identifier,
  policyRevision: revision,
  expiresAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  document: loginDocumentSchema,
  // Route steps (at most 32) and the steps of handlers entered during the attempt.
  stepIndex: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(39)),
  step: loginStepSchema,
});
export const loginOutcomeSchema = v.picklist([
  "authenticated",
  "credential-rejected",
  "challenge",
  "unknown-submit",
  "interrupted",
  "structural-mismatch",
  "timeout",
  "retry-limit",
  "submission-limit",
  "policy-changed",
  "cancelled",
  // The page shows a different account than the one selected; nothing was filled.
  "wrong-account",
  // As "wrong-account", and the recipe's account switch was clicked.
  "account-switched",
  // A value does not fit its input (ADR 0010 `valueMismatch`); nothing was filled.
  "value-mismatch",
  // After a preparing fill the page marked a filled input invalid or showed a new alert;
  // nothing was clicked (ADR 0010).
  "fill-rejected",
  // The tab's page moved to another origin after a possible submission; its result there
  // cannot be observed.
  "left-origin",
]);

export type LoginTarget = v.InferOutput<typeof loginTargetSchema>;
/** Whether two locators name the same element. */
export const sameLoginTarget = (left: LoginTarget, right: LoginTarget) =>
  left.by === right.by && left.value === right.value;
export type LoginAttributeTarget = v.InferOutput<typeof loginAttributeTargetSchema>;
export type LoginStep = v.InferOutput<typeof loginStepSchema>;
export type LoginEffect = "prepare" | "advance" | "submit";
export function loginStepEffect(step: LoginStep): LoginEffect | undefined {
  return step.kind === "fill" ? step.effect : step.kind === "click" ? step.purpose : undefined;
}
export type LoginRecipe = v.InferOutput<typeof loginRecipeSchema>;
export type LoginRoute = v.InferOutput<typeof loginRouteSchema>;
export type LoginHandler = v.InferOutput<typeof loginHandlerSchema>;

/**
 * One way through a route, as the executor records it when a login starts (ADR 0027).
 * `variant` indexes the password route's variants: 0 is the recipe's own `slots` and
 * `steps`, 1 to 3 its `alternatives`. The `passkey` route has no variants.
 */
// The `sso` route of ADR 0027 adds its own member here.
export type LoginRouteChoice = { route: "password"; variant: number } | { route: "passkey" };
/** One identifier set of the password route: the slots it fills and its steps. */
export type PasswordVariant = { slots: string[]; steps: LoginStep[] };
/** The password route's variants in order: the recipe's own, then its alternatives. */
export function passwordVariants(recipe: LoginRecipe): PasswordVariant[] {
  return variantsOf(recipe);
}
/** The chosen route's steps, or none when the recipe lacks it. */
export function routeSteps(recipe: LoginRecipe, choice: LoginRouteChoice): LoginStep[] {
  if (choice.route === "passkey") return recipe.passkey ? [passkeyStep(recipe.passkey)] : [];
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
/** Every path a route's steps use, over all its variants, each once. */
export function routePaths(recipe: LoginRecipe, route: LoginRoute): string[] {
  if (route === "passkey") return recipe.passkey ? [recipe.passkey.path] : [];
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
 * again after the click is still the sign-in page, not a page to learn from.
 */
export function routeSignInTargets(recipe: LoginRecipe, route: LoginRoute): LoginTarget[] {
  if (route === "passkey" && !recipe.passkey) return [];
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
  if (route !== "passkey" || !recipe.passkey) return routePaths(recipe, route);
  return [...new Set([recipe.passkey.path, ...routePaths(recipe, "password")])];
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
 * Whether the recipe offers the route; every recipe has the `password` route, since a
 * start page without a password input is never generated (ADR 0016).
 */
export function recipeHasRoute(recipe: LoginRecipe, route: LoginRoute): boolean {
  return route === "passkey"
    ? recipe.passkey !== undefined
    : route === "password" && passwordVariants(recipe).length > 0;
}
/**
 * The route a new login takes (ADR 0027), in the owner's order: `passkey` when the recipe
 * has it and the item holds a discoverable passkey; otherwise, from whether the item's
 * binding fills each password variant in order (`fits[variant]`), the first fitting
 * variant, when the item has a password. Undefined means `no-route`.
 */
// SSO (ADR 0026) comes between the passkey and password routes once it exists.
export function chooseLoginRoute(
  recipe: LoginRecipe,
  facts: Pick<LoginItemFacts, "password" | "discoverablePasskey">,
  fits: readonly boolean[],
): LoginRouteChoice | undefined {
  if (recipe.passkey && facts.discoverablePasskey) return { route: "passkey" };
  if (!facts.password) return undefined;
  const variant = passwordVariants(recipe).findIndex((_, index) => fits[index] === true);
  return variant === -1 ? undefined : { route: "password", variant };
}
/** The slot a `totp` handler's fill uses; a binding for it reads the item's TOTP field. */
export const TOTP_HANDLER_SLOT = "totp";
/**
 * The steps a handler runs: a `passkey` handler's click, or a `totp` handler's fill of the
 * code into its field followed by the click on its submit button.
 */
export function handlerSteps(handler: LoginHandler): LoginStep[] {
  const click: LoginStep = {
    kind: "click",
    path: handler.path,
    target: handler.target,
    purpose: "submit",
  };
  if (handler.kind === "passkey") return [click];
  return [
    {
      kind: "fill",
      path: handler.path,
      fields: [{ slot: TOTP_HANDLER_SLOT, target: handler.field }],
      effect: "prepare",
    },
    click,
  ];
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
/** The fact each handler kind requires. */
export const handlerFact = { passkey: "passkey", totp: "totp" } as const satisfies Record<
  LoginHandler["kind"],
  keyof LoginItemFacts
>;
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
 * Whether `next` only adds to `previous` (ADR 0027): a newer revision of the same recipe
 * whose routes and route steps are unchanged, whose handlers extend the old ones in order,
 * and whose completion is new or unchanged. A running login takes over only such a
 * revision, so its recorded steps and entered handlers keep their meaning.
 */
export function extendsRecipe(previous: LoginRecipe, next: LoginRecipe): boolean {
  if (
    next.id !== previous.id ||
    next.origin !== previous.origin ||
    next.revision <= previous.revision
  )
    return false;
  const before = previous.handlers ?? [];
  const after = next.handlers ?? [];
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
    (previous.completion === undefined ||
      canonicalJson(previous.completion) === canonicalJson(next.completion))
  );
}
/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : entry,
  );
}
export type LoginAccount = v.InferOutput<typeof loginAccountSchema>;
export type LoginAccountBinding = v.InferOutput<typeof loginAccountBindingSchema>;
export type LoginDocument = v.InferOutput<typeof loginDocumentSchema>;
export type LoginOperation = v.InferOutput<typeof loginOperationSchema>;
export type LoginOutcome = v.InferOutput<typeof loginOutcomeSchema>;
export const parseLoginRecipe = (value: unknown): LoginRecipe => v.parse(loginRecipeSchema, value);
export const parseLoginOperation = (value: unknown): LoginOperation =>
  v.parse(loginOperationSchema, value);
export const parseLoginAccountBinding = (value: unknown): LoginAccountBinding =>
  v.parse(loginAccountBindingSchema, value);
export const parseLoginDocument = (value: unknown): LoginDocument =>
  v.parse(loginDocumentSchema, value);

export function sameLoginDocument(left: LoginDocument, right: LoginDocument): boolean {
  return (
    left.origin === right.origin &&
    left.tabId === right.tabId &&
    left.frameId === right.frameId &&
    left.documentId === right.documentId
  );
}

/**
 * Policy selects one saved account before any recipe or field lookup. No fallback. The
 * binding covers exactly `slots`, the slots of the route the login takes (ADR 0027).
 */
export function resolveLoginPlan(
  snapshot: SettingsSnapshot,
  catalog: VaultCatalog,
  url: string,
  recipeValue: unknown,
  bindingValue: unknown,
  slots: readonly string[],
) {
  const account = resolveSiteAccount(snapshot.settings, catalog, url);
  if (!account.ok) return account;
  const recipe = v.safeParse(loginRecipeSchema, recipeValue);
  if (!recipe.success) return { ok: false as const, reason: "invalid-recipe" as const };
  if (recipe.output.origin !== account.origin)
    return { ok: false as const, reason: "recipe-origin-mismatch" as const };
  const binding = v.safeParse(loginAccountBindingSchema, bindingValue);
  if (!binding.success) return { ok: false as const, reason: "invalid-binding" as const };
  if (
    binding.output.origin !== account.origin ||
    binding.output.connectionId !== account.connectionId ||
    binding.output.itemId !== account.itemId
  )
    return { ok: false as const, reason: "binding-account-mismatch" as const };
  if (
    binding.output.slots.length !== slots.length ||
    !slots.every((slot) => binding.output.slots.some((entry) => entry.slot === slot))
  )
    return { ok: false as const, reason: "binding-slots-mismatch" as const };
  if (!binding.output.slots.every((entry) => account.fieldIds.includes(entry.fieldId)))
    return { ok: false as const, reason: "binding-field-excluded" as const };
  return { ok: true as const, account, recipe: recipe.output, binding: binding.output };
}
