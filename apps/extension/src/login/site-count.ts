// The site count badge (ADR 0021): how many vault items match a tab's HTTP(S) origin, and
// how many of them a login may use. A count only reads vaults the service worker already
// has open; it never opens one, and keeps only the numbers. While a vault stays open on a
// snapshot, its item, group and field IDs are kept in memory for eligibility, never a
// name or a value.
import {
  getItemEligibility,
  isSiteExcluded,
  type SettingsChangeCause,
  type SettingsSnapshot,
  type VaultCatalog,
} from "@pateat/contracts";
import type { LocalVaultMetadata } from "@pateat/bitwarden";
import * as v from "valibot";
import { catalogEntry } from "../connections/catalog";
import type { ConnectionRuntime } from "../connections/runtime";
import { quarantinedItems } from "../connections/policy";
import type { PasskeyMatches } from "../crypto/passkey";
import type { UriCandidates } from "../crypto/wire";
import { passkeyEligible, type PasskeyFinder } from "../passkeys/vault";
import { passkeyOrigin, rpIdsFor } from "../passkeys/rp-id";
import type { LiveUriMatcher } from "../vault/site-candidates";
import { vaultFailure, type VaultResult } from "../vault/record";

export const SITE_COUNT_KEY = "session:pateat.site-count.v1";
/** Origins whose counts are kept; the least recently used goes first. */
export const SITE_COUNT_LIMIT = 200;
/** A finished load that the page never announced is counted after this long. */
export const UNANNOUNCED_COUNT_MS = 5000;
/** A count stopped for a login or an admission is tried again after these waits. */
export const STOPPED_RETRY_MS = [1000, 2000, 4000, 8000, 16_000, 32_000] as const;

/**
 * Why a tab shows no number although its site may have items (ADR 0021); `busy` while
 * logins or page admissions keep a count waiting, until it is tried again.
 */
export type UncheckedReason = "locked" | "not-opened" | "unreadable" | "updating" | "busy";
/** Why some or all of the matching items are not usable. */
export type ExcludedReason = "site" | "items" | "review" | "items-review";
export type SiteCount = {
  /** Items a login on the origin may use; the popup lists the same ones. */
  usable: number;
  /** Items whose URI rule matches the origin or that hold a passkey for its RP IDs. */
  matching: number;
  /** Usable items whose URI rules or passkeys could not be read, left out of both numbers. */
  unevaluated: number;
  /** Set when fewer items are usable than match. */
  excluded?: ExcludedReason;
};
export type SiteCountState =
  | { kind: "count"; count: SiteCount }
  | { kind: "unchecked"; reason: UncheckedReason };

type Matches = Pick<PasskeyMatches, "snapshotId" | "rpId" | "unavailableItemIds"> & {
  candidates: readonly { itemId: string }[];
};
/** One enabled connection, as a count may read it. */
export type CountSource =
  | {
      connectionId: string;
      /** A bundled demo connection, matched by its static `allowedOrigins`. */
      fixed: VaultCatalog["connections"][number];
    }
  | {
      connectionId: string;
      /** The stored record's accepted snapshot. */
      snapshotId: string;
      /** The vault the service worker has open on that snapshot; absent when not open. */
      open?: {
        catalog(): Promise<VaultResult<LocalVaultMetadata>>;
        matchUris(url: string): Promise<VaultResult<UriCandidates>>;
        findPasskeys(rpId: string): Promise<VaultResult<Matches>>;
      };
    };
/** What a count of the current settings and vaults needs, read without any crypto job. */
export type CountScope =
  | { unchecked: Exclude<UncheckedReason, "not-opened" | "busy"> }
  | { snapshot: SettingsSnapshot; sources: CountSource[]; key: string };

/** Runs one crypto job unless a login runs or a page is being admitted (ADR 0021). */
export type CountStep = <T>(job: () => Promise<T>) => Promise<{ value: T } | undefined>;

/** The origin a tab's page is counted for: HTTP(S) only, where logins run (ADR 0050). */
export function countedOrigin(url: string | undefined): string | undefined {
  const parsed = url === undefined ? null : URL.parse(url);
  return parsed?.protocol === "https:" || parsed?.protocol === "http:" ? parsed.origin : undefined;
}

/**
 * What settings eligibility reads of an open snapshot's catalog: item IDs, groups and
 * field IDs and kinds. Names and labels are left out, so nothing a count keeps names an
 * item.
 */
function eligibilityOnly(data: LocalVaultMetadata): LocalVaultMetadata {
  return {
    connectionId: data.connectionId,
    userId: data.userId,
    snapshotId: data.snapshotId,
    groups: [],
    items: data.items.map((item) => ({
      id: item.id,
      label: "",
      type: item.type,
      groupIds: item.groupIds,
      fields: item.fields.map(({ id, kind, linkedFieldId, empty }) => ({
        id,
        label: "",
        name: null,
        kind,
        ...(linkedFieldId ? { linkedFieldId } : {}),
        ...(empty ? { empty } : {}),
      })),
    })),
  };
}

/**
 * The connections a count may read, from the registry and the open vaults, without opening
 * any. URI rules and passkeys go through the popup's and the logins' own `uris` and
 * `passkeys`; what eligibility needs of an open snapshot's catalog is read once per
 * snapshot and dropped once that vault is no longer open on it.
 */
export function createCountScope(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor"> & {
    settings: { read(): Promise<SettingsSnapshot> };
  },
  match: { uris: LiveUriMatcher; passkeys: PasskeyFinder },
  fixed: VaultCatalog = { connections: [] },
): () => Promise<CountScope> {
  /** Each open connection's eligibility catalog, for the snapshot it was read for. */
  const catalogs = new Map<string, { snapshotId: string; data: LocalVaultMetadata }>();
  // A vault closed since the scope was read answers as locked, never as no match.
  const locked = () => vaultFailure("crypto-locked");
  return async () => {
    const snapshot = await connections.settings.read();
    const enabled = (id: string) =>
      snapshot.settings.connections.some((entry) => entry.connectionId === id && entry.enabled);
    const sources: CountSource[] = fixed.connections
      .filter((connection) => enabled(connection.id))
      .map((connection) => ({ connectionId: connection.id, fixed: connection }));
    const configurations = await connections.registry.list();
    const live = new Set(configurations.map(({ profile }) => profile.connectionId));
    for (const connectionId of catalogs.keys())
      if (!live.has(connectionId) || !enabled(connectionId)) catalogs.delete(connectionId);
    // Every record is read, so each closed vault's catalog goes, before one answers.
    let unchecked: Extract<CountScope, { unchecked: string }>["unchecked"] | undefined;
    for (const configuration of configurations) {
      const connectionId = configuration.profile.connectionId;
      if (!enabled(connectionId)) continue;
      const vault = connections.vaultFor(configuration.profile);
      // oxlint-disable-next-line no-await-in-loop -- one record read per connection
      const record = await vault.store.read();
      const handle = vault.manager.status().handle;
      const snapshotId =
        record.ok && record.data?.state === "active" ? record.data.accepted.snapshotId : undefined;
      if (!handle || handle.snapshotId !== snapshotId) catalogs.delete(connectionId);
      if (!record.ok) unchecked ??= "unreadable";
      else if (snapshotId === undefined) unchecked ??= "locked";
      else if (handle && handle.snapshotId !== snapshotId) unchecked ??= "updating";
      if (unchecked || snapshotId === undefined) continue;
      sources.push({
        connectionId,
        snapshotId,
        ...(handle
          ? {
              open: {
                async catalog() {
                  const cached = catalogs.get(connectionId);
                  if (cached?.snapshotId === snapshotId) return { ok: true, data: cached.data };
                  const read = await vault.manager.catalog(handle);
                  if (!read.ok) return read;
                  const data = eligibilityOnly(read.data);
                  if (data.snapshotId === snapshotId)
                    catalogs.set(connectionId, { snapshotId, data });
                  return { ok: true, data };
                },
                matchUris: async (url) => (await match.uris(connectionId, url)) ?? locked(),
                findPasskeys: async (rpId) =>
                  (await match.passkeys(connectionId, rpId)) ?? locked(),
              },
            }
          : {}),
      });
    }
    if (unchecked) return { unchecked };
    const key = JSON.stringify([
      snapshot.revision,
      sources.map((source) => [
        source.connectionId,
        "fixed" in source ? "fixed" : source.snapshotId,
      ]),
    ]);
    return { snapshot, sources, key };
  };
}

/**
 * Settings whose trusted updates, such as an account choice a login saves (ADR 0022) or a
 * remembered passkey default, call `saved` once written, so the badge recounts after them
 * as after an options-page save.
 */
export function recountingSettings<
  T extends {
    update(
      expectedRevision: number | undefined,
      cause: SettingsChangeCause,
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
    ): Promise<SettingsSnapshot>;
  },
>(settings: T, saved: () => void): T {
  return {
    ...settings,
    update: (expectedRevision, cause, mutate) =>
      settings.update(expectedRevision, cause, mutate).then((snapshot) => {
        saved();
        return snapshot;
      }),
  };
}

/** Whether every live connection of the scope is open, so a count can run. */
export function countable(scope: Extract<CountScope, { key: string }>): boolean {
  return scope.sources.every((source) => "fixed" in source || source.open);
}

const failed = (code: string): UncheckedReason =>
  code === "crypto-locked" ? "locked" : code === "stale-vault-handle" ? "updating" : "unreadable";

/**
 * Counts the items matching `origin` in each source, one crypto job at a time through
 * `step`. Answers `undefined` when `step` stopped it for a login or a page.
 */
export async function countSite(
  origin: string,
  scope: Extract<CountScope, { key: string }>,
  step: CountStep,
): Promise<SiteCountState | undefined> {
  const { settings } = scope.snapshot;
  const siteExcluded = isSiteExcluded(settings, origin);
  let usable = 0;
  let matching = 0;
  let unevaluated = 0;
  const reasons = new Set<"items" | "review">();
  for (const source of scope.sources) {
    let entry: VaultCatalog["connections"][number];
    // By item: whether it matched by URI rule or by passkey, and whether one of its URI
    // rules or its passkeys could not be read.
    const items = new Map<
      string,
      { uri?: true; passkey?: true; unknownUri?: true; unknownPasskey?: true }
    >();
    const mark = (itemId: string, how: "uri" | "passkey" | "unknownUri" | "unknownPasskey") =>
      items.set(itemId, { ...items.get(itemId), [how]: true });
    let quarantined: readonly string[];
    if ("fixed" in source) {
      entry = source.fixed;
      quarantined = entry.quarantinedItemIds ?? [];
      for (const item of entry.items)
        if (item.allowedOrigins.includes(origin)) mark(item.id, "uri");
    } else {
      if (!source.open) return { kind: "unchecked", reason: "not-opened" };
      const { open } = source;
      // Sequential: each job shares the vault's one crypto Worker.
      // oxlint-disable-next-line no-await-in-loop
      const catalog = await step(() => open.catalog());
      if (!catalog) return undefined;
      if (!catalog.value.ok) return { kind: "unchecked", reason: failed(catalog.value.error.code) };
      if (catalog.value.data.snapshotId !== source.snapshotId)
        return { kind: "unchecked", reason: "updating" };
      entry = catalogEntry(source.connectionId, "", catalog.value.data);
      quarantined = quarantinedItems(scope.snapshot, source.connectionId, source.snapshotId);
      // URI rules are matched for `origin/`, as the popup's list does; on an `http:` page
      // the matcher answers only rules saved with `http://` (ADR 0050).
      // oxlint-disable-next-line no-await-in-loop
      const uris = await step(() => open.matchUris(`${origin}/`));
      if (!uris) return undefined;
      if (!uris.value.ok) return { kind: "unchecked", reason: failed(uris.value.error.code) };
      if (uris.value.data.snapshotId !== source.snapshotId)
        return { kind: "unchecked", reason: "updating" };
      for (const candidate of uris.value.data.candidates) mark(candidate.itemId, "uri");
      // Non-web schemes and malformed URIs can never match a page, as in the pinned clients.
      for (const unavailable of uris.value.data.unavailableUris)
        if (unavailable.reason !== "unsupported-uri-scheme" && unavailable.reason !== "invalid-uri")
          mark(unavailable.itemId, "unknownUri");
      for (const itemId of uris.value.data.unavailableItemIds) mark(itemId, "unknownUri");
      // Passkeys answer only on HTTPS and `http://localhost`, as in the popup (ADR 0050).
      for (const rpId of passkeyOrigin(origin) ? rpIdsFor(origin) : []) {
        // oxlint-disable-next-line no-await-in-loop
        const found = await step(() => open.findPasskeys(rpId));
        if (!found) return undefined;
        if (!found.value.ok) return { kind: "unchecked", reason: failed(found.value.error.code) };
        if (found.value.data.snapshotId !== source.snapshotId || found.value.data.rpId !== rpId)
          return { kind: "unchecked", reason: "updating" };
        for (const candidate of found.value.data.candidates) mark(candidate.itemId, "passkey");
        for (const itemId of found.value.data.unavailableItemIds) mark(itemId, "unknownPasskey");
      }
    }
    const catalog = { connections: [entry] };
    for (const [itemId, how] of items) {
      if (!how.uri && !how.passkey) {
        // Only an item a login could use is noted, by the rule its popup lookup uses.
        if (
          !siteExcluded &&
          !quarantined.includes(itemId) &&
          ((how.unknownUri &&
            getItemEligibility(settings, catalog, source.connectionId, itemId).eligible) ||
            (how.unknownPasskey && passkeyEligible(settings, catalog, source.connectionId, itemId)))
        )
          unevaluated += 1;
        continue;
      }
      matching += 1;
      const eligible = how.passkey
        ? passkeyEligible(settings, catalog, source.connectionId, itemId)
        : getItemEligibility(settings, catalog, source.connectionId, itemId).eligible;
      if (siteExcluded) continue;
      if (quarantined.includes(itemId)) reasons.add("review");
      else if (!eligible) reasons.add("items");
      else usable += 1;
    }
  }
  const excluded: ExcludedReason | undefined =
    usable === matching
      ? undefined
      : siteExcluded
        ? "site"
        : reasons.size > 1
          ? "items-review"
          : reasons.has("review")
            ? "review"
            : "items";
  return {
    kind: "count",
    count: { usable, matching, unevaluated, ...(excluded ? { excluded } : {}) },
  };
}

const countSchema = v.object({
  usable: v.pipe(v.number(), v.integer(), v.minValue(0)),
  matching: v.pipe(v.number(), v.integer(), v.minValue(0)),
  unevaluated: v.pipe(v.number(), v.integer(), v.minValue(0)),
  excluded: v.exactOptional(v.picklist(["site", "items", "review", "items-review"])),
});
const storedSchema = v.object({
  origins: v.array(v.tuple([v.string(), v.string(), countSchema])),
});

/**
 * Counts each tab's origin when its cached count is missing, and shows the cached one
 * otherwise (ADR 0021). A count runs after the runtime handled the tab's top-frame
 * announcement, or 5 seconds after a finished load the page never announced; worker
 * starts, tab activation and finished loads only show a cached count. A settings or vault
 * change counts the misses of tabs whose page announced (or whose 5 seconds passed). A
 * count stopped for a login or an admission shows `busy` and is tried again after each of
 * `STOPPED_RETRY_MS`, after the next handled announcement, or when a login ends.
 */
export function createSiteCounter(deps: {
  /** Settings and vaults as a count reads them; never opens a vault. */
  scope: () => Promise<CountScope>;
  /** Holds vault replacement off, as an admission does, until the returned function is called. */
  hold: () => Promise<() => void>;
  step: CountStep;
  /** What the tab shows for the origin, or nothing. */
  show: (tabId: number, origin: string, state: SiteCountState | undefined) => void;
  storage: { getValue(): Promise<unknown>; setValue(value: unknown): Promise<void> };
}) {
  /** By origin, in least recently used order: the count and the scope key it was made for. */
  const cache = new Map<string, { key: string; count: SiteCount }>();
  /** Each tab's counted origin, as last told. */
  const tabs = new Map<number, string>();
  /**
   * Tabs whose page announced since the tab last started loading, whose 5 seconds passed
   * without one, or that had finished loading when the worker started.
   */
  const settled = new Set<number>();
  /** Origins whose count a login or an admission stopped: retries so far and the next one. */
  const retries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Origins waiting for or in a count. */
  const queued = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let saved: Promise<void> = Promise.resolve();
  let restored: Promise<void> | undefined;

  function restore(): Promise<void> {
    restored ??= (async () => {
      let stored: unknown;
      try {
        stored = await deps.storage.getValue();
      } catch {
        return;
      }
      const parsed = v.safeParse(storedSchema, stored);
      if (!parsed.success) return;
      // Counts made since the start are newer than the stored ones.
      const newer = new Map(cache);
      cache.clear();
      for (const [origin, key, count] of parsed.output.origins.slice(-SITE_COUNT_LIMIT))
        cache.set(origin, { key, count });
      for (const [origin, entry] of newer) remember(origin, entry);
    })();
    return restored;
  }
  function remember(origin: string, entry: { key: string; count: SiteCount }): void {
    cache.delete(origin);
    cache.set(origin, entry);
    for (const oldest of cache.keys()) {
      if (cache.size <= SITE_COUNT_LIMIT) break;
      cache.delete(oldest);
    }
  }
  function save(): void {
    const value = {
      origins: [...cache].map(([origin, { key, count }]) => [origin, key, count]),
    };
    saved = saved.then(() => deps.storage.setValue(value)).catch(() => undefined);
  }
  function showAll(origin: string, state: SiteCountState | undefined): void {
    for (const [tabId, shown] of tabs) if (shown === origin) deps.show(tabId, origin, state);
  }
  /**
   * Shows the cached count of the tab's origin; answers true on a miss a count could
   * fill, with every vault open.
   */
  async function apply(
    tabId: number,
    origin: string,
    read: Promise<CountScope> = readScope(),
  ): Promise<boolean> {
    await restore();
    const scope = await read;
    if (tabs.get(tabId) !== origin) return false;
    if ("unchecked" in scope) {
      deps.show(tabId, origin, { kind: "unchecked", reason: scope.unchecked });
      return false;
    }
    const cached = cache.get(origin);
    if (cached?.key === scope.key) {
      remember(origin, cached);
      deps.show(tabId, origin, { kind: "count", count: cached.count });
      return false;
    }
    if (!countable(scope)) {
      deps.show(tabId, origin, { kind: "unchecked", reason: "not-opened" });
      return false;
    }
    // A count of older settings or vaults no longer applies.
    deps.show(tabId, origin, undefined);
    return true;
  }
  /** The current scope; settings or a record that cannot be read leave the vault unchecked. */
  function readScope(): Promise<CountScope> {
    return deps.scope().catch(() => ({ unchecked: "unreadable" as const }));
  }
  /**
   * Shows each given tab's cached count, from one read of the settings and records, and
   * counts the misses of tabs whose page has settled.
   */
  async function applyAll(entries: Iterable<[number, string]>): Promise<void> {
    const read = readScope();
    await Promise.all(
      [...entries].map(async ([tabId, origin]) => {
        if ((await apply(tabId, origin, read)) && settled.has(tabId)) enqueue(origin);
      }),
    );
  }
  function enqueue(origin: string): void {
    if (queued.has(origin)) return;
    queued.add(origin);
    queue = queue
      .then(() => countOrigin(origin))
      .catch(() => undefined)
      .finally(() => queued.delete(origin));
  }
  const showing = (origin: string) => [...tabs.values()].includes(origin);
  function dropRetry(origin: string): void {
    clearTimeout(retries.get(origin)?.timer);
    retries.delete(origin);
  }
  /** A login or an admission stopped the count: the tabs say so and it is tried again. */
  function stopped(origin: string): void {
    showAll(origin, { kind: "unchecked", reason: "busy" });
    const attempt = retries.get(origin)?.attempt ?? 0;
    clearTimeout(retries.get(origin)?.timer);
    const wait = STOPPED_RETRY_MS[attempt];
    retries.set(origin, {
      attempt: attempt + 1,
      ...(wait === undefined
        ? {}
        : {
            timer: setTimeout(() => {
              if (showing(origin)) enqueue(origin);
              else dropRetry(origin);
            }, wait),
          }),
    });
  }
  /**
   * Tries every stopped count again now, as when a login ended; the waits go on from where
   * they were, so frequent announcements do not keep them short.
   */
  function retryStopped(): void {
    for (const [origin, { attempt, timer }] of retries) {
      clearTimeout(timer);
      if (!showing(origin)) {
        retries.delete(origin);
        continue;
      }
      retries.set(origin, { attempt });
      enqueue(origin);
    }
  }
  async function countOrigin(origin: string): Promise<void> {
    if (!showing(origin)) {
      dropRetry(origin);
      return;
    }
    let counted: { key: string; state: SiteCountState | undefined } | undefined;
    const release = await deps.hold();
    try {
      const scope = await readScope();
      const cached = "key" in scope ? cache.get(origin) : undefined;
      if ("unchecked" in scope) showAll(origin, { kind: "unchecked", reason: scope.unchecked });
      else if (cached?.key === scope.key) showAll(origin, { kind: "count", count: cached.count });
      else {
        let state: SiteCountState | undefined;
        try {
          state = await countSite(origin, scope, deps.step);
        } catch {
          state = { kind: "unchecked", reason: "unreadable" };
        }
        counted = { key: scope.key, state };
      }
    } finally {
      // Only the count's own jobs keep vault replacement off.
      release();
    }
    if (!counted?.state) {
      if (counted) stopped(origin);
      else dropRetry(origin);
      return;
    }
    dropRetry(origin);
    const { key, state } = counted;
    if (state.kind === "count") {
      remember(origin, { key, count: state.count });
      save();
    }
    // Settings saved or a vault locked meanwhile: the tabs show what applies now.
    const now = readScope();
    const current = await now;
    if ("key" in current && current.key === key) showAll(origin, state);
    else
      await Promise.all(
        [...tabs]
          .filter(([, shown]) => shown === origin)
          .map(([tabId]) => apply(tabId, origin, now)),
      );
  }
  function stopTimer(tabId: number): void {
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);
  }
  /** Notes the tab's origin; answers it when it is counted. */
  function track(tabId: number, url: string | undefined): string | undefined {
    const origin = countedOrigin(url);
    if (origin) tabs.set(tabId, origin);
    else tabs.delete(tabId);
    return origin;
  }

  return {
    /** Shows the cached count of the tab's page, as on tab activation. */
    async apply(tabId: number, url: string | undefined): Promise<void> {
      const origin = track(tabId, url);
      if (origin) await apply(tabId, origin);
    },
    /** The tab's top frame announced and the runtime handled it. */
    async announced(tabId: number, url: string): Promise<void> {
      settled.add(tabId);
      stopTimer(tabId);
      const origin = track(tabId, url);
      if (origin && (await apply(tabId, origin))) enqueue(origin);
      // The admission that stopped another count has ended.
      retryStopped();
    },
    /** A login ended, so counts it stopped may run now. */
    retryStopped,
    /** The tab started loading a page, which has not announced yet. */
    loading(tabId: number): void {
      settled.delete(tabId);
      stopTimer(tabId);
    },
    /** The tab's page finished loading; a page that never announces is counted later. */
    async loaded(tabId: number, url: string | undefined): Promise<void> {
      stopTimer(tabId);
      const origin = track(tabId, url);
      if (!origin) return;
      await apply(tabId, origin);
      if (settled.has(tabId) || tabs.get(tabId) !== origin) return;
      // Another load may have armed one while the cached count was read.
      stopTimer(tabId);
      timers.set(
        tabId,
        setTimeout(() => {
          timers.delete(tabId);
          if (settled.has(tabId) || tabs.get(tabId) !== origin) return;
          settled.add(tabId);
          void apply(tabId, origin).then((miss) => miss && enqueue(origin));
        }, UNANNOUNCED_COUNT_MS),
      );
    },
    /**
     * Settings or a vault changed: counts made for the previous ones stop showing, and
     * settled tabs are counted again.
     */
    async refresh(): Promise<void> {
      await applyAll(tabs);
    },
    /**
     * Shows the cached counts of every open tab, as at worker start; a tab that had
     * finished loading counts as settled, since its page announced to the worker before.
     */
    async applyTabs(
      entries: readonly {
        id?: number | undefined;
        url?: string | undefined;
        status?: string | undefined;
      }[],
    ): Promise<void> {
      const counted: [number, string][] = [];
      for (const { id, url, status } of entries) {
        const origin = id === undefined ? undefined : track(id, url);
        if (id === undefined || !origin) continue;
        if (status === "complete") settled.add(id);
        counted.push([id, origin]);
      }
      // Only shows: a count waits for an announcement or a change.
      const read = readScope();
      await Promise.all(counted.map(([tabId, origin]) => apply(tabId, origin, read)));
    },
    removed(tabId: number): void {
      tabs.delete(tabId);
      settled.delete(tabId);
      stopTimer(tabId);
    },
    /** For tests: resolves once every queued count has finished. */
    idle: async () => {
      while (queued.size) await queue; // oxlint-disable-line no-await-in-loop
    },
  };
}
