import { loginOriginSchema, loginStepSchema, loginTargetSchema } from "@pateat/contracts";
import * as v from "valibot";

const identifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
// Observed text is untrusted page content. Bound it and forbid control, format
// (including bidirectional overrides) and line/paragraph separator characters;
// redacting private label text is the extractor's responsibility.
const observedText = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u),
);
const path = v.pipe(
  v.string(),
  v.check(
    (value) =>
      v.safeParse(loginStepSchema, {
        kind: "assert",
        path: value,
        target: { by: "id", value: "probe" },
        present: true,
      }).success,
    "Use an exact canonical path",
  ),
);
const unique = (values: string[]) => new Set(values).size === values.length;

/** Element roles an observation may describe. Fill roles accept a slot value; action roles are clicked. */
export const fillRoles = ["text", "email", "tel", "number", "password"] as const;
export const actionRoles = ["button", "link"] as const;
export const candidateRoleSchema = v.picklist([...fillRoles, ...actionRoles, "checkbox"]);

/** One allowlisted, value-free page element. The ID is local to this observation. */
export const observedCandidateSchema = v.strictObject({
  id: identifier,
  role: candidateRoleSchema,
  target: loginTargetSchema,
  label: v.optional(observedText),
  placeholder: v.optional(observedText),
  autocomplete: v.optional(
    v.picklist(["username", "email", "current-password", "new-password", "one-time-code", "off"]),
  ),
  group: v.optional(identifier),
});

/**
 * Proposed sanitized pre-fill observation for inference. It carries structure and
 * bounded labels only: no values, hidden inputs, raw HTML, query strings or media.
 */
export const loginObservationSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    origin: loginOriginSchema,
    path,
    language: v.picklist(["ja", "en", "mixed"]),
    title: v.optional(observedText),
    headings: v.optional(v.pipe(v.array(observedText), v.maxLength(8))),
    // The extractor sets false when it dropped eligible elements or text; such an
    // observation is rejected rather than relying on a model to guess the rest.
    complete: v.boolean(),
    candidates: v.pipe(v.array(observedCandidateSchema), v.minLength(1), v.maxLength(48)),
  }),
  v.check(
    (observation) => unique(observation.candidates.map((candidate) => candidate.id)),
    "Duplicate candidate IDs",
  ),
  v.check(
    (observation) =>
      unique(observation.candidates.map((candidate) => JSON.stringify(candidate.target))),
    "Duplicate candidate targets",
  ),
);

/** A semantic slot the caller wants mapped. Values and account bindings never enter inference. */
export const semanticSlotSchema = v.strictObject({
  id: identifier,
  kind: v.picklist(["identifier", "secret", "one-time-code"]),
  description: observedText,
});
export const semanticSlotsSchema = v.pipe(
  v.array(semanticSlotSchema),
  v.minLength(1),
  v.maxLength(8),
  v.check((slots) => unique(slots.map((slot) => slot.id)), "Duplicate slots"),
);

export type LoginObservation = v.InferOutput<typeof loginObservationSchema>;
export type ObservedCandidate = v.InferOutput<typeof observedCandidateSchema>;
export type SemanticSlot = v.InferOutput<typeof semanticSlotSchema>;
