import {
  nextLoginOperation,
  passkeyAnswersRequest,
  routeSteps,
  validateLoginOperation,
  type LoginAttemptMetadata,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import type { ConditionalDecision } from "../../passkeys/runtime";
import { newId } from "@pateat/contracts/ids";
import { recordFor } from "./hold";
import { countSignIn } from "./relogin";
import { terminal, idle } from "./attempt-state";
import { type LiveDocument, type ParkedRequest, type Execution } from "./types";
import { frameKey } from "./steps";
import {
  PASSKEY_SIGNED_IN,
  PASSKEY_SIGN_IN_MS,
  REQUEST_START_WAIT_MS,
  REQUEST_PARK_MS,
  REQUEST_WAIT_MS,
} from "./constants";
import { passkeyMoveFits, quietMove, passwordMoveFits, moveUsername, judgeMove } from "./moves";
import { pauseOf } from "./pause";
import { asksEveryTime } from "./entry-press";
import { startsFor } from "./generation-scope";
import { askFor } from "./choice";
import { choiceWaits } from "./choice-save";
import { change, current } from "./attempt";
import { allowed } from "./plan-2";
import { reconcileBounded } from "./sign-in";
import { type RouteChange } from "./report";
import { planFor } from "./plan";
import type { Runtime } from "./state";

/**
 * Whether a passkey request naming its credentials in this tab is a re-verification while
 * signed in (ADR 0035): the tab's Pateat login of the origin signed in, and its first step
 * did not show again since, which forgets the record as a logout (ADR 0062). A login made
 * in another tab or before a browser restart is not known here.
 */
export async function passkeyReverification(
  rt: Runtime,
  tabId: number,
  siteOrigin: string,
): Promise<boolean> {
  await rt.vars.loaded;
  const metadata = recordFor(rt, tabId, siteOrigin);
  return metadata?.state === "authenticated" && !metadata.fillOnly;
}

/** The passkey bridge saw a request of this tab's top document (ADR 0029: S5). */
export function passkeyRequested(rt: Runtime, tabId: number, siteOrigin: string): void {
  rt.passkeyRequests.set(`${tabId} ${siteOrigin}`, Date.now());
}

/**
 * The passkey bridge returned an assertion for `rpId`, signed with `item`, to a page of
 * this tab (ADR 0022).
 */
export function passkeyAnswered(
  rt: Runtime,
  tabId: number,
  siteOrigin: string,
  rpId: string,
  item?: { connectionId: string; itemId: string },
  facts?: { silent?: true; incognito: boolean; documentId?: string },
): void {
  // A sign-in Pateat answered by itself outside a login counts as a relogin, so a page
  // that asks for a passkey on load after each logout cannot loop (ADR 0062).
  if (facts?.silent)
    void rt.vars.sessionLoaded.then(() => countSignIn(rt, siteOrigin, facts.incognito));
  // A running login's answer is that login's step, which it follows itself (ADR 0034).
  const running = recordFor(rt, tabId, siteOrigin);
  const outside = !running || terminal(running) || idle(running);
  rt.passkeyAnswers.set(`${tabId} ${siteOrigin}`, {
    at: Date.now(),
    rpId,
    ...(item ? { item: { connectionId: item.connectionId, itemId: item.itemId } } : {}),
    ...(outside && facts?.documentId !== undefined ? { signedIn: facts.documentId } : {}),
  });
}

/**
 * Asks a page refused as signed in by a passkey to announce again once that answer's
 * window ends, so a page whose sign-in form still shows then logs in (ADR 0034 rule 6).
 */
export function retryAfterPasskey(rt: Runtime, live: LiveDocument, answeredAt: number): void {
  setTimeout(
    () => {
      if (
        rt.documents.get(frameKey(live.document)) !== live ||
        live.state !== "denied" ||
        live.reason !== PASSKEY_SIGNED_IN
      )
        return;
      void browser.tabs
        .sendMessage(
          live.document.tabId,
          { version: 1, type: "login.reconnect" },
          { frameId: live.document.frameId, documentId: live.document.documentId },
        )
        .catch(() => undefined);
    },
    Math.max(0, answeredAt + PASSKEY_SIGN_IN_MS - Date.now()),
  );
}

/**
 * Whether a top-level attempt's tab moving to `live`, a top page of another origin, ended
 * its sign-in (ADR 0022): after its last effect step, and shortly before the move, Pateat
 * answered the attempt's page's passkey request; the new page's host is the passkey's RP
 * ID or a subdomain of it; and that page is quiet (`quietMove`). Only reads.
 */
export async function signedInByPasskey(
  rt: Runtime,
  record: LoginAttemptMetadata,
  live: LiveDocument,
): Promise<boolean> {
  delete live.moveMiss;
  const answer = passkeyMoveFits(rt, record, live.document.tabId, live.document.origin);
  if (!answer || live.document.frameId !== 0 || live.topUrl !== undefined) {
    live.moveMiss = "no-factor";
    return false;
  }
  return quietMove(rt, live, answer.at);
}

/**
 * Whether a top-level `password` attempt's tab moving to `live`, a top page of another
 * origin of the same site, or of any site after a second factor, ended its sign-in (ADR
 * 0022): the attempt's last effect step or second factor ran shortly before the move
 * (`passwordMoveFits`), and that page is quiet and shows the account's username
 * in its header or navigation (`quietMove`, ADR 0029: E2), or, quiet without it, shows a
 * signed-in marker learned on its origin or is judged `signed-in` once (`judgeMove`). A
 * login that stops before its item's missing password skips the username (ADR 0036).
 * Pateat fills and clicks nothing there.
 */
export async function signedInByPassword(
  rt: Runtime,
  record: LoginAttemptMetadata,
  live: LiveDocument,
): Promise<boolean> {
  delete live.moveMiss;
  if (live.document.frameId !== 0 || live.topUrl !== undefined) {
    live.moveMiss = "no-factor";
    return false;
  }
  const stillLive = () => rt.documents.get(frameKey(live.document)) === live;
  // The same document announcing again while its page is judged waits for that verdict.
  const judging = rt.moveJudgements.get(record.id);
  if (judging?.documentId === live.document.documentId)
    return (await judging.verdict) && stillLive();
  const effect = passwordMoveFits(rt, record, live.document.tabId, live.document.origin);
  if (!effect) {
    live.moveMiss = "no-factor";
    return false;
  }
  const username = await moveUsername(rt, record);
  if (!stillLive()) return false;
  if (!username) {
    live.moveMiss = "no-username";
    return false;
  }
  // A login that stops before its item's missing password is not signed in by the
  // username in the header or navigation (ADR 0036): a quiet page is judged.
  const reading =
    record.stopAt === undefined
      ? await quietMove(rt, live, effect.at, username, true)
      : (await quietMove(rt, live, effect.at)) && ("unproven" as const);
  if (reading !== "unproven" || !stillLive()) return reading === "signed-in";
  const verdict = judgeMove(rt, record, live, username, effect.at);
  rt.moveJudgements.set(record.id, { documentId: live.document.documentId, verdict });
  try {
    return (await verdict) && stillLive();
  } finally {
    if (rt.moveJudgements.get(record.id)?.verdict === verdict) rt.moveJudgements.delete(record.id);
  }
}

/**
 * Has a top document that `awaitsPageRequest` announce again once its own conditional
 * request waits and its repair is over, so its new login answers that request. The new
 * announcement clears the mark, so each refusal restarts at most once (ADR 0034
 * amendment of 2026-10-25).
 */
export function restartForRequest(rt: Runtime, live: LiveDocument): void {
  const { tabId, documentId } = live.document;
  const parked = parkedFor(rt, live.document);
  if (
    !parked ||
    !live.awaitsPageRequest ||
    live.state !== "denied" ||
    rt.documents.get(frameKey(live.document)) !== live ||
    rt.attempts.get(tabId)?.live.document.documentId === documentId
  )
    return;
  delete live.awaitsPageRequest;
  parked.restarted = Date.now();
  void browser.tabs
    .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId: 0, documentId })
    .catch(() => undefined);
}

/** The top document of a request, while it `awaitsPageRequest` (ADR 0034). */
export function awaitingDocument(rt: Runtime, parked: ParkedRequest): LiveDocument | undefined {
  const live = rt.documents.get(frameKey({ tabId: parked.tabId, frameId: 0 }));
  return live?.document.documentId === parked.documentId && live.awaitsPageRequest
    ? live
    : undefined;
}

/** The newest conditional request of a top document still waiting (ADR 0034). */
export function parkedFor(
  rt: Runtime,
  document: { tabId: number; documentId: string },
): ParkedRequest | undefined {
  let found: ParkedRequest | undefined;
  for (const parked of rt.parkedRequests)
    if (parked.tabId === document.tabId && parked.documentId === document.documentId)
      found = parked;
  return found;
}

/**
 * A top document's own `conditional` passkey request (ADR 0034). It waits for the login
 * of its document: that login's `passkey` route answers it; once the login ends, it is
 * withheld if the login signed in and handed on otherwise. While the tab asks for an
 * account (ADR 0021 D, ADR 0062), or offers its document a popup choice in which an item
 * holds a discoverable passkey, the login the pick starts answers it. A request of an origin
 * without a recipe is handed on at once, and one whose document starts no login within
 * `REQUEST_START_WAIT_MS` then.
 */
export async function conditionalRequest(
  rt: Runtime,
  input: {
    tabId: number;
    origin: string;
    documentId: string;
    signal: AbortSignal;
    /** Whether the tab is incognito, as the request's sender says (ADR 0062). */
    incognito?: boolean;
  },
): Promise<ConditionalDecision> {
  await rt.vars.loaded;
  await rt.vars.sessionLoaded;
  // A paused site's own request goes to the browser at once (ADR 0062).
  const incognito =
    input.incognito ?? (await browser.tabs.get(input.tabId).catch(() => undefined))?.incognito;
  const pausedPage = async () =>
    (await pauseOf(rt, { url: input.origin, incognito })) !== undefined;
  if (await pausedPage()) return { kind: "delegate", reason: "paused" };
  const run = rt.attempts.get(input.tabId);
  // A site that asks every time logs in only by a pick, whose own login answers the
  // request of its document; any other goes to the browser (ADR 0063).
  if (
    run?.live.document.documentId !== input.documentId &&
    (await asksEveryTime(rt, input.origin, incognito === true))
  )
    return { kind: "delegate", reason: "one-time-pick" };
  if (run?.live.document.documentId !== input.documentId) {
    const starts = await startsFor(rt, input.origin).catch(() => []);
    if (!starts.length) return { kind: "delegate", reason: "no-recipe" };
  }
  if (input.signal.aborted) return { kind: "delegate", reason: "cancelled" };
  return new Promise<ConditionalDecision>((resolve) => {
    const onAbort = () => parked.settle({ kind: "delegate", reason: "cancelled" });
    const parked: ParkedRequest = {
      tabId: input.tabId,
      origin: input.origin,
      documentId: input.documentId,
      ...(incognito === undefined ? {} : { incognito }),
      since: Date.now(),
      settle(decision) {
        if (!rt.parkedRequests.delete(parked)) return false;
        input.signal.removeEventListener("abort", onAbort);
        resolve(decision);
        return true;
      },
    };
    rt.parkedRequests.add(parked);
    input.signal.addEventListener("abort", onAbort, { once: true });
    reviewRequests(rt);
    // A document refused for want of the passkey route starts its login again for it.
    const awaiting = awaitingDocument(rt, parked);
    if (awaiting) restartForRequest(rt, awaiting);
    // A pause that started while the request was looked at hands it on as well.
    void pausedPage().then((now) => {
      if (now) parked.settle({ kind: "delegate", reason: "paused" });
      return undefined;
    });
  });
}

/**
 * Whether the tab asks the request's document for an account (ADR 0021 D, ADR 0062): its
 * choice waits in the popup, or the pick of a document asked so has not started a login
 * yet.
 */
export function askedFor(rt: Runtime, parked: ParkedRequest): boolean {
  const waiting = rt.pending.get(parked.tabId);
  const pick = rt.picked.get(parked.tabId);
  return (
    (waiting?.ask !== undefined &&
      waiting.document.frameId === 0 &&
      waiting.document.documentId === parked.documentId) ||
    (parked.asked === true &&
      pick !== undefined &&
      pick.attemptId === undefined &&
      pick.origin === parked.origin &&
      pick.documentId === parked.documentId)
  );
}

/**
 * Whether a tab still asks for an account of the origin after a rejection or a stopped
 * login (ADR 0021 D).
 */
export function stillAsks(rt: Runtime, tabId: number, siteOrigin: string): boolean {
  return !recordFor(rt, tabId, siteOrigin) && askFor(rt, tabId, siteOrigin) !== undefined;
}

/**
 * Decides every waiting conditional request whose login ended or never started, and
 * checks again each second while one waits (ADR 0034). The `passkey` route answers its
 * own page's request itself. A request whose document the tab asks for an account (ADR
 * 0021 D, ADR 0062), or fills only, waits for the login the pick starts; so does one whose
 * document is offered a popup choice in which an item holds a passkey, for up to four
 * minutes.
 */
export function reviewRequests(rt: Runtime): void {
  const now = Date.now();
  for (const parked of [...rt.parkedRequests]) {
    const run = rt.attempts.get(parked.tabId);
    const own =
      run &&
      run.live.document.frameId === 0 &&
      run.live.document.documentId === parked.documentId &&
      run.metadata.account.origin === parked.origin
        ? run.metadata
        : undefined;
    const ended = own && (terminal(own) || idle(own));
    const running = own !== undefined && !ended;
    if (running) parked.during = true;
    const offered = !running && askedFor(rt, parked);
    if (offered) delete parked.dropped;
    if (running ? own.fillOnly : offered) parked.asked = true;
    // A choice still offered decides alone: another tab's login can end the rejection this
    // tab asks for, while its choice stays. A dropped pick leaves it a moment to be
    // offered again. A login that only fills while the tab asks waits as the ask does.
    const asks = running
      ? own.fillOnly === true
      : offered ||
        (parked.asked === true &&
          stillAsks(rt, parked.tabId, parked.origin) &&
          (parked.dropped === undefined || now - parked.dropped < REQUEST_START_WAIT_MS));
    // A popup choice outside an ask keeps the request while it offers an item with a
    // passkey, or while that is being checked. Once the choice goes, the request waits a
    // moment for it to be offered again. A login of its document, once seen, decides.
    const free = !parked.during && !asks;
    const choice = free ? choiceWaits(rt, parked) : "none";
    if (choice === "waits") {
      parked.picking = true;
      delete parked.dropped;
    } else if (free && parked.picking && parked.dropped === undefined) parked.dropped = now;
    const choosing =
      free &&
      (choice !== "none" ||
        (parked.picking === true &&
          parked.dropped !== undefined &&
          now - parked.dropped < REQUEST_START_WAIT_MS));
    if (asks) {
      if (now - parked.since >= REQUEST_PARK_MS) parked.settle({ kind: "withhold" });
    } else if (choosing) {
      // Handed on, not withheld: the browser ends the message that carries it after five
      // minutes, so there is time to.
      if (now - parked.since >= REQUEST_PARK_MS)
        parked.settle({ kind: "delegate", reason: "no-pick" });
    } else if (!own || (ended && !parked.during)) {
      // A login of another document, or one that ended before the request came, does
      // not decide it. A document repaired for want of the passkey route keeps it until
      // the repair is over (ADR 0034 amendment of 2026-10-25).
      const repairing = !own && awaitingDocument(rt, parked)?.repairing === true;
      if (repairing) parked.restarted = now;
      if (
        repairing
          ? now - parked.since >= REQUEST_PARK_MS
          : now - Math.max(parked.since, parked.restarted ?? 0) >= REQUEST_START_WAIT_MS
      )
        parked.settle({ kind: "delegate", reason: own ? "login-ended" : "no-login" });
    } else if (own.state === "authenticated") parked.settle({ kind: "withhold" });
    else if (ended) parked.settle({ kind: "delegate", reason: "login-ended" });
    else if (now - parked.since >= REQUEST_PARK_MS) parked.settle({ kind: "withhold" });
  }
  if (rt.parkedRequests.size && rt.vars.reviewTimer === undefined)
    rt.vars.reviewTimer = setInterval(() => reviewRequests(rt), 1000);
  else if (!rt.parkedRequests.size && rt.vars.reviewTimer !== undefined) {
    clearInterval(rt.vars.reviewTimer);
    rt.vars.reviewTimer = undefined;
  }
}

/**
 * Whether a login takes the `passkey` route because its page asked for a passkey by
 * itself (ADR 0034): only before anything was submitted, so a chooser login only before
 * its click on the list, on a recipe without a passkey
 * button, for an item that held a discoverable passkey when the login started. Fields
 * already filled stay as they are.
 */
export async function switchToPasskey(rt: Runtime, run: Execution): Promise<boolean> {
  const { metadata } = run;
  if (
    metadata.route !== "password" ||
    !passkeyAnswersRequest(run.recipe) ||
    run.passkeyFailed ||
    metadata.fillOnly ||
    !metadata.facts.discoverablePasskey ||
    metadata.submissions > 0 ||
    metadata.handlers.length > 0 ||
    metadata.operationId !== undefined ||
    !parkedFor(rt, run.live.document)
  )
    return false;
  await change(
    rt,
    run,
    {
      type: "ROUTE",
      route: "passkey",
      steps: routeSteps(run.recipe, { route: "passkey" }).length,
    },
    undefined,
    undefined,
    "page-request",
  );
  return current(rt, run) && run.metadata.route === "passkey";
}

/**
 * The `passkey` route's one step on a recipe without a passkey button (ADR 0034): the
 * page's own conditional request is answered with the login's item. The answer counts as
 * a submission, recorded before it goes out. Without a request, or when the item cannot
 * answer it, the login falls back to its password variant.
 */
export async function answerRequest(rt: Runtime, run: Execution): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let parked = parkedFor(rt, run.live.document);
  // A page may cancel its request and ask again, as when its form renders once more.
  for (const until = Date.now() + REQUEST_WAIT_MS; !parked && Date.now() < until;) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
    if (!current(rt, run) || run.metadata.state !== "ready") return;
    parked = parkedFor(rt, run.live.document);
  }
  if (!parked) {
    await fallBack(rt, run, "request-missing");
    return;
  }
  if (!(await allowed(rt, run))) return;
  const operation = nextLoginOperation(run.metadata, run.recipe, run.live.document, newId());
  if (!operation) {
    await change(
      rt,
      run,
      { type: "FAILED", reason: "structural-mismatch" },
      undefined,
      "no-operation",
    );
    return;
  }
  run.operation = operation;
  run.delivered = false;
  await change(rt, run, {
    type: "PREPARE",
    operationId: operation.operationId,
    kind: "click",
    effect: "submit",
  });
  await change(rt, run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
  if (!current(rt, run) || run.metadata.state !== "submit-intent") return;
  const authorized = await allowed(rt, run);
  if (!authorized) return;
  if (
    !validateLoginOperation(operation, run.metadata, run.live.document, run.metadata.policyRevision)
  ) {
    await change(rt, run, { type: "FAILED", reason: "timeout" }, undefined, "operation-invalid");
    return;
  }
  const { tabId } = run.live.document;
  run.delivered = true;
  const deliveredAt = Date.now();
  rt.effects.set(tabId, {
    attemptId: run.metadata.id,
    at: deliveredAt,
    document: run.live.document,
    submits: false,
    passkey: true,
    request: true,
    requestAt: deliveredAt,
  });
  const item = {
    connectionId: run.metadata.account.connectionId,
    itemId: run.metadata.account.itemId,
  };
  const target = parked;
  // The bridge says whether the assertion went back; a request that went away meanwhile
  // was never answered.
  let gone = false;
  const signed = await new Promise<boolean>((resolve) => {
    gone = !target.settle({ kind: "answer", item, answered: resolve });
    if (gone) resolve(false);
  });
  delete run.operation;
  if (!current(rt, run) || run.metadata.state !== "submit-intent") return;
  if (signed) {
    run.answeredAt = Date.now();
    await change(rt, run, { type: "SUBMITTED", operationId: operation.operationId });
    // A WebAuthn exchange is observed with the usual budget, held while the form shows.
    await reconcileBounded(rt, run);
    return;
  }
  run.passkeyFailed = true;
  await change(
    rt,
    run,
    {
      type: "FAILED",
      reason: "timeout",
      mutation: "none",
      operationId: operation.operationId,
      document: run.live.document,
    },
    undefined,
    gone ? undefined : "answer-failed",
  );
  // A request that went away before the answer was never answered.
  await fallBack(rt, run, gone ? "request-missing" : "answer-failed");
}

/**
 * When the passkey bridge last returned an assertion to the login's page since its last
 * effect step (ADR 0027), if it did: a request that showed a prompt, answered with the
 * login's item.
 */
export function bridgeAnswer(rt: Runtime, run: Execution): number | undefined {
  const { tabId, origin: pageOrigin } = run.live.document;
  const answer = rt.passkeyAnswers.get(`${tabId} ${pageOrigin}`);
  const effect = rt.effects.get(tabId);
  return answer && effect?.attemptId === run.metadata.id && answer.at >= effect.at
    ? answer.at
    : undefined;
}

/**
 * The `passkey` route that answers its page's own request goes back to the password
 * variant the login recorded (ADR 0034), or ends `challenge` without one or with a stop
 * before the item's missing password (ADR 0036). It never answers again.
 */
export async function fallBack(
  rt: Runtime,
  run: Execution,
  cause: Exclude<RouteChange, "page-request">,
): Promise<void> {
  if (!current(rt, run) || terminal(run.metadata)) return;
  run.passkeyFailed = true;
  const { variant } = run.metadata;
  const steps =
    variant === undefined ? 0 : routeSteps(run.recipe, { route: "password", variant }).length;
  // A login whose item lacks a password never goes back to its variant's stop (ADR 0036).
  if (variant === undefined || !steps || run.metadata.stopAt !== undefined) {
    await change(rt, run, { type: "OBSERVED", result: "challenge", document: run.live.document });
    return;
  }
  await change(rt, run, { type: "ROUTE", route: "password", steps }, undefined, undefined, cause);
  if (!current(rt, run) || run.metadata.route !== "password") return;
  // The account choice saved after the sign-in names the password variant's binding, also
  // when only that binding is unsaved or widened (ADR 0027, amended 2026-10-19), as for a
  // saved default whose passkey plan saved nothing. A pick for this login only stays
  // unsaved, since the plan still sees the pick.
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!current(rt, run) || !snapshot.ok) return;
  const plan = await planFor(rt, snapshot, run.live, run.recipe, {
    route: { route: "password", variant },
  });
  if (
    current(rt, run) &&
    plan.ok &&
    plan.choice &&
    plan.account.connectionId === run.metadata.account.connectionId &&
    plan.account.itemId === run.metadata.account.itemId
  )
    run.choice = plan.choice;
}
