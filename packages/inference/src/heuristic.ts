import {
  fillRoles,
  loginObservationSchema,
  semanticSlotsSchema,
  type LoginObservation,
  type ObservedCandidate,
  type SemanticSlot,
} from "@pateat/contracts";
import * as v from "valibot";
import { noUsage, type InferenceOutcome } from "./outcome";
import {
  slotAccepts,
  validatePagePlan,
  type PagePlan,
  type PlanRejection,
  type ValidatedPagePlan,
} from "./plan";

const identifierRoles = new Set<ObservedCandidate["role"]>(["text", "email", "tel"]);
const identifierHints = new Set(["username", "email"]);
const fillable = new Set<ObservedCandidate["role"]>(fillRoles);
// Fields whose autocomplete names another purpose are never taken as the identifier.
const otherPurposes = new Set(["one-time-code", "new-password", "current-password"]);

const local = (
  outcome:
    | { status: "ok"; value: ValidatedPagePlan }
    | { status: "abstained"; reason: "no-login-form" | "ambiguous" | "no-action" }
    | {
        status: "failed";
        error: "invalid-request" | "incomplete-observation" | "invalid-output";
        detail?: PlanRejection;
      },
): InferenceOutcome<ValidatedPagePlan> => ({ calls: 0, usage: noUsage, ...outcome });

/**
 * A model-free comparator for the benchmark, in the manner of a password manager's form
 * heuristics: the one form with a single sign-in password, its `username` or `email`
 * field or else the nearest identifier-like field before the password, and its first
 * button after the password, or else its first button. Without such a form, the one form
 * whose only fill field is marked `username` or `email` advances. It reads no labels, so
 * it shows what the model adds beyond structure. Not used at runtime. Its inputs pass the
 * same gate as generation's, so both providers fail the same cases before any mapping.
 */
export function heuristicPlan(
  observation: LoginObservation,
  slots: readonly SemanticSlot[],
): InferenceOutcome<ValidatedPagePlan> {
  if (
    !v.safeParse(loginObservationSchema, observation).success ||
    !v.safeParse(semanticSlotsSchema, slots).success
  )
    return local({ status: "failed", error: "invalid-request" });
  if (!observation.complete) return local({ status: "failed", error: "incomplete-observation" });
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
            .find(
              (candidate) =>
                identifier !== undefined &&
                slotAccepts(identifier.kind, candidate) &&
                !otherPurposes.has(candidate.autocomplete ?? ""),
            );
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
    // A form whose only fill field is the identifier; a newsletter form with a name field
    // does not qualify, but one with only an email field still does.
    const firsts = [...forms.values()].filter(
      (form) =>
        hinted(form).length === 1 &&
        form.filter((candidate) => fillable.has(candidate.role)).length === 1,
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
    : local({ status: "failed", error: "invalid-output", detail: validated.reason });
}
