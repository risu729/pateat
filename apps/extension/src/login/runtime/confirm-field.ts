// The vault field the popup's **Fill** puts into a verification page (ADR 0035, amended
// 2026-11-22): the person may choose it, and the choice is saved as that account's
// binding of the page's recipe, so later fills of the page use it too.
import * as v from "valibot";
import {
  customFieldReference,
  findLoginBinding,
  getItemEligibility,
  isSsoFieldName,
  loginDisplayNames,
  sameLoginBinding,
  savedLoginBindingSchema,
  type LoginRecipe,
  type SavedLoginBinding,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultFieldReference,
} from "@pateat/contracts";
import { confirmationSteps } from "./confirm-fill";
import { confirmRecipeOn } from "./generation-scope";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";

/** The settings hold at most this many bindings, as `saveLoginChoice` counts them. */
const MAX_BINDINGS = 1000;
/** At most this many fields are offered for one account. */
export const CONFIRM_FIELDS_MAX = 30;

/** One field the person may choose: the built-in password, or a named custom field. */
export type ConfirmFieldChoice = { field: VaultFieldReference; name?: string };

const sameReference = (left: VaultFieldReference, right: VaultFieldReference) =>
  typeof left === "string" || typeof right === "string"
    ? left === right
    : left.custom === right.custom &&
      left.position === right.position &&
      left.count === right.count;

/** The one slot the recipe's fill on `path` takes, if it takes exactly one. */
export function confirmSlot(recipe: LoginRecipe, path: string): string | undefined {
  const slots = new Set(
    confirmationSteps(recipe, path).flatMap(({ step }) => step.fields.map((field) => field.slot)),
  );
  return slots.size === 1 ? [...slots][0] : undefined;
}

/**
 * The fields of one matching account the person may choose for a verification page whose
 * recipe fills one slot there: the item's password when it holds one, then its named Text
 * and Hidden custom fields, in the item's order, that the account's policy allows. A field
 * holding a TOTP key or naming an SSO method is never offered. `chosen` is the field the
 * account's saved binding of that recipe names, if any.
 */
export function confirmFieldChoices(
  settings: SettingsSnapshot["settings"],
  catalog: VaultCatalog,
  recipe: LoginRecipe,
  path: string,
  account: { connectionId: string; itemId: string },
): { slot: string; fields: ConfirmFieldChoice[]; chosen?: VaultFieldReference } | undefined {
  const slot = confirmSlot(recipe, path);
  if (slot === undefined || slot === "totp" || slot === "username") return undefined;
  const connection = catalog.connections.find((entry) => entry.id === account.connectionId);
  const item = connection?.items.find((entry) => entry.id === account.itemId);
  if (!connection?.userId || !item) return undefined;
  const eligible = getItemEligibility(settings, catalog, account.connectionId, account.itemId);
  if (!eligible.eligible) return undefined;
  const allowed = new Set(eligible.fieldIds);
  const fields: ConfirmFieldChoice[] = [];
  for (const field of item.fields) {
    if (!allowed.has(field.id) || field.empty || field.totpSeed) continue;
    if (field.id === "login.password") fields.push({ field: "password" });
    else if (
      (field.kind === "text" || field.kind === "hidden") &&
      field.name &&
      !isSsoFieldName(field.name)
    ) {
      const reference = customFieldReference(item.fields, field.id);
      if (reference) fields.push({ field: reference, name: field.name });
    }
  }
  if (fields.length < 2) return undefined;
  const saved = findLoginBinding(settings.bindings, recipe, {
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
    itemId: item.id,
  })?.slots.find((entry) => entry.slot === slot)?.field;
  const chosen =
    saved && fields.some((entry) => sameReference(entry.field, saved)) ? saved : undefined;
  return { slot, fields: fields.slice(0, CONFIRM_FIELDS_MAX), ...(chosen ? { chosen } : {}) };
}

/**
 * Saves the field the person chose for a verification page's **Fill** as the account's
 * binding of the page's recipe, replacing the slot's entry of a binding already saved.
 * Returns why it could not, or undefined once the binding holds the choice. The fill that
 * follows reads the saved binding, with every check it makes.
 */
export async function saveConfirmField(
  rt: Runtime,
  live: LiveDocument,
  account: { connectionId: string; itemId: string },
  field: VaultFieldReference,
): Promise<string | undefined> {
  if (!rt.settings.update) return "settings-unavailable";
  const recipe = await confirmRecipeOn(rt, live.document.origin, live.path);
  if (!recipe) return "field-unavailable";
  // The choice, built from the settings and the vault catalog as they are then.
  const choose = (
    settings: SettingsSnapshot["settings"],
    catalog: VaultCatalog,
  ): SavedLoginBinding | undefined => {
    const offered = confirmFieldChoices(settings, catalog, recipe, live.path, account);
    if (!offered?.fields.some((entry) => sameReference(entry.field, field))) return undefined;
    const connection = catalog.connections.find((entry) => entry.id === account.connectionId)!;
    const item = connection.items.find((entry) => entry.id === account.itemId)!;
    const owner = {
      provider: connection.provider,
      server: connection.server,
      userId: connection.userId!,
      itemId: item.id,
    };
    const saved = findLoginBinding(settings.bindings, recipe, owner);
    const binding = v.safeParse(savedLoginBindingSchema, {
      recipeId: recipe.id,
      origin: recipe.origin,
      ...owner,
      ...loginDisplayNames(item.id, item.label, connection.label),
      slots: [
        ...(saved?.slots.filter((entry) => entry.slot !== offered.slot) ?? []),
        { slot: offered.slot, field },
      ],
    });
    return binding.success ? binding.output : undefined;
  };
  const latest = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!latest?.ok) return "settings-unavailable";
  const wanted = choose(latest.snapshot.settings, latest.catalog);
  if (!wanted) return "field-unavailable";
  const current = latest.snapshot.settings.bindings.find((entry) =>
    sameLoginBinding(entry, wanted),
  );
  if (current && JSON.stringify(current.slots) === JSON.stringify(wanted.slots)) return undefined;
  // Checked in the settings queue against the live catalog, and written as checked.
  let checked: SavedLoginBinding | undefined;
  return rt.settings
    .update(
      undefined,
      "account-choice",
      (snapshot) => {
        if (!checked) throw new Error("field-unavailable");
        const binding = checked;
        const others = snapshot.settings.bindings.filter(
          (entry) => !sameLoginBinding(entry, binding),
        );
        if (others.length >= MAX_BINDINGS) throw new Error("field-unavailable");
        return { ...snapshot, settings: { ...snapshot.settings, bindings: [...others, binding] } };
      },
      async (snapshot, catalog) => {
        checked = choose(snapshot.settings, await catalog());
        return checked !== undefined;
      },
    )
    .then(
      () => undefined,
      () => "field-unavailable",
    );
}
