import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ManageClient } from "./api";
import {
  followThemePreference,
  parseThemePreference,
  readThemePreference,
  saveThemePreference,
  type ThemePreference,
} from "./theme";

export const PREFERENCES_QUERY_KEY = ["preferences"] as const;

/**
 * The pages' color theme; Browser setting follows the browser. The choice is the owner's,
 * kept by the service, so every browser the owner signs in with shows it; this browser's
 * `localStorage` keeps a copy only to paint the page in it before the service answers.
 */
export function ThemeSelect({
  client,
}: {
  client: Pick<ManageClient, "preferences" | "savePreferences">;
}) {
  const queryClient = useQueryClient();
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => followThemePreference(setPreference), []);
  // An identity without a paired device has no owner, so its choice stays in this browser.
  const saved = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: () => client.preferences() });
  const save = useMutation({
    mutationFn: (theme: ThemePreference) => client.savePreferences({ version: 1, theme }),
    onSuccess: (written) => queryClient.setQueryData(PREFERENCES_QUERY_KEY, written),
  });
  const synced = saved.data?.theme;
  const answeredAt = saved.dataUpdatedAt;
  const pending = save.isPending;
  const applied = useRef(0);
  // Each answer of the service replaces the copy once, but not while a choice made here
  // is still being saved; a failed save keeps the choice until the next answer.
  useEffect(() => {
    if (synced === undefined || pending || answeredAt === applied.current) return;
    applied.current = answeredAt;
    saveThemePreference(synced);
    setPreference(synced);
  }, [synced, pending, answeredAt]);
  return (
    <label className="flex items-center gap-2">
      Theme
      <select
        id="theme-preference"
        value={preference}
        onChange={(event) => {
          const next = parseThemePreference(event.target.value);
          setPreference(next);
          saveThemePreference(next);
          save.mutate(next);
        }}
        className="min-h-10 rounded-lg border border-border-strong bg-surface px-3"
      >
        <option value="system">Browser setting</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
