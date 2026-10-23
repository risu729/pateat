import {
  MAX_ACTIVE_RECIPE_BYTES,
  storedLoginRecipeSchema,
  type StoredLoginRecipe,
  type SyncRecipeWrite,
} from "@pateat/contracts";
import * as v from "valibot";
import type { ServiceConnection } from "./runtime";
import type { RecipeWriteResult, ServiceTransport } from "./transport";

// Recipes this device holds as its own (ADR 0040): logins use them while no service is
// paired. They come from a paired service's recipes kept when the device was
// disconnected, and are uploaded once to a service the device pairs with later.

const recipeList = v.pipe(
  v.array(storedLoginRecipeSchema),
  v.check(
    (recipes) => new Set(recipes.map((recipe) => recipe.id)).size === recipes.length,
    "Duplicate recipe IDs",
  ),
);

const storeSchema = v.strictObject({
  version: v.literal(1),
  recipes: recipeList,
  /**
   * The recipes a service refused for good (400, 405, 413 or a 409 that names no recipe),
   * by ID and revision: they stay here and are not sent again.
   */
  refused: v.optional(
    v.array(
      v.strictObject({
        id: v.string(),
        revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
    ),
  ),
});
type DeviceRecipeStore = v.InferOutput<typeof storeSchema>;

/**
 * The serialized recipes kept here: the same share of `storage.local` as the synced cache
 * (`MAX_RECIPE_CACHE_BYTES`), which they come from.
 */
export const MAX_DEVICE_RECIPE_BYTES = 2 * 1024 * 1024;

export interface DeviceRecipeStorage {
  read(): Promise<unknown>;
  write(store: DeviceRecipeStore): Promise<void>;
  clear(): Promise<void>;
}

/** Active recipes a device holds at once, as the service's `MAX_ACTIVE_RECIPES` (ADR 0040). */
export const MAX_DEVICE_ACTIVE_RECIPES = 1_000;

export class DeviceRecipesUnavailable extends Error {}
export class DeviceRecipesCorrupt extends Error {}
export class DeviceRecipesTooLarge extends Error {}

const encoder = new TextEncoder();
const documentBytes = (recipe: StoredLoginRecipe) =>
  encoder.encode(JSON.stringify(recipe)).byteLength;
const sameRecipe = (left: StoredLoginRecipe, right: StoredLoginRecipe) =>
  JSON.stringify(left) === JSON.stringify(right);

/** How one upload run ended: `done` when nothing is left to retry before the next one. */
export type DeviceRecipeUpload = "done" | "retry" | "rejected";

export function createDeviceRecipes(options: {
  storage: DeviceRecipeStorage;
  transport: Pick<ServiceTransport, "writeRecipe">;
  /** The size limit of the kept recipes; tests pass a smaller one. */
  maxBytes?: number;
}) {
  const { storage, transport } = options;
  const maxBytes = options.maxBytes ?? MAX_DEVICE_RECIPE_BYTES;
  // One change at a time, so keeping recipes cannot race an upload's cleanup.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const pending = queue.then(task);
    queue = pending.catch(() => undefined);
    return pending;
  }

  async function load(): Promise<DeviceRecipeStore> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      throw new DeviceRecipesUnavailable();
    }
    if (stored === undefined) return { version: 1, recipes: [] };
    const parsed = v.safeParse(storeSchema, stored);
    // A copy that cannot be read is kept until the person deletes it.
    if (!parsed.success) throw new DeviceRecipesCorrupt();
    return parsed.output;
  }
  async function save(store: DeviceRecipeStore) {
    const refused = store.refused?.filter((entry) =>
      store.recipes.some((recipe) => recipe.id === entry.id && recipe.revision === entry.revision),
    );
    try {
      if (store.recipes.length === 0) await storage.clear();
      else
        await storage.write({
          version: 1,
          recipes: store.recipes,
          ...(refused?.length ? { refused } : {}),
        });
    } catch {
      throw new DeviceRecipesUnavailable();
    }
  }

  return {
    /** The recipes kept here; rejects when they cannot be read. */
    async list(): Promise<readonly StoredLoginRecipe[]> {
      return (await load()).recipes;
    },

    /**
     * How many recipes are kept here: -1 when the stored copy cannot be read, and
     * undefined while storage is unavailable, which may pass.
     */
    count(): Promise<number | undefined> {
      return load().then(
        (store) => store.recipes.length,
        (error: unknown) => (error instanceof DeviceRecipesCorrupt ? -1 : undefined),
      );
    },

    /**
     * Keeps `recipes` here, as when a device is disconnected and keeps the service's. A
     * recipe of an ID kept here already replaces it only at a newer revision, so a login
     * that resumes on a revision never finds other content under it. Rejects without
     * changing anything when the result would not fit.
     */
    keep(recipes: readonly StoredLoginRecipe[]): Promise<void> {
      return enqueue(async () => {
        const store = await load();
        const kept = new Map(store.recipes.map((recipe) => [recipe.id, recipe]));
        for (const recipe of recipes) {
          const held = kept.get(recipe.id);
          if (!held || recipe.revision > held.revision) kept.set(recipe.id, recipe);
        }
        const next = [...kept.values()];
        if (encoder.encode(JSON.stringify({ version: 1, recipes: next })).byteLength > maxBytes)
          throw new DeviceRecipesTooLarge();
        await save({ ...store, recipes: next });
      });
    },

    /** The recipe kept here under `recipeId`; rejects when the recipes cannot be read. */
    async head(recipeId: string): Promise<StoredLoginRecipe | undefined> {
      await queue;
      return (await load()).recipes.find((recipe) => recipe.id === recipeId);
    },

    /**
     * How many recipes are kept here and their documents' UTF-8 bytes, as the service
     * counts its active recipes (ADR 0040).
     */
    async usage(): Promise<{ count: number; bytes: number }> {
      await queue;
      const { recipes } = await load();
      return {
        count: recipes.length,
        bytes: recipes.reduce((sum, recipe) => sum + documentBytes(recipe), 0),
      };
    },

    /**
     * Writes the next revision of a recipe generated on this device while no service is
     * paired (ADR 0040), when `expectedRevision` is still the one kept here (0 for none): a
     * write another one beat gets the recipe kept now. A write that would hold more than
     * the service's recipes or bytes, or more than fits here, is `limited`. Revoking
     * removes the recipe, since nothing here syncs its tombstone.
     */
    write(
      recipeId: string,
      write: SyncRecipeWrite,
    ): Promise<
      | { ok: true; recipe: StoredLoginRecipe | undefined }
      | { ok: false; limited: false; current: StoredLoginRecipe | undefined }
      | { ok: false; limited: true }
    > {
      return enqueue(async () => {
        const store = await load();
        const current = store.recipes.find((recipe) => recipe.id === recipeId);
        if ((current?.revision ?? 0) !== write.expectedRevision)
          return { ok: false, limited: false, current };
        const others = store.recipes.filter((recipe) => recipe.id !== recipeId);
        if (write.state === "revoked") {
          await save({ ...store, recipes: others });
          return { ok: true, recipe: undefined };
        }
        if (write.recipe.id !== recipeId) return { ok: false, limited: false, current };
        const next = [...others, write.recipe];
        const bytes = next.reduce((sum, recipe) => sum + documentBytes(recipe), 0);
        if (
          (!current && next.length > MAX_DEVICE_ACTIVE_RECIPES) ||
          // As on the service, only a write that adds a recipe or grows one is held to it.
          (bytes > MAX_ACTIVE_RECIPE_BYTES &&
            (!current || documentBytes(write.recipe) > documentBytes(current))) ||
          encoder.encode(JSON.stringify({ version: 1, recipes: next })).byteLength > maxBytes
        )
          return { ok: false, limited: true };
        await save({ ...store, recipes: next });
        return { ok: true, recipe: write.recipe };
      });
    },

    /** Deletes every recipe kept here, also a copy that cannot be read. */
    clear(): Promise<void> {
      return enqueue(async () => {
        try {
          await storage.clear();
        } catch {
          throw new DeviceRecipesUnavailable();
        }
      });
    },

    /**
     * Uploads the recipes kept here to the paired service (owner, 2026-10-23 12:36 UTC),
     * each as a new recipe at revision 1. One the service holds revoked under its ID is
     * forgotten, as the service's copy wins; one written or held active stays until the
     * synced cache holds it (`forget`), so a disconnect that keeps the synced recipes
     * never misses it. A recipe the service refuses for good stays here and is not sent
     * again; a full service, a refused rate, a server error or no connection stops the
     * upload until the next full sync. A device disconnected meanwhile (`stale`) forgets
     * nothing.
     */
    async upload(connection: ServiceConnection, stale: () => boolean): Promise<DeviceRecipeUpload> {
      const store = await load().catch(() => undefined);
      if (!store) return "done";
      const refused = new Set(
        (store.refused ?? []).map((entry) => `${entry.id}\n${entry.revision}`),
      );
      const revoked = new Map<string, StoredLoginRecipe>();
      const newlyRefused: StoredLoginRecipe[] = [];
      let outcome: DeviceRecipeUpload = "done";
      for (const recipe of store.recipes) {
        if (stale()) {
          outcome = "retry";
          break;
        }
        if (refused.has(`${recipe.id}\n${recipe.revision}`)) continue;
        // oxlint-disable-next-line no-await-in-loop -- one write at a time, in order
        const result: RecipeWriteResult = await transport.writeRecipe(
          connection.origin,
          connection.credential,
          recipe.id,
          // The stored document names its revision once (ADR 0060), so a new recipe starts
          // at 1.
          { version: 1, expectedRevision: 0, state: "active", recipe: { ...recipe, revision: 1 } },
        );
        if (result.kind === "written") continue;
        if (result.kind === "conflict") {
          if (result.current.state === "revoked") revoked.set(recipe.id, recipe);
        } else if (result.kind === "refused") newlyRefused.push(recipe);
        else {
          outcome = result.kind === "rejected" ? "rejected" : "retry";
          break;
        }
      }
      if ((revoked.size > 0 || newlyRefused.length > 0) && !stale())
        await enqueue(async () => {
          if (stale()) return;
          const held = await load();
          // Only the copies that were sent; one kept since under the ID stays.
          const left = held.recipes.filter((recipe) => {
            const uploaded = revoked.get(recipe.id);
            return !uploaded || !sameRecipe(uploaded, recipe);
          });
          await save({
            ...held,
            recipes: left,
            refused: [
              ...(held.refused ?? []),
              ...newlyRefused.map((recipe) => ({ id: recipe.id, revision: recipe.revision })),
            ],
          });
        }).catch(() => undefined);
      return outcome;
    },

    /**
     * Forgets the recipes whose IDs the paired service's synced cache now holds (`held`):
     * the service's copy is the one logins use and a disconnect keeps. A device
     * disconnected meanwhile (`stale`) forgets nothing.
     */
    forget(held: ReadonlySet<string>, stale: () => boolean): Promise<void> {
      return enqueue(async () => {
        if (stale()) return;
        const store = await load();
        const left = store.recipes.filter((recipe) => !held.has(recipe.id));
        if (left.length !== store.recipes.length) await save({ ...store, recipes: left });
      });
    },
  };
}
