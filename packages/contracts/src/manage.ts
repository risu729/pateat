import * as v from "valibot";
import { deviceIdSchema } from "./enrollment";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  settingsDocumentBytes,
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
  "internal_error",
]);
export const manageErrorSchema = v.strictObject({ error: manageErrorCodeSchema });

export type ManageDevice = v.InferOutput<typeof manageDeviceSchema>;
export type ManageDevices = v.InferOutput<typeof manageDevicesSchema>;
export type ManageSettingsWrite = v.InferOutput<typeof manageSettingsWriteSchema>;
export type ManageErrorCode = v.InferOutput<typeof manageErrorCodeSchema>;
export type ManageError = v.InferOutput<typeof manageErrorSchema>;
