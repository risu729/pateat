import {
  actionRoles,
  customSlotIdSchema,
  fillRoles,
  namesPasskey,
  registersPasskey,
  isCodeField,
  isStepTarget,
  loginStepSchema,
  personalDataAutocompleteTokens,
  recipeSlotIdSchema,
  reservedSlotIds,
  sameLoginTarget,
  type LoginEntryRecipe,
  type LoginObservation,
  type LoginStep,
  type LoginTarget,
  type ObservedCandidate,
  type SavedLoginBinding,
  type SemanticSlot,
} from "@pateat/contracts";
import * as v from "valibot";

/**
 * A role's proposal for the observed page, expressed in observation-local candidate
 * IDs. It becomes executable steps only after {@link validatePagePlan}.
 */
export type PagePlan = {
  fields: { slot: string; candidate: string }[];
  action: { candidate: string; purpose: "advance" | "submit" };
  /** The button or link that switches to another account, when the page offers one. */
  accountSwitch?: string | undefined;
};

export type PlanRejection =
  | "empty-plan"
  | "unknown-slot"
  | "unknown-candidate"
  | "duplicate-slot"
  | "duplicate-candidate"
  | "incompatible-role"
  | "mixed-groups"
  /**
   * A secret went into a sign-in form's lone `new-password` field, but the plan fills no
   * identifier of that form ({@link loneNewPassword}).
   */
  | "lone-new-password";

/**
 * A plan whose steps fill each field under its recipe slot: for a custom-field slot the
 * `name` {@link customSlotNames} gave it, otherwise the requested slot ID. `fields[].slot`
 * stays the requested ID.
 */
export type ValidatedPagePlan = Omit<PagePlan, "fields"> & {
  fields: { slot: string; candidate: string; name?: string }[];
  steps: LoginStep[];
  switchTarget?: LoginTarget;
};

const compatibleRoles: Record<SemanticSlot["kind"], readonly ObservedCandidate["role"][]> = {
  identifier: ["text", "email", "tel", "number"],
  secret: ["password"],
  hidden: ["password", "text", "tel"],
  "one-time-code": ["text", "tel", "number"],
};

/** True when a slot kind may be filled into an observed element role. */
export const slotFitsRole = (kind: SemanticSlot["kind"], role: ObservedCandidate["role"]) =>
  compatibleRoles[kind].includes(role);

/**
 * The Hidden fill rule of ADR 0013 as far as an observation shows it: a password input,
 * or a short numeric input (`type=tel`, or a text input with `inputmode=numeric`) whose
 * `maxlength` is 1 to 10. Observations omit lengths on number inputs, so a number input
 * is refused here although the executor would accept one.
 */
const hiddenAccepts = (candidate: ObservedCandidate) =>
  candidate.role === "password" ||
  ((candidate.role === "tel" || (candidate.role === "text" && candidate.inputMode === "numeric")) &&
    candidate.maxLength !== undefined &&
    candidate.maxLength <= 10);

/**
 * True when a slot may be filled into this element; registration passwords never qualify
 * here, though {@link slotAcceptsOn} takes a lone one on a sign-in form. A one-time code
 * goes only where the executor fills a TOTP code (ADR 0013).
 */
export const slotAccepts = (kind: SemanticSlot["kind"], candidate: ObservedCandidate) =>
  slotFitsRole(kind, candidate.role) &&
  candidate.autocomplete !== "new-password" &&
  (kind !== "hidden" || hiddenAccepts(candidate)) &&
  (kind !== "one-time-code" || isCodeField(candidate));

const personalData = new Set<string>(personalDataAutocompleteTokens);
/** Autocomplete values an identifier beside a lone `new-password` field may carry. */
const signInIdentifierHints = new Set<ObservedCandidate["autocomplete"]>([
  undefined,
  "off",
  "username",
  "email",
]);
/** Whether an element could hold a sign-in identifier next to a lone `new-password` field. */
const signInIdentifier = (candidate: ObservedCandidate) =>
  slotAccepts("identifier", candidate) && signInIdentifierHints.has(candidate.autocomplete);

/**
 * Whether a password input marked `autocomplete="new-password"` may still take a
 * password, as on a sign-in form that marks its only password field so (owner decision,
 * 2026-10-12, ADR 0018). Read from the page alone; {@link validatePagePlan} also needs
 * the plan to fill an identifier beside it. All must hold:
 *
 * 1. It is the only password field of its form: no other input of the group is a
 *    password input or marked `current-password` or `new-password`, so there is no
 *    confirmation field.
 * 2. No input of its form carries a personal-data autocomplete token
 *    ({@link personalDataAutocompleteTokens}), which only a sign-up form asks for.
 * 3. No input of its form is marked `one-time-code`, as on a password-reset form.
 * 4. No input outside its form shows a sign-in, as the judge reads one
 *    (`createCompletionJudge`): a password input other than a `new-password` one, or an
 *    input marked `username`, `current-password` or `one-time-code`. On such a page that
 *    form signs in, and the lone field belongs to a sign-up form.
 * 5. Its form holds an input that can take an identifier and is marked `username`,
 *    `email`, `off` or nothing. The checks above already refuse every other token the
 *    observation carries today; this filter keeps any token added later out as well.
 *
 * Fields outside any form count as one form, as in plan validation.
 */
export function loneNewPassword(
  page: Pick<LoginObservation, "candidates">,
  candidate: ObservedCandidate,
): boolean {
  if (candidate.role !== "password" || candidate.autocomplete !== "new-password") return false;
  const others = page.candidates.filter((other) => other.id !== candidate.id);
  const form = others.filter((other) => other.group === candidate.group);
  return (
    !form.some(
      (other) =>
        other.role === "password" ||
        other.autocomplete === "current-password" ||
        other.autocomplete === "new-password",
    ) &&
    !form.some((other) => personalData.has(other.autocomplete ?? "")) &&
    !form.some((other) => other.autocomplete === "one-time-code") &&
    !others.some(
      (other) =>
        other.group !== candidate.group &&
        ((other.role === "password" && other.autocomplete !== "new-password") ||
          other.autocomplete === "username" ||
          other.autocomplete === "current-password" ||
          other.autocomplete === "one-time-code"),
    ) &&
    form.some(signInIdentifier)
  );
}

/**
 * {@link slotAccepts} on this page: a password or Hidden slot may also go into a lone
 * `new-password` field of a sign-in form ({@link loneNewPassword}).
 */
export const slotAcceptsOn = (
  page: Pick<LoginObservation, "candidates">,
  kind: SemanticSlot["kind"],
  candidate: ObservedCandidate,
) =>
  slotAccepts(kind, candidate) ||
  ((kind === "secret" || kind === "hidden") && loneNewPassword(page, candidate));

/** True when an observed element can carry the page action. */
export const isActionRole = (role: ObservedCandidate["role"]) =>
  (actionRoles as readonly string[]).includes(role);

/**
 * The form a button outside every form presses for: the one form the plan's fields share,
 * when that form shows no button of its own and no field outside every form is on the
 * page, so the button can only be one the extractor kept beside a password form
 * (`besideDepth`). Sakura Internet's login button follows its form so (2026-10-23).
 * Undefined for any other action, which presses for its own group.
 */
export function besideForm(
  page: Pick<LoginObservation, "candidates">,
  fields: readonly ObservedCandidate[],
  action: ObservedCandidate,
): string | undefined {
  if (action.group !== undefined) return undefined;
  const groups = new Set(fields.map((field) => field.group));
  const [group] = groups;
  if (groups.size !== 1 || group === undefined) return undefined;
  return page.candidates.some(
    (candidate) =>
      (candidate.group === group && isActionRole(candidate.role)) ||
      (candidate.group === undefined && (fillRoles as readonly string[]).includes(candidate.role)),
  )
    ? undefined
    : group;
}

/** The longest recipe slot ID (`recipeSlotIdSchema`). */
const MAX_SLOT_NAME = 60;
/** The marks the extractor leaves in observed text in place of what it redacted. */
const redactedText = /\[(?:number|email|masked|account)\]/u;
/**
 * NFKC without invisible characters (`Default_Ignorable_Code_Point`, such as variation
 * selectors and the Hangul filler), with whitespace collapsed to single spaces and trimmed.
 */
const tidy = (text: string) =>
  text
    .normalize("NFKC")
    .replaceAll(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
/** `text` cut to at most `length` UTF-16 units, never inside a character, then trimmed. */
function cut(text: string, length: number): string {
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > length) break;
    kept += character;
  }
  return kept.trimEnd();
}
/**
 * A field's label without a trailing copy of its placeholder or description, as a
 * `<label>` that also holds the hint `半角数字3桁` gives `店番 半角数字3桁`. A copy that
 * continues a Latin word or number, as `word` in `Keyword`, stays.
 */
function ownLabel(label: string, hints: readonly (string | undefined)[]): string {
  let own = label;
  for (const hint of hints) {
    if (!hint || own.length <= hint.length || !own.endsWith(hint)) continue;
    const rest = own.slice(0, -hint.length);
    if (/[A-Za-z0-9]$/u.test(rest) && /^[A-Za-z0-9]/u.test(hint)) continue;
    own = rest.trimEnd();
  }
  return own;
}
/**
 * The page's own name for a field, for its custom-field slot (ADR 0027): the first of its
 * label, placeholder, description and `id`, `name` or test ID locator value that gives a
 * name. Each is taken in NFKC without invisible characters and with whitespace collapsed
 * (`tidy`), the label without a trailing copy of the placeholder or description
 * (`ownLabel`), and cut to 60 characters. Text that redaction marked or that holds a
 * number anywhere, even past the cut, gives none, as a label locator's (ADR 0037), so a
 * value the page shows back never becomes a slot ID.
 */
function fieldText(candidate: ObservedCandidate): string | undefined {
  const placeholder = candidate.placeholder && tidy(candidate.placeholder);
  const description = candidate.description && tidy(candidate.description);
  const { by, value } = candidate.target;
  const sources = [
    candidate.label && ownLabel(tidy(candidate.label), [placeholder, description]),
    placeholder,
    description,
    by === "id" || by === "name" || by === "test-id" ? tidy(value) : undefined,
  ];
  for (const source of sources) {
    // Checked whole, so a mark or number past the cut still skips the text.
    if (!source || redactedText.test(source) || /\p{Number}/u.test(source)) continue;
    const text = cut(source, MAX_SLOT_NAME);
    if (v.is(recipeSlotIdSchema, text)) return text;
  }
  return undefined;
}
const fold = (name: string) => name.toLowerCase();

/**
 * The slot name each custom-field request slot carries from the owner's saved bindings of
 * the recipe being generated (ADR 0027, amended 2026-10-19): the `slot` of the binding
 * entries whose field is the slot's custom field, by the same name and, for a duplicate
 * name, the same position and count. A field the bindings give different names, as two
 * accounts may, carries none, and built-in fields (`username`, `password`, `totp`) are
 * never matched. Only slot names and field references are read; a name is checked where
 * it is used ({@link customSlotNames}).
 */
export function carriedSlotNames(
  slots: readonly Pick<SemanticSlot, "id" | "fieldName" | "fieldPosition">[],
  bindings: readonly Pick<SavedLoginBinding, "slots">[],
): Map<string, string> {
  const carried = new Map<string, string>();
  for (const { id, fieldName, fieldPosition } of slots) {
    if (fieldName === undefined) continue;
    const names = new Set(
      bindings.flatMap((binding) =>
        binding.slots.flatMap(({ slot, field }) =>
          typeof field === "object" &&
          field.custom === fieldName &&
          field.position === fieldPosition?.position &&
          field.count === fieldPosition?.count
            ? [slot]
            : [],
        ),
      ),
    );
    const [name, ...others] = names;
    if (name !== undefined && others.length === 0) carried.set(id, name);
  }
  return carried;
}

/**
 * The recipe slot ID of each custom-field slot (one with a `fieldName`) the sets fill,
 * from the page's own text for its element (ADR 0027): `fieldText`, or else `field N` on
 * an English page and `欄 N` on another, N counting the page's fill fields without a name
 * from the top. A slot that fills different elements in different sets is named from its
 * element in the first set that fills it. Without case, a name never equals a built-in
 * slot or a requested slot ID, nor another of the names, which are given in page order:
 * a later one takes a number after a space (`店番 2`). The model's answer never names a
 * slot, so neither the owner's field names nor the model's words become slot IDs, and,
 * without `carried`, an unchanged page always gives the same names. Fields of unknown
 * candidates are left out.
 *
 * `carried` holds the names the owner's saved bindings give request slots
 * ({@link carriedSlotNames}, ADR 0027 amended 2026-10-19). Each one that is a custom-field
 * slot ID and, without case, equals no built-in slot or requested slot ID is reserved
 * before any page text, whether or not this page fills its slot, so a page name equal to
 * one is numbered apart and a later page can still carry it. A filled slot keeps its
 * carried name unless another filled slot carries the same name, when both are named
 * from the page.
 */
export function customSlotNames(
  observation: Pick<LoginObservation, "language" | "candidates">,
  slots: readonly Pick<SemanticSlot, "id" | "fieldName">[],
  sets: readonly Pick<PagePlan, "fields">[],
  carried: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const custom = new Set(slots.flatMap((slot) => (slot.fieldName === undefined ? [] : [slot.id])));
  const at = new Map(observation.candidates.map((candidate, index) => [candidate.id, index]));
  const elements = new Map<string, number>();
  for (const field of sets.flatMap((set) => set.fields)) {
    const index = at.get(field.candidate);
    if (custom.has(field.slot) && index !== undefined && !elements.has(field.slot))
      elements.set(field.slot, index);
  }
  const unnamed = observation.candidates.filter(
    (candidate) =>
      (fillRoles as readonly string[]).includes(candidate.role) &&
      fieldText(candidate) === undefined,
  );
  const fallback = observation.language === "en" ? "field" : "欄";
  const taken = new Set([...reservedSlotIds, ...slots.map((slot) => slot.id)].map(fold));
  const names = new Map<string, string>();
  // Every request slot's valid carried name, filled here or not, by its folded form.
  const claims = new Map<string, string[]>();
  for (const slot of custom) {
    const name = carried.get(slot);
    if (name === undefined || !v.is(customSlotIdSchema, name) || taken.has(fold(name))) continue;
    claims.set(fold(name), [...(claims.get(fold(name)) ?? []), slot]);
  }
  for (const [name, claimants] of claims) {
    taken.add(name);
    const filled = claimants.filter((slot) => elements.has(slot));
    if (filled.length === 1) names.set(filled[0]!, carried.get(filled[0]!)!);
  }
  for (const [slot, index] of [...elements].sort((left, right) => left[1] - right[1])) {
    if (names.has(slot)) continue;
    const candidate = observation.candidates[index]!;
    const base = fieldText(candidate) ?? `${fallback} ${unnamed.indexOf(candidate) + 1}`;
    let name = base;
    for (let count = 2; taken.has(fold(name)); count += 1)
      name = `${cut(base, MAX_SLOT_NAME - ` ${count}`.length)} ${count}`;
    taken.add(fold(name));
    names.set(slot, name);
  }
  return names;
}

/**
 * Local semantic validation shared by every role. Model output never reaches the
 * executor without passing these checks and the shared recipe step contract. Each
 * custom-field slot is filled under its name in `names`, by default the one
 * {@link customSlotNames} gives it on this plan alone.
 */
export function validatePagePlan(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
  plan: PagePlan,
  names: ReadonlyMap<string, string> = customSlotNames(observation, slots, [plan]),
): { ok: true; plan: ValidatedPagePlan } | { ok: false; reason: PlanRejection } {
  if (plan.fields.length === 0) return { ok: false, reason: "empty-plan" };
  // A link named by its path is only ever a signed-in marker (ADR 0029), and a button named
  // by its accessible name only a `password` handler's (ADR 0048), never a step's.
  const candidates = new Map(
    observation.candidates.flatMap(({ target, ...candidate }) =>
      isStepTarget(target) ? [[candidate.id, { ...candidate, target }] as const] : [],
    ),
  );
  const requested = new Map(slots.map((slot) => [slot.id, slot]));
  const usedSlots = new Set<string>();
  const usedCandidates = new Set<string>();
  for (const field of plan.fields) {
    const slot = requested.get(field.slot);
    if (slot === undefined) return { ok: false, reason: "unknown-slot" };
    const candidate = candidates.get(field.candidate);
    if (candidate === undefined) return { ok: false, reason: "unknown-candidate" };
    if (usedSlots.has(field.slot)) return { ok: false, reason: "duplicate-slot" };
    if (usedCandidates.has(field.candidate)) return { ok: false, reason: "duplicate-candidate" };
    if (!slotAcceptsOn(observation, slot.kind, candidate))
      return { ok: false, reason: "incompatible-role" };
    usedSlots.add(field.slot);
    usedCandidates.add(field.candidate);
  }
  // A custom-field slot is stored under the name the page gives it, so no path copies the
  // vault's field names into the recipe (ADR 0027); a page's label may still read the same.
  const nameOf = (slot: string) =>
    requested.get(slot)!.fieldName === undefined ? undefined : names.get(slot);
  const action = candidates.get(plan.action.candidate);
  if (action === undefined) return { ok: false, reason: "unknown-candidate" };
  if (usedCandidates.has(action.id)) return { ok: false, reason: "duplicate-candidate" };
  if (!isActionRole(action.role)) return { ok: false, reason: "incompatible-role" };
  // One plan must stay within a single form: every filled element and the action share
  // one group, or none has a group. A grouped field with an ungrouped action fails closed,
  // unless the action is the button beside a form without one of its own (`besideForm`).
  const filledCandidates = plan.fields.map((field) => candidates.get(field.candidate)!);
  const groups = new Set([...filledCandidates, action].map((candidate) => candidate.group));
  if (groups.size > 1 && besideForm(observation, filledCandidates, action) === undefined)
    return { ok: false, reason: "mixed-groups" };
  // A secret in a lone `new-password` field also needs the plan to fill an identifier of
  // the same form there, so a form that asks for a new password alone is never signed up
  // with.
  if (
    plan.fields.some(
      (field) => !slotAccepts(requested.get(field.slot)!.kind, candidates.get(field.candidate)!),
    ) &&
    !plan.fields.some(
      (field) =>
        requested.get(field.slot)!.kind === "identifier" &&
        signInIdentifier(candidates.get(field.candidate)!),
    )
  )
    return { ok: false, reason: "lone-new-password" };
  // The switch is clicked instead of signing in: a button or link the plan does not use.
  const accountSwitch =
    plan.accountSwitch === undefined ? undefined : candidates.get(plan.accountSwitch);
  if (plan.accountSwitch !== undefined) {
    if (accountSwitch === undefined) return { ok: false, reason: "unknown-candidate" };
    if (usedCandidates.has(accountSwitch.id) || accountSwitch.id === action.id)
      return { ok: false, reason: "duplicate-candidate" };
    if (!isActionRole(accountSwitch.role) && accountSwitch.role !== "link")
      return { ok: false, reason: "incompatible-role" };
  }

  const steps = v.parse(v.array(loginStepSchema), [
    {
      kind: "fill",
      path: observation.path,
      fields: plan.fields.map((field) => ({
        slot: nameOf(field.slot) ?? field.slot,
        target: candidates.get(field.candidate)!.target,
      })),
    },
    { kind: "click", path: observation.path, target: action.target, purpose: plan.action.purpose },
  ]);
  return {
    ok: true,
    plan: {
      fields: plan.fields.map((field) => {
        const name = nameOf(field.slot);
        return { slot: field.slot, candidate: field.candidate, ...(name ? { name } : {}) };
      }),
      action: { candidate: plan.action.candidate, purpose: plan.action.purpose },
      ...(accountSwitch
        ? { accountSwitch: accountSwitch.id, switchTarget: accountSwitch.target }
        : {}),
      steps,
    },
  };
}

/**
 * The purpose of a plan's action, read from the page instead of taken from the model
 * (owner, 2026-10-22, #834): a click after only identifiers advances unless its form (or,
 * for an action outside any form, the form it presses for, {@link besideForm}, else every
 * input outside one) also shows a password or code
 * input the plan leaves empty, which the click would then submit; any other click submits. A plan that names an unknown slot or candidate keeps `fallback`, for
 * {@link validatePagePlan} to refuse.
 */
export function actionPurpose(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
  plan: Pick<PagePlan, "fields"> & { action: { candidate: string } },
  fallback: PagePlan["action"]["purpose"],
): PagePlan["action"]["purpose"] {
  const action = observation.candidates.find((candidate) => candidate.id === plan.action.candidate);
  const kinds = plan.fields.map((field) => slots.find((slot) => slot.id === field.slot)?.kind);
  if (action === undefined || kinds.includes(undefined)) return fallback;
  if (kinds.some((kind) => kind !== "identifier")) return "submit";
  const filled = new Set(plan.fields.map((field) => field.candidate));
  const fields = observation.candidates.filter((candidate) => filled.has(candidate.id));
  const group = besideForm(observation, fields, action) ?? action.group;
  return observation.candidates.some(
    (candidate) =>
      candidate.group === group &&
      !filled.has(candidate.id) &&
      (candidate.role === "password" ||
        ((fillRoles as readonly string[]).includes(candidate.role) && isCodeField(candidate))),
  )
    ? "submit"
    : "advance";
}

export { namesPasskey, registersPasskey } from "@pateat/contracts";

/**
 * One more identifier set the page shows for the same sign-in (ADR 0027), such as a
 * contract number beside a branch and account number: its own fields and action.
 */
export type PageAlternative = Pick<PagePlan, "fields" | "action">;
/**
 * The generation role's page plan: the primary set, any other sets as alternatives, and
 * the button that signs in with a passkey instead (ADR 0027).
 */
export type GeneratedPagePlan = PagePlan & {
  alternatives?: PageAlternative[] | undefined;
  passkeyButton?: string | undefined;
};
/**
 * A validated page plan whose alternatives become the password route's other variants and
 * whose passkey button, kept only when it passes {@link validateGeneratedPage}'s checks,
 * becomes the `passkey` route.
 */
export type ValidatedGeneratedPage = ValidatedPagePlan & {
  alternatives?: ValidatedPagePlan[];
  passkeyButton?: string;
  passkeyTarget?: LoginTarget;
  passkeyOnly?: true;
};
export type GeneratedPageRejection =
  | PlanRejection
  /** One element is filled under different recipe slots in different sets. */
  | "inconsistent-candidate"
  /**
   * Two sets fill the same slots or the same elements, or one set's slots are a subset of
   * another's.
   */
  | "duplicate-variant"
  /** More alternatives than {@link MAX_PAGE_ALTERNATIVES}. */
  | "too-many-variants"
  /** A page with several sets has a set whose action advances instead of submitting. */
  | "variant-advance"
  /** An account-list answer that failed {@link validateAccountList} (ADR 0028). */
  | AccountListRejection
  /** A request with slots was answered with a sign-in entry (ADR 0031). */
  | "unexpected-entry";

/**
 * A generated page plan reduced to what the request log may keep of it once the checks
 * refused it (ADR 0012): candidate and slot references the request holds stay and any
 * other becomes `?`. A string the model chose may quote the page or the user's field
 * names, which the plan itself must never carry.
 */
export function redactGeneratedPage(
  observation: Pick<LoginObservation, "candidates">,
  slots: readonly Pick<SemanticSlot, "id">[],
  draft: GeneratedPagePlan,
): GeneratedPagePlan {
  const candidates = new Set(observation.candidates.map((candidate) => candidate.id));
  const slotIds = new Set(slots.map((slot) => slot.id));
  const candidate = (id: string) => (candidates.has(id) ? id : "?");
  const set = ({ fields, action }: PageAlternative): PageAlternative => ({
    fields: fields.map((field) => ({
      slot: slotIds.has(field.slot) ? field.slot : "?",
      candidate: candidate(field.candidate),
    })),
    action: { candidate: candidate(action.candidate), purpose: action.purpose },
  });
  return {
    ...set(draft),
    ...(draft.accountSwitch === undefined ? {} : { accountSwitch: candidate(draft.accountSwitch) }),
    ...(draft.alternatives === undefined ? {} : { alternatives: draft.alternatives.map(set) }),
    ...(draft.passkeyButton === undefined ? {} : { passkeyButton: candidate(draft.passkeyButton) }),
  };
}

/** At most 3 alternatives, so a password route has at most 4 variants (ADR 0027). */
export const MAX_PAGE_ALTERNATIVES = 3;

/**
 * The passkey sign-in button a generated plan named (ADR 0027), kept only when it is a
 * button of the page whose label or locator names a passkey or security key, that no set
 * fills or submits with, is not the account switch, and does not read as registering a
 * passkey. Anything else is dropped without failing the
 * plan, as the judge adds no handler for a button it cannot use.
 */
function passkeyButtonOf(
  observation: LoginObservation,
  plans: readonly ValidatedPagePlan[],
  candidateId: string | undefined,
): { passkeyButton: string; passkeyTarget: LoginTarget } | undefined {
  if (candidateId === undefined) return undefined;
  const button = observation.candidates.find((candidate) => candidate.id === candidateId);
  if (
    !button ||
    button.role !== "button" ||
    !isStepTarget(button.target) ||
    !namesPasskey(button) ||
    registersPasskey(button)
  )
    return undefined;
  const used = plans.flatMap((plan) => [
    ...plan.fields.map((field) => field.candidate),
    plan.action.candidate,
    ...(plan.accountSwitch === undefined ? [] : [plan.accountSwitch]),
  ]);
  // Compared by locator too, so two candidates with one locator are never both used.
  if (
    used.some((id) => {
      const other = observation.candidates.find((candidate) => candidate.id === id);
      return (
        id === button.id || (other !== undefined && sameLoginTarget(other.target, button.target))
      );
    })
  )
    return undefined;
  return { passkeyButton: button.id, passkeyTarget: button.target };
}

/**
 * Validates a generated page plan with its alternatives (ADR 0027). Custom-field slots are
 * named over all the sets ({@link customSlotNames}), so a requested slot keeps one recipe
 * slot name in every set and two never share one. Each set must pass
 * {@link validatePagePlan} on its own. Across the sets, an element is filled under one
 * recipe slot only, no set's slots repeat or are a subset of another's, no two sets fill
 * the same elements, every action submits, and the account switch is none of their
 * elements. An ambiguous mapping therefore abstains instead of becoming two variants.
 * Any failure refuses the whole plan, so a recipe never stores a set that was not checked.
 * A passkey button that fails its own checks is dropped instead (`passkeyButtonOf`).
 * A plan stored without alternatives (none answered, or dropped on another page) takes
 * its action's purpose from {@link actionPurpose}, not from the model.
 *
 * Only a start page keeps alternatives and a passkey button (ADR 0027). On another page
 * (`startPage` false) the alternatives are still checked but dropped, as is the passkey
 * button, and the slots are named from the first set alone, so a stored name never
 * depends on a set that is not stored. `carried` holds the names the owner's saved
 * bindings give the request's custom-field slots ({@link carriedSlotNames}).
 */
export function validateGeneratedPage(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
  draft: GeneratedPagePlan,
  startPage = true,
  carried: ReadonlyMap<string, string> = new Map(),
): { ok: true; plan: ValidatedGeneratedPage } | { ok: false; reason: GeneratedPageRejection } {
  if (slots.length === 0) {
    const button = observation.candidates.find(
      (candidate) => candidate.id === draft.action.candidate,
    );
    if (
      observation.accounts !== undefined ||
      observation.candidates.some((candidate) =>
        (fillRoles as readonly string[]).includes(candidate.role),
      ) ||
      draft.fields.length ||
      draft.alternatives?.length ||
      draft.accountSwitch !== undefined ||
      draft.action.purpose !== "submit" ||
      draft.passkeyButton !== button?.id ||
      !button ||
      button.role !== "button" ||
      !isStepTarget(button.target) ||
      !namesPasskey(button) ||
      registersPasskey(button)
    )
      return { ok: false, reason: "empty-plan" };
    return {
      ok: true,
      plan: {
        fields: [],
        action: draft.action,
        passkeyButton: button.id,
        passkeyTarget: button.target,
        passkeyOnly: true,
        steps: [
          { kind: "click", path: observation.path, target: button.target, purpose: "submit" },
        ],
      },
    };
  }
  const { passkeyButton, ...answered } = draft;
  // With alternatives every set submits, so only a lone set's purpose is read from the page.
  const sets = answered.alternatives?.length
    ? answered
    : {
        ...answered,
        action: {
          ...answered.action,
          purpose: actionPurpose(observation, slots, answered, answered.action.purpose),
        },
      };
  const validated = validateGeneratedSets(observation, slots, sets, startPage, carried);
  if (!validated.ok) return validated;
  if (!startPage) {
    const { alternatives: _alternatives, ...plan } = validated.plan;
    // Only the first set is stored, so its purpose is read from the page as a lone set's.
    const purpose = actionPurpose(observation, slots, plan, plan.action.purpose);
    return {
      ok: true,
      plan: {
        ...plan,
        action: { ...plan.action, purpose },
        steps: plan.steps.map((step) => (step.kind === "click" ? { ...step, purpose } : step)),
      },
    };
  }
  const passkey = passkeyButtonOf(
    observation,
    [validated.plan, ...(validated.plan.alternatives ?? [])],
    passkeyButton,
  );
  return { ok: true, plan: { ...validated.plan, ...passkey } };
}

function validateGeneratedSets(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
  draft: Omit<GeneratedPagePlan, "passkeyButton">,
  startPage: boolean,
  carried: ReadonlyMap<string, string>,
): { ok: true; plan: ValidatedGeneratedPage } | { ok: false; reason: GeneratedPageRejection } {
  const { alternatives = [], ...primaryDraft } = draft;
  const names = customSlotNames(
    observation,
    slots,
    startPage ? [primaryDraft, ...alternatives] : [primaryDraft],
    carried,
  );
  const primary = validatePagePlan(observation, slots, primaryDraft, names);
  if (!primary.ok || alternatives.length === 0) return primary;
  if (alternatives.length > MAX_PAGE_ALTERNATIVES)
    return { ok: false, reason: "too-many-variants" };
  const validated: ValidatedPagePlan[] = [];
  for (const alternative of alternatives) {
    const result = validatePagePlan(
      observation,
      slots,
      { fields: alternative.fields, action: alternative.action },
      names,
    );
    if (!result.ok) return result;
    validated.push(result.plan);
  }
  const plans = [primary.plan, ...validated];
  // One recipe slot per element, over every set.
  const filledAs = new Map<string, string>();
  for (const field of plans.flatMap((plan) => plan.fields)) {
    const name = field.name ?? field.slot;
    if ((filledAs.get(field.candidate) ?? name) !== name)
      return { ok: false, reason: "inconsistent-candidate" };
    filledAs.set(field.candidate, name);
  }
  const filled = plans.map((plan) => new Set(plan.fields.map((field) => field.candidate)));
  if (
    filled.some((set, index) =>
      filled.some(
        (other, otherIndex) =>
          otherIndex !== index && set.size === other.size && [...set].every((c) => other.has(c)),
      ),
    )
  )
    return { ok: false, reason: "duplicate-variant" };
  const sets = plans.map((plan) => plan.fields.map((field) => field.slot));
  if (
    sets.some((set, index) =>
      sets.some(
        (other, otherIndex) => otherIndex !== index && set.every((slot) => other.includes(slot)),
      ),
    )
  )
    return { ok: false, reason: "duplicate-variant" };
  if (plans.some((plan) => plan.action.purpose !== "submit"))
    return { ok: false, reason: "variant-advance" };
  const accountSwitch = primary.plan.accountSwitch;
  if (
    accountSwitch !== undefined &&
    validated.some(
      (plan) =>
        plan.action.candidate === accountSwitch ||
        plan.fields.some((field) => field.candidate === accountSwitch),
    )
  )
    return { ok: false, reason: "duplicate-candidate" };
  return { ok: true, plan: { ...primary.plan, alternatives: validated } };
}

/**
 * The generation role's answer that a page lists accounts to choose from (ADR 0028):
 * the control that continues without a listed account (`other`) and the one that
 * continues with the one account shown beside it (`continue`), as candidate IDs. The
 * model never picks an account.
 */
export type GeneratedAccountList = {
  other?: string | undefined;
  continue?: string | undefined;
};
/** A list control the extension clicks, with the locator the chooser recipe stores. */
type ListControl = {
  candidate: string;
  target: Exclude<LoginTarget, { by: "autocomplete" | "label" | "accessible-name" }>;
};
/** An account list whose named controls passed {@link validateAccountList}. */
export type ValidatedAccountList = {
  accountList: true;
  other?: ListControl;
  continue?: ListControl;
};
export type AccountListRejection =
  /** The page lists no accounts, or lists some and the answer is a form plan. */
  | "unexpected-account-list"
  | "unexpected-plan"
  | "unknown-candidate"
  | "duplicate-candidate"
  | "incompatible-role"
  /** A control's text holds an email address, a masked value or a long number. */
  | "account-text"
  /**
   * No control is named, and no listed account is an entry Pateat can click, so the list
   * could never lead on.
   */
  | "no-list-control";

/**
 * Text the observation shows in place of an address, a masked value or a run of four or
 * more digits; a control holding one may be an account, which is never clicked as `other`
 * or `continue`.
 */
const accountText = /\[(?:email|masked|number|account)\]|@|\d{4}/u;

/**
 * Validates an account-list answer (ADR 0028): the page must list accounts, and each named
 * control must be a button or link of the page, not hold account text and not be the
 * other control. A list whose accounts are all shown beside buttons needs a named
 * control. Its locator is never `autocomplete` or `label`, which name only inputs, nor
 * `accessible-name`, which names only a `password` handler's button.
 */
export function validateAccountList(
  observation: LoginObservation,
  draft: GeneratedAccountList,
): { ok: true; list: ValidatedAccountList } | { ok: false; reason: AccountListRejection } {
  if (!observation.accounts) return { ok: false, reason: "unexpected-account-list" };
  const control = (id: string | undefined): ListControl | AccountListRejection | undefined => {
    if (id === undefined) return undefined;
    const candidate = observation.candidates.find((entry) => entry.id === id);
    if (!candidate) return "unknown-candidate";
    const { target } = candidate;
    if (
      (!isActionRole(candidate.role) && candidate.role !== "link") ||
      !isStepTarget(target) ||
      target.by === "autocomplete" ||
      target.by === "label"
    )
      return "incompatible-role";
    if (
      [candidate.label, target.value].some((text) => text !== undefined && accountText.test(text))
    )
      return "account-text";
    return { candidate: candidate.id, target };
  };
  const other = control(draft.other);
  const shown = control(draft.continue);
  for (const result of [other, shown])
    if (typeof result === "string") return { ok: false, reason: result };
  const named = [other, shown].filter((entry): entry is ListControl => typeof entry === "object");
  // Without an entry to click, only a named control leads on from the list.
  if (named.length === 0 && observation.accountEntries === 0)
    return { ok: false, reason: "no-list-control" };
  if (
    named.length === 2 &&
    (named[0]!.candidate === named[1]!.candidate ||
      sameLoginTarget(named[0]!.target, named[1]!.target))
  )
    return { ok: false, reason: "duplicate-candidate" };
  return {
    ok: true,
    list: {
      accountList: true,
      ...(typeof other === "object" ? { other } : {}),
      ...(typeof shown === "object" ? { continue: shown } : {}),
    },
  };
}

/** An account-list answer reduced to references the request holds, for the request log. */
export function redactAccountList(
  observation: Pick<LoginObservation, "candidates">,
  draft: GeneratedAccountList,
): GeneratedAccountList {
  const candidate = (id: string) =>
    observation.candidates.some((entry) => entry.id === id) ? id : "?";
  return {
    ...(draft.other === undefined ? {} : { other: candidate(draft.other) }),
    ...(draft.continue === undefined ? {} : { continue: candidate(draft.continue) }),
  };
}

/**
 * The locator a sign-in entry is pressed by: never `autocomplete`, `label` or
 * `accessible-name` (ADR 0031).
 */
export type EntryTarget = LoginEntryRecipe["entry"]["target"];
/**
 * The generation role's entry answer (ADR 0031): the candidate that opens sign-in to an
 * existing account on a page without a login form, and its locator.
 */
export type ValidatedEntry = { entry: string; target: EntryTarget };
export type EntryRejection = Extract<
  GeneratedPageRejection,
  "unknown-candidate" | "incompatible-role" | "account-text"
>;

/**
 * Checks the candidate an entry answer names (ADR 0031): a candidate of the page, a
 * `link` (only an `<a href>` link is pressed), located by `id`, `name`, `test-id` or
 * `text`, and with no label or locator value that may name an account, by ADR 0028's
 * rule for the `other` button (`accountText`).
 */
export function validateEntry(
  observation: Pick<LoginObservation, "candidates">,
  candidateId: string,
): { ok: true; entry: ValidatedEntry } | { ok: false; reason: EntryRejection } {
  const candidate = observation.candidates.find((entry) => entry.id === candidateId);
  if (candidate === undefined) return { ok: false, reason: "unknown-candidate" };
  const { target } = candidate;
  if (
    candidate.role !== "link" ||
    !isStepTarget(target) ||
    target.by === "autocomplete" ||
    target.by === "label"
  )
    return { ok: false, reason: "incompatible-role" };
  if ([candidate.label, target.value].some((text) => text !== undefined && accountText.test(text)))
    return { ok: false, reason: "account-text" };
  return { ok: true, entry: { entry: candidate.id, target } };
}

/**
 * An entry answer reduced to what the request log may keep of it once refused: the
 * candidate ID when the request holds it, otherwise `?` (as {@link redactGeneratedPage}).
 */
export const redactEntry = (
  observation: Pick<LoginObservation, "candidates">,
  candidateId: string,
) => ({
  decision: "entry" as const,
  entry: observation.candidates.some((candidate) => candidate.id === candidateId)
    ? candidateId
    : "?",
});
