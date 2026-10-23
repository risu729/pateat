import {
  isPasskeyBrowserSite,
  normalizeHostname,
  parseSiteUrl,
  type LocalSettings,
  type SettingsChangeCause,
  type SettingsSnapshot,
} from "@pateat/contracts";

/** The `storage.session` key of hostnames chosen "Always" whose settings write is pending. */
export const PENDING_BROWSER_SITES_KEY = "session:pateat.passkey-browser-sites-pending.v1";

/** The settings schema's bound on the list; a full list keeps its entries. */
const MAX_SITES = 1000;
/** How often a write that waits for a running login checks again. */
const LOGIN_POLL_MS = 1000;

/**
 * Adds the exact hostname of `origin` to the sites whose passkey requests go to the browser,
 * for the chooser's "Always for this site" (ADR 0007). A settings write stops a running
 * login, so the write waits while `loginActive` holds, at most `maxWaitMs`, as a settings
 * sync does. Returns whether the settings changed: nothing is written for a hostname
 * already listed, an invalid origin or a full list.
 */
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

export async function addPasskeyBrowserSite(input: {
  settings: BrowserSiteSettings;
  origin: string;
  loginActive?: () => Promise<boolean>;
  maxWaitMs?: number;
  now?: () => number;
}): Promise<boolean> {
  const hostname = hostnameOf(input.origin);
  if (!hostname) return false;
  const now = input.now ?? Date.now;
  const until = now() + (input.maxWaitMs ?? 0);
  // oxlint-disable-next-line no-await-in-loop -- each check waits for the previous one
  while (input.loginActive && (await input.loginActive()) && now() < until)
    // oxlint-disable-next-line no-await-in-loop -- polls until the login ends
    await new Promise((done) => setTimeout(done, LOGIN_POLL_MS));
  const fits = (snapshot: SettingsSnapshot) =>
    !snapshot.settings.passkeyBrowserSites.some((site) => site.hostname === hostname) &&
    snapshot.settings.passkeyBrowserSites.length < MAX_SITES;
  // Read first, so a hostname already listed does not bump the revision.
  if (!fits(await input.settings.read())) return false;
  let added = false;
  await input.settings.update(undefined, "passkey-browser-site", (snapshot) => {
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
 * wait for the settings store, and from the hostnames chosen "Always" whose write still waits
 * for a running login. Those are kept in `storage.session`, written before the wait, so they
 * hold at once and across a worker restart, which resumes their writes; each is dropped once
 * its write landed or was refused.
 */
export function createPasskeyBrowserSites(input: {
  settings: BrowserSiteSettings;
  pending: { getValue(): Promise<unknown>; setValue(value: unknown): Promise<void> };
  loginActive?: () => Promise<boolean>;
  maxWaitMs?: number;
  /** Keeps the worker running while a write waits. */
  keepAlive?: <T>(work: Promise<T>) => Promise<T>;
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
  // Hostname → writes waiting for it; the session copy lists the keys.
  const pending = new Map<string, number>();
  let persisted: Promise<void> = Promise.resolve();
  const persist = () => {
    const hostnames = [...pending.keys()];
    persisted = persisted
      .then(() => input.pending.setValue(hostnames.length ? hostnames : null))
      .catch(() => undefined);
    return persisted;
  };
  const write = async (hostname: string) => {
    pending.set(hostname, (pending.get(hostname) ?? 0) + 1);
    await persist();
    let added = false;
    try {
      const work = addPasskeyBrowserSite({
        settings: input.settings,
        origin: `https://${hostname}`,
        ...(input.loginActive ? { loginActive: input.loginActive } : {}),
        ...(input.maxWaitMs === undefined ? {} : { maxWaitMs: input.maxWaitMs }),
      });
      added = await (input.keepAlive ? input.keepAlive(work) : work);
    } finally {
      // The settings are read again before the pending hostname is forgotten.
      void refresh();
      const left = (pending.get(hostname) ?? 1) - 1;
      if (left > 0) pending.set(hostname, left);
      else pending.delete(hostname);
      await persist();
    }
    if (added) input.added?.();
  };
  const resume = async () => {
    const stored = await input.pending.getValue();
    if (!Array.isArray(stored)) return;
    for (const entry of stored.slice(0, MAX_SITES)) {
      const hostname = typeof entry === "string" ? normalizeHostname(entry) : undefined;
      // A worker restart stopped this write; it runs again.
      if (hostname && hostname === entry) void write(hostname).catch(() => undefined);
    }
  };
  const loaded = resume().catch(() => undefined);
  void refresh();
  return {
    async has(origin: string): Promise<boolean> {
      await loaded;
      const hostname = hostnameOf(origin);
      if (hostname && pending.has(hostname)) return true;
      return isPasskeyBrowserSite(await (listed ?? refresh()), origin);
    },
    /** Adds the origin's hostname, for the chooser's "Always for this site". */
    async add(origin: string): Promise<void> {
      const hostname = hostnameOf(origin);
      if (hostname) await write(hostname);
    },
    /** The settings changed: they are read again for the next request. */
    changed() {
      void refresh();
    },
  };
}
