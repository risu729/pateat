import {
  deviceIdSchema,
  localSettingsSchema,
  serviceOriginSchema,
  type LocalSettings,
  type SettingsSnapshot,
  type SyncSettingsState,
} from "@pateat/contracts";
import * as v from "valibot";
import type { ServiceConnection } from "./runtime";
import type { ServiceTransport, TransportFailure } from "./transport";

/** Conflicting writes are retried this many times in one sync before giving up. */
export const MAX_SETTINGS_SYNC_ATTEMPTS = 3;
/** The service accepts request bodies up to 128 KiB; the document leaves room for the rest. */
export const MAX_SETTINGS_DOCUMENT_BYTES = 120 * 1024;

const encoder = new TextEncoder();

type SiteDefault = LocalSettings["siteDefaults"][number];
type AccountDefault = Extract<SiteDefault, { provider: string }>;
type ExcludedSite = LocalSettings["excludedSites"][number];
type Binding = NonNullable<LocalSettings["bindings"]>[number];

/**
 * The part of the settings that means the same on every device (ADR 0013). Vault
 * connections, item selection, field exclusions and legacy site defaults that name a
 * device-local connection ID stay on this device.
 */
export type SyncedSettings = {
  excludedSites: ExcludedSite[];
  siteDefaults: AccountDefault[];
  bindings: Binding[];
};

const accountDefault = (entry: SiteDefault): entry is AccountDefault => "provider" in entry;

export function syncedSettings(settings: LocalSettings): SyncedSettings {
  return {
    excludedSites: settings.excludedSites,
    siteDefaults: settings.siteDefaults.filter(accountDefault),
    bindings: settings.bindings ?? [],
  };
}

const emptySynced: SyncedSettings = { excludedSites: [], siteDefaults: [], bindings: [] };

// What this device and the service last agreed on: the base of the next three-way merge.
const baseSchema = v.strictObject({
  version: v.literal(1),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The synced part as the service document holds it, with no connections. */
  settings: localSettingsSchema,
});
type SettingsBase = v.InferOutput<typeof baseSchema>;

export interface SettingsBaseStorage {
  read(): Promise<unknown>;
  write(base: SettingsBase): Promise<void>;
  clear(): Promise<void>;
}

export type SettingsSyncOutcome =
  | "synced"
  | "rejected"
  /**
   * Local or service settings kept changing, or a login was in progress; the next sync
   * merges again.
   */
  | "busy"
  /** The merge exceeds the settings limits; neither side was changed. */
  | "too-large"
  | "storage-unavailable"
  | TransportFailure;

const siteKey = (entry: ExcludedSite) => entry.hostname;
const defaultKey = (entry: AccountDefault) => entry.origin;
const bindingKey = (entry: Binding) =>
  JSON.stringify([entry.recipeId, entry.origin, entry.provider, entry.userId, entry.itemId]);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Per entry, a side that changed since the base wins; when both changed, the service
 * wins, because it is the source of truth (ADR 0013). Removing an entry is a change.
 */
function mergeEntries<T>(base: T[], local: T[], service: T[], key: (entry: T) => string): T[] {
  const index = (entries: T[]) => new Map(entries.map((entry) => [key(entry), entry]));
  const [b, l, s] = [index(base), index(local), index(service)];
  const merged: T[] = [];
  for (const id of new Set([...s.keys(), ...l.keys(), ...b.keys()])) {
    const entry = same(s.get(id), b.get(id)) ? l.get(id) : s.get(id);
    if (entry !== undefined) merged.push(entry);
  }
  return merged;
}

export function mergeSyncedSettings(
  base: SyncedSettings,
  local: SyncedSettings,
  service: SyncedSettings,
): SyncedSettings {
  return {
    excludedSites: mergeEntries(
      base.excludedSites,
      local.excludedSites,
      service.excludedSites,
      siteKey,
    ),
    siteDefaults: mergeEntries(
      base.siteDefaults,
      local.siteDefaults,
      service.siteDefaults,
      defaultKey,
    ),
    bindings: mergeEntries(base.bindings, local.bindings, service.bindings, bindingKey),
  };
}

/** Order-insensitive comparison, so a reordered copy is not a change. */
function equalSynced(left: SyncedSettings, right: SyncedSettings): boolean {
  const sorted = <T>(entries: T[], key: (entry: T) => string) =>
    entries.map((entry) => [key(entry), entry] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    same(sorted(left.excludedSites, siteKey), sorted(right.excludedSites, siteKey)) &&
    same(sorted(left.siteDefaults, defaultKey), sorted(right.siteDefaults, defaultKey)) &&
    same(sorted(left.bindings, bindingKey), sorted(right.bindings, bindingKey))
  );
}

/** Local settings with the synced part replaced; a legacy default yields to a synced one. */
function applySynced(settings: LocalSettings, synced: SyncedSettings): LocalSettings {
  const origins = new Set(synced.siteDefaults.map((entry) => entry.origin));
  return {
    ...settings,
    excludedSites: synced.excludedSites,
    siteDefaults: [
      ...settings.siteDefaults.filter(
        (entry) => !accountDefault(entry) && !origins.has(entry.origin),
      ),
      ...synced.siteDefaults,
    ],
    bindings: synced.bindings,
  };
}

/** The service holds only the synced part; it never stores device-local connections. */
const serviceDocument = (synced: SyncedSettings): LocalSettings => ({ connections: [], ...synced });

export function createSettingsSync(options: {
  transport: Pick<ServiceTransport, "settings" | "saveSettings">;
  /** The local settings store; writes go through its revision check. */
  settings: {
    read(): Promise<SettingsSnapshot>;
    update(
      expectedRevision: number | undefined,
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
    ): Promise<SettingsSnapshot>;
  };
  storage: SettingsBaseStorage;
  /** Called after synced changes are written to the local settings. */
  applied?: () => void;
  /** Whether a local settings write must wait, for example while a login runs. */
  deferred?: () => boolean;
}) {
  const { transport, settings, storage } = options;

  async function loadBase(connection: ServiceConnection): Promise<SettingsBase | undefined> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      return undefined;
    }
    const parsed = v.safeParse(baseSchema, stored);
    return parsed.success &&
      parsed.output.origin === connection.origin &&
      parsed.output.deviceId === connection.deviceId
      ? parsed.output
      : undefined;
  }

  /**
   * One three-way merge of local and service settings for this paired device. `stale`
   * reports a disconnect meanwhile; nothing is written for a device that is gone.
   */
  async function run(
    connection: ServiceConnection,
    stale: () => boolean,
  ): Promise<SettingsSyncOutcome> {
    const { origin, credential } = connection;
    const stored = await loadBase(connection);
    const fetched = await transport.settings(origin, credential);
    if (fetched.kind === "rejected") return "rejected";
    if (fetched.kind === "failed") return fetched.error;
    if (fetched.kind !== "state") return "unexpected-response";
    let service: SyncSettingsState = fetched.state;
    // Without a base, for a new pairing or a service restored to an older revision, both
    // sides' entries are kept and the service wins where they differ; nothing is removed.
    const base =
      stored && service.revision >= stored.revision ? syncedSettings(stored.settings) : emptySynced;
    for (let attempt = 0; attempt < MAX_SETTINGS_SYNC_ATTEMPTS; attempt += 1) {
      let local: SettingsSnapshot;
      try {
        // oxlint-disable-next-line no-await-in-loop -- each attempt merges the latest copies
        local = await settings.read();
      } catch {
        return "storage-unavailable";
      }
      const localSynced = syncedSettings(local.settings);
      const serviceSynced = service.settings ? syncedSettings(service.settings) : emptySynced;
      const merged = mergeSyncedSettings(base, localSynced, serviceSynced);
      const next = v.safeParse(localSettingsSchema, applySynced(local.settings, merged));
      if (
        !v.safeParse(localSettingsSchema, serviceDocument(merged)).success ||
        encoder.encode(JSON.stringify(serviceDocument(merged))).byteLength >
          MAX_SETTINGS_DOCUMENT_BYTES ||
        !next.success
      )
        return "too-large";
      if (stale()) return "busy";
      if (!equalSynced(merged, serviceSynced)) {
        // oxlint-disable-next-line no-await-in-loop -- a conflict retries with its state
        const saved = await transport.saveSettings(origin, credential, {
          version: 1,
          expectedRevision: service.revision,
          settings: serviceDocument(merged),
        });
        if (saved.kind === "rejected") return "rejected";
        if (saved.kind === "failed") return saved.error;
        if (saved.kind === "conflict") {
          service = saved.current;
          continue;
        }
        // A retry below keeps the old base: local settings do not hold the merge yet, so
        // their pre-merge entries are not edits.
        service = saved.state;
      }
      if (stale()) return "busy";
      if (!equalSynced(merged, localSynced)) {
        // A policy write now would stop a login in progress; the next sync applies it.
        if (options.deferred?.()) return "busy";
        try {
          // oxlint-disable-next-line no-await-in-loop -- the write must follow the merge
          await settings.update(local.revision, (snapshot) => ({
            ...snapshot,
            settings: v.parse(localSettingsSchema, applySynced(snapshot.settings, merged)),
          }));
        } catch (error) {
          // Settings changed locally while merging; merge again with that change.
          if (error instanceof Error && error.message === "revision-conflict") continue;
          return "storage-unavailable";
        }
        options.applied?.();
      }
      if (stale()) return "busy";
      try {
        // oxlint-disable-next-line no-await-in-loop -- recorded only after both sides agree
        await storage.write({
          version: 1,
          origin,
          deviceId: connection.deviceId,
          revision: service.revision,
          settings: serviceDocument(merged),
        });
      } catch {
        // The next sync merges from the older base; both sides already match.
      }
      return "synced";
    }
    return "busy";
  }

  async function clear() {
    await storage.clear().catch(() => undefined);
  }

  return { run, clear };
}
