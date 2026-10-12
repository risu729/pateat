import {
  isLoginRouteRecipe,
  loginStepEffect,
  recipeHasRoute,
  recipeSlots,
  routeFillTargets,
  routeSignInPaths,
  routeSignInTargets,
  sameLoginTarget,
  storedRecipeStartPath,
  type GenerationUnavailableReason,
  type LoginRecipe,
  type LoginTarget,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  addCompletion,
  addHandler,
  appendPageSteps,
  claudeRefusalCategory,
  completionInstructions,
  completionPromptVersion,
  createCompletionJudge,
  createRecipeGenerator,
  generationInstructions,
  generationPromptVersion,
  outputRejection,
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

/** A page tried is not sent to the model again for this long (owner, 2026-10-12). */
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Judgements per recipe per UTC day, whatever the path (owner, ADR 0027). */
export const JUDGEMENTS_PER_RECIPE_DAY = 20;
const utcDayStart = (now: number) => now - (now % DAY_MS);

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
 * An active head with a login route, the only kind a generation or judgement answers
 * with; an entry recipe (ADR 0031) or a chooser recipe (ADR 0028) is never one.
 */
const activeRoute = (change: SyncRecipeChange | null) => {
  const head = active(change);
  return head && isLoginRouteRecipe(head.recipe) ? { ...head, recipe: head.recipe } : undefined;
};

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
  // The model cannot answer that a page lists accounts yet (ADR 0028), so such a page
  // costs no call.
  if (observation.accounts) return failed("invalid-request");
  /** Whether a stored recipe is the one generated for this origin under this ID. */
  const generatedHere = async (recipe: StoredLoginRecipe) =>
    recipe.origin === origin &&
    recipe.id === recipeId &&
    (await generatedRecipeId(origin, storedRecipeStartPath(recipe))) === recipeId;

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * recipe to continue (`undefined` for a first page). Checked again under the lock.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<
    { answer: RecipeGenerationResult } | { base: LoginRecipe | undefined; revoked?: number }
  > => {
    // A revoked recipe is generated again from its first page, as the revision after its
    // tombstone (owner, 2026-10-12); a later page never continues it.
    if (head?.state === "revoked") {
      if (base) return { answer: unavailable("recipe-revoked") };
      return (await hasRecipeRoom(env.DB, scope.ownerId))
        ? { base: undefined, revoked: head.revision }
        : { answer: unavailable("recipe-limit") };
    }
    const stored = active(head);
    // Only the recipe generated here answers; a device write under the ID cannot redirect it.
    if (stored && !(await generatedHere(stored.recipe)))
      return { answer: unavailable("recipe-conflict") };
    // An entry recipe (ADR 0031) or a chooser recipe (ADR 0028) of this origin and path is
    // no login recipe to answer with; generating either is not implemented yet.
    const current = activeRoute(head);
    if (stored && !current) return { answer: unavailable("recipe-conflict") };
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
  // The attempt key and the write follow the revision the new one replaces.
  const baseRevision = baseRecipe?.revision ?? before.revoked ?? 0;
  let raced: RecipeGenerationResult | undefined;

  const call = await callClaude(env, scope.ownerId, {
    role: "generate",
    promptVersion: await generationPromptVersion(),
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
      // A recipe generated and revoked meanwhile would make this call's write fail.
      if ((latest.base?.revision ?? latest.revoked ?? 0) !== baseRevision) return "recipe-conflict";
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
    logValue: ({ fields, action, accountSwitch, alternatives, passkeyButton }) => ({
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
    }),
  });
  if (call.status === "unavailable") return raced ?? unavailable(call.reason);
  const { outcome } = call;
  if (outcome.status === "failed") {
    // Which check refused the model's output, so the device can log it (codes only).
    const rejection = outputRejection(outcome);
    return { ...failed(failureOf(outcome.error)), ...(rejection ? { rejection } : {}) };
  }
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

  // Each custom-field slot the model named, in any identifier set: the recipe stores only
  // the generic name, and the extension maps it back to the offered field (ADR 0027). A
  // requested slot has one name in every set, so each name appears once. Every variant
  // starts on the start page, so a continuation's alternatives are dropped rather than
  // failing a call that was already paid for. So is the passkey sign-in button, which
  // becomes the `passkey` route of a recipe's first page only.
  const alternatives = baseRecipe ? [] : (outcome.value.alternatives ?? []);
  const passkey = baseRecipe ? undefined : outcome.value.passkeyTarget;
  const customSlots = [
    ...new Map(
      [outcome.value, ...alternatives]
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
    steps: outcome.value.steps,
    ...(alternatives.length ? { alternatives: alternatives.map((entry) => entry.steps) } : {}),
    ...(outcome.value.switchTarget ? { accountSwitch: outcome.value.switchTarget } : {}),
    ...(passkey ? { passkey } : {}),
  });
  // A page that fills one of the recipe's slots again, as its identifier form shown again
  // where it posted, is refused before anything is stored (ADR 0018).
  if (!assembled.ok)
    return assembled.reason === "invalid-recipe" || assembled.reason === "slot-refilled"
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
      // A recipe generated again follows its tombstone's revision.
      recipe: { ...assembled.recipe, revision: baseRevision + 1 },
    },
    scope.deviceId,
  );
  // A write lost to another device answers with that device's recipe, as above.
  if (!written.ok) {
    if (written.limited) return unavailable("recipe-limit");
    const lost = await decide(written.current);
    return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
  }
  const change = activeRoute(written.change);
  if (!change) return unavailable("recipe-conflict");
  // Only the recipe this call wrote has a mapping to answer with.
  return { version: 1, status: "recipe", change, ...(customSlots.length ? { customSlots } : {}) };
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
  // Only a page of the revision that ran, on a route the stored recipe has, is judged; an
  // entry or chooser recipe (ADR 0031, ADR 0028) has no route of its own.
  if (
    !isLoginRouteRecipe(recipe) ||
    head.revision !== request.revision ||
    !recipeHasRoute(recipe, route)
  )
    return unavailable("recipe-conflict");
  if (!observation.complete) return failed("incomplete-observation");
  // The checks use the stored recipe, never the request: a page that still shows one of
  // the password route's fill fields, of any variant and on any path, or the completion
  // marker is not judged. The request never names the variant the login ran. The passkey
  // route starts beside that form, so the form counts for it too; and a page on its
  // sign-in paths that still shows its button is not judged either: its passkey exchange
  // may still be running, as the extension holds it.
  const unexplained = [
    ...routeFillTargets(recipe, "password"),
    ...(recipe.completion ? [recipe.completion.target] : []),
  ];
  const shown = (targets: readonly LoginTarget[]) =>
    observation.candidates.some((candidate) =>
      targets.some((target) => sameLoginTarget(target, candidate.target)),
    );
  if (
    shown(unexplained) ||
    (routeSignInPaths(recipe, route).includes(observation.path) &&
      shown(routeSignInTargets(recipe, route)))
  )
    return unavailable("not-judgeable");

  // The login paths come from the stored recipe, never from the request.
  const loginPaths = [
    ...new Set([
      ...routeSignInPaths(recipe, route),
      ...(recipe.handlers ?? []).map((handler) => handler.path),
    ]),
  ];
  const ofRecipe = and(
    eq(pageJudgements.ownerId, scope.ownerId),
    eq(pageJudgements.recipeId, recipeId),
  );
  const call = await callClaude(env, scope.ownerId, {
    role: "judge",
    promptVersion: await completionPromptVersion(),
    origin: observation.origin,
    path: observation.path,
    request: { instructions: completionInstructions, recipeId, route, loginPaths, observation },
    // Each revision and path is judged once, and a recipe 20 times a UTC day (ADR 0027).
    gate: async (db, now) => {
      const stale = staleHead(await readHead(env.DB, scope.ownerId, recipeId), head.revision);
      if (stale) return stale;
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
    // A page may offer both a security key and an authenticator app code; each handler
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
    if (judgement.totp) {
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
    if (handlers.length) console.info("Judged page handlers", { recipeId, handlers });
    if (!changed) return { version: 1, status: "challenge" };
    const written = await writeRecipe(
      env.DB,
      scope.ownerId,
      recipeId,
      { version: 1, state: "active", expectedRevision: head.revision, recipe: changed },
      scope.deviceId,
    );
    const change = written.ok ? activeRoute(written.change) : undefined;
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
  const change = written.ok ? activeRoute(written.change) : undefined;
  return change ? { version: 1, status: "signed-in", change } : unavailable("recipe-conflict");
}
