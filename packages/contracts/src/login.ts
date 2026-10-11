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
 * `<button>`'s rendered text, an `<input type="submit|button">`'s value or an
 * `<input type="image">`'s alt, with whitespace collapsed to single spaces and
 * format characters removed. It matches buttons only, so fills never use it; a recipe's
 * `accountSwitch` alone also matches an `<a href>` link by its rendered text.
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
 * when a login starts. `password` runs the recipe's steps.
 */
export const loginRouteSchema = v.picklist(["password"]);
/**
 * A branch on the page that appears after an effect step (ADR 0027), entered when its
 * path matches and its element shows, and run only for an item with the handler's fact.
 * Its steps follow from its kind. `passkey` clicks a button such as "Use security key".
 */
export const loginHandlerSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("passkey"), path, target: loginTargetSchema }),
]);
const handlerKey = (handler: v.InferOutput<typeof loginHandlerSchema>) =>
  `${handler.kind} ${handler.path}`;
export const loginRecipeSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    id: identifier,
    revision,
    origin: loginOriginSchema,
    slots: v.pipe(
      v.array(identifier),
      v.minLength(1),
      v.maxLength(20),
      v.check(unique, "Duplicate recipe slots"),
    ),
    steps: v.pipe(v.array(loginStepSchema), v.minLength(1), v.maxLength(32)),
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
      recipe.steps.every(
        (step) =>
          step.kind !== "fill" || step.fields.every((field) => recipe.slots.includes(field.slot)),
      ),
    "Unknown semantic slot",
  ),
  v.check(
    (recipe) =>
      recipe.steps.filter(
        (step) => step.kind === "click" || (step.kind === "fill" && step.effect !== "prepare"),
      ).length <= recipe.maxSubmissions,
    "Effect attempt budget is too small",
  ),
  v.check(
    (recipe) =>
      recipe.steps.every(
        (step, index) =>
          step.kind !== "fill" ||
          step.effect === "prepare" ||
          !recipe.steps
            .slice(index + 1)
            .find((next) => next.path === step.path && next.kind === "click"),
      ),
    "Input-triggered effects cannot have a fallback click on the same path",
  ),
  // The executor checks the result elements and the next step's elements in one
  // observation of at most 24 elements.
  v.check(
    (recipe) =>
      Math.max(0, ...recipe.steps.map(stepTargetCount)) +
        (recipe.completion ? 1 + (recipe.completion.absent?.length ?? 0) : 0) +
        (recipe.rejection ? 1 : 0) <=
      24,
    "Too many result elements to observe with a step",
  ),
  // The switch is clicked instead of signing in, so it must not be a step's own button.
  v.check((recipe) => {
    if (!recipe.accountSwitch) return true;
    const key = JSON.stringify(recipe.accountSwitch);
    return ![
      ...recipe.steps.flatMap((step) => (step.kind === "click" ? [step.target] : [])),
      ...(recipe.handlers ?? []).map((handler) => handler.target),
      ...(recipe.rejection ? [recipe.rejection] : []),
    ].some((target) => JSON.stringify(target) === key);
  }, "Account switch target is a step or rejection target"),
  // A handler's button showing would otherwise prove the sign-in on its own page.
  v.check(
    (recipe) =>
      !recipe.completion ||
      !(recipe.handlers ?? []).some(
        (handler) =>
          handler.path === recipe.completion!.path &&
          JSON.stringify(handler.target) === JSON.stringify(recipe.completion!.target),
      ),
    "Completion target is a handler target",
  ),
);
export const loginAccountSchema = v.strictObject({
  origin: loginOriginSchema,
  connectionId: identifier,
  itemId: identifier,
});
export const loginAccountBindingSchema = v.strictObject({
  ...loginAccountSchema.entries,
  slots: v.pipe(
    v.array(v.strictObject({ slot: identifier, fieldId: identifier })),
    v.minLength(1),
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
export type LoginAttributeTarget = v.InferOutput<typeof loginAttributeTargetSchema>;
export type LoginStep = v.InferOutput<typeof loginStepSchema>;
export type LoginEffect = "prepare" | "advance" | "submit";
export function loginStepEffect(step: LoginStep): LoginEffect | undefined {
  return step.kind === "fill" ? step.effect : step.kind === "click" ? step.purpose : undefined;
}
export type LoginRecipe = v.InferOutput<typeof loginRecipeSchema>;
export type LoginRoute = v.InferOutput<typeof loginRouteSchema>;
export type LoginHandler = v.InferOutput<typeof loginHandlerSchema>;

/** A route's steps. Delivery 3 of ADR 0027 adds start-page routes beside `password`. */
export function routeSteps(recipe: LoginRecipe, route: LoginRoute): LoginStep[] {
  return route === "password" ? recipe.steps : [];
}
/** Whether the recipe offers the route; every recipe has the `password` route. */
export function recipeHasRoute(recipe: LoginRecipe, route: LoginRoute): boolean {
  return routeSteps(recipe, route).length > 0;
}
/** The steps a handler runs. */
export function handlerSteps(handler: LoginHandler): LoginStep[] {
  return [{ kind: "click", path: handler.path, target: handler.target, purpose: "submit" }];
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
export const handlerFact = { passkey: "passkey" } as const satisfies Record<
  LoginHandler["kind"],
  keyof LoginItemFacts
>;
/**
 * The password and TOTP facts from the catalog's value-free `empty` flags and the
 * account's allowed (not excluded) field IDs.
 */
export function loginFieldFacts(
  item: Pick<VaultItemMetadata, "fields">,
  allowedFieldIds: readonly string[],
): Pick<LoginItemFacts, "password" | "totp"> {
  const has = (fieldId: string) =>
    allowedFieldIds.includes(fieldId) &&
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

/** Policy selects one saved account before any recipe or field lookup. No fallback. */
export function resolveLoginPlan(
  snapshot: SettingsSnapshot,
  catalog: VaultCatalog,
  url: string,
  recipeValue: unknown,
  bindingValue: unknown,
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
    binding.output.slots.length !== recipe.output.slots.length ||
    !recipe.output.slots.every((slot) => binding.output.slots.some((entry) => entry.slot === slot))
  )
    return { ok: false as const, reason: "binding-slots-mismatch" as const };
  if (!binding.output.slots.every((entry) => account.fieldIds.includes(entry.fieldId)))
    return { ok: false as const, reason: "binding-field-excluded" as const };
  return { ok: true as const, account, recipe: recipe.output, binding: binding.output };
}
