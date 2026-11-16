import {
  entryBlockReasonSchema,
  syncEntryBlockSchema,
  syncRecipeIdSchema,
  type EntryBlockReason,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import * as v from "valibot";
import { isoTime, isoTimeSchema } from "../time";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// Entry recipe revisions whose press led nowhere (ADR 0031, amended 2026-11-16). The block is
// the owner's: a paired device reports it to the service, which keeps the first reason of
// each revision and hands it to every device with its recipe sync. This device keeps its own
// blocks as well, as a cache until the sync brings them and, without a pairing, as the only
// copy for its own recipes (ADR 0040), uploaded once those recipes are.

/** The `storage.local` key of this device's own blocks. */
export const ENTRY_BLOCKS_KEY = "pateat.login-entry-blocks.v1";
/** Blocks this device keeps; the oldest go first. */
export const MAX_ENTRY_BLOCKS = 100;

const revisionSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

/** A block the recipe sync brought, of a revision the synced cache holds. */
export const syncedEntryBlockSchema = v.strictObject({
  recipeId: syncRecipeIdSchema,
  revision: revisionSchema,
  ...syncEntryBlockSchema.entries,
});
export type SyncedEntryBlock = v.InferOutput<typeof syncedEntryBlockSchema>;

/**
 * A block this device made. `service` names the pairing it was made under; without one it
 * blocks a recipe this device holds as its own while no service is paired. `sent` once the
 * service took the report, or refused it for good.
 */
const ownBlockSchema = v.strictObject({
  recipeId: syncRecipeIdSchema,
  revision: revisionSchema,
  reason: entryBlockReasonSchema,
  blockedAt: isoTimeSchema,
  service: v.optional(v.strictObject({ origin: v.string(), deviceId: v.string() })),
  sent: v.optional(v.literal(true)),
});
type OwnBlock = v.InferOutput<typeof ownBlockSchema>;

export interface EntryBlockStorage {
  read(): Promise<unknown>;
  write(blocks: OwnBlock[]): Promise<void>;
}

/**
 * The synced cache's blocks after a page of changes is applied to `recipes`: a change that
 * carries a block blocks its revision, unless a block of that or a newer revision is held,
 * and only blocks of a revision the cache still holds stay. Undefined for none.
 */
export function syncedBlocksAfter(
  blocks: readonly SyncedEntryBlock[] | undefined,
  changes: readonly SyncRecipeChange[],
  recipes: ReadonlyMap<string, StoredLoginRecipe>,
): SyncedEntryBlock[] | undefined {
  const next = new Map((blocks ?? []).map((block) => [block.recipeId, block]));
  for (const change of changes) {
    if (change.state !== "active" || !change.entryBlock) continue;
    const held = next.get(change.recipeId);
    if (!held || held.revision < change.revision)
      next.set(change.recipeId, {
        recipeId: change.recipeId,
        revision: change.revision,
        ...change.entryBlock,
      });
  }
  const kept = [...next.values()].filter(
    (block) => recipes.get(block.recipeId)?.revision === block.revision,
  );
  return kept.length ? kept : undefined;
}

type Holder = { origin: string; deviceId: string } | undefined;
const heldBy = (block: OwnBlock, holder: Holder) =>
  holder
    ? block.service?.origin === holder.origin && block.service.deviceId === holder.deviceId
    : block.service === undefined;
const sameRevision = (block: { recipeId: string; revision: number }, recipe: Recipe) =>
  block.recipeId === recipe.id && block.revision === recipe.revision;
type Recipe = { id: string; revision: number };

export function createEntryBlocks(options: {
  storage: EntryBlockStorage;
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "reportEntryBlock">;
  /** The blocks the paired device's synced recipe cache holds. */
  synced: () => Promise<readonly SyncedEntryBlock[]>;
  now?: () => number;
}) {
  const { storage, service, transport } = options;
  const now = options.now ?? Date.now;
  // One read-modify-write at a time, so two blocks made together are both kept.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const pending = queue.then(task);
    queue = pending.catch(() => undefined);
    return pending;
  }
  /** The stored blocks; ones that do not parse count as none, as no older format is kept. */
  async function load(): Promise<OwnBlock[]> {
    const parsed = v.safeParse(v.array(ownBlockSchema), (await storage.read()) ?? []);
    return parsed.success ? parsed.output : [];
  }
  const save = (blocks: OwnBlock[]) => storage.write(blocks.slice(-MAX_ENTRY_BLOCKS));
  const holderOf = (connection: ServiceConnection | undefined): Holder =>
    connection && { origin: connection.origin, deviceId: connection.deviceId };

  /** Sends this pairing's blocks the service has not taken yet; a failure waits for the next run. */
  async function send(): Promise<void> {
    const connection = await service.connection().catch(() => undefined);
    if (!connection || connection.rejected) return;
    const holder = holderOf(connection);
    const pending = (await load()).filter((block) => heldBy(block, holder) && !block.sent);
    for (const block of pending) {
      let result: OutcomeResult | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, stopping at a failure
        result = await transport.reportEntryBlock(
          connection.origin,
          connection.credential,
          block.recipeId,
          { version: 1, revision: block.revision, reason: block.reason },
        );
      } catch {
        result = undefined;
      }
      if (result?.kind !== "kept" && result?.kind !== "refused") return;
      // oxlint-disable-next-line no-await-in-loop -- recorded before the next request
      await enqueue(async () => {
        const stored = await load();
        await save(
          stored.map((entry) =>
            heldBy(entry, holder) &&
            sameRevision(entry, { id: block.recipeId, revision: block.revision })
              ? { ...entry, sent: true as const }
              : entry,
          ),
        );
      });
    }
  }
  let sending: Promise<void> | undefined;
  /** Sends what is pending; a call while a run sends joins it. Never throws. */
  function flush(): Promise<void> {
    sending ??= send()
      .catch(() => undefined)
      .finally(() => {
        sending = undefined;
      });
    return sending;
  }

  return {
    /**
     * Whether the recipe revision is blocked for the recipes logins use now: by this
     * device's own block under the same pairing, or without one, or by the synced cache.
     * Rejects when the device's blocks or its pairing cannot be read.
     */
    async blocked(recipe: Recipe): Promise<boolean> {
      const connection = await service.connection();
      const holder = holderOf(connection);
      if ((await load()).some((block) => heldBy(block, holder) && sameRevision(block, recipe)))
        return true;
      return connection !== undefined
        ? (await options.synced()).some((block) => sameRevision(block, recipe))
        : false;
    },
    /**
     * Blocks the recipe revision for the recipes logins use now, and sends the block to a
     * paired service. Resolves to whether it was stored: false when the device's blocks or
     * its pairing could not be read or written, so the caller keeps it in memory.
     */
    block(recipe: Recipe, reason: EntryBlockReason): Promise<boolean> {
      return enqueue(async () => {
        const connection = await service.connection();
        const holder = holderOf(connection);
        const stored = await load();
        await save([
          // A block of another revision of the same recipe no longer applies, and one of a
          // pairing that ended never applies again.
          ...stored.filter(
            (block) =>
              (block.service === undefined || heldBy(block, holder)) &&
              !(heldBy(block, holder) && block.recipeId === recipe.id),
          ),
          {
            recipeId: recipe.id,
            revision: recipe.revision,
            reason,
            blockedAt: isoTime(now()),
            ...(holder ? { service: holder } : {}),
          },
        ]);
        return connection !== undefined;
      }).then(
        (paired) => {
          if (paired) void flush();
          return true;
        },
        () => false,
      );
    },
    flush,
    /**
     * A disconnect keeps the synced recipes as this device's own (ADR 0040): their synced
     * blocks, and this device's blocks under any pairing, become blocks of its own recipes.
     */
    keep(synced: readonly SyncedEntryBlock[]): Promise<void> {
      return enqueue(async () => {
        const stored = await load();
        const at = isoTime(now());
        const own = new Map<string, OwnBlock>();
        for (const entry of stored) if (entry.service === undefined) own.set(entry.recipeId, entry);
        for (const kept of [
          ...stored
            .filter((entry) => entry.service !== undefined)
            .map(({ service: _service, sent: _sent, ...rest }) => rest),
          ...synced.map((entry) => ({
            recipeId: entry.recipeId,
            revision: entry.revision,
            reason: entry.reason,
            blockedAt: at,
          })),
        ]) {
          const held = own.get(kept.recipeId);
          if (!held || held.revision < kept.revision) own.set(kept.recipeId, kept);
        }
        await save([...own.values()]);
      });
    },
    /**
     * A recipe this device held as its own was uploaded to the paired service as
     * `revision` (ADR 0040): its block now names that revision under the pairing, and is
     * sent with the next flush.
     */
    uploaded(recipe: Recipe, revision: number, connection: ServiceConnection): Promise<void> {
      return enqueue(async () => {
        const stored = await load();
        const holder = holderOf(connection);
        if (!stored.some((block) => heldBy(block, undefined) && sameRevision(block, recipe)))
          return;
        await save(
          stored.map((block) =>
            heldBy(block, undefined) && sameRevision(block, recipe)
              ? { ...block, revision, service: holder! }
              : block,
          ),
        );
      });
    },
  };
}
