import * as v from "valibot";
import {
  connectionAccount,
  createDefaultSettings,
  customFieldReviewFor,
  customFieldReviewState,
  DUMMY_VAULT_CATALOG,
  itemPolicyFor,
  localSettingsSchema,
  SETTINGS_CHANGE_HISTORY,
  settingsRequestSchema,
  settingsSnapshotSchema,
  type LocalSettings,
  type SettingsChangeCause,
  type SettingsConflictCause,
  type SettingsError,
  type SettingsResponse,
  type SettingsRequest,
  type VaultCatalog,
  type SettingsSnapshot,
} from "./settings";

export interface SettingsStorage {
  read(): Promise<unknown>;
  write(snapshot: unknown): Promise<void>;
}

function failure(code: SettingsError["code"], message: string): SettingsResponse {
  return { version: 1, ok: false, error: { code, message } };
}

/** `snapshot`'s change history with the cause of `revision` added, keeping the latest. */
function recordChange(
  snapshot: SettingsSnapshot,
  revision: number,
  cause: SettingsChangeCause,
): NonNullable<SettingsSnapshot["changes"]> {
  return [...(snapshot.changes ?? []), { revision, cause }].slice(-SETTINGS_CHANGE_HISTORY);
}

/**
 * Why `current` is no longer the revision a save expected, oldest cause first. The
 * settings page also reads it from a newer snapshot before retrying a save (ADR 0025).
 */
export function conflictCauses(
  current: SettingsSnapshot,
  expected: number,
): SettingsConflictCause[] {
  const recorded = (current.changes ?? []).filter(
    (entry) => entry.revision > expected && entry.revision <= current.revision,
  );
  const causes = [...new Set(recorded.map((entry) => entry.cause))];
  // Revisions older than the kept history, or a store behind the expected revision, as
  // after storage was cleared, have no recorded cause.
  return current.revision - expected > recorded.length || expected > current.revision
    ? ["unknown", ...causes]
    : causes;
}

const isCustom = (reference: LocalSettings["itemPolicies"][number]["excludedFields"][number]) =>
  typeof reference !== "string";

/**
 * A settings page save, applied to the stored settings (ADR 0023). Custom-field review
 * state changes only through a review, so the stored review records are kept; an item
 * waiting for review or for a vault sync keeps its custom-field exclusions as stored; and
 * an item's first custom-field exclusion records its current evidence as reviewed, but
 * only when the page's draft was edited against the snapshot that evidence belongs to
 * (`shown`). Otherwise the item waits for review, so a record never vouches for custom
 * fields the page did not show.
 */
function reviewedSettings(
  stored: LocalSettings,
  next: LocalSettings,
  catalog: VaultCatalog,
  shown: readonly { connectionId: string; snapshotId: string }[],
): LocalSettings {
  const settings = structuredClone({ ...next, customFieldReviews: stored.customFieldReviews });
  for (const connection of catalog.connections) {
    const resolved = connectionAccount(stored, catalog, connection.id);
    if (!resolved.ok) continue;
    const { account } = resolved;
    for (const item of connection.items) {
      const state = customFieldReviewState(stored, account, item);
      if (state === "review-required" || state === "vault-stale") {
        const prior = itemPolicyFor(stored, account, item.id);
        const kept = (prior?.excludedFields ?? []).filter(isCustom);
        const policy = itemPolicyFor(settings, account, item.id);
        if (policy)
          policy.excludedFields = [
            ...policy.excludedFields.filter((ref) => !isCustom(ref)),
            ...kept,
          ];
        else if (prior && kept.length)
          settings.itemPolicies.push({
            ...prior,
            selected: false,
            excluded: false,
            excludedFields: kept,
          });
        continue;
      }
      const policy = itemPolicyFor(settings, account, item.id);
      const shownSnapshot = shown.find((entry) => entry.connectionId === connection.id);
      if (
        policy?.excludedFields.some(isCustom) &&
        connection.snapshotId !== undefined &&
        shownSnapshot?.snapshotId === connection.snapshotId &&
        // The record built so far: an account connected twice is recorded once.
        !customFieldReviewFor(settings, account, item.id) &&
        item.evidence !== undefined &&
        item.revisionDate !== undefined
      )
        settings.customFieldReviews.push({
          ...account,
          itemId: item.id,
          evidence: item.evidence,
          revisionDate: item.revisionDate,
        });
    }
  }
  return settings;
}

const settingsEntries = localSettingsSchema.pipe[0].entries;
const snapshotEntries = settingsSnapshotSchema.entries;
/** The settings that decide where Pateat acts at all; never rebuilt from defaults. */
const SAFETY_PARTS = new Set<string>(["excludedSites", "repromptSites"]);

/**
 * Settings this build cannot read, as an older build wrote them before the settings shape
 * changed (owner rule: no backward compatibility for Pateat's own data), rebuilt from the
 * parts that still read, entry by entry, and `defaults` for the rest, so a shape change
 * never stops every login. A list entry that no longer reads, such as an account
 * reference without its server, is left out; a part that is not a list of entries, or a
 * list still over its limits, is not. A vault connection's entry keeps only
 * whether it is used, and only when it used every item with nothing excluded; the
 * account's policy then follows from it as for a newly added connection. Undefined, so
 * the settings stay refused, for a part this build does not know, such a part or list,
 * a site exclusion or re-prompt list that does not read, or a result that does not.
 */
export function rebuiltSettings(
  parts: unknown,
  defaults: LocalSettings,
): LocalSettings | undefined {
  if (typeof parts !== "object" || parts === null || Array.isArray(parts)) return undefined;
  const old = parts as Record<string, unknown>;
  if (Object.keys(old).some((key) => !(key in settingsEntries))) return undefined;
  const settings: Record<string, unknown> = { ...defaults };
  for (const [key, schema] of Object.entries(settingsEntries)) {
    if (!(key in old)) continue;
    const value = old[key];
    const whole = v.safeParse(schema, value);
    if (whole.success) settings[key] = whole.output;
    else if (SAFETY_PARTS.has(key)) return undefined;
    else if (key === "connections" && Array.isArray(value))
      settings[key] = value.flatMap((entry: unknown) => {
        const parsed = v.safeParse(olderConnectionSchema, entry);
        if (!parsed.success) return [];
        const { connectionId, enabled, selection, excludedItemIds, excludedFields } = parsed.output;
        const unrestricted =
          selection?.mode !== "selected" && !excludedItemIds?.length && !excludedFields?.length;
        return [{ connectionId, enabled: enabled && unrestricted }];
      });
    else {
      const item = entrySchema(schema);
      const parsed =
        Array.isArray(value) && item
          ? v.safeParse(
              schema,
              value.filter((entry: unknown) => v.is(item, entry)),
            )
          : undefined;
      // Only entries are left out: a part that is no list, or a list over its limits.
      if (!parsed?.success) return undefined;
      settings[key] = parsed.output;
    }
  }
  const parsed = v.safeParse(localSettingsSchema, settings);
  return parsed.success ? parsed.output : undefined;
}

/** A stored snapshot an older build wrote, with its settings rebuilt (`rebuiltSettings`). */
function rebuiltSnapshot(stored: unknown, catalog: VaultCatalog): SettingsSnapshot | undefined {
  if (typeof stored !== "object" || stored === null) return undefined;
  const record = stored as Record<string, unknown>;
  if (
    record["version"] !== 1 ||
    !v.is(snapshotEntries.revision, record["revision"]) ||
    // A part this build does not know is not one an older build wrote.
    Object.keys(record).some((key) => !(key in snapshotEntries) && key !== "fieldPolicies")
  )
    return undefined;
  const settings = rebuiltSettings(record["settings"], createDefaultSettings(catalog));
  if (!settings) return undefined;
  const snapshot = {
    version: 1,
    revision: record["revision"],
    settings,
    ...(v.is(snapshotEntries.changes, record["changes"]) ? { changes: record["changes"] } : {}),
  };
  const parsed = v.safeParse(settingsSnapshotSchema, snapshot);
  return parsed.success ? parsed.output : undefined;
}
/** The schema of one entry of a settings list, through its optional and pipe wrappers. */
function entrySchema(schema: unknown): v.GenericSchema | undefined {
  let current = schema as { type?: string; wrapped?: unknown; pipe?: unknown[]; item?: unknown };
  if (current.type === "optional") current = current.wrapped as typeof current;
  if (current.pipe) current = current.pipe[0] as typeof current;
  return current.type === "array" ? (current.item as v.GenericSchema) : undefined;
}
/** A vault connection's entry as builds before ADR 0023's account policies wrote it. */
const olderConnectionSchema = v.object({
  connectionId: v.string(),
  enabled: v.boolean(),
  selection: v.optional(v.object({ mode: v.string() })),
  excludedItemIds: v.optional(v.array(v.unknown())),
  excludedFields: v.optional(v.array(v.unknown())),
});

/** One worker-owned queue serializes read/check/write; no other context writes storage. */
export function createSettingsStore(
  storage: SettingsStorage,
  catalogSource:
    | VaultCatalog
    | ((snapshot: SettingsSnapshot) => Promise<VaultCatalog>) = DUMMY_VAULT_CATALOG,
  initialCatalog: VaultCatalog = typeof catalogSource === "function"
    ? { connections: [] }
    : catalogSource,
) {
  let queue: Promise<unknown> = Promise.resolve();
  class CorruptSettings extends Error {}
  async function readSnapshot(): Promise<SettingsSnapshot> {
    const stored = await storage.read();
    if (stored !== undefined) {
      const checked = v.safeParse(settingsSnapshotSchema, stored);
      if (checked.success) return checked.output;
      const rebuilt = rebuiltSnapshot(stored, initialCatalog);
      if (!rebuilt) throw new CorruptSettings();
      return rebuilt;
    }
    return { version: 1, revision: 0, settings: createDefaultSettings(initialCatalog) };
  }
  async function catalogFor(snapshot: SettingsSnapshot) {
    return typeof catalogSource === "function" ? catalogSource(snapshot) : catalogSource;
  }
  async function execute(request: SettingsRequest): Promise<SettingsResponse> {
    try {
      let snapshot: SettingsSnapshot;
      try {
        snapshot = await readSnapshot();
      } catch (error) {
        return error instanceof CorruptSettings
          ? failure("storage-corrupt", "Stored settings are invalid. They were not replaced.")
          : failure("storage-unavailable", "Local settings storage is unavailable.");
      }
      if (request.type === "settings.save") {
        if (request.expectedRevision !== snapshot.revision)
          return {
            version: 1,
            ok: false,
            error: {
              code: "revision-conflict",
              message: "Saved settings changed. Reload before saving.",
              causes: conflictCauses(snapshot, request.expectedRevision),
            },
          };
        if (snapshot.revision >= Number.MAX_SAFE_INTEGER - 1)
          return failure("storage-corrupt", "The settings revision cannot be advanced.");
        const displayed = await catalogFor(snapshot);
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          settings: reviewedSettings(
            snapshot.settings,
            request.settings,
            displayed,
            request.shownSnapshots ?? [],
          ),
          changes: recordChange(snapshot, snapshot.revision + 1, "settings-save"),
        };
        const finalSnapshot = v.safeParse(settingsSnapshotSchema, snapshot);
        if (!finalSnapshot.success)
          return failure(
            "invalid-settings",
            "The kept custom-field exclusions exceed the supported settings limits.",
          );
        snapshot = finalSnapshot.output;
        await storage.write(snapshot);
      }
      return { version: 1, ok: true, snapshot, catalog: await catalogFor(snapshot) };
    } catch {
      return failure("storage-unavailable", "Local settings storage is unavailable.");
    }
  }
  async function executeUpdate(
    expectedRevision: number | undefined,
    cause: SettingsChangeCause,
    mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ) {
    const current = await readSnapshot();
    if (expectedRevision !== undefined && expectedRevision !== current.revision)
      throw new Error("revision-conflict");
    if (current.revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error("storage-corrupt");
    const next = v.parse(settingsSnapshotSchema, mutate(structuredClone(current)));
    next.revision = current.revision + 1;
    // The store owns the history; a mutation cannot rewrite or drop it.
    next.changes = recordChange(current, next.revision, cause);
    await storage.write(next);
    return next;
  }
  return {
    /** Background metadata read without loading the vault catalog. */
    read(): Promise<SettingsSnapshot> {
      const pending = queue.then(readSnapshot);
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    /**
     * Trusted background-only mutation; the options save contract cannot change field
     * policies. `cause` is recorded for a later save's revision conflict.
     */
    update(
      expectedRevision: number | undefined,
      cause: SettingsChangeCause,
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
    ): Promise<SettingsSnapshot> {
      const pending = queue.then(() => executeUpdate(expectedRevision, cause, mutate));
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    handle(value: unknown): Promise<SettingsResponse> {
      // Parse synchronously to detach the queued request from its caller's mutable data.
      const request = v.safeParse(settingsRequestSchema, value);
      if (!request.success) {
        const isSave =
          value !== null &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "settings.save";
        return Promise.resolve(
          failure(
            isSave ? "invalid-settings" : "invalid-request",
            "The settings request did not match the supported schema.",
          ),
        );
      }
      const pending = queue.then(() => execute(request.output));
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
