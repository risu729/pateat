import {
  MAX_ACTIVE_RECIPE_BYTES,
  runsLogin,
  storedLayouts,
  syncRecipeChangeSchema,
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
import type { ServedModel } from "./claude/calls";
import {
  owners,
  recipeHeads,
  recipeLayoutUses,
  recipeRevisions,
  recipeUnitSources,
  type RecipeUnitOrigin,
} from "./db/schema";
import { LIST_UNIT, pageUnit, type RecipeUnit } from "./recipe-units";
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
 * What a recipe write records of the units it adds (ADR 0060, generation provenance): the
 * call that made them, which a `device` write has none of.
 */
export type UnitSources =
  | {
      origin: Extract<RecipeUnitOrigin, "generated" | "judged">;
      units: readonly RecipeUnit[];
      served: ServedModel;
      promptVersion: string;
      logId: string | undefined;
    }
  | { origin: "device"; units: readonly RecipeUnit[] };

/**
 * Writes the next revision of one recipe when `expectedRevision` is still its head.
 * `writer` is the device the write is for: the one that wrote it (`PUT /v1/recipes/:id`) or
 * whose request generated or judged it. It is null for a write no device asked for, by the
 * owner web UI or the service's own checks, such as the idle check (ADR 0058). A stale
 * writer changes nothing and gets the current head back (null when the recipe never
 * existed). Every winning write marks the recipe used (`lastUsedAt`, ADR 0058); with
 * `unusedBefore`, the write wins only while the head was last used before that time, so a
 * recipe used after an idle check is not revoked by it.
 * A write that would make the owner hold more than `MAX_ACTIVE_RECIPES` active recipes
 * or exceed `MAX_ACTIVE_RECIPE_BYTES` by creating or growing one
 * changes nothing and is `limited`. A winning write deletes revisions older than the
 * newest `KEPT_RECIPE_REVISIONS`, or every older one when it revokes the recipe, and the
 * last use of each layout (ADR 0060) the written document no longer has. With `used:
 * false`, as when the owner or the idle check removes a layout, the write does not mark
 * the recipe used.
 * The same batch keeps `recipe_unit_sources` (ADR 0060): it deletes the rows of layouts the
 * document no longer has, every row of a revoked recipe, and with `sources` writes a row
 * for each unit named there, replacing that unit's earlier row; a `device` write replaces
 * every row of the recipe. `writer` is each row's device.
 */
export async function writeRecipe(
  db: D1Database,
  ownerId: string,
  recipeId: string,
  write: SyncRecipeWrite,
  writer: string | null,
  options: { unusedBefore?: number; used?: boolean; sources?: UnitSources } = {},
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
  // won: rows of layouts the document dropped go (every row for a tombstone, or for a
  // device's document, which replaces them all), then each unit written gets its new row.
  const won = sql`EXISTS (SELECT 1 FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId} AND ${recipeHeads.recipeId} = ${recipeId} AND ${recipeHeads.writeId} = ${writeId})`;
  const { sources } = options;
  const ofRecipe = and(
    eq(recipeUnitSources.ownerId, ownerId),
    eq(recipeUnitSources.recipeId, recipeId),
    won,
  );
  const droppedSources = orm
    .delete(recipeUnitSources)
    .where(
      and(
        ofRecipe,
        document === null || sources?.origin === "device"
          ? undefined
          : "entry" in document
            ? isNotNull(recipeUnitSources.layout)
            : or(isNull(recipeUnitSources.layout), notInArray(recipeUnitSources.layout, kept)),
      ),
    );
  const units = document === null ? [] : (sources?.units ?? []);
  const unitRows = sql`json_each(${JSON.stringify(units)}) AS unit_row`;
  const unitLayout = sql`json_extract(unit_row.value, '$.layout')`;
  const unitId = sql`json_extract(unit_row.value, '$.unit')`;
  const call = sources && sources.origin !== "device" ? sources : undefined;
  const writtenSources = units.length
    ? [
        orm
          .delete(recipeUnitSources)
          .where(
            and(
              ofRecipe,
              sql`EXISTS (SELECT 1 FROM ${unitRows} WHERE ${unitId} = ${recipeUnitSources.unit} AND ${unitLayout} IS ${recipeUnitSources.layout})`,
            ),
          ),
        // Drizzle fills INSERT ... SELECT positionally: keep these fields in the
        // recipeUnitSources column order.
        orm.insert(recipeUnitSources).select(
          orm
            .select({
              ownerId: sql`${ownerId}`.as("owner_id"),
              recipeId: sql`${recipeId}`.as("recipe_id"),
              layout: unitLayout.as("layout"),
              unit: unitId.as("unit"),
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
            .where(won),
        ),
      ]
    : [];
  const [claimed, recorded] = await orm.batch([
    claim,
    history,
    pruned,
    unusedLayouts,
    droppedSources,
    ...writtenSources,
  ]);
  if (claimed.meta.changes === 1 && recorded.meta.changes !== 1)
    throw new Error("Recipe head was claimed without its history row");
  if (claimed.meta.changes !== 1) {
    const current = await readHead(db, ownerId, recipeId);
    // A matching expected head means the active claim was refused only by a quota.
    // Do not recheck capacity here: another writer may have freed room after the claim.
    const limited =
      write.state === "active" &&
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

/**
 * Marks one layout of an active recipe used now (ADR 0060), for a batch: a login reported
 * on it, or a write of it that a login's page caused. Nothing unless the active head still
 * has the layout, so a report of one removed meanwhile, or made up, leaves no row.
 */
/** Stored layouts, of a login recipe or a chooser, as JSON rows of the head's document. */
const layoutRows = (path: string) =>
  sql`json_each(${recipeRevisions.document}, ${path}) AS layout_row`;
/** Whether the head's document has the layout among those at `path`. */
const hasLayout = (path: string, layout: string) =>
  sql`EXISTS (SELECT 1 FROM ${layoutRows(path)}
    WHERE json_extract(layout_row.value, '$.key') = ${layout})`;
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
 * counts as used when it was created and at its last reported use. A layout generated as
 * `confirm` or `unclear` never runs, so never reports use, and stays (ADR 0035); a chooser's
 * layouts are `sign-in`. `undefined` when none is unused, or every one is, which the
 * recipe's own idle check revokes instead.
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
 * service. Entry recipes (ADR 0031) stay: pressing an entry reports nothing to the service.
 * So do login recipes with a layout generated as `confirm` or `unclear` (ADR 0035, ADR
 * 0060), which never runs, so never reports use. A recipe used after this read keeps its head. Returns how many were
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
 * Removes the layouts of the owner's recipes unused since `unusedBefore` while another
 * layout of the same recipe is used (ADR 0060), at most `MAX_IDLE_REVOCATIONS` recipes per
 * call, as service writes that do not mark the recipe used. A recipe written meanwhile
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
    // Sequential: each write takes the owner's next sequence number.
    // eslint-disable-next-line no-await-in-loop
    await writeRecipe(
      db,
      ownerId,
      row.recipeId,
      { version: 1, expectedRevision: row.revision, state: "active", recipe: next },
      null,
      { used: false },
    );
  }
}
