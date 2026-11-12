import * as v from "valibot";
import { loginOriginSchema, identifier, unique, revision, loginStepSchema } from "./targets";
import {
  recipeSlotIdSchema,
  type SettingsSnapshot,
  type VaultCatalog,
  resolveSiteAccount,
} from "../settings";
import { type LoginRecipe, loginRecipeSchema } from "./route-schema";

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
  signInFill: v.optional(v.literal(true)),
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
  // in a new page, as after a code or an approval expired.
  // `challenge-abandoned` for a login stopped at `challenge`, `watch-abandoned` for one
  // whose result settled as unknown.
  "challenge-abandoned",
  "watch-abandoned",
]);
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
