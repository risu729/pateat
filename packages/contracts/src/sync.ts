import * as v from "valibot";
import {
  chooserBranchSchema,
  loginIdentifierSchema,
  loginOutcomeSchema,
  storedLoginRecipeSchema,
} from "./login";
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
/**
 * The largest settings document a writer stores. The service accepts request bodies up
 * to 128 KiB; the document leaves room for the rest of the write.
 */
export const MAX_SETTINGS_DOCUMENT_BYTES = 120 * 1024;
/** UTF-8 bytes of an owner's active recipe documents; tombstones do not count. */
export const MAX_ACTIVE_RECIPE_BYTES = 1.5 * 1024 * 1024;
/** Serialized device cache, including its envelope; leaves margin above the service cap. */
export const MAX_RECIPE_CACHE_BYTES = 2 * 1024 * 1024;
export const settingsDocumentBytes = (settings: unknown) =>
  new TextEncoder().encode(JSON.stringify(settings)).byteLength;

export const syncSettingsWriteSchema = v.strictObject({
  version: v.literal(1),
  expectedRevision: revision,
  settings: localSettingsSchema,
});

/**
 * The stored recipe carries the sync identity, so a cached copy cannot drift from it. It is
 * a login route recipe, an entry recipe (ADR 0031) or a chooser recipe (ADR 0028).
 */
export const syncRecipeChangeSchema = v.pipe(
  v.variant("state", [
    v.strictObject({
      recipeId: syncRecipeIdSchema,
      revision: writtenRevision,
      state: v.literal("active"),
      recipe: storedLoginRecipeSchema,
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
      recipe: storedLoginRecipeSchema,
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
  /** Unused for `DEVICE_IDLE_LIMIT_MS`; the device must pair again. */
  "device_expired",
  "not_found",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  /** The write would make the owner hold more active recipes or recipe bytes than the service keeps. */
  "recipe_limit",
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

/**
 * `GET /v1/device`: what the service holds for the calling device's owner, for the
 * diagnostics page (ADR 0019). Counts, times and codes only.
 */
export const syncDeviceStateSchema = v.strictObject({
  version: v.literal(1),
  /** When this device was paired. */
  pairedAt: sequence,
  /** The owner's recipes that are not deleted. */
  recipes: sequence,
  /** The owner's settings revision; 0 when none is stored. */
  settingsRevision: revision,
  /** Whether recipe generation would be attempted now, without asking Claude. */
  generation: v.picklist([
    "ok",
    "credentials-not-configured",
    "issuer-unavailable",
    "monthly-limit",
    "daily-limit",
  ]),
});
export type SyncDeviceState = v.InferOutput<typeof syncDeviceStateSchema>;

/**
 * Why a login ended where it did, as a fixed code (ADR 0019, amended 2026-10-18): the
 * worker's stop causes, the page's own reasons for a failed or cancelled step, `settled`
 * for a result that settled as unknown, and `unconfirmed` for a sign-in on an undecided
 * page. The extension's `StopCause` must stay inside this list.
 */
export const loginOutcomeCauseSchema = v.picklist([
  // The worker's stop causes.
  "elements-timeout",
  "answer-failed",
  "code-not-submitted",
  "no-operation",
  "operation-invalid",
  "slot-unbound",
  "no-answer",
  "page-submitted",
  "document-gone",
  "captcha-shown",
  "sign-in-shown",
  // The page's reasons for a cancelled or failed step.
  "not-authorized",
  "document-cancelled",
  "operation-used",
  "operation-expired",
  "page-changed",
  "field-changed",
  "threw",
  "form-replaced",
  "target-missing",
  "form-changed",
  "assert-failed",
  "unexpected-values",
  "fields-split",
  "secret-refused",
  "unsupported-input",
  "code-watch-failed",
  "form-off-origin",
  // Flags of the attempt itself.
  "settled",
  "unconfirmed",
]);
/**
 * `POST /v1/recipes/:recipeId/outcome`: how the first login of a recipe revision on this
 * device ended, for the evaluation corpus (ADR 0019 and ADR 0012, amended 2026-10-18). Codes
 * and numbers only: never a URL, page text, reason text, label, value or username. The
 * service adds the time.
 */
export const loginOutcomeReportSchema = v.strictObject({
  version: v.literal(1),
  revision: writtenRevision,
  /** For a chooser recipe (ADR 0028): the branch the login took. */
  branch: v.optional(chooserBranchSchema),
  outcome: loginOutcomeSchema,
  cause: v.optional(loginOutcomeCauseSchema),
  /** The attempt's step index when it ended: route steps and entered handlers' (at most 40). */
  step: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(40)),
});
export type LoginOutcomeCause = v.InferOutput<typeof loginOutcomeCauseSchema>;
export type LoginOutcomeReport = v.InferOutput<typeof loginOutcomeReportSchema>;
