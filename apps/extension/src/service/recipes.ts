import {
  deviceIdSchema,
  laterStartSteps,
  loginRecipesForOrigin,
  MAX_RECIPE_CACHE_BYTES,
  recipeStartSteps,
  selectLoginRecipe,
  serviceOriginSchema,
  storedLoginRecipeSchema,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginRecipe,
  type SyncRecipeChanges,
} from "@pateat/contracts";
import * as v from "valibot";
import type { LoginRecipes } from "../login/runtime";
import { loginReadiness } from "../login/wire";
import type { RecipeSyncRecord, ServiceConnection } from "./runtime";
import type { SettingsSyncOutcome } from "./settings-sync";
import {
  addTimings,
  type ServiceTiming,
  type ServiceTransport,
  type TransportFailure,
} from "./transport";

/** A lookup this long after the last sync attempt starts a background sync. */
export const RECIPE_SYNC_STALE_MS = 5 * 60 * 1000;
/** After the service asks Pateat to slow down, background syncs wait this long. */
export const RECIPE_SYNC_RATE_LIMIT_MS = 15 * 60 * 1000;
/** Pages read in one sync; a larger backlog continues on the next one. */
export const MAX_RECIPE_PAGES_PER_SYNC = 50;
/**
 * The serialized cache stays well inside the 10 MB `storage.local` quota it shares with
 * settings, login attempts and other extension state; the vault cache is in IndexedDB.
 */
export { MAX_RECIPE_CACHE_BYTES } from "@pateat/contracts";

// The last-known-good copy of the owner's active recipes (ADR 0013). The cursor and
// recipes are written together, so a failed write leaves the previous consistent copy.
// An overflow walk writes only removals with the old cursor; skipped active changes
// remain pending until their entire page fits.
// Entry and chooser recipes (ADR 0031, ADR 0028) are cached with the rest; only a
// chooser is looked up and starts a login, on its list's path, and `entries` lists an
// origin's entry recipes.
const cacheSchema = v.strictObject({
  version: v.literal(1),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  cursor: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  recipes: v.pipe(
    v.array(storedLoginRecipeSchema),
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
  /** Active changes do not fit; bounded revoke-only pages still remove cached recipes. */
  | "cache-full"
  | "storage-unavailable"
  | SettingsSyncOutcome
  | TransportFailure;

/** What one sync run changed in the recipe cache, for the local log. */
export type RecipeSyncChanges = {
  /** `recipes` for a recipes-only run, `full` when settings ran too. */
  scope: "recipes" | "full";
  added: number;
  updated: number;
  removed: number;
  /** The run's requests' timing added up; none when it sent none (ADR 0019). */
  timing?: ServiceTiming;
};

/** Adds one request's timing to a sync run's. */
function timed(changed: RecipeSyncChanges, timing: ServiceTiming | undefined): void {
  const total = addTimings(changed.timing, timing);
  if (total) changed.timing = total;
}

export function createRecipeSync(options: {
  service: {
    /** Rejects when the connection cannot be read; undefined means no device is paired. */
    connection(): Promise<ServiceConnection | undefined>;
    recordSync(deviceId: string, outcome: RecipeSyncRecord): Promise<void>;
  };
  transport: Pick<ServiceTransport, "recipeChanges">;
  storage: RecipeCacheStorage;
  schedule: RecipeScheduleStorage;
  /** Settings sync for the same device, run after recipes in every sync. */
  settings?: {
    run(
      connection: ServiceConnection,
      stale: () => boolean,
      timed?: (timing: ServiceTiming | undefined) => void,
    ): Promise<SettingsSyncOutcome>;
    clear(): Promise<void>;
  };
  /** Receives the outcome of each sync run and what it changed, for the local log. */
  report?: (outcome: RecipeSyncOutcome, changes: RecipeSyncChanges) => void;
  now?: () => number;
}) {
  const { service, transport, storage, schedule } = options;
  const now = options.now ?? Date.now;
  let running: Promise<RecipeSyncOutcome> | undefined;
  // A sync requested while one runs, for example by a new pairing, runs once more after it.
  let rerun = false;
  // Whether that further run includes settings; a recipes-only request does not add them.
  let rerunSettings = false;
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

  async function run(
    withSettings: boolean,
    changed: RecipeSyncChanges,
  ): Promise<RecipeSyncOutcome> {
    const started = generation;
    const connection = await service.connection();
    if (!connection) {
      // Retries a clear that a disconnect could not finish, for example in a stopped worker.
      await clear();
      return "not-connected";
    }
    if (connection.rejected) return "rejected";
    const recipesOutcome = await pullRecipes(connection, started, changed);
    if (["not-connected", "rejected", "unreachable", "rate-limited"].includes(recipesOutcome))
      return recipesOutcome;
    // Recipes alone do not complete a sync, so nothing is recorded for them.
    if (!withSettings) return recipesOutcome;
    const settingsOutcome = options.settings
      ? await options.settings.run(
          connection,
          () => generation !== started,
          (timing) => timed(changed, timing),
        )
      : "synced";
    if (generation !== started) return "not-connected";
    if (settingsOutcome === "rejected") {
      await service.recordSync(connection.deviceId, { rejected: true });
      return "rejected";
    }
    if (settingsOutcome === "too-large")
      await service.recordSync(connection.deviceId, { cacheFull: true });
    const outcome = recipesOutcome === "synced" ? settingsOutcome : recipesOutcome;
    if (outcome === "synced") await service.recordSync(connection.deviceId, { syncedAt: now() });
    return outcome;
  }

  /**
   * Pulls recipe pages into the cache; recording a complete sync is left to `run`. Counts
   * each written page's changes in `changed`.
   */
  async function pullRecipes(
    connection: ServiceConnection,
    started: number,
    changed: RecipeSyncChanges,
  ): Promise<RecipeSyncOutcome> {
    // A new pairing starts from an empty cache, so another owner's recipes never linger.
    let cache: RecipeCache = (await load(connection)) ?? {
      version: 1,
      origin: connection.origin,
      deviceId: connection.deviceId,
      cursor: 0,
      recipes: [],
    };
    // Disconnected while loading the cache; the old credential is not used again.
    if (generation !== started) return "not-connected";
    async function readPage(cursor: number): Promise<SyncRecipeChanges | RecipeSyncOutcome> {
      if (generation !== started) return "not-connected";
      const result = await transport.recipeChanges(
        connection.origin,
        connection.credential,
        cursor,
      );
      timed(changed, result.timing);
      if (generation !== started) return "not-connected";
      if (result.kind === "rejected") {
        await service.recordSync(connection.deviceId, { rejected: true });
        return "rejected";
      }
      if (result.kind === "failed") return result.error;
      if (result.page.cursor < cursor || (!result.page.complete && result.page.cursor === cursor))
        return "unexpected-response";
      return result.page;
    }

    async function writeCache(
      next: RecipeCache,
      counts: { added: number; updated: number; removed: number },
    ): Promise<RecipeSyncOutcome | undefined> {
      if (generation !== started) return "not-connected";
      try {
        memory = undefined;
        await storage.write(next);
      } catch {
        return "storage-unavailable";
      }
      if (generation !== started) return "not-connected";
      memory = next;
      cache = next;
      changed.added += counts.added;
      changed.updated += counts.updated;
      changed.removed += counts.removed;
      return undefined;
    }

    /** Save only removals; later active changes remain pending at the old cursor. */
    async function revokePage(page: SyncRecipeChanges): Promise<RecipeSyncOutcome | undefined> {
      const remaining = new Map(cache.recipes.map((recipe) => [recipe.id, recipe]));
      let removed = 0;
      for (const change of page.changes) {
        if (change.state === "revoked" && remaining.delete(change.recipeId)) removed += 1;
      }
      return removed > 0
        ? writeCache(
            { ...cache, recipes: [...remaining.values()] },
            { added: 0, updated: 0, removed },
          )
        : undefined;
    }

    // Normal and revoke-only walks share the page budget. The stuck-page retry gets
    // one extra request, always from the persisted cursor, never the scan cursor.
    let pagesRead = 0;
    let walkedOverflow = false;
    let retrying = false;
    while (pagesRead < MAX_RECIPE_PAGES_PER_SYNC || retrying) {
      if (!retrying) pagesRead += 1;
      // oxlint-disable-next-line no-await-in-loop -- normal pages use the persisted cursor
      const result = await readPage(cache.cursor);
      if (typeof result === "string") return result;
      const { changes, cursor, complete } = result;
      const before = new Map(cache.recipes.map((recipe) => [recipe.id, recipe]));
      const recipes = new Map(before);
      for (const change of changes) {
        if (change.state === "active") recipes.set(change.recipeId, change.recipe);
        else recipes.delete(change.recipeId);
      }
      // Counted against the page's starting cache, so a recipe changed twice counts once.
      const counts = { added: 0, updated: 0, removed: 0 };
      for (const id of new Set(changes.map((change) => change.recipeId))) {
        const [held, kept] = [before.has(id), recipes.has(id)];
        if (kept) counts[held ? "updated" : "added"] += 1;
        else if (held) counts.removed += 1;
      }
      const next: RecipeCache = { ...cache, cursor, recipes: [...recipes.values()] };
      if (encoder.encode(JSON.stringify(next)).byteLength > MAX_RECIPE_CACHE_BYTES) {
        if (walkedOverflow) {
          // The retry may include revocations made while the walk was running.
          // oxlint-disable-next-line no-await-in-loop -- keep fresh removals without another walk
          const failure = await revokePage(result);
          if (failure) return failure;
          // oxlint-disable-next-line no-await-in-loop -- ends the loop after one retry
          await service.recordSync(connection.deviceId, { cacheFull: true });
          return "cache-full";
        }
        walkedOverflow = true;
        let scan = result;
        for (;;) {
          // Persist removals before requesting more pages, even if a later request fails.
          // oxlint-disable-next-line no-await-in-loop -- preserve the old cursor with removals
          const failure = await revokePage(scan);
          if (failure) return failure;
          if (scan.complete || pagesRead >= MAX_RECIPE_PAGES_PER_SYNC) break;
          pagesRead += 1;
          // oxlint-disable-next-line no-await-in-loop -- only this local cursor skips active pages
          const later = await readPage(scan.cursor);
          if (typeof later === "string") return later;
          scan = later;
        }
        retrying = true;
        continue;
      }
      retrying = false;
      // oxlint-disable-next-line no-await-in-loop -- advance the cursor only with a complete page
      const failure = await writeCache(next, counts);
      if (failure) return failure;
      if (complete) return "synced";
    }
    return "incomplete";
  }

  /**
   * Runs a sync now. A call while one runs joins it and makes it run once more, so a
   * device paired during an older device's sync is synced too.
   *
   * `settings: false` pulls recipe changes only. A login in progress uses it after the
   * service changed its recipe (ADR 0027): a settings write would stop that login as a
   * policy change, so settings wait for the next full sync.
   */
  function sync(scope: { settings?: boolean } = {}): Promise<RecipeSyncOutcome> {
    const withSettings = scope.settings ?? true;
    if (running) {
      rerun = true;
      rerunSettings ||= withSettings;
      return running;
    }
    running = (async () => {
      try {
        let outcome: RecipeSyncOutcome;
        let settingsNow = withSettings;
        do {
          rerun = false;
          rerunSettings = false;
          const startedAt = now();
          // Only a full sync moves the background schedule, which also covers settings.
          if (settingsNow) plan(startedAt, RECIPE_SYNC_STALE_MS);
          const changed: RecipeSyncChanges = {
            scope: settingsNow ? "full" : "recipes",
            added: 0,
            updated: 0,
            removed: 0,
          };
          // oxlint-disable-next-line no-await-in-loop -- a rerun follows the previous run
          outcome = await run(settingsNow, changed).catch(
            (): RecipeSyncOutcome => "storage-unavailable",
          );
          try {
            options.report?.(outcome, changed);
          } catch {
            // A report must never change the sync.
          }
          if (outcome === "rate-limited") plan(startedAt, RECIPE_SYNC_RATE_LIMIT_MS);
          settingsNow = rerunSettings;
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
    await Promise.all([storage.clear().catch(() => undefined), options.settings?.clear()]);
  }

  const recipes: LoginRecipes = {
    async recipe(origin: string, path: string, recipeId?: string) {
      const connection = await service.connection().catch(() => undefined);
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
    async chooser(origin: string, path: string, recipeId?: string) {
      const connection = await service.connection().catch(() => undefined);
      if (!connection) return undefined;
      if (!connection.rejected) refreshIfStale();
      const cache = await load(connection);
      if (!cache) return undefined;
      const choosers = cache.recipes.filter(
        (recipe): recipe is LoginChooserRecipe => "chooser" in recipe && recipe.origin === origin,
      );
      if (recipeId !== undefined) return choosers.find((recipe) => recipe.id === recipeId);
      // The service keeps one generated recipe per origin and start path; a path where
      // several start, or where a login recipe starts as well, starts none (ADR 0013).
      const here = choosers.filter((recipe) => recipe.chooser.path === path);
      return here.length === 1 &&
        !loginRecipesForOrigin(cache.recipes, origin).some(
          (recipe) => recipe.steps[0]!.path === path,
        )
        ? here[0]
        : undefined;
    },
    async starts(origin: string) {
      const connection = await service.connection().catch(() => undefined);
      if (!connection) return [];
      const cache = await load(connection);
      if (!cache) return [];
      // Every variant starts on the recipe's start path (ADR 0027). A chooser recipe (ADR
      // 0028) starts where its list shows, once one of its buttons or a listed account
      // does, or its `other` branch's first step on that path, as when the person pressed
      // the button for another account; an entry recipe (ADR 0031) is left out: the runtime
      // counts its path as a start for generation through `entries` instead.
      return [
        ...loginRecipesForOrigin(cache.recipes, origin).map((recipe) => {
          // A later step a login may start at when no first step shows (ADR 0049).
          const later = laterStartSteps(recipe).map(({ step }) => step);
          return {
            path: recipe.steps[0]!.path,
            steps: recipeStartSteps(recipe),
            ...(later.length ? { later } : {}),
          };
        }),
        ...cache.recipes.flatMap((recipe) =>
          "chooser" in recipe && recipe.origin === origin
            ? [
                {
                  path: recipe.chooser.path,
                  steps:
                    recipe.chooser.afterOther?.steps
                      .slice(0, 1)
                      // Only a step that waits for an element: one that needs none would
                      // show on the list as well.
                      .filter(
                        (step) =>
                          step.path === recipe.chooser.path &&
                          loginReadiness(step).targets.length > 0,
                      ) ?? [],
                  list: [recipe.chooser.other, recipe.chooser.continue].filter(
                    (target) => target !== undefined,
                  ),
                },
              ]
            : [],
        ),
      ];
    },
    async later(origin: string, path: string) {
      const connection = await service.connection().catch(() => undefined);
      if (!connection) return [];
      const cache = await load(connection);
      if (!cache) return [];
      // A chooser's branches are never started in the middle: which one runs depends on the
      // click on its list, which the page alone does not tell (ADR 0049).
      return loginRecipesForOrigin(cache.recipes, origin).filter((recipe) =>
        laterStartSteps(recipe).some(({ step }) => step.path === path),
      );
    },
    async entries(origin: string) {
      const connection = await service.connection().catch(() => undefined);
      if (!connection) return [];
      const cache = await load(connection);
      if (!cache) return [];
      return cache.recipes.filter(
        (recipe): recipe is LoginEntryRecipe => "entry" in recipe && recipe.origin === origin,
      );
    },
  };

  return { sync, refreshIfStale, clear, recipes };
}
