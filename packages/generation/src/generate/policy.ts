import {
  type GenerationUnavailableReason,
  type LoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import { utcDayStart, type AttemptKey, type GenerationBackend } from "../backend";

/** A page tried is not sent to the model again for this long (owner, 2026-10-12). */
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
/** Room required before paying for a new page's recipe generation. */
export const MIN_GENERATION_RECIPE_ROOM_BYTES = 32 * 1024;
export { JUDGEMENTS_PER_RECIPE_DAY, utcDayStart } from "../backend";

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
 * The repair limit of ADR 0041: a device asks to repair a recipe at most once a
 * UTC day, whatever came of the call. `recheck` reads the stored head again once the
 * request holds a call slot. Two repairs at once both pass and are both charged; the
 * recipe's revision claim keeps one write (ADR 0018).
 */
export function repairWindow(
  backend: GenerationBackend,
  key: { recipeId: string; baseRevision: number },
  recheck: () => Promise<GenerationUnavailableReason | undefined>,
) {
  const { recipeId, baseRevision } = key;
  return {
    gate: async (now: number) => {
      const stale = await recheck();
      if (stale) return stale;
      return (await backend.repairedSince(recipeId, utcDayStart(now))) ? "repair-limit" : undefined;
    },
    // Earlier days' rows decide nothing any more.
    beforeSend: (now: number) =>
      backend.recordRepair(recipeId, baseRevision, now, utcDayStart(now)),
  };
}

/**
 * The 10-minute retry window of one generation call and its attempt row (ADR 0016), keyed
 * by the recipe, the chooser branch (empty without one), the path and the revision the
 * call's write replaces. `recheck` reads the stored head again once the request holds a
 * call slot. The same page asked twice at once passes twice and is charged twice; the
 * recipe's revision claim keeps one write (ADR 0018).
 */
export function attemptWindow(
  backend: GenerationBackend,
  key: AttemptKey,
  recheck: () => Promise<GenerationUnavailableReason | undefined>,
) {
  return {
    gate: async (now: number) => {
      const stale = await recheck();
      if (stale) return stale;
      return (await backend.attemptedSince(key, now - ATTEMPT_WINDOW_MS))
        ? "recently-tried"
        : undefined;
    },
    beforeSend: (now: number) => backend.recordAttempt(key, now, now - ATTEMPT_WINDOW_MS),
  };
}

/** Whether two route recipes are the same apart from their revision, absent ones included. */
export const sameRoute = (left: LoginRecipe | undefined, right: LoginRecipe | undefined) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    JSON.stringify({ ...left, revision: 0 }) === JSON.stringify({ ...right, revision: 0 }));

/**
 * Why a recipe head read again once the request holds a call slot can no longer be judged
 * at the revision that ran: revoked, gone or replaced meanwhile.
 */
export function staleHead(
  latest: SyncRecipeChange | null,
  revision: number,
): "recipe-revoked" | "recipe-conflict" | undefined {
  if (latest?.state === "revoked") return "recipe-revoked";
  return latest?.state === "active" && latest.revision === revision ? undefined : "recipe-conflict";
}
