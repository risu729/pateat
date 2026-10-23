import { newId } from "@pateat/contracts/ids";

// Settings profiles (ADR 0024, ADR 0076). Every statement names the owner, so one owner's
// request can never reach another owner's profile. Deleted profiles keep their row for
// the revoked devices that name them, and every read and write here skips them.

/** Every profile change advances the owner's one settings revision (ADR 0024). */
function advanceRevision(db: D1Database, ownerId: string) {
  return db
    .prepare(
      `INSERT INTO settings (owner_id, revision, document, updated_at)
      SELECT ?, 1, '{"bindings":[]}', ? WHERE changes() = 1
      ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
    )
    .bind(ownerId, Date.now());
}

export async function listProfiles(db: D1Database, ownerId: string) {
  const result = await db
    .prepare(
      "SELECT id, name FROM profiles WHERE owner_id = ? AND deleted_at IS NULL ORDER BY name, id",
    )
    .bind(ownerId)
    .all<{ id: string; name: string }>();
  return result.results;
}

export async function hasProfile(db: D1Database, ownerId: string, profileId: string) {
  return (
    (await db
      .prepare("SELECT 1 FROM profiles WHERE owner_id = ? AND id = ? AND deleted_at IS NULL")
      .bind(ownerId, profileId)
      .first()) !== null
  );
}

/**
 * Whether another live profile of the owner has the name, ignoring case, so two profiles
 * cannot look the same in a list.
 */
export async function profileNameTaken(db: D1Database, ownerId: string, name: string, except = "") {
  return (
    (await db
      .prepare(
        `SELECT 1 FROM profiles WHERE owner_id = ? AND deleted_at IS NULL AND id != ?
        AND lower(name) = lower(?)`,
      )
      .bind(ownerId, except, name)
      .first()) !== null
  );
}

/**
 * An owner with no live profile gets one named Default. Its ID is the owner's, so
 * simultaneous first pairings agree on it; the migration creates the same one.
 */
export async function ensureProfile(db: D1Database, ownerId: string) {
  await db
    .prepare(
      "INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default') ON CONFLICT DO NOTHING",
    )
    .bind(ownerId, ownerId)
    .run();
}

export type ProfileResult =
  | { ok: true; profile: { id: string; name: string } }
  | { ok: false; error: "not_found" | "profile_name_taken" };

/** A new profile holding a copy of `copyFrom`'s settings, which later edits do not follow. */
export async function copyProfile(
  db: D1Database,
  ownerId: string,
  copyFrom: string,
  name: string,
): Promise<ProfileResult> {
  if (await profileNameTaken(db, ownerId, name)) return { ok: false, error: "profile_name_taken" };
  const id = newId();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO profiles (owner_id, id, name, document)
        SELECT owner_id, ?, ?, document FROM profiles
        WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(id, name, ownerId, copyFrom),
    advanceRevision(db, ownerId),
  ]);
  return inserted?.meta.changes === 1
    ? { ok: true, profile: { id, name } }
    : { ok: false, error: "not_found" };
}

export async function renameProfile(
  db: D1Database,
  ownerId: string,
  profileId: string,
  name: string,
): Promise<ProfileResult> {
  if (await profileNameTaken(db, ownerId, name, profileId))
    return { ok: false, error: "profile_name_taken" };
  const result = await db
    .prepare("UPDATE profiles SET name = ? WHERE owner_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(name, ownerId, profileId)
    .run();
  return result.meta.changes === 1
    ? { ok: true, profile: { id: profileId, name } }
    : { ok: false, error: "not_found" };
}

export type DeleteResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "last_profile" }
  | { ok: false; error: "profile_in_use"; devices: string[] };

/**
 * Deletes a profile no device that is not revoked uses, unless it is the owner's last. A
 * device paired or moved to it meanwhile makes the conditional update change nothing.
 */
export async function deleteProfile(
  db: D1Database,
  ownerId: string,
  profileId: string,
): Promise<DeleteResult> {
  const users = await db
    .prepare(
      `SELECT label FROM devices WHERE owner_id = ? AND profile_id = ? AND revoked_at IS NULL
      ORDER BY created_at`,
    )
    .bind(ownerId, profileId)
    .all<{ label: string }>();
  if (users.results.length)
    return {
      ok: false,
      error: "profile_in_use",
      devices: users.results.map((device) => device.label),
    };
  const [deleted] = await db.batch([
    db
      .prepare(
        `UPDATE profiles SET deleted_at = ? WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM devices WHERE owner_id = ? AND profile_id = ?
          AND revoked_at IS NULL)
        AND (SELECT count(*) FROM profiles WHERE owner_id = ? AND deleted_at IS NULL) > 1`,
      )
      .bind(Date.now(), ownerId, profileId, ownerId, profileId, ownerId),
    advanceRevision(db, ownerId),
  ]);
  if (deleted?.meta.changes === 1) return { ok: true };
  if (!(await hasProfile(db, ownerId, profileId))) return { ok: false, error: "not_found" };
  const live = await listProfiles(db, ownerId);
  if (live.length <= 1) return { ok: false, error: "last_profile" };
  // A device took the profile between the check and the update.
  return deleteProfile(db, ownerId, profileId);
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
      .prepare(
        `UPDATE devices SET profile_id = ? WHERE owner_id = ? AND id = ?
        AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM profiles WHERE owner_id = ? AND id = ?
          AND deleted_at IS NULL)`,
      )
      .bind(profileId, ownerId, deviceId, ownerId, profileId),
    advanceRevision(db, ownerId),
  ]);
  return results[0]?.meta.changes === 1;
}
