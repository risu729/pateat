import {
  isPasskeyBrowserSite,
  normalizeHostname,
  parseSiteUrl,
  type LocalSettings,
  type SettingsChangeCause,
  type SettingsSnapshot,
} from "@pateat/contracts";

/** The settings schema's bound on the list; a full list keeps its entries. */
const MAX_SITES = 1000;

interface BrowserSiteSettings {
  read(): Promise<SettingsSnapshot>;
  update(
    expectedRevision: number | undefined,
    cause: SettingsChangeCause,
    mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ): Promise<SettingsSnapshot>;
}

const hostnameOf = (origin: string) => {
  const url = parseSiteUrl(origin);
  return (url && normalizeHostname(url.hostname)) || undefined;
};

/**
 * Adds the exact hostname of `origin` to the sites whose passkey requests go to the browser,
 * for the chooser's "Always for this site" (ADR 0007). It is written at once: a revision of
 * only this cause stops no running login, login offer or passkey request
 * (`CHOICE_ONLY_CAUSES`), once the caller hands the cause on, as `settingsSaved` does.
 * Returns whether the settings changed: nothing is written for a hostname already listed,
 * an invalid origin or a full list.
 */
export async function addPasskeyBrowserSite(input: {
  settings: BrowserSiteSettings;
  origin: string;
}): Promise<boolean> {
  const hostname = hostnameOf(input.origin);
  return hostname ? writeSite(input.settings, hostname) : false;
}

/** Adds `hostname` unless it is listed or the list is full; returns whether it did. */
async function writeSite(settings: BrowserSiteSettings, hostname: string): Promise<boolean> {
  const fits = (snapshot: SettingsSnapshot) =>
    !snapshot.settings.passkeyBrowserSites.some((site) => site.hostname === hostname) &&
    snapshot.settings.passkeyBrowserSites.length < MAX_SITES;
  // Read first, so a hostname already listed does not bump the revision.
  if (!fits(await settings.read())) return false;
  let added = false;
  await settings.update(undefined, "passkey-browser-site", (snapshot) => {
    if (!fits(snapshot)) return snapshot;
    added = true;
    return {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        passkeyBrowserSites: [...snapshot.settings.passkeyBrowserSites, { hostname }],
      },
    };
  });
  return added;
}

/**
 * The sites whose passkey requests go to the browser, for the passkey runtime (ADR 0007).
 * `has` answers from the settings read once and kept until `changed()`, so a request does not
 * wait for the settings store, and from the hostnames chosen "Always" not written yet, so a
 * choice holds at once.
 */
export function createPasskeyBrowserSites(input: {
  settings: BrowserSiteSettings;
  /** Called once a write changed the settings. */
  added?: () => void;
}) {
  let listed: Promise<LocalSettings> | undefined;
  /** Reads the settings ahead of the next request, which then need not wait for the store. */
  const refresh = () => {
    const read = input.settings.read().then((snapshot) => snapshot.settings);
    listed = read;
    // A failed read is not kept: the next request reads again.
    read.catch(() => {
      if (listed === read) listed = undefined;
    });
    return read;
  };
  /** Chosen hostnames whose write has not ended, with how many writes of each run. */
  const pending = new Map<string, number>();
  /**
   * Chosen hostnames whose write failed. The choice still holds in memory, and is written
   * again with the next write of the settings (`changed`), so it is not lost.
   */
  const unwritten = new Set<string>();
  const chosen = (hostname: string) => pending.has(hostname) || unwritten.has(hostname);
  const write = async (hostname: string) => {
    unwritten.delete(hostname);
    pending.set(hostname, (pending.get(hostname) ?? 0) + 1);
    let added = false;
    try {
      added = await writeSite(input.settings, hostname);
    } catch (error) {
      unwritten.add(hostname);
      throw error;
    } finally {
      // The settings are read again before the pending hostname is forgotten.
      void refresh();
      const left = pending.get(hostname)! - 1;
      if (left) pending.set(hostname, left);
      else pending.delete(hostname);
    }
    if (added) input.added?.();
  };
  void refresh();
  return {
    async has(origin: string): Promise<boolean> {
      const hostname = hostnameOf(origin);
      if (hostname && chosen(hostname)) return true;
      return isPasskeyBrowserSite(await (listed ?? refresh()), origin);
    },
    /**
     * The settings as last read ahead of requests, so a passkey request's other reads, such
     * as whether its site's default counts as unset (ADR 0062, ADR 0063), need not wait for
     * the store either.
     */
    settings(): Promise<LocalSettings> {
      return listed ?? refresh();
    },
    /** Whether the origin's hostname was chosen and is not written yet. */
    pending(origin: string): boolean {
      const hostname = hostnameOf(origin);
      return hostname !== undefined && chosen(hostname);
    },
    /** Adds the origin's hostname, for the chooser's "Always for this site". */
    async add(origin: string): Promise<void> {
      const hostname = hostnameOf(origin);
      if (hostname) await write(hostname);
    },
    /**
     * The settings changed: they are read again for the next request, and a choice whose
     * write failed is written again.
     */
    changed() {
      void refresh();
      for (const hostname of unwritten) void write(hostname).catch(() => undefined);
    },
  };
}

/**
 * Calls `changed` on every write of the settings record, from any path, so the next passkey
 * request reads the list again (ADR 0007).
 */
export function watchSettingsWrites(
  onChanged: { addListener(listener: (changes: Record<string, unknown>) => void): void },
  key: string,
  changed: () => void,
) {
  onChanged.addListener((changes) => {
    if (Object.hasOwn(changes, key)) changed();
  });
}
