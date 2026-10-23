import * as v from "valibot";
import type { KeyRetention } from "./manager";

/**
 * The vault timeout (ADR 0075): when the vaults on this device lock or log out, with the
 * official Bitwarden extension's choices except "Immediately". It is a device setting the
 * settings page writes; it is never synced.
 */
export const VAULT_TIMEOUT_KEY = "pateat.vault-timeout.v1";
/**
 * When a vault was last used in this browser session. `storage.session` is cleared when
 * the browser restarts and when the extension is reloaded or updated, which is how a
 * restart is told apart from a stopped worker.
 */
export const VAULT_ACTIVITY_KEY = "session:pateat.vault-activity.v1";
export const VAULT_TIMEOUT_ALARM = "pateat.vault-timeout";
/** Chrome's idle detection interval for "On system idle", as the official extension's. */
export const IDLE_DETECTION_SECONDS = 5 * 60;

/** The preset minutes; any other whole number of minutes up to a year is a custom one. */
export const VAULT_TIMEOUT_MINUTES = [1, 5, 15, 30, 60, 240] as const;
export const MAX_CUSTOM_MINUTES = 525_600;
export const VAULT_TIMEOUT_EVENTS = ["never", "restart", "system-idle", "system-lock"] as const;
export const vaultTimeoutSchema = v.strictObject({
  /** Minutes without use, a system event, a browser restart only, or never. */
  timeout: v.union([
    v.picklist(VAULT_TIMEOUT_EVENTS),
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CUSTOM_MINUTES)),
  ]),
  /** Lock keeps the sync sign-in and unlocks offline; log out needs a sign-in again. */
  action: v.picklist(["lock", "log-out"]),
});
export type VaultTimeoutSetting = v.InferOutput<typeof vaultTimeoutSchema>;
export type VaultTimeoutAction = VaultTimeoutSetting["action"];
export type VaultTimeoutTrigger = "minutes" | "restart" | "system-idle" | "system-lock";
/** Keeps automatic unlock across browser restarts, as before the setting existed (ADR 0006). */
export const DEFAULT_VAULT_TIMEOUT: VaultTimeoutSetting = { timeout: "never", action: "lock" };
/** A damaged record never keeps a vault unlocked longer than asked. */
const DAMAGED_VAULT_TIMEOUT: VaultTimeoutSetting = { timeout: "restart", action: "lock" };

/** The stored setting. Absent means the default; a value that does not parse locks on restart. */
export function parseVaultTimeout(value: unknown): VaultTimeoutSetting {
  if (value === undefined || value === null) return DEFAULT_VAULT_TIMEOUT;
  const parsed = v.safeParse(vaultTimeoutSchema, value);
  return parsed.success ? parsed.output : DAMAGED_VAULT_TIMEOUT;
}

/** Only "Never" keeps the key on disk; every other timeout keeps it in memory. */
export function keyRetention(setting: VaultTimeoutSetting): KeyRetention {
  return setting.timeout === "never" ? "durable" : "session";
}

const connectionIdsSchema = v.pipe(v.array(v.pipe(v.string(), v.maxLength(256))), v.maxLength(64));
const activitySchema = v.strictObject({
  lastUsedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Set when the timeout acted, until a vault is used, unlocked or signed in to again. */
  timedOut: v.optional(v.literal(true)),
  /**
   * Vaults the timeout could not close. They are tried again at each check and refused
   * until they close or the person unlocks or signs in to them.
   */
  unclosed: v.optional(
    v.strictObject({
      action: v.picklist(["lock", "log-out"]),
      /** Absent when the whole action failed: every vault is owed. */
      connectionIds: v.optional(connectionIdsSchema),
      /** With every vault owed, the ones the person opened again since. */
      except: v.optional(connectionIdsSchema),
    }),
  ),
  /** A changed setting could not move every key; moved again at each check. */
  misplaced: v.optional(v.literal(true)),
});
type Activity = v.InferOutput<typeof activitySchema>;

export type VaultTimeoutReport = {
  trigger: VaultTimeoutTrigger;
  action: VaultTimeoutAction;
  outcome: "done" | "failed";
};
/** What one timeout action did: how many open vaults it closed and which it could not. */
export type VaultTimeoutResult = { closed: number; failed: string[] };

/** A failed close or key move is tried again after this long, and at every check. */
const RETRY_MS = 60_000;

export function createVaultTimeout(options: {
  /** The device's stored setting, unvalidated. */
  setting: { read(): Promise<unknown> };
  /** This browser session's activity record, unvalidated; absent after a restart. */
  activity: { getValue(): Promise<unknown>; setValue(value: unknown): Promise<void> };
  /**
   * Locks or logs out every vault on this device, or only `connectionIds`, leaving out
   * `retry.except`. Never rejects for one vault; a vault it could not close is in
   * `failed`. A retry leaves a vault being unlocked or signed in to as it is, owed still.
   */
  timeOut(
    action: VaultTimeoutAction,
    connectionIds?: string[],
    retry?: { except?: string[] },
  ): Promise<VaultTimeoutResult>;
  /** Moves each unlocked vault's key to where the setting keeps it; false when one failed. */
  keepKeys(retention: KeyRetention): Promise<boolean>;
  /** Wakes the worker at `when` for a check, or cancels that with `undefined`. */
  schedule(when: number | undefined): Promise<void>;
  report?: (event: VaultTimeoutReport) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let running: Promise<void> | undefined;
  // Every change of the activity record runs one at a time, so none undoes another.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function readSetting() {
    return parseVaultTimeout(await options.setting.read());
  }
  async function readActivity(): Promise<Activity | undefined> {
    const parsed = v.safeParse(activitySchema, await options.activity.getValue());
    return parsed.success ? parsed.output : undefined;
  }
  async function writeActivity(value: Activity) {
    await options.activity.setValue(value);
  }
  /** The next wake: the minutes' end while they run, or a retry while one is owed. */
  async function plan(setting: VaultTimeoutSetting, activity: Activity | undefined) {
    const owed = activity?.unclosed || activity?.misplaced ? now() + RETRY_MS : undefined;
    const ends =
      typeof setting.timeout === "number" && activity && !activity.timedOut
        ? activity.lastUsedAt + setting.timeout * 60_000
        : undefined;
    const when = owed === undefined ? ends : ends === undefined ? owed : Math.min(owed, ends);
    await options.schedule(when);
  }
  function withoutUnclosed(activity: Activity): Activity {
    const { unclosed: _unclosed, ...rest } = activity;
    return rest;
  }
  /** Closes the vaults; a vault opened meanwhile by a sign-in keeps the time running. */
  async function act(
    setting: VaultTimeoutSetting,
    trigger: VaultTimeoutTrigger,
    activity: Activity | undefined,
    spare?: string,
  ) {
    const at = now();
    let result: VaultTimeoutResult | undefined;
    try {
      result = await (spare
        ? options.timeOut(setting.action, undefined, { except: [spare] })
        : options.timeOut(setting.action));
    } catch {
      // Which vaults closed is unknown, so every one is tried again.
      result = undefined;
    }
    // Nothing was open: a browser start with every vault locked is not worth a log line.
    if (!result || result.closed > 0 || result.failed.length > 0)
      options.report?.({
        trigger,
        action: setting.action,
        outcome: !result || result.failed.length ? "failed" : "done",
      });
    const next: Activity = {
      ...withoutUnclosed(activity ?? { lastUsedAt: at }),
      lastUsedAt: at,
      timedOut: true,
      ...(!result || result.failed.length > 64
        ? { unclosed: { action: setting.action } }
        : result.failed.length
          ? { unclosed: { action: setting.action, connectionIds: result.failed } }
          : {}),
    };
    await writeActivity(next);
    return next;
  }
  /** Tries again what an earlier action or key move left undone. */
  async function settle(setting: VaultTimeoutSetting, activity: Activity | undefined) {
    if (!activity) return activity;
    let next = activity;
    if (next.unclosed) {
      const { action, connectionIds, except } = next.unclosed;
      let failed: string[] | undefined;
      try {
        ({ failed } = await options.timeOut(action, connectionIds, except ? { except } : {}));
      } catch {
        failed = undefined;
      }
      next =
        failed === undefined
          ? next
          : failed.length === 0
            ? withoutUnclosed(next)
            : failed.length > 64
              ? { ...next, unclosed: { action } }
              : { ...next, unclosed: { action, connectionIds: failed } };
    }
    if (next.misplaced) {
      const moved = await options.keepKeys(keyRetention(setting)).catch(() => false);
      if (moved) {
        const { misplaced: _misplaced, ...rest } = next;
        next = rest;
      }
    }
    if (next !== activity) await writeActivity(next);
    return next;
  }
  /**
   * The activity record, after a run when there is none, so a write outside a run never
   * hides a browser restart the check could not act on yet.
   */
  async function started(spare?: string): Promise<Activity | undefined> {
    const activity = await readActivity();
    if (activity) return activity;
    await run(spare);
    return readActivity();
  }
  /** `spare`: a vault the person just unlocked or signed in to, which a restart leaves open. */
  async function run(spare?: string) {
    const setting = await readSetting();
    let activity = await settle(setting, await readActivity());
    if (!activity?.timedOut) {
      const at = now();
      const usedAt = activity?.lastUsedAt;
      if (usedAt === undefined) {
        // No record: the browser restarted, or the extension was reloaded or updated. The
        // keys in memory are gone already; a log out still has to forget the sign-ins.
        if (setting.timeout === "never") {
          activity = { lastUsedAt: at };
          await writeActivity(activity);
        } else activity = await act(setting, "restart", activity, spare);
      } else if (
        typeof setting.timeout === "number" &&
        // A clock set back counts as the time having passed.
        (usedAt > at || at - usedAt >= setting.timeout * 60_000)
      )
        activity = await act(setting, "minutes", activity);
    }
    await plan(setting, activity);
  }

  return {
    /**
     * Acts once the timeout has passed, and tries again what it could not close. Runs
     * before each vault use, at worker start and on the alarm; concurrent calls share one
     * run. A rejection means the activity record could not be read or written, so the
     * caller must not use the vaults.
     */
    check(): Promise<void> {
      running ??= serial(run).finally(() => {
        running = undefined;
      });
      return running;
    },
    /**
     * A vault was used, unlocked or signed in to: the time starts again. A vault the
     * timeout could not close is open again by the person's choice once they unlocked or
     * signed in to it (`opened`).
     */
    used(opened?: string): Promise<void> {
      return serial(async () => {
        const setting = await readSetting();
        const activity = await started(opened);
        const owed = activity?.unclosed;
        const left = owed?.connectionIds?.filter((id) => id !== opened);
        // With every vault owed, the opened one is left out of the next try.
        const except =
          owed && !owed.connectionIds && opened
            ? [...new Set([...(owed.except ?? []), opened])]
            : owed?.except;
        const next: Activity = {
          lastUsedAt: now(),
          ...(owed && !owed.connectionIds
            ? except && except.length > 64
              ? { unclosed: { action: owed.action } }
              : { unclosed: { action: owed.action, ...(except ? { except } : {}) } }
            : owed && left?.length
              ? { unclosed: { ...owed, connectionIds: left } }
              : {}),
          ...(activity?.misplaced ? { misplaced: true as const } : {}),
        };
        await writeActivity(next);
        await plan(setting, next);
      });
    },
    /** Whether the timeout could not close this vault, which then stays refused. */
    async unclosed(connectionId: string): Promise<boolean> {
      const owed = (await readActivity())?.unclosed;
      if (!owed) return false;
      return owed.connectionIds
        ? owed.connectionIds.includes(connectionId)
        : !owed.except?.includes(connectionId);
    },
    /** Moves each key to where the setting keeps it, as at worker start. */
    apply(): Promise<void> {
      return serial(async () => {
        const setting = await readSetting();
        if (await options.keepKeys(keyRetention(setting)).catch(() => false)) return;
        const activity = await started();
        const next: Activity = { ...(activity ?? { lastUsedAt: now() }), misplaced: true };
        await writeActivity(next);
        await plan(setting, next);
      });
    },
    /**
     * The setting changed: each key moves to where it now belongs, and the time starts
     * again from now rather than from the last use.
     */
    changed(): Promise<void> {
      return serial(async () => {
        const setting = await readSetting();
        const moved = await options.keepKeys(keyRetention(setting)).catch(() => false);
        const activity = await started();
        const next: Activity = {
          ...(activity ?? { lastUsedAt: now() }),
          ...(activity?.timedOut ? {} : { lastUsedAt: now() }),
        };
        if (moved) delete next.misplaced;
        else next.misplaced = true;
        await writeActivity(next);
        await plan(setting, next);
      });
    },
    /** Chrome's idle state changed (`chrome.idle.onStateChanged`). */
    idle(state: string): Promise<void> {
      return serial(async () => {
        const setting = await readSetting();
        // A locked screen is idle too; "On system lock" waits for the lock alone.
        const trigger =
          state === "locked" && setting.timeout === "system-lock"
            ? "system-lock"
            : (state === "idle" || state === "locked") && setting.timeout === "system-idle"
              ? "system-idle"
              : undefined;
        if (!trigger) return;
        const activity = await act(setting, trigger, await readActivity());
        await plan(setting, activity);
      });
    },
  };
}
export type VaultTimeoutControl = ReturnType<typeof createVaultTimeout>;
