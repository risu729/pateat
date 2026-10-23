import type {
  ChooserBranch,
  LoginHandler,
  LoginMarkerTarget,
  LoginRouteBody,
  StoredLoginRecipe,
} from "@pateat/contracts";

// The units of a recipe that `recipe_unit_sources` records the call of (ADR 0060,
// generation provenance): the parts that separate calls make. The IDs are stable, so a
// row keeps naming its unit while the recipe grows, and they say nothing about the owner
// or the device.
//
// Within one layout (the `layout` column holds its key; null for an entry recipe):
//
// - `page:<n>` a page of the layout's route whose steps start at index `n` of its
//   `steps`, which only ever grow at the end: `page:0` is the start page with its slots,
//   alternatives, passkey route, page kind and account switch; a later page holds the
//   steps a continuation appended and the account switch it named first.
// - `handler:<kind>:<path>` a handler the judge added, one per kind and path as the
//   recipe allows (`passkey`, `password` or `totp`).
// - `marker:<hash>` a signed-in marker the judge added: 12 hex digits of the SHA-256 of
//   `[origin ?? "", target]` as JSON, the pair the recipe keeps its markers unique by.
// - `list` a chooser layout's list buttons (`other`, `continue`).
// - `account/<unit>` and `other/<unit>` a unit of that chooser layout's branch's route.
// - `entry` an entry recipe (ADR 0031), which has no layout.
//
// A document a device wrote does not say where one page ended, so its units are each
// route's `page:0` (every step, the account switch and any rejection), its handlers and
// its markers, the list of each chooser layout, or `entry`.

/** A unit of a stored recipe: its layout's key (null for an entry recipe) and its ID. */
export type RecipeUnit = { layout: string | null; unit: string };

export const ENTRY_UNIT = "entry";
export const LIST_UNIT = "list";
/** A page of a route, by the index of its first step. */
export const pageUnit = (firstStep: number) => `page:${firstStep}`;
export const handlerUnit = (handler: Pick<LoginHandler, "kind" | "path">) =>
  `handler:${handler.kind}:${handler.path}`;
export async function markerUnit(marker: {
  target: LoginMarkerTarget;
  origin?: string | undefined;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([marker.origin ?? "", marker.target])),
  );
  return `marker:${new Uint8Array(digest).toHex().slice(0, 12)}`;
}
/** A unit of a route, under its chooser branch's prefix when the route is one. */
export const branchUnit = (branch: ChooserBranch | undefined, unit: string) =>
  branch ? `${branch}/${unit}` : unit;

/** The units a route of a document shows, its pages taken as one. */
async function routeUnits(
  route: Pick<LoginRouteBody, "handlers" | "completion">,
  branch?: ChooserBranch,
): Promise<string[]> {
  const units = [
    pageUnit(0),
    ...(route.handlers ?? []).map(handlerUnit),
    ...(await Promise.all((route.completion ?? []).map(markerUnit))),
  ];
  return units.map((unit) => branchUnit(branch, unit));
}

/** Every unit a stored document shows, as recorded for a document a device wrote. */
export async function documentUnits(recipe: StoredLoginRecipe): Promise<RecipeUnit[]> {
  if ("entry" in recipe) return [{ layout: null, unit: ENTRY_UNIT }];
  const layouts =
    "layouts" in recipe
      ? recipe.layouts.map(async (layout) => ({ key: layout.key, units: await routeUnits(layout) }))
      : recipe.chooser.layouts.map(async (layout) => ({
          key: layout.key,
          units: [
            LIST_UNIT,
            ...(layout.afterAccount ? await routeUnits(layout.afterAccount, "account") : []),
            ...(layout.afterOther ? await routeUnits(layout.afterOther, "other") : []),
          ],
        }));
  return (await Promise.all(layouts)).flatMap(({ key, units }) =>
    units.map((unit) => ({ layout: key, unit })),
  );
}
