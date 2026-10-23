import {
  allowlistOn,
  localSettingsSchema,
  MAX_SETTINGS_DOCUMENT_BYTES,
  normalizeHostname,
  settingsDocumentBytes,
  siteRuleCovers,
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

type SiteRule = LocalSettings["excludedSites"][number];

/** The rules that exclude a hostname: its own, or a parent's that includes subdomains. */
export function exclusionsCovering(settings: LocalSettings | null, hostname: string) {
  return (settings?.excludedSites ?? []).filter((site) => siteRuleCovers(site, hostname));
}

/**
 * Whether the allowed sites leave a hostname out (ADR 0077): they are on and none covers
 * it. An exclusion still wins, so this says nothing about exclusions.
 */
export function notAllowed(settings: LocalSettings | null, hostname: string): boolean {
  return (
    settings !== null &&
    allowlistOn(settings) &&
    !(settings.allowedSites ?? []).some((site) => siteRuleCovers(site, hostname))
  );
}

/** A site rule as shown: its hostname, and whether it also covers subdomains. */
export function exclusionLabel(site: SiteRule): string {
  return site.includeSubdomains ? `${site.hostname} and subdomains` : site.hostname;
}

/** Removes one hostname's exclusion rule. */
export function removeExclusion(hostname: string, done: string): SettingsEdit {
  return {
    apply: (value) => ({
      ...value,
      excludedSites: value.excludedSites.filter((site) => site.hostname !== hostname),
    }),
    done,
  };
}

/** Sets one hostname's allowed site, replacing any it had. */
export function allowSite(
  hostname: string,
  includeSubdomains: boolean,
  done: string,
): SettingsEdit {
  return {
    apply: (value) => ({
      ...value,
      allowedSites: [
        ...(value.allowedSites ?? []).filter((site) => site.hostname !== hostname),
        { hostname, includeSubdomains },
      ],
    }),
    done,
  };
}

/** Removes one hostname's allowed site. */
export function removeAllowedSite(hostname: string, done: string): SettingsEdit {
  return {
    apply: (value) => ({
      ...value,
      allowedSites: (value.allowedSites ?? []).filter((site) => site.hostname !== hostname),
    }),
    done,
  };
}

/** Turns the allowed sites on or off; the list is kept either way. */
export function setAllowedSites(on: boolean): SettingsEdit {
  return {
    apply: (value) => ({ ...value, allowedSitesEnabled: on }),
    done: on
      ? "Pateat now runs only on allowed sites"
      : "Pateat now runs on every site not excluded",
  };
}

/**
 * The site switch for one hostname, as in the extension's popup: on unless an exclusion
 * covers the hostname or the allowed sites leave it out. It changes only the hostname's
 * own exact rules. Turning it on removes the hostname's own exclusion and, while the
 * allowed sites are on and none covers it, allows it; turning it off removes the
 * hostname's own allowed site when only that one allows it, else excludes the hostname.
 */
export function siteSwitch(settings: LocalSettings | null, hostname: string) {
  const covers = (site: SiteRule) => siteRuleCovers(site, hostname);
  const own = (site: SiteRule) => site.hostname === hostname && !site.includeSubdomains;
  // Allowed only by the hostname's own rule: turning the switch off removes that rule.
  const removesAllowed = (value: LocalSettings) => {
    const allowing = allowlistOn(value) ? (value.allowedSites ?? []).filter(covers) : [];
    return allowing.length > 0 && allowing.every(own);
  };
  const rules = exclusionsCovering(settings, hostname);
  const leftOut = notAllowed(settings, hostname);
  return {
    on: rules.length === 0 && !leftOut,
    /** A covering exclusion that also covers other sites, which the switch leaves alone. */
    broader: rules.find((rule) => !own(rule)),
    notAllowed: leftOut,
    /** Applied to the settings as the write reads them, not the page's copy. */
    edit(on: boolean): SettingsEdit {
      if (on)
        return {
          apply: (value) => {
            const next = {
              ...value,
              excludedSites: value.excludedSites.filter((site) => !own(site)),
            };
            if (notAllowed(next, hostname))
              next.allowedSites = [
                ...(value.allowedSites ?? []),
                { hostname, includeSubdomains: false },
              ];
            return next;
          },
          done: leftOut
            ? `${hostname} is now an allowed site`
            : `${hostname} is no longer excluded`,
        };
      return {
        apply: (value) =>
          removesAllowed(value)
            ? {
                ...value,
                allowedSites: (value.allowedSites ?? []).filter((site) => !own(site)),
              }
            : excludeSite(hostname, false).apply(value),
        done:
          settings && removesAllowed(settings)
            ? `${hostname} is no longer an allowed site`
            : `${hostname} excluded`,
      };
    },
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
