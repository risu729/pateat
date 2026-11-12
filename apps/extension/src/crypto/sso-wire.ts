import * as v from "valibot";

export const SSO_METHOD_LIMIT = 32;
export const SSO_CANDIDATE_LIMIT = 2_000;
const uuid = v.pipe(v.string(), v.uuid());
const fieldId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const digest = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));
const origin = v.pipe(
  v.string(),
  v.maxLength(8192),
  v.check((value) => {
    const parsed = URL.parse(value);
    return (
      parsed !== null &&
      ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      parsed.origin === value
    );
  }),
);
export const ssoMethodRefSchema = v.strictObject({
  number: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1_000_000)),
});
export type SsoMethodRef = v.InferOutput<typeof ssoMethodRefSchema>;
export const ssoSourceInputSchema = v.strictObject({
  itemId: uuid,
  allowedFieldIds: v.pipe(v.array(fieldId), v.maxLength(2_000)),
});
export type SsoSourceInput = v.InferOutput<typeof ssoSourceInputSchema>;
export const ssoCandidateInputSchema = v.strictObject({
  /** Ephemeral comparison proof; never persist it or send it to the service. */
  usernameProof: digest,
  candidates: v.pipe(v.array(ssoSourceInputSchema), v.maxLength(SSO_CANDIDATE_LIMIT)),
});
export type SsoCandidateInput = v.InferOutput<typeof ssoCandidateInputSchema>;
const refusal = v.picklist([
  "item-unavailable",
  "field-unreadable",
  "field-type",
  "field-name",
  "duplicate-method",
  "too-many-methods",
  "invalid-value",
  "mixed-forms",
  "url-needs-empty-password",
  "username-missing",
  "uri-unavailable",
]);
export const ssoMethodSchema = v.strictObject({
  method: ssoMethodRefSchema,
  /** Snapshot-bound field ID is not a persistent method reference. */
  fieldId,
  automatic: v.boolean(),
  form: v.picklist(["url", "bracket"]),
  /** Only the bracket label may leave the device; URL origins remain local. */
  label: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  origin: v.optional(origin),
  usernameProof: digest,
});
export type SsoMethod = v.InferOutput<typeof ssoMethodSchema>;
export const ssoMethodsSchema = v.strictObject({
  itemId: uuid,
  snapshotId: uuid,
  /** SHA-256 of the encrypted source; equality is safe to retain locally. */
  sourceEvidence: digest,
  result: v.variant("status", [
    v.strictObject({
      status: v.literal("ready"),
      methods: v.pipe(v.array(ssoMethodSchema), v.maxLength(SSO_METHOD_LIMIT)),
    }),
    v.strictObject({
      status: v.literal("refused"),
      reason: refusal,
      field: v.optional(v.pipe(v.string(), v.maxLength(128))),
    }),
  ]),
});
export type SsoMethods = v.InferOutput<typeof ssoMethodsSchema>;
export const ssoCandidatesSchema = v.strictObject({
  snapshotId: uuid,
  candidates: v.pipe(
    v.array(
      v.strictObject({
        itemId: uuid,
        origins: v.pipe(v.array(origin), v.maxLength(1_000)),
        /** An unevaluated URI prevents treating this item as a complete answer. */
        unavailable: v.optional(refusal),
      }),
    ),
    v.maxLength(SSO_CANDIDATE_LIMIT),
  ),
});
export type SsoCandidates = v.InferOutput<typeof ssoCandidatesSchema>;
