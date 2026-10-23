import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyRetention } from "./manager";
import {
  createVaultTimeout,
  DEFAULT_VAULT_TIMEOUT,
  keyRetention,
  MAX_CUSTOM_MINUTES,
  parseVaultTimeout,
  VAULT_TIMEOUT_MINUTES,
  type VaultTimeoutAction,
  type VaultTimeoutResult,
  type VaultTimeoutSetting,
} from "./timeout";

const START = 2_000_000_000_000;
const MINUTE = 60_000;
const VAULTS = ["vault-a", "vault-b"];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A device with two vaults. `timeOut` closes the open ones it is given (all without
 * `connectionIds`); a stuck vault fails to close until it is freed.
 */
function harness(
  options: { setting?: unknown; activity?: unknown; open?: string[]; now?: number } = {},
) {
  let setting = options.setting;
  let activity = options.activity;
  let at = options.now ?? START;
  const open = new Set(options.open ?? VAULTS);
  const stuck = new Set<string>();
  const events: string[] = [];
  const timeOut = vi.fn(
    async (
      action: VaultTimeoutAction,
      connectionIds?: string[],
      retry?: { except?: string[] },
    ): Promise<VaultTimeoutResult> => {
      events.push(`time-out:${action}${connectionIds ? `:${connectionIds.join(",")}` : ""}`);
      let closed = 0;
      const failed: string[] = [];
      for (const id of VAULTS) {
        if (connectionIds && !connectionIds.includes(id)) continue;
        if (retry?.except?.includes(id)) continue;
        if (stuck.has(id)) failed.push(id);
        else if (open.delete(id)) closed += 1;
      }
      return { closed, failed };
    },
  );
  const keepKeys = vi.fn(async (retention: KeyRetention) => {
    events.push(`keep:${retention}`);
    return true;
  });
  const schedule = vi.fn(async (when: number | undefined) => {
    events.push(`schedule:${when ?? "none"}`);
  });
  const setValue = vi.fn(async (value: unknown) => {
    activity = structuredClone(value);
  });
  const getValue = vi.fn(async () => structuredClone(activity));
  const report = vi.fn();
  const control = createVaultTimeout({
    setting: { read: async () => structuredClone(setting) },
    activity: { getValue, setValue },
    timeOut,
    keepKeys,
    schedule,
    report,
    now: () => at,
  });
  return {
    control,
    timeOut,
    keepKeys,
    schedule,
    getValue,
    setValue,
    report,
    events,
    open,
    stuck,
    activity: () => activity,
    setSetting(value: unknown) {
      setting = value;
    },
    setActivity(value: unknown) {
      activity = value;
    },
    advance(ms: number) {
      at += ms;
    },
    now: () => at,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vault timeout setting", () => {
  it.each([undefined, null])("treats an absent record (%s) as Never with Lock", (value) => {
    expect(parseVaultTimeout(value)).toEqual({ timeout: "never", action: "lock" });
    expect(parseVaultTimeout(value)).toEqual(DEFAULT_VAULT_TIMEOUT);
  });
  it.each<VaultTimeoutSetting>([
    ...VAULT_TIMEOUT_MINUTES.map((timeout) => ({ timeout, action: "lock" as const })),
    { timeout: 1, action: "log-out" },
    { timeout: 7, action: "lock" },
    { timeout: MAX_CUSTOM_MINUTES, action: "log-out" },
    { timeout: "never", action: "log-out" },
    { timeout: "restart", action: "lock" },
    { timeout: "system-idle", action: "lock" },
    { timeout: "system-lock", action: "log-out" },
  ])("keeps the valid setting %j", (setting) => {
    expect(parseVaultTimeout(setting)).toEqual(setting);
  });
  it.each([
    { timeout: 0, action: "lock" },
    { timeout: -5, action: "lock" },
    { timeout: 1.5, action: "lock" },
    { timeout: MAX_CUSTOM_MINUTES + 1, action: "lock" },
    { timeout: Number.NaN, action: "lock" },
    { timeout: "15", action: "lock" },
    { timeout: "immediately", action: "lock" },
    { timeout: "never", action: "delete" },
    { timeout: "never" },
    { action: "lock" },
    { timeout: "never", action: "lock", extra: true },
    "never",
    15,
    [],
    {},
  ])("locks on restart for the damaged record %j", (value) => {
    expect(parseVaultTimeout(value)).toEqual({ timeout: "restart", action: "lock" });
  });
  it("keeps the key on disk only for Never", () => {
    expect(keyRetention({ timeout: "never", action: "lock" })).toBe("durable");
    expect(keyRetention({ timeout: "never", action: "log-out" })).toBe("durable");
    for (const timeout of [...VAULT_TIMEOUT_MINUTES, 7, "restart", "system-idle", "system-lock"])
      expect(keyRetention({ timeout, action: "lock" } as VaultTimeoutSetting)).toBe("session");
  });
  it("keeps a damaged record's key in memory only", () => {
    expect(keyRetention(parseVaultTimeout({ timeout: 0, action: "lock" }))).toBe("session");
    expect(keyRetention(parseVaultTimeout(undefined))).toBe("durable");
  });
});

describe("vault timeout check", () => {
  it("with Never, starts the time in a new browser session and acts on nothing", async () => {
    const h = harness();
    await h.control.check();
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(h.report).not.toHaveBeenCalled();
  });
  it("with Never, leaves a recorded use as it is however old", async () => {
    const h = harness({
      setting: { timeout: "never", action: "log-out" },
      activity: { lastUsedAt: START - 365 * 24 * 60 * MINUTE },
    });
    await h.control.check();
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.setValue).not.toHaveBeenCalled();
    // Every run ends by planning the alarm: nothing to wake for.
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it.each<VaultTimeoutSetting["timeout"]>([15, 7, "restart", "system-idle", "system-lock"])(
    "with %j, treats a missing session record as a browser restart",
    async (timeout) => {
      const h = harness({ setting: { timeout, action: "lock" } });
      await h.control.check();
      expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("lock");
      expect(h.report).toHaveBeenCalledExactlyOnceWith({
        trigger: "restart",
        action: "lock",
        outcome: "done",
      });
      expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true });
      expect(h.events).toEqual(["time-out:lock", "schedule:none"]);
      expect(h.open.size).toBe(0);
    },
  );
  it("logs out on restart when the action is Log out", async () => {
    const h = harness({ setting: { timeout: "restart", action: "log-out" } });
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out");
    expect(h.report).toHaveBeenCalledWith({
      trigger: "restart",
      action: "log-out",
      outcome: "done",
    });
  });
  it("reports nothing when the action found no open vault", async () => {
    // A browser start with every vault already locked is not worth a log line.
    const h = harness({ setting: { timeout: "restart", action: "lock" }, open: [] });
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledOnce();
    expect(h.report).not.toHaveBeenCalled();
    expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true });
  });
  it.each([
    "not a record",
    { lastUsedAt: -1 },
    { lastUsedAt: 1.5 },
    { lastUsedAt: "1" },
    { lastUsedAt: START, timedOut: false },
    { lastUsedAt: START, extra: 1 },
    { lastUsedAt: START, misplaced: false },
    { lastUsedAt: START, unclosed: { action: "delete", connectionIds: [] } },
    { lastUsedAt: START, unclosed: { action: "lock", connectionIds: Array(65).fill("x") } },
  ])("treats the damaged session record %j as none", async (activity) => {
    const restart = harness({ setting: { timeout: 15, action: "lock" }, activity });
    await restart.control.check();
    expect(restart.timeOut).toHaveBeenCalledExactlyOnceWith("lock");
    expect(restart.report.mock.calls[0]?.[0]).toMatchObject({ trigger: "restart" });
    const never = harness({ activity });
    await never.control.check();
    expect(never.timeOut).not.toHaveBeenCalled();
    expect(never.activity()).toEqual({ lastUsedAt: START });
  });
  it("acts on minutes only once they have passed", async () => {
    const h = harness({
      setting: { timeout: 15, action: "lock" },
      activity: { lastUsedAt: START },
    });
    h.advance(15 * MINUTE - 1);
    await h.control.check();
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.setValue).not.toHaveBeenCalled();
    // The alarm wakes the worker when the minutes end.
    expect(h.schedule).toHaveBeenLastCalledWith(START + 15 * MINUTE);
    h.advance(1);
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("lock");
    expect(h.report).toHaveBeenCalledExactlyOnceWith({
      trigger: "minutes",
      action: "lock",
      outcome: "done",
    });
    expect(h.activity()).toEqual({ lastUsedAt: START + 15 * MINUTE, timedOut: true });
    expect(h.schedule).toHaveBeenLastCalledWith(undefined);
  });
  it("acts on custom minutes", async () => {
    const h = harness({
      setting: { timeout: 7, action: "log-out" },
      activity: { lastUsedAt: START },
    });
    h.advance(7 * MINUTE);
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out");
  });
  it("counts a clock set back as the time having passed", async () => {
    const h = harness({
      setting: { timeout: 240, action: "lock" },
      activity: { lastUsedAt: START + 1 },
    });
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledOnce();
    expect(h.report.mock.calls[0]?.[0]).toMatchObject({ trigger: "minutes" });
  });
  it.each(["restart", "system-idle", "system-lock"] as const)(
    "with %s, a recorded use never times out by minutes",
    async (timeout) => {
      const h = harness({
        setting: { timeout, action: "lock" },
        activity: { lastUsedAt: START - 365 * 24 * 60 * MINUTE },
      });
      await h.control.check();
      // A clock set back does not count either: only minutes compare the time.
      h.setActivity({ lastUsedAt: START + MINUTE });
      await h.control.check();
      expect(h.timeOut).not.toHaveBeenCalled();
      expect(h.setValue).not.toHaveBeenCalled();
      expect(h.schedule.mock.calls).toEqual([[undefined], [undefined]]);
    },
  );
  it.each<VaultTimeoutSetting["timeout"]>(["never", 1, "restart"])(
    "acts no more once timed out, with %j, until the vault is used",
    async (timeout) => {
      const h = harness({
        setting: { timeout, action: "lock" },
        activity: { lastUsedAt: START - 60 * MINUTE, timedOut: true },
      });
      await h.control.check();
      expect(h.timeOut).not.toHaveBeenCalled();
      expect(h.setValue).not.toHaveBeenCalled();
      expect(h.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );
  it("acts again after a use once the time passes again", async () => {
    const h = harness({ setting: { timeout: 1, action: "lock" }, activity: { lastUsedAt: START } });
    h.advance(MINUTE);
    await h.control.check();
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledOnce();
    h.advance(1000);
    await h.control.used();
    expect(h.activity()).toEqual({ lastUsedAt: START + MINUTE + 1000 });
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledOnce();
    h.advance(MINUTE);
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledTimes(2);
  });
  it("concurrent checks share one run, and a later check runs again", async () => {
    const h = harness({ setting: { timeout: 15, action: "lock" } });
    const held = gate();
    const close = h.timeOut.getMockImplementation()!;
    h.timeOut.mockImplementationOnce(async (action, ids) => {
      await held.promise;
      return close(action, ids);
    });
    const first = h.control.check();
    const second = h.control.check();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(h.timeOut).toHaveBeenCalledOnce());
    held.release();
    await Promise.all([first, second]);
    expect(h.timeOut).toHaveBeenCalledOnce();
    const third = h.control.check();
    expect(third).not.toBe(first);
    await third;
    // Already timed out: the new run reads the record and acts on nothing.
    expect(h.timeOut).toHaveBeenCalledOnce();
  });
  it("rejects when the setting cannot be read, so no vault is used", async () => {
    const timeOut = vi.fn(async () => ({ closed: 0, failed: [] }));
    const control = createVaultTimeout({
      setting: { read: async () => Promise.reject(new Error("storage-failed")) },
      activity: { getValue: async () => undefined, setValue: async () => undefined },
      timeOut,
      keepKeys: async () => true,
      schedule: async () => undefined,
    });
    await expect(control.check()).rejects.toThrow("storage-failed");
    expect(timeOut).not.toHaveBeenCalled();
  });
  it("rejects when the activity record cannot be written, and a later check runs again", async () => {
    const h = harness({ setting: { timeout: 5, action: "lock" } });
    h.setValue.mockRejectedValueOnce(new Error("storage-failed"));
    await expect(h.control.check()).rejects.toThrow("storage-failed");
    await h.control.check();
    expect(h.activity()).toMatchObject({ timedOut: true });
  });
  it("works without a report and with the system clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + 42);
    let activity: unknown;
    const timeOut = vi.fn(async () => ({ closed: 1, failed: [] }));
    const control = createVaultTimeout({
      setting: { read: async () => ({ timeout: "restart", action: "lock" }) },
      activity: {
        getValue: async () => activity,
        setValue: async (value) => {
          activity = value;
        },
      },
      timeOut,
      keepKeys: async () => true,
      schedule: async () => undefined,
    });
    await control.check();
    expect(timeOut).toHaveBeenCalledOnce();
    expect(activity).toEqual({ lastUsedAt: START + 42, timedOut: true });
  });
});

describe("vault timeout retries", () => {
  it("a vault that does not close is reported, kept refused and tried again at each check", async () => {
    const h = harness({ setting: { timeout: 5, action: "lock" }, activity: { lastUsedAt: START } });
    h.stuck.add("vault-b");
    h.advance(5 * MINUTE);
    await h.control.check();
    expect(h.report).toHaveBeenCalledExactlyOnceWith({
      trigger: "minutes",
      action: "lock",
      outcome: "failed",
    });
    expect(h.activity()).toEqual({
      lastUsedAt: h.now(),
      timedOut: true,
      unclosed: { action: "lock", connectionIds: ["vault-b"] },
    });
    expect(await h.control.unclosed("vault-b")).toBe(true);
    expect(await h.control.unclosed("vault-a")).toBe(false);
    // The worker wakes again in a minute.
    expect(h.schedule).toHaveBeenLastCalledWith(h.now() + MINUTE);
    // Still stuck: the next check tries that vault only, and keeps owing it.
    h.advance(MINUTE);
    await h.control.check();
    expect(h.timeOut).toHaveBeenLastCalledWith("lock", ["vault-b"], {});
    expect(h.schedule).toHaveBeenLastCalledWith(h.now() + MINUTE);
    expect(h.report).toHaveBeenCalledOnce();
    h.stuck.delete("vault-b");
    h.advance(MINUTE);
    await h.control.check();
    expect(h.timeOut).toHaveBeenLastCalledWith("lock", ["vault-b"], {});
    expect(h.open.size).toBe(0);
    expect(h.activity()).toEqual({ lastUsedAt: START + 5 * MINUTE, timedOut: true });
    expect(await h.control.unclosed("vault-b")).toBe(false);
    expect(h.schedule).toHaveBeenLastCalledWith(undefined);
  });
  it("a retry keeps only the vaults still not closed", async () => {
    const h = harness({
      setting: { timeout: "restart", action: "log-out" },
      activity: {
        lastUsedAt: START,
        timedOut: true,
        unclosed: { action: "log-out", connectionIds: ["vault-a", "vault-b"] },
      },
    });
    h.stuck.add("vault-a");
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out", ["vault-a", "vault-b"], {});
    expect(h.activity()).toMatchObject({
      unclosed: { action: "log-out", connectionIds: ["vault-a"] },
    });
  });
  it("a retry that rejects keeps owing the same vaults", async () => {
    const owed = { action: "lock", connectionIds: ["vault-a"] };
    const h = harness({
      setting: { timeout: 15, action: "lock" },
      activity: { lastUsedAt: START, timedOut: true, unclosed: owed },
    });
    h.timeOut.mockRejectedValueOnce(new Error("Synthetic worker failure"));
    await h.control.check();
    expect(h.activity()).toMatchObject({ unclosed: owed });
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
  });
  // A time-out that throws as a whole has no vault list; it must not count as closed.
  it("a time-out that rejects as a whole is tried again on every vault", async () => {
    const h = harness({ setting: { timeout: 5, action: "lock" }, activity: { lastUsedAt: START } });
    h.timeOut.mockRejectedValueOnce(new Error("Synthetic registry failure"));
    h.advance(5 * MINUTE);
    await h.control.check();
    expect(h.report).toHaveBeenCalledWith({
      trigger: "minutes",
      action: "lock",
      outcome: "failed",
    });
    expect(h.open.size).toBe(2);
    expect(h.schedule).toHaveBeenLastCalledWith(h.now() + MINUTE);
    h.advance(MINUTE);
    await h.control.check();
    expect(h.open.size).toBe(0);
  });
  // The retry alarm runs `check`, as before any vault use; the vaults may still be open.
  it.each([
    ["system-lock", "locked"],
    ["system-idle", "idle"],
  ] as const)(
    "a failed %s action is tried again by the check its retry alarm runs",
    async (timeout, state) => {
      const h = harness({
        setting: { timeout, action: "lock" },
        activity: { lastUsedAt: START - MINUTE },
      });
      h.stuck.add("vault-a");
      await h.control.idle(state);
      expect(h.report).toHaveBeenCalledExactlyOnceWith({
        trigger: timeout,
        action: "lock",
        outcome: "failed",
      });
      expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
      h.stuck.delete("vault-a");
      h.advance(MINUTE);
      await h.control.check();
      expect(h.timeOut).toHaveBeenCalledTimes(2);
      expect(h.timeOut).toHaveBeenLastCalledWith("lock", ["vault-a"], {});
      expect(h.open.size).toBe(0);
      expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true });
    },
  );
  it("a retry wakes the worker before the minutes end, and the minutes before a retry", async () => {
    const h = harness({
      setting: { timeout: 5, action: "lock" },
      activity: {
        lastUsedAt: START,
        unclosed: { action: "lock", connectionIds: ["vault-a"] },
      },
    });
    h.stuck.add("vault-a");
    await h.control.check();
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
    const soon = harness({
      setting: { timeout: 1, action: "lock" },
      activity: { lastUsedAt: START - 30_000, misplaced: true },
    });
    soon.keepKeys.mockResolvedValue(false);
    await soon.control.check();
    expect(soon.schedule).toHaveBeenLastCalledWith(START + 30_000);
  });
  it("using a vault keeps owing the others and stops refusing the one opened again", async () => {
    const h = harness({
      setting: { timeout: 30, action: "lock" },
      activity: {
        lastUsedAt: START - MINUTE,
        timedOut: true,
        unclosed: { action: "lock", connectionIds: ["vault-a", "vault-b"] },
      },
    });
    await h.control.used("vault-a");
    expect(h.activity()).toEqual({
      lastUsedAt: START,
      unclosed: { action: "lock", connectionIds: ["vault-b"] },
    });
    expect(await h.control.unclosed("vault-a")).toBe(false);
    expect(await h.control.unclosed("vault-b")).toBe(true);
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
    await h.control.used("vault-b");
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(h.schedule).toHaveBeenLastCalledWith(START + 30 * MINUTE);
  });
  it("a use without a vault named keeps every vault owed", async () => {
    const unclosed = { action: "log-out", connectionIds: ["vault-a"] };
    const h = harness({
      setting: { timeout: "restart", action: "log-out" },
      activity: { lastUsedAt: START - MINUTE, timedOut: true, unclosed },
    });
    await h.control.used();
    expect(h.activity()).toEqual({ lastUsedAt: START, unclosed });
  });
  it("with every vault owed, a vault opened again is left out of the retries", async () => {
    const h = harness({
      setting: { timeout: "restart", action: "lock" },
      activity: { lastUsedAt: START - MINUTE, timedOut: true, unclosed: { action: "lock" } },
    });
    // Every vault is refused while the whole action is owed.
    expect(await h.control.unclosed("vault-a")).toBe(true);
    expect(await h.control.unclosed("vault-b")).toBe(true);
    await h.control.used("vault-a");
    await h.control.used("vault-a");
    expect(h.activity()).toEqual({
      lastUsedAt: START,
      unclosed: { action: "lock", except: ["vault-a"] },
    });
    expect(await h.control.unclosed("vault-a")).toBe(false);
    expect(await h.control.unclosed("vault-b")).toBe(true);
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
    // A use without a vault named keeps the list as it is.
    await h.control.used();
    expect(h.activity()).toMatchObject({ unclosed: { action: "lock", except: ["vault-a"] } });
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("lock", undefined, { except: ["vault-a"] });
    // The vault the person opened stays open; the other closes.
    expect([...h.open]).toEqual(["vault-a"]);
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(await h.control.unclosed("vault-b")).toBe(false);
  });
  it("with every vault owed, a retry that still fails names the vaults left", async () => {
    const h = harness({
      setting: { timeout: "restart", action: "lock" },
      activity: {
        lastUsedAt: START,
        timedOut: true,
        unclosed: { action: "lock", except: ["vault-a"] },
      },
    });
    h.stuck.add("vault-b");
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("lock", undefined, { except: ["vault-a"] });
    expect(h.activity()).toMatchObject({
      unclosed: { action: "lock", connectionIds: ["vault-b"] },
    });
    expect(await h.control.unclosed("vault-a")).toBe(false);
    expect(await h.control.unclosed("vault-b")).toBe(true);
  });
  it("with every vault owed, a retry without exceptions passes an empty retry", async () => {
    const h = harness({
      setting: { timeout: "restart", action: "log-out" },
      activity: { lastUsedAt: START, timedOut: true, unclosed: { action: "log-out" } },
    });
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out", undefined, {});
    expect(h.open.size).toBe(0);
    expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true });
  });
  it("too many vaults opened again owe every vault again, keeping the record bounded", async () => {
    const except = Array.from({ length: 64 }, (_, index) => `vault-${index}`);
    const h = harness({
      setting: { timeout: "restart", action: "lock" },
      activity: { lastUsedAt: START, timedOut: true, unclosed: { action: "lock", except } },
    });
    await h.control.used("vault-a");
    // The record stays bounded; the whole action is owed again.
    expect(h.activity()).toEqual({ lastUsedAt: START, unclosed: { action: "lock" } });
  });
  it("a use names nothing to except when only some vaults are owed", async () => {
    const h = harness({
      setting: { timeout: "restart", action: "lock" },
      activity: {
        lastUsedAt: START - MINUTE,
        timedOut: true,
        unclosed: { action: "lock", connectionIds: ["vault-b"] },
      },
    });
    await h.control.used("vault-a");
    expect(h.activity()).toEqual({
      lastUsedAt: START,
      unclosed: { action: "lock", connectionIds: ["vault-b"] },
    });
  });
  it("unclosed answers false without a record", async () => {
    const h = harness();
    expect(await h.control.unclosed("vault-a")).toBe(false);
    h.setActivity("damaged");
    expect(await h.control.unclosed("vault-a")).toBe(false);
  });
});

describe("vault timeout use", () => {
  it("starts the minutes again from now and wakes the worker when they pass", async () => {
    const h = harness({
      setting: { timeout: 30, action: "lock" },
      activity: { lastUsedAt: START - MINUTE, timedOut: true },
    });
    await h.control.used();
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith(START + 30 * MINUTE);
  });
  it.each(["never", "restart", "system-idle", "system-lock"] as const)(
    "with %s, records the use and cancels any alarm",
    async (timeout) => {
      const h = harness({
        setting: { timeout, action: "lock" },
        activity: { lastUsedAt: START - MINUTE },
      });
      await h.control.used();
      expect(h.activity()).toEqual({ lastUsedAt: START });
      expect(h.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(h.timeOut).not.toHaveBeenCalled();
    },
  );
  it("schedules a custom number of minutes", async () => {
    const h = harness({
      setting: { timeout: 90, action: "log-out" },
      activity: { lastUsedAt: START - MINUTE },
    });
    await h.control.used();
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith(START + 90 * MINUTE);
  });
  it("with Never and no record, records the use without an action", async () => {
    const h = harness({ setting: { timeout: "never", action: "log-out" } });
    await h.control.used("vault-a");
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(h.schedule).toHaveBeenLastCalledWith(undefined);
  });
  it.each<VaultTimeoutSetting["timeout"]>(["restart", "system-idle", "system-lock", 90])(
    "with %j and no record, acts on the browser restart before recording the use",
    async (timeout) => {
      const h = harness({ setting: { timeout, action: "lock" } });
      await h.control.used();
      expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("lock");
      expect(h.open.size).toBe(0);
      expect(h.report).toHaveBeenCalledExactlyOnceWith({
        trigger: "restart",
        action: "lock",
        outcome: "done",
      });
      expect(h.activity()).toEqual({ lastUsedAt: START });
      expect(h.schedule).toHaveBeenLastCalledWith(
        typeof timeout === "number" ? START + timeout * MINUTE : undefined,
      );
    },
  );
  // A sign-in right after a browser start must not hide the restart from the next check.
  it("a sign-in first in a browser session still logs out the other vaults on restart", async () => {
    const h = harness({ setting: { timeout: "restart", action: "log-out" } });
    await h.control.used("vault-a");
    // The restart acts first; the vault the person just signed in to is spared.
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out", undefined, {
      except: ["vault-a"],
    });
    expect(h.events.indexOf("time-out:log-out")).toBe(0);
    expect([...h.open]).toEqual(["vault-a"]);
    expect(h.report).toHaveBeenCalledExactlyOnceWith({
      trigger: "restart",
      action: "log-out",
      outcome: "done",
    });
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(await h.control.unclosed("vault-a")).toBe(false);
    // The record now exists: a later check acts no more.
    await h.control.check();
    expect(h.timeOut).toHaveBeenCalledOnce();
  });
  it("a use without a vault named, first in a browser session, acts on every vault", async () => {
    const h = harness({ setting: { timeout: "restart", action: "log-out" } });
    await h.control.used();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out");
    expect(h.open.size).toBe(0);
    expect(h.activity()).toEqual({ lastUsedAt: START });
  });
  it("a restart that fails while sparing the vault signed in to owes every other vault", async () => {
    const h = harness({ setting: { timeout: "restart", action: "lock" } });
    h.timeOut.mockRejectedValueOnce(new Error("Synthetic registry failure"));
    await h.control.used("vault-a");
    expect(h.activity()).toEqual({
      lastUsedAt: START,
      unclosed: { action: "lock", except: ["vault-a"] },
    });
    expect(await h.control.unclosed("vault-a")).toBe(false);
    expect(await h.control.unclosed("vault-b")).toBe(true);
    await h.control.check();
    expect([...h.open]).toEqual(["vault-a"]);
    expect(await h.control.unclosed("vault-b")).toBe(false);
  });
  it("with Never, a sign-in first in a browser session closes nothing", async () => {
    const h = harness({ setting: { timeout: "never", action: "log-out" } });
    await h.control.used("vault-a");
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.open.size).toBe(2);
  });
  it("keeps a key move still owed", async () => {
    const h = harness({
      setting: { timeout: 30, action: "lock" },
      activity: { lastUsedAt: START - MINUTE, misplaced: true },
    });
    await h.control.used();
    expect(h.activity()).toEqual({ lastUsedAt: START, misplaced: true });
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith(START + MINUTE);
  });
  it("schedules nothing when recording the use fails", async () => {
    const h = harness({ setting: { timeout: 5, action: "lock" }, activity: { lastUsedAt: START } });
    h.setValue.mockRejectedValueOnce(new Error("storage-failed"));
    await expect(h.control.used()).rejects.toThrow("storage-failed");
    expect(h.schedule).not.toHaveBeenCalled();
  });
  it("a use while a time-out runs waits for it, so the time-out cannot undo the use", async () => {
    const h = harness({ setting: { timeout: 5, action: "lock" }, activity: { lastUsedAt: START } });
    h.advance(5 * MINUTE);
    const held = gate();
    const close = h.timeOut.getMockImplementation()!;
    h.timeOut.mockImplementationOnce(async (action, ids) => {
      await held.promise;
      return close(action, ids);
    });
    const checking = h.control.check();
    await vi.waitFor(() => expect(h.timeOut).toHaveBeenCalledOnce());
    h.advance(1000);
    const using = h.control.used("vault-a");
    held.release();
    await Promise.all([checking, using]);
    // The sign-in that ran while the vaults closed keeps the time running.
    expect(h.activity()).toEqual({ lastUsedAt: START + 5 * MINUTE + 1000 });
    expect(h.schedule).toHaveBeenLastCalledWith(START + 10 * MINUTE + 1000);
  });
});

describe("vault timeout key retention", () => {
  it.each([
    [undefined, "durable"],
    [{ timeout: "never", action: "lock" }, "durable"],
    [{ timeout: 5, action: "lock" }, "session"],
    [{ timeout: "system-lock", action: "log-out" }, "session"],
    [{ timeout: "unknown", action: "lock" }, "session"],
  ] as const)("apply with %j keeps the keys %s", async (setting, retention) => {
    const h = harness({ setting });
    await h.control.apply();
    expect(h.keepKeys).toHaveBeenCalledExactlyOnceWith(retention);
    expect(h.setValue).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });
  it.each([
    ["answers false", () => Promise.resolve(false)],
    ["rejects", () => Promise.reject(new Error("storage-failed"))],
  ] as const)("apply whose key move %s owes it and retries at each check", async (_, fail) => {
    const h = harness({
      setting: { timeout: 15, action: "lock" },
      activity: { lastUsedAt: START },
    });
    h.keepKeys.mockImplementationOnce(fail);
    await h.control.apply();
    expect(h.activity()).toEqual({ lastUsedAt: START, misplaced: true });
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
    h.keepKeys.mockImplementationOnce(fail);
    await h.control.check();
    expect(h.keepKeys).toHaveBeenCalledTimes(2);
    expect(h.activity()).toEqual({ lastUsedAt: START, misplaced: true });
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
    await h.control.check();
    expect(h.keepKeys).toHaveBeenLastCalledWith("session");
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(h.schedule).toHaveBeenLastCalledWith(START + 15 * MINUTE);
  });
  it("apply without a record that cannot move the keys starts one", async () => {
    const h = harness({ setting: { timeout: "never", action: "lock" } });
    h.keepKeys.mockResolvedValueOnce(false);
    await h.control.apply();
    expect(h.activity()).toEqual({ lastUsedAt: START, misplaced: true });
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
  });
  it("a changed setting moves the keys and starts the time again from now", async () => {
    const h = harness({
      setting: { timeout: "never", action: "lock" },
      activity: { lastUsedAt: START - 60 * MINUTE },
    });
    h.setSetting({ timeout: 15, action: "lock" });
    await h.control.changed();
    expect(h.events).toEqual(["keep:session", `schedule:${START + 15 * MINUTE}`]);
    expect(h.activity()).toEqual({ lastUsedAt: START });
    // The hour since the last use does not count against the new 15 minutes.
    await h.control.check();
    expect(h.timeOut).not.toHaveBeenCalled();
  });
  it("a change back to Never keeps the keys on disk and cancels the alarm", async () => {
    const h = harness({
      setting: { timeout: "never", action: "log-out" },
      activity: { lastUsedAt: START - MINUTE },
    });
    await h.control.changed();
    expect(h.events).toEqual(["keep:durable", "schedule:none"]);
    expect(h.activity()).toEqual({ lastUsedAt: START });
  });
  it("a change after a time-out moves the keys but leaves the vaults timed out", async () => {
    const h = harness({
      setting: { timeout: 5, action: "lock" },
      activity: { lastUsedAt: START - MINUTE, timedOut: true },
    });
    await h.control.changed();
    expect(h.keepKeys).toHaveBeenCalledExactlyOnceWith("session");
    expect(h.activity()).toEqual({ lastUsedAt: START - MINUTE, timedOut: true });
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("a change whose keys cannot move owes the move, and one that can clears it", async () => {
    const h = harness({
      setting: { timeout: 5, action: "lock" },
      activity: { lastUsedAt: START - MINUTE },
    });
    h.keepKeys.mockRejectedValueOnce(new Error("storage-failed"));
    await h.control.changed();
    expect(h.activity()).toEqual({ lastUsedAt: START, misplaced: true });
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
    h.advance(1000);
    await h.control.changed();
    expect(h.activity()).toEqual({ lastUsedAt: START + 1000 });
    expect(h.schedule).toHaveBeenLastCalledWith(START + 1000 + 5 * MINUTE);
  });
  it("a change without a record acts on the browser restart first", async () => {
    const h = harness({ setting: { timeout: 30, action: "lock" } });
    await h.control.changed();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("lock");
    expect(h.keepKeys).toHaveBeenCalledExactlyOnceWith("session");
    // Timed out: the time does not start again until a vault is used.
    expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true });
    expect(h.schedule).toHaveBeenLastCalledWith(undefined);
  });
  it("a change to Never without a record starts one", async () => {
    const h = harness({ setting: { timeout: "never", action: "lock" } });
    await h.control.changed();
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.activity()).toEqual({ lastUsedAt: START });
    expect(h.schedule).toHaveBeenLastCalledWith(undefined);
  });
  it("apply without a record acts on the browser restart before owing the key move", async () => {
    const h = harness({ setting: { timeout: "restart", action: "log-out" } });
    h.keepKeys.mockResolvedValueOnce(false);
    await h.control.apply();
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out");
    expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true, misplaced: true });
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
  });
});

describe("vault timeout system idle and lock", () => {
  it("On system lock acts on a locked screen only", async () => {
    const h = harness({ setting: { timeout: "system-lock", action: "lock" } });
    await h.control.idle("idle");
    await h.control.idle("active");
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
    await h.control.idle("locked");
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("lock");
    expect(h.report).toHaveBeenCalledExactlyOnceWith({
      trigger: "system-lock",
      action: "lock",
      outcome: "done",
    });
    expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true });
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it.each(["idle", "locked"])("On system idle acts when the system is %s", async (state) => {
    const h = harness({ setting: { timeout: "system-idle", action: "log-out" } });
    await h.control.idle(state);
    expect(h.timeOut).toHaveBeenCalledExactlyOnceWith("log-out");
    expect(h.report).toHaveBeenCalledExactlyOnceWith({
      trigger: "system-idle",
      action: "log-out",
      outcome: "done",
    });
  });
  it("a second idle with every vault closed reports nothing", async () => {
    const h = harness({ setting: { timeout: "system-idle", action: "lock" } });
    await h.control.idle("idle");
    await h.control.idle("locked");
    expect(h.timeOut).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledOnce();
  });
  it("an idle action keeps a key move still owed", async () => {
    const h = harness({
      setting: { timeout: "system-lock", action: "lock" },
      activity: { lastUsedAt: START - MINUTE, misplaced: true },
    });
    await h.control.idle("locked");
    expect(h.activity()).toEqual({ lastUsedAt: START, timedOut: true, misplaced: true });
    expect(h.schedule).toHaveBeenLastCalledWith(START + MINUTE);
  });
  it("On system idle acts on nothing when the system becomes active", async () => {
    const h = harness({ setting: { timeout: "system-idle", action: "lock" } });
    await h.control.idle("active");
    await h.control.idle("unknown");
    expect(h.timeOut).not.toHaveBeenCalled();
  });
  it.each<unknown>([
    undefined,
    { timeout: "never", action: "lock" },
    { timeout: 1, action: "lock" },
    { timeout: "restart", action: "log-out" },
  ])("%j acts on no idle state", async (setting) => {
    const h = harness({ setting });
    // oxlint-disable-next-line no-await-in-loop -- one event at a time, as Chrome sends them
    for (const state of ["idle", "locked", "active"]) await h.control.idle(state);
    expect(h.timeOut).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });
  it("an idle event during a check waits for it", async () => {
    const h = harness({ setting: { timeout: "system-lock", action: "lock" } });
    const held = gate();
    const close = h.timeOut.getMockImplementation()!;
    h.timeOut.mockImplementationOnce(async (action, ids) => {
      await held.promise;
      return close(action, ids);
    });
    const checking = h.control.check();
    await vi.waitFor(() => expect(h.timeOut).toHaveBeenCalledOnce());
    const locking = h.control.idle("locked");
    await Promise.resolve();
    expect(h.timeOut).toHaveBeenCalledOnce();
    held.release();
    await Promise.all([checking, locking]);
    expect(h.timeOut).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledOnce();
  });
});
