import { attemptRouteChoice, handlerSlots } from "@pateat/contracts";
import { type Execution, type Authorized } from "./types";
import { current, change } from "./attempt";
import { planFor } from "./plan";
import type { Runtime } from "./state";

/** Resolve against a fresh live catalog; returns the authorizing metadata and binding. */
export async function allowed(rt: Runtime, run: Execution): Promise<Authorized | undefined> {
  if (!current(rt, run) || !rt.vars.storageHealthy) return undefined;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!current(rt, run)) return undefined;
  // A watched login only reads, so newer settings stop it only when they no longer plan
  // its account on this page, as another site's saved account choice does not (ADR 0027).
  const revised =
    snapshot.ok &&
    run.metadata.watch !== undefined &&
    snapshot.snapshot.revision > run.metadata.policyRevision;
  // A read that another check of the same watch overtook says nothing.
  if (
    snapshot.ok &&
    run.metadata.watch !== undefined &&
    snapshot.snapshot.revision < run.metadata.policyRevision
  )
    return undefined;
  if (!snapshot.ok || (snapshot.snapshot.revision !== run.metadata.policyRevision && !revised)) {
    await change(
      rt,
      run,
      { type: "POLICY_CHANGED" },
      { cause: snapshot.ok ? "settings-revision" : "settings-unavailable" },
    );
    return undefined;
  }
  // The recorded route alone is checked, so an excluded field of another variant never
  // stops this login, with the fields of the handlers it entered (ADR 0027).
  const plan = await planFor(rt, snapshot, run.live, run.recipe, {
    route: attemptRouteChoice(run.metadata),
    handlerSlots: handlerSlots(run.recipe, run.metadata),
  });
  if (
    !plan.ok ||
    plan.account.connectionId !== run.metadata.account.connectionId ||
    plan.account.itemId !== run.metadata.account.itemId
  ) {
    await change(
      rt,
      run,
      { type: "POLICY_CHANGED" },
      { cause: "plan", reason: plan.ok ? "account-changed" : plan.reason },
    );
    return undefined;
  }
  if (revised) {
    await change(rt, run, { type: "POLICY_REVISED", policyRevision: snapshot.snapshot.revision });
    if (!current(rt, run) || run.metadata.policyRevision !== snapshot.snapshot.revision)
      return undefined;
  }
  return {
    connection: plan.connection,
    binding: plan.binding,
    fieldIds: plan.account.fieldIds,
    bindings: snapshot.snapshot.settings.bindings,
    settings: snapshot.snapshot.settings,
    catalog: snapshot.catalog,
  };
}
