import {
  loginStepEffect,
  recipeHasRoute,
  routeSteps,
  type GenerationUnavailableReason,
  type LoginRecipe,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  addCompletion,
  addHandler,
  appendPageSteps,
  claudeRefusalCategory,
  completionInstructions,
  createCompletionJudge,
  createRecipeGenerator,
  generationInstructions,
  type InferenceErrorCode,
} from "@pateat/inference";
import { and, count, eq, gt, gte, lt } from "drizzle-orm";
import type { DeviceScope } from "../auth";
import { callClaude, MAX_OUTPUT_TOKENS, ROLE_LIMITS } from "../claude/calls";
import { generationAttempts, pageJudgements } from "../db/schema";
import { hasRecipeRoom, readHead, writeRecipe } from "../recipe-store";

// The recipe generation routes of ADR 0018: one page per call, appended to one recipe
// per origin and start path (ADR 0016), and a page no recipe check explained judged for
// the recipe's completion or a handler (ADR 0027).

const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Judgements per recipe per UTC day, whatever the path (owner, ADR 0027). */
export const JUDGEMENTS_PER_RECIPE_DAY = 20;
const utcDayStart = (now: number) => now - (now % ATTEMPT_WINDOW_MS);

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
 * `POST /v1/recipes/generate`. Returns `undefined` when `base` names a recipe other
 * than one generated for this origin, which the route answers as a bad request.
 */
export async function generateRecipe(
  env: GenerationEnv,
  scope: DeviceScope,
  request: RecipeGenerationRequest,
): Promise<RecipeGenerationResult | undefined> {
  const { observation, slots, base } = request;
  const { origin, path } = observation;
  // A first page starts its own recipe; a later page continues the one in `base`.
  const recipeId = base?.recipeId ?? (await generatedRecipeId(origin, path));
  if (!/^gen-[0-9a-f]{32}$/u.test(recipeId)) return undefined;
  if (!observation.complete) return failed("incomplete-observation");
  /** Whether a stored recipe is the one generated for this origin under this ID. */
  const generatedHere = async (recipe: LoginRecipe) =>
    recipe.origin === origin &&
    recipe.id === recipeId &&
    (await generatedRecipeId(origin, recipe.steps[0]!.path)) === recipeId;

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * recipe to continue (`undefined` for a first page). Checked again under the lock.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<{ answer: RecipeGenerationResult } | { base: LoginRecipe | undefined }> => {
    if (head?.state === "revoked") return { answer: unavailable("recipe-revoked") };
    const current = active(head);
    // Only the recipe generated here answers; a device write under the ID cannot redirect it.
    if (current && !(await generatedHere(current.recipe)))
      return { answer: unavailable("recipe-conflict") };
    if (current && (!base || current.revision !== base.revision))
      // Another device already generated it, or appended this page first: use that.
      return { answer: { version: 1, status: "recipe", change: current } };
    // A first page adds a recipe, so the owner needs room for one before any model call.
    if (!base)
      return (await hasRecipeRoom(env.DB, scope.ownerId))
        ? { base: undefined }
        : { answer: unavailable("recipe-limit") };
    const last = current?.recipe.steps.at(-1);
    if (!current || current.recipe.completion || !last || loginStepEffect(last) !== "advance")
      return { answer: unavailable("recipe-conflict") };
    return { base: current.recipe };
  };
  const before = await decide(await readHead(env.DB, scope.ownerId, recipeId));
  if ("answer" in before) return before.answer;
  const baseRecipe = before.base;
  const baseRevision = baseRecipe?.revision ?? 0;
  let raced: RecipeGenerationResult | undefined;

  const call = await callClaude(env, scope.ownerId, {
    role: "generate",
    origin,
    path,
    request: { instructions: generationInstructions, slots, observation },
    gate: async (db, now) => {
      // Another device may have stored this recipe while this request waited for the lock.
      const latest = await decide(await readHead(env.DB, scope.ownerId, recipeId));
      if ("answer" in latest) {
        raced = latest.answer;
        return "recipe-conflict";
      }
      const [recent] = await db
        .select()
        .from(generationAttempts)
        .where(
          and(
            eq(generationAttempts.ownerId, scope.ownerId),
            eq(generationAttempts.recipeId, recipeId),
            eq(generationAttempts.path, path),
            eq(generationAttempts.baseRevision, baseRevision),
            gt(generationAttempts.attemptedAt, now - ATTEMPT_WINDOW_MS),
          ),
        )
        .limit(1);
      return recent ? "recently-tried" : undefined;
    },
    reserved: (db, now) => [
      db
        .insert(generationAttempts)
        .values({
          ownerId: scope.ownerId,
          recipeId,
          origin,
          path,
          baseRevision,
          attemptedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            generationAttempts.ownerId,
            generationAttempts.recipeId,
            generationAttempts.path,
            generationAttempts.baseRevision,
          ],
          set: { attemptedAt: now },
        }),
      db
        .delete(generationAttempts)
        .where(
          and(
            eq(generationAttempts.ownerId, scope.ownerId),
            lt(generationAttempts.attemptedAt, now - ATTEMPT_WINDOW_MS),
          ),
        ),
    ],
    invoke: (model) => createRecipeGenerator({ model, ...roleConfig })({ observation, slots }),
    logValue: ({ fields, action, accountSwitch }) => ({
      fields,
      action,
      ...(accountSwitch ? { accountSwitch } : {}),
    }),
  });
  if (call.status === "unavailable") return raced ?? unavailable(call.reason);
  const { outcome } = call;
  if (outcome.status === "failed") return failed(failureOf(outcome.error));
  if (outcome.status === "abstained")
    return {
      version: 1,
      status: "abstained",
      // The generation role abstains only with these; anything else is not evidence.
      reason:
        outcome.reason === "no-login-form" ||
        outcome.reason === "ambiguous" ||
        outcome.reason === "unsafe-instructions"
          ? outcome.reason
          : "insufficient-evidence",
    };

  const assembled = appendPageSteps(baseRecipe, {
    id: recipeId,
    origin,
    steps: outcome.value.steps,
    ...(outcome.value.switchTarget ? { accountSwitch: outcome.value.switchTarget } : {}),
  });
  if (!assembled.ok)
    return assembled.reason === "invalid-recipe"
      ? failed("recipe-invalid")
      : unavailable("recipe-conflict");
  const written = await writeRecipe(
    env.DB,
    scope.ownerId,
    recipeId,
    {
      version: 1,
      state: "active",
      expectedRevision: baseRevision,
      recipe: assembled.recipe,
    },
    scope.deviceId,
  );
  // A write lost to another device answers with that device's recipe, as above.
  if (!written.ok) {
    if (written.limited) return unavailable("recipe-limit");
    const lost = await decide(written.current);
    return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
  }
  const change = active(written.change);
  return change ? { version: 1, status: "recipe", change } : unavailable("recipe-conflict");
}

/**
 * `POST /v1/recipes/:recipeId/completion`: judges a page after an effect step of the
 * login's route (ADR 0027). Returns `undefined` for a missing recipe and `null` for a page
 * on another origin, which the route answers as 404 and 400.
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
  const { recipe } = head;
  const { observation, route } = request;
  if (observation.origin !== recipe.origin) return null;
  // Only a page of the revision that ran, on a route the stored recipe has, is judged.
  if (head.revision !== request.revision || !recipeHasRoute(recipe, route))
    return unavailable("recipe-conflict");
  if (!observation.complete) return failed("incomplete-observation");
  // The checks use the stored recipe, never the request: a page that still shows one of
  // the route's fill fields, on any path, or the completion marker is not judged.
  const steps = routeSteps(recipe, route);
  const unexplained = [
    ...steps.flatMap((step) =>
      step.kind === "fill" ? step.fields.map(({ target }) => target) : [],
    ),
    ...(recipe.completion ? [recipe.completion.target] : []),
  ].map((target) => JSON.stringify(target));
  if (
    observation.candidates.some((candidate) =>
      unexplained.includes(JSON.stringify(candidate.target)),
    )
  )
    return unavailable("not-judgeable");

  // The login paths come from the stored recipe, never from the request.
  const loginPaths = [
    ...new Set([
      ...steps.map((step) => step.path),
      ...(recipe.handlers ?? []).map((handler) => handler.path),
    ]),
  ];
  const ofRecipe = and(
    eq(pageJudgements.ownerId, scope.ownerId),
    eq(pageJudgements.recipeId, recipeId),
  );
  const call = await callClaude(env, scope.ownerId, {
    role: "judge",
    origin: observation.origin,
    path: observation.path,
    request: { instructions: completionInstructions, recipeId, route, loginPaths, observation },
    // Each revision and path is judged once, and a recipe 20 times a UTC day (ADR 0027).
    gate: async (db, now) => {
      const latest = await readHead(env.DB, scope.ownerId, recipeId);
      if (latest?.state !== "active" || latest.revision !== head.revision) return "recipe-conflict";
      const [judged] = await db
        .select()
        .from(pageJudgements)
        .where(
          and(
            ofRecipe,
            eq(pageJudgements.revision, head.revision),
            eq(pageJudgements.path, observation.path),
          ),
        )
        .limit(1);
      if (judged) return "already-judged";
      const [today] = await db
        .select({ value: count() })
        .from(pageJudgements)
        .where(and(ofRecipe, gte(pageJudgements.judgedAt, utcDayStart(now))));
      return (today?.value ?? 0) >= JUDGEMENTS_PER_RECIPE_DAY ? "judgement-limit" : undefined;
    },
    // A request the role refuses before sending still uses its slot, as a generation
    // attempt does. Rows of older revisions go once their day is over.
    reserved: (db, now) => [
      db
        .insert(pageJudgements)
        .values({
          ownerId: scope.ownerId,
          recipeId,
          revision: head.revision,
          path: observation.path,
          judgedAt: now,
        })
        .onConflictDoNothing(),
      db
        .delete(pageJudgements)
        .where(
          and(
            ofRecipe,
            lt(pageJudgements.revision, head.revision),
            lt(pageJudgements.judgedAt, utcDayStart(now)),
          ),
        ),
    ],
    invoke: (model) => createCompletionJudge({ model, ...roleConfig })({ observation, loginPaths }),
    logValue: (judgement) => judgement,
  });
  if (call.status === "unavailable") return unavailable(call.reason);
  const { outcome } = call;
  if (outcome.status === "failed") return failed(failureOf(outcome.error));
  if (outcome.status === "abstained") return { version: 1, status: "unclear" };
  const judgement = outcome.value;
  if (judgement.decision === "rejected") return { version: 1, status: "rejected" };
  if (judgement.decision === "challenge") {
    const added = judgement.next
      ? addHandler(recipe, observation, { kind: "passkey", target: judgement.next })
      : undefined;
    if (!added?.ok) return { version: 1, status: "challenge" };
    const written = await writeRecipe(
      env.DB,
      scope.ownerId,
      recipeId,
      { version: 1, state: "active", expectedRevision: head.revision, recipe: added.recipe },
      scope.deviceId,
    );
    const change = written.ok ? active(written.change) : undefined;
    return { version: 1, status: "challenge", ...(change ? { change } : {}) };
  }
  // A completion is learned once; a later signed-in page needs no change.
  if (recipe.completion) return { version: 1, status: "signed-in" };

  const learned = addCompletion(recipe, observation, judgement.target);
  if (!learned.ok)
    return learned.reason === "already-complete"
      ? unavailable("recipe-conflict")
      : failed("invalid-output");
  const written = await writeRecipe(
    env.DB,
    scope.ownerId,
    recipeId,
    {
      version: 1,
      state: "active",
      expectedRevision: head.revision,
      recipe: learned.recipe,
    },
    scope.deviceId,
  );
  const change = written.ok ? active(written.change) : undefined;
  return change ? { version: 1, status: "signed-in", change } : unavailable("recipe-conflict");
}
