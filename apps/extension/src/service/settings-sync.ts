import {
  deviceIdSchema,
  profileIdSchema,
  localSettingsSchema,
  MAX_SETTINGS_DOCUMENT_BYTES,
  popupPageSectionShown,
  savedLoginBindingSchema,
  settingsDocumentBytes,
  serviceOriginSchema,
  siteDefaultConnection,
  siteDefaultSchema,
  type LocalSettings,
  type SettingsChangeCause,
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
type PasskeyBrowserSite = LocalSettings["passkeyBrowserSites"][number];
type Binding = LocalSettings["bindings"][number];
type AccountPolicy = LocalSettings["accountPolicies"][number];
type ItemPolicy = LocalSettings["itemPolicies"][number];
type CustomFieldReview = LocalSettings["customFieldReviews"][number];
type DetailLink = NonNullable<LocalSettings["detailLinks"]>[number];

/**
 * The part of the settings that means the same on every device (ADR 0013): site
 * exclusions, defaults and bindings, each provider account's vault policy and
 * custom-field reviews (ADR 0023), and the links to the vault fields that hold a login's
 * personal details (ADR 0061). Bindings and detail links belong to the owner; the rest to
 * a profile (ADR 0076). Vault connections stay on this device, and so does the policy of
 * the unsynced demo provider.
 */
export type SyncedSettings = {
  accountPolicies: AccountPolicy[];
  itemPolicies: ItemPolicy[];
  customFieldReviews: CustomFieldReview[];
  excludedSites: ExcludedSite[];
  passkeyBrowserSites: PasskeyBrowserSite[];
  repromptSites: ExcludedSite[];
  siteDefaults: SiteDefault[];
  bindings: Binding[];
  detailLinks: DetailLink[];
  popupPageSection: boolean;
};

const LOCAL_PROVIDER = "dummy";
const shared = <T extends { provider: string }>(entries: T[]) =>
  entries.filter((entry) => entry.provider !== LOCAL_PROVIDER);
const localOnly = <T extends { provider: string }>(entries: T[]) =>
  entries.filter((entry) => entry.provider === LOCAL_PROVIDER);

export function syncedSettings(settings: LocalSettings): SyncedSettings {
  return {
    accountPolicies: shared(settings.accountPolicies),
    itemPolicies: shared(settings.itemPolicies),
    customFieldReviews: shared(settings.customFieldReviews),
    excludedSites: settings.excludedSites,
    passkeyBrowserSites: settings.passkeyBrowserSites,
    repromptSites: settings.repromptSites,
    siteDefaults: settings.siteDefaults,
    bindings: settings.bindings,
    detailLinks: settings.detailLinks ?? [],
    popupPageSection: popupPageSectionShown(settings),
  };
}

const emptySynced: SyncedSettings = {
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites: [],
  passkeyBrowserSites: [],
  repromptSites: [],
  siteDefaults: [],
  bindings: [],
  detailLinks: [],
  popupPageSection: true,
};

// The base of the next three-way merge. Normally both copies are the same; after an
// upload whose local write has not happened yet, `local` is still the local copy the
// merge started from, so the merged entries it lacks are not mistaken for local edits.
// The base is written before each write it describes, never only after: a write whose
// base is lost would make the next merge take an entry this device already uploaded or
// downloaded for an edit not yet sent, and put back what another device changed since.
const baseRevision = v.pipe(v.number(), v.integer(), v.minValue(0));
const baseSchema = v.strictObject({
  version: v.literal(1),
  origin: serviceOriginSchema,
  deviceId: deviceIdSchema,
  profileId: profileIdSchema,
  revision: baseRevision,
  /** The service document at `revision`, which has no connections. */
  settings: localSettingsSchema,
  /** The synced part of the local settings that `settings` already accounts for. */
  local: localSettingsSchema,
  /**
   * The local settings revision this sync's write of `settings` to the local settings
   * takes. Once the local change history shows that write, the local copy holds
   * `settings`, also when the base recorded after it was lost.
   */
  localWrite: v.optional(v.pipe(baseRevision, v.minValue(1))),
  /**
   * An upload, recorded before it is sent, as the base it makes once it commits. The
   * service's `written` (the revision of this device's last stored write) tells the next
   * sync whether it did, also when its answer was lost.
   */
  pending: v.optional(
    v.strictObject({
      profileId: profileIdSchema,
      revision: v.pipe(baseRevision, v.minValue(1)),
      settings: localSettingsSchema,
      local: localSettingsSchema,
    }),
  ),
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

const siteKey = (entry: ExcludedSite | PasskeyBrowserSite) => entry.hostname;
const defaultKey = (entry: SiteDefault) => entry.origin;
const bindingKey = (entry: Binding) =>
  JSON.stringify([
    entry.recipeId,
    entry.origin,
    entry.provider,
    entry.server,
    entry.userId,
    entry.itemId,
  ]);
const accountKey = (entry: AccountPolicy) =>
  JSON.stringify([entry.provider, entry.server, entry.userId]);
const itemKey = (entry: ItemPolicy | CustomFieldReview) =>
  JSON.stringify([entry.provider, entry.server, entry.userId, entry.itemId]);
/**
 * The settings' duplicate check for detail links, so a merge never pairs two links the
 * schema refuses together: one per field for an answer (ADR 0061).
 */
const detailLinkKey = (link: DetailLink) =>
  JSON.stringify([
    link.origin,
    link.provider,
    link.userId,
    link.itemId,
    link.detail,
    link.detail === "secret-answer" ? link.source.field : null,
  ]);
/** A stored question belongs to one answer of a login item (ADR 0061), as the schema checks. */
const detailQuestionKey = (link: DetailLink) =>
  link.question === undefined
    ? undefined
    : JSON.stringify([
        link.origin,
        link.provider,
        link.server,
        link.userId,
        link.itemId,
        link.question,
      ]);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** What each side last agreed to: the service's copy and the local copy it accounts for. */
export type SyncBase = { service: SyncedSettings; local: SyncedSettings };

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

/**
 * Detail links merge per link like bindings. Two answers of one login item may also not
 * store the same question; when a local link takes a question the service's copy already
 * gives another field, the service's link stands, and that local link falls back to the
 * service's copy of it, or is left out when the service has none.
 */
function mergeDetailLinks(
  base: { service: DetailLink[]; local: DetailLink[] },
  local: DetailLink[],
  service: DetailLink[],
): DetailLink[] {
  const merged = mergeEntries(base, local, service, detailLinkKey);
  const serviceLinks = new Map(service.map((link) => [detailLinkKey(link), link]));
  const fromService = (link: DetailLink) => same(link, serviceLinks.get(detailLinkKey(link)));
  const claimed = new Set<string>();
  /** Claims the link's question; false when another link already holds it. */
  const claim = (link: DetailLink) => {
    const question = detailQuestionKey(link);
    if (question === undefined) return true;
    if (claimed.has(question)) return false;
    claimed.add(question);
    return true;
  };
  // The service's links are valid together, so they claim their questions first.
  for (const link of merged.filter(fromService)) claim(link);
  const settled = new Map<DetailLink, DetailLink | undefined>();
  for (const link of merged.filter((entry) => !fromService(entry))) {
    if (claim(link)) continue;
    const fallback = serviceLinks.get(detailLinkKey(link));
    settled.set(link, fallback && claim(fallback) ? fallback : undefined);
  }
  return merged.flatMap((link) => {
    if (!settled.has(link)) return [link];
    const fallback = settled.get(link);
    return fallback ? [fallback] : [];
  });
}

/**
 * An item's policy and its custom-field review merged as one entry: a review changes
 * both, and taking one from each side could pair a review with custom-field exclusions it
 * did not choose, making a field the reviewer excluded usable (ADR 0023).
 */
type ItemEntry = { key: string; policy?: ItemPolicy; review?: CustomFieldReview };

function itemEntries(policies: ItemPolicy[], reviews: CustomFieldReview[]): ItemEntry[] {
  const entries = new Map<string, ItemEntry>();
  for (const policy of policies) entries.set(itemKey(policy), { key: itemKey(policy), policy });
  for (const review of reviews) {
    const key = itemKey(review);
    entries.set(key, { key, ...entries.get(key), review });
  }
  return [...entries.values()];
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
  const items = mergeEntries(
    {
      service: itemEntries(base.service.itemPolicies, base.service.customFieldReviews),
      local: itemEntries(base.local.itemPolicies, base.local.customFieldReviews),
    },
    itemEntries(local.itemPolicies, local.customFieldReviews),
    itemEntries(service.itemPolicies, service.customFieldReviews),
    (entry) => entry.key,
  );
  return {
    accountPolicies: mergeEntries(
      part("accountPolicies"),
      local.accountPolicies,
      service.accountPolicies,
      accountKey,
    ),
    itemPolicies: items.flatMap((entry) => (entry.policy ? [entry.policy] : [])),
    customFieldReviews: items.flatMap((entry) => (entry.review ? [entry.review] : [])),
    excludedSites: mergeEntries(
      part("excludedSites"),
      local.excludedSites,
      service.excludedSites,
      siteKey,
    ),
    passkeyBrowserSites: mergeEntries(
      part("passkeyBrowserSites"),
      local.passkeyBrowserSites,
      service.passkeyBrowserSites,
      siteKey,
    ),
    repromptSites: mergeEntries(
      part("repromptSites"),
      local.repromptSites,
      service.repromptSites,
      siteKey,
    ),
    siteDefaults: mergeEntries(
      part("siteDefaults"),
      local.siteDefaults,
      service.siteDefaults,
      defaultKey,
    ),
    bindings: mergeEntries(part("bindings"), local.bindings, service.bindings, bindingKey),
    detailLinks: mergeDetailLinks(part("detailLinks"), local.detailLinks, service.detailLinks),
    // One value, merged like one entry.
    popupPageSection:
      service.popupPageSection === base.service.popupPageSection &&
      local.popupPageSection !== base.local.popupPageSection
        ? local.popupPageSection
        : service.popupPageSection,
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
    same(sorted(left.accountPolicies, accountKey), sorted(right.accountPolicies, accountKey)) &&
    same(sorted(left.itemPolicies, itemKey), sorted(right.itemPolicies, itemKey)) &&
    same(sorted(left.customFieldReviews, itemKey), sorted(right.customFieldReviews, itemKey)) &&
    same(sorted(left.excludedSites, siteKey), sorted(right.excludedSites, siteKey)) &&
    same(sorted(left.passkeyBrowserSites, siteKey), sorted(right.passkeyBrowserSites, siteKey)) &&
    same(sorted(left.repromptSites, siteKey), sorted(right.repromptSites, siteKey)) &&
    same(sorted(left.siteDefaults, defaultKey), sorted(right.siteDefaults, defaultKey)) &&
    same(sorted(left.bindings, bindingKey), sorted(right.bindings, bindingKey)) &&
    same(sorted(left.detailLinks, detailLinkKey), sorted(right.detailLinks, detailLinkKey)) &&
    left.popupPageSection === right.popupPageSection
  );
}

/**
 * Local settings with the synced part replaced; the demo provider's policy stays. The
 * popup's choice is kept only while it hides the page's status, as in the documents.
 */
function applySynced(settings: LocalSettings, merged: SyncedSettings): LocalSettings {
  const { popupPageSection, ...lists } = merged;
  const { popupPageSection: _replaced, ...rest } = settings;
  return {
    ...rest,
    ...lists,
    accountPolicies: [...merged.accountPolicies, ...localOnly(settings.accountPolicies)],
    itemPolicies: [...merged.itemPolicies, ...localOnly(settings.itemPolicies)],
    customFieldReviews: [...merged.customFieldReviews, ...localOnly(settings.customFieldReviews)],
    ...(popupPageSection ? {} : { popupPageSection: false }),
  };
}

/** The service holds only the synced part; it never stores device-local connections. */
const serviceDocument = ({ popupPageSection, ...lists }: SyncedSettings): LocalSettings => ({
  connections: [],
  ...lists,
  ...(popupPageSection ? {} : { popupPageSection: false }),
});

export function createSettingsSync(options: {
  transport: Pick<ServiceTransport, "settings" | "saveSettings">;
  /** The local settings store; writes go through its revision check. */
  settings: {
    read(): Promise<SettingsSnapshot>;
    update(
      expectedRevision: number | undefined,
      cause: SettingsChangeCause,
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

  /** `unreadable` when storage failed: without the base, local edits look like nothing. */
  async function loadBase(
    connection: ServiceConnection,
  ): Promise<SettingsBase | "unreadable" | undefined> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      return "unreadable";
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
    const loaded = await loadBase(connection);
    // A missing base would let an existing profile replace this device's entries.
    if (loaded === "unreadable") return "storage-unavailable";
    const fetched = await transport.settings(origin, credential);
    timed?.(fetched.timing);
    if (fetched.kind === "rejected") return "rejected";
    if (fetched.kind === "failed") return fetched.error;
    if (fetched.kind !== "state") return "unexpected-response";
    let service: SyncSettingsState = fetched.state;
    // An upload recorded as pending is the base once the service stored it, and is
    // dropped otherwise. Every base written below starts from this one, so a committed
    // upload is not forgotten by a later write that fails.
    const stored = loaded && resolvePending(loaded, service.written);
    // Read only when an entry lacks a name: building the catalog restores the vaults.
    let catalog: Promise<VaultCatalog | undefined> | undefined;
    const serviceCopy = (state: SyncSettingsState) =>
      state.settings ? syncedSettings(state.settings) : emptySynced;
    // A matching profile base preserves local edits. A new pairing or a profile switch
    // adopts the profile's own parts below (ADR 0076); only a profile no device has
    // written yet (`newProfile`, or the owner's first settings) starts from local policy.
    // Bindings and detail links belong to the owner, not a profile, so they keep merging
    // either way.
    const base0: SyncBase = { service: emptySynced, local: emptySynced };
    let base = base0;
    let ownerBase = base;
    if (
      stored &&
      (service.revision > stored.revision ||
        (service.revision === stored.revision &&
          equalSynced(serviceCopy(service), syncedSettings(stored.settings))))
    ) {
      ownerBase = {
        service: syncedSettings(stored.settings),
        local: syncedSettings(stored.local),
      };
      if (stored.profileId === service.profileId) base = ownerBase;
    }
    /** Whether `next` was written; nothing is written for a device that is gone. */
    async function save(next: SettingsBase): Promise<boolean> {
      if (stale()) return false;
      try {
        await storage.write(next);
        return true;
      } catch {
        return false;
      }
    }
    // While a profile switch is not yet applied locally, a base keeps the profile it
    // switches from, so the next sync still replaces the old profile's cache rather than
    // merging it as edits (ADR 0076). Without a stored base there is none to keep.
    const baseProfile = (): string | undefined =>
      switchingProfile ? stored?.profileId : service.profileId;
    /** Records `next` at the service's revision; false when it was not written. */
    async function record(next: SyncBase, localWrite?: number): Promise<boolean> {
      const profileId = baseProfile();
      if (profileId === undefined) return false;
      return save({
        version: 1,
        origin,
        deviceId,
        profileId,
        revision: service.revision,
        settings: serviceDocument(next.service),
        local: serviceDocument(next.local),
        ...(localWrite === undefined ? {} : { localWrite }),
      });
    }
    // A profile switch must never reinterpret the previous profile cache as edits.
    const adopts = (state: SyncSettingsState) =>
      !state.newProfile &&
      (stored ? stored.profileId !== state.profileId : state.settings !== null);
    let switchingProfile = adopts(service);
    // Keep the old identity until the replacement is applied: a deferred or failed
    // local write must still recognize the switch on the next worker run.
    for (let attempt = 0; attempt < MAX_SETTINGS_SYNC_ATTEMPTS; attempt += 1) {
      let local: SettingsSnapshot;
      try {
        // oxlint-disable-next-line no-await-in-loop -- each attempt merges the latest copies
        local = await settings.read();
      } catch {
        return "storage-unavailable";
      }
      const localSynced = syncedSettings(local.settings);
      // The stored base's own local write landed before the base recorded after it was
      // lost: the local copy holds the base's service copy, and only later local changes
      // differ from it. Older than the kept change history, it counts as not written.
      if (
        attempt === 0 &&
        ownerBase !== base0 &&
        stored?.localWrite !== undefined &&
        local.changes?.some(
          (change) => change.revision === stored.localWrite && change.cause === "service-sync",
        )
      ) {
        const written = { service: ownerBase.service, local: ownerBase.service };
        if (base === ownerBase) base = written;
        ownerBase = written;
      }
      const serviceSynced = serviceCopy(service);
      const ownerParts = mergeSyncedSettings(ownerBase, localSynced, serviceSynced);
      const mergedEntries = {
        ...(switchingProfile
          ? serviceSynced
          : mergeSyncedSettings(base, localSynced, serviceSynced)),
        bindings: ownerParts.bindings,
        detailLinks: ownerParts.detailLinks,
      };
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
        // Recorded before it is sent: an upload whose answer is lost may have committed.
        const pendingProfile = baseProfile();
        if (
          stored &&
          pendingProfile !== undefined &&
          // oxlint-disable-next-line no-await-in-loop -- the upload waits for its record
          !(await save({
            ...stored,
            pending: {
              profileId: pendingProfile,
              revision: service.revision + 1,
              settings: serviceDocument(merged),
              local: serviceDocument(localSynced),
            },
          }))
        )
          return stale() ? "busy" : "storage-unavailable";
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
          if (service.profileId !== saved.current.profileId) {
            // The device moved meanwhile: the old profile's base says nothing about the
            // new one, whose entries are adopted or, if it has none yet, filled locally.
            switchingProfile ||= adopts(saved.current);
            base = { service: emptySynced, local: emptySynced };
          }
          service = saved.current;
          continue;
        }
        service = saved.state;
        // The service holds the merge; local settings still hold `localSynced`.
        base = { service: merged, local: localSynced };
        ownerBase = base;
        // Best effort: the pending upload recorded above already makes this base.
        // oxlint-disable-next-line no-await-in-loop -- recorded before the local write
        await record(base);
      }
      if (stale()) return "busy";
      if (!equalSynced(merged, localSynced)) {
        // A policy write now would stop a login in progress; a later sync applies it.
        // oxlint-disable-next-line no-await-in-loop -- decides this attempt's write
        if (await holdForLogin(stale)) return "busy";
        if (stale()) return "busy";
        // Recorded before the local write, which takes the next local revision: whether
        // or not it lands, the next merge then sees which side changed since.
        base = { service: merged, local: localSynced };
        ownerBase = base;
        if (
          baseProfile() !== undefined &&
          // oxlint-disable-next-line no-await-in-loop -- the local write waits for its record
          !(await record(base, local.revision + 1))
        )
          return stale() ? "busy" : "storage-unavailable";
        try {
          // oxlint-disable-next-line no-await-in-loop -- the write must follow the merge
          await settings.update(local.revision, "service-sync", (snapshot) => ({
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
      // Both sides now hold the merge, so a profile switch is applied.
      switchingProfile = false;
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

/**
 * `stored` with its pending upload settled: the base that upload makes when `written`,
 * the revision of this device's last write the service stored, is the upload's, and the
 * base before it otherwise. One sync runs at a time per device and resolves a pending
 * upload before it sends another, so no other write of this device has that revision.
 */
function resolvePending(stored: SettingsBase, written: number | undefined): SettingsBase {
  const { pending, localWrite, ...rest } = stored;
  if (!pending) return stored;
  if (written !== pending.revision)
    return { ...rest, ...(localWrite === undefined ? {} : { localWrite }) };
  return { ...rest, ...pending };
}
