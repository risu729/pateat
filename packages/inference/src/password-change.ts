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
 * Words that name a new password ("New password", "Confirm new password",
 * "新しいパスワード", "新パスワード", "変更後のパスワード"). Latin words match whole words.
 */
const newPasswordWording = /\bnew\b|新しい|新\s*パスワード|新規\s*パスワード|変更後/iu;
/**
 * Words that name the password in use now ("Current password", "Old password",
 * "現在のパスワード", "今のパスワード", "旧パスワード").
 */
const currentPasswordWording =
  /\b(?:current|old|existing|present)\b|現在|今の|旧\s*パスワード|これまで/iu;
/** Whether an input's label, placeholder or `id`, `name` or test ID locator reads so. */
const fieldReads = (wording: RegExp, candidate: ObservedCandidate) =>
  [candidate.label, candidate.placeholder, ...targetValues(candidate.target)].some(
    (text) => text !== undefined && (wording.test(text) || wording.test(fieldWords(text))),
  );
/** An input that names a new password and not the current one. */
const readsNew = (candidate: ObservedCandidate) =>
  fieldReads(newPasswordWording, candidate) && !fieldReads(currentPasswordWording, candidate);
/** An input that names the current password and not a new one. */
const readsCurrent = (candidate: ObservedCandidate) =>
  fieldReads(currentPasswordWording, candidate) && !fieldReads(newPasswordWording, candidate);

/**
 * Whether a form sets a new password beside its other fields, read from the page alone
 * (owner, 2026-11-19, ADR 0035): it has two or more password inputs and one of them is
 * marked `new-password` or reads as a new password, or it has three or more. Undefined
 * for any other form; else `current`, its one input for the password in use now: the
 * one marked `current-password`, else the one reading so, else its first password input
 * unless that one is marked `new-password` or reads as a new password. A form with two
 * or more candidates by one rule, or none, has no `current`, as a reset form that asks
 * for a new password and its confirmation does. Fields outside any form count as one
 * form, as in plan validation. No site is named: the rule reads only structure and
 * labels (ADR 0033).
 */
export function passwordChangeForm(
  page: Pick<LoginObservation, "candidates">,
  group: string | undefined,
): { current: string | undefined } | undefined {
  const passwords = page.candidates.filter(
    (candidate) => candidate.role === "password" && candidate.group === group,
  );
  if (
    passwords.length < 2 ||
    (passwords.length < 3 &&
      !passwords.some(
        (candidate) => candidate.autocomplete === "new-password" || readsNew(candidate),
      ))
  )
    return undefined;
  const one = (found: readonly ObservedCandidate[]) =>
    found.length === 1 ? found[0]!.id : undefined;
  const marked = passwords.filter((candidate) => candidate.autocomplete === "current-password");
  if (marked.length) return { current: one(marked) };
  const named = passwords.filter(
    (candidate) => candidate.autocomplete !== "new-password" && readsCurrent(candidate),
  );
  if (named.length) return { current: one(named) };
  const [first] = passwords;
  return {
    current: first!.autocomplete === "new-password" || readsNew(first!) ? undefined : first!.id,
  };
}

/**
 * The check a `confirm` or `unclear` plan gets beside {@link validateGeneratedPage} (owner,
 * 2026-11-19, ADR 0035): on a form that also sets a new password
 * ({@link passwordChangeForm}), such as an account form that saves its changes only with
 * the current password, a set may fill only the password slot, and only into that
 * form's current password input. A new password, its confirmation, the form's other
 * fields and a form without a current password input are never filled. Undefined when
 * every set passes.
 */
export function verificationPlanRejection(
  observation: Pick<LoginObservation, "candidates">,
  slots: readonly SemanticSlot[],
  plan: Pick<ValidatedGeneratedPage, "fields" | "alternatives">,
): "password-change-field" | undefined {
  const kinds = new Map(slots.map((slot) => [slot.id, slot.kind]));
  const candidates = new Map(observation.candidates.map((candidate) => [candidate.id, candidate]));
  const fields = [plan, ...(plan.alternatives ?? [])].flatMap((set) => set.fields);
  return fields.some((field) => {
    const candidate = candidates.get(field.candidate);
    if (candidate === undefined) return true;
    const form = passwordChangeForm(observation, candidate.group);
    return (
      form !== undefined && (candidate.id !== form.current || kinds.get(field.slot) !== "secret")
    );
  })
    ? "password-change-field"
    : undefined;
}
