import { isSiteExcluded, type SettingsSnapshot } from "@pateat/contracts";
import { browser } from "wxt/browser";

/** Why a document is not admitted; logged for a login-related page (ADR 0019). */
export type SiteRefusal = "not-web" | "site-excluded" | "no-site-access" | "settings-unavailable";

export interface LoginSites {
  /** Exact HTTP(S) origins with a saved default, no exclusion and host access still granted. */
  origins(): Promise<string[]>;
  /** HTTP(S) documents on a non-excluded site with host access still granted, else why not. */
  admission(url: URL): Promise<"admitted" | SiteRefusal>;
}

const webOrigin = (origin: string) => origin.startsWith("https://") || origin.startsWith("http://");
// Chrome match patterns do not carry ports; site access is granted per scheme and host.
const hostPattern = (url: URL) => `${url.protocol}//${url.hostname}/*`;

/**
 * Production document admission. The content script runs on every HTTP(S) page; a
 * document on a non-excluded site with host access is admitted, with or without a saved
 * site default (ADR 0013 chooses an account by URI match). An admitted document without a
 * cached recipe stops there: no attempt, observation, policy catalog or vault access.
 * Account eligibility is still checked per attempt; on an `http:` page only items saved
 * with an `http://` URI match (ADR 0050).
 */
export function createLoginSites(settings: { read(): Promise<SettingsSnapshot> }): LoginSites {
  async function origins(): Promise<string[]> {
    const snapshot = await settings.read();
    const candidates = [
      ...new Set(
        snapshot.settings.siteDefaults
          .map((entry) => entry.origin)
          .filter((origin) => webOrigin(origin) && !isSiteExcluded(snapshot.settings, origin)),
      ),
    ];
    // Chrome lets the user withhold site access after install; respect that per origin.
    const granted = await Promise.all(
      candidates.map((origin) =>
        browser.permissions
          .contains({ origins: [hostPattern(new URL(origin))] })
          .catch(() => false),
      ),
    );
    return candidates.filter((_origin, index) => granted[index]);
  }
  return {
    origins,
    async admission(url) {
      if (url.protocol !== "https:" && url.protocol !== "http:") return "not-web";
      let current: SettingsSnapshot["settings"];
      try {
        current = (await settings.read()).settings;
      } catch {
        return "settings-unavailable";
      }
      if (isSiteExcluded(current, url.origin)) return "site-excluded";
      const granted = await browser.permissions
        .contains({ origins: [hostPattern(url)] })
        .catch(() => false);
      return granted ? "admitted" : "no-site-access";
    },
  };
}
