// The toolbar icon shows whether Pateat can log in without asking for a password, and spins
// in a tab while a model request for that tab's page is in flight.
import type { VaultEntry, VaultResult } from "../vault/record";
import type { DurableVaultStore } from "../vault/storage";

export type VaultRecordState = "active" | "disabled" | "absent" | "unreadable";
export type ActionIconState = "unlocked" | "locked";

export const ACTION_ICON_PATHS: Record<ActionIconState, Record<16 | 32, string>> = {
  unlocked: { 16: "/icon/16.png", 32: "/icon/32.png" },
  locked: { 16: "/icon-locked/16.png", 32: "/icon-locked/32.png" },
};

/** The logo turned in 45° steps; each frame shows for `BUSY_FRAME_MS`, one turn a second. */
export const BUSY_FRAME_COUNT = 8;
export const BUSY_FRAME_MS = 125;
/**
 * A spin ends on its own after this long: longer than the transport's 90-second inference
 * timeout, so a stop that never arrives cannot leave the icon spinning.
 */
export const BUSY_LIMIT_MS = 2 * 60 * 1000;

export function busyIconPaths(frame: number): Record<16 | 32, string> {
  return { 16: `/icon-busy/${frame}/16.png`, 32: `/icon-busy/${frame}/32.png` };
}

export type ActionIconDetails = { path: Record<16 | 32, string>; tabId?: number };

/**
 * Unlocked only when at least one connection exists and every configured
 * connection holds an active vault record, so automatic unlock needs no password.
 */
export function actionIconState(states: readonly VaultRecordState[]): ActionIconState {
  return states.length > 0 && states.every((state) => state === "active") ? "unlocked" : "locked";
}

export function vaultRecordState(record: VaultResult<VaultEntry | null>): VaultRecordState {
  if (!record.ok) return "unreadable";
  return record.data?.state ?? "absent";
}

/** Notifies after every write attempt; one that reports failure may still have landed. */
export function notifyingVaultStore<T extends DurableVaultStore>(store: T, notify: () => void): T {
  return {
    ...store,
    compareAndSwap: (...args: Parameters<DurableVaultStore["compareAndSwap"]>) =>
      store.compareAndSwap(...args).finally(notify),
    remove: (...args: Parameters<DurableVaultStore["remove"]>) =>
      store.remove(...args).finally(notify),
  };
}

export function createActionIcon(deps: {
  states: () => Promise<VaultRecordState[]>;
  setIcon: (details: ActionIconDetails) => Promise<void>;
}) {
  let shown: ActionIconState | undefined;
  let queue: Promise<void> = Promise.resolve();
  // Spins in flight; a tab spins while one names it. A replaced tab's spins move with it.
  const spins = new Set<{ tabId: number }>();
  // Tabs given their own icon, which a later switch of the global icon does not reach.
  const pinned = new Set<number>();
  // Each tab's last icon write: Chrome loads the images before it applies a write, so two
  // writes for one tab could land out of order unless the next waits for the last.
  const writes = new Map<number, Promise<void>>();
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const spinning = (tabId: number) => [...spins].some((spin) => spin.tabId === tabId);
  function setTab(tabId: number, path: Record<16 | 32, string>): void {
    pinned.add(tabId);
    const write = (writes.get(tabId) ?? Promise.resolve())
      .then(() => deps.setIcon({ tabId, path }))
      // A closed tab refuses; Chrome drops its icon with it.
      .catch(() => {
        pinned.delete(tabId);
      })
      .finally(() => {
        if (writes.get(tabId) === write) writes.delete(tabId);
      });
    writes.set(tabId, write);
  }
  function tick(): void {
    if (!spins.size) {
      clearInterval(timer);
      timer = undefined;
      return;
    }
    frame = (frame + 1) % BUSY_FRAME_COUNT;
    // A tab whose last frame has not landed skips this one rather than queueing it.
    for (const tabId of new Set([...spins].map((spin) => spin.tabId)))
      if (!writes.has(tabId)) setTab(tabId, busyIconPaths(frame));
  }
  async function apply() {
    let next: ActionIconState;
    try {
      next = actionIconState(await deps.states());
    } catch {
      next = "locked";
    }
    if (next === shown) return;
    await deps.setIcon({ path: ACTION_ICON_PATHS[next] });
    shown = next;
    for (const tabId of pinned) if (!spinning(tabId)) setTab(tabId, ACTION_ICON_PATHS[next]);
  }
  return {
    /** Serialized so a slow earlier read cannot overwrite a newer state. */
    refresh(): Promise<void> {
      queue = queue.then(apply).catch(() => {
        shown = undefined;
      });
      return queue;
    },
    /**
     * Spins the tab's icon until the returned stop is called, or for `BUSY_LIMIT_MS`. The
     * tab then shows the global icon again; overlapping spins of one tab end with the last.
     */
    spin(tabId: number): () => void {
      const spin = { tabId };
      if (!spinning(tabId)) setTab(tabId, busyIconPaths(frame));
      spins.add(spin);
      timer ??= setInterval(tick, BUSY_FRAME_MS);
      const limit = setTimeout(stop, BUSY_LIMIT_MS);
      function stop(): void {
        if (!spins.delete(spin)) return;
        clearTimeout(limit);
        if (!spinning(spin.tabId)) setTab(spin.tabId, ACTION_ICON_PATHS[shown ?? "locked"]);
      }
      return stop;
    },
    /** Chrome gave a tab a new ID (`tabs.onReplaced`); its spins and own icon move with it. */
    replaced(added: number, removed: number): void {
      if (added === removed) return;
      for (const spin of spins) if (spin.tabId === removed) spin.tabId = added;
      if (!pinned.delete(removed)) return;
      setTab(added, spinning(added) ? busyIconPaths(frame) : ACTION_ICON_PATHS[shown ?? "locked"]);
    },
  };
}
