import * as v from "valibot";
import {
  path,
  loginTargetSchema,
  loginFieldTargetSchema,
  sameLoginTarget,
  unique,
  loginStepSchema,
  loginMarkerTargetSchema,
  loginOriginSchema,
  loginStepEffect,
  stepTargetCount,
  identifier,
  revision,
  loginRouteSchema,
} from "./targets";
import { detailFieldSchema, detailFieldInputs } from "./details";
import { recipeSlotIdSchema } from "../settings";

/**
 * A branch on the page that appears after an effect step (ADR 0027), entered when its
 * path matches and all its elements show, and run only for an item with the handler's
 * fact. Its steps follow from its kind. `passkey` clicks a button such as "Use security
 * key"; `totp` fills the item's TOTP code into `field` and clicks `target`, its submit
 * button, or, without `target`, types the code as the submission on a page that shows no
 * button for it and submits the code once it is in (ADR 0027 amendment of 2026-10-23);
 * `password` clicks a button such as "Password" on a page that asks how to confirm the
 * sign-in, which goes on to typing the password (ADR 0048); `authenticator` clicks a
 * button such as "Use code from authenticator" on such a page, which goes on to the page
 * that asks for the authenticator app's code (ADR 0081); `detail` fills one of its
 * inputs with a personal detail of a linked item and clicks `target` (ADR 0061).
 */
export const loginHandlerSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("passkey"), path, target: loginTargetSchema }),
  v.strictObject({ kind: v.literal("password"), path, target: loginTargetSchema }),
  v.strictObject({ kind: v.literal("authenticator"), path, target: loginTargetSchema }),
  v.pipe(
    v.strictObject({
      kind: v.literal("totp"),
      path,
      field: loginFieldTargetSchema,
      target: v.optional(loginTargetSchema),
    }),
    v.check(
      (handler) => handler.target === undefined || !sameLoginTarget(handler.field, handler.target),
      "The code field cannot be its submit button",
    ),
  ),
  /**
   * A page that asks for a personal detail (ADR 0061): one to three fields, each the
   * detail it asks for in one input or split over several, of which a login fills the
   * first it has a linked value for, and the button that submits it. A page that offers a
   * choice, as radio buttons do, lists each field.
   */
  v.pipe(
    v.strictObject({
      kind: v.literal("detail"),
      path,
      fields: v.pipe(v.array(detailFieldSchema), v.minLength(1), v.maxLength(3)),
      target: loginTargetSchema,
    }),
    v.check(
      (handler) =>
        unique(
          handler.fields.flatMap((field) =>
            detailFieldInputs(field).map((input) => JSON.stringify(input.target)),
          ),
        ),
      "Duplicate detail inputs",
    ),
    v.check(
      (handler) =>
        !handler.fields.some((field) =>
          detailFieldInputs(field).some(
            (input) => JSON.stringify(input.target) === JSON.stringify(handler.target),
          ),
        ),
      "A detail input cannot be its submit button",
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
export const variantsOf = (recipe: {
  slots: string[];
  steps: v.InferOutput<typeof loginStepSchema>[];
  alternatives?: { slots: string[]; steps: v.InferOutput<typeof loginStepSchema>[] }[] | undefined;
}) => [{ slots: recipe.slots, steps: recipe.steps }, ...(recipe.alternatives ?? [])];
/** How many slots some routes fill together, each once (ADR 0060). */
export const routeSlotCount = (routes: readonly Parameters<typeof variantsOf>[0][]) =>
  new Set(routes.flatMap((route) => variantsOf(route).flatMap((variant) => variant.slots))).size;
export const targetKey = (target: v.InferOutput<typeof loginMarkerTargetSchema>) =>
  JSON.stringify(target);
/** The elements a recipe's markers name: each marker and the elements it needs missing. */
const completionTargetCount = (
  markers: readonly { absent?: readonly unknown[] | undefined }[] | undefined,
) => (markers ?? []).reduce((count, marker) => count + 1 + (marker.absent?.length ?? 0), 0);
/**
 * Every element a handler uses, in the order its steps use them: a `totp` handler's code
 * field or a `detail` handler's inputs, then its button when it has one. The handler is
 * entered only when all of them show (ADR 0027).
 */
export function handlerTargets(
  handler: v.InferOutput<typeof loginHandlerSchema>,
): v.InferOutput<typeof loginTargetSchema>[] {
  if (handler.kind === "totp")
    return handler.target ? [handler.field, handler.target] : [handler.field];
  if (handler.kind === "detail")
    return [
      ...handler.fields.flatMap((field) => detailFieldInputs(field).map((input) => input.target)),
      handler.target,
    ];
  return [handler.target];
}
/** The `passkey` route's one step: a click on its button that submits. */
export const passkeyStep = (passkey: {
  path: string;
  target: v.InferOutput<typeof loginTargetSchema>;
}): v.InferOutput<typeof loginStepSchema> => ({
  kind: "click",
  path: passkey.path,
  target: passkey.target,
  purpose: "submit",
});
/**
 * The kind of page a route recipe starts on (ADR 0035), as generation answered it from the
 * page's structure: `sign-in` for a login and the pages that continue it, `confirm` for a
 * verification asked while signed in, before an action, and `unclear` when the model could
 * not tell, which is handled as `confirm`.
 */
export const pageKindSchema = v.picklist(["sign-in", "confirm", "unclear"]);
export type PageKind = v.InferOutput<typeof pageKindSchema>;
/**
 * The most layouts one recipe holds (ADR 0060): versions of the same start page, such as
 * the page in another language or after the site changed it.
 */
export const MAX_RECIPE_LAYOUTS = 3;
/**
 * The most bytes one stored recipe document takes as JSON (ADR 0060): with the write's
 * envelope it stays within the service's 128 KiB request body limit, so a device can write
 * back any document it synced. Each layout's own limits allow more than a third of it.
 */
export const MAX_RECIPE_DOCUMENT_BYTES = 120 * 1024;
export const fitsDocumentBytes = (recipe: unknown) =>
  new TextEncoder().encode(JSON.stringify(recipe)).byteLength <= MAX_RECIPE_DOCUMENT_BYTES;
/**
 * A layout's stable key (ADR 0060): the service writes the layout's creation time in epoch
 * milliseconds, made unique within the recipe, and never changes or reuses it, so records
 * name a layout by it even after others are added or removed.
 */
export const recipeLayoutKeySchema = v.pipe(v.string(), v.regex(/^\d{1,16}$/u));
/** The language a layout's page was in when it was generated; a mixed page has none. */
export const recipeLanguageSchema = v.picklist(["ja", "en"]);
export const layoutCreatedAt = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
/** The members of one login route: what a recipe's layout and a chooser branch hold. */
const routeEntries = {
  /**
   * The start page's kind (ADR 0035), kept by each layout (ADR 0060). Generation stores it
   * on every layout it makes; a continuation keeps the layout's own, and a chooser branch
   * is `sign-in`. Only a `sign-in` layout starts a login, counts as a logout or is filled
   * after one.
   */
  pageKind: pageKindSchema,
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
};
const routeObject = v.strictObject(routeEntries);
type RouteBody = v.InferOutput<typeof routeObject>;
/** The checks every login route passes, whether a layout, a projection or a branch. */
const routeRules: readonly (readonly [(recipe: RouteBody) => boolean, string])[] = [
  [
    (recipe) => recipe.passkeyOnly === true || recipe.slots.length > 0,
    "A recipe has at least one slot",
  ],
  [
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
  ],
  [
    (recipe) =>
      variantsOf(recipe).every((variant) =>
        variant.steps.every(
          (step) =>
            step.kind !== "fill" ||
            step.fields.every((field) => variant.slots.includes(field.slot)),
        ),
      ),
    "Unknown semantic slot",
  ],
  [
    (recipe) =>
      variantsOf(recipe).every((variant) => stepEffects(variant.steps) <= recipe.maxSubmissions),
    "Effect attempt budget is too small",
  ],
  [
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
  ],
  // Variants are told apart by their slots, and every variant starts on the recipe's start
  // page. Each one submits, so a later page can never continue one variant of several.
  [
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
  ],
  [
    (recipe) =>
      variantsOf(recipe).every((variant, index, all) =>
        all.every(
          (other, otherIndex) =>
            otherIndex === index || !variant.slots.every((slot) => other.slots.includes(slot)),
        ),
      ),
    "A variant's slots repeat or are a subset of another variant's",
  ],
  // An element is filled as one slot whatever the variant, and no two variants fill the
  // same elements, so an ambiguous mapping never becomes two variants.
  [
    (recipe) => {
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
    },
    "A fill target maps to several slots, or two variants fill the same targets",
  ],
  // A binding covers one variant, and bindings hold at most 20 slots.
  [
    (recipe) => new Set(variantsOf(recipe).flatMap((variant) => variant.slots)).size <= 20,
    "Too many recipe slots",
  ],
  // The executor checks the result elements and the next step's elements in one
  // observation of at most 24 elements.
  [
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
  ],
  // The switch is clicked instead of signing in, so it must not be a step's own button.
  // A marker proves the sign-in wherever it shows (ADR 0029), so a login page that shows
  // the switch must not read as signed in either.
  [
    (recipe) => {
      if (!recipe.accountSwitch) return true;
      const key = targetKey(recipe.accountSwitch);
      return ![
        ...variantsOf(recipe).flatMap((variant) =>
          variant.steps.flatMap((step) => (step.kind === "click" ? [step.target] : [])),
        ),
        ...(recipe.handlers ?? []).flatMap(handlerTargets),
        ...(recipe.rejection ? [recipe.rejection] : []),
        ...(recipe.completion ?? []).map((marker) => marker.target),
      ].some((target) => targetKey(target) === key);
    },
    "Account switch target is a step, rejection or completion marker target",
  ],
  // The markers and the rejection are checked after every step, on any path, so a
  // variant's own element must never prove or refuse the sign-in. A marker proves it
  // wherever it shows (ADR 0029), so even a single variant's step never uses one; its
  // rejection on its own elements is left to the recipe's author.
  [
    (recipe) => {
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
    },
    "Completion or rejection target is a variant's step target",
  ],
  // A handler's element showing would otherwise prove the sign-in on its own page.
  [
    (recipe) => {
      const markers = new Set((recipe.completion ?? []).map((marker) => targetKey(marker.target)));
      return !(recipe.handlers ?? []).some((handler) =>
        handlerTargets(handler).some((target) => markers.has(targetKey(target))),
      );
    },
    "Completion target is a handler target",
  ],
  // A `totp` handler types a code into a field of its own: never one a route step uses on
  // its path, such as the password input of a form that asks for the code after it. A
  // `detail` handler's inputs and button are all its own (ADR 0061): the route's sign-in
  // form may still show beside them.
  // The `detail` slot is the handler's own, so no route step fills one by that name.
  [
    (recipe) =>
      !variantsOf(recipe).some((variant) =>
        variant.steps.some(
          (step) => step.kind === "fill" && step.fields.some((field) => isDetailSlot(field.slot)),
        ),
      ) &&
      !(recipe.handlers ?? []).some((handler) => {
        if (handler.kind !== "totp" && handler.kind !== "detail") return false;
        const own = (handler.kind === "totp" ? [handler.field] : handlerTargets(handler)).map(
          targetKey,
        );
        return variantsOf(recipe).some((variant) =>
          variant.steps.some(
            (step) =>
              step.path === handler.path &&
              (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target])
                .map(targetKey)
                .some((key) => own.includes(key)),
          ),
        );
      }),
    "The code field or a detail handler's element is a route step target, or a route slot is named as a detail handler's",
  ],
  // A `password` handler's button leads to the password a route step types, and an
  // `authenticator` handler's to the code page after the sign-in form: neither is a route
  // step's own element on its path (ADR 0048, ADR 0081).
  [
    (recipe) =>
      !(recipe.handlers ?? []).some(
        (handler) =>
          (handler.kind === "password" || handler.kind === "authenticator") &&
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
    "A password or authenticator handler's button is a route step target",
  ],
  // A control named by its accessible name is only ever a `password` handler's button
  // (ADR 0048 amendment of 2026-10-19) or a route step's click (ADR 0048 amendment of
  // 2026-10-23), never another element the executor presses or checks.
  [
    (recipe) =>
      ![
        ...variantsOf(recipe).flatMap((variant) =>
          variant.steps.flatMap((step) =>
            step.kind === "fill" || step.kind === "click" ? [] : [step.target],
          ),
        ),
        ...(recipe.passkey ? [recipe.passkey.target] : []),
        ...(recipe.completion ?? []).flatMap((marker) => [marker.target, ...(marker.absent ?? [])]),
        ...(recipe.rejection ? [recipe.rejection] : []),
        ...(recipe.accountSwitch ? [recipe.accountSwitch] : []),
        ...(recipe.handlers ?? []).flatMap((handler) =>
          handler.kind === "password" ? [] : handlerTargets(handler),
        ),
      ].some((target) => target.by === "accessible-name"),
    "Only a password handler's button or a click step is named by its accessible name",
  ],
  // The passkey route starts on the start page, beside the password route.
  [
    (recipe) => !recipe.passkey || recipe.passkey.path === recipe.steps[0]!.path,
    "The passkey route must start on the start path",
  ],
  // Its button is an element of its own: no password variant's step uses it on the start
  // page, and it never switches the account, proves or refuses the sign-in, or answers a
  // handler there.
  [
    (recipe) => {
      const { passkey } = recipe;
      if (!passkey) return true;
      const key = targetKey(passkey.target);
      const onPath = (
        entries: { path: string; target: v.InferOutput<typeof loginTargetSchema> }[],
      ) => entries.some((entry) => entry.path === passkey.path && targetKey(entry.target) === key);
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
    },
    "Passkey target is a step, handler, completion, rejection or account switch target",
  ],
];
/** Adds an issue for each of `routeRules` the route breaks. */
function routeCheck<T extends RouteBody>() {
  return v.rawCheck<T>(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    for (const [holds, message] of routeRules) if (!holds(dataset.value)) addIssue({ message });
  });
}
/** Whether none of the route's markers names `origin`, which a marker of that origin leaves out. */
export const markersOffOrigin = (origin: string, route: Pick<RouteBody, "completion">) =>
  !(route.completion ?? []).some((marker) => marker.origin === origin);
/** A chooser branch's route (ADR 0028), stored inside its chooser layout. */
export const loginRouteBodySchema = v.pipe(routeObject, routeCheck<RouteBody>());
const recipeObject = v.strictObject({
  version: v.literal(1),
  id: identifier,
  revision,
  origin: loginOriginSchema,
  /**
   * The layout this recipe was projected from (ADR 0060), which a login records and resumes
   * by; absent only for a recipe that comes from no stored layout, as the probe build's.
   */
  layout: v.optional(recipeLayoutKeySchema),
  ...routeEntries,
});
/**
 * The recipe a login runs: one layout of a stored recipe document, projected with the
 * document's ID, revision and origin (`layoutRecipe`, ADR 0060).
 */
export const loginRecipeSchema = v.pipe(
  recipeObject,
  routeCheck<v.InferOutput<typeof recipeObject>>(),
  // A marker of the recipe's own origin names none.
  v.check(
    (recipe) => markersOffOrigin(recipe.origin, recipe),
    "Completion marker names the recipe's own origin",
  ),
);
const layoutObject = v.strictObject({
  key: recipeLayoutKeySchema,
  language: v.optional(recipeLanguageSchema),
  createdAt: layoutCreatedAt,
  ...routeEntries,
});
/**
 * One layout of a stored login recipe (ADR 0060): a whole login route with its own
 * handlers, signed-in markers and continuation pages, its stable key, the language of the
 * page it was generated from and when it was created.
 */
export const loginLayoutSchema = v.pipe(
  layoutObject,
  routeCheck<v.InferOutput<typeof layoutObject>>(),
);
export type LoginRecipe = v.InferOutput<typeof loginRecipeSchema>;
export type LoginLayout = v.InferOutput<typeof loginLayoutSchema>;
export type LoginRouteBody = v.InferOutput<typeof loginRouteBodySchema>;
export type RecipeLanguage = v.InferOutput<typeof recipeLanguageSchema>;
/** What a layout is besides its route (ADR 0060): its key, language and creation time. */
export type LayoutMeta = { key: string; language?: RecipeLanguage | undefined; createdAt: number };
export type LoginRoute = v.InferOutput<typeof loginRouteSchema> | "sso";
export type LoginHandler = v.InferOutput<typeof loginHandlerSchema>;
/**
 * The slot a `totp` handler's fill uses; it always fills a generated code. A binding for it
 * reads the item's TOTP field, or a Text or Hidden custom field that a saved binding names
 * and that holds a TOTP seed.
 */
export const TOTP_HANDLER_SLOT = "totp";
/**
 * The slot a `detail` handler's fill uses (ADR 0061). No binding slot reads it: the value
 * comes from the item the binding's `details` link for the input's detail.
 */
export const DETAIL_HANDLER_SLOT = "detail";
/**
 * The slot of a `detail` handler's fill of the `index`th input of its chosen field: the
 * first `detail`, a split value's further parts `detail 2` to `detail 6` (ADR 0061).
 */
export const detailSlot = (index: number) =>
  index === 0 ? DETAIL_HANDLER_SLOT : `${DETAIL_HANDLER_SLOT} ${index + 1}`;
/** Whether `slot` is one a `detail` handler's fill uses, which no route step fills. */
export const isDetailSlot = (slot: string) => /^detail(?: [2-6])?$/u.test(slot);
