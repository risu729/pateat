import {
  deviceIdSchema,
  loginRecipeSchema,
  loginRecipesForOrigin,
  selectLoginRecipe,
  serviceOriginSchema,
  type LoginRecipe,
} from "@pateat/contracts";
import * as v from "valibot";
import type { LoginRecipes } from "../login/runtime";
import type { RecipeSyncRecord, ServiceConnection } from "./runtime";
import type { ServiceTransport, TransportFailure } from "./transport";

/** A lookup this long after the last sync attempt starts a background sync. */
export const RECIPE_SYNC_STALE_MS = 5 * 60 * 1000;
/** After the service asks Pateat to slow down, background syncs wait this long. */
export const RECIPE_SYNC_RATE_LIMIT_MS = 15 * 60 * 1000;
/** Pages read in one sync; a larger backlog continues on the next one. */
export const MAX_RECIPE_PAGES_PER_SYNC = 50;
/**
 * The serialized cache stays well inside the 10 MB `storage.local` quota it shares with
 * the vault cache, settings and login attempts.
 */
export const MAX_RECIPE_CACHE_BYTES = 2 * 1024 * 1024;

// The last-known-good copy of the owner's active recipes (ADR 0013). The cursor and
// recipes are written together, so a failed write leaves the previous consistent copy.
const cacheSchema = v.strictObject({
  version: v.literal(1),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  cursor: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  recipes: v.pipe(
    v.array(loginRecipeSchema),
    v.check(
      (recipes) => new Set(recipes.map((recipe) => recipe.id)).size === recipes.length,
      "Duplicate cached recipes",
    ),
  ),
});
type RecipeCache = v.InferOutput<typeof cacheSchema>;

// When the next background sync is due; it survives service worker restarts.
const scheduleSchema = v.strictObject({
  version: v.literal(1),
  startedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  retryAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
type RecipeSyncSchedule = v.InferOutput<typeof scheduleSchema>;

export interface RecipeCacheStorage {
  read(): Promise<unknown>;
  write(cache: RecipeCache): Promise<void>;
  clear(): Promise<void>;
}

export interface RecipeScheduleStorage {
  read(): Promise<unknown>;
  write(schedule: RecipeSyncSchedule): Promise<void>;
}

const encoder = new TextEncoder();

export type RecipeSyncOutcome =
  | "synced"
  /** More changes remain than one sync reads; the next sync continues from the cursor. */
  | "incomplete"
  | "not-connected"
  | "rejected"
  /** The next page would grow the cache past its size limit; it was not applied. */
  | "cache-full"
  | "storage-unavailable"
  | TransportFailure;

export function createRecipeSync(options: {
  service: {
    connection(): Promise<ServiceConnection | undefined>;
    recordSync(deviceId: string, outcome: RecipeSyncRecord): Promise<void>;
  };
  transport: Pick<ServiceTransport, "recipeChanges">;
  storage: RecipeCacheStorage;
  schedule: RecipeScheduleStorage;
  now?: () => number;
}) {
  const { service, transport, storage, schedule } = options;
  const now = options.now ?? Date.now;
  let running: Promise<RecipeSyncOutcome> | undefined;
  // A sync requested while one runs, for example by a new pairing, runs once more after it.
  let rerun = false;
  // Only this module writes the cache, so the parsed copy stays valid until the next write.
  let memory: RecipeCache | undefined;
  // Bumped by clear(), so a sync or read that started before it cannot restore the cache.
  let generation = 0;
  let retryAt: Promise<number> | undefined;

  /** The cache of exactly this paired device; another device's or a corrupt copy is ignored. */
  async function load(connection: ServiceConnection): Promise<RecipeCache | undefined> {
    if (!memory) {
      const started = generation;
      let stored: unknown;
      try {
        stored = await storage.read();
      } catch {
        return undefined;
      }
      const parsed = v.safeParse(cacheSchema, stored);
      if (!parsed.success) return undefined;
      if (generation !== started) return undefined;
      memory ??= parsed.output;
    }
    return memory.origin === connection.origin && memory.deviceId === connection.deviceId
      ? memory
      : undefined;
  }

  /** When the next background sync is due; a clock that moved backwards makes it due now. */
  function dueAt(): Promise<number> {
    retryAt ??= schedule.read().then(
      (stored) => {
        const parsed = v.safeParse(scheduleSchema, stored);
        return parsed.success && parsed.output.startedAt <= now() ? parsed.output.retryAt : 0;
      },
      () => 0,
    );
    return retryAt;
  }
  function plan(startedAt: number, delay: number) {
    retryAt = Promise.resolve(startedAt + delay);
    // Best effort: a lost write only makes the next worker start sync sooner.
    void schedule
      .write({ version: 1, startedAt, retryAt: startedAt + delay })
      .catch(() => undefined);
  }

  async function run(): Promise<RecipeSyncOutcome> {
    const started = generation;
    const connection = await service.connection();
    if (!connection) return "not-connected";
    if (connection.rejected) return "rejected";
    // A new pairing starts from an empty cache, so another owner's recipes never linger.
    let cache: RecipeCache = (await load(connection)) ?? {
      version: 1,
      origin: connection.origin,
      deviceId: connection.deviceId,
      cursor: 0,
      recipes: [],
    };
    for (let page = 0; page < MAX_RECIPE_PAGES_PER_SYNC; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page continues from the last cursor
      const result = await transport.recipeChanges(
        connection.origin,
        connection.credential,
        cache.cursor,
      );
      if (result.kind === "rejected") {
        // oxlint-disable-next-line no-await-in-loop -- ends the loop
        await service.recordSync(connection.deviceId, { rejected: true });
        return "rejected";
      }
      if (result.kind === "failed") return result.error;
      const { changes, cursor, complete } = result.page;
      if (!complete && cursor === cache.cursor) return "unexpected-response";
      const recipes = new Map(cache.recipes.map((recipe) => [recipe.id, recipe]));
      for (const change of changes) {
        if (change.state === "active") recipes.set(change.recipeId, change.recipe);
        else recipes.delete(change.recipeId);
      }
      const next: RecipeCache = { ...cache, cursor, recipes: [...recipes.values()] };
      if (encoder.encode(JSON.stringify(next)).byteLength > MAX_RECIPE_CACHE_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- ends the loop
        await service.recordSync(connection.deviceId, { cacheFull: true });
        return "cache-full";
      }
      // The device was disconnected meanwhile; its recipes are not written back.
      if (generation !== started) return "not-connected";
      try {
        memory = undefined;
        // oxlint-disable-next-line no-await-in-loop -- the cursor advances only with its recipes
        await storage.write(next);
      } catch {
        return "storage-unavailable";
      }
      if (generation !== started) return "not-connected";
      memory = next;
      cache = next;
      if (complete) {
        // oxlint-disable-next-line no-await-in-loop -- ends the loop
        await service.recordSync(connection.deviceId, { syncedAt: now() });
        return "synced";
      }
    }
    return "incomplete";
  }

  /**
   * Runs a sync now. A call while one runs joins it and makes it run once more, so a
   * device paired during an older device's sync is synced too.
   */
  function sync(): Promise<RecipeSyncOutcome> {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        let outcome: RecipeSyncOutcome;
        do {
          rerun = false;
          const startedAt = now();
          plan(startedAt, RECIPE_SYNC_STALE_MS);
          // oxlint-disable-next-line no-await-in-loop -- a rerun follows the previous run
          outcome = await run().catch((): RecipeSyncOutcome => "storage-unavailable");
          if (outcome === "rate-limited") plan(startedAt, RECIPE_SYNC_RATE_LIMIT_MS);
        } while (rerun);
        return outcome;
      } finally {
        // Cleared in the same step as the last rerun check, so no request falls between.
        running = undefined;
      }
    })();
    return running;
  }

  /** Starts a background sync when the last attempt, even in an earlier worker, is old. */
  function refreshIfStale() {
    if (running) return;
    void dueAt().then((at) => (!running && now() >= at ? sync() : undefined));
  }

  /** Forgets the cache when its device is disconnected; a new pairing starts empty anyway. */
  async function clear() {
    generation += 1;
    memory = undefined;
    await storage.clear().catch(() => undefined);
  }

  const recipes: LoginRecipes = {
    async recipe(origin: string, path: string, recipeId?: string) {
      const connection = await service.connection();
      if (!connection) return undefined;
      if (!connection.rejected) refreshIfStale();
      const cache = await load(connection);
      if (!cache) return undefined;
      // A resumed attempt asks for its own recipe; the executor checks its revision.
      if (recipeId !== undefined)
        return loginRecipesForOrigin(cache.recipes, origin).find(
          (recipe): recipe is LoginRecipe => recipe.id === recipeId,
        );
      const selection = selectLoginRecipe(cache.recipes, origin, path);
      return selection.ok ? selection.recipe : undefined;
    },
  };

  return { sync, refreshIfStale, clear, recipes };
}
