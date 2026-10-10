import * as v from "valibot";
import {
  parseSiteUrl,
  resolveSiteAccount,
  type SettingsSnapshot,
  type VaultCatalog,
} from "./settings";

const identifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
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
const unique = (values: string[]) => new Set(values).size === values.length;

/** An allowlisted element locator; recipes cannot supply CSS, code, URLs or values. */
export const loginTargetSchema = v.strictObject({
  by: v.picklist(["id", "name", "test-id"]),
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(120), v.regex(/^[a-zA-Z0-9_.:-]+$/)),
});
const fields = v.pipe(
  v.array(v.strictObject({ slot: identifier, target: loginTargetSchema })),
  v.minLength(1),
  v.maxLength(20),
  v.check((entries) => unique(entries.map((entry) => entry.slot)), "Duplicate fill slots"),
  v.check(
    (entries) => unique(entries.map((entry) => JSON.stringify(entry.target))),
    "Duplicate fill targets",
  ),
);
export const loginStepSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("fill"), path, fields }),
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
    completion: v.strictObject({ path, target: loginTargetSchema }),
    rejection: v.optional(loginTargetSchema),
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
      recipe.steps.filter((step) => step.kind === "click").length <= recipe.maxSubmissions,
    "Click budget is too small",
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
  stepIndex: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(31)),
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
]);

export type LoginTarget = v.InferOutput<typeof loginTargetSchema>;
export type LoginStep = v.InferOutput<typeof loginStepSchema>;
export type LoginRecipe = v.InferOutput<typeof loginRecipeSchema>;
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
