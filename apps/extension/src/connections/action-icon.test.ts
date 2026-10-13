import { afterEach, describe, expect, it, vi } from "vitest";
import { activeEntry, disabledEntry } from "../vault/__fixtures__/vault";
import { vaultFailure } from "../vault/record";
import type { DurableVaultStore } from "../vault/storage";
import {
  ACTION_ICON_PATHS,
  BUSY_FRAME_MS,
  BUSY_LIMIT_MS,
  actionIconState,
  busyIconPaths,
  createActionIcon,
  notifyingVaultStore,
  vaultRecordState,
} from "./action-icon";

describe("toolbar lock icon", () => {
  it("is unlocked only when every configured connection can unlock automatically", () => {
    expect(actionIconState([])).toBe("locked");
    expect(actionIconState(["active"])).toBe("unlocked");
    expect(actionIconState(["active", "active"])).toBe("unlocked");
    expect(actionIconState(["active", "disabled"])).toBe("locked");
    expect(actionIconState(["absent"])).toBe("locked");
    expect(actionIconState(["active", "unreadable"])).toBe("locked");
  });

  it("maps stored vault records to icon inputs", () => {
    expect(vaultRecordState({ ok: true, data: activeEntry() })).toBe("active");
    expect(vaultRecordState({ ok: true, data: disabledEntry() })).toBe("disabled");
    expect(vaultRecordState({ ok: true, data: null })).toBe("absent");
    expect(vaultRecordState(vaultFailure("storage-uncertain"))).toBe("unreadable");
  });

  it("notifies after every vault write or deletion, including one that reports failure", async () => {
    const notify = vi.fn();
    const results = [
      { ok: true as const, data: { revision: "r1" } },
      vaultFailure("storage-uncertain"),
    ];
    const base: DurableVaultStore = {
      read: vi.fn(async () => ({ ok: true as const, data: null })),
      compareAndSwap: vi.fn(async () => results.shift()!),
      remove: vi.fn(async () => ({ ok: true as const, data: true as const })),
      close: vi.fn(),
    };
    const store = notifyingVaultStore(base, notify);
    await store.read();
    expect(notify).not.toHaveBeenCalled();
    await expect(store.compareAndSwap(null, activeEntry())).resolves.toEqual({
      ok: true,
      data: { revision: "r1" },
    });
    await expect(store.compareAndSwap("r1", disabledEntry())).resolves.toMatchObject({
      ok: false,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    await expect(store.remove()).resolves.toEqual({ ok: true, data: true });
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("sets the icon only when the state changes", async () => {
    let states: ("active" | "disabled")[] = ["disabled"];
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({ states: async () => states, setIcon });
    await icon.refresh();
    await icon.refresh();
    states = ["active"];
    await icon.refresh();
    expect(setIcon.mock.calls).toEqual([
      [{ path: ACTION_ICON_PATHS.locked }],
      [{ path: ACTION_ICON_PATHS.unlocked }],
    ]);
  });

  it("shows locked when the vault records cannot be read", async () => {
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({
      states: async () => {
        throw new Error("storage");
      },
      setIcon,
    });
    await icon.refresh();
    expect(setIcon).toHaveBeenCalledWith({ path: ACTION_ICON_PATHS.locked });
  });

  it("applies refreshes in order and retries after a failed set", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads: (() => Promise<("active" | "disabled")[]>)[] = [
      async () => {
        await slow;
        return ["active"];
      },
      async () => ["disabled"],
    ];
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({ states: () => reads.shift()!(), setIcon });
    const first = icon.refresh();
    const second = icon.refresh();
    release();
    await Promise.all([first, second]);
    expect(setIcon.mock.calls).toEqual([
      [{ path: ACTION_ICON_PATHS.unlocked }],
      [{ path: ACTION_ICON_PATHS.locked }],
    ]);

    const failing = vi.fn(async () => {
      throw new Error("tab strip closed");
    });
    const retry = createActionIcon({ states: async () => ["active"], setIcon: failing });
    await retry.refresh();
    await retry.refresh();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("toolbar icon spin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("turns the waiting tab's icon each frame and gives it the global icon back", async () => {
    vi.useFakeTimers();
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({ states: async () => ["active"], setIcon });
    await icon.refresh();
    setIcon.mockClear();
    const stop = icon.spin(7);
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 2);
    expect(setIcon.mock.calls).toEqual([
      [{ tabId: 7, path: busyIconPaths(0) }],
      [{ tabId: 7, path: busyIconPaths(1) }],
      [{ tabId: 7, path: busyIconPaths(2) }],
    ]);
    setIcon.mockClear();
    stop();
    stop();
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 4);
    expect(setIcon.mock.calls).toEqual([[{ tabId: 7, path: ACTION_ICON_PATHS.unlocked }]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spins a tab until its last overlapping request ends, and only that tab", async () => {
    vi.useFakeTimers();
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({ states: async () => ["active"], setIcon });
    await icon.refresh();
    const first = icon.spin(1);
    const second = icon.spin(1);
    const other = icon.spin(2);
    first();
    setIcon.mockClear();
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS);
    expect(setIcon.mock.calls).toEqual([
      [{ tabId: 1, path: busyIconPaths(1) }],
      [{ tabId: 2, path: busyIconPaths(1) }],
    ]);
    setIcon.mockClear();
    other();
    second();
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS);
    expect(setIcon.mock.calls).toEqual([
      [{ tabId: 2, path: ACTION_ICON_PATHS.unlocked }],
      [{ tabId: 1, path: ACTION_ICON_PATHS.unlocked }],
    ]);
  });

  it("stops on its own when no stop arrives", async () => {
    vi.useFakeTimers();
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({ states: async () => ["disabled"], setIcon });
    await icon.refresh();
    icon.spin(3);
    await vi.advanceTimersByTimeAsync(BUSY_LIMIT_MS);
    setIcon.mockClear();
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 4);
    expect(setIcon).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("switches a tab that spun along with the global icon", async () => {
    vi.useFakeTimers();
    let states: ("active" | "disabled")[] = ["active"];
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({ states: async () => states, setIcon });
    await icon.refresh();
    icon.spin(4)();
    await flush();
    setIcon.mockClear();
    states = ["disabled"];
    await icon.refresh();
    expect(setIcon.mock.calls).toEqual([
      [{ path: ACTION_ICON_PATHS.locked }],
      [{ tabId: 4, path: ACTION_ICON_PATHS.locked }],
    ]);
  });

  it("forgets a closed tab", async () => {
    vi.useFakeTimers();
    let states: ("active" | "disabled")[] = ["active"];
    const setIcon = vi.fn(async (details: { tabId?: number }) => {
      if (details.tabId === 5) throw new Error("No tab with id: 5.");
    });
    const icon = createActionIcon({ states: async () => states, setIcon });
    await icon.refresh();
    const stop = icon.spin(5);
    await flush();
    setIcon.mockClear();
    await vi.advanceTimersByTimeAsync(BUSY_FRAME_MS * 2);
    stop();
    states = ["disabled"];
    await icon.refresh();
    expect(setIcon.mock.calls).toEqual([[{ path: ACTION_ICON_PATHS.locked }]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
