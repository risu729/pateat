import * as v from "valibot";

// Device pairing contracts shared by the service and the extension (ADR 0020). The
// extension's background sends one `POST /pair` carrying the owner's login session;
// the service answers with the device credential exactly once and keeps only its hash.

export const deviceCredentialSchema = v.pipe(
  v.string(),
  v.regex(/^pateat_device_[A-Za-z0-9_-]{43}$/),
);
export const deviceIdSchema = v.pipe(v.string(), v.uuid());
/**
 * A device credential expires after this long without an authenticated use; each
 * use renews it. There is no absolute lifetime.
 */
export const DEVICE_IDLE_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * A letter, digit, punctuation mark or symbol that shows: what keeps a device name from
 * looking blank. Default-ignorable ones such as the Hangul filler U+3164, and the blank
 * Braille pattern U+2800, show nothing.
 */
export const VISIBLE_LABEL_CHARACTER =
  /(?![\p{Default_Ignorable_Code_Point}\u2800])[\p{L}\p{N}\p{P}\p{S}]/u;

export const deviceLabelSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(64),
  // Control characters, lone surrogates, line and paragraph separators and text-direction
  // marks are refused. Other format characters stay, as emoji need joiners and tags.
  v.regex(
    /^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}]+$/u,
    "Labels cannot contain control characters, line breaks or text-direction marks",
  ),
  // A name of invisible characters alone would show as blank.
  v.regex(VISIBLE_LABEL_CHARACTER, "Labels need a visible character"),
);

/** A Chrome extension ID: the first 128 bits of the key's SHA-256 as letters `a`-`p`. */
export const extensionIdSchema = v.pipe(v.string(), v.regex(/^[a-p]{32}$/));

/** An owner's settings profile (ADR 0024); names follow device labels' rules. */
export const profileIdSchema = deviceIdSchema;
export const profileNameSchema = deviceLabelSchema;
export const profileSchema = v.strictObject({ id: profileIdSchema, name: profileNameSchema });
export const profilesSchema = v.strictObject({
  version: v.literal(1),
  profiles: v.array(profileSchema),
});
export const profileCreateSchema = v.strictObject({
  version: v.literal(1),
  name: profileNameSchema,
  copyFrom: profileIdSchema,
});
export const profileRenameSchema = v.strictObject({
  version: v.literal(1),
  name: profileNameSchema,
});
export const deviceProfileSchema = v.strictObject({
  version: v.literal(1),
  profileId: profileIdSchema,
});

export const devicePairRequestSchema = v.strictObject({
  version: v.literal(1),
  label: deviceLabelSchema,
  /**
   * The profile an existing owner's device takes; `newProfile` names one to create for
   * it instead. A first pairing names neither (ADR 0075).
   */
  profileId: v.optional(profileIdSchema),
  newProfile: v.optional(profileNameSchema),
});
/** The credential is returned exactly once; the service keeps only its hash. */
export const devicePairResultSchema = v.strictObject({
  version: v.literal(1),
  deviceId: deviceIdSchema,
  credential: deviceCredentialSchema,
});

export const pairErrorCodeSchema = v.picklist([
  "bad_request",
  /** The owner has profiles; the request must name one or a new one (ADR 0075). */
  "profile_required",
  "profile_not_found",
  /** Another profile of the owner already has the new profile's name. */
  "profile_name_taken",
  /** No login token: the user must sign in to the service first. */
  "unauthorized",
  /** The login token failed verification. */
  "forbidden",
  /** `Origin` is not a listed extension ID. */
  "extension_not_allowed",
  /** The service has no Access configuration. */
  "access_unavailable",
  /** The service's list of extension IDs is empty or malformed. */
  "pairing_unavailable",
  /** Access's signing keys could not be fetched, so no login token can be checked. */
  "access_keys_unavailable",
  "rate_limited",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "internal_error",
]);
export const pairErrorSchema = v.strictObject({
  error: pairErrorCodeSchema,
  /** With the three profile errors: the owner's profiles to choose from. */
  profiles: v.optional(v.array(profileSchema)),
});

export type DevicePairRequest = v.InferOutput<typeof devicePairRequestSchema>;
export type DevicePairResult = v.InferOutput<typeof devicePairResultSchema>;
export type PairErrorCode = v.InferOutput<typeof pairErrorCodeSchema>;
export type PairError = v.InferOutput<typeof pairErrorSchema>;
