import * as v from "valibot";

/**
 * The vault timeout (plan phase 4): how long the vaults on this device stay unlocked, as
 * the official Bitwarden extension offers. It is a device setting and never synced.
 * Locking turns automatic unlock off, as the settings page's "Disable automatic unlock"
 * does; the person signs in again to unlock.
 */
export const VAULT_TIMEOUT_KEY = "pateat.vault-timeout.v1";
/**
 * When a vault was last used in this browser session. `storage.session` is cleared when
 * the browser restarts and when the extension is reloaded or updated, which is how a
 * restart is told apart from a stopped worker.
 */
export const VAULT_ACTIVITY_KEY = "session:pateat.vault-activity.v1";
export const VAULT_TIMEOUT_ALARM = "pateat.vault-timeout";

/** Minutes without use, or a browser restart only, or never (ADR 0006's default). */
export const VAULT_TIMEOUTS = ["never", "restart", 1, 5, 15, 30, 60, 240] as const;
export type VaultTimeout = (typeof VAULT_TIMEOUTS)[number];
export const vaultTimeoutSchema = v.picklist(VAULT_TIMEOUTS);
/** Keeps automatic unlock across browser restarts, as before the setting existed. */
export const DEFAULT_VAULT_TIMEOUT: VaultTimeout = "never";

const activitySchema = v.strictObject({
  lastUsedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Set when the timeout locked the vaults, until a vault is used or unlocked again. */
  locked: v.optional(v.literal(true)),
});
type Activity = v.InferOutput<typeof activitySchema>;

/**
 * The stored timeout. Absent means the default; a value that does not parse locks on
 * restart, so a damaged record never keeps a vault unlocked longer than asked.
 */
export function parseVaultTimeout(value: unknown): VaultTimeout {
  if (value === undefined || value === null) return DEFAULT_VAULT_TIMEOUT;
  const parsed = v.safeParse(vaultTimeoutSchema, value);
  return parsed.success ? parsed.output : "restart";
}

export function createVaultTimeout(options: {
  /** The device's stored timeout, unvalidated. */
  setting: { read(): Promise<unknown> };
  /** This browser session's activity record, unvalidated; absent after a restart. */
  activity: { getValue(): Promise<unknown>; setValue(value: unknown): Promise<void> };
  /** Locks every vault on this device; rejects when one may still be unlocked. */
  lock(): Promise<void>;
  /** Whether a vault on this device unlocks automatically, as after a sign-in. */
  unlocked(): Promise<boolean>;
  /** Wakes the worker at `when` for a check, or cancels that with `undefined`. */
  schedule(when: number | undefined): Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let running: Promise<void> | undefined;

  async function readActivity(): Promise<Activity | undefined> {
    const parsed = v.safeParse(activitySchema, await options.activity.getValue());
    return parsed.success ? parsed.output : undefined;
  }

  async function plan(timeout: VaultTimeout, usedAt: number) {
    await options.schedule(typeof timeout === "number" ? usedAt + timeout * 60_000 : undefined);
  }

  async function run() {
    const [timeout, activity] = await Promise.all([
      options.setting.read().then(parseVaultTimeout),
      readActivity(),
    ]);
    const at = now();
    if (activity?.locked) {
      // A vault that unlocks again was signed in to since the lock, even if that sign-in
      // could not yet say so: the time counts from now rather than locking it at once.
      if (await options.unlocked()) await restart(timeout);
      return;
    }
    const usedAt = activity?.lastUsedAt;
    // No record: the browser restarted, or the extension was reloaded or updated.
    const expired =
      timeout !== "never" &&
      (usedAt === undefined ||
        (typeof timeout === "number" && (usedAt > at || at - usedAt >= timeout * 60_000)));
    if (expired) {
      try {
        await options.lock();
      } catch (error) {
        // Tried again in a minute, and before any vault use meanwhile.
        await options.schedule(at + 60_000).catch(() => undefined);
        throw error;
      }
      // Locked vaults need no wake-up; signing in again counts as use and plans one.
      await options.activity.setValue({ lastUsedAt: at, locked: true });
      await options.schedule(undefined);
      return;
    }
    // A running worker keeps the alarm that the last use planned.
    if (usedAt === undefined) await restart(timeout);
  }

  /** The time without use starts again now. */
  async function restart(timeout: VaultTimeout) {
    const at = now();
    await options.activity.setValue({ lastUsedAt: at });
    await plan(timeout, at);
  }

  return {
    /**
     * Locks the vaults when the timeout has passed. Runs before each vault use, at worker
     * start and on the alarm; concurrent calls share one run. A rejection means the
     * vaults may not be locked, so the caller must not use them.
     */
    check(): Promise<void> {
      running ??= run().finally(() => {
        running = undefined;
      });
      return running;
    },
    /** A vault was used or unlocked, or the setting changed: the time starts again. */
    async used(): Promise<void> {
      await restart(parseVaultTimeout(await options.setting.read()));
    },
  };
}
export type VaultTimeoutControl = ReturnType<typeof createVaultTimeout>;
