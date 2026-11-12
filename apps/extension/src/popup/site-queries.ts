import { normalizeHostname, parseSiteUrl } from "@pateat/contracts";
import { popupPageSectionShown } from "@pateat/contracts";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { SETTINGS_QUERY_KEY, type SettingsClient } from "../options/client";
import type { ChoiceClient } from "../login/choice-wire";
import type { DetailClient } from "../login/detail-wire";
import { privatePaused } from "./pause";
import type { PopupHost } from "./site-app";

/**
 * How long the popup waits for the site's matches. Each vault lookup of the search is
 * bounded at 30 seconds, but one after another they can take minutes while the vault is
 * busy, such as right after the extension restarted; the popup then stops waiting, above
 * one lookup's bound so a slow but working lookup still answers.
 */
export const SITE_ACCOUNTS_WAIT_MS = 45_000;
export class ListingTimeout extends Error {}

/** The tab's origin when Pateat can run there: an HTTP(S) page with a valid hostname. */
export function popupOrigin(url: string | undefined): string | undefined {
  const parsed = url === undefined ? undefined : parseSiteUrl(url);
  return (parsed?.protocol === "https:" || parsed?.protocol === "http:") &&
    normalizeHostname(parsed.hostname)
    ? parsed.origin
    : undefined;
}

/** Reads the active site's metadata and keeps the original subscription/query order. */
export function useSiteQueries({
  host,
  client,
  choices,
  details,
  listingWaitMs,
  queryClient,
}: {
  host: PopupHost;
  client: SettingsClient;
  choices: ChoiceClient;
  details: DetailClient;
  listingWaitMs: number;
  queryClient: QueryClient;
}) {
  const tab = useQuery({
    queryKey: ["popup", "tab"],
    queryFn: async () => (await host.currentTab()) ?? null,
  });
  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: () => client.getSettings() });
  // Settings saved elsewhere while the popup is open, such as the default a picked login
  // saves once it succeeds, show without reopening the popup.
  useEffect(
    () =>
      host.watchSettings(() => {
        void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY, exact: true });
      }),
    [host, queryClient],
  );
  const origin = tab.data === undefined ? undefined : popupOrigin(tab.data?.url);
  const tabId = tab.data?.id;
  const saved = settings.data?.ok ? settings.data : undefined;
  // In a private window automatic login is off unless turned on in the settings (ADR 0062).
  const inPrivate =
    saved !== undefined && privatePaused(saved.snapshot.settings, tab.data?.incognito);
  // A login refused because several accounts match, or on a paused site, waits for a pick
  // (ADR 0021, ADR 0062).
  const choice = useQuery({
    queryKey: ["popup", "choice", tabId],
    queryFn: () => choices.get(tabId!),
    enabled: tabId !== undefined && origin !== undefined && saved !== undefined,
    // The page may be refused only after the popup opened, or announce again after a
    // restarted worker; asking again while open shows the choice once it waits, and
    // once another tab's login no longer holds the site.
    refetchInterval: (query) => (query.state.data?.ok && !query.state.data.held ? false : 1000),
    staleTime: 0,
    gcTime: 0,
  });
  // The settings may hide the section; it waits for them so a hidden one never flashes.
  const pageSectionShown = saved !== undefined && popupPageSectionShown(saved.snapshot.settings);
  // What Pateat did on the page (ADR 0038), read again while the popup is open and shown.
  // While the settings hide the section it is not asked for, so the account switch (ADR
  // 0063), part of the section, is not offered either.
  const pageStatus = useQuery({
    // Keyed by the choice, so a status read before the section was hidden never shows when
    // it is shown again.
    queryKey: ["popup", "page-status", tabId, pageSectionShown],
    queryFn: () => choices.status(tabId!),
    enabled: pageSectionShown && tabId !== undefined && origin !== undefined,
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
  // The site's timed pause (ADR 0062) while the page section is hidden: the pause row needs
  // only the tab's site and its pause, never the page's status.
  const pauseState = useQuery({
    queryKey: ["popup", "pause-state", tabId],
    queryFn: () => choices.pauseState(tabId!),
    enabled: saved !== undefined && !pageSectionShown && tabId !== undefined && !!origin,
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
  /** Reads the pause again from where the popup shows it: the page status, or the pause alone. */
  const refreshPause = () => (pageSectionShown ? pageStatus.refetch() : pauseState.refetch());
  const timedPause = pageSectionShown
    ? pageStatus.data?.ok && pageStatus.data.origin === origin
      ? pageStatus.data.pause?.until
      : undefined
    : pauseState.data?.ok
      ? pauseState.data.until
      : undefined;
  // The personal details the page asks for and the site's links (ADR 0061), read again
  // while the popup is open, since the login may stop at the page after it opened.
  const pageDetails = useQuery({
    queryKey: ["popup", "details", tabId],
    queryFn: () => details.get(tabId!),
    enabled: tabId !== undefined && origin !== undefined,
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
  // Only the vault policies and each vault's sync, state and quarantine decide the matches,
  // so saving a default or a pause keeps the listed accounts instead of listing them again.
  const accounts = useQuery({
    queryKey: [
      "popup",
      "site-accounts",
      origin,
      saved &&
        JSON.stringify([
          saved.snapshot.settings.accountPolicies,
          saved.snapshot.settings.itemPolicies,
          saved.snapshot.settings.customFieldReviews,
        ]),
      saved?.catalog.settingsSyncPending ?? false,
      saved?.catalog.connections.map((entry) => [
        entry.snapshotId ?? null,
        entry.state ?? null,
        entry.quarantinedItemIds ?? [],
      ]),
    ],
    queryFn: async () => {
      const over = Promise.withResolvers<never>();
      const timer = setTimeout(() => over.reject(new ListingTimeout()), listingWaitMs);
      try {
        return await Promise.race([
          client.findSiteAccounts(origin!, saved!.snapshot.settings),
          over.promise,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    enabled: Boolean(origin && saved),
    staleTime: 0,
    gcTime: 0,
  });

  return {
    queryClient,
    tab,
    settings,
    origin,
    tabId,
    saved,
    inPrivate,
    choice,
    pageSectionShown,
    pageStatus,
    pauseState,
    refreshPause,
    timedPause,
    pageDetails,
    accounts,
  };
}
