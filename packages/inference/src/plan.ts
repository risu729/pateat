import {
  actionRoles,
  genericSlotIdSchema,
  loginStepSchema,
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
  | "mixed-groups";

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

/** True when a slot may be filled into this element; registration passwords never qualify. */
export const slotAccepts = (kind: SemanticSlot["kind"], candidate: ObservedCandidate) =>
  slotFitsRole(kind, candidate.role) &&
  candidate.autocomplete !== "new-password" &&
  (kind !== "hidden" || hiddenAccepts(candidate));

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
  const candidates = new Map(observation.candidates.map((candidate) => [candidate.id, candidate]));
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
    if (!slotAccepts(slot.kind, candidate)) return { ok: false, reason: "incompatible-role" };
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

/**
 * One more identifier set the page shows for the same sign-in (ADR 0027), such as a
 * contract number beside a branch and account number: its own fields and action.
 */
export type PageAlternative = Pick<PagePlan, "fields" | "action">;
/** The generation role's page plan: the primary set, and any other sets as alternatives. */
export type GeneratedPagePlan = PagePlan & { alternatives?: PageAlternative[] | undefined };
/** A validated page plan whose alternatives become the password route's other variants. */
export type ValidatedGeneratedPage = ValidatedPagePlan & { alternatives?: ValidatedPagePlan[] };
export type GeneratedPageRejection =
  | PlanRejection
  /** A requested slot was given another recipe slot name in another set. */
  | "inconsistent-slot-name"
  /** Two sets fill the same slots, or one set's slots are a subset of another's. */
  | "duplicate-variant"
  /** A page with several sets has a set whose action advances instead of submitting. */
  | "variant-advance";

/** At most 3 alternatives, so a password route has at most 4 variants (ADR 0027). */
export const MAX_PAGE_ALTERNATIVES = 3;

/**
 * Validates a generated page plan with its alternatives (ADR 0027). Each set must pass
 * {@link validatePagePlan} on its own. Across the sets, a requested slot keeps one recipe
 * slot name and two requested slots never share one, no set's slots repeat or are a subset
 * of another's, every action submits, and the account switch is none of their elements.
 * Any failure refuses the whole plan, so a recipe never stores a set that was not checked.
 */
export function validateGeneratedPage(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
  draft: GeneratedPagePlan,
): { ok: true; plan: ValidatedGeneratedPage } | { ok: false; reason: GeneratedPageRejection } {
  const { alternatives = [], ...primaryDraft } = draft;
  const primary = validatePagePlan(observation, slots, primaryDraft);
  if (!primary.ok || alternatives.length === 0) return primary;
  if (alternatives.length > MAX_PAGE_ALTERNATIVES)
    return { ok: false, reason: "duplicate-variant" };
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
