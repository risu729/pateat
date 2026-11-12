import { ssoChild } from "./sso-state";
import { parseAttemptMetadata, type LoginAttemptMetadata } from "@pateat/contracts";
import { rememberConfirmAuthentication } from "./confirm-state";
import { recordKey } from "./steps";
import { terminal } from "./attempt-state";
import { SITE_MOVE_MS, SITE_WAIT_MS, WATCH_MS } from "./constants";
import type { Runtime } from "./state";

// Toolbar and session storage failures only lose the badge or a pick; never a login.
export const quietly = (_rt: Runtime, work: () => Promise<unknown>) =>
  Promise.try(work).then(
    () => undefined,
    () => undefined,
  );

export const scopes = (_rt: Runtime, keys: Set<string>) =>
  [...keys].map((key) => {
    const at = key.indexOf(" ");
    return { tabId: Number(key.slice(0, at)), origin: key.slice(at + 1) };
  });

export async function pause(rt: Runtime, at: "before-delivery" | "before-ack"): Promise<void> {
  if (import.meta.env.MODE !== "probe" || rt.vars.armed !== at) return;
  clearTimeout(rt.vars.armTimer);
  rt.vars.armed = undefined;
  rt.vars.checkpoint = at;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.vars.releaseCheckpoint = undefined;
      rt.vars.checkpoint = undefined;
      reject(new Error("Synthetic checkpoint expired"));
    }, 5000);
    rt.vars.releaseCheckpoint = () => {
      clearTimeout(timer);
      rt.vars.checkpoint = undefined;
      rt.vars.releaseCheckpoint = undefined;
      resolve();
    };
  });
}

/** Stores a record; `progress` false keeps its time, as for a watch that ran out. */
export async function keep(
  rt: Runtime,
  metadata: LoginAttemptMetadata,
  progressed = true,
  authorize?: () => boolean,
): Promise<void> {
  if (authorize && !authorize()) return;
  const key = recordKey(metadata.document.tabId, metadata.account.origin);
  const previous = rt.persisted.get(key);
  const next = parseAttemptMetadata({ ...metadata, changedAt: undefined });
  // Only the login's own progress counts as a change. A new page of its tab (another
  // `documentId`), a page sent to be judged, newer settings a watch took over or the
  // login's own times keep the time, so a tab left browsing the site after a login that
  // did not succeed stops holding it.
  const progress = (record: LoginAttemptMetadata) =>
    JSON.stringify({
      ...record,
      document: { ...record.document, documentId: undefined },
      judged: undefined,
      watch: undefined,
      policyRevision: undefined,
      changedAt: undefined,
      timing: undefined,
    });
  const unchanged =
    previous?.changedAt !== undefined && (!progressed || progress(previous) === progress(next));
  // Re-inserted, so the last record of a tab is the one it wrote last.
  rt.persisted.delete(key);
  rt.persisted.set(key, { ...next, changedAt: unchanged ? previous.changedAt : Date.now() });
  await write(rt);
  if (
    !ssoChild(rt.sso, metadata) &&
    (!authorize || authorize()) &&
    metadata.state === "authenticated" &&
    !metadata.unconfirmed &&
    (previous?.state !== "authenticated" || previous.unconfirmed)
  )
    await rememberConfirmAuthentication(rt, metadata);
}

/** Releases one tab's record for one origin, as after a logout (ADR 0062). */
export async function forget(rt: Runtime, key: string): Promise<void> {
  rt.persisted.delete(key);
  await write(rt);
}

/** Throws `storage-failed`, a Pateat error code the log keeps (ADR 0019). */
export async function write(rt: Runtime): Promise<void> {
  rt.vars.storageQueue = rt.vars.storageQueue.then(async () => {
    if (!rt.vars.storageHealthy) throw new Error("storage-failed");
    // The records as they are when the write runs, so a write queued behind a closed
    // tab's release does not store its record again.
    await rt.attemptRecords.write([...rt.persisted.values()]);
    return undefined;
  });
  armSiteWait(rt);
  try {
    await rt.vars.storageQueue;
  } catch {
    rt.vars.storageHealthy = false;
    throw new Error("storage-failed");
  }
}

/**
 * Sets the site-wait alarm for the first stored login whose wait for the site or watch
 * runs out (ADR 0022, amended 2026-11-03), or clears it when none waits. One that already
 * ran out and still waits, as while the tab's running login or a page that asked for a
 * passkey decides it, is looked at again `SITE_MOVE_MS` later, Chrome's shortest alarm
 * delay. Tells `keepAwake` whether a login waits for the site; a watch alone does not.
 */
export function armSiteWait(rt: Runtime, now = Date.now()): void {
  const schedule = rt.options.siteWait;
  if (!schedule) return;
  let when: number | undefined;
  let awake = false;
  for (const stored of rt.persisted.values()) {
    const run = rt.attempts.get(stored.document.tabId)?.metadata;
    const record = run?.id === stored.id ? run : stored;
    if (terminal(record)) continue;
    if (record.timing.pageSince !== undefined) awake = true;
    // The same persistent alarm also ends a watch whose page never announces again.
    for (const [since, duration] of [
      [record.timing.pageSince, SITE_WAIT_MS],
      [record.watch?.since, WATCH_MS],
      [record.signInFill ? record.fillSince : undefined, WATCH_MS],
    ] as const) {
      if (since === undefined) continue;
      // A clock set back before either wait began ends it too.
      const due = since <= now && since + duration > now ? since + duration : now + SITE_MOVE_MS;
      when = Math.min(when ?? due, due);
    }
  }
  if (awake !== rt.vars.siteWaitAwake) {
    rt.vars.siteWaitAwake = awake;
    rt.options.keepAwake?.(awake);
  }
  if (when === rt.vars.siteWaitAt) return;
  rt.vars.siteWaitAt = when;
  // A failed call is made again by the next write.
  void Promise.try(() => schedule(when)).catch(() => {
    if (rt.vars.siteWaitAt === when) rt.vars.siteWaitAt = Number.NaN;
  });
}
