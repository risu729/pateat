import * as v from "valibot";
import { runsLogin, sameLoginDocument, type LoginDocument } from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  pickRequestSchema,
  type AskReason,
  type ChoiceResponse,
  type PickResponse,
  type StatusResponse,
} from "../choice-wire";
import { observedPath } from "../../observation/path";
import { recordKey, choiceBadge, frameKey, clipCodes } from "./steps";
import { rejectedElsewhere, recordFor, heldElsewhere, tabAttempt } from "./hold";
import { type PendingChoice, type PickedAccount } from "./session-schemas";
import { quietly } from "./session-store";
import { saveSession, report } from "./attempt";
import { pauseOf, pausedUntil, usedAndSwitch } from "./pause";
import { type LoginReport } from "./report";
import { routesOf } from "./generation-scope";
import type { Runtime } from "./state";

/**
 * Why a tab asks for an account of an origin (ADR 0021 D): the site rejected its own
 * login, its own login stopped after a submission or its watch was abandoned, or the
 * site rejected another tab's login that still asks. Undefined when it does not ask.
 */
export function askFor(rt: Runtime, tabId: number, siteOrigin: string): AskReason | undefined {
  const key = recordKey(tabId, siteOrigin);
  if (rt.rejectedAsks.has(key)) return "rejected";
  if (rt.stoppedAsks.has(key)) return "stopped-login";
  return rejectedElsewhere(rt, tabId, siteOrigin) ? "rejected-elsewhere" : undefined;
}

/** Badges the tab and records the refused document for the popup (ADR 0021). */
export function offerChoice(
  rt: Runtime,
  document: LoginDocument,
  candidates: PendingChoice["candidates"],
  ask?: AskReason,
  paused?: boolean,
): void {
  // The same document offered the choice again still waits since its first offer.
  const offered = rt.pending.get(document.tabId);
  rt.pending.set(document.tabId, {
    document,
    at: offered?.document.documentId === document.documentId ? offered.at : Date.now(),
    candidates,
    ...(ask ? { ask } : {}),
    ...(paused ? { paused: true as const } : {}),
  });
  void quietly(rt, () => saveSession(rt));
  rt.badge.choice(document.tabId, choiceBadge(candidates, ask, paused));
}

export function clearChoice(rt: Runtime, tabId: number): void {
  if (!rt.pending.delete(tabId)) return;
  void quietly(rt, () => saveSession(rt));
  rt.badge.choice(tabId, undefined);
  rt.badge.note(tabId, undefined);
}

/**
 * Asks a refused document that a restarted worker knows only from session storage to
 * announce again; that offers its choice again, or clears it once the document is gone.
 */
export function revive(rt: Runtime, waiting: PendingChoice): Promise<void> {
  const { tabId, frameId, documentId } = waiting.document;
  let running = rt.reviving.get(tabId);
  if (!running) {
    running = browser.tabs
      .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId, documentId })
      .then(
        () => undefined,
        () => {
          if (rt.pending.get(tabId) === waiting) clearChoice(rt, tabId);
        },
      )
      .finally(() => rt.reviving.delete(tabId));
    rt.reviving.set(tabId, running);
  }
  return running;
}

/** The refused document of a tab and the accounts it could use, for the popup. */
export async function choiceFor(rt: Runtime, tabId: number): Promise<ChoiceResponse> {
  // The attempt records decide whether another tab holds the site.
  await rt.vars.loaded;
  await rt.vars.sessionLoaded;
  let waiting = rt.pending.get(tabId);
  if (waiting && !rt.documents.has(frameKey(waiting.document))) {
    await revive(rt, waiting);
    // The document may have answered as stale because another announcement of it, such
    // as one asked for by the restarted worker's reconnect of every tab, overtook it.
    await rt.admitting.get(`${tabId}:${waiting.document.frameId}`)?.catch(() => undefined);
    // A document that answered but could not be admitted again, for example after its
    // site access was withdrawn, offers nothing; asking again would only repeat that.
    if (rt.pending.get(tabId) === waiting && !rt.documents.has(frameKey(waiting.document)))
      clearChoice(rt, tabId);
    waiting = rt.pending.get(tabId);
  }
  const live = waiting && rt.documents.get(frameKey(waiting.document));
  if (
    !waiting ||
    !live ||
    !sameLoginDocument(live.document, waiting.document) ||
    recordFor(rt, tabId, waiting.document.origin) !== undefined
  ) {
    // The document announced again without being refused for several accounts.
    if (waiting && live) clearChoice(rt, tabId);
    return { ok: false, reason: "no-choice" };
  }
  // A default saved since the refusal decides the page's next login instead.
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (rt.pending.get(tabId) !== waiting) return { ok: false, reason: "no-choice" };
  // A paused choice ends once its pause has (ADR 0062); the page's next announcement
  // logs in.
  if (waiting.paused && (await pauseOf(rt, live)) === undefined) {
    if (rt.pending.get(tabId) === waiting) clearChoice(rt, tabId);
    return { ok: false, reason: "no-choice" };
  }
  if (rt.pending.get(tabId) !== waiting) return { ok: false, reason: "no-choice" };
  const held = heldElsewhere(rt, tabId, waiting.document.origin) ? { held: true as const } : {};
  // A tab that asks, and a paused site (ADR 0062), offers any matching account.
  if (waiting.ask || waiting.paused)
    return {
      ok: true,
      origin: waiting.document.origin,
      documentId: waiting.document.documentId,
      candidates: waiting.candidates,
      ...(waiting.ask ? { ask: waiting.ask } : {}),
      ...(waiting.paused ? { paused: true as const } : {}),
      ...held,
      ...(waiting.ask !== "rejected" && rejectedElsewhere(rt, tabId, waiting.document.origin)
        ? { rejectedElsewhere: true as const }
        : {}),
    };
  if (
    !snapshot.ok ||
    snapshot.snapshot.settings.siteDefaults.some(
      (entry) => entry.origin === waiting.document.origin,
    )
  ) {
    if (snapshot.ok) clearChoice(rt, tabId);
    return { ok: false, reason: "no-choice" };
  }
  return {
    ok: true,
    origin: waiting.document.origin,
    documentId: waiting.document.documentId,
    candidates: waiting.candidates,
    ...held,
    ...(rejectedElsewhere(rt, tabId, waiting.document.origin)
      ? { rejectedElsewhere: true as const }
      : {}),
  };
}

/** Answers the popup and logs, value-free, what it was told when that changes (ADR 0019). */
export async function popupChoice(rt: Runtime, tabId: number): Promise<ChoiceResponse> {
  const answer = await choiceFor(rt, tabId);
  const page = rt.documents.get(frameKey({ tabId, frameId: 0 }));
  const pageOrigin = answer.ok ? answer.origin : page?.document.origin;
  if (pageOrigin === undefined) return answer;
  const record = recordFor(rt, tabId, pageOrigin);
  const entry: LoginReport = {
    type: "popup",
    tabId,
    origin: pageOrigin,
    choice: answer.ok ? "offered" : "none",
    ...(answer.ok
      ? {
          candidates: answer.candidates.length,
          ...(answer.ask ? { ask: answer.ask } : {}),
          ...(answer.paused ? { paused: true as const } : {}),
          ...(answer.held ? { held: true as const } : {}),
          ...(answer.rejectedElsewhere ? { rejectedElsewhere: true as const } : {}),
        }
      : {}),
    ...(record
      ? {
          recordState: record.state,
          ...(record.outcome ? { recordOutcome: record.outcome } : {}),
        }
      : {}),
    ...(page?.reason ? { pageReason: page.reason } : {}),
  };
  const key = JSON.stringify(entry);
  if (rt.popupAnswers.get(tabId) !== key) {
    rt.popupAnswers.set(tabId, key);
    report(rt, { frameId: 0 }, entry);
  }
  return answer;
}

/**
 * What the popup's page section shows for a tab (ADR 0038): whether the top page's origin
 * has a recipe, and for which path; the page's state as this worker last saw it; and the
 * tab's last login and model request on that origin. Never a value, recipe step or query.
 */
export async function popupStatus(rt: Runtime, tabId: number): Promise<StatusResponse> {
  const live = rt.documents.get(frameKey({ tabId, frameId: 0 }));
  // The tab's own URL, since its page may not have announced yet.
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  const url = tab?.url ?? live?.url;
  const page = url ? (URL.parse(url) ?? undefined) : undefined;
  // The popup shows its page section only on HTTP(S) pages.
  if (page?.protocol !== "https:" && page?.protocol !== "http:")
    return { ok: false, reason: "no-page" };
  const till = await pausedUntil(rt, {
    url: page.href,
    incognito: tab?.incognito ?? live?.incognito,
  });
  const pausedTill = typeof till === "number" ? till : undefined;
  const pageOrigin = page.origin;
  const path = observedPath(page.pathname);
  const [starts, entries, routes] = await Promise.all([
    rt.recipes.starts(pageOrigin).catch(() => []),
    rt.recipes.entries(pageOrigin).catch(() => []),
    routesOf(rt, pageOrigin),
  ]);
  // A later step a login may start at counts as a start on its path (ADR 0049), and so
  // does the first page of a recipe generated as a verification (ADR 0035).
  const paths = [
    ...starts.flatMap((start) => [start.path, ...(start.later ?? []).map((entry) => entry.path)]),
    ...entries.map((entry) => entry.entry.path),
    ...(routes ?? []).filter((recipe) => !runsLogin(recipe)).map((recipe) => recipe.steps[0]!.path),
  ];
  await rt.vars.loaded;
  const status = rt.badge.status(tabId);
  const known = status?.origin === pageOrigin ? status : undefined;
  // A login whose result settled as unknown has nothing in flight; its next pages are
  // checked (ADR 0027), so the popup does not show it as logging in. A login in a frame
  // is recorded under the frame's origin.
  const attempt = recordFor(rt, tabId, pageOrigin) ?? tabAttempt(rt, tabId);
  const settled =
    known?.login?.state === "reconciling" &&
    attempt?.state === "reconciling" &&
    attempt.settled === true &&
    (attempt.pageOrigin ?? attempt.account.origin) === pageOrigin;
  // The worker's view of the page holds only while the tab still shows its path.
  const shown = live?.document.origin === pageOrigin && live.path === path ? live : undefined;
  const pageState = shown && {
    ...(shown.state ? { state: shown.state } : {}),
    ...(shown.reason ? { reason: shown.reason } : {}),
    ...(shown.notStarted ? { notStarted: shown.notStarted } : {}),
    ...(shown.generationSkip ? { generationSkip: shown.generationSkip } : {}),
  };
  return {
    ok: true,
    origin: pageOrigin,
    recipe: paths.includes(path) ? "page" : paths.length ? "other-paths" : "none",
    ...(rt.badge.asking(tabId) ? { asking: true as const } : {}),
    ...(pageState ? { page: clipCodes(pageState) } : {}),
    ...(known?.login
      ? {
          login: {
            ...clipCodes({
              state: known.login.state,
              outcome: known.login.outcome,
              cause: known.login.cause,
            }),
            ...(known.login.unconfirmed ? { unconfirmed: true as const } : {}),
            ...(known.login.fillOnly ? { fillOnly: true as const } : {}),
            ...(settled ? { settled: true as const } : {}),
          },
        }
      : {}),
    ...(known?.refused ? { refused: clipCodes(known.refused) } : {}),
    ...(pausedTill === undefined ? {} : { pause: { until: pausedTill } }),
    ...(known?.generation ? { generation: clipCodes(known.generation) } : {}),
    ...usedAndSwitch(rt, tabId, pageOrigin),
  };
}

/**
 * Restarts the refused document's login with the picked account: the document announces
 * again and a new attempt starts from the recipe's first step, if that step still shows.
 */
export async function pickFor(
  rt: Runtime,
  request: v.InferOutput<typeof pickRequestSchema>,
): Promise<PickResponse> {
  const offered = await choiceFor(rt, request.tabId);
  const waiting = rt.pending.get(request.tabId);
  if (!offered.ok || !waiting || offered.documentId !== request.documentId)
    return { ok: false, reason: "no-choice" };
  if (
    !offered.candidates.some(
      (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
    )
  )
    return { ok: false, reason: "not-a-candidate" };
  // The pick would be refused as the page announces; the choice stays for a later pick.
  if (offered.held) return { ok: false, reason: "origin-busy" };
  const pick: PickedAccount = {
    tabId: request.tabId,
    origin: waiting.document.origin,
    documentId: waiting.document.documentId,
    connectionId: request.connectionId,
    itemId: request.itemId,
    makeDefault: request.makeDefault,
    waitedMs: Math.max(0, Date.now() - waiting.at),
  };
  rt.picked.set(request.tabId, pick);
  clearChoice(rt, request.tabId);
  let gone = false;
  try {
    await saveSession(rt);
    // The document answers once its new announce is handled, started or refused.
    await browser.tabs.sendMessage(
      request.tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: waiting.document.frameId, documentId: waiting.document.documentId },
    );
    // Another announcement of the document may have overtaken this one and take the pick.
    await rt.admitting.get(`${request.tabId}:${waiting.document.frameId}`)?.catch(() => undefined);
  } catch {
    gone = true;
  }
  if (pick.attemptId !== undefined) return { ok: true };
  // A pick that started nothing is dropped; the form's next appearance asks again.
  if (rt.picked.get(request.tabId) === pick) {
    rt.picked.delete(request.tabId);
    await quietly(rt, () => saveSession(rt));
  }
  // Nothing answers the document's passkey request then, unless its choice is offered
  // again soon, as when the document announces again (ADR 0034).
  for (const parked of rt.parkedRequests)
    if (parked.tabId === request.tabId && parked.documentId === waiting.document.documentId)
      parked.dropped = Date.now();
  if (gone) return { ok: false, reason: "document-gone" };
  // Another tab's login started holding the site after the choice was offered. The page
  // does not announce again once that hold ends, so its choice waits for a later pick.
  const live = rt.documents.get(frameKey(waiting.document));
  if (
    live?.reason === "origin-busy" &&
    live.document.documentId === waiting.document.documentId &&
    !rt.pending.has(request.tabId)
  ) {
    offerChoice(rt, waiting.document, waiting.candidates, waiting.ask, waiting.paused);
    return { ok: false, reason: "origin-busy" };
  }
  // On a paused site an item without a password is not handed on to its passkey; the
  // page's own passkey button signs in with it through the chooser window (ADR 0062).
  if (
    waiting.paused &&
    live?.document.documentId === waiting.document.documentId &&
    live.reason === "no-route" &&
    live.refusal?.startsWith("password-empty") === true
  )
    return { ok: false, reason: "paused-no-password" };
  return { ok: false, reason: "not-started" };
}
