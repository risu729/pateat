import {
  localSettingsSchema,
  MAX_SETTINGS_DOCUMENT_BYTES,
  normalizeHostname,
  settingsDocumentBytes,
  type LocalSettings,
} from "@pateat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as v from "valibot";
import { ManageApiError, type ManageClient } from "./api";

export const SETTINGS_QUERY_KEY = ["settings"] as const;

/** The document a first write starts from; the service never holds vault connections. */
const EMPTY_SETTINGS: LocalSettings = {
  connections: [],
  excludedSites: [],
  repromptSites: [],
  siteDefaults: [],
  bindings: [],
};

/**
 * A vault account as a device named it when saving: the connection's label, else the
 * provider account ID.
 */
export function vaultAccountLabel(
  entry: Pick<LocalSettings["siteDefaults"][number], "provider" | "userId" | "accountName">,
): string {
  return entry.accountName || `${entry.provider} account ${entry.userId}`;
}

/** A default account as "<item> in <vault account>"; the service holds no usernames. */
export function defaultAccountLabel(entry: LocalSettings["siteDefaults"][number]): string {
  return `${entry.itemName || entry.itemId} in ${vaultAccountLabel(entry)}`;
}

/**
 * The hostname exclusion rules name for an origin: canonical, without a trailing dot,
 * as the extension matches it.
 */
export function siteHostname(origin: string): string {
  const { hostname } = new URL(origin);
  return normalizeHostname(hostname) ?? hostname;
}

/** The rules that exclude a hostname: its own, or a parent's that includes subdomains. */
export function exclusionsCovering(settings: LocalSettings | null, hostname: string) {
  return (settings?.excludedSites ?? []).filter(
    (site) =>
      hostname === site.hostname ||
      (site.includeSubdomains && hostname.endsWith(`.${site.hostname}`)),
  );
}

/** An exclusion rule as shown: its hostname, and whether it also covers subdomains. */
export function exclusionLabel(site: LocalSettings["excludedSites"][number]): string {
  return site.includeSubdomains ? `${site.hostname} and subdomains` : site.hostname;
}

/** Removes one hostname's exclusion rule. */
export function allowSite(hostname: string, done: string): SettingsEdit {
  return {
    apply: (value) => ({
      ...value,
      excludedSites: value.excludedSites.filter((site) => site.hostname !== hostname),
    }),
    done,
  };
}

/** Sets one hostname's exclusion rule, replacing any it had. */
export function excludeSite(hostname: string, includeSubdomains: boolean): SettingsEdit {
  return {
    apply: (value) => ({
      ...value,
      excludedSites: [
        ...value.excludedSites.filter((site) => site.hostname !== hostname),
        { hostname, includeSubdomains },
      ],
    }),
    done: `${hostname} excluded`,
  };
}

export function useSettings(client: ManageClient) {
  const profileId = client.profileId;
  return useQuery({
    queryKey: [...SETTINGS_QUERY_KEY, profileId],
    queryFn: () => client.settings(profileId),
  });
}

export type SettingsEdit = {
  apply: (settings: LocalSettings) => LocalSettings;
  /** Announced once the write succeeds. */
  done: string;
};

/**
 * Applies one edit to the settings the page last read and writes the result with that
 * revision. A conflict refreshes the page's copy and reports the error, so the owner
 * repeats the edit against the current settings instead of overwriting them.
 */
export function useSettingsEdit(client: ManageClient) {
  const queryClient = useQueryClient();
  const profileId = client.profileId;
  const queryKey = [...SETTINGS_QUERY_KEY, profileId];
  return useMutation({
    mutationFn: async ({ apply }: SettingsEdit) => {
      // Waits for the refetch a conflict started instead of reusing the stale copy.
      const state = await queryClient.query({
        queryKey,
        queryFn: () => client.settings(profileId),
        staleTime: Number.POSITIVE_INFINITY,
      });
      const edited = apply(state.settings ?? EMPTY_SETTINGS);
      // Connections are device-local; a copy some other client stored is not kept.
      const next = v.safeParse(localSettingsSchema, { ...edited, connections: [] });
      if (!next.success) throw new ManageApiError("bad_request");
      if (settingsDocumentBytes(next.output) > MAX_SETTINGS_DOCUMENT_BYTES)
        throw new ManageApiError("payload_too_large");
      return client.saveSettings(state.revision, next.output, state.profileId);
    },
    onSuccess: (state) => queryClient.setQueryData(queryKey, state),
    onError: (error) => {
      if (error instanceof ManageApiError && error.code === "settings_conflict")
        void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
  });
}
