import type { LocalSettings } from "@pateat/contracts";
import { storage } from "wxt/utils/storage";
import { SETTINGS_STORAGE_KEY } from "./settings";

/**
 * One synced profile setting as extension pages and the worker see it: read from the
 * settings snapshot the worker keeps, and followed as syncs and the settings page change
 * it. Only the worker writes the snapshot, so changing it goes through the settings page.
 */
export interface ProfileSettingStore {
  get(): Promise<unknown>;
  /** Calls back with each new value of the setting, unvalidated; returns the unwatch. */
  watch(changed: (value: unknown) => void): () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The setting's value in a stored snapshot, unvalidated; absent when there is none. */
export function snapshotSetting(snapshot: unknown, key: keyof LocalSettings): unknown {
  return isRecord(snapshot) && isRecord(snapshot["settings"])
    ? snapshot["settings"][key]
    : undefined;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Whether a snapshot change changed the setting. */
export function settingChanged(
  key: keyof LocalSettings,
  next: unknown,
  previous: unknown,
): boolean {
  return !same(snapshotSetting(next, key), snapshotSetting(previous, key));
}

export function profileSettingStore(key: keyof LocalSettings): ProfileSettingStore {
  const item = storage.defineItem<unknown>(`local:${SETTINGS_STORAGE_KEY}`);
  return {
    get: async () => snapshotSetting(await item.getValue(), key),
    watch: (changed) =>
      item.watch((next, previous) => {
        if (settingChanged(key, next, previous)) changed(snapshotSetting(next, key));
      }),
  };
}
