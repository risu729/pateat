import { ssoChild } from "./sso-state";
import { ssoScope } from "./sso-scope";
import { onlyChoicesSince, attemptRouteChoice, handlerSlots } from "@pateat/contracts";
import { type Execution, type Authorized } from "./types";
import { current, change } from "./attempt";
import { planFor } from "./plan";
import { signInPermission } from "./page-permission";
import type { Runtime } from "./state";
import { manualExecutionConflict } from "./hold";
import { note } from "./generation";

/**
 * Whether an SSO hop's own login may still act: its parent flow runs and owns it, and the
 * flow's scope holds for its document. A scope that no longer holds, as when the tab's URL
 * moved on before its document announced it, is logged once for its page, so a step that
 * does not run says why (ADR 0026, amendment of 2026-11-18); the flow's own time bounds it.
 */
async function hopScope(rt: Runtime, run: Execution): Promise<boolean> {
  const parent = rt.sso.flows.get(run.metadata.document.tabId);
  if (!parent || parent.childId !== run.metadata.id) return false;
  if ((await ssoScope(rt, parent, run.live))?.()) return true;
  if (current(rt, run) && !parent.ended)
    note(rt, run.live.document, run.live.url, "sso-scope-changed", "idp-step");
  return false;
}

/** Resolve against a fresh live catalog; returns the authorizing metadata and binding. */
export async function allowed(rt: Runtime, run: Execution): Promise<Authorized | undefined> {
  if (!current(rt, run) || !rt.vars.storageHealthy || manualExecutionConflict(rt, run))
    return undefined;
  if (ssoChild(rt.sso, run.metadata) && !(await hopScope(rt, run))) return undefined;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!current(rt, run) || manualExecutionConflict(rt, run)) return undefined;
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
  // A revision that only wrote a choice for one site leaves the login authorized, as it was
  // already applied before the write landed (`CHOICE_ONLY_CAUSES`).
  if (
    !snapshot.ok ||
    (!onlyChoicesSince(snapshot.snapshot, run.metadata.policyRevision) && !revised)
  ) {
    await change(
      rt,
      run,
      { type: "POLICY_CHANGED" },
      { cause: snapshot.ok ? "settings-revision" : "settings-unavailable" },
    );
    return undefined;
  }
  if (
    run.metadata.signInFill &&
    signInPermission(snapshot.snapshot.settings, run.live).permission !== "fill"
  ) {
    await change(rt, run, { type: "POLICY_CHANGED" }, { cause: "settings-revision" });
    return undefined;
  }
  // The recorded route alone is checked, so an excluded field of another variant never
  // stops this login, with the fields of the handlers it entered (ADR 0027).
  const plan = await planFor(rt, snapshot, run.live, run.recipe, {
    route: attemptRouteChoice(run.metadata),
    handlerSlots: handlerSlots(run.recipe, run.metadata),
  });
  if (manualExecutionConflict(rt, run)) return undefined;
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
  if (manualExecutionConflict(rt, run)) return undefined;
  if (ssoChild(rt.sso, run.metadata) && !(await hopScope(rt, run))) return undefined;
  return {
    connection: plan.connection,
    binding: plan.binding,
    fieldIds: plan.account.fieldIds,
    bindings: snapshot.snapshot.settings.bindings,
    settings: snapshot.snapshot.settings,
    catalog: snapshot.catalog,
  };
}
