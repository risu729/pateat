import * as v from "valibot";
import { deviceIdSchema } from "./pairing";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  settingsDocumentBytes,
  syncRecipeChangeSchema,
  syncSettingsStateSchema,
  syncSettingsWriteSchema,
} from "./sync";

// Contracts for the service's owner web UI API under `/manage/api` (see the
// architecture's "Owner web UI"). Every route acts for the owner the Access token
// names; paths and bodies never select an owner.

const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0));

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
/** Most recently changed first. */
export const manageRecipesSchema = v.strictObject({
  version: v.literal(1),
  recipes: v.array(manageRecipeSchema),
});
/** Revokes the recipe if `expectedRevision` is still its head; devices drop it on sync. */
export const manageRecipeRevokeSchema = v.strictObject({
  version: v.literal(1),
  expectedRevision: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(Number.MAX_SAFE_INTEGER - 1),
  ),
});
/** The revocation lost to another write, or the recipe is already revoked. */
export const manageRecipeConflictSchema = v.strictObject({
  error: v.literal("recipe_conflict"),
  current: v.nullable(syncRecipeChangeSchema),
});

/**
 * The identifiers an owner copies from their own Workload Identity Federation rule in
 * the Claude Console (ADR 0015). None is a secret.
 */
export const wifIdentifiersSchema = v.strictObject({
  federationRuleId: v.pipe(v.string(), v.regex(/^fdrl_[A-Za-z0-9]{1,64}$/)),
  organizationId: v.pipe(v.string(), v.uuid()),
  serviceAccountId: v.pipe(v.string(), v.regex(/^svac_[A-Za-z0-9]{1,64}$/)),
  workspaceId: v.pipe(v.string(), v.regex(/^wrkspc_[A-Za-z0-9]{1,64}$/)),
});

/** What the owner enters in the Claude Console, and the identifiers saved here. */
export const manageClaudeSchema = v.strictObject({
  version: v.literal(1),
  console: v.strictObject({
    /** Null while the operator has not configured this service's OIDC issuer. */
    issuer: v.nullable(v.pipe(v.string(), v.url())),
    /** The federation rule's exact subject: `owner:<ownerId>`. */
    subject: v.pipe(v.string(), v.startsWith("owner:")),
    audience: v.pipe(v.string(), v.url()),
  }),
  /** Null when none are saved, or when the saved row no longer validates. */
  identifiers: v.nullable(wifIdentifiersSchema),
  /** A row is saved but no longer validates; the owner enters the identifiers again. */
  storedInvalid: v.boolean(),
});
/** Replaces the owner's identifiers. */
export const manageClaudeWriteSchema = v.strictObject({
  version: v.literal(1),
  identifiers: wifIdentifiersSchema,
});

const httpStatus = v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599));
/**
 * The outcome of one token exchange with the saved identifiers. The token itself never
 * leaves the service.
 */
export const manageClaudeTestSchema = v.strictObject({
  version: v.literal(1),
  result: v.variant("status", [
    v.strictObject({
      status: v.literal("ready"),
      /** How long Anthropic said the token lasts. */
      expiresInSeconds: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    v.strictObject({
      status: v.picklist(["not_configured", "stored_invalid", "issuer_unavailable"]),
    }),
    v.strictObject({ status: v.literal("rejected"), httpStatus }),
    v.strictObject({ status: v.literal("failed"), httpStatus: v.optional(httpStatus) }),
  ]),
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
  /**
   * Settings and Claude identifiers belong to an account with a paired device; this
   * identity has none.
   */
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
export type ManageRecipes = v.InferOutput<typeof manageRecipesSchema>;
export type WifIdentifiers = v.InferOutput<typeof wifIdentifiersSchema>;
export type ManageClaude = v.InferOutput<typeof manageClaudeSchema>;
export type ManageClaudeWrite = v.InferOutput<typeof manageClaudeWriteSchema>;
export type ManageClaudeTest = v.InferOutput<typeof manageClaudeTestSchema>;
export type ManageErrorCode = v.InferOutput<typeof manageErrorCodeSchema>;
export type ManageError = v.InferOutput<typeof manageErrorSchema>;
