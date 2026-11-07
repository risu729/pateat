import {
  customSlotIdSchema,
  loginRouteSchema,
  recipeBranchSchema,
  PAGE_SAMPLE_INTERVAL_MS,
  recipeLayoutKeySchema,
  syncRecipeIdSchema,
  vaultFieldReferenceSchema,
  type LoginRoute,
  type RecipeGenerationRequest,
} from "@pateat/contracts";
import * as v from "valibot";

import type { ServiceConnection } from "./runtime";

/**
 * A page whose request reached the model is not sent again for this long, whatever came of
 * it: the service's retry window (ADR 0016, owner 2026-10-12).
 */
export const GENERATION_RETRY_MS = 10 * 60 * 1000;
/**
 * How long a page stays claimed while its request is in flight: longer than the
 * transport's 90-second inference timeout, so a claim whose request was lost with a
 * stopped or reloaded worker frees the page soon after (ADR 0016).
 */
export const GENERATION_SENDING_MS = 2 * 60 * 1000;
/** Pages remembered at once; the oldest go first. */
export const MAX_GENERATION_ATTEMPTS = 500;
/** The recipe revision a page continues after its final `advance` step (ADR 0018). */
export type GenerationBase = NonNullable<RecipeGenerationRequest["base"]>;
/** The recipe revision a stale start page repairs (ADR 0041). */
export type GenerationRepair = NonNullable<RecipeGenerationRequest["repair"]>;
/**
 * Each origin and path claimed for generation: `sending` while its request is in flight,
 * `sent` once an answer showed the request reached the model (ADR 0016). A page that
 * continues a recipe is claimed under that recipe revision, not under its path alone
 * (ADR 0018), as the service's own rule does.
 */
const attemptsSchema = v.strictObject({
  version: v.literal(1),
  attempts: v.pipe(
    v.array(
      v.strictObject({
        origin: v.pipe(v.string(), v.maxLength(2048)),
        path: v.pipe(v.string(), v.maxLength(2048)),
        state: v.picklist(["sending", "sent"]),
        base: v.optional(
          v.strictObject({
            recipeId: syncRecipeIdSchema,
            revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
            /** The page replaces the recipe's final advance click (ADR 0018). */
            replacesLast: v.optional(v.literal(true)),
          }),
        ),
        /**
         * The layout it continues (ADR 0060), and for a chooser's page (ADR 0028) the branch,
         * as `recipeBranch` names them.
         */
        branch: v.optional(recipeBranchSchema),
        /**
         * For a stale recipe's page (ADR 0041): the revision it repairs, so the
         * claim of the page's first generation does not hold its repair.
         */
        repair: v.optional(
          v.strictObject({
            recipeId: syncRecipeIdSchema,
            revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
            /** For a later step's page: the layout and the step that did not show. */
            layout: v.optional(recipeLayoutKeySchema),
            step: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
          }),
        ),
        at: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
    v.maxLength(MAX_GENERATION_ATTEMPTS),
  ),
});
type GenerationAttempts = v.InferOutput<typeof attemptsSchema>;

export interface GenerationAttemptStorage {
  read(): Promise<unknown>;
  write(attempts: GenerationAttempts): Promise<void>;
}

/** Generated recipes whose custom-field slots this device remembers; the oldest go first. */
export const MAX_GENERATED_SLOT_MAPS = 200;
/**
 * Which vault field each custom slot of a recipe generated from this device names, from
 * the request that produced it (ADR 0027). It is kept per service and device, since a
 * generated recipe's ID depends only on its origin and start path, so a device paired
 * again or with another service never reuses an old map.
 */
const slotMapsSchema = v.strictObject({
  version: v.literal(1),
  maps: v.pipe(
    v.array(
      v.strictObject({
        service: v.pipe(v.string(), v.maxLength(2048)),
        deviceId: v.pipe(v.string(), v.maxLength(200)),
        recipeId: syncRecipeIdSchema,
        slots: v.pipe(
          v.array(v.strictObject({ slot: customSlotIdSchema, field: vaultFieldReferenceSchema })),
          v.minLength(1),
          v.maxLength(20),
        ),
      }),
    ),
    v.maxLength(MAX_GENERATED_SLOT_MAPS),
  ),
});
export type GeneratedSlotMaps = v.InferOutput<typeof slotMapsSchema>;

export interface GeneratedSlotStorage {
  read(): Promise<unknown>;
  write(maps: GeneratedSlotMaps): Promise<void>;
}

/** Signed-in page samples remembered at once; the oldest go first. */
export const MAX_PAGE_SAMPLES = 200;
/**
 * When this device last sent a repeat login's signed-in page of a recipe and branch (ADR
 * 0029, owner 2026-10-18 08:05 UTC), per service and device as the slot maps are. A sample
 * is recorded before it is sent, so a request lost with its worker is not sent again
 * within `PAGE_SAMPLE_INTERVAL_MS` either.
 */
const samplesSchema = v.strictObject({
  version: v.literal(1),
  samples: v.pipe(
    v.array(
      v.strictObject({
        service: v.pipe(v.string(), v.maxLength(2048)),
        deviceId: v.pipe(v.string(), v.maxLength(200)),
        recipeId: syncRecipeIdSchema,
        branch: v.optional(recipeBranchSchema),
        at: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
    v.maxLength(MAX_PAGE_SAMPLES),
  ),
});
type PageSamples = v.InferOutput<typeof samplesSchema>;

export interface PageSampleStorage {
  read(): Promise<unknown>;
  write(samples: PageSamples): Promise<void>;
}

/**
 * A recipe whose repair this device sent because the chosen item could not run it (ADR 0058
 * A, amended by ADR 0041) is not sent again by it for the same missing route for this long:
 * the bound on a repair that still leaves the item without a route (owner, 2026-10-23
 * 12:54 UTC: 3 days).
 */
export const RECIPE_REPLACE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
/** Revoked recipes remembered at once; the oldest go first. */
export const MAX_RECIPE_REPLACEMENTS = 200;
/**
 * When this device last sent each such recipe's repair (ADR 0058 A, amended by ADR 0041),
 * per service and device as the slot maps are, by recipe ID and the route the item lacked
 * (owner, 2026-10-23 12:53 UTC), so a recipe has at most one claim per route. Recorded
 * before the request leaves, so a request lost with its worker is not sent again within
 * `RECIPE_REPLACE_INTERVAL_MS` either.
 */
const replacementsSchema = v.strictObject({
  version: v.literal(1),
  replacements: v.pipe(
    v.array(
      v.strictObject({
        service: v.pipe(v.string(), v.maxLength(2048)),
        deviceId: v.pipe(v.string(), v.maxLength(200)),
        recipeId: syncRecipeIdSchema,
        route: loginRouteSchema,
        at: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
    v.maxLength(MAX_RECIPE_REPLACEMENTS),
  ),
});
type RecipeReplacements = v.InferOutput<typeof replacementsSchema>;

export interface RecipeReplacementStorage {
  read(): Promise<unknown>;
  write(replacements: RecipeReplacements): Promise<void>;
}

/** Local generation records and the original serialized mutation queues. */
export function createGenerationStorage({
  storage,
  slotStorage,
  sampleStorage,
  now,
}: {
  storage: GenerationAttemptStorage;
  slotStorage: GeneratedSlotStorage;
  sampleStorage?: PageSampleStorage;
  now: () => number;
}) {
  // Writes are serialized so two pages sent together are both remembered.
  let queue: Promise<unknown> = Promise.resolve();
  // Every binding check reads the slot maps, so they are kept in memory after one read. A
  // read that fails is not kept, so the next call reads storage again; stored maps that do
  // not parse count as none, since no older format is kept (ADR 0027).
  let slotMaps: Promise<GeneratedSlotMaps["maps"] | undefined> | undefined;
  let slotQueue: Promise<unknown> = Promise.resolve();
  let sampleQueue: Promise<unknown> = Promise.resolve();
  let replaceQueue: Promise<unknown> = Promise.resolve();

  function readSlotMaps(): Promise<GeneratedSlotMaps["maps"] | undefined> {
    if (slotMaps) return slotMaps;
    const read: Promise<GeneratedSlotMaps["maps"] | undefined> = slotStorage.read().then(
      (stored) => {
        const parsed = v.safeParse(slotMapsSchema, stored);
        return parsed.success ? parsed.output.maps : [];
      },
      () => {
        if (slotMaps === read) slotMaps = undefined;
        return undefined;
      },
    );
    slotMaps = read;
    return read;
  }
  /**
   * Stores one recipe's slot map. A continuation's map is added to the map of the recipe
   * it continues; a new recipe replaces any map under its ID. Nothing is written when the
   * stored maps could not be read, so other recipes' maps are never dropped, and nothing
   * is kept in memory that was not written.
   */
  function rememberSlots(
    entry: GeneratedSlotMaps["maps"][number],
    /** The continued recipe's slots, when the answer continues a recipe. */
    continued: readonly string[] | undefined,
  ): Promise<boolean> {
    const next = slotQueue.then(async () => {
      const current = await readSlotMaps();
      if (!current) return false;
      // Slots the continued recipe still has and this answer does not name again.
      const kept = continued
        ? (current
            .find(
              (map) =>
                map.service === entry.service &&
                map.deviceId === entry.deviceId &&
                map.recipeId === entry.recipeId,
            )
            ?.slots.filter(
              ({ slot }) =>
                continued.includes(slot) && !entry.slots.some((added) => added.slot === slot),
            ) ?? [])
        : [];
      const merged = { ...entry, slots: [...kept, ...entry.slots] };
      const maps = [...current.filter((map) => map.recipeId !== entry.recipeId), merged].slice(
        -MAX_GENERATED_SLOT_MAPS,
      );
      try {
        await slotStorage.write({ version: 1, maps });
      } catch (error) {
        slotMaps = undefined;
        throw error;
      }
      slotMaps = Promise.resolve(maps);
      return true;
    });
    slotQueue = next.catch(() => undefined);
    return next.catch(() => false);
  }

  /** The claims still in force; stored claims that do not parse count as none. */
  async function recent(): Promise<GenerationAttempts["attempts"]> {
    const parsed = v.safeParse(attemptsSchema, await storage.read());
    const at = now();
    return parsed.success
      ? parsed.output.attempts.filter(
          (entry) =>
            entry.at > at - (entry.state === "sent" ? GENERATION_RETRY_MS : GENERATION_SENDING_MS),
        )
      : [];
  }
  /**
   * Applies one change to the remembered attempts; fails closed when it cannot read or
   * write, so a failed read never drops the other pages' claims.
   */
  function remember(
    change: (attempts: GenerationAttempts["attempts"]) => GenerationAttempts["attempts"],
  ): Promise<boolean> {
    const next = queue.then(async () => {
      const attempts = change(await recent()).slice(-MAX_GENERATION_ATTEMPTS);
      await storage.write({ version: 1, attempts });
      return true;
    });
    queue = next.catch(() => undefined);
    return next.catch(() => false);
  }
  const same =
    (
      origin: string,
      path: string,
      base?: GenerationBase,
      branch?: string,
      repair?: GenerationRepair,
    ) =>
    (entry: GenerationAttempts["attempts"][number]) =>
      entry.origin === origin &&
      entry.path === path &&
      entry.base?.recipeId === base?.recipeId &&
      entry.base?.revision === base?.revision &&
      entry.base?.replacesLast === base?.replacesLast &&
      entry.branch === branch &&
      entry.repair?.recipeId === repair?.recipeId &&
      entry.repair?.revision === repair?.revision &&
      entry.repair?.layout === repair?.layout &&
      entry.repair?.step === repair?.step;

  /** This device's samples of the last `PAGE_SAMPLE_INTERVAL_MS`; unreadable ones count as none. */
  async function recentSamples(): Promise<PageSamples["samples"]> {
    const parsed = v.safeParse(samplesSchema, await sampleStorage!.read());
    const at = now();
    return parsed.success
      ? parsed.output.samples.filter((entry) => entry.at > at - PAGE_SAMPLE_INTERVAL_MS)
      : [];
  }
  const sameSample =
    (connection: ServiceConnection, recipeId: string, branch: string | undefined) =>
    (entry: PageSamples["samples"][number]) =>
      entry.service === connection.origin &&
      entry.deviceId === connection.deviceId &&
      entry.recipeId === recipeId &&
      entry.branch === branch;
  /**
   * Records a sample of the recipe and branch now, unless one is recorded within the
   * interval: `claimed` once it is written, `recent` for one already there, `unavailable`
   * when storage cannot be read or written, so a sample is never sent unrecorded.
   */
  function claimSample(
    connection: ServiceConnection,
    recipeId: string,
    branch: string | undefined,
  ): Promise<"claimed" | "recent" | "unavailable"> {
    const next = sampleQueue.then(async () => {
      const samples = await recentSamples();
      if (samples.some(sameSample(connection, recipeId, branch))) return "recent" as const;
      await sampleStorage!.write({
        version: 1,
        samples: [
          ...samples,
          {
            service: connection.origin,
            deviceId: connection.deviceId,
            recipeId,
            ...(branch ? { branch } : {}),
            at: now(),
          },
        ].slice(-MAX_PAGE_SAMPLES),
      });
      return "claimed" as const;
    });
    sampleQueue = next.catch(() => undefined);
    return next.catch(() => "unavailable" as const);
  }

  /**
   * Records a repair of the recipe now, unless one is recorded within the interval:
   * `claimed` with the time once it is written, `recent` for one already there,
   * `unavailable` when storage cannot be read or written, so a repair is never sent
   * unrecorded. Stored entries that do not parse count as none.
   */
  function claimReplace(
    store: RecipeReplacementStorage,
    connection: ServiceConnection,
    recipeId: string,
    route: LoginRoute,
  ): Promise<{ claimed: number } | "recent" | "unavailable"> {
    const next = replaceQueue.then(async () => {
      const parsed = v.safeParse(replacementsSchema, await store.read());
      const at = now();
      const replacements = parsed.success
        ? parsed.output.replacements.filter((entry) => entry.at > at - RECIPE_REPLACE_INTERVAL_MS)
        : [];
      if (
        replacements.some(
          (entry) =>
            entry.service === connection.origin &&
            entry.deviceId === connection.deviceId &&
            entry.recipeId === recipeId &&
            entry.route === route,
        )
      )
        return "recent" as const;
      await store.write({
        version: 1,
        replacements: [
          ...replacements,
          { service: connection.origin, deviceId: connection.deviceId, recipeId, route, at },
        ].slice(-MAX_RECIPE_REPLACEMENTS),
      });
      return { claimed: at };
    });
    replaceQueue = next.catch(() => undefined);
    return next.catch(() => "unavailable" as const);
  }
  /**
   * Drops this request's own claim, for a request that did not reach the service or that it
   * refused before writing: the next visit may send it again.
   */
  function releaseReplace(
    store: RecipeReplacementStorage,
    connection: ServiceConnection,
    recipeId: string,
    route: LoginRoute,
    claimedAt: number,
  ): Promise<unknown> {
    const next = replaceQueue.then(async () => {
      const parsed = v.safeParse(replacementsSchema, await store.read());
      if (!parsed.success) return false;
      await store.write({
        version: 1,
        replacements: parsed.output.replacements.filter(
          (entry) =>
            entry.service !== connection.origin ||
            entry.deviceId !== connection.deviceId ||
            entry.recipeId !== recipeId ||
            entry.route !== route ||
            entry.at !== claimedAt,
        ),
      });
      return true;
    });
    replaceQueue = next.catch(() => undefined);
    return next.catch(() => undefined);
  }

  return {
    readSlotMaps,
    rememberSlots,
    recent,
    remember,
    same,
    claimSample,
    claimReplace,
    releaseReplace,
    recentSamples,
    sameSample,
    // Read each current queue at the caller's fence, rather than its initial promise.
    pendingAttempts: () => queue,
    pendingSlots: () => slotQueue,
    pendingSamples: () => sampleQueue,
  };
}
