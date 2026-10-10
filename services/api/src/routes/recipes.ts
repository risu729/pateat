import {
  SYNC_PAGE_LIMIT,
  syncRecipeChangeSchema,
  syncRecipeIdSchema,
  syncRecipeWriteSchema,
  type SyncRecipeChange,
} from "@pateat/contracts";
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { validator } from "hono/validator";
import * as v from "valibot";
import type { ApiEnv, DeviceScope } from "../auth";
import { recipeHeads, recipeRevisions } from "../db/schema";
import { apiError } from "../http";
import { jsonBody } from "../validation";

const changesQuerySchema = v.strictObject({
  after: v.optional(
    v.pipe(v.string(), v.regex(/^(?:0|[1-9][0-9]{0,14})$/), v.transform(Number)),
    "0",
  ),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[1-9][0-9]{0,2}$/),
      v.transform(Number),
      v.maxValue(SYNC_PAGE_LIMIT),
    ),
    String(SYNC_PAGE_LIMIT),
  ),
});

type HeadRow = {
  recipeId: string;
  revision: number;
  state: "active" | "revoked";
  sequence: number;
  document: unknown;
};

/** Every head read is owner-scoped here; callers can only narrow it further. */
function selectHeads(db: D1Database, scope: DeviceScope, ...conditions: SQL[]) {
  return drizzle(db)
    .select({
      recipeId: recipeHeads.recipeId,
      revision: recipeHeads.revision,
      state: recipeHeads.state,
      sequence: recipeHeads.sequence,
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
    .where(and(eq(recipeHeads.ownerId, scope.ownerId), ...conditions))
    .$dynamic();
}

/** Stored rows are revalidated; a corrupt row fails closed as an internal error. */
function toChange(row: HeadRow): SyncRecipeChange {
  return v.parse(
    syncRecipeChangeSchema,
    row.state === "active"
      ? { recipeId: row.recipeId, revision: row.revision, state: row.state, recipe: row.document }
      : { recipeId: row.recipeId, revision: row.revision, state: row.state },
  );
}

async function readHead(db: D1Database, scope: DeviceScope, recipeId: string) {
  const [row] = await selectHeads(db, scope, eq(recipeHeads.recipeId, recipeId));
  return row ? toChange(row) : null;
}

export const recipeRoutes = new Hono<ApiEnv>()
  .get(
    "/",
    validator("query", (value, c) => {
      const result = v.safeParse(changesQuerySchema, value);
      return result.success ? result.output : apiError(c, 400, { error: "bad_request" });
    }),
    async (c) => {
      const { after, limit } = c.req.valid("query");
      const scope = c.get("scope");
      const rows = await selectHeads(c.env.DB, scope, gt(recipeHeads.sequence, after))
        .orderBy(asc(recipeHeads.sequence))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return c.json({
        version: 1 as const,
        changes: page.map(toChange),
        cursor: page.at(-1)?.sequence ?? after,
        complete: rows.length <= limit,
      });
    },
  )
  .put(
    "/:recipeId",
    validator("param", (value, c) => {
      const result = v.safeParse(v.strictObject({ recipeId: syncRecipeIdSchema }), value);
      return result.success ? result.output : apiError(c, 400, { error: "bad_request" });
    }),
    jsonBody(syncRecipeWriteSchema),
    async (c) => {
      const scope = c.get("scope");
      const { recipeId } = c.req.valid("param");
      const write = c.req.valid("json");
      if (write.state === "active" && write.recipe.id !== recipeId)
        return apiError(c, 400, { error: "bad_request" });

      const db = drizzle(c.env.DB);
      const now = Date.now();
      const writeId = crypto.randomUUID();
      const revision = write.expectedRevision + 1;
      const document = write.state === "active" ? write.recipe : null;
      // Sequences grow per owner; batches run serially in one transaction.
      const nextSequence = sql<number>`(SELECT COALESCE(MAX(${recipeHeads.sequence}), 0) + 1 FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${scope.ownerId})`;
      const head = {
        revision,
        state: write.state,
        sequence: nextSequence,
        writeId,
        updatedAt: now,
      };
      const claim =
        write.expectedRevision === 0
          ? db
              .insert(recipeHeads)
              .values({ ownerId: scope.ownerId, recipeId, ...head })
              .onConflictDoNothing()
          : db
              .update(recipeHeads)
              .set(head)
              .where(
                and(
                  eq(recipeHeads.ownerId, scope.ownerId),
                  eq(recipeHeads.recipeId, recipeId),
                  eq(recipeHeads.revision, write.expectedRevision),
                ),
              );
      // The history row is written only if this request's claim won the head.
      const history = db.insert(recipeRevisions).select(
        db
          .select({
            ownerId: recipeHeads.ownerId,
            recipeId: recipeHeads.recipeId,
            revision: recipeHeads.revision,
            state: recipeHeads.state,
            document: sql`${document === null ? null : JSON.stringify(document)}`.as("document"),
            createdAt: sql`${now}`.as("created_at"),
            createdByDeviceId: sql`${scope.deviceId}`.as("created_by_device_id"),
          })
          .from(recipeHeads)
          .where(
            and(
              eq(recipeHeads.ownerId, scope.ownerId),
              eq(recipeHeads.recipeId, recipeId),
              eq(recipeHeads.writeId, writeId),
            ),
          ),
      );
      const [claimed, recorded] = await db.batch([claim, history]);
      if (claimed.meta.changes === 1 && recorded.meta.changes !== 1)
        throw new Error("Recipe head was claimed without its history row");
      if (claimed.meta.changes !== 1)
        return c.json(
          {
            error: "recipe_conflict" as const,
            current: await readHead(c.env.DB, scope, recipeId),
          },
          409,
        );
      return c.json({
        version: 1 as const,
        change: toChange({ recipeId, revision, state: write.state, sequence: 0, document }),
      });
    },
  );
