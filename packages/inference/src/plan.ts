import {
  actionRoles,
  genericSlotIdSchema,
  isCodeField,
  loginStepSchema,
  sameLoginTarget,
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

/**
 * True when a slot may be filled into this element; registration passwords never qualify.
 * A one-time code goes only where the executor fills a TOTP code (ADR 0013).
 */
export const slotAccepts = (kind: SemanticSlot["kind"], candidate: ObservedCandidate) =>
  slotFitsRole(kind, candidate.role) &&
  candidate.autocomplete !== "new-password" &&
  (kind !== "hidden" || hiddenAccepts(candidate)) &&
  (kind !== "one-time-code" || isCodeField(candidate));

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
 * Words of a button that registers, adds, sets up, turns on or manages a passkey ("Add a
 * passkey", "Set up security key", "Manage passkeys", "パスキーを登録", "パスキーを設定",
 * "パスキーを有効にする"). The model is told not to name one; this local check also refuses
 * it, and can refuse a sign-in button whose text happens to match. Latin words match whole
 * words, Japanese ones anywhere except 設定済み ("already set up") and 有効な ("valid"),
 * which describe the passkey a sign-in button uses.
 */
const registration =
  /\b(?:add|register|create|set\s*up|new|enrol?l|manage|enable|turn\s*on)\b|登録|追加|作成|設定(?!済)|有効(?!な)|管理/iu;
/**
 * A locator value as words: `addPasskey`, `register_key` and `#set-up-key` read as
 * "add Passkey", "register key" and "set up key".
 */
const words = (value: string) =>
  value.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll(/[^\p{L}\p{N}]+/gu, " ");
/** A label as words: split at anything but letters and digits, never inside a word. */
const labelWords = (value: string) => value.replaceAll(/[^\p{L}\p{N}]+/gu, " ");
/**
 * Whether a button registers, adds, creates or sets up a passkey or security key rather
 * than signing in with one (ADR 0027): its label, its text or its `id`, `name` or test ID
 * locator reads so. Shared by the generated passkey route and the judge's `passkey`
 * handler.
 */
export const registersPasskey = (button: Pick<ObservedCandidate, "label" | "target">) =>
  [button.label, button.target.value].some(
    (text) => text !== undefined && registration.test(words(text)),
  );

/**
 * Words that name a passkey or a security key ("Sign in with a passkey", "Use security
 * key", "パスキーでログイン", `#passkeyLoginButton`), matched case-insensitively. Latin words
 * match whole words of a label, or whole camelCase, kebab or snake parts of a locator, so
 * "MyFido" or "Fidor" in a label never match; Japanese words match anywhere.
 */
const passkeyWording =
  /\b(?:pass\s*keys?|security\s*keys?|webauthn|fido\d*)\b|パスキー|セキュリティー?\s*キー|生体認証/iu;
/**
 * Whether a button's label, text or `id`, `name` or test ID locator names a passkey or a
 * security key (ADR 0027). The generated passkey route keeps only such a button, so a
 * mislabelled "Sign in with Google" never becomes a passkey click; the judge's `passkey`
 * handler may use it later.
 */
export const namesPasskey = (button: Pick<ObservedCandidate, "label" | "target">) =>
  (button.label !== undefined && passkeyWording.test(labelWords(button.label))) ||
  passkeyWording.test(
    button.target.by === "text" ? labelWords(button.target.value) : words(button.target.value),
  );

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
  | "variant-advance";

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
  if (!button || button.role !== "button" || !namesPasskey(button) || registersPasskey(button))
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
