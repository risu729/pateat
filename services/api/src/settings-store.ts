import {
  syncSettingsStateSchema,
  type SavedLoginBinding,
  type SyncSettingsState,
  type SyncSettingsWrite,
} from "@pateat/contracts";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { settings } from "./db/schema";

/** The owner's settings; revision 0 with no document before the first write. */
export async function readSettings(db: D1Database, ownerId: string): Promise<SyncSettingsState> {
  const [row] = await drizzle(db)
    .select({ revision: settings.revision, document: settings.document })
    .from(settings)
    .where(eq(settings.ownerId, ownerId))
    .limit(1);
  // Stored documents are revalidated; a corrupt row fails closed as an internal error.
  return v.parse(syncSettingsStateSchema, {
    version: 1,
    revision: row?.revision ?? 0,
    settings: row?.document ?? null,
  });
}

/**
 * The slots of the owner's saved bindings for one recipe of one origin, every account's,
 * for naming a generated page's custom-field slots (ADR 0027, amended 2026-10-19): only
 * slot names and field references, never the item or account a binding names.
 */
export async function recipeBindingSlots(
  db: D1Database,
  ownerId: string,
  origin: string,
  recipeId: string,
): Promise<Pick<SavedLoginBinding, "slots">[]> {
  const { settings: document } = await readSettings(db, ownerId);
  return (document?.bindings ?? []).flatMap((binding) =>
    binding.origin === origin && binding.recipeId === recipeId ? [{ slots: binding.slots }] : [],
  );
}

/**
 * Replaces the owner's settings when `expectedRevision` is still current. `writer` is
 * the writing device, or null for the owner web UI. One conditional statement: a stale
 * writer changes no row and gets the current state back.
 */
export async function writeSettings(
  db: D1Database,
  ownerId: string,
  write: SyncSettingsWrite,
  writer: string | null,
): Promise<{ ok: true; state: SyncSettingsState } | { ok: false; current: SyncSettingsState }> {
  const orm = drizzle(db);
  const values = {
    revision: write.expectedRevision + 1,
    document: write.settings,
    updatedAt: Date.now(),
    updatedByDeviceId: writer,
  };
  const result =
    write.expectedRevision === 0
      ? await orm
          .insert(settings)
          .values({ ownerId, ...values })
          .onConflictDoNothing()
          .run()
      : await orm
          .update(settings)
          .set(values)
          .where(and(eq(settings.ownerId, ownerId), eq(settings.revision, write.expectedRevision)))
          .run();
  if (result.meta.changes !== 1) return { ok: false, current: await readSettings(db, ownerId) };
  return { ok: true, state: { version: 1, revision: values.revision, settings: write.settings } };
}
