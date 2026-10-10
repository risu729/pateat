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
import type { ServiceConnection } from "./runtime";
import type { ServiceTransport, TransportFailure } from "./transport";

/** A lookup older than this starts a background sync; the lookup itself never waits. */
export const RECIPE_SYNC_STALE_MS = 5 * 60 * 1000;
/** Pages read in one sync; a larger backlog continues on the next one. */
export const MAX_RECIPE_PAGES_PER_SYNC = 50;

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

export interface RecipeCacheStorage {
  read(): Promise<unknown>;
  write(cache: RecipeCache): Promise<void>;
  clear(): Promise<void>;
}

export type RecipeSyncOutcome =
  | "synced"
  /** More changes remain than one sync reads; the next sync continues from the cursor. */
  | "incomplete"
  | "not-connected"
  | "rejected"
  | "storage-unavailable"
  | TransportFailure;

export function createRecipeSync(options: {
  service: {
    connection(): Promise<ServiceConnection | undefined>;
    recordSync(deviceId: string, outcome: { syncedAt: number } | { rejected: true }): Promise<void>;
  };
  transport: Pick<ServiceTransport, "recipeChanges">;
  storage: RecipeCacheStorage;
  now?: () => number;
}) {
  const { service, transport, storage } = options;
  const now = options.now ?? Date.now;
  let running: Promise<RecipeSyncOutcome> | undefined;
  let lastStartedAt: number | undefined;

  /** The cache of exactly this paired device; another device's or a corrupt copy is ignored. */
  async function load(connection: ServiceConnection): Promise<RecipeCache | undefined> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      return undefined;
    }
    const parsed = v.safeParse(cacheSchema, stored);
    return parsed.success &&
      parsed.output.origin === connection.origin &&
      parsed.output.deviceId === connection.deviceId
      ? parsed.output
      : undefined;
  }

  async function run(): Promise<RecipeSyncOutcome> {
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
      try {
        // oxlint-disable-next-line no-await-in-loop -- the cursor advances only with its recipes
        await storage.write(next);
      } catch {
        return "storage-unavailable";
      }
      cache = next;
      if (complete) {
        // oxlint-disable-next-line no-await-in-loop -- ends the loop
        await service.recordSync(connection.deviceId, { syncedAt: now() });
        return "synced";
      }
    }
    return "incomplete";
  }

  /** Runs one sync, or joins the one already running. */
  function sync(): Promise<RecipeSyncOutcome> {
    lastStartedAt = now();
    running ??= run()
      .catch((): RecipeSyncOutcome => "storage-unavailable")
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  function refreshIfStale() {
    if (lastStartedAt === undefined || now() - lastStartedAt >= RECIPE_SYNC_STALE_MS) void sync();
  }

  const recipes: LoginRecipes = {
    async recipe(origin: string, path: string, recipeId?: string) {
      const connection = await service.connection();
      if (!connection) return undefined;
      refreshIfStale();
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

  return { sync, refreshIfStale, recipes };
}
