import {
  loginStepEffect,
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
  appendPageSteps,
  claudeRefusalCategory,
  completionInstructions,
  createCompletionJudge,
  createRecipeGenerator,
  generationInstructions,
  type InferenceErrorCode,
} from "@pateat/inference";
import { and, eq, gt, lt } from "drizzle-orm";
import type { DeviceScope } from "../auth";
import { callClaude, MAX_OUTPUT_TOKENS, ROLE_LIMITS } from "../claude/calls";
import { generationAttempts } from "../db/schema";
import { readHead, writeRecipe } from "../recipe-store";

// The recipe generation routes of ADR 0018: one page per call, appended to one recipe
// per origin and start path (ADR 0016), and the page after the first sign-in judged for
// the recipe's completion.

const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    if (!base) return { base: undefined };
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
            eq(generationAttempts.origin, origin),
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
        .values({ ownerId: scope.ownerId, origin, path, baseRevision, attemptedAt: now })
        .onConflictDoUpdate({
          target: [
            generationAttempts.ownerId,
            generationAttempts.origin,
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
    logValue: ({ fields, action }) => ({ fields, action }),
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
    const lost = await decide(written.current);
    return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
  }
  const change = active(written.change);
  return change ? { version: 1, status: "recipe", change } : unavailable("recipe-conflict");
}

/**
 * `POST /v1/recipes/:recipeId/completion`. Returns `undefined` for a missing recipe and
 * `null` for a page on another origin, which the route answers as 404 and 400.
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
  const { observation } = request;
  if (observation.origin !== recipe.origin) return null;
  const last = recipe.steps.at(-1);
  // Only the page after a recipe's final submission, at the revision that ran, is judged.
  if (
    head.revision !== request.revision ||
    recipe.completion ||
    !last ||
    loginStepEffect(last) !== "submit"
  )
    return unavailable("recipe-conflict");
  if (!observation.complete) return failed("incomplete-observation");

  // The login paths come from the stored recipe, never from the request.
  const loginPaths = [...new Set(recipe.steps.map((step) => step.path))];
  const call = await callClaude(env, scope.ownerId, {
    role: "judge",
    origin: observation.origin,
    path: observation.path,
    request: { instructions: completionInstructions, recipeId, loginPaths, observation },
    invoke: (model) => createCompletionJudge({ model, ...roleConfig })({ observation, loginPaths }),
    logValue: (judgement) => judgement,
  });
  if (call.status === "unavailable") return unavailable(call.reason);
  const { outcome } = call;
  if (outcome.status === "failed") return failed(failureOf(outcome.error));
  if (outcome.status === "abstained") return { version: 1, status: "unclear" };
  const judgement = outcome.value;
  if (judgement.decision !== "signed-in") return { version: 1, status: judgement.decision };

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
