import type { LoginObservation, ObservedCandidate, SemanticSlot } from "@pateat/contracts";
import { noUsage, type InferenceOutcome } from "./outcome";
import { slotAccepts, validatePagePlan, type PagePlan, type ValidatedPagePlan } from "./plan";

const identifierRoles = new Set<ObservedCandidate["role"]>(["text", "email", "tel"]);
const identifierHints = new Set(["username", "email"]);

const local = (
  outcome:
    | { status: "ok"; value: ValidatedPagePlan }
    | { status: "abstained"; reason: "no-login-form" | "ambiguous" | "no-action" }
    | { status: "failed"; error: "invalid-output" },
): InferenceOutcome<ValidatedPagePlan> => ({ calls: 0, usage: noUsage, ...outcome });

/**
 * A model-free comparator for the benchmark, in the manner of a password manager's form
 * heuristics: the one form with a single sign-in password, its `username` or `email`
 * field or else the nearest text field before the password, and its button after the
 * password. A form with only an identifier marked `username` or `email` advances. It
 * reads no labels, so it shows what the model adds beyond structure. Not used at runtime.
 */
export function heuristicPlan(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
): InferenceOutcome<ValidatedPagePlan> {
  const identifier = slots.find((slot) => slot.kind === "identifier");
  const secret = slots.find((slot) => slot.kind === "secret");
  const forms = new Map<string, ObservedCandidate[]>();
  for (const candidate of observation.candidates) {
    const key = candidate.group ?? "";
    forms.set(key, [...(forms.get(key) ?? []), candidate]);
  }
  const passwordsIn = (form: ObservedCandidate[]) =>
    form.filter((candidate) => candidate.role === "password");
  // Two password fields in one form are a sign-up or a password change.
  const logins = [...forms.values()].filter(
    (form) =>
      passwordsIn(form).length === 1 &&
      secret !== undefined &&
      slotAccepts(secret.kind, passwordsIn(form)[0]!),
  );
  const hinted = (form: ObservedCandidate[]) =>
    form.filter(
      (candidate) =>
        identifierRoles.has(candidate.role) && identifierHints.has(candidate.autocomplete ?? ""),
    );

  let plan: PagePlan;
  if (logins.length > 1) return local({ status: "abstained", reason: "ambiguous" });
  if (logins.length === 1) {
    const form = logins[0]!;
    const password = passwordsIn(form)[0]!;
    const at = form.indexOf(password);
    const named = hinted(form);
    const field =
      named.length === 1
        ? named[0]
        : form
            .slice(0, at)
            .reverse()
            .find((candidate) => identifierRoles.has(candidate.role));
    const action =
      form.slice(at + 1).find((candidate) => candidate.role === "button") ??
      form.find((candidate) => candidate.role === "button");
    if (!action) return local({ status: "abstained", reason: "no-action" });
    plan = {
      fields: [
        ...(field && identifier ? [{ slot: identifier.id, candidate: field.id }] : []),
        { slot: secret!.id, candidate: password.id },
      ],
      action: { candidate: action.id, purpose: "submit" },
    };
  } else {
    const firsts = [...forms.values()].filter(
      (form) => passwordsIn(form).length === 0 && hinted(form).length === 1,
    );
    if (firsts.length !== 1 || !identifier)
      return local({ status: "abstained", reason: "no-login-form" });
    const form = firsts[0]!;
    const field = hinted(form)[0]!;
    const action =
      form.slice(form.indexOf(field) + 1).find((candidate) => candidate.role === "button") ??
      form.find((candidate) => candidate.role === "button");
    if (!action) return local({ status: "abstained", reason: "no-action" });
    plan = {
      fields: [{ slot: identifier.id, candidate: field.id }],
      action: { candidate: action.id, purpose: "advance" },
    };
  }
  const validated = validatePagePlan(observation, slots, plan);
  return validated.ok
    ? local({ status: "ok", value: validated.plan })
    : local({ status: "failed", error: "invalid-output" });
}
