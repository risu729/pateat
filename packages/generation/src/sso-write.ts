import {
  canonicalJson,
  newLayoutKey,
  storedLayouts,
  storedLoginRecipeSchema,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import * as v from "valibot";
const native = (recipe: StoredLoginRecipe) => {
  if ("entry" in recipe || "logout" in recipe) return undefined;
  const { sso: _sso, revision: _revision, ...body } = recipe;
  return canonicalJson(body);
};
/** A paid native answer can cross an SSO-only write, without overwriting either family. */
export function rebaseNativeOverSso(
  proposed: StoredLoginRecipe,
  base: StoredLoginRecipe | undefined,
  current: StoredLoginRecipe,
): { recipe: StoredLoginRecipe; renamed: Map<string, string> } | undefined {
  if ("entry" in proposed || "logout" in proposed || "entry" in current || "logout" in current)
    return undefined;
  const empty = { version: 1 as const, id: proposed.id, revision: 0, origin: proposed.origin };
  if (native(base ?? empty) !== native(current)) return undefined;
  const { sso: _sso, ...body } = proposed;
  const occupied = new Set((current.sso?.layouts ?? []).map((layout) => layout.key));
  const taken = [...storedLayouts(proposed), ...storedLayouts(current)].map((layout) => layout.key);
  const renamed = new Map<string, string>();
  const rename = <T extends { key: string; createdAt: number }>(layout: T): T => {
    if (!occupied.has(layout.key)) return layout;
    const key = newLayoutKey(layout.createdAt, taken);
    taken.push(key);
    renamed.set(layout.key, key);
    return { ...layout, key };
  };
  const recipe = {
    ...body,
    ...(body.layouts ? { layouts: body.layouts.map(rename) } : {}),
    ...(body.chooser
      ? { chooser: { ...body.chooser, layouts: body.chooser.layouts.map(rename) } }
      : {}),
    revision: current.revision + 1,
    ...(current.sso ? { sso: current.sso } : {}),
  };
  return v.is(storedLoginRecipeSchema, recipe) ? { recipe, renamed } : undefined;
}
