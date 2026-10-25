import {
  MAX_ACTIVE_RECIPE_BYTES,
  runsLogin,
  storedLayouts,
  syncRecipeChangeSchema,
  type ChooserBranch,
  type ManageLayoutSource,
  type StoredLoginRecipe,
  type SyncRecipeChange,
  type SyncRecipeWrite,
} from "@pateat/contracts";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as v from "valibot";
import {
  owners,
  recipeHeads,
  recipeLayoutUses,
  recipeRevisions,
  recipeUnitSources,
} from "./db/schema";
import {
  documentUnits,
  LIST_UNIT,
  namedUnits,
  pageUnit,
  type RecipeUnit,
  type UnitSources,
} from "@pateat/generation";
import {
  KEPT_RECIPE_REVISIONS,
  MAX_ACTIVE_RECIPES,
  MAX_IDLE_REVOCATIONS,
  RECIPE_IDLE_LIMIT_MS,
} from "./limits";
import { newId } from "@pateat/contracts/ids";

type HeadRow = {
  recipeId: string;
  revision: number;
  state: "active" | "revoked";
  sequence: number;
  updatedAt: number;
  document: unknown;
};

/** Every head read is owner-scoped here; callers can only narrow it further. */
export function selectHeads(db: D1Database, ownerId: string, ...conditions: SQL[]) {
  return drizzle(db)
    .select({
      recipeId: recipeHeads.recipeId,
      revision: recipeHeads.revision,
      state: recipeHeads.state,
      sequence: recipeHeads.sequence,
      updatedAt: recipeHeads.updatedAt,
      document: recipeRevisions.document,
    })
    .from(recipeHeads)
    .innerJoin(
      recipeRevisions,
      and(
        eq(recipeRevisions.ownerId, recipeHeads.ownerId),
        eq(recipeRevisions.recipeId, recipeHeads.recipeId),
        eq(recipeRevisions.revision, recipeHeads.revision),
      ),
    )
    .where(and(eq(recipeHeads.ownerId, ownerId), ...conditions))
    .$dynamic();
}

/**
 * Stored rows are revalidated. An active head whose document no longer validates is
 * read as revoked, so devices drop it and sync moves past it, and is `unreadable` so the
 * web UI can list it for revocation. A head whose ID or revision is invalid fails closed
 * as an internal error.
 */
export function readChange(row: Omit<HeadRow, "sequence" | "updatedAt">): {
  change: SyncRecipeChange;
  unreadable: boolean;
} {
  const tombstone = { recipeId: row.recipeId, revision: row.revision, state: "revoked" as const };
  if (row.state === "active") {
    const active = v.safeParse(syncRecipeChangeSchema, {
      ...tombstone,
      state: row.state,
      recipe: row.document,
    });
    if (active.success) return { change: active.output, unreadable: false };
  }
  const change = v.parse(syncRecipeChangeSchema, tombstone);
  if (row.state === "active") console.error("Stored recipe document no longer validates");
  return { change, unreadable: row.state === "active" };
}

export function toChange(row: Omit<HeadRow, "sequence" | "updatedAt">): SyncRecipeChange {
  return readChange(row).change;
}

export async function readHead(db: D1Database, ownerId: string, recipeId: string) {
  const [row] = await selectHeads(db, ownerId, eq(recipeHeads.recipeId, recipeId));
  return row ? toChange(row) : null;
}

/**
 * One kept revision of the owner's recipe, read as a sync change is: `null` when the
 * revision is not kept, is a tombstone or no longer validates.
 */
export async function readRevision(
  db: D1Database,
  ownerId: string,
  recipeId: string,
  revision: number,
) {
  const [row] = await drizzle(db)
    .select({
      recipeId: recipeRevisions.recipeId,
      revision: recipeRevisions.revision,
      state: recipeRevisions.state,
      document: recipeRevisions.document,
    })
    .from(recipeRevisions)
    .where(
      and(
        eq(recipeRevisions.ownerId, ownerId),
        eq(recipeRevisions.recipeId, recipeId),
        eq(recipeRevisions.revision, revision),
      ),
    );
  if (row?.state !== "active") return null;
  const { change } = readChange(row);
  return change.state === "active" ? change : null;
}

/** The owner's active recipe count, inside a statement so a batch checks it atomically. */
export function activeRecipes(ownerId: string) {
  return sql<number>`(SELECT COUNT(*) FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId} AND ${recipeHeads.state} = 'active')`;
}

/** UTF-8 bytes of active head documents only; old revisions and tombstones do not count. */
export function activeRecipeBytes(ownerId: string, excluding?: string) {
  // Explicit aliases keep these columns qualified when Drizzle embeds the expression in a select.
  return sql<number>`(SELECT COALESCE(SUM(length(CAST(r.document AS BLOB))), 0)
    FROM ${recipeHeads} AS h INNER JOIN ${recipeRevisions} AS r
      ON r.owner_id = h.owner_id AND r.recipe_id = h.recipe_id AND r.revision = h.revision
    WHERE h.owner_id = ${ownerId} AND h.state = 'active'
      ${excluding === undefined ? sql`` : sql`AND h.recipe_id != ${excluding}`})`;
}

/** Preflight only; the write's claim checks the same capacity atomically. */
export async function hasRecipeByteRoom(db: D1Database, ownerId: string, bytes: number) {
  const [row] = await drizzle(db)
    .select({ bytes: activeRecipeBytes(ownerId) })
    .from(owners)
    .where(eq(owners.id, ownerId));
  return (row?.bytes ?? 0) + bytes <= MAX_ACTIVE_RECIPE_BYTES;
}

/** Whether the owner may hold one more active recipe. */
export async function hasRecipeRoom(db: D1Database, ownerId: string): Promise<boolean> {
  const [row] = await drizzle(db)
    .select({ count: activeRecipes(ownerId) })
    .from(owners)
    .where(eq(owners.id, ownerId));
  return (row?.count ?? 0) < MAX_ACTIVE_RECIPES;
}

/**
 * Writes the next revision of one recipe when `expectedRevision` is still its head.
 * `writer` is the device the write is for: the one that wrote it (`PUT /v1/recipes/:id`) or
 * whose request generated or judged it. It is null for a write no device asked for, by the
 * owner web UI or the service's own checks, such as the idle check (ADR 0058). A stale
 * writer changes nothing and gets the current head back (null when the recipe never
 * existed). Every winning write marks the recipe used (`lastUsedAt`, ADR 0058); with
 * `unusedBefore`, the write wins only while the head was last used before that time, so a
 * recipe used after an idle check is not revoked by it; with `idleLayouts`, only while
 * none of those layouts was used since `before`, so a layout used after the check is not
 * removed by it.
 * A write that would make the owner hold more than `MAX_ACTIVE_RECIPES` active recipes
 * or exceed `MAX_ACTIVE_RECIPE_BYTES` by creating or growing one
 * changes nothing and is `limited`. A winning write deletes revisions older than the
 * newest `KEPT_RECIPE_REVISIONS`, or every older one when it revokes the recipe, and the
 * last use of each layout (ADR 0060) the written document no longer has. With `used:
 * false`, as when the owner or the idle check removes a layout, the write does not mark
 * the recipe used.
 * The same batch keeps `recipe_unit_sources` (ADR 0060): it deletes the rows of layouts the
 * document no longer has and every row of a revoked recipe, and with a call's `sources`
 * writes a row for each unit named there, replacing that unit's earlier row. A `device`
 * write keeps the rows of units whose digest it left unchanged, deletes the rows of units
 * its document no longer has, and writes a `device` row for each unit it changed or
 * added. `writer` is each row's device.
 */
export async function writeRecipe(
  db: D1Database,
  ownerId: string,
  recipeId: string,
  write: SyncRecipeWrite,
  writer: string | null,
  options: {
    unusedBefore?: number;
    used?: boolean;
    /** The layouts the write removes as idle, which must still be unused since `before`. */
    idleLayouts?: { keys: readonly string[]; before: number };
    sources?: UnitSources;
    /**
     * Rows a layout the write adds takes over from another one, as the pages a later step's
     * repair copies from the stale layout (ADR 0041): copied before `from` may be dropped.
     * With `branch`, each unit is copied under that chooser branch's prefix (ADR 0079).
     */
    copied?: { from: string; to: string; units: readonly string[]; branch?: ChooserBranch };
  } = {},
): Promise<
  | { ok: true; change: SyncRecipeChange }
  | { ok: false; limited: false; current: SyncRecipeChange | null }
  | { ok: false; limited: true }
> {
  const orm = drizzle(db);
  const now = Date.now();
  const writeId = newId();
  const revision = write.expectedRevision + 1;
  const document = write.state === "active" ? write.recipe : null;
  const serialized = document === null ? null : JSON.stringify(document);
  const bytes = serialized === null ? 0 : new TextEncoder().encode(serialized).byteLength;
  // Sequences grow per owner; batches run serially in one transaction.
  const nextSequence = sql<number>`(SELECT COALESCE(MAX(${recipeHeads.sequence}), 0) + 1 FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId})`;
  const head = {
    revision,
    state: write.state,
    sequence: nextSequence,
    writeId,
    updatedAt: now,
    ...(options.used === false ? {} : { lastUsedAt: now }),
  };
  // Only a write that makes a recipe active can add one; updates and revocations cannot.
  const hasRoom = sql`${activeRecipes(ownerId)} < ${MAX_ACTIVE_RECIPES}`;
  const hasBytes = sql`${activeRecipeBytes(ownerId, recipeId)} + ${bytes} <= ${MAX_ACTIVE_RECIPE_BYTES}`;
  // Equal or shrinking active documents can repair an owner already above the cap.
  const doesNotGrow = sql`${bytes} <= (SELECT length(CAST(${recipeRevisions.document} AS BLOB))
    FROM ${recipeRevisions} WHERE ${recipeRevisions.ownerId} = ${ownerId}
      AND ${recipeRevisions.recipeId} = ${recipeId}
      AND ${recipeRevisions.revision} = ${write.expectedRevision})`;
  // INSERT ... SELECT is positional: keep these fields in the recipeHeads column order.
  const claim =
    write.expectedRevision === 0
      ? orm
          .insert(recipeHeads)
          .select(
            orm
              .select({
                ownerId: owners.id,
                recipeId: sql`${recipeId}`.as("recipe_id"),
                revision: sql`${revision}`.as("revision"),
                state: sql`${write.state}`.as("state"),
                sequence: nextSequence.as("sequence"),
                writeId: sql`${writeId}`.as("write_id"),
                updatedAt: sql`${now}`.as("updated_at"),
                lastUsedAt: sql`${now}`.as("last_used_at"),
              })
              .from(owners)
              .where(and(eq(owners.id, ownerId), hasRoom, hasBytes)),
          )
          .onConflictDoNothing()
      : orm
          .update(recipeHeads)
          .set(head)
          .where(
            and(
              eq(recipeHeads.ownerId, ownerId),
              eq(recipeHeads.recipeId, recipeId),
              eq(recipeHeads.revision, write.expectedRevision),
              options.unusedBefore === undefined
                ? undefined
                : lt(recipeHeads.lastUsedAt, options.unusedBefore),
              options.idleLayouts?.keys.length
                ? sql`NOT EXISTS (SELECT 1 FROM ${recipeLayoutUses}
                    WHERE ${recipeLayoutUses.ownerId} = ${ownerId}
                      AND ${recipeLayoutUses.recipeId} = ${recipeId}
                      AND ${recipeLayoutUses.layout} IN (${sql.join(
                        options.idleLayouts.keys.map((key) => sql`${key}`),
                        sql`, `,
                      )})
                      AND ${recipeLayoutUses.lastUsedAt} >= ${options.idleLayouts.before})`
                : undefined,
              // Re-revoking a tombstone would only add churn to every change feed.
              write.state === "revoked"
                ? eq(recipeHeads.state, "active")
                : and(
                    or(eq(recipeHeads.state, "active"), hasRoom),
                    or(and(eq(recipeHeads.state, "active"), doesNotGrow), hasBytes),
                  ),
            ),
          );
  // The history row is written only if this request's claim won the head.
  // Drizzle fills INSERT ... SELECT positionally: keep these fields in the
  // recipeRevisions column order (the stored-row test checks every column).
  const history = orm.insert(recipeRevisions).select(
    orm
      .select({
        ownerId: recipeHeads.ownerId,
        recipeId: recipeHeads.recipeId,
        revision: recipeHeads.revision,
        state: recipeHeads.state,
        document: sql`${serialized}`.as("document"),
        createdAt: sql`${now}`.as("created_at"),
        createdByDeviceId: sql`${writer}`.as("created_by_device_id"),
      })
      .from(recipeHeads)
      .where(
        and(
          eq(recipeHeads.ownerId, ownerId),
          eq(recipeHeads.recipeId, recipeId),
          eq(recipeHeads.writeId, writeId),
        ),
      ),
  );
  // Runs only after this request's claim won; a tombstone needs no earlier revision.
  const pruned = orm
    .delete(recipeRevisions)
    .where(
      and(
        eq(recipeRevisions.ownerId, ownerId),
        eq(recipeRevisions.recipeId, recipeId),
        sql`${recipeRevisions.revision} <= (SELECT ${recipeHeads.revision} - CASE ${recipeHeads.state} WHEN 'revoked' THEN 1 ELSE ${KEPT_RECIPE_REVISIONS} END FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId} AND ${recipeHeads.recipeId} = ${recipeId} AND ${recipeHeads.writeId} = ${writeId})`,
      ),
    );
  // Runs only after this request's claim won: the uses of layouts the document dropped,
  // every one for a tombstone.
  const kept = document === null ? [] : storedLayouts(document).map((layout) => layout.key);
  const unusedLayouts = orm.delete(recipeLayoutUses).where(
    and(
      eq(recipeLayoutUses.ownerId, ownerId),
      eq(recipeLayoutUses.recipeId, recipeId),
      sql`EXISTS (SELECT 1 FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId} AND ${recipeHeads.recipeId} = ${recipeId} AND ${recipeHeads.writeId} = ${writeId})`,
      kept.length
        ? sql`${recipeLayoutUses.layout} NOT IN (${sql.join(
            kept.map((key) => sql`${key}`),
            sql`, `,
          )})`
        : undefined,
    ),
  );
  // The provenance of the recipe's units (ADR 0060), kept only after this request's claim
  // won. A device's document does not say where its pages end, so it is split where the
  // recorded pages start; a write that wins finds these rows unchanged, since every write
  // of them changes the head.
  const { sources, copied } = options;
  const device = sources?.origin === "device";
  const call = sources && sources.origin !== "device" ? sources : undefined;
  const units =
    document === null || !sources
      ? []
      : call
        ? await namedUnits(document, call.units)
        : await documentUnits(document, await readPageUnits(db, ownerId, recipeId));
  // Every unit a call's document still holds, so a row of a unit it no longer has, as the
  // markers of a passkey route put in place of another (ADR 0079), goes with the write.
  const held =
    document !== null && call
      ? await documentUnits(document, [
          ...(await readPageUnits(db, ownerId, recipeId)),
          ...call.units,
          // The pages a repair copies start where they started in the layout they come from.
          ...(copied?.units ?? []).map((unit) => ({
            layout: copied!.to,
            unit: copied!.branch ? `${copied!.branch}/${unit}` : unit,
          })),
        ])
      : [];
  const heldRows = sql`json_each(${JSON.stringify(held)}) AS held_row`;
  const won = sql`EXISTS (SELECT 1 FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId} AND ${recipeHeads.recipeId} = ${recipeId} AND ${recipeHeads.writeId} = ${writeId})`;
  const unitRows = sql`json_each(${JSON.stringify(units)}) AS unit_row`;
  const unitLayout = sql`json_extract(unit_row.value, '$.layout')`;
  const unitId = sql`json_extract(unit_row.value, '$.unit')`;
  const unitDigest = sql`json_extract(unit_row.value, '$.digest')`;
  /** Whether the written units name the row's unit, and with `digest` its content too. */
  const listed = (digest: boolean) =>
    sql`EXISTS (SELECT 1 FROM ${unitRows} WHERE ${unitId} = ${recipeUnitSources.unit} AND ${unitLayout} IS ${recipeUnitSources.layout}${digest ? sql` AND ${unitDigest} = ${recipeUnitSources.digest}` : sql``})`;
  // A tombstone drops every row; a device's document every row it did not keep as it was;
  // another write the rows of layouts the document dropped and of the units it rewrote,
  // and a call's write also those of units the document no longer holds.
  const staleSources = orm
    .delete(recipeUnitSources)
    .where(
      and(
        eq(recipeUnitSources.ownerId, ownerId),
        eq(recipeUnitSources.recipeId, recipeId),
        won,
        document === null
          ? undefined
          : device
            ? sql`NOT ${listed(true)}`
            : or(
                "entry" in document
                  ? isNotNull(recipeUnitSources.layout)
                  : or(
                      isNull(recipeUnitSources.layout),
                      notInArray(recipeUnitSources.layout, kept),
                    ),
                call
                  ? sql`NOT EXISTS (SELECT 1 FROM ${heldRows} WHERE json_extract(held_row.value, '$.unit') = ${recipeUnitSources.unit} AND json_extract(held_row.value, '$.layout') IS ${recipeUnitSources.layout})`
                  : undefined,
                listed(false),
              ),
      ),
    );
  const writtenSources = units.length
    ? [
        // Drizzle fills INSERT ... SELECT positionally: keep these fields in the
        // recipeUnitSources column order. A unit whose row stayed keeps it.
        orm.insert(recipeUnitSources).select(
          orm
            .select({
              ownerId: sql`${ownerId}`.as("owner_id"),
              recipeId: sql`${recipeId}`.as("recipe_id"),
              layout: unitLayout.as("layout"),
              unit: unitId.as("unit"),
              digest: unitDigest.as("digest"),
              revision: sql`${revision}`.as("revision"),
              origin: sql`${sources!.origin}`.as("origin"),
              provider: sql`${call?.served.provider ?? null}`.as("provider"),
              model: sql`${call?.served.model ?? null}`.as("model"),
              effort: sql`${call?.served.effort ?? null}`.as("effort"),
              speed: sql`${call?.served.speed ?? null}`.as("speed"),
              promptVersion: sql`${call?.promptVersion ?? null}`.as("prompt_version"),
              build: sql`${PATEAT_BUILD_REVISION}`.as("build"),
              deviceId: sql`${writer}`.as("device_id"),
              logId: sql`${call?.logId ?? null}`.as("log_id"),
              createdAt: sql`${now}`.as("created_at"),
            })
            .from(unitRows)
            .where(
              and(
                won,
                sql`NOT EXISTS (SELECT 1 FROM ${recipeUnitSources} WHERE ${recipeUnitSources.ownerId} = ${ownerId} AND ${recipeUnitSources.recipeId} = ${recipeId} AND ${recipeUnitSources.unit} = ${unitId} AND ${recipeUnitSources.layout} IS ${unitLayout})`,
              ),
            ),
        ),
      ]
    : [];
  // Drizzle fills INSERT ... SELECT positionally, as below.
  const copiedSources =
    document !== null && copied?.units.length
      ? [
          orm.insert(recipeUnitSources).select(
            orm
              .select({
                ownerId: recipeUnitSources.ownerId,
                recipeId: recipeUnitSources.recipeId,
                layout: sql`${copied.to}`.as("layout"),
                unit: copied.branch
                  ? sql`${`${copied.branch}/`} || ${recipeUnitSources.unit}`.as("unit")
                  : recipeUnitSources.unit,
                digest: recipeUnitSources.digest,
                revision: recipeUnitSources.revision,
                origin: recipeUnitSources.origin,
                provider: recipeUnitSources.provider,
                model: recipeUnitSources.model,
                effort: recipeUnitSources.effort,
                speed: recipeUnitSources.speed,
                promptVersion: recipeUnitSources.promptVersion,
                build: recipeUnitSources.build,
                deviceId: recipeUnitSources.deviceId,
                logId: recipeUnitSources.logId,
                createdAt: recipeUnitSources.createdAt,
              })
              .from(recipeUnitSources)
              .where(
                and(
                  eq(recipeUnitSources.ownerId, ownerId),
                  eq(recipeUnitSources.recipeId, recipeId),
                  won,
                  eq(recipeUnitSources.layout, copied.from),
                  inArray(recipeUnitSources.unit, [...copied.units]),
                ),
              ),
          ),
        ]
      : [];
  const [claimed, recorded] = await orm.batch([
    claim,
    history,
    pruned,
    unusedLayouts,
    ...copiedSources,
    staleSources,
    ...writtenSources,
  ]);
  if (claimed.meta.changes === 1 && recorded.meta.changes !== 1)
    throw new Error("Recipe head was claimed without its history row");
  if (claimed.meta.changes !== 1) {
    const current = await readHead(db, ownerId, recipeId);
    // A matching expected head means the active claim was refused only by a quota.
    // Do not recheck capacity here: another writer may have freed room after the claim.
    // A removal of idle layouts that only shrinks the document is refused by a use instead.
    const limited =
      write.state === "active" &&
      !options.idleLayouts?.keys.length &&
      (current ? current.revision === write.expectedRevision : write.expectedRevision === 0);
    return limited ? { ok: false, limited } : { ok: false, limited, current };
  }
  // A document written just now must validate; only stored rows read back may be unreadable.
  return {
    ok: true,
    change: v.parse(
      syncRecipeChangeSchema,
      document === null
        ? { recipeId, revision, state: write.state }
        : { recipeId, revision, state: write.state, recipe: document },
    ),
  };
}

/** Stored layouts, of a login recipe or a chooser, as JSON rows of the head's document. */
const layoutRows = (path: string) =>
  sql`json_each(${recipeRevisions.document}, ${path}) AS layout_row`;
/** Whether the head's document has the layout among those at `path`. */
const hasLayout = (path: string, layout: string) =>
  sql`EXISTS (SELECT 1 FROM ${layoutRows(path)}
    WHERE json_extract(layout_row.value, '$.key') = ${layout})`;
/**
 * Marks one layout of an active recipe used now (ADR 0060), for a batch: a login reported
 * on it, or a write of it that a login's page caused. Nothing unless the active head still
 * has the layout, so a report of one removed meanwhile, or made up, leaves no row.
 */
export function markLayoutUsed(
  orm: DrizzleD1Database,
  ownerId: string,
  recipeId: string,
  layout: string,
  now: number,
) {
  return orm
    .insert(recipeLayoutUses)
    .select(
      orm
        .select({
          ownerId: recipeHeads.ownerId,
          recipeId: recipeHeads.recipeId,
          layout: sql`${layout}`.as("layout"),
          lastUsedAt: sql`${now}`.as("last_used_at"),
        })
        .from(recipeHeads)
        .innerJoin(
          recipeRevisions,
          and(
            eq(recipeRevisions.ownerId, recipeHeads.ownerId),
            eq(recipeRevisions.recipeId, recipeHeads.recipeId),
            eq(recipeRevisions.revision, recipeHeads.revision),
          ),
        )
        .where(
          and(
            eq(recipeHeads.ownerId, ownerId),
            eq(recipeHeads.recipeId, recipeId),
            eq(recipeHeads.state, "active"),
            sql`(${hasLayout("$.layouts", layout)} OR ${hasLayout("$.chooser.layouts", layout)})`,
          ),
        ),
    )
    .onConflictDoUpdate({
      target: [recipeLayoutUses.ownerId, recipeLayoutUses.recipeId, recipeLayoutUses.layout],
      set: { lastUsedAt: now },
    });
}

/** When each layout of the owner's recipes was last used, by recipe ID and layout key. */
export async function readLayoutUses(
  db: D1Database,
  ownerId: string,
  recipeId?: string,
): Promise<Map<string, Map<string, number>>> {
  const rows = await drizzle(db)
    .select()
    .from(recipeLayoutUses)
    .where(
      and(
        eq(recipeLayoutUses.ownerId, ownerId),
        recipeId === undefined ? undefined : eq(recipeLayoutUses.recipeId, recipeId),
      ),
    );
  const uses = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const recipe = uses.get(row.recipeId) ?? new Map<string, number>();
    recipe.set(row.layout, row.lastUsedAt);
    uses.set(row.recipeId, recipe);
  }
  return uses;
}

/** The recorded page units of a recipe (ADR 0060), where a device's document is split. */
async function readPageUnits(
  db: D1Database,
  ownerId: string,
  recipeId: string,
): Promise<RecipeUnit[]> {
  return drizzle(db)
    .select({ layout: recipeUnitSources.layout, unit: recipeUnitSources.unit })
    .from(recipeUnitSources)
    .where(
      and(
        eq(recipeUnitSources.ownerId, ownerId),
        eq(recipeUnitSources.recipeId, recipeId),
        sql`${recipeUnitSources.unit} GLOB '*page:*'`,
      ),
    );
}

/**
 * Who made the first page of each layout of the owner's recipes (ADR 0060, generation
 * provenance), a chooser layout's list for a chooser, by recipe ID and layout key.
 */
export async function readFirstPageSources(
  db: D1Database,
  ownerId: string,
): Promise<Map<string, Map<string, ManageLayoutSource>>> {
  const rows = await drizzle(db)
    .select({
      recipeId: recipeUnitSources.recipeId,
      layout: recipeUnitSources.layout,
      origin: recipeUnitSources.origin,
      model: recipeUnitSources.model,
      createdAt: recipeUnitSources.createdAt,
    })
    .from(recipeUnitSources)
    .where(
      and(
        eq(recipeUnitSources.ownerId, ownerId),
        isNotNull(recipeUnitSources.layout),
        inArray(recipeUnitSources.unit, [pageUnit(0), LIST_UNIT]),
      ),
    );
  const sources = new Map<string, Map<string, ManageLayoutSource>>();
  for (const { recipeId, layout, ...source } of rows) {
    if (layout === null) continue;
    const recipe = sources.get(recipeId) ?? new Map<string, ManageLayoutSource>();
    recipe.set(layout, source);
    sources.set(recipeId, recipe);
  }
  return sources;
}

/**
 * The stored recipe without its layouts unused since `unusedBefore` (ADR 0060): a layout
 * counts as used when it was created and at its last reported use. A recipe whose layouts
 * were generated as `confirm` or `unclear` never runs, so never reports use, and keeps them
 * all (ADR 0035): every layout of a recipe has its kind. A chooser's layouts are `sign-in`.
 * `undefined` when none is unused, or every one is, which the recipe's own idle check
 * revokes instead.
 */
export function withoutUnusedLayouts(
  recipe: StoredLoginRecipe,
  uses: ReadonlyMap<string, number>,
  unusedBefore: number,
): StoredLoginRecipe | undefined {
  const idle = new Set(
    [
      ...("layouts" in recipe ? recipe.layouts.filter(runsLogin) : []),
      ...("chooser" in recipe ? recipe.chooser.layouts : []),
    ]
      .filter((layout) => Math.max(layout.createdAt, uses.get(layout.key) ?? 0) < unusedBefore)
      .map((layout) => layout.key),
  );
  if (!idle.size || idle.size === storedLayouts(recipe).length) return undefined;
  const revision = recipe.revision + 1;
  if ("layouts" in recipe)
    return {
      ...recipe,
      revision,
      layouts: recipe.layouts.filter((layout) => !idle.has(layout.key)),
    };
  if ("chooser" in recipe)
    return {
      ...recipe,
      revision,
      chooser: {
        ...recipe.chooser,
        layouts: recipe.chooser.layouts.filter((layout) => !idle.has(layout.key)),
      },
    };
  return undefined;
}

/**
 * Revokes the owner's active recipes unused for `RECIPE_IDLE_LIMIT_MS` (ADR 0058), at most
 * `MAX_IDLE_REVOCATIONS` per call and oldest first, as ordinary tombstone writes by the
 * service. Entry recipes (ADR 0031) and logout recipes (ADR 0063) stay: pressing an entry or
 * signing out for an account switch reports nothing to the service. So do login recipes
 * with a layout generated as `confirm` or `unclear` (ADR 0035, ADR 0060), which never
 * runs, so never reports use. A recipe used after this read keeps its head. Returns how
 * many were
 * revoked.
 */
export async function revokeUnusedRecipes(
  db: D1Database,
  ownerId: string,
  now: number,
): Promise<number> {
  const unusedBefore = now - RECIPE_IDLE_LIMIT_MS;
  const idle = await selectHeads(
    db,
    ownerId,
    eq(recipeHeads.state, "active"),
    lt(recipeHeads.lastUsedAt, unusedBefore),
    sql`json_extract(${recipeRevisions.document}, '$.entry') IS NULL`,
    sql`json_extract(${recipeRevisions.document}, '$.logout') IS NULL`,
    // Every layout of a login recipe was generated as `sign-in` (ADR 0060).
    sql`NOT EXISTS (SELECT 1 FROM ${layoutRows("$.layouts")}
      WHERE json_extract(layout_row.value, '$.pageKind') <> 'sign-in')`,
  )
    .orderBy(asc(recipeHeads.lastUsedAt))
    .limit(MAX_IDLE_REVOCATIONS);
  let revoked = 0;
  for (const { recipeId, revision } of idle) {
    // Sequential: each write takes the owner's next sequence number.
    // eslint-disable-next-line no-await-in-loop
    const result = await writeRecipe(
      db,
      ownerId,
      recipeId,
      { version: 1, expectedRevision: revision, state: "revoked" },
      null,
      { unusedBefore },
    );
    if (result.ok) revoked += 1;
  }
  await removeUnusedLayouts(db, ownerId, unusedBefore);
  return revoked;
}

/**
 * Removes the layouts unused since `unusedBefore` of the owner's active recipes that were
 * themselves used since then, at their head's `lastUsedAt`, and keep another layout (ADR
 * 0060), at most `MAX_IDLE_REVOCATIONS` recipes per call, as service writes that do not
 * mark the recipe used. A recipe written meanwhile, or a removed layout used meanwhile,
 * keeps its layouts until the next check.
 */
async function removeUnusedLayouts(db: D1Database, ownerId: string, unusedBefore: number) {
  // Only recipes holding a layout created before the limit and not used since are read.
  const idleLayout = (path: string) =>
    sql`EXISTS (SELECT 1 FROM ${layoutRows(path)}
      WHERE json_extract(layout_row.value, '$.createdAt') < ${unusedBefore}
        AND coalesce(json_extract(layout_row.value, '$.pageKind'), 'sign-in') = 'sign-in'
        AND NOT EXISTS (SELECT 1 FROM ${recipeLayoutUses}
          WHERE ${recipeLayoutUses.ownerId} = ${recipeHeads.ownerId}
            AND ${recipeLayoutUses.recipeId} = ${recipeHeads.recipeId}
            AND ${recipeLayoutUses.layout} = json_extract(layout_row.value, '$.key')
            AND ${recipeLayoutUses.lastUsedAt} >= ${unusedBefore}))`;
  const candidates = await selectHeads(
    db,
    ownerId,
    eq(recipeHeads.state, "active"),
    gte(recipeHeads.lastUsedAt, unusedBefore),
    sql`(${idleLayout("$.layouts")} OR ${idleLayout("$.chooser.layouts")})`,
  )
    .orderBy(asc(recipeHeads.lastUsedAt))
    .limit(MAX_IDLE_REVOCATIONS);
  if (!candidates.length) return;
  const uses = await readLayoutUses(db, ownerId);
  for (const row of candidates) {
    const { change } = readChange(row);
    if (change.state !== "active" || "entry" in change.recipe) continue;
    const next = withoutUnusedLayouts(
      change.recipe,
      uses.get(row.recipeId) ?? new Map(),
      unusedBefore,
    );
    if (!next) continue;
    const kept = new Set(storedLayouts(next).map((layout) => layout.key));
    // Sequential: each write takes the owner's next sequence number.
    // eslint-disable-next-line no-await-in-loop
    await writeRecipe(
      db,
      ownerId,
      row.recipeId,
      { version: 1, expectedRevision: row.revision, state: "active", recipe: next },
      null,
      {
        used: false,
        // A use reported after `uses` was read keeps its layout.
        idleLayouts: {
          keys: storedLayouts(change.recipe)
            .map((layout) => layout.key)
            .filter((key) => !kept.has(key)),
          before: unusedBefore,
        },
      },
    );
  }
}
