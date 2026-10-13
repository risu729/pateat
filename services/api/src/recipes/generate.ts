import {
  chooserBranch,
  isLoginRouteRecipe,
  loginChooserRecipeSchema,
  loginStepEffect,
  recipeHasRoute,
  recipeSlots,
  routeFillTargets,
  routeSignInPaths,
  routeSignInTargets,
  sameLoginTarget,
  storedRecipeStartPath,
  withChooserBranch,
  type ChooserBranch,
  type EntryGenerationRequest,
  type EntryGenerationResult,
  type GenerationUnavailableReason,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginMarkerTarget,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import { loginMoveFits } from "@pateat/contracts/site";
import {
  accountListGenerationInstructions,
  accountListGenerationPromptVersion,
  addCompletion,
  addHandler,
  appendPageSteps,
  claudeRefusalCategory,
  completionInstructions,
  completionPromptVersion,
  completionStopInstructions,
  completionStopPromptVersion,
  createCompletionJudge,
  createEntryGenerator,
  createRecipeGenerator,
  entryGenerationInstructions,
  entryGenerationPromptVersion,
  entryRecipe,
  generationInstructions,
  generationPromptVersion,
  outputRejection,
  type InferenceErrorCode,
  type InferenceOutcome,
} from "@pateat/inference";
import { and, count, eq, gt, gte, lt, notInArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import type { DeviceScope } from "../auth";
import { callClaude, MAX_OUTPUT_TOKENS, ROLE_LIMITS, type ClaudeCall } from "../claude/calls";
import { generationAttempts, pageJudgements, type PageJudgementVerdict } from "../db/schema";
import { hasRecipeRoom, readHead, writeRecipe } from "../recipe-store";

// The recipe generation routes of ADR 0018: one page per call, appended to one recipe
// per origin and start path (ADR 0016), and a page no recipe check explained judged for
// the recipe's completion or a handler (ADR 0027).

/** A page tried is not sent to the model again for this long (owner, 2026-10-12). */
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Judgements per recipe per UTC day, whatever the path (owner, ADR 0027). */
export const JUDGEMENTS_PER_RECIPE_DAY = 20;
const utcDayStart = (now: number) => now - (now % DAY_MS);

type AttemptDb = Parameters<NonNullable<ClaudeCall<unknown>["gate"]>>[0];
type GenerationEnv = { DB: D1Database; OIDC_ISSUER?: string; OIDC_SIGNING_KEYS?: string };
type Failure = Extract<RecipeGenerationResult, { status: "failed" }>["error"];

const roleConfig = {
  limits: ROLE_LIMITS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  refusalCategory: claudeRefusalCategory,
};

/**
 * One generated recipe per origin and start path, so devices generating together
 * converge on it, and a page where another recipe of the origin does not start gets its
 * own (ADR 0016, "Pages where no recipe starts").
 */
export async function generatedRecipeId(origin: string, startPath: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([origin, startPath])),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
  return `gen-${hex.join("").slice(0, 32)}`;
}

const unavailable = (reason: GenerationUnavailableReason) =>
  ({ version: 1, status: "unavailable", reason }) as const;
const failed = (error: Failure) => ({ version: 1, status: "failed", error }) as const;
// Nobody waits on a cancelled request, so it reads as the timeout that usually causes it.
const failureOf = (error: InferenceErrorCode): Failure =>
  error === "cancelled" ? "timeout" : error;
const active = (change: SyncRecipeChange | null) =>
  change?.state === "active" ? change : undefined;
/**
 * An active head a generation or judgement answers with: a route recipe, or a chooser
 * recipe (ADR 0028) for an account list or one of its branches. An entry recipe (ADR 0031)
 * is never one.
 */
const answerable = (
  change: SyncRecipeChange | null,
): Extract<RecipeGenerationResult, { status: "recipe" }>["change"] | undefined => {
  const head = active(change);
  return head && !("entry" in head.recipe) ? { ...head, recipe: head.recipe } : undefined;
};
/** The branch's route recipe of a chooser head, or the head's own route recipe without one. */
function routeOf(
  recipe: StoredLoginRecipe,
  branch: ChooserBranch | undefined,
): LoginRecipe | undefined {
  if (branch) return "chooser" in recipe ? chooserBranch(recipe, branch) : undefined;
  return isLoginRouteRecipe(recipe) ? recipe : undefined;
}
/**
 * A route recipe changed for a page, written back under its chooser for a branch, or
 * `undefined` when the chooser it makes fails its own schema, so devices never get a
 * recipe they refuse to sync.
 */
function stored(
  head: StoredLoginRecipe,
  branch: ChooserBranch | undefined,
  next: LoginRecipe,
): StoredLoginRecipe | undefined {
  if (!branch || !("chooser" in head)) return next;
  const chooser = withChooserBranch(head, branch, next);
  return v.is(loginChooserRecipeSchema, chooser) ? chooser : undefined;
}
/**
 * The answer of a call that produced no value: failed, with the check that refused the
 * model's output (codes only), or abstained.
 */
function unsettled<T>(
  outcome: InferenceOutcome<T>,
): { answer: RecipeGenerationResult & EntryGenerationResult } | { value: T } {
  if (outcome.status === "failed") {
    // Which check refused the model's output, so the device can log it (codes only).
    const rejection = outputRejection(outcome);
    return { answer: { ...failed(failureOf(outcome.error)), ...(rejection ? { rejection } : {}) } };
  }
  if (outcome.status === "abstained")
    return {
      answer: {
        version: 1,
        status: "abstained",
        // The generation role abstains only with these; anything else is not evidence.
        reason:
          outcome.reason === "no-login-form" ||
          outcome.reason === "ambiguous" ||
          outcome.reason === "unsafe-instructions"
            ? outcome.reason
            : "insufficient-evidence",
      },
    };
  return { value: outcome.value };
}

/**
 * The 10-minute retry window of one generation call and its attempt row (ADR 0016), keyed
 * by the recipe, the chooser branch (empty without one), the path and the revision the
 * call's write replaces. `recheck` reads the stored head again under the owner's lock.
 */
function attemptWindow(
  ownerId: string,
  key: { recipeId: string; branch: string; origin: string; path: string; baseRevision: number },
  recheck: () => Promise<GenerationUnavailableReason | undefined>,
) {
  const { recipeId, branch, origin, path, baseRevision } = key;
  return {
    gate: async (db: AttemptDb, now: number) => {
      const stale = await recheck();
      if (stale) return stale;
      const [recent] = await db
        .select()
        .from(generationAttempts)
        .where(
          and(
            eq(generationAttempts.ownerId, ownerId),
            eq(generationAttempts.recipeId, recipeId),
            eq(generationAttempts.branch, branch),
            eq(generationAttempts.path, path),
            eq(generationAttempts.baseRevision, baseRevision),
            gt(generationAttempts.attemptedAt, now - ATTEMPT_WINDOW_MS),
          ),
        )
        .limit(1);
      return recent ? "recently-tried" : undefined;
    },
    reserved: (db: AttemptDb, now: number) => [
      db
        .insert(generationAttempts)
        .values({ ownerId, recipeId, branch, origin, path, baseRevision, attemptedAt: now })
        .onConflictDoUpdate({
          target: [
            generationAttempts.ownerId,
            generationAttempts.recipeId,
            generationAttempts.branch,
            generationAttempts.path,
            generationAttempts.baseRevision,
          ],
          set: { attemptedAt: now },
        }),
      db
        .delete(generationAttempts)
        .where(
          and(
            eq(generationAttempts.ownerId, ownerId),
            lt(generationAttempts.attemptedAt, now - ATTEMPT_WINDOW_MS),
          ),
        ),
    ],
  };
}

/** Whether two route recipes are the same apart from their revision, absent ones included. */
const sameRoute = (left: LoginRecipe | undefined, right: LoginRecipe | undefined) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    JSON.stringify({ ...left, revision: 0 }) === JSON.stringify({ ...right, revision: 0 }));

/**
 * `POST /v1/recipes/generate`. Returns `undefined` when `base` names a recipe other
 * than one generated for this origin, which the route answers as a bad request.
 *
 * A page that lists accounts (ADR 0028) starts a chooser recipe; a page sent with a
 * `branch` is the next page of that chooser branch: its first, after the click on the
 * list, or a later one after an advance. Either answers with the chooser.
 */
export async function generateRecipe(
  env: GenerationEnv,
  scope: DeviceScope,
  request: RecipeGenerationRequest,
): Promise<RecipeGenerationResult | undefined> {
  const { observation, slots, base, branch } = request;
  const { origin, path } = observation;
  // A first page starts its own recipe; a later page continues the one in `base`.
  const recipeId = base?.recipeId ?? (await generatedRecipeId(origin, path));
  if (!/^gen-[0-9a-f]{32}$/u.test(recipeId)) return undefined;
  if (!observation.complete) return failed("incomplete-observation");
  // A list of accounts is only ever a recipe's first page.
  const list = observation.accounts !== undefined;
  if (list && base) return failed("invalid-request");
  /** Whether a stored recipe is the one generated for this origin under this ID. */
  const generatedHere = async (recipe: StoredLoginRecipe) =>
    recipe.origin === origin &&
    recipe.id === recipeId &&
    (await generatedRecipeId(origin, storedRecipeStartPath(recipe))) === recipeId;
  /** Whether a stored recipe is the kind this request writes: a chooser, or a route. */
  const fits = (recipe: StoredLoginRecipe) =>
    list || branch ? "chooser" in recipe : isLoginRouteRecipe(recipe);

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * route to continue (`undefined` for a first page) with the chooser it belongs to for a
   * branch. Checked again under the lock.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<
    | { answer: RecipeGenerationResult }
    | {
        base: LoginRecipe | undefined;
        chooser?: LoginChooserRecipe;
        revoked?: number;
      }
  > => {
    // A revoked recipe is generated again from its first page, as the revision after its
    // tombstone (owner, 2026-10-12); a later page never continues it.
    if (head?.state === "revoked") {
      if (base) return { answer: unavailable("recipe-revoked") };
      return (await hasRecipeRoom(env.DB, scope.ownerId))
        ? { base: undefined, revoked: head.revision }
        : { answer: unavailable("recipe-limit") };
    }
    const current = active(head);
    // Only the recipe generated here answers; a device write under the ID cannot redirect it.
    if (current && !(await generatedHere(current.recipe)))
      return { answer: unavailable("recipe-conflict") };
    // An entry recipe (ADR 0031), a chooser for a form or a route recipe for a list of this
    // origin and path is no recipe to answer with.
    const answer = answerable(head);
    if (current && (!answer || !fits(answer.recipe)))
      return { answer: unavailable("recipe-conflict") };
    if (answer && (!base || answer.revision !== base.revision))
      // Another device already generated it, or appended this page first: use that.
      return { answer: { version: 1, status: "recipe", change: answer } };
    // A first page adds a recipe, so the owner needs room for one before any model call.
    if (!base)
      return (await hasRecipeRoom(env.DB, scope.ownerId))
        ? { base: undefined }
        : { answer: unavailable("recipe-limit") };
    if (!current) return { answer: unavailable("recipe-conflict") };
    const chooser = "chooser" in current.recipe ? current.recipe : undefined;
    // The other branch starts only with the chooser's button for it.
    if (branch === "other" && !chooser?.chooser.other)
      return { answer: unavailable("recipe-conflict") };
    const route = routeOf(current.recipe, branch);
    // A branch's first page has nothing to continue yet.
    if (chooser && !route) return { base: undefined, chooser };
    const last = route?.steps.at(-1);
    if (!route || route.completion || !last || loginStepEffect(last) !== "advance")
      return { answer: unavailable("recipe-conflict") };
    return { base: route, ...(chooser ? { chooser } : {}) };
  };
  /** The revision a decision's write replaces, which keys its attempt. */
  const revisionOf = (decision: {
    base?: LoginRecipe | undefined;
    chooser?: LoginChooserRecipe | undefined;
    revoked?: number | undefined;
  }) => decision.chooser?.revision ?? decision.base?.revision ?? decision.revoked ?? 0;
  const before = await decide(await readHead(env.DB, scope.ownerId, recipeId));
  if ("answer" in before) return before.answer;
  const baseRecipe = before.base;
  const chooser = before.chooser;
  // The attempt key and the write follow the revision the new one replaces.
  const baseRevision = revisionOf(before);
  const attemptBranch = branch ?? "";
  let raced: RecipeGenerationResult | undefined;

  const call = await callClaude(env, scope.ownerId, {
    role: "generate",
    // Only a list of accounts gets the list line (ADR 0028).
    promptVersion: await (list ? accountListGenerationPromptVersion : generationPromptVersion)(),
    origin,
    path,
    request: {
      instructions: list ? accountListGenerationInstructions : generationInstructions,
      slots,
      observation,
    },
    ...attemptWindow(
      scope.ownerId,
      { recipeId, branch: attemptBranch, origin, path, baseRevision },
      async () => {
        // Another device may have stored this recipe while this request waited for the lock.
        const latest = await decide(await readHead(env.DB, scope.ownerId, recipeId));
        if ("answer" in latest) {
          raced = latest.answer;
          return "recipe-conflict";
        }
        // A recipe generated and revoked meanwhile would make this call's write fail.
        return revisionOf(latest) !== baseRevision ? "recipe-conflict" : undefined;
      },
    ),
    invoke: (model) => createRecipeGenerator({ model, ...roleConfig })({ observation, slots }),
    logValue: (value) => {
      if ("accountList" in value)
        return {
          accountList: true,
          ...(value.other ? { other: value.other.candidate } : {}),
          ...(value.continue ? { continue: value.continue.candidate } : {}),
        };
      const { fields, action, accountSwitch, alternatives, passkeyButton } = value;
      return {
        fields,
        action,
        ...(accountSwitch ? { accountSwitch } : {}),
        ...(passkeyButton ? { passkeyButton } : {}),
        ...(alternatives?.length
          ? {
              alternatives: alternatives.map((entry) => ({
                fields: entry.fields,
                action: entry.action,
              })),
            }
          : {}),
      };
    },
  });
  if (call.status === "unavailable") return raced ?? unavailable(call.reason);
  const result = unsettled(call.outcome);
  if ("answer" in result) return result.answer;
  /**
   * Writes the recipe after `baseRevision` and answers with it, with `customSlots` when
   * given, or with what won the race: only the recipe this call wrote has a mapping to
   * answer with. A branch's page lost to a write of the chooser's other branch, or of a
   * judgement there, is written once more onto that head, so the paid answer is kept.
   */
  const save = async (
    recipe: StoredLoginRecipe,
    customSlots: { slot: string; offered: string }[] = [],
    rebase?: (head: SyncRecipeChange | null) => Promise<StoredLoginRecipe | undefined>,
  ): Promise<RecipeGenerationResult> => {
    let next = recipe;
    let expectedRevision = baseRevision;
    for (let tries = 0; ; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const written = await writeRecipe(
        env.DB,
        scope.ownerId,
        recipeId,
        { version: 1, state: "active", expectedRevision, recipe: next },
        scope.deviceId,
      );
      if (written.ok) {
        const change = answerable(written.change);
        if (!change) return unavailable("recipe-conflict");
        return {
          version: 1,
          status: "recipe",
          change,
          ...(customSlots.length ? { customSlots } : {}),
        };
      }
      if (written.limited) return unavailable("recipe-limit");
      // eslint-disable-next-line no-await-in-loop
      const moved = tries === 0 ? await rebase?.(written.current) : undefined;
      if (!moved) {
        // A write lost to another device answers with that device's recipe, as above.
        // eslint-disable-next-line no-await-in-loop
        const lost = await decide(written.current);
        return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
      }
      next = moved;
      expectedRevision = moved.revision - 1;
    }
  };
  const { value } = result;
  // The role answers a list only for a list and a plan only for a form; checked again here.
  if ("accountList" in value !== list) return failed("invalid-output");
  if ("accountList" in value) {
    // The list becomes a chooser recipe without branches; each branch is generated once a
    // login takes it (ADR 0028). A recipe generated again follows its tombstone's revision.
    const recipe = v.safeParse(loginChooserRecipeSchema, {
      version: 1,
      id: recipeId,
      revision: baseRevision + 1,
      origin,
      chooser: {
        path,
        ...(value.other ? { other: value.other.target } : {}),
        ...(value.continue ? { continue: value.continue.target } : {}),
      },
    });
    return recipe.success ? save(recipe.output) : failed("recipe-invalid");
  }

  // Each custom-field slot the model named, in any identifier set: the recipe stores only
  // the generic name, and the extension maps it back to the offered field (ADR 0027). A
  // requested slot has one name in every set, so each name appears once. Every variant
  // starts on the start page, so a continuation's alternatives are dropped rather than
  // failing a call that was already paid for. So is the passkey sign-in button, which
  // becomes the `passkey` route of a recipe's first page only. A chooser branch's pages
  // all follow the click on the list, so none of them is a start page.
  const later = baseRecipe !== undefined || chooser !== undefined;
  const alternatives = later ? [] : (value.alternatives ?? []);
  const passkey = later ? undefined : value.passkeyTarget;
  const customSlots = [
    ...new Map(
      [value, ...alternatives]
        .flatMap((plan) => plan.fields)
        .flatMap(({ slot, name }) => (name === undefined ? [] : [[name, slot] as const])),
    ),
  ].map(([slot, offered]) => ({ slot, offered }));
  // Appending unites slot IDs, so a name the recipe already uses could silently merge two
  // different fields.
  if (baseRecipe && customSlots.some(({ slot }) => recipeSlots(baseRecipe).includes(slot)))
    return failed("recipe-invalid");
  const assembled = appendPageSteps(baseRecipe, {
    id: recipeId,
    origin,
    steps: value.steps,
    ...(alternatives.length ? { alternatives: alternatives.map((entry) => entry.steps) } : {}),
    ...(value.switchTarget ? { accountSwitch: value.switchTarget } : {}),
    ...(passkey ? { passkey } : {}),
  });
  // A page that fills one of the recipe's slots again, as its identifier form shown again
  // where it posted, is refused before anything is stored (ADR 0018).
  if (!assembled.ok)
    return assembled.reason === "invalid-recipe" || assembled.reason === "slot-refilled"
      ? failed("recipe-invalid")
      : unavailable("recipe-conflict");
  // A recipe generated again follows its tombstone's revision.
  const next = { ...assembled.recipe, revision: baseRevision + 1 };
  if (!chooser || !branch) return save(next, customSlots);
  const written = stored(chooser, branch, next);
  if (!written) return failed("recipe-invalid");
  return save(written, customSlots, async (head) => {
    // Only a head whose own branch is still the one this page continues takes the page.
    const current = active(head);
    if (
      !current ||
      !("chooser" in current.recipe) ||
      !(await generatedHere(current.recipe)) ||
      (branch === "other" && !current.recipe.chooser.other) ||
      !sameRoute(chooserBranch(current.recipe, branch), baseRecipe)
    )
      return undefined;
    return stored(current.recipe, branch, { ...next, revision: current.revision + 1 });
  });
}

/**
 * `POST /v1/recipes/generate` without `slots`: an entry request (ADR 0031) for a page
 * without a login form. The model names the link that opens the site's login page, which
 * is stored as the entry recipe of the page's origin and path under its generated ID. The
 * retry window, attempt row, spend limits and request log are a first page's; a login or
 * chooser recipe starting on that path answers `recipe-conflict`.
 */
export async function generateEntry(
  env: GenerationEnv,
  scope: DeviceScope,
  request: EntryGenerationRequest,
): Promise<EntryGenerationResult> {
  const { observation } = request;
  const { origin, path } = observation;
  const recipeId = await generatedRecipeId(origin, path);
  if (!observation.complete) return failed("incomplete-observation");

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * revision the new recipe follows (its tombstone's, or 0). Checked again under the lock.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<{ answer: EntryGenerationResult } | { revision: number }> => {
    const current = active(head);
    if (current) {
      // Only the entry recipe generated here answers; a login or chooser recipe on its path,
      // or a device write under the ID for another page, is no entry to answer with.
      const { recipe } = current;
      return "entry" in recipe &&
        recipe.origin === origin &&
        recipe.id === recipeId &&
        recipe.entry.path === path
        ? { answer: { version: 1, status: "recipe", change: { ...current, recipe } } }
        : { answer: unavailable("recipe-conflict") };
    }
    // A revoked recipe is generated again as the revision after its tombstone (owner,
    // 2026-10-12), and a new one needs room under the active recipe limit.
    if (!(await hasRecipeRoom(env.DB, scope.ownerId)))
      return { answer: unavailable("recipe-limit") };
    return { revision: head?.revision ?? 0 };
  };
  const before = await decide(await readHead(env.DB, scope.ownerId, recipeId));
  if ("answer" in before) return before.answer;
  const baseRevision = before.revision;
  let raced: EntryGenerationResult | undefined;

  const call = await callClaude(env, scope.ownerId, {
    role: "generate",
    promptVersion: await entryGenerationPromptVersion(),
    origin,
    path,
    request: { instructions: entryGenerationInstructions, observation },
    ...attemptWindow(
      scope.ownerId,
      { recipeId, branch: "", origin, path, baseRevision },
      async () => {
        // Another device may have stored this recipe while this request waited for the lock.
        const latest = await decide(await readHead(env.DB, scope.ownerId, recipeId));
        if ("answer" in latest) {
          raced = latest.answer;
          return "recipe-conflict";
        }
        return latest.revision !== baseRevision ? "recipe-conflict" : undefined;
      },
    ),
    invoke: (model) => createEntryGenerator({ model, ...roleConfig })({ observation }),
    logValue: ({ entry: candidate }) => ({ entry: candidate }),
  });
  if (call.status === "unavailable") return raced ?? unavailable(call.reason);
  const result = unsettled(call.outcome);
  if ("answer" in result) return result.answer;
  // A recipe generated again follows its tombstone's revision.
  const built = entryRecipe({
    id: recipeId,
    revision: baseRevision + 1,
    origin,
    path,
    target: result.value.target,
  });
  if (!built.ok) return failed("recipe-invalid");
  const written = await writeRecipe(
    env.DB,
    scope.ownerId,
    recipeId,
    { version: 1, state: "active", expectedRevision: baseRevision, recipe: built.recipe },
    scope.deviceId,
  );
  if (!written.ok) {
    if (written.limited) return unavailable("recipe-limit");
    // A write lost to another device answers with that device's recipe, as above.
    const lost = await decide(written.current);
    return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
  }
  const change = active(written.change);
  return change && "entry" in change.recipe
    ? { version: 1, status: "recipe", change: { ...change, recipe: change.recipe } }
    : unavailable("recipe-conflict");
}

/**
 * Why a recipe head read again under the owner's lock can no longer be judged at the
 * revision that ran: revoked, gone or replaced meanwhile.
 */
export function staleHead(
  latest: SyncRecipeChange | null,
  revision: number,
): "recipe-revoked" | "recipe-conflict" | undefined {
  if (latest?.state === "revoked") return "recipe-revoked";
  return latest?.state === "active" && latest.revision === revision ? undefined : "recipe-conflict";
}

/**
 * `POST /v1/recipes/:recipeId/completion`: judges a page after an effect step of the
 * login's route (ADR 0027), on the recipe's origin or on another origin that the login's
 * tab moved to (ADR 0022). Returns `undefined` for a missing recipe and `null` for a page
 * of an origin no move could reach, which the route answers as 404 and 400.
 */
export async function judgeCompletion(
  env: GenerationEnv,
  scope: DeviceScope,
  recipeId: string,
  request: RecipeCompletionRequest,
): Promise<RecipeCompletionResult | undefined | null> {
  const head = await readHead(env.DB, scope.ownerId, recipeId);
  if (!head) return undefined;
  if (head.state === "revoked") return unavailable("recipe-revoked");
  const { observation, route, branch, partial } = request;
  // A page at a `password` login's stop before its item's missing password (ADR 0036, owner
  // 2026-10-13 05:39 UTC): judged though it shows the route's password field, for a
  // `passkey` handler only.
  const stop = request.stop === true;
  // Only a page of the revision that ran, on a route the stored recipe has, is judged: the
  // recipe's own, or for a chooser (ADR 0028) the route of the branch the login took. An
  // entry recipe (ADR 0031) has no route.
  const recipe = routeOf(head.recipe, branch);
  // A page of another origin is one a `password` login's tab moved to right after its
  // submission (ADR 0022): of the site, or of another site right after a second factor,
  // which a page answered by itself may ask for without any recipe step, so the extension
  // alone knows it. The recipe's paths are not that origin's, and its markers there carry
  // that origin.
  const moved = observation.origin !== head.recipe.origin;
  if (
    moved &&
    (route !== "password" || !loginMoveFits(head.recipe.origin, observation.origin, true))
  )
    return null;
  if (!recipe || head.revision !== request.revision || !recipeHasRoute(recipe, route))
    return unavailable("recipe-conflict");
  if (!observation.complete) return failed("incomplete-observation");
  // A list of accounts shown again is the sign-in's start, not its result (ADR 0028). A
  // stop's page is judged only on a recipe without a chooser and on its own origin: the
  // extension never sends a chooser branch's stop (ADR 0036, account lists).
  if (observation.accounts || (stop && (moved || "chooser" in head.recipe)))
    return unavailable("not-judgeable");
  // The checks use the stored recipe, never the request: a page that still shows one of
  // the password route's fill fields, of any variant and on any path, or a signed-in
  // marker is not judged. The request never names the variant the login ran. The passkey
  // route starts beside that form, so the form counts for it too; and a page on its
  // sign-in paths that still shows its button is not judged either: its passkey exchange
  // may still be running, as the extension holds it.
  const markers = (recipe.completion ?? [])
    .filter((marker) => (marker.origin ?? head.recipe.origin) === observation.origin)
    .map((marker) => marker.target);
  const shown = (targets: readonly LoginMarkerTarget[]) =>
    observation.candidates.some((candidate) =>
      targets.some((target) => sameLoginTarget(target, candidate.target)),
    );
  // A stop's page is the sign-in page by design: it must show one of the route's fill
  // fields as a password input, and never a signed-in marker.
  const stopPage = observation.candidates.some(
    (candidate) =>
      candidate.role === "password" &&
      routeFillTargets(recipe, "password").some((target) =>
        sameLoginTarget(target, candidate.target),
      ),
  );
  // A stop's page is judged only for a `passkey` handler, which a path that has one never
  // gets again (`addHandler`'s `duplicate`), so it is not sent to the model.
  const passkeyHandled = (recipe.handlers ?? []).some(
    (handler) => handler.kind === "passkey" && handler.path === observation.path,
  );
  if (
    stop
      ? !stopPage || shown(markers) || passkeyHandled
      : shown([...routeFillTargets(recipe, "password"), ...markers]) ||
        (routeSignInPaths(recipe, route).includes(observation.path) &&
          shown(routeSignInTargets(recipe, route)))
  )
    return unavailable("not-judgeable");

  // The login paths come from the stored recipe, never from the request; a branch's
  // login started on its chooser's list.
  const loginPaths = [
    ...new Set([
      ...("chooser" in head.recipe ? [head.recipe.chooser.path] : []),
      ...routeSignInPaths(recipe, route),
      ...(recipe.handlers ?? []).map((handler) => handler.path),
    ]),
  ];
  const ofRecipe = and(
    eq(pageJudgements.ownerId, scope.ownerId),
    eq(pageJudgements.recipeId, recipeId),
  );
  // Each branch of a chooser is judged on its own; its limit per day is the chooser's.
  const judgedBranch = branch ?? "";
  // A stop's page is judged under its own prompt version, so its row never answers another
  // login's page of the path, nor theirs it (ADR 0036). Rows of either current version stay.
  const usualVersion = await completionPromptVersion();
  const stopVersion = await completionStopPromptVersion();
  const promptVersion = stop ? stopVersion : usualVersion;
  const call = await callClaude(env, scope.ownerId, {
    role: "judge",
    promptVersion,
    origin: observation.origin,
    path: observation.path,
    request: {
      instructions: stop ? completionStopInstructions : completionInstructions,
      recipeId,
      route,
      loginPaths,
      observation,
      ...(stop ? { stop } : {}),
    },
    // Each revision, origin and path is judged once per judge prompt version, and a recipe
    // 20 times a UTC day (ADR 0027), counting a stop's pages.
    gate: async (db, now) => {
      const stale = staleHead(await readHead(env.DB, scope.ownerId, recipeId), head.revision);
      if (stale) return stale;
      const [judged] = await db
        .select()
        .from(pageJudgements)
        .where(
          and(
            ofRecipe,
            eq(pageJudgements.branch, judgedBranch),
            eq(pageJudgements.revision, head.revision),
            eq(pageJudgements.origin, observation.origin),
            eq(pageJudgements.path, observation.path),
            eq(pageJudgements.promptVersion, promptVersion),
          ),
        )
        .limit(1);
      // A later login of the revision completes on the path only after a `signed-in` or
      // undecided verdict (ADR 0029): one judged `challenge` or `rejected`, still being
      // judged, or whose request failed does not. A row of an earlier judge prompt does not
      // count: a page it judged `challenge` but kept no handler for, such as a code split
      // into one-digit inputs before those were learned, is judged again. A page the model
      // could not decide on a description that left out a disabled field, as a code field
      // waiting for its code may be, is judged again once the path is described in full; a
      // description that leaves one out again is `already-judged`, which the extension
      // never completes on.
      if (judged && !(judged.verdict === "partial" && !partial))
        return judged.verdict === "challenge"
          ? "judged-challenge"
          : judged.verdict === "rejected"
            ? "judged-rejected"
            : judged.verdict === null
              ? "judgement-unanswered"
              : judged.verdict === "signed-in"
                ? "judged-signed-in"
                : "already-judged";
      const [today] = await db
        .select({ value: count() })
        .from(pageJudgements)
        .where(and(ofRecipe, gte(pageJudgements.judgedAt, utcDayStart(now))));
      return (today?.value ?? 0) >= JUDGEMENTS_PER_RECIPE_DAY ? "judgement-limit" : undefined;
    },
    // A request the role refuses before sending still uses its slot, as a generation
    // attempt does; a `partial` row judged again takes today's slot and waits for its new
    // verdict. Rows of older revisions or judges go once their day is over.
    reserved: (db, now) => [
      db
        .insert(pageJudgements)
        .values({
          ownerId: scope.ownerId,
          recipeId,
          branch: judgedBranch,
          revision: head.revision,
          origin: observation.origin,
          path: observation.path,
          promptVersion,
          judgedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            pageJudgements.ownerId,
            pageJudgements.recipeId,
            pageJudgements.branch,
            pageJudgements.revision,
            pageJudgements.origin,
            pageJudgements.path,
            pageJudgements.promptVersion,
          ],
          set: { judgedAt: now, verdict: null },
          setWhere: eq(pageJudgements.verdict, "partial"),
        }),
      db
        .delete(pageJudgements)
        .where(
          and(
            ofRecipe,
            or(
              lt(pageJudgements.revision, head.revision),
              notInArray(pageJudgements.promptVersion, [usualVersion, stopVersion]),
            ),
            lt(pageJudgements.judgedAt, utcDayStart(now)),
          ),
        ),
    ],
    invoke: (model) =>
      createCompletionJudge({ model, ...roleConfig })({
        observation,
        loginPaths,
        ...(stop ? { stop } : {}),
      }),
    logValue: (judgement) => judgement,
  });
  if (call.status === "unavailable") return unavailable(call.reason);
  const { outcome } = call;
  if (outcome.status === "failed") return failed(failureOf(outcome.error));
  // The verdict goes on the path's row, which tells a later login of the revision what
  // the page was (ADR 0029). A row left without one never completes a login, so a failed
  // write only costs that.
  const keepVerdict = async (verdict: PageJudgementVerdict) => {
    try {
      await drizzle(env.DB)
        .update(pageJudgements)
        .set({ verdict })
        .where(
          and(
            ofRecipe,
            eq(pageJudgements.branch, judgedBranch),
            eq(pageJudgements.revision, head.revision),
            eq(pageJudgements.origin, observation.origin),
            eq(pageJudgements.path, observation.path),
            eq(pageJudgements.promptVersion, promptVersion),
          ),
        );
    } catch {
      console.warn("Page judgement verdict not kept", { recipeId, verdict });
    }
  };
  if (outcome.status === "abstained") {
    // Undecided on a description that left a disabled field out: not kept as `unclear`,
    // so a later login does not complete on the path once the field is enabled.
    await keepVerdict(partial ? "partial" : "unclear");
    return { version: 1, status: "unclear" };
  }
  const judgement = outcome.value;
  // A stop's page keeps a `passkey` handler and nothing else: no rejection, no marker and
  // no `totp` handler. Its other answers are kept as undecided, under the stop's version.
  if (stop && judgement.decision !== "challenge") {
    await keepVerdict("unclear");
    return { version: 1, status: "unclear" };
  }
  await keepVerdict(judgement.decision);
  if (judgement.decision === "rejected") return { version: 1, status: "rejected" };
  if (judgement.decision === "challenge") {
    // A page may offer both a security key and a TOTP code; each handler
    // that passes its checks is kept, in one revision (ADR 0027).
    let changed: LoginRecipe | undefined;
    // Kinds and refusal reasons only: never an element, label or value.
    const handlers: { kind: "passkey" | "totp"; kept: boolean; reason?: string }[] = [];
    if (judgement.passkey) {
      const added = addHandler(recipe, observation, { kind: "passkey", target: judgement.passkey });
      if (added.ok) changed = added.recipe;
      handlers.push({
        kind: "passkey",
        kept: added.ok,
        ...(added.ok ? {} : { reason: added.reason }),
      });
    }
    // A code on a stop's page is never learned (ADR 0036).
    if (judgement.totp && stop) handlers.push({ kind: "totp", kept: false, reason: "stop" });
    else if (judgement.totp) {
      const base = changed ?? recipe;
      const added = addHandler(base, observation, { kind: "totp", ...judgement.totp });
      // Both handlers land in the revision after the judged one.
      if (added.ok) changed = changed ? { ...added.recipe, revision: base.revision } : added.recipe;
      handlers.push({
        kind: "totp",
        kept: added.ok,
        ...(added.ok ? {} : { reason: added.reason }),
      });
    }
    // A code the judge named but its local checks refused is logged with why (ADR 0027).
    if (judgement.totpDropped && !stop)
      handlers.push({ kind: "totp", kept: false, reason: judgement.totpDropped });
    if (handlers.length) console.info("Judged page handlers", { recipeId, handlers });
    const withHandlers = changed && stored(head.recipe, branch, changed);
    if (!withHandlers) return { version: 1, status: "challenge" };
    const written = await writeRecipe(
      env.DB,
      scope.ownerId,
      recipeId,
      { version: 1, state: "active", expectedRevision: head.revision, recipe: withHandlers },
      scope.deviceId,
    );
    const change = written.ok ? answerable(written.change) : undefined;
    return { version: 1, status: "challenge", ...(change ? { change } : {}) };
  }
  // A later signed-in page adds its marker, up to four (ADR 0029). A recipe that has a
  // marker already is signed in whether or not this one can be added, as with four, a
  // marker it has, or one that breaks the recipe's bounds. So is a page of another origin
  // of the site (ADR 0022): a later request for it answers `judged-signed-in` anyway.
  const signedInAnyway = recipe.completion !== undefined || moved;
  const learned = addCompletion(recipe, observation, judgement.target);
  const signedIn = { version: 1, status: "signed-in" } as const;
  if (!learned.ok) return signedInAnyway ? signedIn : failed("invalid-output");
  const learnedRecipe = stored(head.recipe, branch, learned.recipe);
  if (!learnedRecipe) return signedInAnyway ? signedIn : failed("recipe-invalid");
  const written = await writeRecipe(
    env.DB,
    scope.ownerId,
    recipeId,
    { version: 1, state: "active", expectedRevision: head.revision, recipe: learnedRecipe },
    scope.deviceId,
  );
  const change = written.ok ? answerable(written.change) : undefined;
  if (change) return { ...signedIn, change };
  return signedInAnyway ? signedIn : unavailable("recipe-conflict");
}
