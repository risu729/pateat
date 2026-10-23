import {
  deviceIdSchema,
  localSettingsSchema,
  MAX_SETTINGS_DOCUMENT_BYTES,
  savedLoginBindingSchema,
  settingsDocumentBytes,
  serviceOriginSchema,
  siteDefaultConnection,
  siteDefaultSchema,
  type LocalSettings,
  type SettingsSnapshot,
  type SyncSettingsState,
  type VaultCatalog,
} from "@pateat/contracts";
import * as v from "valibot";
import type { ServiceConnection } from "./runtime";
import type { ServiceTiming, ServiceTransport, TransportFailure } from "./transport";

/** Conflicting writes are retried this many times in one sync before giving up. */
export const MAX_SETTINGS_SYNC_ATTEMPTS = 3;
/**
 * A local write waits for a running login at most this long; a login left unfinished on
 * an open page must not hold synced settings back indefinitely.
 */
export const MAX_SETTINGS_DEFER_MS = 2 * 60 * 1000;

type SiteDefault = LocalSettings["siteDefaults"][number];
type ExcludedSite = LocalSettings["excludedSites"][number];
type Binding = LocalSettings["bindings"][number];

/**
 * The part of the settings that means the same on every device (ADR 0013). Vault
 * connections, item selection and field exclusions stay on this device.
 */
export type SyncedSettings = {
  excludedSites: ExcludedSite[];
  siteDefaults: SiteDefault[];
  /**
   * Automatic login in private windows, absent while off (ADR 0062). Like the sites' rules
   * it says how this profile's browsers log in, so it is synced (ADR 0024).
   */
  loginInPrivateWindows?: true;
  bindings: Binding[];
};

export function syncedSettings(settings: LocalSettings): SyncedSettings {
  return {
    excludedSites: settings.excludedSites,
    siteDefaults: settings.siteDefaults,
    ...(settings.loginInPrivateWindows ? { loginInPrivateWindows: true } : {}),
    bindings: settings.bindings,
  };
}

const emptySynced: SyncedSettings = { excludedSites: [], siteDefaults: [], bindings: [] };

// The base of the next three-way merge. Normally both copies are the same; after an
// upload whose local write has not happened yet, `local` is still the local copy the
// merge started from, so the merged entries it lacks are not mistaken for local edits.
const baseSchema = v.strictObject({
  version: v.literal(1),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The service document at `revision`, which has no connections. */
  settings: localSettingsSchema,
  /** The synced part of the local settings that `settings` already accounts for. */
  local: localSettingsSchema,
});
type SettingsBase = v.InferOutput<typeof baseSchema>;

export interface SettingsBaseStorage {
  read(): Promise<unknown>;
  write(base: SettingsBase): Promise<void>;
  clear(): Promise<void>;
}

/** When a local write first waited for a login, kept across service worker restarts. */
export interface SettingsHoldStorage {
  read(): Promise<unknown>;
  write(since: number): Promise<void>;
  clear(): Promise<void>;
}

const holdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

function memoryHold(): SettingsHoldStorage {
  let since: number | undefined;
  return {
    read: async () => since,
    write: async (next) => {
      since = next;
    },
    clear: async () => {
      since = undefined;
    },
  };
}

export type SettingsSyncOutcome =
  | "synced"
  | "rejected"
  /**
   * Local or service settings kept changing, or a login was in progress; the next sync
   * merges again.
   */
  | "busy"
  /** The merge exceeds the settings limits; it was not applied. */
  | "too-large"
  | "storage-unavailable"
  | TransportFailure;

const siteKey = (entry: ExcludedSite) => entry.hostname;
const defaultKey = (entry: SiteDefault) => entry.origin;
const bindingKey = (entry: Binding) =>
  JSON.stringify([entry.recipeId, entry.origin, entry.provider, entry.userId, entry.itemId]);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** What each side last agreed to: the service's copy and the local copy it accounts for. */
export type SyncBase = { service: SyncedSettings; local: SyncedSettings };

/**
 * One value merged as an entry is: the service's copy wins when it changed since the
 * base, else a local change, else the service's copy.
 */
function mergeValue<T>(base: { service: T; local: T }, local: T, service: T): T {
  return same(service, base.service) && !same(local, base.local) ? local : service;
}

/**
 * Per entry, the service's copy wins when it changed since the base, because the service
 * is the source of truth (ADR 0013); otherwise a local change wins; otherwise the
 * service's copy stands, which also applies a merge not yet written locally. Removing
 * an entry is a change.
 */
function mergeEntries<T>(
  base: { service: T[]; local: T[] },
  local: T[],
  service: T[],
  key: (entry: T) => string,
): T[] {
  const index = (entries: T[]) => new Map(entries.map((entry) => [key(entry), entry]));
  const [bs, bl, l, s] = [index(base.service), index(base.local), index(local), index(service)];
  const merged: T[] = [];
  for (const id of new Set([...s.keys(), ...l.keys(), ...bs.keys(), ...bl.keys()])) {
    const entry =
      same(s.get(id), bs.get(id)) && !same(l.get(id), bl.get(id)) ? l.get(id) : s.get(id);
    if (entry !== undefined) merged.push(entry);
  }
  return merged;
}

export function mergeSyncedSettings(
  base: SyncBase,
  local: SyncedSettings,
  service: SyncedSettings,
): SyncedSettings {
  const part = <K extends keyof SyncedSettings>(name: K) => ({
    service: base.service[name],
    local: base.local[name],
  });
  return {
    excludedSites: mergeEntries(
      part("excludedSites"),
      local.excludedSites,
      service.excludedSites,
      siteKey,
    ),
    siteDefaults: mergeEntries(
      part("siteDefaults"),
      local.siteDefaults,
      service.siteDefaults,
      defaultKey,
    ),
    ...(mergeValue(
      part("loginInPrivateWindows"),
      local.loginInPrivateWindows,
      service.loginInPrivateWindows,
    )
      ? { loginInPrivateWindows: true }
      : {}),
    bindings: mergeEntries(part("bindings"), local.bindings, service.bindings, bindingKey),
  };
}

/**
 * Display names from this device's catalog: an entry whose provider account is connected
 * here exactly once gains that connection's label as its account name and the item's
 * label as its item name, each only when the entry has none. Another device may label the
 * same account differently, or still hold an older item label until its vault syncs, so a
 * name already set is kept; overwriting it would make two devices rewrite each other on
 * every sync. Entries of an account that is not connected here, connected twice, locked
 * or unavailable keep their names. Login usernames are never copied. Unchanged entries keep
 * their identity, so an unchanged sync writes nothing.
 */
export function refreshDisplayNames(synced: SyncedSettings, catalog: VaultCatalog): SyncedSettings {
  function refresh<T extends SiteDefault | Binding>(entry: T, schema: v.GenericSchema<T>): T {
    const mapped = siteDefaultConnection(entry, catalog);
    const connection =
      mapped.ok && catalog.connections.find((item) => item.id === mapped.connectionId);
    if (!connection || connection.state === "locked" || connection.state === "unavailable")
      return entry;
    const accountName = entry.accountName ?? connection.label;
    const itemName =
      entry.itemName ?? connection.items.find((item) => item.id === entry.itemId)?.label;
    if (accountName === entry.accountName && itemName === entry.itemName) return entry;
    // Parsing keeps the schema's key order, which the merge compares.
    const next = v.safeParse(schema, {
      ...entry,
      accountName,
      ...(itemName === undefined ? {} : { itemName }),
    });
    return next.success ? next.output : entry;
  }
  return {
    ...synced,
    excludedSites: synced.excludedSites,
    siteDefaults: synced.siteDefaults.map((entry) => refresh(entry, siteDefaultSchema)),
    bindings: synced.bindings.map((entry) => refresh(entry, savedLoginBindingSchema)),
  };
}

/** Whether a site default or binding still lacks a display name. */
const unnamed = (synced: SyncedSettings) =>
  [...synced.siteDefaults, ...synced.bindings].some(
    (entry) => entry.accountName === undefined || entry.itemName === undefined,
  );

/** Order-insensitive comparison, so a reordered copy is not a change. */
function equalSynced(left: SyncedSettings, right: SyncedSettings): boolean {
  const sorted = <T>(entries: T[], key: (entry: T) => string) =>
    entries.map((entry) => [key(entry), entry] as const).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    same(sorted(left.excludedSites, siteKey), sorted(right.excludedSites, siteKey)) &&
    same(sorted(left.siteDefaults, defaultKey), sorted(right.siteDefaults, defaultKey)) &&
    left.loginInPrivateWindows === right.loginInPrivateWindows &&
    same(sorted(left.bindings, bindingKey), sorted(right.bindings, bindingKey))
  );
}

/** Local settings with the synced part replaced. */
function applySynced(settings: LocalSettings, synced: SyncedSettings): LocalSettings {
  // A setting turned off is the absent field, so the local copy's field goes as well.
  const { loginInPrivateWindows: _off, ...rest } = settings;
  return { ...rest, ...synced };
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
  /** Without it, the wait for a login is bounded only within one service worker. */
  hold?: SettingsHoldStorage;
  /** Called after synced changes are written to the local settings. */
  applied?: () => void;
  /** Whether a local settings write must wait, for example while a login runs. */
  deferred?: () => boolean | Promise<boolean>;
  /**
   * This device's vault catalog, which names synced entries for display; without one,
   * or when it fails, names are left as they are.
   */
  catalog?: () => Promise<VaultCatalog | undefined>;
  now?: () => number;
}) {
  const { transport, settings, storage } = options;
  const now = options.now ?? Date.now;
  const hold = options.hold ?? memoryHold();

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
   * reports a disconnect meanwhile; nothing is written for a device that is gone. `timed`
   * is told how long each request took, for the sync's log entry (ADR 0019).
   */
  async function run(
    connection: ServiceConnection,
    stale: () => boolean,
    timed?: (timing: ServiceTiming | undefined) => void,
  ): Promise<SettingsSyncOutcome> {
    const { origin, credential, deviceId } = connection;
    // A wait that started for an earlier login does not shorten the wait for a later one.
    if (!(await options.deferred?.())) await release();
    const stored = await loadBase(connection);
    const fetched = await transport.settings(origin, credential);
    timed?.(fetched.timing);
    if (fetched.kind === "rejected") return "rejected";
    if (fetched.kind === "failed") return fetched.error;
    if (fetched.kind !== "state") return "unexpected-response";
    let service: SyncSettingsState = fetched.state;
    // Read only when an entry lacks a name: building the catalog restores the vaults.
    let catalog: Promise<VaultCatalog | undefined> | undefined;
    const serviceCopy = (state: SyncSettingsState) =>
      state.settings ? syncedSettings(state.settings) : emptySynced;
    // Without a base, for a new pairing or a service restored to an older state, both
    // sides' entries are kept and the service wins where they differ; nothing is removed.
    let base: SyncBase = { service: emptySynced, local: emptySynced };
    if (
      stored &&
      (service.revision > stored.revision ||
        (service.revision === stored.revision &&
          equalSynced(serviceCopy(service), syncedSettings(stored.settings))))
    )
      base = { service: syncedSettings(stored.settings), local: syncedSettings(stored.local) };
    async function record(next: SyncBase) {
      if (stale()) return;
      // Best effort: a lost write leaves the older base, which merges to the same result
      // unless this device edits the same entries again before the next sync.
      await storage
        .write({
          version: 1,
          origin,
          deviceId,
          revision: service.revision,
          settings: serviceDocument(next.service),
          local: serviceDocument(next.local),
        })
        .catch(() => undefined);
    }
    for (let attempt = 0; attempt < MAX_SETTINGS_SYNC_ATTEMPTS; attempt += 1) {
      let local: SettingsSnapshot;
      try {
        // oxlint-disable-next-line no-await-in-loop -- each attempt merges the latest copies
        local = await settings.read();
      } catch {
        return "storage-unavailable";
      }
      const localSynced = syncedSettings(local.settings);
      const serviceSynced = serviceCopy(service);
      const mergedEntries = mergeSyncedSettings(base, localSynced, serviceSynced);
      // Named after the merge, so the names are uploaded and written like any change.
      if (unnamed(mergedEntries)) catalog ??= options.catalog?.().catch(() => undefined);
      // oxlint-disable-next-line no-await-in-loop -- read once, on the first attempt that needs it
      const names = await catalog;
      const merged = names ? refreshDisplayNames(mergedEntries, names) : mergedEntries;
      const upload = !equalSynced(merged, serviceSynced);
      if (
        !v.safeParse(localSettingsSchema, applySynced(local.settings, merged)).success ||
        (upload && settingsDocumentBytes(serviceDocument(merged)) > MAX_SETTINGS_DOCUMENT_BYTES)
      )
        return "too-large";
      if (stale()) return "busy";
      if (upload) {
        // oxlint-disable-next-line no-await-in-loop -- a conflict retries with its state
        const saved = await transport.saveSettings(origin, credential, {
          version: 1,
          expectedRevision: service.revision,
          settings: serviceDocument(merged),
        });
        timed?.(saved.timing);
        if (saved.kind === "rejected") return "rejected";
        if (saved.kind === "failed") return saved.error;
        if (saved.kind === "conflict") {
          service = saved.current;
          continue;
        }
        service = saved.state;
        // The service holds the merge; local settings still hold `localSynced`.
        base = { service: merged, local: localSynced };
        // oxlint-disable-next-line no-await-in-loop -- recorded before the local write
        await record(base);
      }
      if (stale()) return "busy";
      if (!equalSynced(merged, localSynced)) {
        // A policy write now would stop a login in progress; a later sync applies it.
        // oxlint-disable-next-line no-await-in-loop -- decides this attempt's write
        if (await holdForLogin(stale)) return "busy";
        if (stale()) return "busy";
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
      // oxlint-disable-next-line no-await-in-loop -- both sides now hold the merge
      await Promise.all([record({ service: merged, local: merged }), release()]);
      return "synced";
    }
    return "busy";
  }

  /** Waits for a running login, but not longer than the limit since the first wait. */
  async function holdForLogin(stale: () => boolean): Promise<boolean> {
    if (!(await options.deferred?.())) return false;
    const at = now();
    let since: number | undefined;
    try {
      const parsed = v.safeParse(holdSchema, await hold.read());
      // A start in the future, for example after a clock change, starts the wait again.
      if (parsed.success && parsed.output <= at) since = parsed.output;
    } catch {
      // Unreadable: the write goes ahead rather than waiting without a bound.
      return false;
    }
    if (since === undefined) {
      // A disconnect meanwhile cleared the hold; it does not carry over to a new pairing.
      if (stale()) return true;
      since = at;
      try {
        await hold.write(since);
      } catch {
        return false;
      }
    }
    return at - since < MAX_SETTINGS_DEFER_MS;
  }

  async function release() {
    await hold.clear().catch(() => undefined);
  }

  async function clear() {
    await Promise.all([storage.clear().catch(() => undefined), release()]);
  }

  return { run, clear };
}
