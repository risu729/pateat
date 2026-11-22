import {
  targetValues,
  type LoginObservation,
  type ObservedCandidate,
  type SemanticSlot,
} from "@pateat/contracts";
import type { ValidatedGeneratedPage } from "./plan";

/**
 * A field's text as words: `NewPassword`, `new_password` and `#new-password` read as
 * "New Password", "new password" and "new password".
 */
const fieldWords = (value: string) =>
  value.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll(/[^\p{L}\p{N}]+/gu, " ");
/**
 * Words that name a new value ("New password", "Confirm new password", "New email",
 * "新しいパスワード", "新パスワード", "変更後のパスワード"). Latin words match whole words;
 * 新 matches only where no other kanji before it makes another word, as 更新パスワード
 * ("renewal password") or 刷新.
 */
const newWording = /\bnew\b|新しい|(?<!\p{sc=Han})新(?:規)?\s*(?:パスワード|メール)|変更後/iu;
/**
 * Words that name the password in use now ("Current password", "Old password",
 * "現在のパスワード", "今のパスワード", "旧パスワード").
 */
const currentWording = /\b(?:current|old|existing|present)\b|現在|今の|旧\s*パスワード|これまで/iu;
/**
 * Words that set a value apart from another ("Must differ from your current password",
 * "現在のパスワードと異なるもの"): a text naming the current password with them describes
 * a new one.
 */
const differWording =
  /\b(?:differ(?:s|ent)?|same\s+as|other\s+than|unlike|reuse)\b|異な|違う|同じ|以外/iu;
/** Whether a text, or its words, reads so. */
const textReads = (wording: RegExp, text: string) =>
  wording.test(text) || wording.test(fieldWords(text));
/** An input's texts, the label first, then its `id`, `name` or test ID locator, then its placeholder. */
const textsOf = (candidate: ObservedCandidate) =>
  [candidate.label, ...targetValues(candidate.target), candidate.placeholder].filter(
    (text): text is string => text !== undefined,
  );
/** Whether any text of an input names a new value, whatever else it names. */
const namesNew = (candidate: ObservedCandidate) =>
  textsOf(candidate).some((text) => textReads(newWording, text));

/**
 * What an input reads as, taken from its first text that tells (`textsOf`), so a label
 * outweighs a placeholder: `current` for one that names the current password and no new
 * value, `new` for one that names a new value and not the current password, or the
 * current password beside words that set a value apart from it. A text naming both, or
 * neither, tells nothing.
 */
export function fieldReading(candidate: ObservedCandidate): "current" | "new" | undefined {
  for (const text of textsOf(candidate)) {
    const current = textReads(currentWording, text);
    const fresh = textReads(newWording, text);
    if (current && textReads(differWording, text)) return "new";
    if (current && fresh) continue;
    if (current) return "current";
    if (fresh) return "new";
  }
  return undefined;
}

/**
 * Whether a form sets a new password beside its other fields, read from the page alone
 * (owner, 2026-11-19, ADR 0035): it has two or more password inputs, and one of them is
 * marked `new-password`, names a new value in any text or reads as new
 * ({@link fieldReading}), or it has three or more and
 * one reads as the current password ({@link fieldReading}). Three password inputs
 * without such words, as a login password, a PIN and a second PIN asked before a
 * transfer, are no such form. Undefined for any other form; else `current`, its one
 * input for the password in use now: the one marked `current-password`, else the one
 * reading so, else its first password input unless that one is marked `new-password` or
 * reads as new. A form with two or more candidates by one rule, or none, has no
 * `current`, as a reset form that asks for a new password and its confirmation does, or
 * one that labels its current password only "Password" after the new ones. Fields
 * outside any form count as one form, as in plan validation. No site is named: the rule
 * reads only structure and labels (ADR 0033).
 */
export function passwordChangeForm(
  page: Pick<LoginObservation, "candidates">,
  group: string | undefined,
): { current: string | undefined } | undefined {
  const passwords = page.candidates.filter(
    (candidate) => candidate.role === "password" && candidate.group === group,
  );
  const readings = new Map(passwords.map((candidate) => [candidate, fieldReading(candidate)]));
  if (
    passwords.length < 2 ||
    !(
      passwords.some(
        (candidate) =>
          candidate.autocomplete === "new-password" ||
          namesNew(candidate) ||
          readings.get(candidate) === "new",
      ) ||
      (passwords.length >= 3 &&
        passwords.some((candidate) => readings.get(candidate) === "current"))
    )
  )
    return undefined;
  const one = (found: readonly ObservedCandidate[]) =>
    found.length === 1 ? found[0]!.id : undefined;
  const marked = passwords.filter((candidate) => candidate.autocomplete === "current-password");
  if (marked.length) return { current: one(marked) };
  const named = passwords.filter(
    (candidate) =>
      candidate.autocomplete !== "new-password" && readings.get(candidate) === "current",
  );
  if (named.length) return { current: one(named) };
  const [first] = passwords;
  return {
    current:
      first!.autocomplete === "new-password" || readings.get(first!) === "new"
        ? undefined
        : first!.id,
  };
}

/** The filled candidates of every set of a plan, unknown ones as undefined. */
const filledCandidates = (
  observation: Pick<LoginObservation, "candidates">,
  plan: Pick<ValidatedGeneratedPage, "fields" | "alternatives">,
) => {
  const candidates = new Map(observation.candidates.map((candidate) => [candidate.id, candidate]));
  return [plan, ...(plan.alternatives ?? [])]
    .flatMap((set) => set.fields)
    .map((field) => ({ field, candidate: candidates.get(field.candidate) }));
};

/**
 * The check a `confirm` or `unclear` plan gets beside `validateGeneratedPage` (owner,
 * 2026-11-19, ADR 0035): on a form that also sets a new password
 * ({@link passwordChangeForm}), such as an account form that saves its changes only with
 * the current password, a set may fill only the password slot, and only into that
 * form's current password input. A new password, its confirmation, the form's other
 * fields and a form without a current password input are never filled. On any form, no
 * identifier goes into an input that reads as a new value ({@link fieldReading}), such
 * as a new email beside the current password. Undefined when every set passes.
 */
export function verificationPlanRejection(
  observation: Pick<LoginObservation, "candidates">,
  slots: readonly SemanticSlot[],
  plan: Pick<ValidatedGeneratedPage, "fields" | "alternatives">,
): "password-change-field" | undefined {
  const kinds = new Map(slots.map((slot) => [slot.id, slot.kind]));
  return filledCandidates(observation, plan).some(({ field, candidate }) => {
    if (candidate === undefined) return true;
    // A new email or another new value beside the current password is never filled.
    if (kinds.get(field.slot) === "identifier" && fieldReading(candidate) === "new") return true;
    const form = passwordChangeForm(observation, candidate.group);
    return (
      form !== undefined && (candidate.id !== form.current || kinds.get(field.slot) !== "secret")
    );
  })
    ? "password-change-field"
    : undefined;
}

/** A text as compared with a vault field's name: NFKC, lower case, letters and digits only. */
const compact = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "");

type SlotSet = { fields: { slot: string; candidate: string }[] };

/**
 * The slots a `confirm` or `unclear` plan fills, with a custom vault field kept in a
 * password input only where the input names it (owner, 2026-11-22, ADR 0035): a slot that
 * offers a custom field fills a `password` input only when the field's name shows in one
 * of that input's own texts (`textsOf`: its label, `id`, `name` or test ID, placeholder),
 * as Bitwarden fills a custom field only into an input its name matches. Otherwise the set
 * fills the account's password there, when the request offers that slot and the set
 * fills it nowhere else and no other such input; any other set is kept as it is. Headings
 * and the page's other text never count: ANA's page asked for 「ANAマイレージクラブの
 * パスワード」 in an input labelled 「パスワード：」, and the model took the field
 * 「AMCパスワード」, a four-digit PIN, for it.
 */
export function verificationSecretSlots<
  Plan extends SlotSet & { alternatives?: SlotSet[] | undefined },
>(
  observation: Pick<LoginObservation, "candidates">,
  slots: readonly SemanticSlot[],
  plan: Plan,
): Plan {
  if (!slots.some((slot) => slot.id === "password")) return plan;
  const candidates = new Map(observation.candidates.map((candidate) => [candidate.id, candidate]));
  const names = new Map(
    slots.flatMap((slot) => (slot.fieldName === undefined ? [] : [[slot.id, slot.fieldName]])),
  );
  const unnamed = (field: SlotSet["fields"][number]) => {
    const name = names.get(field.slot);
    const candidate = candidates.get(field.candidate);
    return (
      name !== undefined &&
      candidate?.role === "password" &&
      !textsOf(candidate).some((text) => compact(text).includes(compact(name)))
    );
  };
  const fixed = <Fields extends SlotSet>(set: Fields): Fields => {
    const taken = set.fields.filter(unnamed);
    if (taken.length !== 1 || set.fields.some((field) => field.slot === "password")) return set;
    return {
      ...set,
      fields: set.fields.map((field) =>
        field === taken[0] ? { ...field, slot: "password" } : field,
      ),
    };
  };
  return {
    ...fixed(plan),
    ...(plan.alternatives ? { alternatives: plan.alternatives.map(fixed) } : {}),
  };
}

/**
 * Whether a form reads, in words, as one that changes the password: one password input
 * names the current password ({@link fieldReading}) and another names a new value or
 * is marked `new-password`. Marks alone never count, so one page-wide form that holds a
 * sign-in marked `current-password` and a registration marked `new-password` still
 * signs in.
 */
export function readsAsPasswordChange(
  page: Pick<LoginObservation, "candidates">,
  group: string | undefined,
): boolean {
  const passwords = page.candidates.filter(
    (candidate) => candidate.role === "password" && candidate.group === group,
  );
  return passwords.some(
    (current) =>
      fieldReading(current) === "current" &&
      passwords.some(
        (other) =>
          other !== current &&
          (other.autocomplete === "new-password" || fieldReading(other) === "new"),
      ),
  );
}

/**
 * The check a `sign-in` plan gets beside `validateGeneratedPage` (ADR 0035, 2026-11-19):
 * it fills no form that reads as changing the password ({@link readsAsPasswordChange}),
 * whose button would save the account's changes. Undefined when every set passes.
 */
export function signInPlanRejection(
  observation: Pick<LoginObservation, "candidates">,
  plan: Pick<ValidatedGeneratedPage, "fields" | "alternatives">,
): "password-change-form" | undefined {
  return filledCandidates(observation, plan).some(
    ({ candidate }) =>
      candidate === undefined || readsAsPasswordChange(observation, candidate.group),
  )
    ? "password-change-form"
    : undefined;
}
