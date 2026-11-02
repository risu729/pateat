import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const watchers = new Set<(next: unknown, previous: unknown) => void>();
  return {
    value: undefined as unknown,
    watchers,
    storage: {
      defineItem: vi.fn(() => ({
        getValue: async () => h.value,
        watch: (watcher: (next: unknown, previous: unknown) => void) => {
          watchers.add(watcher);
          return () => watchers.delete(watcher);
        },
      })),
    },
  };
});
vi.mock("wxt/utils/storage", () => ({ storage: h.storage }));

const { profileSettingStore, settingChanged, snapshotSetting } = await import("./profile-setting");

const snapshot = (settings: Record<string, unknown>) => ({ version: 1, revision: 1, settings });

describe("one synced profile setting from the worker's settings snapshot (ADR 0024)", () => {
  it("reads the setting, and nothing from a missing or damaged snapshot", () => {
    expect(snapshotSetting(snapshot({ theme: "dark" }), "theme")).toBe("dark");
    expect(snapshotSetting(snapshot({}), "theme")).toBeUndefined();
    expect(snapshotSetting(undefined, "theme")).toBeUndefined();
    expect(snapshotSetting({ settings: "x" }, "theme")).toBeUndefined();
  });

  it("tells a change of the setting from a change of the rest", () => {
    const timeout = { timeout: 5, action: "lock" };
    expect(settingChanged("vaultTimeout", snapshot({ vaultTimeout: timeout }), snapshot({}))).toBe(
      true,
    );
    expect(
      settingChanged(
        "vaultTimeout",
        { ...snapshot({ vaultTimeout: { ...timeout } }), revision: 2 },
        snapshot({ vaultTimeout: timeout }),
      ),
    ).toBe(false);
    expect(settingChanged("vaultTimeout", snapshot({}), undefined)).toBe(false);
  });

  it("reads the stored snapshot and calls back only when the setting changes", async () => {
    h.value = snapshot({ language: "ja" });
    const store = profileSettingStore("language");
    expect(h.storage.defineItem).toHaveBeenCalledWith("local:pateat.local-settings.v1");
    expect(await store.get()).toBe("ja");
    const seen = vi.fn();
    const stop = store.watch(seen);
    const emit = (next: unknown, previous: unknown) => {
      for (const watcher of h.watchers) watcher(next, previous);
    };
    emit(snapshot({ language: "ja", theme: "dark" }), snapshot({ language: "ja" }));
    expect(seen).not.toHaveBeenCalled();
    emit(snapshot({}), snapshot({ language: "ja" }));
    expect(seen).toHaveBeenCalledExactlyOnceWith(undefined);
    stop();
    emit(snapshot({ language: "en" }), snapshot({}));
    expect(seen).toHaveBeenCalledOnce();
  });
});
