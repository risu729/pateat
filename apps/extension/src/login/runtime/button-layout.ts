import {
  identifierLayoutAfter,
  layoutStartTargets,
  loginFieldSource,
  onlyChoicesSince,
  transitionLoginAttempt,
  type LoginAccountBinding,
  type LoginAttemptEvent,
  type LoginRecipe,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { type Execution } from "./types";
import { change, current } from "./attempt";
import { observe } from "./reconcile";
import { planFor } from "./plan";
import type { Runtime } from "./state";

/**
 * The layouts of `recipe` its passkey button leads to, where the site asks for the account
 * before its passkey request (`identifierLayoutAfter`, ADR 0060 amendment of 2026-11-18),
 * newest first: those of its own revision or a newer one that start on the button's path.
 * None without a button or a layout key. Read from the cache, never generated.
 */
export async function buttonLayouts(rt: Runtime, recipe: LoginRecipe): Promise<LoginRecipe[]> {
  const button = recipe.passkey;
  if (!button || recipe.layout === undefined || !rt.recipes.layouts) return [];
  const candidates = await Promise.resolve(rt.recipes.layouts(recipe.origin, button.path)).catch(
    () => [],
  );
  return candidates
    .map((candidate) => candidate.recipe)
    .filter((layout) => identifierLayoutAfter(recipe, layout))
    .sort((left, right) => Number(right.layout) - Number(left.layout));
}

/**
 * Whether a binding reads a secret into the page: the `password` slot, the password or a
 * TOTP code through any field, or a concealed (hidden) custom field. A layout that asks
 * for the account first fills none of these after the passkey button.
 */
export function readsSecret(
  connection: Pick<VaultConnectionMetadata, "items">,
  binding: Pick<LoginAccountBinding, "itemId" | "slots">,
): boolean {
  const item = connection.items.find((entry) => entry.id === binding.itemId);
  return binding.slots.some(({ slot, fieldId }) => {
    const source = item ? loginFieldSource(item, fieldId) : fieldId;
    return (
      slot === "password" ||
      source === "login.password" ||
      source === "login.totp-code" ||
      item?.fields.find((field) => field.id === fieldId)?.kind === "hidden"
    );
  });
}

/**
 * After the `passkey` route's click on its button, the page on the button's path may ask
 * for the account first, as a layout of the recipe learned there does (ADR 0060 amendment
 * of 2026-11-18, owner 2026-11-18 02:16 UTC): once the button no longer shows and every
 * element of that layout's start page shows, the login goes on with that layout's steps,
 * the account's plan on it permitting, and stops just past them, where its page's passkey
 * request is answered with its item (ADR 0036). Returns whether the login switched; the
 * newest layout that shows wins.
 */
export async function switchAfterButton(rt: Runtime, run: Execution): Promise<boolean> {
  const { metadata, recipe } = run;
  const button = recipe.passkey;
  if (
    !button ||
    metadata.route !== "passkey" ||
    metadata.stepIndex !== 0 ||
    metadata.operationId === undefined ||
    metadata.operationKind !== "click" ||
    metadata.settled === true ||
    run.live.document.frameId !== 0
  )
    return false;
  const layouts = await buttonLayouts(rt, recipe);
  if (!current(rt, run) || run.metadata !== metadata) return false;
  for (const layout of layouts) {
    const targets = layoutStartTargets(layout);
    // The button gone and the layout's whole start page shown: the click led there.
    // eslint-disable-next-line no-await-in-loop
    const observed = await observe(
      rt,
      run,
      [button.target, ...targets],
      [button.target, ...targets].map(() => "shown" as const),
    );
    if (!observed || !current(rt, run) || run.metadata !== metadata) return false;
    const [shownButton, ...shown] = observed.targets;
    if (
      observed.path !== button.path ||
      shownButton === "unique" ||
      shownButton === "ambiguous" ||
      !shown.every((state) => state === "unique")
    )
      continue;
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
    if (!current(rt, run) || run.metadata !== metadata) return false;
    if (!snapshot.ok || !onlyChoicesSince(snapshot.snapshot, metadata.policyRevision)) return false;
    // eslint-disable-next-line no-await-in-loop
    const plan = await planFor(rt, snapshot, run.live, layout, {
      route: { route: "password", variant: 0 },
    });
    if (!current(rt, run) || run.metadata !== metadata) return false;
    if (
      !plan.ok ||
      plan.account.connectionId !== metadata.account.connectionId ||
      plan.account.itemId !== metadata.account.itemId ||
      readsSecret(plan.connection, plan.binding)
    )
      continue;
    const event: LoginAttemptEvent = {
      type: "IDENTIFIER_LAYOUT",
      layout: layout.layout!,
      recipeRevision: layout.revision,
      steps: layout.steps.length,
      maxSubmissions: layout.maxSubmissions,
      document: run.live.document,
    };
    if (transitionLoginAttempt(metadata, event).layout !== layout.layout) continue;
    // The recipe is replaced before the record that names its layout is written.
    run.recipe = layout;
    // The account's choice is saved for the layout the login signs in on, as after any
    // layout switch (ADR 0060).
    if (plan.choice && !run.bindingRepair) run.choice = plan.choice;
    else delete run.choice;
    delete run.heldClick;
    delete run.inPlace;
    delete run.siblingsInPlace;
    delete run.qualified;
    // The loop ends here: the switch is recorded once, for this layout.
    // eslint-disable-next-line no-await-in-loop
    await change(rt, run, event, undefined, undefined, "passkey-button");
    return true;
  }
  return false;
}
