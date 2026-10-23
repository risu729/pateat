import * as v from "valibot";
import {
  connectionAccount,
  createDefaultSettings,
  customFieldReviewFor,
  customFieldReviewState,
  DUMMY_VAULT_CATALOG,
  itemPolicyFor,
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
      if (!checked.success) throw new CorruptSettings();
      return checked.output;
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
