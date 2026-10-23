import {
  normalizeHostname,
  parseSiteUrl,
  type SettingsChangeCause,
  type SettingsSnapshot,
} from "@pateat/contracts";

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
export async function addPasskeyBrowserSite(input: {
  settings: {
    read(): Promise<SettingsSnapshot>;
    update(
      expectedRevision: number | undefined,
      cause: SettingsChangeCause,
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
    ): Promise<SettingsSnapshot>;
  };
  origin: string;
  loginActive?: () => Promise<boolean>;
  maxWaitMs?: number;
  now?: () => number;
}): Promise<boolean> {
  const url = parseSiteUrl(input.origin);
  const hostname = url && normalizeHostname(url.hostname);
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
