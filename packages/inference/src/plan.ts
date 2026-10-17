import {
  actionRoles,
  fillRoles,
  namesPasskey,
  registersPasskey,
  genericSlotIdSchema,
  isCodeField,
  isLoginTarget,
  loginStepSchema,
  personalDataAutocompleteTokens,
  sameLoginTarget,
  type LoginEntryRecipe,
  type LoginObservation,
  type LoginStep,
  type LoginTarget,
  type ObservedCandidate,
  type SemanticSlot,
} from "@pateat/contracts";
import * as v from "valibot";

/**
 * A role's proposal for the observed page, expressed in observation-local candidate
 * IDs. It becomes executable steps only after {@link validatePagePlan}.
 */
export type PagePlan = {
  /**
   * `name` is the generic recipe slot ID the model gave a custom-field slot (ADR 0027),
   * required exactly for slots that carry a `fieldName`.
   */
  fields: { slot: string; candidate: string; name?: string | undefined }[];
  action: { candidate: string; purpose: "advance" | "submit" };
  /** The button or link that switches to another account, when the page offers one. */
  accountSwitch?: string | undefined;
};

export type PlanRejection =
  | "empty-plan"
  | "unknown-slot"
  | "unknown-candidate"
  | "duplicate-slot"
  /** A slot that names a vault field was given no generic name. */
  | "missing-slot-name"
  /** A slot without a vault field name was given a name. */
  | "unexpected-slot-name"
  /** A name that is not a generic slot ID, or that takes a requested slot's ID. */
  | "invalid-slot-name"
  | "duplicate-candidate"
  | "incompatible-role"
  | "mixed-groups"
  /**
   * A secret went into a sign-in form's lone `new-password` field, but the plan fills no
   * identifier of that form ({@link loneNewPassword}).
   */
  | "lone-new-password";

/**
 * A plan whose steps fill each field under its recipe slot: the generic `name` for a
 * custom-field slot, otherwise the requested slot ID. `fields[].slot` stays the
 * requested ID.
 */
export type ValidatedPagePlan = PagePlan & { steps: LoginStep[]; switchTarget?: LoginTarget };

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
 * Local semantic validation shared by every role. Model output never reaches the
 * executor without passing these checks and the shared recipe step contract.
 */
export function validatePagePlan(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
  plan: PagePlan,
): { ok: true; plan: ValidatedPagePlan } | { ok: false; reason: PlanRejection } {
  if (plan.fields.length === 0) return { ok: false, reason: "empty-plan" };
  // A link named by its path is only ever a signed-in marker (ADR 0029), never a step's.
  const candidates = new Map(
    observation.candidates.flatMap(({ target, ...candidate }) =>
      isLoginTarget(target) ? [[candidate.id, { ...candidate, target }] as const] : [],
    ),
  );
  const requested = new Map(slots.map((slot) => [slot.id, slot]));
  const usedSlots = new Set<string>();
  const usedCandidates = new Set<string>();
  /** Recipe slot IDs the steps use: requested IDs and generic names alike. */
  const recipeSlots = new Set<string>();
  for (const field of plan.fields) {
    const slot = requested.get(field.slot);
    if (slot === undefined) return { ok: false, reason: "unknown-slot" };
    const candidate = candidates.get(field.candidate);
    if (candidate === undefined) return { ok: false, reason: "unknown-candidate" };
    if (usedSlots.has(field.slot)) return { ok: false, reason: "duplicate-slot" };
    if (usedCandidates.has(field.candidate)) return { ok: false, reason: "duplicate-candidate" };
    if (!slotAcceptsOn(observation, slot.kind, candidate))
      return { ok: false, reason: "incompatible-role" };
    // A custom-field slot is stored under a generic name the model gave it, so the recipe
    // never carries the owner's field names (ADR 0027).
    if (slot.fieldName !== undefined && field.name === undefined)
      return { ok: false, reason: "missing-slot-name" };
    if (slot.fieldName === undefined && field.name !== undefined)
      return { ok: false, reason: "unexpected-slot-name" };
    if (
      field.name !== undefined &&
      (!v.is(genericSlotIdSchema, field.name) || requested.has(field.name))
    )
      return { ok: false, reason: "invalid-slot-name" };
    const recipeSlot = field.name ?? field.slot;
    if (recipeSlots.has(recipeSlot)) return { ok: false, reason: "duplicate-slot" };
    usedSlots.add(field.slot);
    usedCandidates.add(field.candidate);
    recipeSlots.add(recipeSlot);
  }
  const action = candidates.get(plan.action.candidate);
  if (action === undefined) return { ok: false, reason: "unknown-candidate" };
  if (usedCandidates.has(action.id)) return { ok: false, reason: "duplicate-candidate" };
  if (!isActionRole(action.role)) return { ok: false, reason: "incompatible-role" };
  // One plan must stay within a single form: every filled element and the action share
  // one group, or none has a group. A grouped field with an ungrouped action fails closed.
  const groups = new Set(
    [...plan.fields.map((field) => candidates.get(field.candidate)!), action].map(
      (candidate) => candidate.group,
    ),
  );
  if (groups.size > 1) return { ok: false, reason: "mixed-groups" };
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
        slot: field.name ?? field.slot,
        target: candidates.get(field.candidate)!.target,
      })),
    },
    { kind: "click", path: observation.path, target: action.target, purpose: plan.action.purpose },
  ]);
  return {
    ok: true,
    plan: {
      fields: plan.fields.map((field) => ({
        slot: field.slot,
        candidate: field.candidate,
        ...(field.name === undefined ? {} : { name: field.name }),
      })),
      action: { candidate: plan.action.candidate, purpose: plan.action.purpose },
      ...(accountSwitch
        ? { accountSwitch: accountSwitch.id, switchTarget: accountSwitch.target }
        : {}),
      steps,
    },
  };
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
  /** A requested slot was given another recipe slot name in another set. */
  | "inconsistent-slot-name"
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
 * other becomes `?`; a name that is not a request slot ID becomes `name-1`, `name-2` and
 * so on by first appearance, so equal names stay equal. A string the model chose may
 * quote the page or the user's field names, which the plan itself must never carry.
 */
export function redactGeneratedPage(
  observation: Pick<LoginObservation, "candidates">,
  slots: readonly Pick<SemanticSlot, "id">[],
  draft: GeneratedPagePlan,
): GeneratedPagePlan {
  const candidates = new Set(observation.candidates.map((candidate) => candidate.id));
  const slotIds = new Set(slots.map((slot) => slot.id));
  const candidate = (id: string) => (candidates.has(id) ? id : "?");
  const names = new Map<string, string>();
  const name = (value: string) => {
    if (slotIds.has(value)) return value;
    if (!names.has(value)) names.set(value, `name-${names.size + 1}`);
    return names.get(value)!;
  };
  const set = ({ fields, action }: PageAlternative): PageAlternative => ({
    fields: fields.map((field) => ({
      slot: slotIds.has(field.slot) ? field.slot : "?",
      candidate: candidate(field.candidate),
      ...(field.name === undefined ? {} : { name: name(field.name) }),
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
    !isLoginTarget(button.target) ||
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
 * Validates a generated page plan with its alternatives (ADR 0027). Each set must pass
 * {@link validatePagePlan} on its own. Across the sets, a requested slot keeps one recipe
 * slot name and two requested slots never share one, an element is filled under one recipe
 * slot only, no set's slots repeat or are a subset of another's, no two sets fill the same
 * elements, every action submits, and the account switch is none of their elements. An
 * ambiguous mapping therefore abstains instead of becoming two variants.
 * Any failure refuses the whole plan, so a recipe never stores a set that was not checked.
 * A passkey button that fails its own checks is dropped instead (`passkeyButtonOf`).
 */
export function validateGeneratedPage(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
  draft: GeneratedPagePlan,
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
      !isLoginTarget(button.target) ||
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
  const { passkeyButton, ...sets } = draft;
  const validated = validateGeneratedSets(observation, slots, sets);
  if (!validated.ok) return validated;
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
): { ok: true; plan: ValidatedGeneratedPage } | { ok: false; reason: GeneratedPageRejection } {
  const { alternatives = [], ...primaryDraft } = draft;
  const primary = validatePagePlan(observation, slots, primaryDraft);
  if (!primary.ok || alternatives.length === 0) return primary;
  if (alternatives.length > MAX_PAGE_ALTERNATIVES)
    return { ok: false, reason: "too-many-variants" };
  const validated: ValidatedPagePlan[] = [];
  for (const alternative of alternatives) {
    const result = validatePagePlan(observation, slots, {
      fields: alternative.fields,
      action: alternative.action,
    });
    if (!result.ok) return result;
    validated.push(result.plan);
  }
  const plans = [primary.plan, ...validated];
  // One name per requested slot and one requested slot per name, over every set.
  const names = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const field of plans.flatMap((plan) => plan.fields)) {
    const name = field.name ?? field.slot;
    if ((names.get(field.slot) ?? name) !== name)
      return { ok: false, reason: "inconsistent-slot-name" };
    if ((owners.get(name) ?? field.slot) !== field.slot)
      return { ok: false, reason: "duplicate-slot" };
    names.set(field.slot, name);
    owners.set(name, field.slot);
  }
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
  target: Exclude<LoginTarget, { by: "autocomplete" | "label" }>;
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
 * control. Its locator is never `autocomplete` or `label`, which name only inputs.
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
      !isLoginTarget(target) ||
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

/** The locator a sign-in entry is pressed by: never `autocomplete` or `label` (ADR 0031). */
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
    !isLoginTarget(target) ||
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
