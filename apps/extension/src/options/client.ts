import {
  parseRuntimeStatus,
  parseSettingsResponse,
  type RuntimeStatus,
  type SettingsRequest,
  type SettingsResponse,
} from "@pateat/contracts";
import { QueryClient } from "@tanstack/react-query";

export const SETTINGS_QUERY_KEY = ["settings", "metadata"] as const;
export const RUNTIME_STATUS_QUERY_KEY = ["runtime", "status"] as const;

export interface SettingsClient {
  getSettings(): Promise<SettingsResponse>;
  saveSettings(
    request: Extract<SettingsRequest, { type: "settings.save" }>,
  ): Promise<SettingsResponse>;
  getStatus(): Promise<RuntimeStatus>;
}

/** Only metadata contracts may cross this UI boundary. Never cache vault field values. */
export function createSettingsClient(send: (message: unknown) => Promise<unknown>): SettingsClient {
  return {
    getSettings: async () =>
      parseSettingsResponse(await send({ version: 1, type: "settings.get" })),
    saveSettings: async (request) => parseSettingsResponse(await send(request)),
    getStatus: async () =>
      parseRuntimeStatus(await send({ version: 1, type: "runtime.status.get" })),
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
