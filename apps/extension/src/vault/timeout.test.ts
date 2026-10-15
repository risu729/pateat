import { describe, expect, it, vi } from "vitest";
import {
  createVaultTimeout,
  DEFAULT_VAULT_TIMEOUT,
  parseVaultTimeout,
  VAULT_TIMEOUTS,
  type VaultTimeout,
} from "./timeout";

const MINUTE = 60_000;
const START = 1_800_000_000_000;

function setup(
  options: {
    timeout?: unknown;
    activity?: unknown;
    unlocked?: boolean;
    lock?: () => Promise<void>;
  } = {},
) {
  let clock = START;
  let setting = options.timeout;
  let activity = options.activity;
  let unlocked = options.unlocked ?? false;
  const lock = vi.fn(options.lock ?? (async () => undefined));
  const schedule = vi.fn(async (_when: number | undefined) => undefined);
  const settingRead = vi.fn(async () => structuredClone(setting));
  const activityRead = vi.fn(async () => structuredClone(activity));
  const activityWrite = vi.fn(async (value: unknown) => {
    activity = structuredClone(value);
  });
  const unlockedRead = vi.fn(async () => unlocked);
  const control = createVaultTimeout({
    setting: { read: settingRead },
    activity: { getValue: activityRead, setValue: activityWrite },
    lock,
    unlocked: unlockedRead,
    schedule,
    now: () => clock,
  });
  return {
    control,
    lock,
    schedule,
    settingRead,
    activityWrite,
    unlockedRead,
    activity: () => activity,
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    setTimeout(value: unknown) {
      setting = value;
    },
    setActivity(value: unknown) {
      activity = value;
    },
    setUnlocked(value: boolean) {
      unlocked = value;
    },
  };
}

describe("stored vault timeout", () => {
  it("defaults to never and locks on restart for a damaged value", () => {
    expect(DEFAULT_VAULT_TIMEOUT).toBe("never");
    expect(parseVaultTimeout(undefined)).toBe("never");
    expect(parseVaultTimeout(null)).toBe("never");
    for (const value of VAULT_TIMEOUTS) expect(parseVaultTimeout(value)).toBe(value);
    for (const value of ["1", 0, 2, -1, 1.5, "always", "Never", {}, [], true, Number.NaN])
      expect(parseVaultTimeout(value), String(value)).toBe("restart");
  });
});

describe("vault timeout checks", () => {
  it("never locks with the default timeout, even after a restart", async () => {
    for (const timeout of [undefined, "never"]) {
      const t = setup({ timeout });
      // oxlint-disable-next-line no-await-in-loop -- independent setups
      await t.control.check();
      expect(t.lock).not.toHaveBeenCalled();
      // The session starts its record without a wake-up.
      expect(t.activity()).toEqual({ lastUsedAt: START });
      expect(t.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
      t.advance(10_000 * MINUTE);
      // oxlint-disable-next-line no-await-in-loop -- independent setups
      await t.control.check();
      expect(t.lock).not.toHaveBeenCalled();
      expect(t.schedule).toHaveBeenCalledOnce();
    }
  });

  it.each(VAULT_TIMEOUTS.filter((timeout) => timeout !== "never"))(
    "locks with timeout %s when the session has no activity record",
    async (timeout) => {
      const t = setup({ timeout });
      await t.control.check();
      expect(t.lock).toHaveBeenCalledOnce();
      expect(t.activity()).toEqual({ lastUsedAt: START, locked: true });
      expect(t.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );

  it("locks on restart for a damaged timeout or a damaged activity record", async () => {
    const damaged = setup({ timeout: "forever", activity: { lastUsedAt: START } });
    await damaged.control.check();
    expect(damaged.lock).not.toHaveBeenCalled();
    for (const activity of [
      { lastUsedAt: -1 },
      { lastUsedAt: 1.5 },
      { lastUsedAt: "1" },
      { lastUsedAt: START, extra: true },
      { lastUsedAt: START, locked: false },
      "garbage",
      null,
    ]) {
      const t = setup({ timeout: 5, activity });
      // oxlint-disable-next-line no-await-in-loop -- independent setups
      await t.control.check();
      expect(t.lock, JSON.stringify(activity)).toHaveBeenCalledOnce();
    }
  });

  it("keeps the vault for restart-only timeouts while the session lasts", async () => {
    const t = setup({ timeout: "restart", activity: { lastUsedAt: START - 10_000 * MINUTE } });
    await t.control.check();
    expect(t.lock).not.toHaveBeenCalled();
    expect(t.activityWrite).not.toHaveBeenCalled();
    expect(t.schedule).not.toHaveBeenCalled();
  });

  it.each([1, 5, 15, 30, 60, 240] as const)(
    "locks %s minutes after the last use, not a moment earlier",
    async (minutes) => {
      const t = setup({ timeout: minutes, activity: { lastUsedAt: START } });
      t.advance(minutes * MINUTE - 1);
      await t.control.check();
      expect(t.lock).not.toHaveBeenCalled();
      // A running worker keeps the alarm the last use planned.
      expect(t.schedule).not.toHaveBeenCalled();
      expect(t.activityWrite).not.toHaveBeenCalled();
      t.advance(1);
      await t.control.check();
      expect(t.lock).toHaveBeenCalledOnce();
      expect(t.activity()).toEqual({ lastUsedAt: t.now(), locked: true });
      expect(t.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );

  it("locks when the clock went back before the last use", async () => {
    const t = setup({ timeout: 240, activity: { lastUsedAt: START + 1 } });
    await t.control.check();
    expect(t.lock).toHaveBeenCalledOnce();
    expect(t.activity()).toEqual({ lastUsedAt: START, locked: true });
  });

  it("rejects without recording, and retries in a minute, when the lock fails", async () => {
    const t = setup({
      timeout: 1,
      activity: { lastUsedAt: START },
      lock: async () => {
        throw new Error("disable-failed");
      },
    });
    t.advance(MINUTE);
    await expect(t.control.check()).rejects.toThrow("disable-failed");
    expect(t.activityWrite).not.toHaveBeenCalled();
    expect(t.schedule).toHaveBeenCalledExactlyOnceWith(t.now() + MINUTE);
    expect(t.activity()).toEqual({ lastUsedAt: START });
    // A retry alarm that cannot be set does not hide the lock failure.
    t.schedule.mockRejectedValueOnce(new Error("alarms"));
    await expect(t.control.check()).rejects.toThrow("disable-failed");
    expect(t.lock).toHaveBeenCalledTimes(2);
    expect(t.activity()).toEqual({ lastUsedAt: START });
    // The next check tries again.
    t.lock.mockImplementation(async () => undefined);
    await t.control.check();
    expect(t.lock).toHaveBeenCalledTimes(3);
    expect(t.activity()).toEqual({ lastUsedAt: t.now(), locked: true });
    expect(t.schedule).toHaveBeenLastCalledWith(undefined);
  });

  it("rejects when the setting or the activity cannot be read", async () => {
    const t = setup({ timeout: 1, activity: { lastUsedAt: START } });
    t.settingRead.mockRejectedValueOnce(new Error("storage"));
    await expect(t.control.check()).rejects.toThrow("storage");
    expect(t.lock).not.toHaveBeenCalled();
    await t.control.check();
  });

  it("shares one run between concurrent checks and runs again afterwards", async () => {
    let release!: () => void;
    const t = setup({
      timeout: 1,
      activity: { lastUsedAt: START },
      lock: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    t.advance(MINUTE);
    const first = t.control.check();
    const second = t.control.check();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(t.lock).toHaveBeenCalledOnce());
    const third = t.control.check();
    expect(third).toBe(first);
    release();
    await Promise.all([first, second, third]);
    expect(t.lock).toHaveBeenCalledOnce();
    expect(t.settingRead).toHaveBeenCalledOnce();
    // A later check is a new run; the record says locked and nothing unlocked.
    await t.control.check();
    expect(t.settingRead).toHaveBeenCalledTimes(2);
    expect(t.lock).toHaveBeenCalledOnce();
  });

  it("shares a rejected run and recovers afterwards", async () => {
    const t = setup({
      timeout: 1,
      lock: async () => {
        throw new Error("disable-failed");
      },
    });
    const results = await Promise.allSettled([t.control.check(), t.control.check()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(t.lock).toHaveBeenCalledOnce();
    expect(t.schedule).toHaveBeenCalledExactlyOnceWith(START + MINUTE);
    t.lock.mockImplementation(async () => undefined);
    await t.control.check();
    expect(t.lock).toHaveBeenCalledTimes(2);
  });
});

describe("vault timeout after a lock", () => {
  it("does not lock again while nothing unlocked the vaults", async () => {
    const t = setup({ timeout: 1, activity: { lastUsedAt: START } });
    t.advance(MINUTE);
    await t.control.check();
    expect(t.lock).toHaveBeenCalledOnce();
    const locked = t.activity();
    t.schedule.mockClear();
    t.activityWrite.mockClear();
    for (const minutes of [1, 10, 1000]) {
      t.advance(minutes * MINUTE);
      // oxlint-disable-next-line no-await-in-loop -- one check per step
      await t.control.check();
    }
    expect(t.lock).toHaveBeenCalledOnce();
    expect(t.unlockedRead).toHaveBeenCalledTimes(3);
    expect(t.activityWrite).not.toHaveBeenCalled();
    expect(t.schedule).not.toHaveBeenCalled();
    expect(t.activity()).toEqual(locked);
  });

  it("restarts the clock once a sign-in unlocked a vault again", async () => {
    const t = setup({ timeout: 5, activity: { lastUsedAt: START - 10 * MINUTE, locked: true } });
    t.setUnlocked(true);
    t.advance(3 * MINUTE);
    await t.control.check();
    expect(t.lock).not.toHaveBeenCalled();
    expect(t.activity()).toEqual({ lastUsedAt: t.now() });
    expect(t.schedule).toHaveBeenCalledExactlyOnceWith(t.now() + 5 * MINUTE);
    // That use then times out like any other.
    t.advance(5 * MINUTE);
    await t.control.check();
    expect(t.lock).toHaveBeenCalledOnce();
  });

  it("does not schedule a wake-up for a restart-only timeout after a sign-in", async () => {
    const t = setup({ timeout: "restart", activity: { lastUsedAt: START, locked: true } });
    t.setUnlocked(true);
    await t.control.check();
    expect(t.lock).not.toHaveBeenCalled();
    expect(t.activity()).toEqual({ lastUsedAt: START });
    expect(t.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rejects when whether a vault unlocks cannot be read, without locking", async () => {
    const t = setup({ timeout: 1, activity: { lastUsedAt: START, locked: true } });
    t.unlockedRead.mockRejectedValueOnce(new Error("registry"));
    await expect(t.control.check()).rejects.toThrow("registry");
    expect(t.lock).not.toHaveBeenCalled();
    expect(t.activityWrite).not.toHaveBeenCalled();
  });

  it("starts again from a use, which clears the lock mark", async () => {
    const t = setup({ timeout: 15, activity: { lastUsedAt: START, locked: true } });
    t.advance(MINUTE);
    await t.control.used();
    expect(t.activity()).toEqual({ lastUsedAt: t.now() });
    t.advance(15 * MINUTE - 1);
    await t.control.check();
    expect(t.lock).not.toHaveBeenCalled();
    expect(t.unlockedRead).not.toHaveBeenCalled();
    t.advance(1);
    await t.control.check();
    expect(t.lock).toHaveBeenCalledOnce();
  });
});

describe("vault use", () => {
  it.each([
    [undefined, undefined],
    ["never", undefined],
    ["restart", undefined],
    ["garbage", undefined],
    [1, MINUTE],
    [5, 5 * MINUTE],
    [15, 15 * MINUTE],
    [30, 30 * MINUTE],
    [60, 60 * MINUTE],
    [240, 240 * MINUTE],
  ] as [unknown, number | undefined][])(
    "records the use and plans the wake-up for timeout %s",
    async (timeout, after) => {
      const t = setup({ timeout, activity: { lastUsedAt: START - MINUTE } });
      t.advance(7);
      await t.control.used();
      expect(t.activity()).toEqual({ lastUsedAt: START + 7 });
      expect(t.schedule).toHaveBeenCalledExactlyOnceWith(
        after === undefined ? undefined : START + 7 + after,
      );
      expect(t.lock).not.toHaveBeenCalled();
    },
  );

  it("keeps a vault in use unlocked past the timeout since the first use", async () => {
    const t = setup({ timeout: 5 satisfies VaultTimeout, activity: { lastUsedAt: START } });
    for (let step = 0; step < 6; step += 1) {
      t.advance(4 * MINUTE);
      // oxlint-disable-next-line no-await-in-loop -- one use per step
      await t.control.check();
      // oxlint-disable-next-line no-await-in-loop -- one use per step
      await t.control.used();
    }
    expect(t.lock).not.toHaveBeenCalled();
    expect(t.schedule).toHaveBeenLastCalledWith(t.now() + 5 * MINUTE);
  });

  it("counts a changed timeout from the change", async () => {
    const t = setup({ timeout: 240, activity: { lastUsedAt: START } });
    t.advance(30 * MINUTE);
    t.setTimeout(1);
    // The worker calls used() when the setting changes.
    await t.control.used();
    expect(t.schedule).toHaveBeenCalledExactlyOnceWith(t.now() + MINUTE);
    await t.control.check();
    expect(t.lock).not.toHaveBeenCalled();
    t.advance(MINUTE);
    await t.control.check();
    expect(t.lock).toHaveBeenCalledOnce();
  });

  it("rejects when the use cannot be recorded", async () => {
    const t = setup({ timeout: 5 });
    t.activityWrite.mockRejectedValueOnce(new Error("session"));
    await expect(t.control.used()).rejects.toThrow("session");
    expect(t.schedule).not.toHaveBeenCalled();
  });
});
