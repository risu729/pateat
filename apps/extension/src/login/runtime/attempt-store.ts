import * as v from "valibot";
import {
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
  withdrawAccountSwitch,
  type LoginAttemptEvent,
  type LoginAttemptMetadata,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { trustedRecord } from "../../storage";
import { configureSchema } from "../wire";
import { DEMO_PROBE_ACCOUNT } from "../dummy";
import {
  choiceBadge,
  CHOICES_KEY,
  CONFIG_KEY,
  ENTRY_BLOCKS_KEY,
  ENTRY_PRESSES_KEY,
  type EntryBlock,
  entryPressSchema,
  type Execution,
  frameKey,
  holdsSite,
  idle,
  LOGOUT_FILLS_KEY,
  LOGOUTS_KEY,
  logoutSchema,
  NOTED_KEY,
  pendingChoiceSchema,
  pickedAccountSchema,
  PICKS_KEY,
  probeMode,
  recordKey,
  REJECTED_ASKS_KEY,
  STOPPED_ASKS_KEY,
  STORAGE_KEY,
  terminal,
} from "./model";
import type { PolicyChange, RouteChange, StopCause } from "./reports";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * Attempt records and the tabs' session records: loading them after a worker restart,
 * writing and forgetting them, and moving an attempt through its state transitions.
 */
export function createAttemptStore(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    quietly,
    picked,
    pending,
    badge,
    logouts,
    stoppedAsks,
    rejectedAsks,
    logoutFills,
    noted,
    entryPresses,
    persisted,
    replacedTabs,
    attempts,
    documents,
    options,
    continuations,
    reportAttempt,
    publish,
    report,
  } = shared;
  // Picks and waiting choices outlive a worker restart, as the tab's badge does. Every
  // change to them happens after this load.
  const sessionLoaded = quietly(async () => {
    const items = await storage.getItems([
      PICKS_KEY,
      CHOICES_KEY,
      LOGOUTS_KEY,
      LOGOUT_FILLS_KEY,
      STOPPED_ASKS_KEY,
      REJECTED_ASKS_KEY,
      ENTRY_PRESSES_KEY,
      NOTED_KEY,
    ]);
    const stored = Object.fromEntries(items.map(({ key, value }) => [key, value]));
    const picks = v.safeParse(v.array(pickedAccountSchema), stored[PICKS_KEY] ?? []);
    if (picks.success) for (const entry of picks.output) picked.set(entry.tabId, entry);
    const choices = v.safeParse(v.array(pendingChoiceSchema), stored[CHOICES_KEY] ?? []);
    if (choices.success)
      for (const entry of choices.output) {
        pending.set(entry.document.tabId, entry);
        // Chrome kept the tab's badge; the badge learns the choice it shows again.
        badge.choice(entry.document.tabId, choiceBadge(entry.candidates, entry.logout));
      }
    const left = v.safeParse(v.array(logoutSchema), stored[LOGOUTS_KEY] ?? []);
    if (left.success)
      for (const entry of left.output) logouts.add(recordKey(entry.tabId, entry.origin));
    const stopped = v.safeParse(v.array(logoutSchema), stored[STOPPED_ASKS_KEY] ?? []);
    if (stopped.success)
      for (const entry of stopped.output) stoppedAsks.add(recordKey(entry.tabId, entry.origin));
    const rejected = v.safeParse(v.array(logoutSchema), stored[REJECTED_ASKS_KEY] ?? []);
    if (rejected.success)
      for (const entry of rejected.output) rejectedAsks.add(recordKey(entry.tabId, entry.origin));
    const filled = v.safeParse(
      v.pipe(v.array(v.string()), v.maxLength(256)),
      stored[LOGOUT_FILLS_KEY] ?? [],
    );
    if (filled.success) for (const entry of filled.output) logoutFills.add(entry);
    const logged = v.safeParse(
      v.pipe(v.array(v.tuple([v.string(), v.array(v.string())])), v.maxLength(256)),
      stored[NOTED_KEY] ?? [],
    );
    // Every note waits for this load.
    if (logged.success)
      for (const [key, reasons] of logged.output) noted.set(key, new Set(reasons));
    const presses = v.safeParse(
      v.pipe(v.array(entryPressSchema), v.maxLength(256)),
      stored[ENTRY_PRESSES_KEY] ?? [],
    );
    if (presses.success)
      for (const entry of presses.output) {
        entryPresses.set(entry.tabId, entry);
        // A press whose next page was not checked before a restart is checked in time.
        if (!entry.checked) runtime.armEntryTimer(entry);
      }
  });
  const scopes = (keys: Set<string>) =>
    [...keys].map((key) => {
      const at = key.indexOf(" ");
      return { tabId: Number(key.slice(0, at)), origin: key.slice(at + 1) };
    });
  async function saveSession(): Promise<void> {
    await storage.setItems([
      { key: PICKS_KEY, value: [...picked.values()] },
      { key: CHOICES_KEY, value: [...pending.values()] },
      { key: LOGOUTS_KEY, value: scopes(logouts) },
      { key: LOGOUT_FILLS_KEY, value: [...logoutFills] },
      { key: STOPPED_ASKS_KEY, value: scopes(stoppedAsks) },
      { key: REJECTED_ASKS_KEY, value: scopes(rejectedAsks) },
      { key: ENTRY_PRESSES_KEY, value: [...entryPresses.values()] },
      { key: NOTED_KEY, value: [...noted].map(([page, ids]) => [page, [...ids]]) },
    ]);
  }
  // Attempts, the probe configuration and entry blocks are trusted-only device records.
  const attemptRecords = trustedRecord<LoginAttemptMetadata[]>(STORAGE_KEY);
  const probeConfig = trustedRecord<object>(CONFIG_KEY);
  const entryBlockRecords = trustedRecord<EntryBlock[]>(ENTRY_BLOCKS_KEY);
  async function pause(at: "before-delivery" | "before-ack"): Promise<void> {
    if (import.meta.env.MODE !== "probe" || runtime.armed !== at) return;
    clearTimeout(runtime.armTimer);
    runtime.armed = undefined;
    runtime.checkpoint = at;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.releaseCheckpoint = undefined;
        runtime.checkpoint = undefined;
        reject(new Error("Synthetic checkpoint expired"));
      }, 5000);
      runtime.releaseCheckpoint = () => {
        clearTimeout(timer);
        runtime.checkpoint = undefined;
        runtime.releaseCheckpoint = undefined;
        resolve();
      };
    });
  }
  const loaded = (async () => {
    try {
      const [config, stored] = await Promise.all([probeConfig.read(), attemptRecords.read()]);
      if (probeMode && config !== undefined) {
        const parsed = v.parse(configureSchema, {
          version: 1,
          type: "login.probe.configure",
          ...(config as object),
        });
        runtime.origin = parsed.origin;
        runtime.account = parsed.account ?? DEMO_PROBE_ACCOUNT;
        runtime.probePasskey = parsed.passkey;
        runtime.probeTotp = parsed.totp === true;
      }
      if (stored === undefined) return;
      if (!Array.isArray(stored) || stored.length > 100) throw new Error("Invalid attempt store");
      for (const entry of stored) {
        const metadata = recoverLoginAttempt(parseAttemptMetadata(entry));
        const key = recordKey(metadata.document.tabId, metadata.account.origin);
        if (persisted.has(key)) throw new Error("Duplicate attempt scope");
        persisted.set(key, metadata);
      }
      // Complete startup reconciliation before accepting any hello or checking
      // ownership. Closing a tab can wake a worker whose in-memory map is empty.
      const openTabs = await browser.tabs.query({});
      const liveIds = new Set(openTabs.map((tab) => tab.id));
      for (const [key, metadata] of persisted)
        if (!liveIds.has(metadata.document.tabId) && !replacedTabs.has(metadata.document.tabId))
          persisted.delete(key);
      await attemptRecords.write([...persisted.values()]);
    } catch {
      runtime.storageHealthy = false;
    }
  })();
  /**
   * The record of a tab for one origin, also once it ended. A document resumes only its
   * own origin's record; a logout may release exactly this one.
   */
  function recordFor(tabId: number, documentOrigin: string): LoginAttemptMetadata | undefined {
    const run = attempts.get(tabId);
    return run?.metadata.account.origin === documentOrigin
      ? run.metadata
      : persisted.get(recordKey(tabId, documentOrigin));
  }
  /**
   * Whether another tab's login still holds the origin. Cookies can be shared across tabs,
   * so a login that is running, awaits its result, or ended without success there keeps this
   * tab from submitting until that tab closes or its record has not changed for
   * `HOLD_MS` (ADR 0022). One that authenticated, ended without ever submitting, or was
   * stopped by Pateat with nothing in flight does not: the login form showing in this tab
   * then means the site's session has ended.
   */
  function heldElsewhere(tabId: number, siteOrigin: string): boolean {
    const now = Date.now();
    return [...persisted.values()].some(
      (entry) =>
        entry.account.origin === siteOrigin &&
        entry.document.tabId !== tabId &&
        holdsSite(entry, now),
    );
  }
  /** The attempt a tab runs, else the one it last recorded. */
  function tabAttempt(tabId: number): LoginAttemptMetadata | undefined {
    const run = attempts.get(tabId);
    if (run) return run.metadata;
    const records = [...persisted.values()].filter((entry) => entry.document.tabId === tabId);
    return records.find((entry) => !terminal(entry)) ?? records.at(-1);
  }
  function current(run: Execution): boolean {
    return (
      attempts.get(run.live.document.tabId) === run &&
      documents.get(frameKey(run.live.document)) === run.live
    );
  }
  /**
   * Whether a policy write now would stop this attempt while it can still make progress. A
   * login whose result settled as unknown, or that is watched, counts only while this
   * worker checks or judges one of its pages: such a record stays for a while, and counting
   * it would hold policy writes for as long (ADR 0027).
   */
  function inProgress(run: Execution): boolean {
    return current(run) && !terminal(run.metadata) && (run.running || !idle(run.metadata));
  }
  async function save(run: Execution): Promise<void> {
    await keep(run.metadata);
  }
  /** Stores a record; `progress` false keeps its time, as for a watch that ran out. */
  async function keep(metadata: LoginAttemptMetadata, progressed = true): Promise<void> {
    const key = recordKey(metadata.document.tabId, metadata.account.origin);
    const previous = persisted.get(key);
    const next = parseAttemptMetadata({ ...metadata, changedAt: undefined });
    // Only the login's own progress counts as a change. A new page of its tab (another
    // `documentId`), a page sent to be judged or newer settings a watch took over keep the
    // time, so a tab left browsing the site after a login that did not succeed stops
    // holding it.
    const progress = (record: LoginAttemptMetadata) =>
      JSON.stringify({
        ...record,
        document: { ...record.document, documentId: undefined },
        judged: undefined,
        watch: undefined,
        policyRevision: undefined,
        changedAt: undefined,
      });
    const unchanged =
      previous?.changedAt !== undefined && (!progressed || progress(previous) === progress(next));
    // Re-inserted, so the last record of a tab is the one it wrote last.
    persisted.delete(key);
    persisted.set(key, { ...next, changedAt: unchanged ? previous.changedAt : Date.now() });
    await write();
  }
  /** Releases one tab's record for one origin after a logout (ADR 0021 D). */
  async function forget(key: string): Promise<void> {
    persisted.delete(key);
    await write();
  }
  /** Throws `storage-failed`, a Pateat error code the log keeps (ADR 0019). */
  async function write(): Promise<void> {
    const snapshot = [...persisted.values()];
    runtime.storageQueue = runtime.storageQueue.then(async () => {
      if (!runtime.storageHealthy) throw new Error("storage-failed");
      await attemptRecords.write(snapshot);
      return undefined;
    });
    try {
      await runtime.storageQueue;
    } catch {
      runtime.storageHealthy = false;
      throw new Error("storage-failed");
    }
  }
  /**
   * Tells `options.signedIn` of an attempt that has just reached signed in: its origin, the
   * top page's origin for a frame's login, and the page it ended on.
   */
  const noteSignedIn = (
    previous: LoginAttemptMetadata,
    next: LoginAttemptMetadata,
    pageOrigin?: string,
  ) => {
    if (next.state !== "authenticated" || previous.state === "authenticated") return;
    const origins = new Set(
      [next.account.origin, next.pageOrigin, pageOrigin].filter(
        (value): value is string => value !== undefined,
      ),
    );
    for (const signedOrigin of origins)
      try {
        options.signedIn?.(next.document.tabId, signedOrigin);
      } catch {
        // Never changes the login.
      }
  };
  async function change(
    run: Execution,
    event: LoginAttemptEvent,
    policy?: PolicyChange,
    stop?: StopCause,
    routeChange?: RouteChange,
    /** Why the login stopped where it did, for the log: `password-empty` (ADR 0036). */
    reason?: string,
  ): Promise<void> {
    if (!current(run)) return;
    // A stop before the page received the prepared operation takes its effect back, so the
    // record does not hold the origin as if a submission were in flight (ADR 0022).
    const undelivered =
      event.type === "POLICY_CHANGED" &&
      run.operation &&
      !run.delivered &&
      run.operation.operationId === run.metadata.operationId
        ? run.operation.operationId
        : undefined;
    const previous = run.metadata;
    run.metadata = transitionLoginAttempt(
      run.metadata,
      undelivered ? { type: "POLICY_CHANGED", undelivered } : event,
    );
    noteSignedIn(
      previous,
      run.metadata,
      run.live.document.frameId === 0 ? run.live.document.origin : undefined,
    );
    // Settling as unknown keeps the state, but it is how a login ends without a result.
    const settled = run.metadata.settled === true && previous.settled !== true ? true : undefined;
    // An ended login no longer waits for a continuation it asked for (ADR 0018).
    if (terminal(run.metadata) || idle(run.metadata)) continuations.delete(run.metadata.id);
    if (
      run.metadata.state !== previous.state ||
      settled ||
      (routeChange && run.metadata.route !== previous.route)
    )
      // The log still names the step that was withdrawn.
      reportAttempt(
        undelivered
          ? {
              ...run.metadata,
              operationKind: previous.operationKind,
              operationEffect: previous.operationEffect,
            }
          : run.metadata,
        run.recipe,
        policy,
        {
          ...(settled ? { settled } : {}),
          ...(stop ? { stop } : {}),
          ...(reason ? { reason } : {}),
          ...(routeChange && run.metadata.route !== previous.route ? { routeChange } : {}),
        },
      );
    if (
      import.meta.env.MODE === "probe" &&
      runtime.armed === "intent-write-failure" &&
      (event.type === "MUTATION_INTENT" || event.type === "SUBMIT_INTENT")
    ) {
      runtime.armed = undefined;
      clearTimeout(runtime.armTimer);
      runtime.storageHealthy = false;
      throw new Error("Synthetic intent write failed");
    }
    await save(run);
    await publish(run.live, run.metadata);
    // A conditional request of the page waits for how this login ends (ADR 0034).
    if (terminal(run.metadata) || idle(run.metadata)) runtime.reviewRequests();
    if (run.metadata.state === "authenticated" && run.choice) await runtime.remember(run);
  }
  /**
   * Ends a fill-only login before its first step with an effect and forgets its record, so
   * it neither holds the site nor counts as a login of the tab. The document announces again
   * on this status and asks for an account, as after a logout (ADR 0021 D).
   */
  async function endFillOnly(run: Execution): Promise<void> {
    if (!current(run)) return;
    if (!terminal(run.metadata)) {
      run.metadata = transitionLoginAttempt(run.metadata, { type: "CANCEL" });
      reportAttempt(run.metadata, run.recipe);
    }
    const { document } = run.live;
    const key = recordKey(document.tabId, run.metadata.account.origin);
    attempts.delete(document.tabId);
    await forget(key).catch(() => undefined);
    // The page then waits for a pick, as after a logout; its own announcement after this
    // status carries no start, so the choice is offered and the asking logged here.
    if (run.asked?.length) {
      runtime.offerChoice(
        document,
        run.asked,
        runtime.logoutDetail(recordKey(document.tabId, document.origin)),
      );
      run.live.state = "denied";
      run.live.reason = "logged-out";
      report(document, {
        type: "refused",
        tabId: document.tabId,
        origin: document.origin,
        reason: "logged-out",
        detail: runtime.logoutDetail(key),
        ...(document.frameId === 0 ? {} : { frame: true as const }),
      });
    }
    await publish(run.live, run.metadata);
  }
  async function withdrawSwitch(run: Execution): Promise<void> {
    const tabId = run.live.document.tabId;
    if (
      attempts.get(tabId) !== run ||
      persisted.get(recordKey(tabId, run.metadata.account.origin))?.id !== run.metadata.id
    )
      return;
    run.metadata = withdrawAccountSwitch(run.metadata);
    await save(run);
    await publish(run.live, run.metadata);
  }
  return {
    saveSession,
    loaded,
    sessionLoaded,
    recordFor,
    heldElsewhere,
    inProgress,
    current,
    change,
    forget,
    save,
    endFillOnly,
    pause,
    withdrawSwitch,
    tabAttempt,
    keep,
    noteSignedIn,
    scopes,
    entryBlockRecords,
    probeConfig,
    attemptRecords,
  };
}
