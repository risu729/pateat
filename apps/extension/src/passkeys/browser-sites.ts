import {
  isPasskeyBrowserSite,
  normalizeHostname,
  parseSiteUrl,
  type LocalSettings,
  type SettingsChangeCause,
  type SettingsSnapshot,
} from "@pateat/contracts";
import * as v from "valibot";

/** The `storage.session` key of hostnames chosen "Always" whose settings write is pending. */
export const PENDING_BROWSER_SITES_KEY = "session:pateat.passkey-browser-sites-pending.v1";

/** The settings schema's bound on the list; a full list keeps its entries. */
const MAX_SITES = 1000;
/** How often a write that waits for a running login checks again. */
const LOGIN_POLL_MS = 1000;

/** The `storage.session` copy of the pending hostnames; `writing` once its write started. */
const pendingSchema = v.pipe(
  v.array(
    v.object({
      hostname: v.string(),
      at: v.pipe(v.number(), v.safeInteger()),
      writing: v.optional(v.literal(true)),
    }),
  ),
  v.maxLength(MAX_SITES),
);

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
 * for the chooser's "Always for this site" (ADR 0007). A settings write stops a running
 * login, so the write waits while `loginActive` holds, at most `maxWaitMs`, as a settings
 * sync does. Returns whether the settings changed: nothing is written for a hostname
 * already listed, an invalid origin or a full list.
 */
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
  await waitForLogin(input.loginActive, now() + (input.maxWaitMs ?? 0), now);
  return writeSite(input.settings, hostname);
}

/** Waits while `loginActive` holds, until `until`. */
async function waitForLogin(
  loginActive: (() => Promise<boolean>) | undefined,
  until: number,
  now: () => number,
) {
  if (!loginActive) return;
  // oxlint-disable-next-line no-await-in-loop -- each check waits for the previous one
  while ((await loginActive()) && now() < until)
    // oxlint-disable-next-line no-await-in-loop -- polls until the login ends
    await new Promise((done) => setTimeout(done, LOGIN_POLL_MS));
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
 * wait for the settings store, and from the hostnames chosen "Always" whose write still waits
 * for a running login. Those are kept in `storage.session`, written before the wait, so they
 * hold at once and across a worker restart, which resumes a write still waiting within the
 * wait limit; each is dropped once its write landed or was refused.
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
  now?: () => number;
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
  const now = input.now ?? Date.now;
  const limit = input.maxWaitMs ?? 0;
  /** A chosen hostname whose write has not ended: when it was chosen, and its writes. */
  type Pending = { at: number; writes: number; writing: boolean };
  const pending = new Map<string, Pending>();
  let persisted: Promise<void> = Promise.resolve();
  const persist = () => {
    const entries = [...pending].map(([hostname, entry]) => ({
      hostname,
      at: entry.at,
      ...(entry.writing ? { writing: true } : {}),
    }));
    persisted = persisted
      .then(() => input.pending.setValue(entries.length ? entries : null))
      .catch(() => undefined);
    return persisted;
  };
  const write = async (hostname: string, at = now()) => {
    const entry = pending.get(hostname) ?? { at, writes: 0, writing: false };
    entry.writes += 1;
    pending.set(hostname, entry);
    await persist();
    let added = false;
    try {
      const work = (async () => {
        await waitForLogin(input.loginActive, entry.at + limit, now);
        // Marked before the write: a restart cannot tell whether it landed, and then
        // does not write again, so a removal on the settings page is never undone.
        entry.writing = true;
        await persist();
        return writeSite(input.settings, hostname);
      })();
      added = await (input.keepAlive ? input.keepAlive(work) : work);
    } finally {
      // The settings are read again before the pending hostname is forgotten.
      void refresh();
      entry.writes -= 1;
      if (entry.writes === 0) pending.delete(hostname);
      await persist();
    }
    if (added) input.added?.();
  };
  /**
   * After a worker restart, a write that was still waiting for a login runs again, until
   * the wait limit from its choice; one that had started, or is older, is dropped.
   */
  const resume = async () => {
    const stored = v.safeParse(pendingSchema, await input.pending.getValue());
    if (!stored.success) return;
    const resumed = stored.output.filter(
      (entry) => !entry.writing && entry.at <= now() && now() - entry.at < limit,
    );
    // Each resumed write stores the pending list again; without one, it is cleared here.
    if (!resumed.length && stored.output.length) await persist();
    for (const { hostname, at } of resumed) {
      // Only hostnames as `write` stored them.
      if (normalizeHostname(hostname) === hostname) void write(hostname, at).catch(() => undefined);
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
    /** Whether the origin's hostname was chosen and its write has not ended yet. */
    pending(origin: string): boolean {
      const hostname = hostnameOf(origin);
      return hostname !== undefined && pending.has(hostname);
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
