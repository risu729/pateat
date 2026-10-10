import { isSiteExcluded, type SettingsSnapshot } from "@pateat/contracts";
import { browser } from "wxt/browser";

export interface LoginSites {
  /** Exact HTTPS origins with a saved default, no exclusion and host access still granted. */
  origins(): Promise<string[]>;
  /** Top-level HTTPS documents on a non-excluded site with host access still granted. */
  admits(url: URL): Promise<boolean>;
}

/**
 * Production document admission. The content script runs on every HTTPS page; a document
 * on a non-excluded site with host access is admitted, with or without a saved site
 * default (ADR 0013 chooses an account by URI match). An admitted document without a
 * cached recipe stops there: no attempt, observation, policy catalog or vault access.
 * Account eligibility is still checked per attempt.
 */
export function createLoginSites(settings: { read(): Promise<SettingsSnapshot> }): LoginSites {
  async function origins(): Promise<string[]> {
    const snapshot = await settings.read();
    const candidates = [
      ...new Set(
        snapshot.settings.siteDefaults
          .map((entry) => entry.origin)
          .filter(
            (origin) => origin.startsWith("https://") && !isSiteExcluded(snapshot.settings, origin),
          ),
      ),
    ];
    // Chrome lets the user withhold site access after install; respect that per origin.
    const granted = await Promise.all(
      candidates.map((origin) =>
        browser.permissions
          .contains({ origins: [`https://${new URL(origin).hostname}/*`] })
          .catch(() => false),
      ),
    );
    return candidates.filter((_origin, index) => granted[index]);
  }
  return {
    origins,
    async admits(url) {
      if (url.protocol !== "https:") return false;
      try {
        const { settings: current } = await settings.read();
        return (
          !isSiteExcluded(current, url.origin) &&
          (await browser.permissions.contains({ origins: [`https://${url.hostname}/*`] }))
        );
      } catch {
        return false;
      }
    },
  };
}
