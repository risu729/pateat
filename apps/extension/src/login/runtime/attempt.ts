import {
  attemptPlan,
  parseAttemptMetadata,
  WATCH_PATH_MAX,
  addAttemptTime,
  attemptTimes,
  siteDefaultConnection,
  transitionLoginAttempt,
  withdrawAccountSwitch,
  type LoginAttemptEvent,
  type LoginAttemptMetadata,
  type LoginRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { MAX_SETTINGS_DEFER_MS } from "../../service/settings-sync";
import type { ServiceTiming } from "../../service/transport";
import { LOGIN_STEP_WAIT_MS } from "../wire";
import { isoTimeMs } from "../../time";
import { siteDefaultsMark } from "../switch";
import { type LoginReport, type PolicyChange, type StopCause, type RouteChange } from "./report";
import { frameKey, branchField, siteOf, pathNow, recordKey } from "./steps";
import { terminal, idle } from "./attempt-state";
import { probeMode, ENTRY_NEXT_PAGE_MS } from "./constants";
import {
  PICKS_KEY,
  CHOICES_KEY,
  STOPPED_ASKS_KEY,
  REJECTED_ASKS_KEY,
  ASK_FILLS_KEY,
  ENTRY_PRESSES_KEY,
  NOTED_KEY,
  RELOGINS_KEY,
  DETAIL_OFFERS_KEY,
  PENDING_DETAILS_KEY,
  REFUSED_DETAILS_KEY,
} from "./session-schemas";
import { scopes, quietly, keep, forget } from "./session-store";
import { type LiveDocument, type StartTiming, type Execution } from "./types";
import { signedInNow, countRelogin } from "./relogin";
import { endPickedPause } from "./pause";
import { reviewRequests } from "./passkey";
import { remember } from "./choice-save";
import { settleDetails, forgetDetail, removeRefused } from "./detail-fill";
import { askFor, offerChoice } from "./choice";
import { DocumentGone } from "./document-gone";
import type { Runtime } from "./state";

/** Spins the tab's badge from a model request's `sent` until `stop`, once the request returns. */
export function spinning(rt: Runtime, tabId: number) {
  let stop: (() => void) | undefined;
  return {
    sent: (then: () => void) => () => {
      stop ??= rt.badge.spin(tabId);
      then();
    },
    stop: () => stop?.(),
  };
}

/** Reports about `source`'s document; only the tab's own page gets its URL (ADR 0019). */
export const report = (rt: Runtime, source: { frameId: number }, value: LoginReport) => {
  try {
    // A report that names its page's URL, even as none, keeps it.
    const page = rt.documents.get(frameKey({ tabId: value.tabId, frameId: 0 }));
    const url =
      "url" in value
        ? value.url
        : source.frameId === 0 && page && page.document.origin === value.origin
          ? page.url
          : undefined;
    const { url: _named, ...rest } = value;
    rt.options.report?.(url ? { ...rest, url } : rest);
  } catch {
    // A report must never change the answer.
  }
};

export const reportAttempt = (
  rt: Runtime,
  metadata: LoginAttemptMetadata,
  recipe: LoginRecipe | undefined,
  policy?: PolicyChange,
  flags: {
    settled?: true;
    repeat?: true;
    stop?: StopCause;
    reason?: string;
    routeChange?: RouteChange;
    layoutFrom?: string;
    /** When the login ended, if earlier than now, such as when its watch ran out. */
    endedAt?: number;
  } = {},
) => {
  const { stop, endedAt, ...marks } = flags;
  // A login that just ended, signed in or blocked, says how long it took (ADR 0019); a
  // watched one only when its watch ends, which may have been before it was noticed.
  const times = terminal(metadata) && !flags.repeat ? attemptTimes(metadata, endedAt) : undefined;
  // Handler steps sit inside the plan, so the plan names the handler a step belongs to.
  const handler =
    recipe && metadata.handlers.length
      ? attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.handler
      : undefined;
  report(rt, metadata.document, {
    type: "attempt",
    tabId: metadata.document.tabId,
    origin: metadata.document.origin,
    recipeId: metadata.recipeId,
    recipeRevision: metadata.recipeRevision,
    ...branchField(metadata),
    route: metadata.route,
    ...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
    state: metadata.state,
    stepIndex: metadata.stepIndex,
    stepCount: metadata.stepCount,
    ...(metadata.operationKind ? { operation: metadata.operationKind } : {}),
    ...(metadata.operationEffect ? { effect: metadata.operationEffect } : {}),
    ...(handler === undefined ? {} : { handler }),
    ...(metadata.outcome ? { outcome: metadata.outcome } : {}),
    ...(metadata.unconfirmed ? { unconfirmed: true as const } : {}),
    ...(metadata.watch ? { watched: true as const } : {}),
    ...(unsubmitted(rt, metadata) ? { unsubmitted: true as const } : {}),
    ...(metadata.fillOnly ? { fillOnly: true as const, reason: "fill-only" } : {}),
    ...(metadata.stopAt === undefined ? {} : { stop: "password" as const }),
    ...(policy && metadata.outcome === "policy-changed" ? policy : {}),
    ...(stop ? { cause: stop } : {}),
    ...marks,
    ...(times ? { times } : {}),
  });
};

export const stepWaitMs = (rt: Runtime) =>
  (probeMode ? rt.vars.probeStepWaitMs : undefined) ?? LOGIN_STEP_WAIT_MS;

/** Nothing was submitted yet, and the login is still in the document it began in. */
export const unsubmitted = (rt: Runtime, metadata: LoginAttemptMetadata) =>
  metadata.submissions === 0 && rt.begunIn.get(metadata.id) === metadata.document.documentId;

export async function saveSession(rt: Runtime): Promise<void> {
  await storage.setItems([
    { key: PICKS_KEY, value: [...rt.picked.values()] },
    { key: CHOICES_KEY, value: [...rt.pending.values()] },
    { key: STOPPED_ASKS_KEY, value: scopes(rt, rt.stoppedAsks) },
    { key: REJECTED_ASKS_KEY, value: scopes(rt, rt.rejectedAsks) },
    { key: ASK_FILLS_KEY, value: [...rt.askFills] },
    { key: ENTRY_PRESSES_KEY, value: [...rt.entryPresses.values()] },
    { key: NOTED_KEY, value: [...rt.noted].map(([page, ids]) => [page, [...ids]]) },
    { key: RELOGINS_KEY, value: [...rt.relogins.values()] },
    { key: DETAIL_OFFERS_KEY, value: [...rt.detailOffers.values()] },
    { key: PENDING_DETAILS_KEY, value: [...rt.pendingDetails.values()].flat() },
    { key: REFUSED_DETAILS_KEY, value: [...rt.refusedDetails.values()] },
  ]);
}

/**
 * Adds time a login waited for the service to its attempt (ADR 0019): to the run that
 * holds it now, which may be a later document's, and to its stored record, both written
 * with the attempt's next change.
 */
export function spend(
  rt: Runtime,
  attemptId: string,
  waitedMs: number,
  timing: ServiceTiming | undefined,
): void {
  const add = { serviceMs: waitedMs, networkMs: timing?.networkMs ?? 0 };
  for (const run of rt.attempts.values())
    if (run.metadata.id === attemptId) run.metadata = addAttemptTime(run.metadata, add);
  for (const [key, record] of rt.persisted)
    if (record.id === attemptId) rt.persisted.set(key, addAttemptTime(record, add));
}

/**
 * The time a new login took before it started (ADR 0019): since its page was seen, or the
 * sign-in entry pressed just before it was, with the service time spent on them, the
 * person's time picking its account in the popup and, after a press, the wait for the site
 * from the press until its page was seen. An entry press's time is taken once.
 */
export function startTiming(
  rt: Runtime,
  live: LiveDocument,
  chosen: { connectionId: string; itemId: string },
): StartTiming & { pageMs: number } {
  const { tabId, documentId, frameId } = live.document;
  const timing = { ...live.timing, pageMs: 0 };
  const press = rt.entryPresses.get(tabId);
  const pressedAt = press && isoTimeMs(press.pressedAt);
  if (
    press?.timing &&
    pressedAt !== undefined &&
    frameId === 0 &&
    !(press.documentId === documentId && press.url === live.url) &&
    timing.since >= pressedAt &&
    timing.since - pressedAt <= ENTRY_NEXT_PAGE_MS + LOGIN_STEP_WAIT_MS
  ) {
    timing.pageMs = timing.since - pressedAt;
    timing.since = Math.min(timing.since, press.timing.since);
    timing.serviceMs += press.timing.serviceMs;
    timing.networkMs += press.timing.networkMs;
    timing.personMs += press.timing.personMs;
    const { timing: _taken, ...spent } = press;
    rt.entryPresses.set(tabId, spent);
    void quietly(rt, () => saveSession(rt));
  }
  const pick = rt.picked.get(tabId);
  if (
    pick?.attemptId === undefined &&
    pick?.documentId === documentId &&
    pick.connectionId === chosen.connectionId &&
    pick.itemId === chosen.itemId
  )
    timing.personMs += pick.waitedMs;
  // The document's time so far is this login's; another login it starts later counts
  // from now (ADR 0019).
  Object.assign(live.timing, { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 });
  return timing;
}

/** Adds time spent on a document's login before it started, such as its generation. */
export function spendBefore(
  _rt: Runtime,
  live: LiveDocument,
  waitedMs: number,
  timing: ServiceTiming | undefined,
) {
  live.timing.serviceMs += Math.max(0, Math.round(waitedMs));
  live.timing.networkMs += timing?.networkMs ?? 0;
}

export function current(rt: Runtime, run: Execution): boolean {
  return (
    rt.attempts.get(run.live.document.tabId) === run &&
    rt.documents.get(frameKey(run.live.document)) === run.live
  );
}

/**
 * Whether a policy write now would stop this attempt while it can still make progress. A
 * login whose result settled as unknown, or that is watched, counts only while this
 * worker checks or judges one of its pages: such a record stays for a while, and counting
 * it would hold policy writes for as long (ADR 0027).
 */
export function inProgress(rt: Runtime, run: Execution): boolean {
  return current(rt, run) && !terminal(run.metadata) && (run.running || !idle(run.metadata));
}

export async function save(rt: Runtime, run: Execution): Promise<void> {
  await keep(rt, run.metadata);
}

/**
 * Tells `options.signedIn` of an attempt that has just reached signed in: its origin, the
 * top page's origin for a frame's login, and the page it ended on.
 */
export const noteSignedIn = (
  rt: Runtime,
  previous: LoginAttemptMetadata,
  next: LoginAttemptMetadata,
  pageOrigin?: string,
) => {
  // A login confirmed signed in keeps its account for the site's session (ADR 0063).
  if (
    next.state === "authenticated" &&
    !next.unconfirmed &&
    !(previous.state === "authenticated" && !previous.unconfirmed)
  )
    void keepPick(rt, next);
  if (!signedInNow(rt, previous, next)) return;
  const origins = new Set(
    [next.account.origin, next.pageOrigin, pageOrigin].filter(
      (value): value is string => value !== undefined,
    ),
  );
  for (const signedOrigin of origins)
    try {
      rt.options.signedIn?.(next.document.tabId, signedOrigin);
    } catch {
      // Never changes the login.
    }
};

/**
 * Keeps the account a popup pick or an account switch signed in with as the site's pick
 * for the browser session, unless it was made the default, which drops the session's
 * pick instead (ADR 0063).
 */
export async function keepPick(rt: Runtime, signedIn: LoginAttemptMetadata): Promise<void> {
  const { tabId } = signedIn.document;
  const pick = rt.picked.get(tabId);
  const site = siteOf(signedIn.account.origin);
  const live =
    rt.documents.get(frameKey(signedIn.document)) ??
    rt.documents.get(frameKey({ tabId, frameId: 0 }));
  if (!pick || pick.attemptId !== signedIn.id || site === undefined || !live) return;
  if (pick.makeDefault) {
    await rt.accountPicks.stopAsking(site, live.incognito === true).catch(() => undefined);
    return;
  }
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return;
  // Picking the saved default itself chose nothing else: the site goes on as before.
  const saved = snapshot.snapshot.settings.siteDefaults.find(
    (entry) => entry.origin === signedIn.account.origin,
  );
  const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
  if (saved?.itemId === pick.itemId && mapped?.ok && mapped.connectionId === pick.connectionId) {
    await rt.accountPicks.stopAsking(site, live.incognito === true).catch(() => undefined);
    return;
  }
  await rt.accountPicks
    .askEveryTime({
      site,
      incognito: live.incognito === true,
      defaults: siteDefaultsMark(snapshot.snapshot.settings.siteDefaults, site, siteOf),
    })
    .catch(() => undefined);
}

export async function change(
  rt: Runtime,
  run: Execution,
  event: LoginAttemptEvent,
  policy?: PolicyChange,
  stop?: StopCause,
  routeChange?: RouteChange,
  /** Why the login stopped where it did, for the log: `password-empty` (ADR 0036). */
  reason?: string,
): Promise<void> {
  if (!current(rt, run)) return;
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
    rt,
    previous,
    run.metadata,
    run.live.document.frameId === 0 ? run.live.document.origin : undefined,
  );
  countRelogin(rt, previous, run.metadata, run.live.incognito === true);
  // A watch that begins in this document keeps the path the login was last read on, so
  // a route the document takes later is read (ADR 0027 amendment of 2026-10-25).
  const { watch } = run.metadata;
  if (watch && watch.path === undefined && watch.documentId === run.live.document.documentId) {
    const path =
      run.readPath?.documentId === watch.documentId ? run.readPath.path : pathNow(run.live);
    if (path.length <= WATCH_PATH_MAX)
      run.metadata = parseAttemptMetadata({ ...run.metadata, watch: { ...watch, path } });
    // The path the document announced may lag a route it took without a move reported
    // to this worker, as before the login carried it; the reading is the page's own.
    run.live.route ??= path;
  }
  if (signedInNow(rt, previous, run.metadata)) void endPickedPause(rt, run.metadata, run.live);
  // Settling as unknown keeps the state, but it is how a login ends without a result.
  const settled = run.metadata.settled === true && previous.settled !== true ? true : undefined;
  // An ended login no longer waits for a continuation it asked for (ADR 0018).
  if (terminal(run.metadata) || idle(run.metadata)) rt.continuations.delete(run.metadata.id);
  // The layout it ran before, when the login just switched layouts (ADR 0060).
  const layoutFrom = run.metadata.layout !== previous.layout ? previous.layout : undefined;
  if (
    run.metadata.state !== previous.state ||
    settled ||
    (routeChange && run.metadata.route !== previous.route) ||
    layoutFrom !== undefined
  )
    // The log still names the step that was withdrawn.
    reportAttempt(
      rt,
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
        ...(layoutFrom === undefined ? {} : { layoutFrom }),
      },
    );
  if (
    import.meta.env.MODE === "probe" &&
    rt.vars.armed === "intent-write-failure" &&
    (event.type === "MUTATION_INTENT" || event.type === "SUBMIT_INTENT")
  ) {
    rt.vars.armed = undefined;
    clearTimeout(rt.vars.armTimer);
    rt.vars.storageHealthy = false;
    throw new Error("Synthetic intent write failed");
  }
  await save(rt, run);
  await publish(rt, run.live, run.metadata);
  // A conditional request of the page waits for how this login ends (ADR 0034).
  if (terminal(run.metadata) || idle(run.metadata)) reviewRequests(rt);
  if (run.metadata.state === "authenticated" && !run.metadata.unconfirmed && run.choice)
    await remember(rt, run);
  // Links filled from the popup are saved once the login is confirmed, and links whose
  // value the site rejected are removed (ADR 0061).
  if (run.metadata.state === "authenticated" && !run.metadata.unconfirmed)
    await settleDetails(rt, run, true);
  else if (
    run.metadata.outcome === "credential-rejected" &&
    previous.outcome !== "credential-rejected"
  ) {
    await settleDetails(rt, run, false);
    await forgetDetail(rt, run);
  }
  // Refused links that another login kept from being removed are removed once one ends.
  if (rt.refusedDetails.size && terminal(run.metadata) && !terminal(previous))
    await removeRefused(rt, run).catch(() => undefined);
}

/**
 * Ends a fill-only login before its first step with an effect and forgets its record, so
 * it neither holds the site nor counts as a login of the tab. The document announces again
 * on this status and asks for an account, as before the fill (ADR 0021 D).
 */
export async function endFillOnly(rt: Runtime, run: Execution): Promise<void> {
  if (!current(rt, run)) return;
  if (!terminal(run.metadata)) {
    run.metadata = transitionLoginAttempt(run.metadata, { type: "CANCEL" });
    reportAttempt(rt, run.metadata, run.recipe);
  }
  const { document } = run.live;
  const key = recordKey(document.tabId, run.metadata.account.origin);
  rt.attempts.delete(document.tabId);
  await forget(rt, key).catch(() => undefined);
  // The page then waits for a pick; its own announcement after this status carries no
  // start, so the choice is offered and the asking logged here.
  if (run.asked?.candidates.length) {
    const ask = askFor(rt, document.tabId, document.origin) ?? run.asked.ask;
    offerChoice(rt, document, run.asked.candidates, ask);
    run.live.state = "denied";
    run.live.reason = "account-asked";
    report(rt, document, {
      type: "refused",
      tabId: document.tabId,
      origin: document.origin,
      reason: "account-asked",
      detail: ask,
      candidates: run.asked.candidates.length,
      ...(document.frameId === 0 ? {} : { frame: true as const }),
    });
  }
  await publish(rt, run.live, run.metadata);
}

export async function withdrawSwitch(rt: Runtime, run: Execution): Promise<void> {
  const tabId = run.live.document.tabId;
  if (
    rt.attempts.get(tabId) !== run ||
    rt.persisted.get(recordKey(tabId, run.metadata.account.origin))?.id !== run.metadata.id
  )
    return;
  run.metadata = withdrawAccountSwitch(run.metadata);
  await save(rt, run);
  await publish(rt, run.live, run.metadata);
}

/**
 * Whether a login other than `run` is in progress that a settings write would stop, as
 * it bumps the revision every attempt checks: an account choice or a detail link then
 * waits (ADR 0013, ADR 0061). A login between pages has no current run, as while its
 * next page is admitted or after a worker restart, so its stored record counts too, as
 * `active` counts it, but only while it changed within the settings sync's two-minute
 * cap: an older one is likely left over, and the write may stop it `policy-changed`
 * (owner, 2026-10-24 for choices and 2026-10-25 for detail links).
 */
export function loginElsewhere(rt: Runtime, run: Execution | undefined): boolean {
  const now = Date.now();
  return (
    rt.attempts.values().some((other) => other !== run && inProgress(rt, other)) ||
    rt.persisted.values().some((other) => {
      const age = now - (other.changedAt ?? Number.NEGATIVE_INFINITY);
      return (
        other.id !== run?.metadata.id &&
        !terminal(other) &&
        !idle(other) &&
        // A clock set back ends the wait rather than prolonging it.
        age >= 0 &&
        age < MAX_SETTINGS_DEFER_MS
      );
    })
  );
}

export async function send(
  _rt: Runtime,
  live: LiveDocument,
  message: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await browser.tabs.sendMessage(
      live.document.tabId,
      { version: 1, token: live.token, ...message },
      { documentId: live.document.documentId, frameId: live.document.frameId },
    );
  } catch (error) {
    // The browser rejects when no listener in the document answered: the document has no
    // receiver anymore, or it unloaded before its answer.
    throw new DocumentGone(error);
  }
}

export async function publish(
  rt: Runtime,
  live: LiveDocument,
  metadata?: LoginAttemptMetadata,
): Promise<void> {
  if (rt.documents.get(frameKey(live.document)) !== live) return;
  await send(rt, live, {
    type: "login.status",
    state: metadata?.state ?? live.state ?? "denied",
    stepIndex: metadata?.stepIndex ?? 0,
    ...(metadata?.outcome || live.reason ? { outcome: metadata?.outcome ?? live.reason } : {}),
  }).catch(() => undefined);
}
