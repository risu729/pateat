import { describe, expect, it, vi } from "vitest";
import { ACTION_ICON_PATHS, actionIconState, createActionIcon } from "./action-icon";

describe("toolbar lock icon", () => {
  it("is unlocked only when every configured connection can unlock automatically", () => {
    expect(actionIconState([])).toBe("locked");
    expect(actionIconState(["active"])).toBe("unlocked");
    expect(actionIconState(["active", "active"])).toBe("unlocked");
    expect(actionIconState(["active", "disabled"])).toBe("locked");
    expect(actionIconState(["absent"])).toBe("locked");
    expect(actionIconState(["active", "unreadable"])).toBe("locked");
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
