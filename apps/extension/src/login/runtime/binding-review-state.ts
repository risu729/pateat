import * as v from "valibot";
import {
  loginDocumentSchema,
  savedLoginBindingSchema,
  type SavedLoginBinding,
  type SettingsSnapshot,
} from "@pateat/contracts";

export const BINDING_REVIEWS_KEY = "session:pateat.login-binding-reviews.v1";
export const bindingReviewStateSchema = v.strictObject({
  id: v.string(),
  document: loginDocumentSchema,
  path: v.string(),
  url: v.string(),
  topUrl: v.optional(v.string()),
  connectionId: v.string(),
  snapshotId: v.string(),
  policyRevision: v.number(),
  scope: v.string(),
  recipeId: v.string(),
  recipeRevision: v.number(),
  layout: v.optional(v.string()),
  recipeMark: v.string(),
  binding: savedLoginBindingSchema,
  slots: v.array(v.string()),
  replacement: v.optional(savedLoginBindingSchema),
  attemptId: v.optional(v.string()),
});
export type BindingReviewState = v.InferOutput<typeof bindingReviewStateSchema>;
export type BindingIssue = {
  binding: SavedLoginBinding;
  connectionId: string;
  slots: string[];
};

const profileScopeSchema = v.object({
  origin: v.string(),
  deviceId: v.string(),
  profileId: v.string(),
  localWrite: v.optional(v.object({ revision: v.number(), profileId: v.string() })),
});

/** Only the settings base's identity is retained, never its settings or a device credential. */
export function bindingProfileScope(
  value: unknown,
  snapshot: Pick<SettingsSnapshot, "revision" | "changes">,
  device: { origin: string; deviceId: string } | undefined,
): string {
  if (!device) return "local";
  const base = v.parse(profileScopeSchema, value);
  if (base.origin !== device.origin || base.deviceId !== device.deviceId)
    throw new Error("binding-profile-unavailable");
  let profile = base.profileId;
  if (base.localWrite && base.localWrite.revision <= snapshot.revision) {
    // The base is written before the local profile replacement. A different write can
    // take that revision, so the revision alone never proves the new profile landed.
    if (
      !snapshot.changes?.some(
        (change) =>
          change.revision === base.localWrite!.revision && change.cause === "service-sync",
      )
    )
      throw new Error("binding-profile-unavailable");
    profile = base.localWrite.profileId;
  }
  return JSON.stringify([device.origin, device.deviceId, profile]);
}
