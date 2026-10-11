import {
  parseSettingsResponse,
  parseSiteAccountsResponse,
  type LocalSettings,
  type SettingsRequest,
  type SettingsResponse,
  type SiteAccountsResponse,
} from "@pateat/contracts";
import { QueryClient } from "@tanstack/react-query";

export const SETTINGS_QUERY_KEY = ["settings", "metadata"] as const;

export interface SettingsClient {
  getSettings(): Promise<SettingsResponse>;
  saveSettings(
    request: Extract<SettingsRequest, { type: "settings.save" }>,
  ): Promise<SettingsResponse>;
  /** Items the draft allows as the default account for one origin, with their usernames. */
  findSiteAccounts(origin: string, settings: LocalSettings): Promise<SiteAccountsResponse>;
}

/**
 * Only metadata contracts may cross this UI boundary, plus the login usernames of the items
 * that match one origin in `findSiteAccounts`. Never cache or persist vault field values.
 */
export function createSettingsClient(send: (message: unknown) => Promise<unknown>): SettingsClient {
  return {
    getSettings: async () =>
      parseSettingsResponse(await send({ version: 1, type: "settings.get" })),
    saveSettings: async (request) => parseSettingsResponse(await send(request)),
    findSiteAccounts: async (origin, settings) =>
      parseSiteAccountsResponse(
        await send({ version: 1, type: "settings.site-accounts", origin, settings }),
      ),
  };
}

export function createMetadataQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        networkMode: "always",
      },
      mutations: { retry: false, networkMode: "always", gcTime: 0 },
    },
  });
}
