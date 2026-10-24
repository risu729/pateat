import { isSupportedSite, type SettingsSnapshot } from "@pateat/contracts";
import { browser } from "wxt/browser";

/** Why a document is not admitted; logged for a login-related page (ADR 0019). */
export type SiteRefusal =
  | "not-web"
  /** A hostname policy inputs do not accept, where Pateat never runs. */
  | "unsupported-host"
  | "no-site-access"
  | "settings-unavailable";

export type PausingSettings = Pick<
  SettingsSnapshot["settings"],
  "excludedSites" | "loginInPrivateWindows"
>;

export interface LoginSites {
  /** Exact HTTP(S) origins with a saved default and host access still granted. */
  origins(): Promise<string[]>;
  /**
   * HTTP(S) documents with host access still granted, else why not. An exclusion rule
   * admits the document: it pauses automatic login there (ADR 0062).
   */
  admission(url: URL): Promise<"admitted" | SiteRefusal>;
  /**
   * What of the saved settings pauses automatic login (ADR 0062), read as admission reads
   * the settings: the exclusion rules, which pause it until turned back on, and whether it
   * runs in private windows.
   */
  pausing(): Promise<PausingSettings>;
}

const webOrigin = (origin: string) => origin.startsWith("https://") || origin.startsWith("http://");
// Chrome match patterns do not carry ports; site access is granted per scheme and host.
const hostPattern = (url: URL) => `${url.protocol}//${url.hostname}/*`;

/**
 * Production document admission. The content script runs on every HTTP(S) page; a
 * document with a supported hostname and host access is admitted, with or without a saved
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
          .filter((origin) => webOrigin(origin) && isSupportedSite(origin)),
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
    async pausing() {
      const { excludedSites, loginInPrivateWindows } = (await settings.read()).settings;
      return { excludedSites, ...(loginInPrivateWindows ? { loginInPrivateWindows } : {}) };
    },
    async admission(url) {
      if (url.protocol !== "https:" && url.protocol !== "http:") return "not-web";
      try {
        await settings.read();
      } catch {
        return "settings-unavailable";
      }
      if (!isSupportedSite(url.origin)) return "unsupported-host";
      const granted = await browser.permissions
        .contains({ origins: [hostPattern(url)] })
        .catch(() => false);
      return granted ? "admitted" : "no-site-access";
    },
  };
}
