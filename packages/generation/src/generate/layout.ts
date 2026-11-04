import {
  findChooserLayout,
  newLayoutKey,
  parseRecipeBranch,
  recipeSlots,
  storedBranchRoute,
  isChooserDocument,
  isLoginRecipeDocument,
  storedLoginRecipeSchema,
  toChooserLayout,
  toLoginLayout,
  withChooserBranch,
  withChooserLayout,
  withLoginLayout,
  type LayoutMeta,
  type LoginLayout,
  type LoginObservation,
  type LoginRecipe,
  type PageKind,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { appendPageSteps, customSlotNames, type ValidatedGeneratedPage } from "@pateat/inference";
import * as v from "valibot";
import { type GenerationBackend } from "../backend";
import { unavailable, failed } from "./responses";

/** The route a branch name runs on a stored head: a layout's, or a chooser layout's branch's. */
export const routeOf = (recipe: StoredLoginRecipe, branch: string) =>
  storedBranchRoute(recipe, branch)?.route;
/**
 * A route a login ran, changed for a page or a judgement, written back as its layout of the
 * stored head (ADR 0060), under its chooser layout for a chooser branch, at `next`'s
 * revision; the head's other layouts stay as they are. `undefined` when the head has no
 * such layout, or the recipe it makes fails its own schema, so devices never get a recipe
 * they refuse to sync.
 */
export function stored(
  head: StoredLoginRecipe,
  branch: string,
  next: LoginRecipe,
): StoredLoginRecipe | undefined {
  const named = parseRecipeBranch(branch);
  if (!named) return undefined;
  const revision = { revision: next.revision };
  let written: StoredLoginRecipe | undefined;
  if (isLoginRecipeDocument(head) && !named.branch) {
    const meta = head.layouts.find((layout) => layout.key === named.layout);
    written = meta && { ...withLoginLayout(head, toLoginLayout(next, meta)), ...revision };
  } else if (isChooserDocument(head) && named.branch) {
    const chooser = findChooserLayout(head, named.layout);
    const meta = head.chooser.layouts.find((layout) => layout.key === named.layout);
    written = chooser &&
      meta && {
        ...withChooserLayout(
          head,
          toChooserLayout(withChooserBranch(chooser, named.branch, next), meta),
        ),
        ...revision,
      };
  }
  return written && v.is(storedLoginRecipeSchema, written) ? written : undefined;
}
/**
 * The key, language and creation time of a layout created now (ADR 0060): a language the
 * page was written in alone, none for a page of both.
 */
export function newLayoutMeta(language: LoginObservation["language"], now: number): LayoutMeta {
  return {
    key: newLayoutKey(now, []),
    ...(language === "mixed" ? {} : { language }),
    createdAt: now,
  };
}
/**
 * A write that a login's page caused, on a continuation or a judgement, marks the layout
 * the login ran used (ADR 0060). A failed mark only costs that layout some idle time.
 */
export async function markWritten(backend: GenerationBackend, recipeId: string, branch: string) {
  const layout = parseRecipeBranch(branch)?.layout;
  if (layout === undefined) return;
  try {
    await backend.markLayoutUsed(recipeId, layout);
  } catch {
    console.warn("Recipe layout use not kept", { recipeId });
  }
}
/** What the model answered a page for, as {@link buildLoginLayout} builds a layout of it. */
export type LayoutPage = {
  /** The recipe's ID and origin. */
  id: string;
  origin: string;
  observation: LoginObservation;
  slots: RecipeGenerationRequest["slots"];
  /** The model's validated answer for a form. */
  value: ValidatedGeneratedPage;
  /** The page is a recipe's start page, which alone keeps alternatives and a passkey. */
  startPage: boolean;
  /** Custom-field names the owner's saved bindings of the recipe carry (ADR 0027). */
  carriedNames: ReadonlyMap<string, string>;
  /** The page's kind (ADR 0035); a continuation keeps the layout's own. */
  pageKind: PageKind;
  /** The page's steps replace `base`'s final `advance` click (ADR 0018). */
  replacesLast?: true;
};
/**
 * Builds the layout a model's answer for one page makes (ADR 0060), without writing it:
 * the page's steps appended to `base`, the route of the layout it continues, or a new
 * route without one, stored as the layout `meta` names. Repair builds its layouts here too
 * and decides itself whether one is added, merged or replaces another before it is
 * written. `customSlots` are the custom-field slots the page named, for the answer.
 */
export function buildLoginLayout(
  base: LoginRecipe | undefined,
  page: LayoutPage,
  meta: LayoutMeta,
):
  | {
      ok: true;
      layout: LoginLayout;
      recipe: LoginRecipe;
      customSlots: { slot: string; offered: string }[];
    }
  | { ok: false; answer: Extract<RecipeGenerationResult, { status: "failed" | "unavailable" }> } {
  const { value, observation, slots, carriedNames, startPage } = page;
  // Each custom-field slot of any identifier set, under the name the page's text or the
  // saved bindings gave it: the recipe stores only that name, and the extension maps it
  // back to the offered field (ADR 0027). A requested slot has one name in every set and
  // names are numbered apart, so each name appears once. A later page's validated plan has
  // no alternatives and no passkey button (see `startPage` in `generateRecipe`).
  const alternatives = value.alternatives ?? [];
  const passkey = value.passkeyTarget;
  const customSlots = [
    ...new Map(
      [value, ...alternatives]
        .flatMap((plan) => plan.fields)
        .flatMap(({ slot, name }) => (name === undefined ? [] : [[name, slot] as const])),
    ),
  ].map(([slot, offered]) => ({ slot, offered }));
  // Appending unites slot IDs, so a name the recipe already uses, in any case, could
  // silently merge two different fields. It is refused rather than numbered apart: a form
  // shown again after an error names its field the same, and must not become a next page
  // that fills it again (ADR 0018).
  const used = new Set(base ? recipeSlots(base).map((slot) => slot.toLowerCase()) : []);
  if (customSlots.some(({ slot }) => used.has(slot.toLowerCase())))
    return { ok: false, answer: failed("recipe-invalid") };
  // A carried name never lets through a page its own text refuses: the names the page's
  // text alone gives are checked as well (ADR 0027, amended 2026-10-19).
  if (
    used.size > 0 &&
    carriedNames.size > 0 &&
    [...customSlotNames(observation, slots, [value]).values()].some((name) =>
      used.has(name.toLowerCase()),
    )
  )
    return { ok: false, answer: failed("recipe-invalid") };
  const assembled = appendPageSteps(base, {
    id: page.id,
    origin: page.origin,
    steps: value.steps,
    ...(alternatives.length ? { alternatives: alternatives.map((entry) => entry.steps) } : {}),
    ...(value.switchTarget ? { accountSwitch: value.switchTarget } : {}),
    ...(passkey ? { passkey } : {}),
    ...(value.passkeyOnly && startPage ? { passkeyOnly: true } : {}),
    pageKind: page.pageKind,
    ...(page.replacesLast ? { replacesLast: true } : {}),
  });
  // A page that fills one of the recipe's slots again, as its identifier form shown again
  // where it posted, is refused before anything is stored (ADR 0018).
  if (!assembled.ok)
    return {
      ok: false,
      answer:
        assembled.reason === "invalid-recipe" || assembled.reason === "slot-refilled"
          ? failed("recipe-invalid")
          : unavailable("recipe-conflict"),
    };
  return {
    ok: true,
    layout: toLoginLayout(assembled.recipe, meta),
    recipe: assembled.recipe,
    customSlots,
  };
}
