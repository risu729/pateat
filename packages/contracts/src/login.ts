import * as v from "valibot";
import {
  parseSiteUrl,
  recipeSlotIdSchema,
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
 * `autocomplete` tokens an input can be located by. `new-password` is left out: a
 * recipe never names a field for a new password. `webauthn` marks the field a passkey
 * fills, which tells it from another field with the same first token, such as a hidden
 * copy of the password field.
 */
export const loginAutocompleteTokens = [
  "username",
  "email",
  "current-password",
  "one-time-code",
  "webauthn",
] as const;
/**
 * An attribute locator: the element whose `id`, `name` or `data-testid` equals the
 * value, or the `<input>` whose `autocomplete` attribute holds the token among its
 * whitespace-separated tokens, ignoring case (for fields with no `id` or `name`, such as
 * `autocomplete="username webauthn"`). `id` and `name` take any ASCII except whitespace
 * and control characters, as ASP.NET (`ctl00$Main$txtUserId`) and Rails (`user[login]`)
 * names need; the executor compares attribute strings, so the value never becomes a
 * selector.
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
  v.strictObject({ by: v.literal("autocomplete"), value: v.picklist(loginAutocompleteTokens) }),
]);
/**
 * A button locator: the one button whose text equals the value. The text is a
 * `<button>`'s rendered text, an `<input type="submit|button">`'s value, an
 * `<input type="image">`'s alt, or the rendered text of an `<a>` that runs a script
 * instead of following a link (no `href` but an `onclick` or `role="button"`, a
 * `javascript:` URL, or an empty or fragment-only `href` with either), with whitespace
 * collapsed to single spaces and format characters removed. Native buttons are matched
 * first; such links only when no native button shows the text. It matches buttons only,
 * so fills never use it; a recipe's `accountSwitch` and completion markers alone also
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
/**
 * A field locator by its visible name (ADR 0037): the one shown fillable `<input>` (text,
 * email, tel, number or password) whose name equals the value. The name is the rendered
 * text of the elements its `aria-labelledby` names, else of its `<label>` elements, else
 * its `aria-label`, else its `placeholder`, the first that is not empty, with whitespace
 * collapsed to single spaces and format characters removed, and at most 120 characters.
 * It names fields only, for a field with no unique `id`, `name`, `data-testid` or
 * `autocomplete` locator but a stable one; hidden inputs never match. A control is named
 * by its accessible name with {@link loginAccessibleNameTargetSchema} instead, which is
 * counted apart, so a button and a field with the same name never make either ambiguous.
 */
export const loginLabelTargetSchema = v.strictObject({
  by: v.literal("label"),
  value: loginTextTargetSchema.entries.value,
});
/**
 * A control locator by its accessible name (ADR 0048 amendment of 2026-10-19): the one
 * shown control whose name equals the value. The name is the rendered text of the
 * elements its `aria-labelledby` names, else its `aria-label`, the first that is not
 * empty, with whitespace collapsed to single spaces and format characters removed, and
 * at most 120 characters. A control is a button or a script button, as a text locator
 * matches them, or a link to a fragment of its own document that opens in the same tab
 * and downloads nothing (`<a href="#">`); fields never match. It names only a `password`
 * handler's button, such as `<a href="#" aria-label="Select Password.">Select</a>` beside
 * another "Select" for a phone, when no `id`, `name`, `data-testid` or unique text names
 * it: route steps, the `passkey` route, other handlers, signed-in markers, the rejection
 * and the account switch never use it.
 */
export const loginAccessibleNameTargetSchema = v.strictObject({
  by: v.literal("accessible-name"),
  value: loginTextTargetSchema.entries.value,
});
/** A locator a fill names its field by: an attribute one, or the field's visible name. */
export const loginFieldTargetSchema = v.variant("by", [
  ...loginAttributeTargetSchema.options,
  loginLabelTargetSchema,
]);
/**
 * An allowlisted element locator; recipes cannot supply CSS, code, URLs or values. A recipe
 * uses an accessible-name locator only for a `password` handler's button.
 */
export const loginTargetSchema = v.variant("by", [
  ...loginAttributeTargetSchema.options,
  loginTextTargetSchema,
  loginLabelTargetSchema,
  loginAccessibleNameTargetSchema,
]);
/**
 * A signed-in marker's link locator (ADR 0029): the one `<a href>` link to the page's own
 * origin whose path equals the value, such as an account link to `/my` whose text is the
 * person's nickname (owner's choice, 2026-10-13). Letters, `-`, `.`, `_`, `~` and `/`
 * only, so the path never carries a number, an ID or a percent-encoded name; the link's
 * query and fragment are not compared. Only completion markers use it.
 */
export const loginLinkTargetSchema = v.strictObject({
  by: v.literal("href"),
  value: v.pipe(v.string(), v.maxLength(120), v.regex(/^(?:\/[A-Za-z._~-]+)+\/?$/u)),
});
/** A signed-in marker's locator: any element locator, or a link by its path. */
export const loginMarkerTargetSchema = v.variant("by", [
  ...loginTargetSchema.options,
  loginLinkTargetSchema,
]);
const fields = v.pipe(
  v.array(v.strictObject({ slot: recipeSlotIdSchema, target: loginFieldTargetSchema })),
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
  v.pipe(
    v.strictObject({
      kind: v.literal("click"),
      path,
      target: loginTargetSchema,
      purpose: v.picklist(["advance", "submit"]),
      /**
       * For a form that shows no button to press (ADR 0064): the target is the field the
       * fill just before typed last, and the step submits that field's form as pressing
       * Enter there does instead of clicking anything.
       */
      press: v.optional(v.literal("enter")),
    }),
    v.check(
      (step) =>
        step.press === undefined ||
        (step.target.by !== "text" && step.target.by !== "accessible-name"),
      "Enter is pressed in a field",
    ),
  ),
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
 * button; `password` clicks a button such as "Password" on a page that asks how to
 * confirm the sign-in, which goes on to typing the password (ADR 0048).
 */
export const loginHandlerSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("passkey"), path, target: loginTargetSchema }),
  v.strictObject({ kind: v.literal("password"), path, target: loginTargetSchema }),
  v.pipe(
    v.strictObject({
      kind: v.literal("totp"),
      path,
      field: loginFieldTargetSchema,
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
  v.array(recipeSlotIdSchema),
  v.minLength(1),
  v.maxLength(20),
  v.check(unique, "Duplicate recipe slots"),
);
const routeStepList = v.pipe(
  v.array(loginStepSchema),
  v.minLength(1),
  v.maxLength(32),
  // Enter goes into the field the fill just before typed last, never a code (ADR 0064).
  v.check(
    (steps) =>
      steps.every((step, index) => {
        if (step.kind !== "click" || step.press === undefined) return true;
        const before = steps[index - 1];
        const last = before?.kind === "fill" ? before.fields.at(-1) : undefined;
        return (
          before?.kind === "fill" &&
          before.effect === "prepare" &&
          before.path === step.path &&
          last !== undefined &&
          last.slot !== TOTP_HANDLER_SLOT &&
          sameLoginTarget(last.target, step.target)
        );
      }),
    "Enter is pressed only in the field the fill before typed last",
  ),
);
/** At most 3 alternatives, so a password route has at most 4 variants (ADR 0027). */
export const MAX_PASSWORD_ALTERNATIVES = 3;
/** A recipe learns at most four signed-in markers (ADR 0029). */
export const MAX_COMPLETION_MARKERS = 4;
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
const targetKey = (target: v.InferOutput<typeof loginMarkerTargetSchema>) => JSON.stringify(target);
/** The elements a recipe's markers name: each marker and the elements it needs missing. */
const completionTargetCount = (
  markers: readonly { absent?: readonly unknown[] | undefined }[] | undefined,
) => (markers ?? []).reduce((count, marker) => count + 1 + (marker.absent?.length ?? 0), 0);
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
    slots: v.pipe(
      v.array(recipeSlotIdSchema),
      v.maxLength(20),
      v.check(unique, "Duplicate recipe slots"),
    ),
    /** A button-only start page: no password route or fallback (ADR 0053). */
    passkeyOnly: v.optional(v.literal(true)),
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
    /**
     * The signed-in markers (ADR 0029): elements the judge picked on signed-in pages, in
     * the order they were learned, each proving a sign-in on any path of the origin it was
     * learned on. A generated recipe has none until the page after its first sign-in is
     * judged (ADR 0018); until then only the sign-in state of ADR 0029 completes a login. A
     * later page the judge answers `signed-in` for adds its marker, up to four.
     */
    completion: v.optional(
      v.pipe(
        v.array(
          v.strictObject({
            target: loginMarkerTargetSchema,
            /**
             * Another origin the marker was learned on (ADR 0022): the page a `password`
             * login's tab moved to right after the submission, of the recipe's site or,
             * after a second factor, of another site. Such a
             * marker proves a sign-in only on a page of that origin the tab moved to; one
             * without proves it on the recipe's own origin.
             */
            origin: v.optional(loginOriginSchema),
            /**
             * Elements that must be missing as well, even hidden, such as the sign-in
             * fields of a page that signs in on its own path, where the marker was learned.
             * A login page that still holds a hidden "Sign out" element then never counts
             * as signed in.
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
        v.minLength(1),
        v.maxLength(MAX_COMPLETION_MARKERS),
        v.check(
          (markers) =>
            unique(markers.map((marker) => JSON.stringify([marker.origin ?? "", marker.target]))),
          "Duplicate completion markers",
        ),
      ),
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
     * Second-factor pages learned from judged pages (ADR 0027), and pages that ask how to
     * confirm the sign-in before the password (ADR 0048), one per kind and path.
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
    (recipe) => recipe.passkeyOnly === true || recipe.slots.length > 0,
    "A recipe has at least one slot",
  ),
  v.check(
    (recipe) =>
      !recipe.passkeyOnly ||
      (recipe.slots.length === 0 &&
        recipe.alternatives === undefined &&
        recipe.passkey !== undefined &&
        recipe.steps.length === 1 &&
        recipe.steps[0]!.kind === "click" &&
        recipe.steps[0]!.purpose === "submit" &&
        recipe.steps[0]!.path === recipe.passkey.path &&
        sameLoginTarget(recipe.steps[0]!.target, recipe.passkey.target) &&
        recipe.maxSubmissions === 1),
    "A passkey-only recipe has only its passkey submit",
  ),
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
        completionTargetCount(recipe.completion) +
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
  // The markers and the rejection are checked after every step, on any path, so a
  // variant's own element must never prove or refuse the sign-in. A marker proves it
  // wherever it shows (ADR 0029), so even a single variant's step never uses one; its
  // rejection on its own elements is left to the recipe's author.
  v.check((recipe) => {
    const used = new Set(
      variantsOf(recipe).flatMap((variant) =>
        variant.steps.flatMap((step) =>
          (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target]).map(
            targetKey,
          ),
        ),
      ),
    );
    return (
      !(recipe.completion ?? []).some((marker) => used.has(targetKey(marker.target))) &&
      !(recipe.alternatives && recipe.rejection && used.has(targetKey(recipe.rejection)))
    );
  }, "Completion or rejection target is a variant's step target"),
  // A marker of the recipe's own origin names none.
  v.check(
    (recipe) => !(recipe.completion ?? []).some((marker) => marker.origin === recipe.origin),
    "Completion marker names the recipe's own origin",
  ),
  // A handler's element showing would otherwise prove the sign-in on its own page.
  v.check((recipe) => {
    const markers = new Set((recipe.completion ?? []).map((marker) => targetKey(marker.target)));
    return !(recipe.handlers ?? []).some((handler) =>
      handlerTargets(handler).some((target) => markers.has(targetKey(target))),
    );
  }, "Completion target is a handler target"),
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
  // A `password` handler's button leads to the password a route step types: it is never a
  // route step's own element on its path (ADR 0048).
  v.check(
    (recipe) =>
      !(recipe.handlers ?? []).some(
        (handler) =>
          handler.kind === "password" &&
          variantsOf(recipe).some((variant) =>
            variant.steps.some(
              (step) =>
                step.path === handler.path &&
                (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target])
                  .map(targetKey)
                  .includes(targetKey(handler.target)),
            ),
          ),
      ),
    "A password handler's button is a route step target",
  ),
  // A control named by its accessible name is only ever a `password` handler's button
  // (ADR 0048 amendment of 2026-10-19), never another element the executor presses or
  // checks.
  v.check(
    (recipe) =>
      ![
        ...variantsOf(recipe).flatMap((variant) =>
          variant.steps.flatMap((step) => (step.kind === "fill" ? [] : [step.target])),
        ),
        ...(recipe.passkey ? [recipe.passkey.target] : []),
        ...(recipe.completion ?? []).flatMap((marker) => [marker.target, ...(marker.absent ?? [])]),
        ...(recipe.rejection ? [recipe.rejection] : []),
        ...(recipe.accountSwitch ? [recipe.accountSwitch] : []),
        ...(recipe.handlers ?? []).flatMap((handler) =>
          handler.kind === "password" ? [] : handlerTargets(handler),
        ),
      ].some((target) => target.by === "accessible-name"),
    "Only a password handler's button is named by its accessible name",
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
        (recipe.passkeyOnly ? [] : variantsOf(recipe)).flatMap((variant) =>
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
      ![
        recipe.accountSwitch,
        recipe.rejection,
        ...(recipe.completion ?? []).map((marker) => marker.target),
      ].some((target) => target !== undefined && targetKey(target) === key)
    );
  }, "Passkey target is a step, handler, completion, rejection or account switch target"),
);
/**
 * A recipe whose only member is `entry` (ADR 0031): the start path of a page without a
 * login form, and the control there that opens the site's login page, such as "Login" on
 * a top page the site sent the visitor to before signing in. It has no slots, steps,
 * submission budget or login route members, reads no vault field and never gains steps.
 * Only an `<a href>` link is to be pressed, which a `text` target names by its rendered
 * text as an `accountSwitch` does; its target is an `id`, `name`, `test-id` or `text`
 * locator, never `autocomplete` or `label`, which name only inputs, nor `accessible-name`,
 * which names only a `password` handler's button.
 *
 * The service generates it for an entry request (`entryGenerationRequestSchema`) and
 * stores it; devices cache it, but nothing sends such a request or presses it yet, it
 * starts no login and its path is not a path where a login recipe starts.
 */
export const loginEntryRecipeSchema = v.strictObject({
  version: v.literal(1),
  id: identifier,
  revision,
  origin: loginOriginSchema,
  entry: v.strictObject({
    path,
    // A link or button locator; `autocomplete` and `label` name only inputs, which are never
    // pressed, and `accessible-name` only a `password` handler's button.
    target: v.variant("by", [
      loginAttributeTargetSchema.options[0],
      loginAttributeTargetSchema.options[1],
      loginTextTargetSchema,
    ]),
  }),
});
/**
 * A list control's locator: never `autocomplete` or `label`, which name only inputs, nor
 * `accessible-name`, which names only a `password` handler's button.
 */
const chooserTargetSchema = v.variant("by", [
  loginAttributeTargetSchema.options[0],
  loginAttributeTargetSchema.options[1],
  loginTextTargetSchema,
]);
/**
 * A recipe that starts on a page listing accounts to choose from (ADR 0028), such as
 * Cloudflare's saved profiles: `chooser.path` is where the list shows. `other` is the
 * button that continues without a listed account ("Sign in with another profile"), and
 * `continue` the one that continues with the one account a page shows beside it ("Log
 * back in" on Wise). The entry to click is never stored: it is found on the page from
 * the chosen item's username each time.
 *
 * Each branch is the route recipe for the page the click leads to, after a listed or
 * shown account (`afterAccount`) or after `other` (`afterOther`), under the chooser's own
 * ID, origin and revision. A branch is absent until a login takes it and its page is
 * generated as an ADR 0018 continuation.
 *
 * A login on the list runs `chooserRoute` for what it clicks there.
 */
export const loginChooserRecipeSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    id: identifier,
    revision,
    origin: loginOriginSchema,
    chooser: v.strictObject({
      path,
      other: v.optional(chooserTargetSchema),
      continue: v.optional(chooserTargetSchema),
      afterAccount: v.optional(loginRecipeSchema),
      afterOther: v.optional(loginRecipeSchema),
    }),
  }),
  v.check(
    ({ id, revision: current, origin, chooser }) =>
      [chooser.afterAccount, chooser.afterOther].every(
        (branch) =>
          !branch || (branch.id === id && branch.revision === current && branch.origin === origin),
      ),
    "A chooser branch has the chooser's ID, revision and origin",
  ),
  v.check(
    ({ chooser }) =>
      !chooser.other ||
      !chooser.continue ||
      JSON.stringify(chooser.other) !== JSON.stringify(chooser.continue),
    "The chooser's other and continue buttons differ",
  ),
  v.check(
    ({ chooser }) => !chooser.afterOther || chooser.other !== undefined,
    "A chooser has an other-account branch only with its button",
  ),
);
/**
 * Any recipe the service stores and devices sync: a recipe with a login route
 * (`loginRecipeSchema`, which every login runs), an entry recipe (ADR 0031) or a chooser
 * recipe (ADR 0028). Strict objects keep them apart, so `entry` or `chooser` is never
 * beside `slots`, `steps` or another login route member.
 */
export const storedLoginRecipeSchema = v.union([
  loginRecipeSchema,
  loginEntryRecipeSchema,
  loginChooserRecipeSchema,
]);
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
    v.array(v.strictObject({ slot: recipeSlotIdSchema, fieldId: identifier })),
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
  // A chooser's list shows no account that fits the login's own, and has no button for
  // another account; nothing was clicked (ADR 0028).
  "account-not-listed",
  // A watched login that never signed in (ADR 0027): the recipe's first step showed again
  // in a new page, as after a code or an approval expired; not a logout (ADR 0021 D).
  // `challenge-abandoned` for a login stopped at `challenge`, `watch-abandoned` for one
  // whose result settled as unknown.
  "challenge-abandoned",
  "watch-abandoned",
]);

export type LoginTarget = v.InferOutput<typeof loginTargetSchema>;
export type LoginMarkerTarget = v.InferOutput<typeof loginMarkerTargetSchema>;
/** Whether a locator may name a step's or a handler's element: any but a link's path. */
export const isLoginTarget = (target: LoginMarkerTarget): target is LoginTarget =>
  target.by !== "href";
/**
 * Whether a locator may name a route step's element, or a handler's other than a
 * `password` handler's button: neither a link's path (ADR 0029) nor an accessible name
 * (ADR 0048 amendment of 2026-10-19).
 */
export const isStepTarget = (
  target: LoginMarkerTarget,
): target is Exclude<LoginTarget, { by: "accessible-name" }> =>
  target.by !== "href" && target.by !== "accessible-name";
/** Whether two locators name the same element. */
export const sameLoginTarget = (left: LoginMarkerTarget, right: LoginMarkerTarget) =>
  left.by === right.by && left.value === right.value;
export type LoginAttributeTarget = v.InferOutput<typeof loginAttributeTargetSchema>;
export type LoginFieldTarget = v.InferOutput<typeof loginFieldTargetSchema>;
export type LoginStep = v.InferOutput<typeof loginStepSchema>;
export type LoginEffect = "prepare" | "advance" | "submit";
export function loginStepEffect(step: LoginStep): LoginEffect | undefined {
  return step.kind === "fill" ? step.effect : step.kind === "click" ? step.purpose : undefined;
}
export type LoginRecipe = v.InferOutput<typeof loginRecipeSchema>;
export type LoginEntryRecipe = v.InferOutput<typeof loginEntryRecipeSchema>;
export type LoginChooserRecipe = v.InferOutput<typeof loginChooserRecipeSchema>;
export type StoredLoginRecipe = v.InferOutput<typeof storedLoginRecipeSchema>;
/** Whether a stored recipe has a login route: its own `steps`. */
export const isLoginRouteRecipe = (recipe: StoredLoginRecipe): recipe is LoginRecipe =>
  "steps" in recipe;
/**
 * The path a stored recipe starts on: its entry's (ADR 0031), its chooser's (ADR 0028)
 * or its first step's. The service keeps one generated recipe per origin and start path
 * either way. Each kind of stored recipe is named, so a new kind has to say where it
 * starts.
 */
export function storedRecipeStartPath(recipe: StoredLoginRecipe): string {
  if ("entry" in recipe) return recipe.entry.path;
  if ("chooser" in recipe) return recipe.chooser.path;
  if ("steps" in recipe) return recipe.steps[0]!.path;
  const unknown: never = recipe;
  throw new Error(`Unknown stored recipe kind: ${JSON.stringify(unknown)}`);
}
/**
 * A branch of a chooser recipe (ADR 0028): the page after a listed or shown account
 * (`account`), or after the `other` button (`other`).
 */
export const chooserBranchSchema = v.picklist(["account", "other"]);
export type ChooserBranch = v.InferOutput<typeof chooserBranchSchema>;
const branchMember = { account: "afterAccount", other: "afterOther" } as const;
/** A chooser's route recipe for one branch, if a login generated it already. */
export function chooserBranch(
  recipe: LoginChooserRecipe,
  branch: ChooserBranch,
): LoginRecipe | undefined {
  return recipe.chooser[branchMember[branch]];
}
/**
 * The chooser with one branch replaced by `next`, as the revision `next` carries: the
 * other branch, if any, moves to that revision unchanged, since every branch has its
 * chooser's revision.
 */
export function withChooserBranch(
  recipe: LoginChooserRecipe,
  branch: ChooserBranch,
  next: LoginRecipe,
): LoginChooserRecipe {
  const other = chooserBranch(recipe, branch === "account" ? "other" : "account");
  return {
    ...recipe,
    revision: next.revision,
    chooser: {
      ...recipe.chooser,
      ...(other
        ? {
            [branchMember[branch === "account" ? "other" : "account"]]: {
              ...other,
              revision: next.revision,
            },
          }
        : {}),
      [branchMember[branch]]: next,
    },
  };
}
/**
 * What a login clicks on a chooser's list (ADR 0028): the entry of the chosen account, the
 * `continue` button beside the one shown account, or the `other` button.
 */
export const listClickSchema = v.picklist(["entry", "continue", "other"]);
export type ListClick = v.InferOutput<typeof listClickSchema>;
/**
 * How a chooser login (ADR 0028) entered its branch: by its click on the list, or
 * `other-shown` when its path already showed the `other` branch's form instead of the
 * list, as after the person pressed the button for another account, so it clicked nothing.
 */
export const chooserClickSchema = v.picklist([...listClickSchema.options, "other-shown"]);
export type ChooserClick = v.InferOutput<typeof chooserClickSchema>;
/** The branch a click on the list leads to, or the branch already shown. */
export const chooserClickBranch = (click: ChooserClick): ChooserBranch =>
  click === "other" || click === "other-shown" ? "other" : "account";
/**
 * The locator a chooser login's click on an account entry carries. It names no element:
 * the content script finds the entry of the account the worker chose, by the rule of ADR
 * 0028, and the entry itself is never stored.
 */
export const CHOOSER_ENTRY_TARGET = { by: "text", value: "[account]" } as const;
/**
 * The login recipe a chooser's login runs (ADR 0028): the click on the list, as an
 * `advance` step on the chooser's path, then the steps of the branch it leads to, once
 * generated. It has the chooser's ID, revision and origin, the branch's completion,
 * handlers and account switch, and one submission more than the branch for the click. It
 * always has the `username` slot, which picks the account's entry. For `other-shown` it is
 * the `other` branch alone, without a click, and only once that branch starts on the
 * chooser's path. `undefined` when the chooser has no button for the click, or the result
 * is no valid recipe.
 */
export function chooserRoute(
  recipe: LoginChooserRecipe,
  click: ChooserClick,
): LoginRecipe | undefined {
  if (click === "other-shown") {
    const shown = recipe.chooser.afterOther;
    if (!shown || shown.steps[0]!.path !== recipe.chooser.path) return undefined;
    const { alternatives: _alternatives, passkey: _passkey, ...rest } = shown;
    const parsed = v.safeParse(loginRecipeSchema, {
      ...rest,
      id: recipe.id,
      revision: recipe.revision,
      origin: recipe.origin,
    });
    return parsed.success ? parsed.output : undefined;
  }
  const target =
    click === "entry"
      ? CHOOSER_ENTRY_TARGET
      : click === "continue"
        ? recipe.chooser.continue
        : recipe.chooser.other;
  if (!target) return undefined;
  const branch = chooserBranch(recipe, chooserClickBranch(click));
  // A branch never starts a login, so it has no alternatives or passkey route.
  const { alternatives: _alternatives, passkey: _passkey, ...rest } = branch ?? {};
  const parsed = v.safeParse(loginRecipeSchema, {
    ...rest,
    version: 1,
    id: recipe.id,
    revision: recipe.revision,
    origin: recipe.origin,
    slots: [...new Set(["username", ...(branch?.slots ?? [])])],
    steps: [
      { kind: "click", path: recipe.chooser.path, target, purpose: "advance" },
      ...(branch?.steps ?? []),
    ],
    maxSubmissions: Math.min(8, (branch?.maxSubmissions ?? 0) + 1),
  });
  return parsed.success ? parsed.output : undefined;
}
/** The slots a stored recipe's routes fill: none for an entry, its branches' for a chooser. */
export function storedRecipeSlots(recipe: StoredLoginRecipe): string[] {
  if ("steps" in recipe) return recipeSlots(recipe);
  if ("entry" in recipe) return [];
  return [
    ...new Set(
      [recipe.chooser.afterAccount, recipe.chooser.afterOther].flatMap((branch) =>
        branch ? recipeSlots(branch) : [],
      ),
    ),
  ];
}
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
 * is the step's position in its variant.
 */
export function laterStartSteps(
  recipe: LoginRecipe,
): { variant: number; index: number; step: Extract<LoginStep, { kind: "fill" }> }[] {
  return passwordVariants(recipe).flatMap((variant, variantIndex) =>
    variant.steps.flatMap((step, index) =>
      index > 0 &&
      step.kind === "fill" &&
      step.fields.some((field) => field.slot !== TOTP_HANDLER_SLOT)
        ? [{ variant: variantIndex, index, step }]
        : [],
    ),
  );
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
/** The slot a `totp` handler's fill uses; a binding for it reads the item's TOTP field. */
export const TOTP_HANDLER_SLOT = "totp";
/**
 * The steps a handler runs: a `passkey` handler's click, a `password` handler's click that
 * advances to the password page (ADR 0048), or a `totp` handler's fill of the code into
 * its field followed by the click on its submit button.
 */
export function handlerSteps(handler: LoginHandler): LoginStep[] {
  const click: LoginStep = {
    kind: "click",
    path: handler.path,
    target: handler.target,
    purpose: handler.kind === "password" ? "advance" : "submit",
  };
  if (handler.kind !== "totp") return [click];
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
export const handlerFact = {
  passkey: "passkey",
  password: "password",
  totp: "totp",
} as const satisfies Record<LoginHandler["kind"], keyof LoginItemFacts>;
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
 * whose routes and route steps are unchanged, and whose handlers and signed-in markers
 * extend the old ones in order. A running login takes over only such a
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
 * 0018): a newer revision of the same recipe whose steps are `previous`'s steps followed by
 * at least one more, none of which fills a slot `previous`'s steps already fill.
 * `previous` has no completion and no alternatives and ends in an advance; `next` has no
 * alternatives. The `passkey` route and the rejection are unchanged, the handlers extend
 * the old ones in order, the account switch is unchanged or newly added, and signed-in
 * markers may be new. A running login at its final advance takes over only such a revision, so
 * the steps it ran keep their meaning.
 */
export function continuesRecipe(previous: LoginRecipe, next: LoginRecipe): boolean {
  const last = previous.steps.at(-1);
  if (
    next.id !== previous.id ||
    next.origin !== previous.origin ||
    next.revision <= previous.revision ||
    previous.completion !== undefined ||
    previous.alternatives !== undefined ||
    next.alternatives !== undefined ||
    !last ||
    loginStepEffect(last) !== "advance" ||
    next.steps.length <= previous.steps.length
  )
    return false;
  const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  const before = previous.handlers ?? [];
  const after = next.handlers ?? [];
  return (
    previous.steps.every((step, index) => same(step, next.steps[index])) &&
    !refillsLoginSlot(previous.steps, next.steps.slice(previous.steps.length)) &&
    previous.slots.every((slot) => next.slots.includes(slot)) &&
    next.maxSubmissions >= previous.maxSubmissions &&
    previous.passkeyOnly === next.passkeyOnly &&
    same(previous.passkey ?? null, next.passkey ?? null) &&
    same(previous.rejection ?? null, next.rejection ?? null) &&
    (previous.accountSwitch === undefined || same(previous.accountSwitch, next.accountSwitch)) &&
    after.length >= before.length &&
    before.every((handler, index) => same(handler, after[index]))
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
