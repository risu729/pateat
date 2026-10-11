import { describe, expect, it, vi } from "vitest";
import { activeEntry, disabledEntry } from "../vault/__fixtures__/vault";
import { vaultFailure } from "../vault/record";
import type { DurableVaultStore } from "../vault/storage";
import {
  ACTION_ICON_PATHS,
  actionIconState,
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

  it("notifies after every vault write, including one that reports failure", async () => {
    const notify = vi.fn();
    const results = [
      { ok: true as const, data: { revision: "r1" } },
      vaultFailure("storage-uncertain"),
    ];
    const base: DurableVaultStore = {
      read: vi.fn(async () => ({ ok: true as const, data: null })),
      compareAndSwap: vi.fn(async () => results.shift()!),
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
  });

  it("sets the icon only when the state changes", async () => {
    let states: ("active" | "disabled")[] = ["disabled"];
    const setIcon = vi.fn(async () => undefined);
    const icon = createActionIcon({ states: async () => states, setIcon });
    await icon.refresh();
    await icon.refresh();
    states = ["active"];
    await icon.refresh();
    expect(setIcon.mock.calls).toEqual([[ACTION_ICON_PATHS.locked], [ACTION_ICON_PATHS.unlocked]]);
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
    expect(setIcon).toHaveBeenCalledWith(ACTION_ICON_PATHS.locked);
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
    expect(setIcon.mock.calls).toEqual([[ACTION_ICON_PATHS.unlocked], [ACTION_ICON_PATHS.locked]]);

    const failing = vi.fn(async () => {
      throw new Error("tab strip closed");
    });
    const retry = createActionIcon({ states: async () => ["active"], setIcon: failing });
    await retry.refresh();
    await retry.refresh();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
