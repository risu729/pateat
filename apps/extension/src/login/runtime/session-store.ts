import { parseAttemptMetadata, type LoginAttemptMetadata } from "@pateat/contracts";
import { recordKey } from "./steps";
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
): Promise<void> {
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
}

/** Releases one tab's record for one origin, as after a logout (ADR 0062). */
export async function forget(rt: Runtime, key: string): Promise<void> {
  rt.persisted.delete(key);
  await write(rt);
}

/** Throws `storage-failed`, a Pateat error code the log keeps (ADR 0019). */
export async function write(rt: Runtime): Promise<void> {
  const snapshot = [...rt.persisted.values()];
  rt.vars.storageQueue = rt.vars.storageQueue.then(async () => {
    if (!rt.vars.storageHealthy) throw new Error("storage-failed");
    await rt.attemptRecords.write(snapshot);
    return undefined;
  });
  try {
    await rt.vars.storageQueue;
  } catch {
    rt.vars.storageHealthy = false;
    throw new Error("storage-failed");
  }
}
