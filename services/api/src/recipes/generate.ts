import {
  findChooserLayout,
  isGeneratedRecipeId,
  loginStepEffect,
  newLayoutKey,
  parseRecipeBranch,
  recipeHasRoute,
  recipeSlots,
  routeFillTargets,
  routeSignInPaths,
  routeSignInTargets,
  sameLoginTarget,
  showsBesideForm,
  storedBranchRoute,
  storedLoginRecipeSchema,
  storedRecipeStartPath,
  toChooserLayout,
  toLoginLayout,
  withChooserBranch,
  withChooserLayout,
  withLoginLayout,
  type ChooserBranch,
  type EntryGenerationRequest,
  type EntryGenerationResult,
  type GenerationUnavailableReason,
  type LayoutMeta,
  type LoginChooserRecipe,
  type LoginLayout,
  type LoginObservation,
  type LoginRecipe,
  type LoginMarkerTarget,
  type LoginRoute,
  type PageKind,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type RecipePageSampleRequest,
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
  carriedSlotNames,
  claudeRefusalCategory,
  completionInstructions,
  completionPromptVersion,
  completionStopInstructions,
  completionStopPromptVersion,
  completionBesideInstructions,
  completionBesidePromptVersion,
  createCompletionJudge,
  createEntryGenerator,
  createRecipeGenerator,
  customSlotNames,
  entryGenerationInstructions,
  entryGenerationPromptVersion,
  entryRecipe,
  generationInstructions,
  generationPromptVersion,
  outputRejection,
  passkeyOnlyGenerationInstructions,
  passkeyOnlyGenerationPromptVersion,
  type InferenceErrorCode,
  type InferenceOutcome,
  type ValidatedGeneratedPage,
} from "@pateat/inference";
import { and, count, eq, gt, gte, inArray, lt, notInArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import type { DeviceScope } from "../auth";
import {
  callClaude,
  keepLogRevision,
  logPageSample,
  logUnsent,
  MAX_OUTPUT_TOKENS,
  ROLE_LIMITS,
  type ClaudeCall,
  type RequestTrace,
  type UnsentOutcome,
  type UnsentRequest,
} from "../claude/calls";
import { generationAttempts, pageJudgements, type PageJudgementVerdict } from "../db/schema";
import {
  hasRecipeByteRoom,
  hasRecipeRoom,
  markLayoutUsed,
  readHead,
  readRevision,
  writeRecipe,
  type UnitSources,
} from "../recipe-store";
import {
  branchUnit,
  ENTRY_UNIT,
  handlerUnit,
  LIST_UNIT,
  markerUnit,
  pageUnit,
  type RecipeUnit,
} from "../recipe-units";
import { recipeBindingSlots } from "../settings-store";

// The recipe generation routes of ADR 0018: one page per call, appended to one recipe
// per origin and start path (ADR 0016), and a page no recipe check explained judged for
// the recipe's completion or a handler (ADR 0027).

/** A page tried is not sent to the model again for this long (owner, 2026-10-12). */
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
/** Room required before paying for a new page's recipe generation. */
export const MIN_GENERATION_RECIPE_ROOM_BYTES = 32 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Judgements per recipe per UTC day, whatever the path (owner, ADR 0027). */
export const JUDGEMENTS_PER_RECIPE_DAY = 20;
const utcDayStart = (now: number) => now - (now % DAY_MS);

type AttemptDb = Parameters<NonNullable<ClaudeCall<unknown>["gate"]>>[0];
type GenerationEnv = { DB: D1Database; OIDC_ISSUER?: string; OIDC_SIGNING_KEYS?: string };
type Failure = Extract<RecipeGenerationResult, { status: "failed" }>["error"];
/** An answer given without a model call: a refusal, a failure, or a stored recipe. */
type UnsentAnswer = Extract<
  RecipeGenerationResult | EntryGenerationResult | RecipeCompletionResult,
  { status: "unavailable" | "failed" | "recipe" }
>;

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
  return `gen-${new Uint8Array(digest).toHex().slice(0, 32)}`;
}

/**
 * Answers without a model call, logging the request under the answer's code (ADR 0012,
 * owner 2026-10-18 08:04 UTC): the reason or failure code, or `recipe` for a recipe
 * another request stored. The row is named on `trace` for its server time.
 */
async function answerUnsent<Answer extends UnsentAnswer>(
  env: GenerationEnv,
  ownerId: string,
  unsent: UnsentRequest,
  answer: Answer,
  trace: RequestTrace,
) {
  const code: UnsentOutcome =
    answer.status === "unavailable"
      ? answer.reason
      : answer.status === "failed"
        ? answer.error
        : answer.status;
  await logUnsent(env.DB, ownerId, unsent, code, trace);
  return answer;
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
/** The route a branch name runs on a stored head: a layout's, or a chooser layout's branch's. */
const routeOf = (recipe: StoredLoginRecipe, branch: string) =>
  storedBranchRoute(recipe, branch)?.route;
/**
 * A route a login ran, changed for a page or a judgement, written back as its layout of the
 * stored head (ADR 0060), under its chooser layout for a chooser branch, at `next`'s
 * revision; the head's other layouts stay as they are. `undefined` when the head has no
 * such layout, or the recipe it makes fails its own schema, so devices never get a recipe
 * they refuse to sync.
 */
function stored(
  head: StoredLoginRecipe,
  branch: string,
  next: LoginRecipe,
): StoredLoginRecipe | undefined {
  const named = parseRecipeBranch(branch);
  if (!named) return undefined;
  const revision = { revision: next.revision };
  let written: StoredLoginRecipe | undefined;
  if ("layouts" in head && !named.branch) {
    const meta = head.layouts.find((layout) => layout.key === named.layout);
    written = meta && { ...withLoginLayout(head, toLoginLayout(next, meta)), ...revision };
  } else if ("chooser" in head && named.branch) {
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
function newLayoutMeta(language: LoginObservation["language"], now: number): LayoutMeta {
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
async function markWritten(env: GenerationEnv, ownerId: string, recipeId: string, branch: string) {
  const layout = parseRecipeBranch(branch)?.layout;
  if (layout === undefined) return;
  try {
    await markLayoutUsed(drizzle(env.DB), ownerId, recipeId, layout, Date.now());
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
    beforeSend: (db: AttemptDb, now: number) => [
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
 * `POST /v1/recipes/generate`. Returns `undefined` when `base` names a recipe ID that is
 * not a generated one (`gen-…`), which the route answers as a bad request; a generated ID
 * of another origin or start path answers `recipe-conflict`.
 *
 * A page that lists accounts (ADR 0028) starts a chooser recipe; a page sent with a
 * `branch` is the next page of that chooser branch: its first, after the click on the
 * list, or a later one after an advance. Either answers with the chooser.
 */
export async function generateRecipe(
  env: GenerationEnv,
  scope: DeviceScope,
  request: RecipeGenerationRequest,
  trace: RequestTrace,
): Promise<RecipeGenerationResult | undefined> {
  const { observation, slots, base, branch, passkeyOnly, signedIn } = request;
  const { origin, path } = observation;
  // A first page starts its own recipe; a later page continues the one in `base`.
  const recipeId = base?.recipeId ?? (await generatedRecipeId(origin, path));
  if (!isGeneratedRecipeId(recipeId)) return undefined;
  const list = observation.accounts !== undefined;
  const headAtStart = await readHead(env.DB, scope.ownerId, recipeId);
  const attemptBranch = branch ?? "";
  // What the request log keeps of the request, sent or not (ADR 0012).
  const logged = {
    role: "generate",
    // Only a list of accounts gets the list line (ADR 0028), and a passkey-only page its
    // own instructions (ADR 0053).
    promptVersion: await (
      passkeyOnly
        ? passkeyOnlyGenerationPromptVersion
        : list
          ? accountListGenerationPromptVersion
          : generationPromptVersion
    )(),
    origin,
    path,
    request: {
      instructions: passkeyOnly
        ? passkeyOnlyGenerationInstructions
        : list
          ? accountListGenerationInstructions
          : generationInstructions,
      slots,
      ...(passkeyOnly ? { passkeyOnly } : {}),
      // The device's hint for the page's kind, sent to the model as well (ADR 0035).
      ...(signedIn === undefined ? {} : { signedIn }),
      observation,
    },
    // A recipe generated again after its revocation has a tombstone but no base: its page
    // starts the recipe, as a new one's does.
    recipe: {
      recipeId,
      branch: attemptBranch,
      baseRevision: headAtStart?.revision ?? 0,
      page: base ? "continuation" : "first",
    },
  } satisfies UnsentRequest;
  const unsent = (answer: Extract<RecipeGenerationResult, UnsentAnswer>) =>
    answerUnsent(env, scope.ownerId, logged, answer, trace);
  if (!observation.complete) return unsent(failed("incomplete-observation"));
  // A list of accounts is only ever a recipe's first page.
  if (list && base) return unsent(failed("invalid-request"));
  /** Whether a stored recipe is the one generated for this origin under this ID. */
  const generatedHere = async (recipe: StoredLoginRecipe) =>
    recipe.origin === origin &&
    recipe.id === recipeId &&
    (await generatedRecipeId(origin, storedRecipeStartPath(recipe))) === recipeId;
  // The layout a continuation names (ADR 0060), and the chooser branch it takes, if any.
  const named = branch === undefined ? undefined : parseRecipeBranch(branch);
  const chooserSide: ChooserBranch | undefined = named?.branch;
  /** Whether a stored recipe is the kind this request writes: a chooser, or layouts. */
  const fits = (recipe: StoredLoginRecipe) =>
    list || chooserSide ? "chooser" in recipe : "layouts" in recipe;

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * route to continue (`undefined` for a first page) with the chooser it belongs to for a
   * branch. Checked again under the lock.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<
    | { answer: Extract<RecipeGenerationResult, { status: "recipe" | "unavailable" }> }
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
      return (await hasRecipeRoom(env.DB, scope.ownerId)) &&
        (await hasRecipeByteRoom(env.DB, scope.ownerId, MIN_GENERATION_RECIPE_ROOM_BYTES))
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
      return (await hasRecipeRoom(env.DB, scope.ownerId)) &&
        (await hasRecipeByteRoom(env.DB, scope.ownerId, MIN_GENERATION_RECIPE_ROOM_BYTES))
        ? { base: undefined }
        : { answer: unavailable("recipe-limit") };
    if (!current) return { answer: unavailable("recipe-conflict") };
    if (!(await hasRecipeByteRoom(env.DB, scope.ownerId, MIN_GENERATION_RECIPE_ROOM_BYTES)))
      return { answer: unavailable("recipe-limit") };
    // The layout the login ran, and its chooser for a branch; one the head no longer has, as
    // after its revocation from the management page, is not continued.
    const resolved = branch === undefined ? undefined : storedBranchRoute(current.recipe, branch);
    if (!resolved) return { answer: unavailable("recipe-conflict") };
    const { route, chooser } = resolved;
    // The other branch starts only with the chooser's button for it.
    if (chooserSide === "other" && !chooser?.chooser.other)
      return { answer: unavailable("recipe-conflict") };
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
  const before = await decide(headAtStart);
  if ("answer" in before) return unsent(before.answer);
  const baseRecipe = before.base;
  const chooser = before.chooser;
  // The attempt key and the write follow the revision the new one replaces.
  const baseRevision = revisionOf(before);
  // Every variant starts on the start page, so plan validation drops a continuation's
  // alternatives rather than failing a call that was already paid for, and names its
  // slots from the kept set alone. It drops the passkey sign-in button too, which becomes
  // the `passkey` route of a recipe's first page only. A chooser branch's pages all follow
  // the click on the list, so none of them is a start page.
  const startPage = baseRecipe === undefined && chooser === undefined;
  // A custom field the owner's saved bindings of this recipe already name keeps that name,
  // on any page (ADR 0027, amended 2026-10-19), so a recipe generated again after its
  // revocation still fits its bindings. Only names and field references are read, and the
  // prompt stays the same.
  const carriedNames =
    !list && slots.some((slot) => slot.fieldName !== undefined)
      ? carriedSlotNames(slots, await recipeBindingSlots(env.DB, scope.ownerId, origin, recipeId))
      : new Map<string, string>();
  let raced: Extract<RecipeGenerationResult, { status: "recipe" | "unavailable" }> | undefined;
  // A first page starts the recipe's first layout (ADR 0060), keyed by when it was made and
  // in the page's language; until repair lands, no request adds another. Its key is chosen
  // before the call, so the request log names the layout the answer creates.
  const meta = newLayoutMeta(observation.language, Date.now());

  const call = await callClaude(env, scope.ownerId, trace, {
    ...logged,
    recipe: { ...logged.recipe, baseRevision, ...(base ? {} : { layout: meta.key }) },
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
    invoke: (model) =>
      createRecipeGenerator({ model, ...roleConfig })({
        observation,
        slots,
        startPage,
        carriedNames,
        ...(passkeyOnly ? { passkeyOnly } : {}),
        ...(signedIn === undefined ? {} : { signedIn }),
      }),
    logValue: (value) => {
      if ("accountList" in value)
        return {
          accountList: true,
          ...(value.other ? { other: value.other.candidate } : {}),
          ...(value.continue ? { continue: value.continue.candidate } : {}),
        };
      const { pageKind, irreversible, fields, action, accountSwitch, alternatives, passkeyButton } =
        value;
      return {
        // The answered kind and the evaluation answer, which no recipe keeps (ADR 0035).
        pageKind,
        irreversible,
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
  if (call.status === "unavailable") return unsent(raced ?? unavailable(call.reason));
  const { logId, served } = call;
  /** The provenance of the units this call's write adds (ADR 0060). */
  const generated = (units: RecipeUnit[]): UnitSources => ({
    origin: "generated",
    units,
    served,
    promptVersion: logged.promptVersion,
    logId,
  });
  const result = unsettled(call.outcome);
  // A request the role refused locally, as one too large, was never sent; the roles refuse
  // locally only with a failure.
  if ("answer" in result)
    return call.outcome.calls === 0 && result.answer.status === "failed"
      ? unsent(result.answer)
      : result.answer;
  /**
   * Writes the recipe after `baseRevision` and answers with it, with `customSlots` when
   * given, or with what won the race: only the recipe this call wrote has a mapping to
   * answer with. A page lost to a write of another layout or of the chooser layout's
   * other branch, such as a judgement or a removal there, is written once more onto that
   * head, so the paid answer is kept. `units` are the units the page adds, recorded with
   * each write, the rebased one too (ADR 0060).
   */
  const save = async (
    recipe: StoredLoginRecipe,
    units: RecipeUnit[],
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
        { sources: generated(units) },
      );
      if (written.ok) {
        // eslint-disable-next-line no-await-in-loop
        await keepLogRevision(env.DB, scope.ownerId, logId, written.change.revision);
        // eslint-disable-next-line no-await-in-loop
        if (branch !== undefined) await markWritten(env, scope.ownerId, recipeId, branch);
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
  // A recipe generated again follows its tombstone's revision.
  const revision = baseRevision + 1;
  /** A new recipe document, checked as devices check what they sync. */
  const document = (recipe: StoredLoginRecipe) =>
    v.is(storedLoginRecipeSchema, recipe) ? recipe : undefined;
  if ("accountList" in value) {
    // The list becomes a chooser recipe with one layout and no branches; each branch is
    // generated once a login takes it (ADR 0028).
    const recipe = document({
      version: 1,
      id: recipeId,
      revision,
      origin,
      chooser: {
        path,
        layouts: [
          {
            ...meta,
            ...(value.other ? { other: value.other.target } : {}),
            ...(value.continue ? { continue: value.continue.target } : {}),
          },
        ],
      },
    });
    return recipe
      ? save(recipe, [{ layout: meta.key, unit: LIST_UNIT }])
      : failed("recipe-invalid");
  }
  const built = buildLoginLayout(
    baseRecipe,
    {
      id: recipeId,
      origin,
      observation,
      slots,
      value,
      startPage,
      carriedNames,
      // The first page's kind (ADR 0035): a continuation keeps the layout's own, and every
      // page of a chooser branch follows a list of accounts, a sign-in page.
      pageKind: chooserSide ? "sign-in" : value.pageKind,
    },
    meta,
  );
  if (!built.ok) return built.answer;
  const { customSlots } = built;
  const next = { ...built.recipe, revision };
  if (!branch) {
    const recipe = document({
      version: 1,
      id: recipeId,
      revision,
      origin,
      layouts: [built.layout],
    });
    return recipe
      ? save(recipe, [{ layout: meta.key, unit: pageUnit(0) }], customSlots)
      : failed("recipe-invalid");
  }
  // A continuation goes back as the layout it continues, beside the head's others: the
  // head the decision read, which the lock found unchanged.
  const head = active(headAtStart);
  const written = head && stored(head.recipe, branch, next);
  if (!written || !named) return failed("recipe-invalid");
  // The page's steps follow the route's: a branch's first page starts at 0 (ADR 0060). A
  // rebased write keeps them, as it takes only a head whose route is still `baseRecipe`.
  const units = [
    {
      layout: named.layout,
      unit: branchUnit(chooserSide, pageUnit(baseRecipe?.steps.length ?? 0)),
    },
  ];
  return save(written, units, customSlots, async (latest) => {
    // A write of another layout, or of the chooser layout's other branch, meanwhile keeps
    // this page: only a head whose own route of the layout, or branch, is still the one
    // this page continues takes it.
    const current = active(latest);
    const resolved = current && storedBranchRoute(current.recipe, branch);
    if (
      !current ||
      !resolved ||
      !(await generatedHere(current.recipe)) ||
      !sameRoute(resolved.route, baseRecipe) ||
      (chooserSide === "other" && !resolved.chooser?.chooser.other)
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
  trace: RequestTrace,
): Promise<EntryGenerationResult> {
  const { observation } = request;
  const { origin, path } = observation;
  const recipeId = await generatedRecipeId(origin, path);
  const headAtStart = await readHead(env.DB, scope.ownerId, recipeId);
  // What the request log keeps of the request, sent or not (ADR 0012).
  const logged = {
    role: "generate",
    promptVersion: await entryGenerationPromptVersion(),
    origin,
    path,
    request: { instructions: entryGenerationInstructions, observation },
    recipe: { recipeId, branch: "", baseRevision: headAtStart?.revision ?? 0, page: "first" },
  } satisfies UnsentRequest;
  const unsent = (answer: Extract<EntryGenerationResult, UnsentAnswer>) =>
    answerUnsent(env, scope.ownerId, logged, answer, trace);
  if (!observation.complete) return unsent(failed("incomplete-observation"));

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * revision the new recipe follows (its tombstone's, or 0). Checked again under the lock.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<
    | { answer: Extract<EntryGenerationResult, { status: "recipe" | "unavailable" }> }
    | { revision: number }
  > => {
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
    if (
      !(await hasRecipeRoom(env.DB, scope.ownerId)) ||
      !(await hasRecipeByteRoom(env.DB, scope.ownerId, MIN_GENERATION_RECIPE_ROOM_BYTES))
    )
      return { answer: unavailable("recipe-limit") };
    return { revision: head?.revision ?? 0 };
  };
  const before = await decide(headAtStart);
  if ("answer" in before) return unsent(before.answer);
  const baseRevision = before.revision;
  let raced: Extract<EntryGenerationResult, { status: "recipe" | "unavailable" }> | undefined;

  const call = await callClaude(env, scope.ownerId, trace, {
    ...logged,
    recipe: { ...logged.recipe, baseRevision },
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
  if (call.status === "unavailable") return unsent(raced ?? unavailable(call.reason));
  const result = unsettled(call.outcome);
  // A request the role refused locally, as one too large, was never sent; the roles refuse
  // locally only with a failure.
  if ("answer" in result)
    return call.outcome.calls === 0 && result.answer.status === "failed"
      ? unsent(result.answer)
      : result.answer;
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
    {
      sources: {
        origin: "generated",
        units: [{ layout: null, unit: ENTRY_UNIT }],
        served: call.served,
        promptVersion: logged.promptVersion,
        logId: call.logId,
      },
    },
  );
  if (!written.ok) {
    if (written.limited) return unavailable("recipe-limit");
    // A write lost to another device answers with that device's recipe, as above.
    const lost = await decide(written.current);
    return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
  }
  await keepLogRevision(env.DB, scope.ownerId, call.logId, written.change.revision);
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
 * The paths the judge is told the login ran on: from the stored recipe, never from the
 * request; a branch's login started on its chooser's list.
 */
function judgedLoginPaths(head: StoredLoginRecipe, recipe: LoginRecipe, route: LoginRoute) {
  return [
    ...new Set([
      ...("chooser" in head ? [head.chooser.path] : []),
      ...routeSignInPaths(recipe, route),
      ...(recipe.handlers ?? []).map((handler) => handler.path),
    ]),
  ];
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
  trace: RequestTrace,
): Promise<RecipeCompletionResult | undefined | null> {
  const head = await readHead(env.DB, scope.ownerId, recipeId);
  if (!head) return undefined;
  const { observation, route, branch, partial, slots } = request;
  // A page at a `password` login's stop before its item's missing password (ADR 0036, owner
  // 2026-10-13 05:39 UTC): judged though it shows the route's password field, for a
  // `passkey` handler only.
  const stop = request.stop === true;
  // A page that still shows the route's sign-in form beside another form (ADR 0061): judged
  // though it shows a route fill field, for a `detail` handler only.
  const beside = request.beside === true;
  // Each layout (ADR 0060), and each branch of a chooser layout, is judged on its own; its
  // limit per day is the recipe's.
  const judgedBranch = branch;
  // A stop's page is judged under its own prompt version, so its row never answers another
  // login's page of the path, nor theirs it (ADR 0036); so is a page beside the sign-in
  // form (ADR 0061). Rows of every current version stay.
  const usualVersion = await completionPromptVersion();
  const stopVersion = await completionStopPromptVersion();
  const besideVersion = await completionBesidePromptVersion();
  const promptVersion = stop ? stopVersion : beside ? besideVersion : usualVersion;
  /**
   * What the request log keeps of the request, sent or not (ADR 0012): without the login
   * paths while the request names no route of the stored revision to take them from.
   */
  const logged = (loginPaths?: string[]) =>
    ({
      role: "judge",
      promptVersion,
      origin: observation.origin,
      path: observation.path,
      request: {
        instructions: stop
          ? completionStopInstructions
          : beside
            ? completionBesideInstructions
            : completionInstructions,
        recipeId,
        route,
        ...(loginPaths ? { loginPaths } : {}),
        // The account's slots, logged as a generation request's are (owner 2026-10-23).
        slots,
        observation,
        ...(stop ? { stop } : {}),
        ...(beside ? { beside } : {}),
      },
      recipe: { recipeId, branch: judgedBranch, baseRevision: head.revision },
    }) satisfies UnsentRequest;
  const unsent = (answer: Extract<RecipeCompletionResult, UnsentAnswer>, loginPaths?: string[]) =>
    answerUnsent(env, scope.ownerId, logged(loginPaths), answer, trace);
  if (head.state === "revoked") return unsent(unavailable("recipe-revoked"));
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
    return unsent(unavailable("recipe-conflict"));
  const loginPaths = judgedLoginPaths(head.recipe, recipe, route);
  if (!observation.complete) return unsent(failed("incomplete-observation"), loginPaths);
  // A list of accounts shown again is the sign-in's start, not its result (ADR 0028). A
  // stop's page is judged only on a recipe without a chooser and on its own origin: the
  // extension never sends a chooser branch's stop (ADR 0036, account lists); nor a page
  // beside the sign-in form (ADR 0061).
  if (observation.accounts || ((stop || beside) && (moved || "chooser" in head.recipe)))
    return unsent(unavailable("not-judgeable"), loginPaths);
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
  // A page beside the sign-in form shows one of the route's fill fields on a route path,
  // and another form with a text-like input and its button (ADR 0061). It is judged only
  // for a `detail` handler, which a path that has one never gets again.
  const besidePage =
    routeSignInPaths(recipe, route).includes(observation.path) &&
    showsBesideForm(observation, routeFillTargets(recipe, "password"));
  const detailHandled = (recipe.handlers ?? []).some(
    (handler) => handler.kind === "detail" && handler.path === observation.path,
  );
  if (
    stop
      ? !stopPage || shown(markers) || passkeyHandled
      : beside
        ? !besidePage || shown(markers) || detailHandled
        : shown([...routeFillTargets(recipe, "password"), ...markers]) ||
          (routeSignInPaths(recipe, route).includes(observation.path) &&
            shown(routeSignInTargets(recipe, route)))
  )
    return unsent(unavailable("not-judgeable"), loginPaths);

  const ofRecipe = and(
    eq(pageJudgements.ownerId, scope.ownerId),
    eq(pageJudgements.recipeId, recipeId),
  );
  const call = await callClaude(env, scope.ownerId, trace, {
    ...logged(loginPaths),
    // Each revision, origin and path is judged once per judge prompt version, and a recipe
    // 20 times a UTC day (ADR 0027), counting a stop's pages and those beside the sign-in
    // form.
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
      // never completes on. A page judged `optional` is judged again each time: another
      // page of the same path, as a single-page sign-in shows, may ask for a step (ADR 0065).
      if (judged && !(judged.verdict === "partial" && !partial) && judged.verdict !== "optional")
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
    // A request the role refuses before sending gives the slot back, as a generation
    // attempt does (ADR 0027); a `partial` or `optional` row judged again takes today's
    // slot and waits for its new verdict. Rows of older revisions or judges go once their
    // day is over.
    beforeSend: (db, now) => [
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
          setWhere: inArray(pageJudgements.verdict, ["partial", "optional"]),
        }),
      db
        .delete(pageJudgements)
        .where(
          and(
            ofRecipe,
            or(
              lt(pageJudgements.revision, head.revision),
              notInArray(pageJudgements.promptVersion, [usualVersion, stopVersion, besideVersion]),
            ),
            lt(pageJudgements.judgedAt, utcDayStart(now)),
          ),
        ),
    ],
    invoke: (model) =>
      createCompletionJudge({ model, ...roleConfig })({
        observation,
        loginPaths,
        slots,
        ...(stop ? { stop } : {}),
        ...(beside ? { beside } : {}),
      }),
    logValue: (judgement) => judgement,
  });
  if (call.status === "unavailable") return unsent(unavailable(call.reason), loginPaths);
  const { outcome } = call;
  /**
   * The provenance of the handlers or marker this judgement adds to the judged layout and
   * branch (ADR 0060), several under the same request log row.
   */
  const named = parseRecipeBranch(branch);
  const judged = (units: string[]): UnitSources => ({
    origin: "judged",
    units: named
      ? units.map((unit) => ({ layout: named.layout, unit: branchUnit(named.branch, unit) }))
      : [],
    served: call.served,
    promptVersion,
    logId: call.logId,
  });
  if (outcome.status === "failed") {
    const answer = failed(failureOf(outcome.error));
    // A request the role refused locally, as one too large, was never sent.
    return outcome.calls === 0 ? unsent(answer, loginPaths) : answer;
  }
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
  // no `totp` or `password` handler. Its other answers are kept as undecided, under the
  // stop's version. So does a page beside the sign-in form, with a `detail` handler (ADR
  // 0061), and its challenge that keeps none.
  if ((stop || beside) && judgement.decision !== "challenge") {
    await keepVerdict("unclear");
    return { version: 1, status: "unclear" };
  }
  // A page beside the sign-in form keeps its verdict once its handlers are known. An
  // optional answer on a description that left out a disabled field is kept as
  // `partial`, as an abstention there is (ADR 0029, ADR 0065).
  if (!beside)
    await keepVerdict(
      partial && judgement.decision === "optional" ? "partial" : judgement.decision,
    );
  if (judgement.decision === "rejected") return { version: 1, status: "rejected" };
  // A page the person may put off is signed in, but nothing is learned there (ADR 0065):
  // its elements may never show on the usual signed-in page, so a marker comes only from a
  // page judged `signed-in`, and the path is judged again on the next login.
  if (judgement.decision === "optional") return { version: 1, status: "optional" };
  if (judgement.decision === "challenge") {
    // A page may offer both a security key and a TOTP code, or a button that goes on to
    // the password (ADR 0048); each handler that passes its checks is kept, in one revision
    // (ADR 0027).
    let changed: LoginRecipe | undefined;
    // Kinds and refusal reasons only: never an element, label or value.
    const handlers: {
      kind: "passkey" | "password" | "totp" | "detail";
      kept: boolean;
      reason?: string;
    }[] = [];
    /** The handler added to the revision after the judged one, with what came before. */
    const keep = (handler: Parameters<typeof addHandler>[2]) => {
      const base = changed ?? recipe;
      const added = addHandler(base, observation, handler);
      if (added.ok) changed = changed ? { ...added.recipe, revision: base.revision } : added.recipe;
      handlers.push({
        kind: handler.kind,
        kept: added.ok,
        ...(added.ok ? {} : { reason: added.reason }),
      });
    };
    // A page beside the sign-in form keeps only a `detail` handler (ADR 0061).
    if (judgement.passkey && beside)
      handlers.push({ kind: "passkey", kept: false, reason: "beside" });
    else if (judgement.passkey) keep({ kind: "passkey", target: judgement.passkey });
    // A stop's page keeps only a `passkey` handler (ADR 0036).
    if (judgement.password && (stop || beside))
      handlers.push({ kind: "password", kept: false, reason: stop ? "stop" : "beside" });
    else if (judgement.password) keep({ kind: "password", target: judgement.password });
    // A code on a stop's page is never learned (ADR 0036), nor beside the sign-in form.
    if (judgement.totp && (stop || beside))
      handlers.push({ kind: "totp", kept: false, reason: stop ? "stop" : "beside" });
    else if (judgement.totp) keep({ kind: "totp", ...judgement.totp });
    // A code the judge named but its local checks refused is logged with why (ADR 0027).
    if (judgement.totpDropped && !stop && !beside)
      handlers.push({ kind: "totp", kept: false, reason: judgement.totpDropped });
    // Nor are a stop's details (ADR 0036, ADR 0061); each dropped input is logged by why.
    if (judgement.detail && stop) handlers.push({ kind: "detail", kept: false, reason: "stop" });
    else if (judgement.detail) keep({ kind: "detail", ...judgement.detail });
    if (!stop)
      for (const reason of judgement.detailsDropped ?? [])
        handlers.push({ kind: "detail", kept: false, reason });
    if (handlers.length) console.info("Judged page handlers", { recipeId, handlers });
    // The secret questions the judge paired with this account's slots (ADR 0061) answer
    // this request only: the recipe, shared by every account, never holds a field's name.
    // Only a `detail` handler kept for the page pairs anything; a stop keeps none.
    const questions =
      judgement.questions?.length &&
      handlers.some((handler) => handler.kind === "detail" && handler.kept)
        ? { questions: judgement.questions }
        : {};
    const withHandlers = changed && stored(head.recipe, branch, changed);
    // A page beside the sign-in form is a challenge only with the `detail` handler it adds,
    // its only handler there; without one it is still the sign-in page, kept as undecided
    // (ADR 0061).
    if (beside) {
      await keepVerdict(withHandlers ? "challenge" : "unclear");
      if (!withHandlers) return { version: 1, status: "unclear" };
    }
    if (!withHandlers) return { version: 1, status: "challenge", ...questions };
    // Handlers are only appended, so the ones after the judged route's are this call's.
    const before = recipe.handlers?.length ?? 0;
    const added = (changed?.handlers ?? []).slice(before).map((_, index) => before + index);
    const written = await writeRecipe(
      env.DB,
      scope.ownerId,
      recipeId,
      { version: 1, state: "active", expectedRevision: head.revision, recipe: withHandlers },
      scope.deviceId,
      { sources: judged(added.map(handlerUnit)) },
    );
    if (written.ok) {
      await keepLogRevision(env.DB, scope.ownerId, call.logId, written.change.revision);
      await markWritten(env, scope.ownerId, recipeId, branch);
    }
    // The page is a challenge whether or not its handlers fit the owner's recipe bytes.
    if (!written.ok && written.limited)
      console.warn("Judged page handlers refused by the recipe limit", { recipeId });
    const change = written.ok ? answerable(written.change) : undefined;
    return { version: 1, status: "challenge", ...(change ? { change } : {}), ...questions };
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
  // The marker learned is the route's last one.
  const learnedMarkers = learned.recipe.completion?.length ?? 0;
  const written = await writeRecipe(
    env.DB,
    scope.ownerId,
    recipeId,
    { version: 1, state: "active", expectedRevision: head.revision, recipe: learnedRecipe },
    scope.deviceId,
    { sources: judged(learnedMarkers ? [markerUnit(learnedMarkers - 1)] : []) },
  );
  if (written.ok) {
    await keepLogRevision(env.DB, scope.ownerId, call.logId, written.change.revision);
    await markWritten(env, scope.ownerId, recipeId, branch);
  }
  const limited = !written.ok && written.limited;
  if (limited) console.warn("Signed-in marker refused by the recipe limit", { recipeId });
  const change = written.ok ? answerable(written.change) : undefined;
  if (change) return { ...signedIn, change };
  if (signedInAnyway) return signedIn;
  return unavailable(limited ? "recipe-limit" : "recipe-conflict");
}

/**
 * Keeps a repeat login's signed-in page in the request log, with the request built as the
 * judge's would be, without a model call (ADR 0029, owner 2026-10-18 08:05 UTC): `sampled`
 * when it wrote the row, `recent` when the owner already has a sample of the recipe and
 * branch from the last 30 days. `undefined` when the recipe or its revision is not the
 * owner's or not kept, or the revision is a tombstone; `null` for a page the revision
 * cannot have ended on: another origin, an incomplete description, a list of accounts, one
 * of the route's fill fields still shown, or a route or branch the revision does not have.
 * Nothing is logged for either.
 */
export async function samplePage(
  env: GenerationEnv,
  scope: DeviceScope,
  recipeId: string,
  request: RecipePageSampleRequest,
  trace: RequestTrace,
): Promise<"sampled" | "recent" | undefined | null> {
  const change = await readRevision(env.DB, scope.ownerId, recipeId, request.revision);
  if (!change || change.state !== "active") return undefined;
  const { observation, route, branch, slots } = request;
  const recipe = routeOf(change.recipe, branch);
  if (
    !recipe ||
    !recipeHasRoute(recipe, route) ||
    observation.origin !== change.recipe.origin ||
    !observation.complete ||
    observation.accounts !== undefined ||
    // As for the judge, a page that still shows one of the password route's fill fields,
    // of any variant and on any path, is not a signed-in page; kept, it would hold off the
    // recipe's next sample for 30 days.
    observation.candidates.some((candidate) =>
      routeFillTargets(recipe, "password").some((target) =>
        sameLoginTarget(target, candidate.target),
      ),
    )
  )
    return null;
  const sampled = await logPageSample(
    env.DB,
    scope.ownerId,
    {
      role: "judge",
      promptVersion: await completionPromptVersion(),
      origin: observation.origin,
      path: observation.path,
      request: {
        instructions: completionInstructions,
        recipeId,
        route,
        loginPaths: judgedLoginPaths(change.recipe, recipe, route),
        // The account's slots, as the judge request carries them (owner 2026-10-23).
        slots,
        observation,
      },
      recipe: { recipeId, branch, baseRevision: change.revision },
    },
    trace,
  );
  return sampled ? "sampled" : "recent";
}
