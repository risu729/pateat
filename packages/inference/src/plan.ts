import { loginStepSchema, type LoginStep } from "@pateat/contracts";
import * as v from "valibot";
import {
  actionRoles,
  type LoginObservation,
  type ObservedCandidate,
  type SemanticSlot,
} from "./observation";

/**
 * A role's proposal for the observed page, expressed in observation-local candidate
 * IDs. It becomes executable steps only after {@link validatePagePlan}.
 */
export type PagePlan = {
  fields: { slot: string; candidate: string }[];
  action: { candidate: string; purpose: "advance" | "submit" };
};

export type PlanRejection =
  | "empty-plan"
  | "unknown-slot"
  | "unknown-candidate"
  | "duplicate-slot"
  | "duplicate-candidate"
  | "incompatible-role";

export type ValidatedPagePlan = PagePlan & { steps: LoginStep[] };

const compatibleRoles: Record<SemanticSlot["kind"], readonly ObservedCandidate["role"][]> = {
  identifier: ["text", "email", "tel", "number"],
  secret: ["password"],
  "one-time-code": ["text", "tel", "number"],
};

/** True when a slot kind may be filled into an observed element role. */
export const slotFitsRole = (kind: SemanticSlot["kind"], role: ObservedCandidate["role"]) =>
  compatibleRoles[kind].includes(role);

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
  const slotKinds = new Map(slots.map((slot) => [slot.id, slot.kind]));
  const usedSlots = new Set<string>();
  const usedCandidates = new Set<string>();
  for (const field of plan.fields) {
    const kind = slotKinds.get(field.slot);
    if (kind === undefined) return { ok: false, reason: "unknown-slot" };
    const candidate = candidates.get(field.candidate);
    if (candidate === undefined) return { ok: false, reason: "unknown-candidate" };
    if (usedSlots.has(field.slot)) return { ok: false, reason: "duplicate-slot" };
    if (usedCandidates.has(field.candidate)) return { ok: false, reason: "duplicate-candidate" };
    if (!slotFitsRole(kind, candidate.role)) return { ok: false, reason: "incompatible-role" };
    usedSlots.add(field.slot);
    usedCandidates.add(field.candidate);
  }
  const action = candidates.get(plan.action.candidate);
  if (action === undefined) return { ok: false, reason: "unknown-candidate" };
  if (usedCandidates.has(action.id)) return { ok: false, reason: "duplicate-candidate" };
  if (!isActionRole(action.role)) return { ok: false, reason: "incompatible-role" };

  const steps = v.parse(v.array(loginStepSchema), [
    {
      kind: "fill",
      path: observation.path,
      fields: plan.fields.map((field) => ({
        slot: field.slot,
        target: candidates.get(field.candidate)!.target,
      })),
    },
    { kind: "click", path: observation.path, target: action.target, purpose: plan.action.purpose },
  ]);
  return {
    ok: true,
    plan: {
      fields: plan.fields.map((field) => ({ slot: field.slot, candidate: field.candidate })),
      action: { candidate: plan.action.candidate, purpose: plan.action.purpose },
      steps,
    },
  };
}
