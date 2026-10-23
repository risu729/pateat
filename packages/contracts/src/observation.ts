import {
  detailLength,
  loginMarkerTargetSchema,
  loginOriginSchema,
  loginStepSchema,
  sameLoginTarget,
  type LoginMarkerTarget,
} from "./login";
import { recipeSlotIdSchema, type DetailFormat, type LoginDetail } from "./settings";
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
/** The header and navigation text of a signed-in page (ADR 0029), up to 1,000 characters. */
const observedHeaderText = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1000),
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

/**
 * The path segment every observation carries in place of one that may hold a session ID,
 * a tenant or account ID or another token (ADR 0029, extended to every page by ADR 0039),
 * such as Cloudflare's `/<account ID>/home`, sent as `/[id]/home`. Recipes are stored
 * under such a path, and the extension compares a live page with them through it.
 */
export const REDACTED_PATH_SEGMENT = "[id]";

/**
 * Element roles an observation may describe. Fill roles accept a slot value; action
 * roles are clicked. Links and checkboxes are context (a reset or sign-up link), except
 * that a recipe's account switch may be a link.
 */
export const fillRoles = ["text", "email", "tel", "number", "password"] as const;
export const actionRoles = ["button"] as const;
export const candidateRoleSchema = v.picklist([...fillRoles, ...actionRoles, "link", "checkbox"]);

const textLength = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1024));

/**
 * Autofill field names (WHATWG HTML) for personal details: names, organization, postal
 * address, birthday, sex and telephone parts. A sign-up form asks for them and a sign-in
 * form rarely does, so the plan check reads one in a form as a sign-up signal (ADR 0018).
 * A sign-in by phone number marked `tel` is therefore refused a lone `new-password`
 * field, a conservative choice.
 */
export const personalDataAutocompleteTokens = [
  "name",
  "honorific-prefix",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-suffix",
  "nickname",
  "organization-title",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level4",
  "address-level3",
  "address-level2",
  "address-level1",
  "country",
  "country-name",
  "postal-code",
  "bday",
  "bday-day",
  "bday-month",
  "bday-year",
  "sex",
  "tel",
  "tel-country-code",
  "tel-national",
  "tel-area-code",
  "tel-local",
  "tel-local-prefix",
  "tel-local-suffix",
  "tel-extension",
] as const;
/** The autofill field names an observation carries, besides `off`. */
export const observedAutocompleteTokens = [
  "username",
  "email",
  "current-password",
  "new-password",
  "one-time-code",
  ...personalDataAutocompleteTokens,
] as const;

/** One allowlisted, value-free page element. The ID is local to this observation. */
export const observedCandidateSchema = v.strictObject({
  id: identifier,
  role: candidateRoleSchema,
  // A link may be named by its path (`href`) on a signed-in page, as a marker only, and a
  // button by its accessible name there, as a `password` handler's button only.
  target: loginMarkerTargetSchema,
  label: v.optional(observedText),
  placeholder: v.optional(observedText),
  // Text the page ties to a fill-role field with `aria-describedby`, such as a hint that
  // the field takes three digits; left out when it repeats the label.
  description: v.optional(observedText),
  autocomplete: v.optional(v.picklist([...observedAutocompleteTokens, "off"])),
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
    /**
     * The visible text of a signed-in page's header and navigation, redacted as the rest
     * of that page, for the judge (ADR 0029); no other page carries it.
     */
    headerText: v.optional(observedHeaderText),
    /**
     * Up to three short texts a signed-in page shows near its first code field, redacted
     * as the rest of that page, for the judge to tell where the code comes from (ADR
     * 0027); no other page carries it.
     */
    nearCode: v.optional(v.pipe(v.array(observedText), v.minLength(1), v.maxLength(3))),
    /**
     * Up to three short texts a signed-in page without a code field shows near its
     * buttons, redacted as the rest of that page, for the judge to tell what a button
     * whose label says little starts (ADR 0027); no other page carries it.
     */
    nearButtons: v.optional(v.pipe(v.array(observedText), v.minLength(1), v.maxLength(3))),
    // The extractor sets false when it dropped an element a recipe may need; such an
    // observation is rejected rather than relying on a model to guess the rest.
    // Text bounded to its length limit or redacted is not counted as dropped.
    complete: v.boolean(),
    candidates: v.pipe(v.array(observedCandidateSchema), v.maxLength(48)),
    /**
     * The entries of a list of accounts on a page without fields (ADR 0028), as their
     * redacted text, such as `Taro [email] Last used`. Only such a page may have no
     * candidates: its other controls are context for judging it.
     */
    accounts: v.optional(v.pipe(v.array(observedText), v.minLength(1), v.maxLength(8))),
    /**
     * How many of the listed accounts are entries Pateat can click itself (ADR 0028); the
     * others are shown beside separate buttons, so only the list's `continue` or `other`
     * button leads on from them.
     */
    accountEntries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8))),
  }),
  v.check(
    (observation) =>
      observation.accountEntries === undefined ||
      (observation.accounts !== undefined &&
        observation.accountEntries <= observation.accounts.length),
    "Account entries need a list of accounts",
  ),
  v.check(
    (observation) => observation.candidates.length > 0 || observation.accounts !== undefined,
    "An observation needs candidates or an account list",
  ),
  v.check(
    (observation) => observation.nearCode === undefined || observation.candidates.some(isCodeField),
    "Text near a code field needs a code field",
  ),
  v.check(
    (observation) =>
      observation.nearButtons === undefined ||
      (!observation.candidates.some(isCodeField) &&
        observation.candidates.some((candidate) => candidate.role === "button")),
    "Text near buttons needs a button and no code field",
  ),
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
        ({ role, inputMode, description }) =>
          (inputMode === undefined && description === undefined) ||
          (fillRoles as readonly string[]).includes(role),
      ),
    "Input constraints and descriptions apply only to fill roles; lengths not to number inputs",
  ),
  v.check(
    (observation) =>
      observation.candidates.every(
        ({ role, target }) => target.by !== "text" || role === "button" || role === "link",
      ),
    "Text locators apply only to buttons and links",
  ),
  v.check(
    (observation) =>
      observation.candidates.every(
        ({ role, target }) =>
          (target.by !== "autocomplete" &&
            target.by !== "label" &&
            target.by !== "password-form-name") ||
          (fillRoles as readonly string[]).includes(role),
      ),
    "Autocomplete, label and password-form name locators apply only to fields",
  ),
  // Only a signed-in page's description offers one, for a button that may go on to the
  // password (ADR 0048 amendment of 2026-10-19).
  v.check(
    (observation) =>
      observation.candidates.every(
        ({ role, target }) => target.by !== "accessible-name" || role === "button",
      ),
    "Accessible-name locators apply only to buttons",
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

const fieldCount = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000));

/**
 * A semantic slot the caller wants mapped. Values and account bindings are never part of
 * the model's input; the service matches a slot to the owner's saved bindings only to
 * keep their slot names (ADR 0027). `fieldName` is the user's name for an allowed vault
 * field, with `fieldPosition` among the item's custom fields of that name when several
 * share it (ADR 0013, ADR 0027). `hidden` is a Bitwarden Hidden custom field, filled
 * under the Hidden rule of ADR 0013. `valueShape` is allowed only on identifier slots
 * backed by a visible value (ADR 0010), so never on secret, hidden or one-time-code slots.
 */
export const semanticSlotSchema = v.pipe(
  v.strictObject({
    id: identifier,
    kind: v.picklist(["identifier", "secret", "hidden", "one-time-code"]),
    description: observedText,
    fieldName: v.optional(observedText),
    fieldPosition: v.optional(
      v.strictObject({ position: fieldCount, count: v.pipe(fieldCount, v.minValue(2)) }),
    ),
    valueShape: v.optional(valueShapeSchema),
  }),
  v.check(
    (slot) => slot.valueShape === undefined || slot.kind === "identifier",
    "Only identifier slots may carry a value shape",
  ),
  v.check(
    (slot) =>
      slot.fieldPosition === undefined ||
      (slot.fieldName !== undefined && slot.fieldPosition.position <= slot.fieldPosition.count),
    "A field position needs a field name and must be within its count",
  ),
);
export const semanticSlotsSchema = v.pipe(
  v.array(semanticSlotSchema),
  v.minLength(1),
  v.maxLength(20),
  v.check((slots) => unique(slots.map((slot) => slot.id)), "Duplicate slots"),
  v.check(
    (slots) =>
      unique(
        slots.flatMap(({ fieldName, fieldPosition }) =>
          fieldName === undefined
            ? []
            : [JSON.stringify([fieldName, fieldPosition?.position, fieldPosition?.count])],
        ),
      ),
    "Duplicate vault fields",
  ),
);

/** Slot IDs a custom-field slot may not take, in any case: the built-in slots keep theirs. */
export const reservedSlotIds = ["username", "password", "totp"] as const;
/**
 * The recipe slot ID of a custom-field slot (ADR 0027): any recipe slot ID other than a
 * built-in slot's, compared without case.
 */
export const customSlotIdSchema = v.pipe(
  recipeSlotIdSchema,
  v.check(
    (value) => !(reservedSlotIds as readonly string[]).includes(value.toLowerCase()),
    "Use a slot ID other than a built-in slot",
  ),
);

export type LoginObservation = v.InferOutput<typeof loginObservationSchema>;
export type ObservedCandidate = v.InferOutput<typeof observedCandidateSchema>;
export type SemanticSlot = v.InferOutput<typeof semanticSlotSchema>;
export type ValueShape = v.InferOutput<typeof valueShapeSchema>;

/**
 * Slot meanings the extension sends for generation, one per built-in vault login field.
 * The real-page corpus sends the same ones, so its benchmark matches production.
 */
export const builtInLoginSlots = {
  username: {
    id: "username",
    kind: "identifier",
    description: "account username, email address or login ID",
  },
  password: { id: "password", kind: "secret", description: "account password" },
  totp: { id: "totp", kind: "one-time-code", description: "one-time authentication code" },
} as const satisfies Record<string, SemanticSlot>;

/**
 * Descriptions of custom-field slots by kind (ADR 0027). The field name carries the
 * meaning, so the description only says where the value comes from. The real-page corpus
 * sends the same ones.
 */
export const customFieldSlotDescriptions = {
  identifier: "value of the user's vault field named in fieldName",
  secret: "secret value of the user's vault field named in fieldName",
  hidden: "concealed value of the user's vault field named in fieldName, such as a PIN",
  "one-time-code": "one-time code from the user's vault field named in fieldName",
} as const satisfies Record<SemanticSlot["kind"], string>;

/**
 * Whether the executor would fill a TOTP code into this element (ADR 0013, the extension's
 * `acceptsSecret`): `autocomplete="one-time-code"`, or a numeric, tel or number input whose
 * `maxlength` is 1 to 10. Observations omit lengths on number inputs, so a number input
 * counts only with the autocomplete hint.
 */
export function isCodeField(candidate: ObservedCandidate): boolean {
  return (
    candidate.autocomplete === "one-time-code" ||
    ((candidate.inputMode === "numeric" ||
      candidate.role === "tel" ||
      candidate.role === "number") &&
      candidate.maxLength !== undefined &&
      candidate.maxLength >= 1 &&
      candidate.maxLength <= 10)
  );
}

/**
 * The inputs of a code split into one input per digit that `field` is one of (ADR 0027,
 * owner decision 2026-10-12 19:21 UTC), in page order: every fill-role input of its form
 * that {@link isCodeField} accepts, when there are 6 to 8, each takes one character
 * (`maxlength` 1) and each has an attribute or visible-name locator. Undefined for any
 * other field.
 */
export function splitCodeInputs(
  page: Pick<LoginObservation, "candidates">,
  field: ObservedCandidate,
): ObservedCandidate[] | undefined {
  const inputs = page.candidates.filter(
    (candidate) =>
      candidate.group === field.group &&
      (fillRoles as readonly string[]).includes(candidate.role) &&
      isCodeField(candidate),
  );
  return inputs.includes(field) &&
    inputs.length >= 6 &&
    inputs.length <= 8 &&
    inputs.every((input) => input.maxLength === 1 && input.target.by !== "text")
    ? inputs
    : undefined;
}

/**
 * Whether `field` and `button` of this page may be a `totp` handler's code field and the
 * button that submits it (ADR 0027): a fill-role input located by an attribute or its
 * visible name (ADR 0037) that
 * {@link isCodeField} accepts, either with at least 6 characters when it limits them and
 * the only such input in its form, or the first of a code split into one input per digit
 * ({@link splitCodeInputs}), which the executor fills one digit per input; and a button
 * of that form, or no button on a page that submits the code once it is in (ADR 0027
 * amendment of 2026-10-23). The judge and the recipe assembly both check this.
 */
export function isTotpCode(
  page: Pick<LoginObservation, "candidates">,
  field: ObservedCandidate,
  button: ObservedCandidate | undefined,
): boolean {
  return totpCodeRefusal(page, field, button) === undefined;
}

/**
 * Why {@link isTotpCode} refuses `field` and `button`, for the log, or undefined when it
 * accepts them: the field is no fill-role input (`not-input`), is located by its text
 * (`text-locator`), is no code input (`not-code-field`), limits the code below 6
 * characters (`code-too-short`), is one of several code inputs of its form that are no
 * split code, or not the first of one (`several-code-fields`), or the button is no button
 * (`submit-not-button`) or not of the field's form (`submit-other-form`). Without a button,
 * the field's form must show none (`submit-unnamed`): a form with a button is taken to
 * submit the code with it, so a code typed there without its click would wait for the
 * person.
 */
export function totpCodeRefusal(
  page: Pick<LoginObservation, "candidates">,
  field: ObservedCandidate,
  button: ObservedCandidate | undefined,
): string | undefined {
  if (!(fillRoles as readonly string[]).includes(field.role)) return "not-input";
  if (field.target.by === "text") return "text-locator";
  if (!isCodeField(field)) return "not-code-field";
  const split = splitCodeInputs(page, field);
  if (split) {
    if (split[0] !== field) return "several-code-fields";
  } else {
    if (field.maxLength !== undefined && field.maxLength < 6) return "code-too-short";
    if (
      page.candidates.some(
        (other) => other !== field && other.group === field.group && isCodeField(other),
      )
    )
      return "several-code-fields";
  }
  if (!button)
    return field.group !== undefined &&
      page.candidates.some(
        (candidate) => candidate.role === "button" && candidate.group === field.group,
      )
      ? "submit-unnamed"
      : undefined;
  if (button.role !== "button") return "submit-not-button";
  if (button.group !== field.group) return "submit-other-form";
  return undefined;
}

/**
 * The input roles each detail's fill rule admits; `card-code` also limits the length, and
 * a value written with `/` or `-` never goes into a number input, which takes digits only.
 */
function admitsDetail(
  { detail, format }: { detail: LoginDetail; format?: DetailFormat | undefined },
  field: ObservedCandidate,
): boolean {
  if (field.role === "number" && format !== undefined && /[/-]/u.test(format)) return false;
  if (detail === "card-code")
    return (
      field.role === "password" ||
      ((field.role === "text" || field.role === "tel") &&
        (field.maxLength === 3 || field.maxLength === 4))
    );
  if (detail === "secret-answer") return field.role === "text" || field.role === "password";
  if (detail === "card-number" || detail === "pin")
    return ["password", "text", "tel", "number"].includes(field.role);
  return ["text", "tel", "number"].includes(field.role);
}

/**
 * Why `field` and `button` of this page may not be a `detail` handler's input for
 * `entry` and the button that submits it (ADR 0061), for the log, or undefined when they
 * may. The field must be an input the detail's fill rule admits (`not-input`): a text,
 * tel or number input for a birth date, the last four digits, a card's expiry date or a
 * member ID, but no number input for a format with `/` or `-`; a password input, or a
 * text or tel input limited to 3 or 4 characters, for a card's security code; a password,
 * text, tel or number input for a whole card number or a PIN; a text or password input
 * for a secret question's answer. No other detail takes a password input, so a second
 * password the judge takes for the last four digits is not kept. It must not be located
 * by its text (`text-locator`), an answer not by its label (`label-locator`), nor be
 * marked as a sign-in, email or code field (`sign-in-field`), nor declare a `maxlength`
 * shorter than the value (`too-short`); the button must be a button (`submit-not-button`)
 * of the field's form (`submit-other-form`). The judge and the recipe assembly both
 * check this.
 */
export function detailInputRefusal(
  entry: { detail: LoginDetail; format?: DetailFormat | undefined },
  field: ObservedCandidate,
  button: ObservedCandidate,
): string | undefined {
  const admitted = admitsDetail(entry, field);
  if (!admitted) return "not-input";
  if (field.target.by === "text") return "text-locator";
  // An answer's label may be the account's own question, which a shared recipe never holds.
  if (entry.detail === "secret-answer" && field.target.by === "label") return "label-locator";
  if (
    field.autocomplete === "username" ||
    field.autocomplete === "email" ||
    field.autocomplete === "current-password" ||
    field.autocomplete === "new-password" ||
    field.autocomplete === "one-time-code"
  )
    return "sign-in-field";
  if (field.maxLength !== undefined && field.maxLength < detailLength(entry)) return "too-short";
  if (button.role !== "button") return "submit-not-button";
  if (button.group !== field.group) return "submit-other-form";
  return undefined;
}

/**
 * Whether a page that still shows one of `fillTargets`, a route's fill fields, also shows
 * another form beside them that a `detail` handler may be learned from (ADR 0061): a
 * text, tel or number input that is none of `fillTargets`, in a form other than every
 * shown fill field's, with a button in that form. The extension sends such a page with
 * `beside`, and the service judges it only then.
 */
export function showsBesideForm(
  page: Pick<LoginObservation, "candidates">,
  fillTargets: readonly LoginMarkerTarget[],
): boolean {
  const fill = (candidate: ObservedCandidate) =>
    fillTargets.some((target) => sameLoginTarget(target, candidate.target));
  const groups = page.candidates.filter(fill).map((candidate) => candidate.group);
  if (!groups.length) return false;
  return page.candidates.some(
    (input) =>
      (input.role === "text" || input.role === "tel" || input.role === "number") &&
      input.group !== undefined &&
      !fill(input) &&
      !groups.includes(input.group) &&
      page.candidates.some((button) => button.role === "button" && button.group === input.group),
  );
}

/** Whether the page shows an input the executor would fill a TOTP code into. */
export function showsCodeField(observation: Pick<LoginObservation, "candidates">): boolean {
  return observation.candidates.some(isCodeField);
}

/**
 * The slots offered for a page: one-time-code slots only when the page shows a code field,
 * so the slots never tell the model whether an account has TOTP (ADR 0027).
 */
export function slotsForPage(
  observation: Pick<LoginObservation, "candidates">,
  slots: readonly SemanticSlot[],
): SemanticSlot[] {
  const code = showsCodeField(observation);
  return slots.filter((slot) => code || slot.kind !== "one-time-code");
}
