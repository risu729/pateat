import { newId } from "@pateat/contracts/ids";

export async function listProfiles(db: D1Database, ownerId: string) {
  const result = await db
    .prepare("SELECT id, name FROM profiles WHERE owner_id = ? ORDER BY name, id")
    .bind(ownerId)
    .all<{ id: string; name: string }>();
  return result.results;
}

/** An owner's first profile has a stable ID, so simultaneous first pairings agree. */
export async function ensureProfile(db: D1Database, ownerId: string) {
  await db
    .prepare(
      "INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default') ON CONFLICT DO NOTHING",
    )
    .bind(ownerId, ownerId)
    .run();
}

export async function copyProfile(db: D1Database, ownerId: string, copyFrom: string, name: string) {
  const id = newId();
  const results = await db.batch([
    db
      .prepare(`INSERT INTO profiles (owner_id, id, name, document)
      SELECT owner_id, ?, ?, document FROM profiles WHERE owner_id = ? AND id = ?`)
      .bind(id, name, ownerId, copyFrom),
    db
      .prepare(`INSERT INTO settings (owner_id, revision, document, updated_at)
      SELECT ?, 1, '{"bindings":[]}', ? WHERE changes() = 1
      ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`)
      .bind(ownerId, Date.now()),
  ]);
  return results[0]?.meta.changes === 1 ? { id, name } : null;
}

/** Reassignment and revision advancement are atomic; old-profile writes conflict. */
export async function assignProfile(
  db: D1Database,
  ownerId: string,
  deviceId: string,
  profileId: string,
) {
  const results = await db.batch([
    db
      .prepare(`UPDATE devices SET profile_id = ? WHERE owner_id = ? AND id = ?
      AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM profiles WHERE owner_id = ? AND id = ?)`)
      .bind(profileId, ownerId, deviceId, ownerId, profileId),
    db
      .prepare(`INSERT INTO settings (owner_id, revision, document, updated_at)
      SELECT ?, 1, '{"bindings":[]}', ? WHERE changes() = 1
      ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`)
      .bind(ownerId, Date.now()),
  ]);
  return results[0]?.meta.changes === 1;
}
