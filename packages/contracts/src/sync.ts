import * as v from "valibot";
import { loginIdentifierSchema, loginRecipeSchema } from "./login";
import { localSettingsSchema } from "./settings";

// Contracts for the optional private settings/recipe service. Synced documents are
// server-readable policy and recipe metadata; vault values, provider sessions,
// unlock material and device-local field policies are never part of them.

const revision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);
const writtenRevision = v.pipe(revision, v.minValue(1));
const sequence = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);

export const SYNC_PAGE_LIMIT = 100;
export const syncRecipeIdSchema = loginIdentifierSchema;

/** Revision 0 means the owner has never stored settings on the service. */
export const syncSettingsStateSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    revision,
    settings: v.nullable(localSettingsSchema),
  }),
  v.check(
    (state) => (state.revision === 0) === (state.settings === null),
    "Only revision 0 has no settings",
  ),
);
export const syncSettingsWriteSchema = v.strictObject({
  version: v.literal(1),
  expectedRevision: revision,
  settings: localSettingsSchema,
});

/** The stored recipe carries the sync identity, so a cached copy cannot drift from it. */
export const syncRecipeChangeSchema = v.pipe(
  v.variant("state", [
    v.strictObject({
      recipeId: syncRecipeIdSchema,
      revision: writtenRevision,
      state: v.literal("active"),
      recipe: loginRecipeSchema,
    }),
    v.strictObject({
      recipeId: syncRecipeIdSchema,
      revision: writtenRevision,
      state: v.literal("revoked"),
    }),
  ]),
  v.check(
    (change) =>
      change.state === "revoked" ||
      (change.recipe.id === change.recipeId && change.recipe.revision === change.revision),
    "Recipe identity does not match its sync revision",
  ),
);
export const syncRecipeChangesSchema = v.strictObject({
  version: v.literal(1),
  changes: v.pipe(
    v.array(syncRecipeChangeSchema),
    v.maxLength(SYNC_PAGE_LIMIT),
    v.check(
      (changes) => new Set(changes.map((change) => change.recipeId)).size === changes.length,
      "Duplicate recipe changes",
    ),
  ),
  /** Opaque to clients: pass it back as `after` to continue. */
  cursor: sequence,
  complete: v.boolean(),
});

/** A revoked recipe stays a tombstone; a later active revision may replace it explicitly. */
export const syncRecipeWriteSchema = v.pipe(
  v.variant("state", [
    v.strictObject({
      version: v.literal(1),
      expectedRevision: revision,
      state: v.literal("active"),
      recipe: loginRecipeSchema,
    }),
    v.strictObject({
      version: v.literal(1),
      expectedRevision: writtenRevision,
      state: v.literal("revoked"),
    }),
  ]),
  v.check(
    (write) => write.state === "revoked" || write.recipe.revision === write.expectedRevision + 1,
    "Recipe revision must follow the expected revision",
  ),
);
export const syncRecipeWriteResultSchema = v.strictObject({
  version: v.literal(1),
  change: syncRecipeChangeSchema,
});

export const syncErrorCodeSchema = v.picklist([
  "bad_request",
  "unauthorized",
  "device_revoked",
  "not_found",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "internal_error",
]);
export const syncErrorSchema = v.variant("error", [
  v.strictObject({ error: syncErrorCodeSchema }),
  v.strictObject({ error: v.literal("settings_conflict"), current: syncSettingsStateSchema }),
  v.strictObject({
    error: v.literal("recipe_conflict"),
    current: v.nullable(syncRecipeChangeSchema),
  }),
]);

export type SyncSettingsState = v.InferOutput<typeof syncSettingsStateSchema>;
export type SyncSettingsWrite = v.InferOutput<typeof syncSettingsWriteSchema>;
export type SyncRecipeChange = v.InferOutput<typeof syncRecipeChangeSchema>;
export type SyncRecipeChanges = v.InferOutput<typeof syncRecipeChangesSchema>;
export type SyncRecipeWrite = v.InferOutput<typeof syncRecipeWriteSchema>;
export type SyncRecipeWriteResult = v.InferOutput<typeof syncRecipeWriteResultSchema>;
export type SyncError = v.InferOutput<typeof syncErrorSchema>;
