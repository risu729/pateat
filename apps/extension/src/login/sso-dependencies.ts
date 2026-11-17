import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  itemAsksForMasterPassword,
  resolvePagePermission,
  type SettingsResponse,
} from "@pateat/contracts";
import { pausedInPrivate } from "./pause";

type Saved = Extract<SettingsResponse, { ok: true }>;

/**
 * The accounts, pages and origins an SSO flow or method offer reads from the settings,
 * and whether its tab is a private window.
 */
export type SsoDependencyScope = {
  accounts: { connectionId: string; itemId: string }[];
  pages: string[];
  /** The origins whose saved defaults it depends on. */
  origins: string[];
  incognito: boolean | undefined;
};

/**
 * What an SSO flow or offer reads from the settings and the vault catalog (ADR 0026,
 * ADR 0085): its accounts' eligibility, items and connections, its pages' permissions,
 * site rules and master-password asks, private-window pausing and its origins' saved
 * defaults. Each scope check also reads these from the current settings itself.
 */
export function ssoScopeDependencies(scope: SsoDependencyScope, saved: Saved): string {
  const { settings } = saved.snapshot;
  return JSON.stringify({
    accounts: scope.accounts.map((account) => {
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
        reprompt: scope.pages.map((page) =>
          itemAsksForMasterPassword(settings, found.eligible ? found.item : undefined, page),
        ),
      };
    }),
    pages: scope.pages.map((page) => [
      resolvePagePermission(settings, page, "sign-in")?.permission,
      isSiteExcluded(settings, page),
      isSiteAllowed(settings, page),
    ]),
    privatePaused: pausedInPrivate(settings, scope.incognito),
    defaults: settings.siteDefaults.filter((entry) => scope.origins.includes(entry.origin)),
  });
}
