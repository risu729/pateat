import {
  localSettingsSchema,
  MAX_SETTINGS_DOCUMENT_BYTES,
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
  siteDefaults: [],
  bindings: [],
};

export function useSettings(client: ManageClient) {
  return useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: () => client.settings() });
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
  return useMutation({
    mutationFn: async ({ apply }: SettingsEdit) => {
      // Waits for the refetch a conflict started instead of reusing the stale copy.
      const state = await queryClient.query({
        queryKey: SETTINGS_QUERY_KEY,
        queryFn: () => client.settings(),
        staleTime: Number.POSITIVE_INFINITY,
      });
      const edited = apply(state.settings ?? EMPTY_SETTINGS);
      // Connections are device-local; a copy some other client stored is not kept.
      const next = v.safeParse(localSettingsSchema, { ...edited, connections: [] });
      if (!next.success) throw new ManageApiError("bad_request");
      if (settingsDocumentBytes(next.output) > MAX_SETTINGS_DOCUMENT_BYTES)
        throw new ManageApiError("payload_too_large");
      return client.saveSettings(state.revision, next.output);
    },
    onSuccess: (state) => queryClient.setQueryData(SETTINGS_QUERY_KEY, state),
    onError: (error) => {
      if (error instanceof ManageApiError && error.code === "settings_conflict")
        void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
  });
}
