import { fillRoles, type LoginObservation, type ObservedCandidate } from "@pateat/contracts";
import type { ExpectedResult } from "./cases";

/** Why a label could not move to a new observation of its page. */
export type CarryRefusal =
  /** The new observation is of another origin or path. */
  | "moved"
  /** Inference would reject the new observation without a call. */
  | "incomplete"
  /** The page shows other fields to fill, which may change what its label should be. */
  | "changed-fields"
  /** A labelled candidate has no counterpart with the same role and locator. */
  | "missing-candidate";

export type CarryResult =
  | { ok: true; expected: ExpectedResult }
  | { ok: false; reason: CarryRefusal; candidate?: string };

/**
 * Moves a page's label to a new observation of the same page. Candidate IDs are numbered
 * per observation, so each candidate the label names is found again by its role and
 * locator (an observation never repeats a locator). A page whose fields to fill changed
 * may need another label, such as a submit where an advance was, so it is refused, as is
 * a label that cannot move whole, to be checked by a person.
 */
export function carryLabel(
  previous: LoginObservation,
  expected: ExpectedResult,
  next: LoginObservation,
): CarryResult {
  if (next.origin !== previous.origin || next.path !== previous.path)
    return { ok: false, reason: "moved" };
  if (!next.complete) return { ok: false, reason: "incomplete" };
  if (fields(previous) !== fields(next)) return { ok: false, reason: "changed-fields" };
  if (expected.kind === "abstain") return { ok: true, expected };

  const ids = new Map<string, string>();
  for (const id of labelledIds(expected)) {
    const old = previous.candidates.find((candidate) => candidate.id === id);
    const match = next.candidates.find(
      (candidate) => old !== undefined && identity(candidate) === identity(old),
    );
    if (!match) return { ok: false, reason: "missing-candidate", candidate: id };
    ids.set(id, match.id);
  }
  const moved = (id: string) => ids.get(id)!;
  const slots = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).map(([slot, id]) => [slot, moved(id)]));
  return {
    ok: true,
    expected: {
      ...expected,
      fields: slots(expected.fields),
      action: moved(expected.action),
      ...(expected.alternatives === undefined
        ? {}
        : {
            alternatives: expected.alternatives.map((alternative) => ({
              fields: slots(alternative.fields),
              action: moved(alternative.action),
            })),
          }),
      ...(expected.passkeyButton === undefined
        ? {}
        : { passkeyButton: moved(expected.passkeyButton) }),
    },
  };
}

const identity = ({ role, target }: ObservedCandidate) =>
  JSON.stringify([role, target.by, target.value, "within" in target ? target.within : undefined]);

/** The page's fields to fill, in page order. */
const fields = (observation: LoginObservation) =>
  JSON.stringify(
    observation.candidates
      .filter((candidate) => (fillRoles as readonly string[]).includes(candidate.role))
      .map(identity),
  );

function labelledIds(expected: Extract<ExpectedResult, { kind: "plan" }>): Set<string> {
  return new Set([
    ...Object.values(expected.fields),
    expected.action,
    ...(expected.alternatives ?? []).flatMap((alternative) => [
      ...Object.values(alternative.fields),
      alternative.action,
    ]),
    ...(expected.passkeyButton === undefined ? [] : [expected.passkeyButton]),
  ]);
}
