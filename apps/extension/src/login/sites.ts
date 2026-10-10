import { isSiteExcluded, type SettingsSnapshot } from "@pateat/contracts";
import { browser } from "wxt/browser";

export interface LoginSites {
  /** Exact HTTPS origins with a saved default, no exclusion and host access still granted. */
  origins(): Promise<string[]>;
  admits(url: URL): Promise<boolean>;
}

/**
 * Production document admission. The content script runs on every HTTPS page, but only
 * an exact origin with a saved site default is admitted; every other document gets no
 * attempt, observation or vault lookup. Account eligibility is still checked per attempt.
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
        return (await origins()).includes(url.origin);
      } catch {
        return false;
      }
    },
  };
}
