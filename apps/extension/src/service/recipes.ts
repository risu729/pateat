import {
  chooserLayouts,
  deviceIdSchema,
  findChooserLayout,
  findLayoutRecipe,
  laterStartSteps,
  loginLayoutCandidates,
  loginRecipesForOrigin,
  MAX_RECIPE_CACHE_BYTES,
  newestLayout,
  recipeLayouts,
  recipeStartSteps,
  runsLogin,
  selectLoginRecipe,
  serviceOriginSchema,
  storedLoginRecipeSchema,
  type LayoutCandidate,
  type LoginChooserDocument,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginStep,
  type LoginTarget,
  type StoredLoginRecipe,
  type SyncRecipeChanges,
} from "@pateat/contracts";
import * as v from "valibot";
import type { LoginRecipes } from "../login/runtime";
import type { DeviceRecipeUpload } from "./device-recipes";
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
// An overflow walk writes removals and non-growing newer heads with the old cursor;
// skipped active changes remain pending until their entire page fits.
// Entry and chooser recipes (ADR 0031, ADR 0028) are cached with the rest; only a
// chooser is looked up and starts a login, on its list's path, and `entries` lists an
// origin's entry recipes. Version 2 holds recipes with layouts (ADR 0060): a version 1
// cache is ignored, so the device pulls every recipe again from the start.
// A change this build cannot read, as a recipe a newer service stored with a locator this
// build does not know, is left out and the cursor moves past it (#959); `unreadableBy` names
// the build that left one out, and any other build reads every head again from the start.
const cacheSchema = v.strictObject({
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
});
type RecipeCache = v.InferOutput<typeof cacheSchema>;

// Kept separately so even an exactly full recipe cache can checkpoint its lookahead.
// This is not an applied cursor: normal sync still reads every pending current head.
const recoverySchema = v.strictObject({
  version: v.literal(2),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  cursor: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  after: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
});
type RecipeRecovery = v.InferOutput<typeof recoverySchema>;

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
  readRecovery(): Promise<unknown>;
  writeRecovery(recovery: RecipeRecovery): Promise<void>;
  /** Clears both the cache and its recovery checkpoint. */
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
  /** A page does not fit; bounded lookahead saves removals and non-growing newer heads. */
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
  /** Changes left out because this build cannot read their recipe (#959). */
  unreadable?: number;
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
  /**
   * The recipes this device holds as its own (ADR 0040): logins use them while no service
   * is paired, and each full sync uploads them to the paired service.
   */
  device?: {
    list(): Promise<readonly StoredLoginRecipe[]>;
    upload(connection: ServiceConnection, stale: () => boolean): Promise<DeviceRecipeUpload>;
    forget(held: ReadonlySet<string>, stale: () => boolean): Promise<void>;
  };
  /** Receives the outcome of each sync run and what it changed, for the local log. */
  report?: (outcome: RecipeSyncOutcome, changes: RecipeSyncChanges) => void;
  /** The extension's build: its commit, or `development` for a build outside git. */
  build: string;
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
  // clear() waits behind pending writes, so a late durable write cannot survive it.
  let storageWrites: Promise<void> = Promise.resolve();
  function persist(action: () => Promise<void>, started: number): Promise<boolean> {
    const write = storageWrites.then(async () => {
      if (generation !== started) return false;
      await action();
      return generation === started;
    });
    storageWrites = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
  // The stored schedule, read once per worker; `plan` replaces it.
  let planned: Promise<{ startedAt: number; retryAt: number } | undefined> | undefined;

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

  /**
   * When the next background sync is due. A clock that moved backwards past the last
   * start makes it due now, checked on every call, also after a sync in this worker.
   */
  async function dueAt(): Promise<number> {
    planned ??= schedule.read().then(
      (stored) => {
        const parsed = v.safeParse(scheduleSchema, stored);
        return parsed.success ? parsed.output : undefined;
      },
      () => undefined,
    );
    const next = await planned;
    return next && next.startedAt <= now() ? next.retryAt : 0;
  }
  function plan(startedAt: number, delay: number) {
    planned = Promise.resolve({ startedAt, retryAt: startedAt + delay });
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
    // The recipes this device holds go up first, so the pull below brings them back
    // (owner, 2026-10-23 12:36 UTC).
    if (withSettings && options.device)
      await options.device.upload(connection, () => generation !== started).catch(() => undefined);
    const recipesOutcome = await pullRecipes(connection, started, changed);
    if (withSettings && options.device && generation === started) {
      const cache = await load(connection);
      if (cache)
        await options.device
          .forget(new Set(cache.recipes.map((recipe) => recipe.id)), () => generation !== started)
          .catch(() => undefined);
    }
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
    const loaded = await load(connection);
    let cache: RecipeCache = loaded ?? {
      version: 2,
      origin: connection.origin,
      deviceId: connection.deviceId,
      cursor: 0,
      recipes: [],
    };
    // Another build left out a change it could not read: this one reads every head again,
    // keeping the recipes held meanwhile, so the recipe arrives once the extension can read
    // it (#959).
    const reread = cache.unreadableBy !== undefined && cache.unreadableBy !== options.build;
    if (reread) {
      const { unreadableBy: _, ...rest } = cache;
      cache = { ...rest, cursor: 0 };
    }
    // Disconnected while loading the cache; the old credential is not used again.
    if (generation !== started) return "not-connected";
    let recovery: RecipeRecovery | undefined;
    if (reread) {
      // The checkpoint of the walk from the old cursor is replaced by one that skips
      // nothing, so the cursor arriving there again never resumes that walk; then the reset
      // is stored, so later runs keep the checkpoints of this walk from cursor 0.
      try {
        const neutral: RecipeRecovery = {
          version: 2,
          origin: cache.origin,
          deviceId: cache.deviceId,
          cursor: 0,
          after: 0,
        };
        if (!(await persist(() => storage.writeRecovery(neutral), started))) return "not-connected";
      } catch {
        return "storage-unavailable";
      }
      const failure = await writeCache(cache, { added: 0, updated: 0, removed: 0 });
      if (failure) return failure;
    } else if (loaded) {
      try {
        const parsed = v.safeParse(recoverySchema, await storage.readRecovery());
        if (
          parsed.success &&
          parsed.output.origin === cache.origin &&
          parsed.output.deviceId === cache.deviceId &&
          parsed.output.cursor === cache.cursor &&
          parsed.output.after >= cache.cursor
        )
          recovery = parsed.output;
      } catch {
        return "storage-unavailable";
      }
      if (generation !== started) return "not-connected";
    }
    async function readPage(
      cursor: number,
    ): Promise<(SyncRecipeChanges & { unreadable: number }) | RecipeSyncOutcome> {
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
      return { ...result.page, unreadable: result.unreadable?.length ?? 0 };
    }

    async function writeCache(
      next: RecipeCache,
      counts: { added: number; updated: number; removed: number },
    ): Promise<RecipeSyncOutcome | undefined> {
      if (generation !== started) return "not-connected";
      try {
        memory = undefined;
        if (!(await persist(() => storage.write(next), started))) return "not-connected";
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

    /** Apply only changes that cannot grow the last-known-good cache. */
    async function recoverPage(page: SyncRecipeChanges): Promise<RecipeSyncOutcome | undefined> {
      const remaining = new Map(cache.recipes.map((recipe) => [recipe.id, recipe]));
      const counts = { added: 0, updated: 0, removed: 0 };
      for (const change of page.changes) {
        const held = remaining.get(change.recipeId);
        if (!held || change.revision <= held.revision) continue;
        if (change.state === "revoked") {
          remaining.delete(change.recipeId);
          counts.removed += 1;
        } else if (
          encoder.encode(JSON.stringify(change.recipe)).byteLength <=
          encoder.encode(JSON.stringify(held)).byteLength
        ) {
          remaining.set(change.recipeId, change.recipe);
          counts.updated += 1;
        }
      }
      if (counts.removed > 0 || counts.updated > 0) {
        const failure = await writeCache({ ...cache, recipes: [...remaining.values()] }, counts);
        if (failure) return failure;
      }
      return undefined;
    }

    async function checkpoint(after: number): Promise<RecipeSyncOutcome | undefined> {
      if (generation !== started) return "not-connected";
      const next: RecipeRecovery = {
        version: 2,
        origin: cache.origin,
        deviceId: cache.deviceId,
        cursor: cache.cursor,
        after,
      };
      try {
        // The safe cache write precedes this; failure only repeats an idempotent scan.
        if (!(await persist(() => storage.writeRecovery(next), started))) return "not-connected";
      } catch {
        return "storage-unavailable";
      }
      if (generation !== started) return "not-connected";
      recovery = next;
      return undefined;
    }

    // Normal and recovery walks share the page budget. The stuck-page retry gets
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
        const held = recipes.get(change.recipeId);
        // A newer head saved by lookahead must never be replaced by an older response.
        if (held && change.revision <= held.revision) continue;
        if (change.state === "active") recipes.set(change.recipeId, change.recipe);
        else recipes.delete(change.recipeId);
      }
      // Counted against the page's starting cache, so a recipe changed twice counts once.
      const counts = { added: 0, updated: 0, removed: 0 };
      for (const id of new Set(changes.map((change) => change.recipeId))) {
        const [held, kept] = [before.has(id), recipes.has(id)];
        if (kept && before.get(id) !== recipes.get(id)) counts[held ? "updated" : "added"] += 1;
        else if (held && !kept) counts.removed += 1;
      }
      const next: RecipeCache = {
        ...cache,
        cursor,
        recipes: [...recipes.values()],
        ...(result.unreadable ? { unreadableBy: options.build } : {}),
      };
      if (encoder.encode(JSON.stringify(next)).byteLength > MAX_RECIPE_CACHE_BYTES) {
        if (walkedOverflow) {
          // The retry may include revocations made while the walk was running.
          // oxlint-disable-next-line no-await-in-loop -- keep fresh removals without another walk
          const failure = await recoverPage(result);
          if (failure) return failure;
          // oxlint-disable-next-line no-await-in-loop -- ends the loop after one retry
          await service.recordSync(connection.deviceId, { cacheFull: true });
          return "cache-full";
        }
        walkedOverflow = true;
        let scan = result;
        let after = Math.max(result.cursor, recovery?.after ?? cache.cursor);
        for (;;) {
          // Persist safe changes before checkpointing, even if a later request fails.
          // oxlint-disable-next-line no-await-in-loop -- preserve the old applied cursor
          const failure = await recoverPage(scan);
          if (failure) return failure;
          // oxlint-disable-next-line no-await-in-loop -- durable lookahead precedes the next read
          const saved = await checkpoint(after);
          if (saved) return saved;
          if (scan.complete || pagesRead >= MAX_RECIPE_PAGES_PER_SYNC) break;
          pagesRead += 1;
          // oxlint-disable-next-line no-await-in-loop -- only lookahead skips pending active pages
          const later = await readPage(after);
          if (typeof later === "string") return later;
          scan = later;
          after = scan.cursor;
        }
        // Refetch current heads: revocation or republication may have replaced the
        // blocked page's earlier active response while lookahead was running.
        retrying = true;
        continue;
      }
      retrying = false;
      // oxlint-disable-next-line no-await-in-loop -- advance the cursor only with a complete page
      const failure = await writeCache(next, counts);
      if (failure) return failure;
      if (result.unreadable) changed.unreadable = (changed.unreadable ?? 0) + result.unreadable;
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
    const cleared = storageWrites.then(async () => {
      try {
        await storage.clear();
      } catch {
        // A later disconnected run retries unavailable storage cleanup.
      }
      return undefined;
    });
    storageWrites = cleared;
    await Promise.all([cleared, options.settings?.clear()]);
  }

  /**
   * The recipes logins use: the paired device's cache, refreshed in the background when
   * `refresh` is set, or without a pairing those this device holds (ADR 0040). None when
   * the pairing or those recipes cannot be read.
   */
  async function current(
    refresh: boolean,
  ): Promise<{ recipes: readonly StoredLoginRecipe[] } | undefined> {
    let connection: ServiceConnection | undefined;
    try {
      connection = await service.connection();
    } catch {
      return undefined;
    }
    if (!connection) {
      const held = await options.device?.list().catch(() => undefined);
      return held ? { recipes: held } : undefined;
    }
    if (refresh && !connection.rejected) refreshIfStale();
    return load(connection);
  }
  type Held = { recipes: readonly StoredLoginRecipe[] };
  /**
   * The paired device's synced recipes, as a disconnect keeps them; none unpaired. It
   * first stops a running sync, so the device's own store forgets nothing that this copy
   * misses (ADR 0040), and rejects when the cache cannot be read.
   */
  async function synced(): Promise<readonly StoredLoginRecipe[] | undefined> {
    const connection = await service.connection();
    if (!connection) return undefined;
    generation += 1;
    if (!memory) {
      const stored = await storage.read();
      if (stored === undefined) return [];
      const parsed = v.safeParse(cacheSchema, stored);
      if (!parsed.success) throw new Error("The synced recipes cannot be read");
      memory ??= parsed.output;
    }
    return memory.origin === connection.origin && memory.deviceId === connection.deviceId
      ? memory.recipes
      : [];
  }
  const choosersOf = (cache: Held, origin: string) =>
    cache.recipes.filter(
      (recipe): recipe is LoginChooserDocument => "chooser" in recipe && recipe.origin === origin,
    );
  const documentOf = (cache: Held, origin: string, recipeId: string) =>
    loginRecipesForOrigin(cache.recipes, origin).find((recipe) => recipe.id === recipeId);
  /**
   * The chooser documents whose list shows on the path. The service keeps one generated
   * recipe per origin and start path; a path where several start, or where a login recipe
   * starts as well, starts none (ADR 0013).
   */
  function choosersOn(cache: Held, origin: string, path: string) {
    const here = choosersOf(cache, origin).filter((recipe) => recipe.chooser.path === path);
    return here.length === 1 &&
      !loginRecipesForOrigin(cache.recipes, origin).some(
        (recipe) => recipe.layouts[0]!.steps[0]!.path === path,
      )
      ? here[0]
      : undefined;
  }
  const chooserCandidates = (recipe: LoginChooserDocument) =>
    chooserLayouts(recipe).map((projected, index): LayoutCandidate<LoginChooserRecipe> => ({
      recipe: projected,
      ...(recipe.chooser.layouts[index]!.language
        ? { language: recipe.chooser.layouts[index]!.language }
        : {}),
      createdAt: recipe.chooser.layouts[index]!.createdAt,
    }));
  /** Steps and targets each once, in order. */
  const once = <T>(items: readonly T[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Each lookup projects one layout of a stored recipe to the recipe a login runs (ADR
  // 0060). Without a layout named, it is the newest one; a new login chooses among
  // `layouts` (or `choosers`) itself.
  const recipes: LoginRecipes = {
    async recipe(origin: string, path: string, recipeId?: string, layout?: string) {
      const cache = await current(true);
      if (!cache) return undefined;
      // A resumed attempt asks for its own recipe and layout; the executor checks its
      // revision.
      if (recipeId !== undefined) {
        const stored = documentOf(cache, origin, recipeId);
        if (!stored) return undefined;
        if (layout === undefined) return newestLayout(loginLayoutCandidates(stored))?.recipe;
        // A layout generated as `confirm` or `unclear` never runs (ADR 0035).
        const found = findLayoutRecipe(stored, layout);
        return found && runsLogin(found) ? found : undefined;
      }
      const selection = selectLoginRecipe(cache.recipes, origin, path);
      return selection.ok ? selection.recipe : undefined;
    },
    async layouts(origin: string, path: string) {
      const cache = await current(false);
      if (!cache) return [];
      const selection = selectLoginRecipe(cache.recipes, origin, path);
      return selection.ok ? selection.layouts : [];
    },
    async layoutsOf(origin: string, recipeId: string) {
      const cache = await current(false);
      if (!cache) return [];
      const stored = documentOf(cache, origin, recipeId);
      if (stored) return recipeLayouts(stored);
      // A chooser login's markers are its branches' (ADR 0028).
      const chooser = choosersOf(cache, origin).find((recipe) => recipe.id === recipeId);
      return (chooser ? chooserLayouts(chooser) : []).flatMap((projected) =>
        [projected.chooser.afterAccount, projected.chooser.afterOther].filter(
          (branch) => branch !== undefined,
        ),
      );
    },
    async chooser(origin: string, path: string, recipeId?: string, layout?: string) {
      const cache = await current(true);
      if (!cache) return undefined;
      const stored =
        recipeId !== undefined
          ? choosersOf(cache, origin).find((recipe) => recipe.id === recipeId)
          : choosersOn(cache, origin, path);
      if (!stored) return undefined;
      if (layout !== undefined) return findChooserLayout(stored, layout);
      return newestLayout(chooserCandidates(stored))?.recipe;
    },
    async choosers(origin: string, path: string) {
      const cache = await current(false);
      if (!cache) return [];
      const stored = choosersOn(cache, origin, path);
      return stored ? chooserCandidates(stored) : [];
    },
    async starts(origin: string) {
      const cache = await current(false);
      if (!cache) return [];
      // Every variant starts on the recipe's start path (ADR 0027), in every layout (ADR
      // 0060): a recipe is one start with every layout's first steps. A chooser recipe (ADR
      // 0028) starts where its list shows, once one of its buttons or a listed account
      // does, or its `other` branch's first step on that path, as when the person pressed
      // the button for another account; an entry recipe (ADR 0031) is left out: the runtime
      // counts its path as a start for generation through `entries` instead.
      return [
        ...loginRecipesForOrigin(cache.recipes, origin).map((stored) => {
          // A layout generated as `confirm` or `unclear` never starts (ADR 0035).
          const layouts = loginLayoutCandidates(stored).map((candidate) => candidate.recipe);
          // A later step a login may start at when no first step shows (ADR 0049).
          const later = once(
            layouts.flatMap((recipe) => laterStartSteps(recipe).map(({ step }) => step)),
          );
          return {
            path: stored.layouts[0]!.steps[0]!.path,
            steps: once(layouts.flatMap(recipeStartSteps)),
            ...(later.length ? { later } : {}),
          };
        }),
        ...choosersOf(cache, origin).map((stored) => {
          const layouts = chooserLayouts(stored);
          return {
            path: stored.chooser.path,
            steps: once(
              layouts.flatMap(
                (recipe): LoginStep[] =>
                  recipe.chooser.afterOther?.steps
                    .slice(0, 1)
                    // Only a step that waits for an element: one that needs none would
                    // show on the list as well.
                    .filter(
                      (step) =>
                        step.path === recipe.chooser.path &&
                        loginReadiness(step).targets.length > 0,
                    ) ?? [],
              ),
            ),
            list: once(
              layouts.flatMap((recipe): LoginTarget[] =>
                [recipe.chooser.other, recipe.chooser.continue].filter(
                  (target) => target !== undefined,
                ),
              ),
            ),
          };
        }),
      ];
    },
    async later(origin: string, path: string) {
      const cache = await current(false);
      if (!cache) return [];
      // A chooser's branches are never started in the middle: which one runs depends on the
      // click on its list, which the page alone does not tell (ADR 0049). Each layout with
      // such a step is a candidate; the runtime chooses among one recipe's (ADR 0060).
      return loginRecipesForOrigin(cache.recipes, origin)
        .flatMap((stored) => loginLayoutCandidates(stored).map((candidate) => candidate.recipe))
        .filter((recipe) => laterStartSteps(recipe).some(({ step }) => step.path === path));
    },
    async routes(origin: string) {
      const cache = await current(false);
      if (!cache) return [];
      // Every layout of each login recipe whatever its kind, and every chooser layout's
      // branches (ADR 0060).
      return cache.recipes.flatMap((recipe) =>
        recipe.origin !== origin
          ? []
          : "layouts" in recipe
            ? recipeLayouts(recipe)
            : "chooser" in recipe
              ? chooserLayouts(recipe).flatMap((projected) =>
                  [projected.chooser.afterAccount, projected.chooser.afterOther].filter(
                    (branch) => branch !== undefined,
                  ),
                )
              : [],
      );
    },
    async entries(origin: string) {
      const cache = await current(false);
      if (!cache) return [];
      return cache.recipes.filter(
        (recipe): recipe is LoginEntryRecipe => "entry" in recipe && recipe.origin === origin,
      );
    },
  };

  return { sync, refreshIfStale, clear, synced, recipes };
}
