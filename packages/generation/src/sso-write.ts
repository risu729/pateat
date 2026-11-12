import { canonicalJson, storedLoginRecipeSchema, type StoredLoginRecipe } from "@pateat/contracts";
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
): StoredLoginRecipe | undefined {
  if ("entry" in proposed || "logout" in proposed || "entry" in current || "logout" in current)
    return undefined;
  const empty = { version: 1 as const, id: proposed.id, revision: 0, origin: proposed.origin };
  if (native(base ?? empty) !== native(current)) return undefined;
  const { sso: _sso, ...body } = proposed;
  const recipe = {
    ...body,
    revision: current.revision + 1,
    ...(current.sso ? { sso: current.sso } : {}),
  };
  return v.is(storedLoginRecipeSchema, recipe) ? recipe : undefined;
}
