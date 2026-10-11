// The toolbar icon shows whether Pateat can log in without asking for a password.
export type VaultRecordState = "active" | "disabled" | "absent" | "unreadable";
export type ActionIconState = "unlocked" | "locked";

export const ACTION_ICON_PATHS: Record<ActionIconState, Record<16 | 32, string>> = {
  unlocked: { 16: "/icon/16.png", 32: "/icon/32.png" },
  locked: { 16: "/icon-locked/16.png", 32: "/icon-locked/32.png" },
};

/**
 * Unlocked only when at least one connection exists and every configured
 * connection holds an active vault record, so automatic unlock needs no password.
 */
export function actionIconState(states: readonly VaultRecordState[]): ActionIconState {
  return states.length > 0 && states.every((state) => state === "active") ? "unlocked" : "locked";
}

export function createActionIcon(deps: {
  states: () => Promise<VaultRecordState[]>;
  setIcon: (path: Record<16 | 32, string>) => Promise<void>;
}) {
  let shown: ActionIconState | undefined;
  let queue: Promise<void> = Promise.resolve();
  async function apply() {
    let next: ActionIconState;
    try {
      next = actionIconState(await deps.states());
    } catch {
      next = "locked";
    }
    if (next === shown) return;
    await deps.setIcon(ACTION_ICON_PATHS[next]);
    shown = next;
  }
  return {
    /** Serialized so a slow earlier read cannot overwrite a newer state. */
    refresh(): Promise<void> {
      queue = queue.then(apply).catch(() => {
        shown = undefined;
      });
      return queue;
    },
  };
}
