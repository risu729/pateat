import {
  MAX_RECIPE_CACHE_BYTES,
  type StoredLoginRecipe,
  type SyncRecipeChanges,
} from "@pateat/contracts";
import * as v from "valibot";
import type { DeviceRecipeUpload } from "./device-recipes";
import { createRecipeLookups } from "./recipe-lookups";
import { syncedBlocksAfter, type SyncedEntryBlock } from "./entry-blocks";
import {
  cacheSchema,
  recoverySchema,
  scheduleSchema,
  type RecipeCache,
  type RecipeCacheStorage,
  type RecipeRecovery,
  type RecipeScheduleStorage,
} from "./recipe-cache";
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
/**
 * How long a check whether a recipe was withdrawn waits for a sync that is running or a
 * lookup just started: the lookup answered from the cache that sync may be changing.
 */
export const RECIPE_SYNC_WAIT_MS = 5 * 1000;
/** After the service asks Pateat to slow down, background syncs wait this long. */
export const RECIPE_SYNC_RATE_LIMIT_MS = 15 * 60 * 1000;
/** Pages read in one sync; a larger backlog continues on the next one. */
export const MAX_RECIPE_PAGES_PER_SYNC = 50;
/**
 * The serialized cache stays well inside the 10 MB `storage.local` quota it shares with
 * settings, login attempts and other extension state; the vault cache is in IndexedDB.
 */
export { MAX_RECIPE_CACHE_BYTES } from "@pateat/contracts";

export type { RecipeCacheStorage, RecipeScheduleStorage } from "./recipe-cache";

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
    fence?(): () => boolean;
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
    fence?(): () => boolean;
    upload(connection: ServiceConnection, stale: () => boolean): Promise<DeviceRecipeUpload>;
    forget(held: ReadonlySet<string>, stale: () => boolean): Promise<void>;
  };
  /**
   * Called once the first settings sync since pairing is recorded, which lets this device
   * use its vault items (ADR 0023); the merge itself may have changed nothing.
   */
  settingsSynced?: () => void;
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
  let mutation = 0;
  let writing = 0;
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
    // The first completed settings sync since pairing lets this device use its vaults.
    if (settingsOutcome === "synced" && !connection.settingsSynced) {
      await service.recordSync(connection.deviceId, { settingsSynced: true });
      options.settingsSynced?.();
    }
    if (settingsOutcome === "rejected") {
      await service.recordSync(connection.deviceId, { rejected: true });
      return "rejected";
    }
    if (settingsOutcome === "settings-limit")
      await service.recordSync(connection.deviceId, { settingsLimited: true });
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
      mutation += 1;
      writing += 1;
      try {
        memory = undefined;
        if (!(await persist(() => storage.write(next), started))) return "not-connected";
      } catch {
        return "storage-unavailable";
      } finally {
        writing -= 1;
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
      const { entryBlocks: _, ...rest } = cache;
      const withBlocks = (blocks: SyncedEntryBlock[] | undefined): RecipeCache => ({
        ...rest,
        recipes: [...remaining.values()],
        ...(blocks ? { entryBlocks: blocks } : {}),
      });
      // The full cache takes the page's new blocks one at a time while they fit. One that
      // does not is left to the normal walk, which brings it with the page at the cursor
      // once revocations made room; the sync ends `cache-full` meanwhile. Evicting a
      // recipe instead would have its page generated again, and that upload would end
      // the block (ADR 0031).
      const standing = syncedBlocksAfter(cache.entryBlocks, [], remaining) ?? [];
      let blocks: SyncedEntryBlock[] | undefined = [...standing];
      let bytes = encoder.encode(
        JSON.stringify(withBlocks(standing.length ? standing : undefined)),
      ).byteLength;
      for (const block of syncedBlocksAfter(cache.entryBlocks, page.changes, remaining) ?? []) {
        if (standing.some((entry) => entry.recipeId === block.recipeId)) continue;
        // `,"entryBlocks":[block]` for the first block, else `,block`.
        const added = blocks.length
          ? encoder.encode(JSON.stringify(block)).byteLength + 1
          : encoder.encode(JSON.stringify({ entryBlocks: [block] })).byteLength - 1;
        if (bytes + added > MAX_RECIPE_CACHE_BYTES) continue;
        blocks.push(block);
        bytes += added;
      }
      if (!blocks.length) blocks = undefined;
      // A page that only blocks a revision the cache holds is written too (ADR 0031).
      if (
        counts.removed > 0 ||
        counts.updated > 0 ||
        JSON.stringify(blocks ?? []) !== JSON.stringify(cache.entryBlocks ?? [])
      ) {
        const failure = await writeCache(withBlocks(blocks), counts);
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
      // A change of a revision held here may still bring its block.
      const { entryBlocks: _, ...rest } = cache;
      const blocks = syncedBlocksAfter(cache.entryBlocks, changes, recipes);
      const next: RecipeCache = {
        ...rest,
        cursor,
        recipes: [...recipes.values()],
        ...(blocks ? { entryBlocks: blocks } : {}),
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

  // The sync a lookup's `refreshIfStale` is deciding on, until it is known whether one runs.
  let refreshing: Promise<unknown> | undefined;
  /** Starts a background sync when the last attempt, even in an earlier worker, is old. */
  function refreshIfStale() {
    // A check still deciding is kept, so a wait on it never misses the sync it starts.
    if (running || refreshing) return;
    const check = dueAt().then((at) => (!running && now() >= at ? sync() : undefined));
    refreshing = check;
    void check.finally(() => {
      if (refreshing === check) refreshing = undefined;
    });
  }
  /** Waits, at most `RECIPE_SYNC_WAIT_MS`, for the sync running or being started now. */
  async function settled() {
    const pending = running ?? refreshing;
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending.catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, RECIPE_SYNC_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Forgets the cache when its device is disconnected; a new pairing starts empty anyway. */
  async function clear() {
    mutation += 1;
    writing += 1;
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
    try {
      await Promise.all([cleared, options.settings?.clear()]);
    } finally {
      writing -= 1;
    }
  }

  /**
   * The recipes logins use: the paired device's cache, refreshed in the background when
   * `refresh` is set, or without a pairing those this device holds (ADR 0040). None when
   * the pairing or those recipes cannot be read.
   */
  async function current(
    refresh: boolean,
  ): Promise<{ recipes: readonly StoredLoginRecipe[]; local?: true } | undefined> {
    let connection: ServiceConnection | undefined;
    try {
      connection = await service.connection();
    } catch {
      return undefined;
    }
    if (!connection) {
      const held = await options.device?.list().catch(() => undefined);
      return held ? { recipes: held, local: true } : undefined;
    }
    if (refresh && !connection.rejected) refreshIfStale();
    return load(connection);
  }
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
  /**
   * The synced blocks `synced` read with its recipes, which a disconnect keeps too: none
   * when the cache is another pairing's, as for `synced`.
   */
  async function syncedBlocks(): Promise<readonly SyncedEntryBlock[]> {
    const connection = await service.connection();
    return connection &&
      memory?.origin === connection.origin &&
      memory.deviceId === connection.deviceId
      ? (memory.entryBlocks ?? [])
      : [];
  }
  /** The blocks the service sent of entry recipe revisions the paired cache holds (ADR 0031). */
  async function entryBlocks(): Promise<readonly SyncedEntryBlock[]> {
    const connection = await service.connection();
    return (connection && (await load(connection))?.entryBlocks) ?? [];
  }
  const recipes = createRecipeLookups({
    current,
    async paired() {
      const connection = await service.connection().catch(() => undefined);
      return connection && load(connection);
    },
    settled,
    epoch: () => ({ mutation, writing }),
    serviceFence: () => service.fence?.(),
    deviceFence: () => options.device?.fence?.(),
  });

  /** The recipes logins use now, as an export holds them (ADR 0040); none when unreadable. */
  async function inUse(): Promise<readonly StoredLoginRecipe[] | undefined> {
    return (await current(false))?.recipes;
  }

  return { sync, refreshIfStale, clear, synced, syncedBlocks, entryBlocks, inUse, recipes };
}
