// The site count badge (ADR 0021): how many vault items match a tab's HTTPS origin, and
// how many of them a login may use. A count only reads vaults the service worker already
// has open; it never opens one, and keeps no item ID, name or value, only the numbers.
import {
  getItemEligibility,
  isSiteExcluded,
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
import { passkeyEligible } from "../passkeys/vault";
import { rpIdsFor } from "../passkeys/rp-id";
import type { VaultResult } from "../vault/record";

export const SITE_COUNT_KEY = "session:pateat.site-count.v1";
/** Origins whose counts are kept; the least recently used goes first. */
export const SITE_COUNT_LIMIT = 200;
/** A finished load that the page never announced is counted after this long. */
export const UNANNOUNCED_COUNT_MS = 5000;

/** Why a tab shows no number although its site may have items (ADR 0021). */
export type UncheckedReason = "locked" | "not-opened" | "unreadable" | "updating";
/** Why none of the matching items is usable. */
export type ExcludedReason = "site" | "items" | "review" | "items-review";
export type SiteCount = {
  /** Items a login on the origin may use; the popup lists the same ones. */
  usable: number;
  /** Items whose URI rule matches the origin or that hold a passkey for its RP IDs. */
  matching: number;
  /** Usable items whose URI rules or passkeys could not be read, left out of both numbers. */
  unevaluated: number;
  /** Set when items match but none is usable. */
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
  | { unchecked: Exclude<UncheckedReason, "not-opened"> }
  | { snapshot: SettingsSnapshot; sources: CountSource[]; key: string };

/** Runs one crypto job unless a login runs or a page is being admitted (ADR 0021). */
export type CountStep = <T>(job: () => Promise<T>) => Promise<{ value: T } | undefined>;

/** The origin a tab's page is counted for: HTTPS only. */
export function countedOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The connections a count may read, from the registry and the open vaults, without opening any. */
export function createCountScope(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor"> & {
    settings: { read(): Promise<SettingsSnapshot> };
  },
  fixed: VaultCatalog = { connections: [] },
): () => Promise<CountScope> {
  return async () => {
    const snapshot = await connections.settings.read();
    const enabled = (id: string) =>
      snapshot.settings.connections.some((entry) => entry.connectionId === id && entry.enabled);
    const sources: CountSource[] = fixed.connections
      .filter((connection) => enabled(connection.id))
      .map((connection) => ({ connectionId: connection.id, fixed: connection }));
    for (const configuration of await connections.registry.list()) {
      const connectionId = configuration.profile.connectionId;
      if (!enabled(connectionId)) continue;
      const vault = connections.vaultFor(configuration.profile);
      // oxlint-disable-next-line no-await-in-loop -- one record read per connection
      const record = await vault.store.read();
      if (!record.ok) return { unchecked: "unreadable" };
      if (record.data?.state !== "active") return { unchecked: "locked" };
      const { snapshotId } = record.data.accepted;
      const handle = vault.manager.status().handle;
      if (handle && handle.snapshotId !== snapshotId) return { unchecked: "updating" };
      sources.push({
        connectionId,
        snapshotId,
        ...(handle
          ? {
              open: {
                catalog: () => vault.manager.catalog(handle),
                matchUris: (url) => vault.manager.matchUris(handle, url),
                findPasskeys: (rpId) => vault.manager.findPasskeys(handle, rpId),
              },
            }
          : {}),
      });
    }
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
    // By item: whether it matched by URI rule, by passkey, and whether a rule was unevaluated.
    const items = new Map<string, { uri?: true; passkey?: true; unknown?: true }>();
    const mark = (itemId: string, how: "uri" | "passkey" | "unknown") =>
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
      // URI rules are matched for `origin/`, as the popup's list does.
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
          mark(unavailable.itemId, "unknown");
      for (const itemId of uris.value.data.unavailableItemIds) mark(itemId, "unknown");
      for (const rpId of rpIdsFor(origin)) {
        // oxlint-disable-next-line no-await-in-loop
        const found = await step(() => open.findPasskeys(rpId));
        if (!found) return undefined;
        if (!found.value.ok) return { kind: "unchecked", reason: failed(found.value.error.code) };
        if (found.value.data.snapshotId !== source.snapshotId || found.value.data.rpId !== rpId)
          return { kind: "unchecked", reason: "updating" };
        for (const candidate of found.value.data.candidates) mark(candidate.itemId, "passkey");
        for (const itemId of found.value.data.unavailableItemIds) mark(itemId, "unknown");
      }
    }
    const catalog = { connections: [entry] };
    for (const [itemId, how] of items) {
      if (!how.uri && !how.passkey) {
        // Only an item a login could use is noted, as the popup's list does.
        if (
          !quarantined.includes(itemId) &&
          passkeyEligible(settings, catalog, source.connectionId, itemId)
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
    usable > 0 || matching === 0
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
 * starts, tab activation and finished loads only show a cached count.
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
  /** Tabs whose page announced since the tab last started loading. */
  const announced = new Set<number>();
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
  async function apply(tabId: number, origin: string): Promise<boolean> {
    await restore();
    let scope: CountScope;
    try {
      scope = await deps.scope();
    } catch {
      scope = { unchecked: "unreadable" };
    }
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
  function enqueue(origin: string): void {
    if (queued.has(origin)) return;
    queued.add(origin);
    queue = queue
      .then(() => countOrigin(origin))
      .catch(() => undefined)
      .finally(() => queued.delete(origin));
  }
  async function countOrigin(origin: string): Promise<void> {
    if (![...tabs.values()].includes(origin)) return;
    const release = await deps.hold();
    try {
      const scope = await deps.scope();
      if ("unchecked" in scope) {
        showAll(origin, { kind: "unchecked", reason: scope.unchecked });
        return;
      }
      const cached = cache.get(origin);
      if (cached?.key === scope.key) {
        showAll(origin, { kind: "count", count: cached.count });
        return;
      }
      let state: SiteCountState | undefined;
      try {
        state = await countSite(origin, scope, deps.step);
      } catch {
        state = { kind: "unchecked", reason: "unreadable" };
      }
      // Stopped for a login or a page; the page's next announcement counts again.
      if (!state) return;
      if (state.kind === "count") {
        remember(origin, { key: scope.key, count: state.count });
        save();
      }
      // Settings saved or a vault locked meanwhile: the tabs show what applies now.
      let now: CountScope;
      try {
        now = await deps.scope();
      } catch {
        now = { unchecked: "unreadable" };
      }
      if ("key" in now && now.key === scope.key) showAll(origin, state);
      else
        await Promise.all(
          [...tabs].filter(([, shown]) => shown === origin).map(([tabId]) => apply(tabId, origin)),
        );
    } finally {
      release();
    }
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
    /** Shows the cached count of the tab's page, as at worker start or tab activation. */
    async apply(tabId: number, url: string | undefined): Promise<void> {
      const origin = track(tabId, url);
      if (origin) await apply(tabId, origin);
    },
    /** The tab's top frame announced and the runtime handled it. */
    async announced(tabId: number, url: string): Promise<void> {
      announced.add(tabId);
      stopTimer(tabId);
      const origin = track(tabId, url);
      if (origin && (await apply(tabId, origin))) enqueue(origin);
    },
    /** The tab started loading a page, which has not announced yet. */
    loading(tabId: number): void {
      announced.delete(tabId);
      stopTimer(tabId);
    },
    /** The tab's page finished loading; a page that never announces is counted later. */
    async loaded(tabId: number, url: string | undefined): Promise<void> {
      stopTimer(tabId);
      const origin = track(tabId, url);
      if (!origin) return;
      await apply(tabId, origin);
      if (announced.has(tabId) || tabs.get(tabId) !== origin) return;
      // Another load may have armed one while the cached count was read.
      stopTimer(tabId);
      timers.set(
        tabId,
        setTimeout(() => {
          timers.delete(tabId);
          if (announced.has(tabId) || tabs.get(tabId) !== origin) return;
          void apply(tabId, origin).then((miss) => miss && enqueue(origin));
        }, UNANNOUNCED_COUNT_MS),
      );
    },
    /** Settings or a vault changed: counts made for the previous ones stop showing. */
    async refresh(): Promise<void> {
      await Promise.all([...tabs].map(([tabId, origin]) => apply(tabId, origin)));
    },
    removed(tabId: number): void {
      tabs.delete(tabId);
      announced.delete(tabId);
      stopTimer(tabId);
    },
    /** For tests: resolves once every queued count has finished. */
    idle: async () => {
      while (queued.size) await queue; // oxlint-disable-line no-await-in-loop
    },
  };
}
