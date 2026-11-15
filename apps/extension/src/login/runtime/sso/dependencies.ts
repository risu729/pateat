import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  itemAsksForMasterPassword,
  resolvePagePermission,
  type SettingsResponse,
} from "@pateat/contracts";
import { pausedInPrivate } from "../../pause";
import type { SsoWork } from "../sso-state";

type Saved = Extract<SettingsResponse, { ok: true }>;

/**
 * What an SSO flow reads from the settings and the vault catalog (ADR 0026): both
 * accounts' eligibility, items and connections, the RP and IdP pages' permissions, site
 * rules and master-password asks, private-window pausing and the two origins' saved
 * defaults. Each scope check also reads these from the current settings itself.
 */
function ssoDependencies(work: SsoWork, saved: Saved): string {
  const { settings } = saved.snapshot;
  const pages = [work.rpLive.url, work.live.url, work.selected.origin];
  return JSON.stringify({
    accounts: [work.source.account, work.selected.account].map((account) => {
      const found = getItemEligibility(
        settings,
        saved.catalog,
        account.connectionId,
        account.itemId,
      );
      const connection = saved.catalog.connections.find(
        (entry) => entry.id === account.connectionId,
      );
      return {
        found,
        connection: connection && {
          provider: connection.provider,
          server: connection.server,
          userId: connection.userId,
          snapshotId: connection.snapshotId,
          state: connection.state,
          quarantined: connection.quarantinedItemIds?.includes(account.itemId) === true,
        },
        reprompt: pages.map((page) =>
          itemAsksForMasterPassword(settings, found.eligible ? found.item : undefined, page),
        ),
      };
    }),
    pages: pages.map((page) => [
      resolvePagePermission(settings, page, "sign-in")?.permission,
      isSiteExcluded(settings, page),
      isSiteAllowed(settings, page),
    ]),
    privatePaused: pausedInPrivate(settings, work.rpLive.incognito),
    defaults: settings.siteDefaults.filter(
      (entry) => entry.origin === work.account.origin || entry.origin === work.selected.origin,
    ),
  });
}

/**
 * Whether `next` keeps everything the flow depends on from `before`. A newer revision
 * that changes none of it, as another site's account choice or a sync of unrelated
 * settings, keeps the flow; one that changes any of it ends the flow.
 */
export const ssoDependenciesKept = (work: SsoWork, before: Saved, next: Saved): boolean =>
  ssoDependencies(work, before) === ssoDependencies(work, next);
