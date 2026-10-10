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

const textLength = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1024));

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
  // Page-declared input constraints. Lengths are UTF-16 code units, as HTML counts them.
  // The extractor omits a length outside 1-1024 (0, absent or effectively unbounded
  // values such as 524288), omits both when minlength exceeds maxlength, and omits
  // lengths on number inputs, where browsers ignore them, so one odd attribute never
  // rejects the whole observation. Constraints appear only on fill roles. `pattern` is deliberately absent:
  // evaluating a page-supplied expression locally could hang the caller.
  maxLength: v.optional(textLength),
  minLength: v.optional(textLength),
  inputMode: v.optional(
    v.picklist(["none", "text", "decimal", "numeric", "tel", "search", "email", "url"]),
  ),
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
  v.check(
    (observation) =>
      observation.candidates.every(
        ({ minLength, maxLength }) =>
          minLength === undefined || maxLength === undefined || minLength <= maxLength,
      ),
    "minLength exceeds maxLength",
  ),
  v.check(
    (observation) =>
      observation.candidates.every(
        ({ role, maxLength, minLength }) =>
          (maxLength === undefined && minLength === undefined) ||
          (role !== "number" && (fillRoles as readonly string[]).includes(role)),
      ) &&
      observation.candidates.every(
        ({ role, inputMode }) =>
          inputMode === undefined || (fillRoles as readonly string[]).includes(role),
      ),
    "Input constraints apply only to fill roles; lengths not to number inputs",
  ),
);

/** Character classes of a value shape, in their canonical order. */
export const valueCharacterClasses = [
  "ascii-digit",
  "ascii-letter",
  "ascii-symbol",
  "fullwidth",
  "space",
  "other",
] as const;

/**
 * Coarse shape of a visible identifier value (ADR 0010): its UTF-16 length, the
 * character classes it contains in canonical order, and whether it is email-shaped.
 * It never carries characters or their positions.
 */
export const valueShapeSchema = v.strictObject({
  length: textLength,
  classes: v.pipe(
    v.array(v.picklist(valueCharacterClasses)),
    v.minLength(1),
    v.check(
      (classes) =>
        classes.every(
          (entry, index) =>
            index === 0 ||
            valueCharacterClasses.indexOf(entry) >
              valueCharacterClasses.indexOf(classes[index - 1]!),
        ),
      "Use unique classes in canonical order",
    ),
  ),
  email: v.boolean(),
});

/**
 * A semantic slot the caller wants mapped. Values and account bindings never enter
 * inference. `fieldName` is the user's name for an allowed vault field; `valueShape`
 * is allowed only on identifier slots backed by a visible value (ADR 0010).
 */
export const semanticSlotSchema = v.pipe(
  v.strictObject({
    id: identifier,
    kind: v.picklist(["identifier", "secret", "one-time-code"]),
    description: observedText,
    fieldName: v.optional(observedText),
    valueShape: v.optional(valueShapeSchema),
  }),
  v.check(
    (slot) => slot.valueShape === undefined || slot.kind === "identifier",
    "Only identifier slots may carry a value shape",
  ),
);
export const semanticSlotsSchema = v.pipe(
  v.array(semanticSlotSchema),
  v.minLength(1),
  v.maxLength(8),
  v.check((slots) => unique(slots.map((slot) => slot.id)), "Duplicate slots"),
);

export type LoginObservation = v.InferOutput<typeof loginObservationSchema>;
export type ObservedCandidate = v.InferOutput<typeof observedCandidateSchema>;
export type SemanticSlot = v.InferOutput<typeof semanticSlotSchema>;
export type ValueShape = v.InferOutput<typeof valueShapeSchema>;
