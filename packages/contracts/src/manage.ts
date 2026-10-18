import * as v from "valibot";
import { deviceIdSchema } from "./pairing";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  settingsDocumentBytes,
  syncRecipeChangeSchema,
  syncRecipeIdSchema,
  syncSettingsStateSchema,
  syncSettingsWriteSchema,
} from "./sync";

// Contracts for the service's owner web UI API under `/manage/api` (see the
// architecture's "Owner web UI"). Every route acts for the owner the Access token
// names; paths and bodies never select an owner.

const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0));
const headRevision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);

export const manageDeviceSchema = v.strictObject({
  id: deviceIdSchema,
  /** Empty for a device paired without a label. */
  label: v.pipe(v.string(), v.maxLength(64)),
  createdAt: timestamp,
  /** Recorded at most once a day, so it can lag the real last use by a day. */
  lastUsedAt: timestamp,
  revokedAt: v.nullable(timestamp),
});
/** Newest first. */
export const manageDevicesSchema = v.strictObject({
  version: v.literal(1),
  devices: v.array(manageDeviceSchema),
});

/**
 * The web UI writes the same document devices sync. The service copy never holds
 * device-local vault connections, so a write that names any is refused, and the
 * document stays within the size devices upload.
 */
export const manageSettingsWriteSchema = v.pipe(
  syncSettingsWriteSchema,
  v.check((write) => write.settings.connections.length === 0, "Connections stay on devices"),
  v.check(
    (write) => settingsDocumentBytes(write.settings) <= MAX_SETTINGS_DOCUMENT_BYTES,
    "The settings document is too large",
  ),
);
/** A stale write changes nothing; the current state comes back. */
export const manageSettingsConflictSchema = v.strictObject({
  error: v.literal("settings_conflict"),
  current: syncSettingsStateSchema,
});

/** One recipe's current head: the active recipe, or a tombstone once revoked. */
export const manageRecipeSchema = v.strictObject({
  change: syncRecipeChangeSchema,
  updatedAt: timestamp,
});
/**
 * An active head whose stored document no longer passes the recipe contract. Devices
 * receive it as revoked; it stays active on the service until the owner revokes it.
 */
export const manageUnreadableRecipeSchema = v.strictObject({
  recipeId: syncRecipeIdSchema,
  revision: headRevision,
  updatedAt: timestamp,
});
/** Both lists are most recently changed first. */
export const manageRecipesSchema = v.strictObject({
  version: v.literal(1),
  recipes: v.array(manageRecipeSchema),
  unreadable: v.array(manageUnreadableRecipeSchema),
});
/** Revokes the recipe if `expectedRevision` is still its head; devices drop it on sync. */
export const manageRecipeRevokeSchema = v.strictObject({
  version: v.literal(1),
  expectedRevision: headRevision,
});
/** The revocation lost to another write, or the recipe is already revoked. */
export const manageRecipeConflictSchema = v.strictObject({
  error: v.literal("recipe_conflict"),
  current: v.nullable(syncRecipeChangeSchema),
});

/** How long the service keeps each request log row (ADR 0012; owner, 2026-10-18). */
export const INFERENCE_LOG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** The owner's request log (ADR 0012): how many requests it holds, and the oldest's time. */
export const manageRequestLogSchema = v.strictObject({
  version: v.literal(1),
  entries: v.pipe(v.number(), v.integer(), v.minValue(0)),
  oldestAt: v.nullable(timestamp),
});
/** Deleting the whole request log: how many requests it removed. */
export const manageRequestLogDeletedSchema = v.strictObject({
  version: v.literal(1),
  deleted: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export const manageErrorCodeSchema = v.picklist([
  "bad_request",
  /** No Access token: the page must be reloaded through Access. */
  "unauthorized",
  /** The token failed verification, or the request came from another origin. */
  "forbidden",
  /** The service has no Access configuration. */
  "access_unavailable",
  "not_found",
  /** Settings belong to an account with a paired device; this identity has none. */
  "not_paired",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  /** Too many requests from this identity in the last minute. */
  "rate_limited",
  "internal_error",
]);
export const manageErrorSchema = v.strictObject({ error: manageErrorCodeSchema });

export type ManageDevice = v.InferOutput<typeof manageDeviceSchema>;
export type ManageDevices = v.InferOutput<typeof manageDevicesSchema>;
export type ManageSettingsWrite = v.InferOutput<typeof manageSettingsWriteSchema>;
export type ManageRecipe = v.InferOutput<typeof manageRecipeSchema>;
export type ManageUnreadableRecipe = v.InferOutput<typeof manageUnreadableRecipeSchema>;
export type ManageRecipes = v.InferOutput<typeof manageRecipesSchema>;
export type ManageRequestLog = v.InferOutput<typeof manageRequestLogSchema>;
export type ManageRequestLogDeleted = v.InferOutput<typeof manageRequestLogDeletedSchema>;
export type ManageErrorCode = v.InferOutput<typeof manageErrorCodeSchema>;
export type ManageError = v.InferOutput<typeof manageErrorSchema>;
