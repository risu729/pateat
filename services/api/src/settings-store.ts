import {
  syncSettingsStateSchema,
  type LocalSettings,
  type SavedLoginBinding,
  type SyncSettingsState,
  type SyncSettingsWrite,
} from "@pateat/contracts";
import * as v from "valibot";

/** Profile parts are explicit so shared bindings cannot accidentally become policy. */
export const profileDocument = (document: LocalSettings) => ({
  excludedSites: document.excludedSites,
  siteDefaults: document.siteDefaults,
});

/** Reads the profile and shared binding revision in one database snapshot. */
export async function readSettings(
  db: D1Database,
  ownerId: string,
  profileId: string,
): Promise<SyncSettingsState> {
  const row = await db.prepare(`SELECT s.revision, s.document AS shared, p.document
    FROM profiles p LEFT JOIN settings s ON s.owner_id = p.owner_id
    WHERE p.owner_id = ? AND p.id = ?`).bind(ownerId, profileId)
    .first<{ revision: number | null; shared: string | null; document: string | null }>();
  if (!row) throw new Error("profile-not-found");
  const shared = row.shared ? JSON.parse(row.shared) : { bindings: [] };
  const profile = row.document ? JSON.parse(row.document) : { excludedSites: [], siteDefaults: [] };
  return v.parse(syncSettingsStateSchema, {
    version: 1,
    profileId,
    revision: row.revision ?? 0,
    settings: row.revision ? { connections: [], ...profile, bindings: shared.bindings } : null,
  });
}

  type LocalSettings,
  type SavedLoginBinding,
export async function writeSettings(
  db: D1Database,
  ownerId: string,
  profileId: string,
  write: SyncSettingsWrite,
  writer: string | null,
): Promise<{ ok: true; state: SyncSettingsState } | { ok: false; current: SyncSettingsState }> {
  // Both statements use the exact same compare-and-swap predicate. The profile write
  // runs first; changes() gates the revision write so losing writers update neither.
  const results = await db.batch([
    db.prepare(`UPDATE profiles SET document = ? WHERE owner_id = ? AND id = ?
      AND COALESCE((SELECT revision FROM settings WHERE owner_id = ?), 0) = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM devices WHERE id = ? AND owner_id = ? AND profile_id = ?))`)
      .bind(JSON.stringify(profileDocument(write.settings)), ownerId, profileId, ownerId,
        write.expectedRevision, writer, writer, ownerId, profileId),
    db.prepare(`INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id)
      SELECT ?, ?, ?, ?, ? WHERE changes() = 1
      ON CONFLICT(owner_id) DO UPDATE SET revision = excluded.revision,
        document = excluded.document, updated_at = excluded.updated_at,
        updated_by_device_id = excluded.updated_by_device_id`)
      .bind(ownerId, write.expectedRevision + 1, JSON.stringify({ bindings: write.settings.bindings }), Date.now(), writer),
  ]);
  if (results[1]?.meta.changes !== 1) {
    const currentProfile = writer
      ? await db.prepare("SELECT profile_id FROM devices WHERE owner_id = ? AND id = ?")
        .bind(ownerId, writer).first<{profile_id: string}>()
      : null;
    return { ok: false, current: await readSettings(db, ownerId, currentProfile?.profile_id ?? profileId) };
  }
  return { ok: true, state: { version: 1, profileId, revision: write.expectedRevision + 1, settings: write.settings } };
}
