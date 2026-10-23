import type { ChooserBranch, LoginRouteBody, StoredLoginRecipe } from "@pateat/contracts";

// The units of a recipe that `recipe_unit_sources` records the call of (ADR 0060,
// generation provenance): the parts that separate calls make. The IDs are positions that
// writes never shift, so a row keeps naming its unit while the recipe grows and when a
// migration renames members; they say nothing about the owner or the device.
//
// Within one layout (the `layout` column holds its key; null for an entry recipe):
//
// - `page:<n>` a page of the layout's route whose steps start at index `n` of its
//   `steps`, which only ever grow at the end.
// - `handler:<i>` the route's handler at index `i`, and `marker:<i>` its signed-in marker
//   at index `i`: the judge only appends them, and only a device's write may reorder or
//   remove them, which the unit digests catch.
// - `list` a chooser layout's list buttons (`other`, `continue`).
// - `account/<unit>` and `other/<unit>` a unit of that chooser layout's branch's route.
// - `entry` an entry recipe (ADR 0031), which has no layout.
// - `logout` a logout recipe's clicks (ADR 0063), which has no layout either.
//
// Each unit has a digest of its content in the document (`documentUnits`), so a device's
// write keeps the record of every unit it left unchanged.

/** A unit of a stored recipe: its layout's key (null for an entry or logout recipe) and its ID. */
export type RecipeUnit = { layout: string | null; unit: string };
/** A unit with the digest of its content in a written document. */
export type DigestedUnit = RecipeUnit & { digest: string };

export const ENTRY_UNIT = "entry";
export const LIST_UNIT = "list";
export const LOGOUT_UNIT = "logout";
/** A page of a route, by the index of its first step. */
export const pageUnit = (firstStep: number) => `page:${firstStep}`;
/** A route's handler, by its index in `handlers`. */
export const handlerUnit = (index: number) => `handler:${index}`;
/** A route's signed-in marker, by its index in `completion`. */
export const markerUnit = (index: number) => `marker:${index}`;
/** A unit of a route, under its chooser branch's prefix when the route is one. */
export const branchUnit = (branch: ChooserBranch | undefined, unit: string) =>
  branch ? `${branch}/${unit}` : unit;

const PAGE_UNIT = /^(?:(account|other)\/)?page:(\d+)$/;

/**
 * Each unit of a route with its content: its pages, split where `starts` say a page began
 * (the start page always at 0), then its handlers and markers. A page holds its own steps;
 * the start page also holds what only the start page sets (variants, passkey route, page
 * kind, the layout's language) and the rejection, which only a device writes. The slots and
 * submission count follow from the steps, and a later page may keep, add or drop the
 * account switch, so these are no unit's content.
 */
function routeContents(
  route: LoginRouteBody,
  starts: readonly number[],
  branch: ChooserBranch | undefined,
  language: string | undefined,
): [string, unknown][] {
  const bounds = [...new Set([0, ...starts])]
    .filter((start) => start < route.steps.length)
    .toSorted((a, b) => a - b);
  const pages = bounds.map((start, index): [string, unknown] => {
    const steps = route.steps.slice(start, bounds[index + 1]);
    return [
      pageUnit(start),
      start === 0
        ? {
            steps,
            alternatives: route.alternatives,
            passkey: route.passkey,
            passkeyOnly: route.passkeyOnly,
            pageKind: route.pageKind,
            rejection: route.rejection,
            language,
          }
        : { steps },
    ];
  });
  return [
    ...pages,
    ...(route.handlers ?? []).map((handler, index): [string, unknown] => [
      handlerUnit(index),
      handler,
    ]),
    ...(route.completion ?? []).map((marker, index): [string, unknown] => [
      markerUnit(index),
      marker,
    ]),
  ].map(([unit, content]) => [branchUnit(branch, unit), content]);
}

/** JSON with object keys sorted and undefined members left out, so equal content is equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** 32 hex digits of the SHA-256 of the content's canonical JSON. */
async function contentDigest(content: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(content)),
  );
  return new Uint8Array(digest).toHex().slice(0, 32);
}

/**
 * Every unit a stored document shows, with its digest. A document does not say where one
 * page ended, so each route is split at the `page:<n>` units of `pages` for its layout and
 * branch (the recipe's recorded units); a route none names is one `page:0`.
 */
export async function documentUnits(
  recipe: StoredLoginRecipe,
  pages: readonly RecipeUnit[] = [],
): Promise<DigestedUnit[]> {
  const startsOf = (layout: string, branch?: ChooserBranch) =>
    pages.flatMap((page) => {
      const match = page.layout === layout ? PAGE_UNIT.exec(page.unit) : null;
      return match && match[1] === branch ? [Number(match[2])] : [];
    });
  const contents: { layout: string | null; unit: string; content: unknown }[] =
    "entry" in recipe
      ? [{ layout: null, unit: ENTRY_UNIT, content: recipe.entry }]
      : "logout" in recipe
        ? [{ layout: null, unit: LOGOUT_UNIT, content: recipe.logout }]
        : "layouts" in recipe
          ? recipe.layouts.flatMap((layout) =>
              routeContents(layout, startsOf(layout.key), undefined, layout.language).map(
                ([unit, content]) => ({ layout: layout.key, unit, content }),
              ),
            )
          : recipe.chooser.layouts.flatMap((layout) =>
              [
                [
                  LIST_UNIT,
                  { other: layout.other, continue: layout.continue, language: layout.language },
                ] as [string, unknown],
                ...(layout.afterAccount
                  ? routeContents(
                      layout.afterAccount,
                      startsOf(layout.key, "account"),
                      "account",
                      undefined,
                    )
                  : []),
                ...(layout.afterOther
                  ? routeContents(
                      layout.afterOther,
                      startsOf(layout.key, "other"),
                      "other",
                      undefined,
                    )
                  : []),
              ].map(([unit, content]) => ({ layout: layout.key, unit, content })),
            );
  return Promise.all(
    contents.map(async ({ layout, unit, content }) => ({
      layout,
      unit,
      digest: await contentDigest(content),
    })),
  );
}

/**
 * The named units of a written document with their digests. A named page ends where the
 * next named page of its route starts, or with the route: a call's page is its route's
 * last when it is written.
 */
export async function namedUnits(
  recipe: StoredLoginRecipe,
  units: readonly RecipeUnit[],
): Promise<DigestedUnit[]> {
  const named = new Set(units.map(({ layout, unit }) => JSON.stringify([layout, unit])));
  return (await documentUnits(recipe, units)).filter(({ layout, unit }) =>
    named.has(JSON.stringify([layout, unit])),
  );
}
