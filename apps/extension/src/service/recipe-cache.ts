import { deviceIdSchema, serviceOriginSchema, storedLoginRecipeSchema } from "@pateat/contracts";
import * as v from "valibot";
import { syncedEntryBlockSchema } from "./entry-blocks";

// The last-known-good copy of the owner's active recipes (ADR 0013). The cursor and
// recipes are written together, so a failed write leaves the previous consistent copy.
// An overflow walk writes removals and non-growing newer heads with the old cursor;
// skipped active changes remain pending until their entire page fits.
// Entry and chooser recipes (ADR 0031, ADR 0028) are cached with the rest; only a
// chooser is looked up and starts a login, on its list's path, and `entries` lists an
// origin's entry recipes. Version 2 holds recipes with layouts (ADR 0060): a version 1
// cache is ignored, so the device pulls every recipe again from the start.
// A change this build cannot read, as a recipe a newer service stored with a locator this
// build does not know, is left out and the cursor moves past it (#959); `unreadableBy` names
// the build that left one out, and any other build reads every head again from the start.
// `entryBlocks` holds the blocks the service sent of entry recipe revisions held here (ADR
// 0031, amended 2026-11-16).
export const cacheSchema = v.strictObject({
  version: v.literal(2),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  cursor: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  unreadableBy: v.optional(v.pipe(v.string(), v.minLength(1))),
  recipes: v.pipe(
    v.array(storedLoginRecipeSchema),
    v.check(
      (recipes) => new Set(recipes.map((recipe) => recipe.id)).size === recipes.length,
      "Duplicate cached recipes",
    ),
  ),
  entryBlocks: v.optional(v.array(syncedEntryBlockSchema)),
});
export type RecipeCache = v.InferOutput<typeof cacheSchema>;

// Kept separately so even an exactly full recipe cache can checkpoint its lookahead.
// This is not an applied cursor: normal sync still reads every pending current head.
export const recoverySchema = v.strictObject({
  version: v.literal(2),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  cursor: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  after: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
});
export type RecipeRecovery = v.InferOutput<typeof recoverySchema>;

// When the next background sync is due; it survives service worker restarts.
export const scheduleSchema = v.strictObject({
  version: v.literal(1),
  startedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  retryAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type RecipeSyncSchedule = v.InferOutput<typeof scheduleSchema>;

export interface RecipeCacheStorage {
  read(): Promise<unknown>;
  write(cache: RecipeCache): Promise<void>;
  readRecovery(): Promise<unknown>;
  writeRecovery(recovery: RecipeRecovery): Promise<void>;
  /** Clears both the cache and its recovery checkpoint. */
  clear(): Promise<void>;
}

export interface RecipeScheduleStorage {
  read(): Promise<unknown>;
  write(schedule: RecipeSyncSchedule): Promise<void>;
}
