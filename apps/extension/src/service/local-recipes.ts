import {
  loginIdentifierSchema,
  storedLoginRecipeSchema,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import * as v from "valibot";
import type { ServiceConnection } from "./runtime";
import type { ServiceTransport } from "./transport";

// Recipes kept on a device that has no paired service (ADR 0039). They come from a recipe
// file the user imports on the settings page, are looked up only while no device is
// paired, and are uploaded once to a service the device pairs with later.

const recipeList = v.pipe(
  v.array(storedLoginRecipeSchema),
  v.check(
    (recipes) => new Set(recipes.map((recipe) => recipe.id)).size === recipes.length,
    "Duplicate recipe IDs",
  ),
);

const storeSchema = v.strictObject({ version: v.literal(1), recipes: recipeList });
type LocalRecipeStore = v.InferOutput<typeof storeSchema>;

/** The file the settings page exports and imports; recipes only, never bindings or values. */
export const recipeFileSchema = v.strictObject({
  format: v.literal("pateat-recipes"),
  version: v.literal(1),
  recipes: recipeList,
});
export type RecipeFile = v.InferOutput<typeof recipeFileSchema>;

/**
 * The serialized recipes kept here, the same share of `storage.local` as the synced cache
 * (`MAX_RECIPE_CACHE_BYTES`); this module stays free of the sync code the settings page
 * does not load.
 */
export const MAX_LOCAL_RECIPE_BYTES = 2 * 1024 * 1024;
/** The largest recipe file the settings page reads; the stored copy has its own limit. */
export const MAX_RECIPE_FILE_BYTES = 2 * MAX_LOCAL_RECIPE_BYTES;

export const localRecipeRequestSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("recipes.get") }),
  v.strictObject({ version: v.literal(1), type: v.literal("recipes.export") }),
  v.strictObject({ version: v.literal(1), type: v.literal("recipes.import"), file: v.unknown() }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("recipes.remove"),
    recipeId: loginIdentifierSchema,
  }),
  /** Forgets every recipe kept on the device, also a copy that cannot be read. */
  v.strictObject({ version: v.literal(1), type: v.literal("recipes.clear") }),
]);
export type LocalRecipeRequest = v.InferOutput<typeof localRecipeRequestSchema>;

const summarySchema = v.strictObject({
  id: v.string(),
  origin: v.string(),
  revision: v.number(),
  kind: v.picklist(["login", "entry", "chooser"]),
});
export type RecipeSummary = v.InferOutput<typeof summarySchema>;

/**
 * What the settings page shows. `device`: no service is paired, and logins use the
 * recipes kept here. `service`: logins use the paired service's cached recipes, and
 * `waiting` counts the recipes kept here that are not uploaded yet. `unavailable`: the
 * pairing or the recipes kept here cannot be read.
 */
export const localRecipeStateSchema = v.strictObject({
  source: v.picklist(["device", "service", "unavailable"]),
  recipes: v.array(summarySchema),
  waiting: v.number(),
  /** The recipes kept here cannot be read; clearing them is the way out. */
  unreadable: v.optional(v.literal(true)),
});
export type LocalRecipeState = v.InferOutput<typeof localRecipeStateSchema>;

export const localRecipeErrorSchema = v.picklist([
  "invalid-request",
  /** Not a Pateat recipe file, or one with a recipe this version cannot read. */
  "invalid-file",
  /** The recipes kept here would outgrow their share of local storage. */
  "too-large",
  /** A paired device takes its recipes from the service; import and removal wait. */
  "paired",
  "storage-unavailable",
  /** The recipes kept here cannot be read; only clearing them works. */
  "storage-corrupt",
]);
export type LocalRecipeError = v.InferOutput<typeof localRecipeErrorSchema>;

const importCountsSchema = v.strictObject({
  added: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  /** Recipes of an ID kept here at the same or a newer revision with other content. */
  skipped: v.number(),
});
export type RecipeImportCounts = v.InferOutput<typeof importCountsSchema>;

export const localRecipeResponseSchema = v.union([
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(true),
    state: localRecipeStateSchema,
    imported: v.optional(importCountsSchema),
    file: v.optional(recipeFileSchema),
  }),
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(false),
    error: localRecipeErrorSchema,
    state: v.optional(localRecipeStateSchema),
  }),
]);
export type LocalRecipeResponse = v.InferOutput<typeof localRecipeResponseSchema>;

export interface LocalRecipeStorage {
  read(): Promise<unknown>;
  write(store: LocalRecipeStore): Promise<void>;
  clear(): Promise<void>;
}

class StorageUnavailable extends Error {}
class StorageCorrupt extends Error {}
class TooLarge extends Error {}

const encoder = new TextEncoder();
const sameRecipe = (left: StoredLoginRecipe, right: StoredLoginRecipe) =>
  JSON.stringify(left) === JSON.stringify(right);
const summary = (recipe: StoredLoginRecipe): RecipeSummary => ({
  id: recipe.id,
  origin: recipe.origin,
  revision: recipe.revision,
  kind: "entry" in recipe ? "entry" : "chooser" in recipe ? "chooser" : "login",
});

export function createLocalRecipes(options: {
  storage: LocalRecipeStorage;
  service: {
    /** Rejects when the connection cannot be read; undefined means no device is paired. */
    connection(): Promise<ServiceConnection | undefined>;
  };
  /** The paired device's cached recipes, which a paired device exports. */
  synced(): Promise<readonly StoredLoginRecipe[] | undefined>;
  transport: Pick<ServiceTransport, "writeRecipe">;
}) {
  const { storage, service, transport } = options;
  // One change at a time, so an import cannot race a removal or an upload's cleanup.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const pending = queue.then(task);
    queue = pending.catch(() => undefined);
    return pending;
  }

  async function load(): Promise<StoredLoginRecipe[]> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      throw new StorageUnavailable();
    }
    if (stored === undefined) return [];
    const parsed = v.safeParse(storeSchema, stored);
    // A copy that cannot be read is kept until the user clears it.
    if (!parsed.success) throw new StorageCorrupt();
    return parsed.output.recipes;
  }
  async function save(recipes: StoredLoginRecipe[]) {
    try {
      if (recipes.length === 0) await storage.clear();
      else await storage.write({ version: 1, recipes });
    } catch {
      throw new StorageUnavailable();
    }
  }

  async function state(): Promise<LocalRecipeState> {
    let connection: ServiceConnection | undefined;
    try {
      connection = await service.connection();
    } catch {
      return { source: "unavailable", recipes: [], waiting: 0 };
    }
    const kept = await load().catch(() => undefined);
    const unreadable = kept ? {} : { unreadable: true as const };
    if (connection) {
      const synced = (await options.synced().catch(() => undefined)) ?? [];
      return {
        source: "service",
        recipes: synced.map(summary),
        waiting: kept?.length ?? 0,
        ...unreadable,
      };
    }
    return kept
      ? { source: "device", recipes: kept.map(summary), waiting: 0 }
      : { source: "unavailable", recipes: [], waiting: 0, ...unreadable };
  }

  /**
   * Adds the file's recipes to those kept here. A recipe whose ID is already kept replaces
   * it only at a higher revision, so a login that resumes on a revision never finds other
   * content under it; the same revision with other content is skipped.
   */
  async function importFile(file: RecipeFile): Promise<RecipeImportCounts> {
    const kept = new Map((await load()).map((recipe) => [recipe.id, recipe]));
    const counts = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (const recipe of file.recipes) {
      const held = kept.get(recipe.id);
      if (!held) counts.added += 1;
      else if (recipe.revision > held.revision) counts.updated += 1;
      else {
        counts[
          recipe.revision === held.revision && sameRecipe(recipe, held) ? "unchanged" : "skipped"
        ] += 1;
        continue;
      }
      kept.set(recipe.id, recipe);
    }
    const next = [...kept.values()];
    if (
      encoder.encode(JSON.stringify({ version: 1, recipes: next })).byteLength >
      MAX_LOCAL_RECIPE_BYTES
    )
      throw new TooLarge();
    if (counts.added + counts.updated > 0) await save(next);
    return counts;
  }

  async function run(input: unknown): Promise<LocalRecipeResponse> {
    const parsed = v.safeParse(localRecipeRequestSchema, input);
    if (!parsed.success) return { version: 1, ok: false, error: "invalid-request" };
    const request = parsed.output;
    const done = async (extra: { imported?: RecipeImportCounts; file?: RecipeFile } = {}) => ({
      version: 1 as const,
      ok: true as const,
      state: await state(),
      ...extra,
    });
    const fail = async (error: LocalRecipeError): Promise<LocalRecipeResponse> => ({
      version: 1,
      ok: false,
      error,
      state: await state(),
    });
    if (request.type === "recipes.get") return done();
    let connection: ServiceConnection | undefined;
    try {
      connection = await service.connection();
    } catch {
      return fail("storage-unavailable");
    }
    if (request.type === "recipes.export") {
      // The recipes logins use now: the service's while paired, else those kept here.
      const recipes = connection ? ((await options.synced()) ?? []) : await load();
      return done({ file: { format: "pateat-recipes", version: 1, recipes: [...recipes] } });
    }
    if (request.type === "recipes.clear") {
      // Also clears what a paired device still has to upload, if the user asks.
      await save([]);
      return done();
    }
    if (connection) return fail("paired");
    if (request.type === "recipes.remove") {
      const kept = await load();
      await save(kept.filter((recipe) => recipe.id !== request.recipeId));
      return done();
    }
    const file = v.safeParse(recipeFileSchema, request.file);
    if (!file.success) return fail("invalid-file");
    return done({ imported: await importFile(file.output) });
  }

  return {
    handle(input: unknown): Promise<LocalRecipeResponse> {
      return enqueue(() =>
        run(input).catch(async (error: unknown): Promise<LocalRecipeResponse> => {
          const code: LocalRecipeError | undefined =
            error instanceof TooLarge
              ? "too-large"
              : error instanceof StorageCorrupt
                ? "storage-corrupt"
                : error instanceof StorageUnavailable
                  ? "storage-unavailable"
                  : undefined;
          if (!code) throw error;
          return { version: 1, ok: false, error: code, state: await state() };
        }),
      );
    },

    /** The recipes kept here, or undefined when they cannot be read (served as none). */
    list(): Promise<readonly StoredLoginRecipe[] | undefined> {
      return load().catch(() => undefined);
    },

    /**
     * Uploads the recipes kept here to the newly paired service, each as a new recipe at
     * revision 1, and forgets each one the service now holds: written, or already held
     * under its ID, whose service copy wins. A recipe the service refused stays here; a
     * full service or a failed request stops the upload until the next sync.
     */
    async upload(
      connection: ServiceConnection,
      stale: () => boolean,
    ): Promise<"done" | "rejected"> {
      const kept = await load().catch(() => []);
      const settled = new Set<string>();
      let outcome: "done" | "rejected" = "done";
      for (const recipe of kept) {
        if (stale()) break;
        // oxlint-disable-next-line no-await-in-loop -- one write at a time, in order
        const result = await transport.writeRecipe(
          connection.origin,
          connection.credential,
          recipe.id,
          {
            version: 1,
            expectedRevision: 0,
            state: "active",
            recipe: withRevision(recipe, 1),
          },
        );
        if (result.kind === "written" || result.kind === "conflict") settled.add(recipe.id);
        else if (result.kind === "rejected") {
          outcome = "rejected";
          break;
        } else if (result.kind !== "refused") break;
      }
      if (settled.size > 0)
        await enqueue(async () =>
          save((await load()).filter((recipe) => !settled.has(recipe.id))),
        ).catch(() => undefined);
      return outcome;
    },
  };
}

/** The recipe at another revision; a chooser's branches carry the chooser's revision. */
function withRevision(recipe: StoredLoginRecipe, revision: number): StoredLoginRecipe {
  if (!("chooser" in recipe)) return { ...recipe, revision };
  const { afterAccount, afterOther } = recipe.chooser;
  return {
    ...recipe,
    revision,
    chooser: {
      ...recipe.chooser,
      ...(afterAccount ? { afterAccount: { ...afterAccount, revision } } : {}),
      ...(afterOther ? { afterOther: { ...afterOther, revision } } : {}),
    },
  };
}
