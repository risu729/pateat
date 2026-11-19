import {
  isDetailSlot,
  isLoginRecipeDocument,
  loginStepEffect,
  MAX_RECIPE_START_PATHS,
  runsLogin,
  sameLoginTarget,
  storedRecipeStartPath,
  storedRecipeStartPaths,
  startPathFor,
  TOTP_HANDLER_SLOT,
  type LoginLayout,
  type LoginObservation,
  type LoginStep,
  type LoginTarget,
  type ObservedCandidate,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import { type GenerationBackend } from "../backend";
import { generatedRecipeId } from "./policy";
import { active, answerable } from "./responses";

/** A recipe a generation request answers with. */
type AnsweredChange = NonNullable<ReturnType<typeof answerable>>;

// A page on a new path that shows the first page of one of the origin's sign-in layouts
// unchanged starts that recipe there too (ADR 0060 amendment of 2026-11-18, owner
// 2026-11-19 01:37 UTC): the path is added to the recipe's `starts`, with no model call,
// so its bindings, handlers and markers carry over. Anything that cannot prove the same
// form generates the page as before.

/** The roles a fill field of each kind of slot may have on the page. */
const identifierRoles: ReadonlySet<ObservedCandidate["role"]> = new Set(["text", "email", "tel"]);
const passwordRoles: ReadonlySet<ObservedCandidate["role"]> = new Set(["password"]);
const buttonRoles: ReadonlySet<ObservedCandidate["role"]> = new Set(["button"]);

/**
 * The first page of one variant: its steps from the first, all on the start path, up to and
 * including the first that advances or submits. `undefined` when that page cannot be
 * compared with a description: it leaves the start path first, never takes effect, or
 * waits for or asserts an element, which a description need not name.
 */
function firstPage(steps: readonly LoginStep[], start: string): LoginStep[] | undefined {
  const end = steps.findIndex((step) => loginStepEffect(step) !== "prepare");
  if (end < 0) return undefined;
  const page = steps.slice(0, end + 1);
  return page.every(
    (step) => step.path === start && (step.kind === "fill" || step.kind === "click"),
  )
    ? page
    : undefined;
}

/**
 * Each element a layout's first page names, with the roles its candidate may have: every
 * variant's fill fields and clicks, and the passkey route's button. A field for the TOTP
 * code or a personal detail, a passkey-only layout and a layout of another kind than a
 * sign-in form are never compared.
 */
function firstPageElements(
  layout: LoginLayout,
  start: string,
): { target: LoginTarget; keypad?: unknown; roles: ReadonlySet<string> }[] {
  if (!runsLogin(layout) || layout.passkeyOnly) return [];
  const elements: ReturnType<typeof firstPageElements> = [];
  for (const steps of [layout.steps, ...(layout.alternatives ?? []).map((entry) => entry.steps)]) {
    const page = firstPage(steps, start);
    if (!page) return [];
    for (const step of page) {
      if (step.kind === "click") {
        // Enter is pressed in the field the fill before typed last, already compared.
        if (step.press === undefined) elements.push({ target: step.target, roles: buttonRoles });
        continue;
      }
      if (step.kind !== "fill") return [];
      for (const field of step.fields) {
        if (field.slot === TOTP_HANDLER_SLOT || isDetailSlot(field.slot)) return [];
        elements.push({
          target: field.target,
          keypad: field.keypad,
          roles: field.slot === "password" ? passwordRoles : identifierRoles,
        });
      }
    }
  }
  if (layout.passkey) {
    if (layout.passkey.path !== start) return [];
    elements.push({ target: layout.passkey.target, roles: buttonRoles });
  }
  return elements;
}

/**
 * Whether the page described shows the layout's first page unchanged: each element it
 * names is exactly one candidate of the description, of a role its slot takes (an
 * identifier a text, email or telephone input, the password a password input, a click a
 * button), with the same software keyboard if any; and the page has no password input
 * the layout does not fill, so a form that asks for a new password never matches.
 */
export function showsFirstPage(
  layout: LoginLayout,
  start: string,
  observation: LoginObservation,
): boolean {
  const elements = firstPageElements(layout, start);
  if (!elements.length) return false;
  const named = new Set<string>();
  for (const element of elements) {
    const found = observation.candidates.filter((candidate) =>
      sameLoginTarget(candidate.target, element.target),
    );
    const candidate = found[0];
    if (
      found.length !== 1 ||
      !candidate ||
      !element.roles.has(candidate.role) ||
      JSON.stringify(candidate.keypad ?? null) !== JSON.stringify(element.keypad ?? null)
    )
      return false;
    named.add(candidate.id);
  }
  return observation.candidates.every(
    (candidate) => candidate.role !== "password" || named.has(candidate.id),
  );
}

/**
 * The origin's recipe whose sign-in layout a first page on a new path shows unchanged, as
 * the one of its active heads that alone has exactly one such layout; `undefined` for
 * none, several, a recipe that already starts on as many paths as it may, or a page that
 * is no sign-in form's.
 */
export function sameFormRecipe(
  heads: readonly StoredLoginRecipe[],
  observation: LoginObservation,
): StoredLoginRecipe | undefined {
  if (!observation.complete || observation.accounts !== undefined) return undefined;
  const matches = heads.flatMap((recipe) => {
    if (recipe.origin !== observation.origin || !isLoginRecipeDocument(recipe)) return [];
    const start = storedRecipeStartPath(recipe);
    if (start === observation.path) return [];
    const shown = recipe.layouts.filter((layout) => showsFirstPage(layout, start, observation));
    // A recipe with two layouts that both match counts as several, as the page cannot say
    // which one it shows.
    return shown.map(() => recipe);
  });
  const [only] = matches;
  return matches.length === 1 &&
    only &&
    storedRecipeStartPaths(only).length < MAX_RECIPE_START_PATHS
    ? only
    : undefined;
}

/**
 * Whether the recipe generated for the origin and path is active: a path whose own recipe
 * was revoked holds only its tombstone, so no recipe starts there and the path may become
 * another recipe's start path (ADR 0060 amendment of 2026-11-18, agent's choice), as when
 * a second recipe generated there by mistake was revoked.
 */
async function ownRecipeStarts(
  backend: GenerationBackend,
  origin: string,
  path: string,
): Promise<boolean> {
  return active(await backend.readHead(await generatedRecipeId(origin, path))) !== undefined;
}

/**
 * The answer to a first page on a path no recipe of its own starts on (ADR 0060 amendment of
 * 2026-11-18): the origin's recipe that already starts there, or the one that shows the same
 * form, written with the path added to its `starts`. `undefined` generates the page as
 * before. A write another writer beat reads the origin again once, so a recipe another
 * device added the path to answers as it is.
 */
export async function startAlias(
  backend: GenerationBackend,
  observation: LoginObservation,
): Promise<AnsweredChange | undefined> {
  const { origin, path } = observation;
  if (await ownRecipeStarts(backend, origin, path)) return undefined;
  const first = await aliasOnce(backend, observation);
  if (first !== "raced") return first;
  const second = await aliasOnce(backend, observation);
  return second === "raced" ? undefined : second;
}

/** One read of the origin's recipes and, for the same form, one write of the path. */
async function aliasOnce(
  backend: GenerationBackend,
  observation: LoginObservation,
): Promise<AnsweredChange | "raced" | undefined> {
  const { origin, path } = observation;
  const changes = await backend.originRecipes(origin);
  const heads = changes.flatMap((change) => {
    const current = active(change);
    return current ? [current.recipe] : [];
  });
  const already = heads.filter((recipe) => storedRecipeStartPaths(recipe).includes(path));
  if (already.length > 1) return undefined;
  if (already.length === 1)
    return answerable(changes.find((change) => change.recipeId === already[0]!.id) ?? null);
  const recipe = sameFormRecipe(heads, observation);
  // Only the recipe generated for its own start path takes another one (ADR 0018).
  if (!recipe || (await generatedRecipeId(origin, storedRecipeStartPath(recipe))) !== recipe.id)
    return undefined;
  const written = await backend.writeRecipe(
    recipe.id,
    {
      version: 1,
      state: "active",
      expectedRevision: recipe.revision,
      recipe: {
        ...recipe,
        revision: recipe.revision + 1,
        starts: [...("starts" in recipe && recipe.starts ? recipe.starts : []), path],
      },
    },
    {},
  );
  if (written.ok) return answerable(written.change);
  return written.limited ? undefined : "raced";
}

/**
 * A page of a recipe described on one of its other start paths, read as the start page it
 * shows (ADR 0060 amendment of 2026-11-18): with the recipe's start path, so a continuation,
 * a repair, a judgement or an SSO entry of that page keeps every path the recipe stores and
 * every limit keyed by it as on the start path. Any other page is read as it is.
 */
export function onStartPath(
  change: SyncRecipeChange | null,
  observation: LoginObservation,
): LoginObservation {
  const recipe = active(change)?.recipe;
  if (!recipe || recipe.origin !== observation.origin) return observation;
  const start = startPathFor(recipe, observation.path);
  return start === observation.path ? observation : { ...observation, path: start };
}

/**
 * The recipe a page on a path no recipe of its own starts on belongs to as one of its other
 * start paths (ADR 0060 amendment of 2026-11-18), with the page read on that recipe's start
 * path; `undefined` when none or several of the origin's recipes start there.
 */
export async function aliasedStart(
  backend: GenerationBackend,
  observation: LoginObservation,
): Promise<
  { recipeId: string; change: SyncRecipeChange; observation: LoginObservation } | undefined
> {
  const { origin, path } = observation;
  if (await ownRecipeStarts(backend, origin, path)) return undefined;
  const owners = (await backend.originRecipes(origin)).filter((change) => {
    const recipe = active(change)?.recipe;
    return recipe !== undefined && storedRecipeStartPaths(recipe).includes(path);
  });
  const [only] = owners;
  return owners.length === 1 && only
    ? { recipeId: only.recipeId, change: only, observation: onStartPath(only, observation) }
    : undefined;
}
