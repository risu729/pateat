import {
  syncSettingsStateSchema,
  type LocalSettings,
  type SavedLoginBinding,
  type SyncSettingsState,
  type SyncSettingsWrite,
} from "@pateat/contracts";
import * as v from "valibot";
import { hasProfile } from "./profile-store";

/** Profile parts are explicit so shared bindings cannot accidentally become policy. */
export const profileDocument = (document: LocalSettings) => ({
  accountPolicies: document.accountPolicies,
  itemPolicies: document.itemPolicies,
  customFieldReviews: document.customFieldReviews,
  excludedSites: document.excludedSites,
  repromptSites: document.repromptSites,
  passkeyBrowserSites: document.passkeyBrowserSites,
  siteDefaults: document.siteDefaults,
  // Kept only while it hides the popup's page status; absent means shown.
  ...(document.popupPageSection === false && { popupPageSection: false }),
});

/**
 * The owner's parts, shared by every profile (ADR 0076): account bindings and the links
 * to the items that hold a login's personal details (ADR 0061), which name vault items
 * and fields per site as bindings do.
 */
export const ownerDocument = (document: LocalSettings) => ({
  bindings: document.bindings,
  detailLinks: document.detailLinks,
});

/**
 * Reads the profile and the owner's shared parts at the owner's revision in one statement. A
 * profile with no document of its own yet answers `newProfile`, so the first device to
 * sync it keeps its own entries (ADR 0076). For a paired device, `written` is the revision
 * of its own last stored write, read in the same statement.
 */
export async function readSettings(
  db: D1Database,
  ownerId: string,
  profileId: string,
  deviceId: string | null = null,
): Promise<SyncSettingsState> {
  const row = await db
    .prepare(`SELECT s.revision, s.document AS shared, p.document,
      (SELECT settings_revision FROM devices WHERE id = ? AND owner_id = p.owner_id) AS written
    FROM profiles p LEFT JOIN settings s ON s.owner_id = p.owner_id
    WHERE p.owner_id = ? AND p.id = ? AND p.deleted_at IS NULL`)
    .bind(deviceId, ownerId, profileId)
    .first<{
      revision: number | null;
      shared: string | null;
      document: string | null;
      written: number | null;
    }>();
  if (!row) throw new Error("profile-not-found");
  const shared: Partial<ReturnType<typeof ownerDocument>> = row.shared
    ? JSON.parse(row.shared)
    : { bindings: [] };
  const profile = {
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [],
    repromptSites: [],
    siteDefaults: [],
    ...(row.document ? JSON.parse(row.document) : {}),
  };
  return v.parse(syncSettingsStateSchema, {
    version: 1,
    profileId,
    revision: row.revision ?? 0,
    settings: row.revision
      ? {
          connections: [],
          ...profile,
          bindings: shared.bindings,
          ...(shared.detailLinks ? { detailLinks: shared.detailLinks } : {}),
        }
      : null,
    ...(row.revision && !row.document ? { newProfile: true } : {}),
    ...(row.written === null ? {} : { written: row.written }),
  });
}

/**
 * The slots of the owner's saved bindings for one recipe of one origin, every account's,
 * for naming a generated page's custom-field slots (ADR 0027, amended 2026-10-19): only
 * slot names and field references, never the item or account a binding names. Bindings
 * are shared by every profile.
 */
export async function recipeBindingSlots(
  db: D1Database,
  ownerId: string,
  origin: string,
  recipeId: string,
): Promise<Pick<SavedLoginBinding, "slots">[]> {
  const row = await db
    .prepare("SELECT document FROM settings WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ document: string | null }>();
  const bindings: SavedLoginBinding[] = row?.document
    ? (JSON.parse(row.document).bindings ?? [])
    : [];
  return bindings.flatMap((binding) =>
    binding.origin === origin && binding.recipeId === recipeId ? [{ slots: binding.slots }] : [],
  );
}

/**
 * One owner revision covers the owner's shared parts and every profile. D1 batches are
 * atomic.
 */
export async function writeSettings(
  db: D1Database,
  ownerId: string,
  profileId: string,
  write: SyncSettingsWrite,
  writer: string | null,
): Promise<
  | { ok: true; state: SyncSettingsState }
  /** `current` is missing when the profile was deleted meanwhile. */
  | { ok: false; current: SyncSettingsState | undefined }
> {
  // A write without `detailLinks` keeps the stored ones: the key is optional, so a client
  // that predates it (or leaves it out) must not delete every device's links. They are
  // read at the expected revision; any later write changes the revision, so the batch
  // below then loses its compare-and-swap and stores nothing.
  const settings = write.settings.detailLinks
    ? write.settings
    : await withStoredDetailLinks(db, ownerId, write.expectedRevision, write.settings);
  // Both statements use the exact same compare-and-swap predicate. The profile write
  // runs first; changes() gates the revision write so losing writers update neither, and
  // the revision write's changes() gates the writing device's record of it (`written`).
  const results = await db.batch([
    db
      .prepare(`UPDATE profiles SET document = ? WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
      AND COALESCE((SELECT revision FROM settings WHERE owner_id = ?), 0) = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM devices WHERE id = ? AND owner_id = ? AND profile_id = ?))`)
      .bind(
        JSON.stringify(profileDocument(write.settings)),
        ownerId,
        profileId,
        ownerId,
        write.expectedRevision,
        writer,
        writer,
        ownerId,
        profileId,
      ),
    db
      .prepare(`INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id)
      SELECT ?, ?, ?, ?, ? WHERE changes() = 1
      ON CONFLICT(owner_id) DO UPDATE SET revision = excluded.revision,
        document = excluded.document, updated_at = excluded.updated_at,
        updated_by_device_id = excluded.updated_by_device_id`)
      .bind(
        ownerId,
        write.expectedRevision + 1,
        JSON.stringify(ownerDocument(settings)),
        Date.now(),
        writer,
      ),
    db
      .prepare(
        "UPDATE devices SET settings_revision = ? WHERE id = ? AND owner_id = ? AND changes() = 1",
      )
      .bind(write.expectedRevision + 1, writer, ownerId),
  ]);
  if (results[1]?.meta.changes !== 1) {
    const currentProfile = writer
      ? await db
          .prepare("SELECT profile_id FROM devices WHERE owner_id = ? AND id = ?")
          .bind(ownerId, writer)
          .first<{ profile_id: string }>()
      : null;
    const target = currentProfile?.profile_id ?? profileId;
    return {
      ok: false,
      current: (await hasProfile(db, ownerId, target))
        ? await readSettings(db, ownerId, target, writer)
        : undefined,
    };
  }
  return {
    ok: true,
    state: {
      version: 1,
      profileId,
      revision: write.expectedRevision + 1,
      settings,
      ...(writer === null ? {} : { written: write.expectedRevision + 1 }),
    },
  };
}

/** `settings` with the owner's stored detail links at `revision`, when it has any. */
async function withStoredDetailLinks(
  db: D1Database,
  ownerId: string,
  revision: number,
  settings: LocalSettings,
): Promise<LocalSettings> {
  const row = await db
    .prepare("SELECT document FROM settings WHERE owner_id = ? AND revision = ?")
    .bind(ownerId, revision)
    .first<{ document: string }>();
  const stored: Partial<ReturnType<typeof ownerDocument>> | undefined = row
    ? JSON.parse(row.document)
    : undefined;
  return stored?.detailLinks ? { ...settings, detailLinks: stored.detailLinks } : settings;
}
