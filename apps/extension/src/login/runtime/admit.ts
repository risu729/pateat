import {
  finishedLogin,
  recoverLoginAttempt,
  sameLoginDocument,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  type LoginDocument,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { observedPath } from "../../observation/path";
import { keep } from "./session-store";
import { frameKey, documentKey } from "./steps";
import { checkAfterPress } from "./entry-press";
import { AFTER_SIGN_IN_MS, SITE_MOVE_MS, WATCH_MS } from "./constants";
import { pauseOf, endPickedPause } from "./pause";
import { identify } from "./messages";
import { send, reportAttempt, publish, report, noteSignedIn } from "./attempt";
import { clearChoice } from "./choice";
import {
  type Sender,
  type Shown,
  type ListOffer,
  type Announced,
  type Unoffered,
  type Readiness,
  type LiveDocument,
  type ConfirmVisit,
  type Execution,
} from "./types";
import { leaveConfirm, previousPage } from "./markers";
import { noteNotStarted } from "./not-started";
import { noteUnadmitted, note, loginRelated } from "./generation";
import { tabAttempt, recordFor } from "./hold";
import { terminal, siteWaitOver, watchOver } from "./attempt-state";
import { dropReprompt } from "./master-password";
import { type MoveMiss } from "./report";
import { countRelogin, signedInNow } from "./relogin";
import { remember } from "./choice-save";
import {
  credentialMoveFits,
  stepMoveFits,
  passkeyPageFits,
  stillAsking,
  holdForPasskey,
  requestMoveFits,
  frameMoveFits,
  framePresent,
} from "./moves";
import { signedInAfterFrame, signedInByMove } from "./passkey";
import type { Runtime } from "./state";
import { cancelConfirm, hasConfirmAuthentication } from "./confirm-state";
import { admitConfirm } from "./confirm-admit";
import { admitRecord } from "./admit-record";
import type { AdmitContext } from "./admit-context";
import { manualAuthorizationCurrent } from "./manual-scope";

export async function admit(
  rt: Runtime,
  sender: Sender,
  token: string,
  helloKey: string,
  sequence: number,
  start?: { path: string },
  signIn?: { path: string; identifier?: true | undefined; passkey?: true | undefined },
  shown?: Shown,
  list?: ListOffer,
  entryHello?: Announced,
  unoffered?: Unoffered,
  switchedInPlace?: true,
): Promise<Readiness> {
  const receivedAt = Date.now();
  const requestedManual =
    sender.tab?.id === undefined ? undefined : rt.manualStarts.get(sender.tab.id);
  const manual =
    requestedManual?.pick &&
    requestedManual.document.frameId === sender.frameId &&
    requestedManual.document.documentId === sender.documentId
      ? { request: requestedManual, pick: requestedManual.pick }
      : undefined;

  await rt.vars.loaded;

  await rt.vars.sessionLoaded;

  await rt.confirmFill.loaded;

  const document = await identify(rt, sender);

  if (!document || !sender.url) {
    if (sender.frameId === 0 && sender.tab?.id !== undefined) {
      // A page Pateat does not fill was left for a page it does not read, which is also
      // the tab's previous page for the next one it reads (ADR 0035).
      const visit = rt.confirmVisits.get(sender.tab.id);
      if (visit && visit.document.documentId !== sender.documentId) leaveConfirm(rt, visit);
      const top = rt.documents.get(frameKey({ tabId: sender.tab.id, frameId: 0 }));
      if (top && top.document.documentId !== sender.documentId) top.leftUnread = true;
    }
    await noteUnadmitted(rt, sender);
    return { ok: false, reason: "unauthorized-document" };
  }

  if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };

  const key = frameKey(document);

  // The tab's next page of the origin after a submitted sign-in form (ADR 0028).
  const submitted = rt.signInSubmits.get(document.tabId);

  if (submitted && document.frameId === 0 && submitted.documentId !== document.documentId) {
    // Only the tab's next page counts: one of another origin ends the skip.
    rt.signInSubmits.delete(document.tabId);
    // A clock that went back keeps the skip: sending the page is the less safe outcome.
    if (submitted.origin === document.origin && Date.now() - submitted.at < AFTER_SIGN_IN_MS)
      rt.afterSignIn.set(document.tabId, document.documentId);
  }

  // A new page in the tab replaces the document that waited for a choice.
  const waiting = rt.pending.get(document.tabId);

  if (
    waiting?.document.frameId === 0 &&
    document.frameId === 0 &&
    waiting.document.documentId !== document.documentId
  )
    clearChoice(rt, document.tabId);

  // `sender.url` keeps the URL the document loaded with; a same-document URL change
  // (history.pushState) of the tab's page shows only in the tab's committed URL. A frame
  // inside the page keeps its load URL and records the tab's URL to match as well.
  let url = sender.url;

  let topUrl: string | undefined;

  // The sender's tab says whether its window is incognito; `tabs.get` is asked otherwise.
  let incognito = sender.tab?.incognito;

  try {
    const tab = await browser.tabs.get(document.tabId);
    incognito ??= tab.incognito;
    if (document.frameId !== 0) {
      // A frame's page is a web page; any other URL means the tab moved on.
      if (!tab.url || !/^https?:$/.test(new URL(tab.url).protocol))
        return { ok: false, reason: "stale-document" };
      topUrl = tab.url;
    } else if (tab.url && new URL(tab.url).origin === document.origin) url = tab.url;
  } catch {
    return { ok: false, reason: "closed-tab" };
  }

  if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };

  // Re-announcing the same document must not replace a confirmation's identity while
  // extraction, a vault read or a delivery is in flight. Other frames gain no authority.
  const confirming = rt.confirmFill.work.get(document.tabId);
  if (confirming) {
    const same = sameLoginDocument(confirming.live.document, document);
    if (
      same &&
      confirming.live.url === url &&
      confirming.live.topUrl === topUrl &&
      confirming.live.token === token
    ) {
      const visit = rt.confirmVisits.get(document.tabId);
      if (
        !confirming.generation &&
        visit &&
        sameLoginDocument(visit.document, document) &&
        visit.path === confirming.live.path
      )
        noteNotStarted(rt, confirming.live, shown, "confirm-fill", confirming.recipe, visit);
      return {
        ok: false,
        reason: confirming.generation ? "generating" : "confirm-fill",
        ...(visit?.document.documentId === document.documentId ? { confirm: visit.first } : {}),
      };
    }
    if (
      same ||
      document.frameId === confirming.live.document.frameId ||
      (document.frameId === 0 &&
        (confirming.topDocumentId !== document.documentId ||
          (confirming.live.topUrl ?? confirming.live.url) !== url))
    ) {
      cancelConfirm(rt, document.tabId);
      await send(rt, confirming.live, { type: "login.cancel" }).catch(() => undefined);
      if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    } else return { ok: false, reason: "tab-busy" };
  }

  // A tab runs one attempt. Another frame of the tab, such as an embedded widget or the
  // page around a framed login, never takes it over or disturbs it. Only a new page in
  // the tab (another top document) ends an attempt held by a frame of the old page.
  let owner = tabAttempt(rt, document.tabId);

  const page = rt.documents.get(frameKey({ tabId: document.tabId, frameId: 0 }));

  let newPage =
    document.frameId === 0 &&
    page !== undefined &&
    page.document.documentId !== document.documentId;

  // A `password` login in a frame whose page this page replaced right after its step or
  // during its watch: this page is read for its result before the login ends (ADR 0086).
  // The move is kept in `rt.leftFrames` until a hello of the top page ends the login, so
  // the page announcing again, or a hello that went stale, still reads it.
  let frameMoved: LoginAttemptMetadata | undefined;

  if (newPage) {
    // Frames of this page may have announced before it did. Only documents that no
    // longer answer went away with the old page.
    // A frame that does not answer in time counts as still there.
    const frames = [...rt.documents].filter(
      ([, entry]) => entry.document.tabId === document.tabId && entry.document.frameId !== 0,
    );
    const answers = await Promise.all(
      frames.map(([, entry]) =>
        Promise.race([
          send(rt, entry, { type: "login.observe", path: entry.path, targets: [] }).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => setTimeout(resolve, 1000, true)),
        ]),
      ),
    );
    for (const [index, [other]] of frames.entries())
      if (!answers[index]) {
        rt.documents.delete(other);
        // A choice that waited in a frame of the old page ends with it, badge and all.
        const framed = rt.pending.get(document.tabId);
        if (framed && frameKey(framed.document) === other) clearChoice(rt, document.tabId);
      }
    if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    owner = tabAttempt(rt, document.tabId);
    const holder = owner && rt.documents.get(frameKey(owner.document));
    if (owner && owner.document.frameId !== 0) {
      if (holder && sameLoginDocument(holder.document, owner.document)) {
        // The frame holding the attempt is still there, so this page is its parent.
        newPage = false;
      } else if (!terminal(owner) && frameMoveFits(rt, owner, document.tabId)) {
        rt.leftFrames.set(document.tabId, owner.id);
      } else if (!terminal(owner)) {
        // The frame's page is gone: its attempt ends without resubmitting, whatever
        // origin the new page has.
        const run = rt.attempts.get(document.tabId);
        const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(owner), {
          type: "NAVIGATED",
          document,
        });
        if (run) run.metadata = ended;
        reportAttempt(rt, ended, run?.recipe);
        try {
          await keep(rt, ended);
        } catch {
          return { ok: false, reason: "storage-unavailable" };
        }
        if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
        owner = ended;
      }
    }
  }

  // A top page announcing while the tab's framed login has no document of its frame, as
  // after a worker restart, asks the frame whether it is still there when the login may
  // end on this page (`frameMoveFits`, as during its watch).
  if (
    document.frameId === 0 &&
    owner &&
    owner.document.frameId !== 0 &&
    !terminal(owner) &&
    rt.leftFrames.get(document.tabId) !== owner.id &&
    !rt.documents.has(frameKey(owner.document)) &&
    frameMoveFits(rt, owner, document.tabId)
  ) {
    const recorded = owner;
    const present = await framePresent(document.tabId, recorded.document.frameId);
    if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    owner = tabAttempt(rt, document.tabId);
    if (!present && owner?.id === recorded.id && !rt.documents.has(frameKey(owner.document)))
      rt.leftFrames.set(document.tabId, owner.id);
  }

  // The top page of a tab whose framed login's frame went away, with the new page above
  // or after the tab's URL changed in place (`frameLeftInPlace`), is read for that
  // login's result. A login that ended, or whose frame announced again, keeps no move.
  if (
    document.frameId === 0 &&
    owner &&
    owner.document.frameId !== 0 &&
    rt.leftFrames.get(document.tabId) === owner.id
  ) {
    const frame = rt.documents.get(frameKey(owner.document));
    if (terminal(owner) || (frame && sameLoginDocument(frame.document, owner.document)))
      rt.leftFrames.delete(document.tabId);
    else frameMoved = owner;
  }

  // The site the tab shows now. A login on another site's page, in the page or in one of
  // its frames, is a login of a site the tab left: it never holds a document of this
  // site, and a top-level one still running ends below.
  const siteOrigin = topUrl ? new URL(topUrl).origin : document.origin;

  const leftSite = (record: LoginAttemptMetadata) => {
    const site = record.document.frameId === 0 ? record.account.origin : record.pageOrigin;
    return site !== undefined && site !== siteOrigin;
  };

  // A busy document is still recorded, so a later new page in the tab is recognized.
  const busy =
    owner !== undefined &&
    !leftSite(owner) &&
    owner.document.frameId !== document.frameId &&
    !newPage &&
    !frameMoved;

  const oldLive = rt.documents.get(key);

  const sameDocument = oldLive !== undefined && sameLoginDocument(oldLive.document, document);

  // A document may announce again when its form appears or its URL changes in place,
  // but never while it already carries an attempt, unless that login finished and the
  // document now watches for its first step again (ADR 0062), the login is watched and
  // its first step shows in the document (ADR 0027), or the login switched accounts and
  // the document, changed in place, announces itself as a new page (ADR 0078).
  const carried = rt.attempts.get(document.tabId);

  if (
    sameDocument &&
    (oldLive.token !== token ||
      (carried?.live === oldLive &&
        !(
          document.frameId === 0 &&
          (finishedLogin(carried.metadata) ||
            (switchedInPlace &&
              carried.metadata.state === "blocked" &&
              carried.metadata.outcome === "account-switched") ||
            (carried.metadata.watch !== undefined &&
              start?.path === observedPath(new URL(url).pathname) &&
              document.documentId !== carried.metadata.watch.documentId))
        )))
  ) {
    note(rt, document, url, "duplicate-document");
    return { ok: false, reason: "duplicate-document" };
  }

  if (oldLive && !sameDocument)
    await send(rt, oldLive, { type: "login.cancel" }).catch(() => undefined);

  const path = observedPath(new URL(url).pathname);

  const previousUrl = previousPage(rt, document, oldLive, sameDocument, path);

  // The document's time for its next login starts again (ADR 0019, owner 2026-11-03), from
  // when this announcement arrived: on a new document; once a locked vault can be read,
  // since unlocking comes before any login; when the document announces from another path
  // it moved to in place, as a single-page site's route to its sign-in; and when it shows a
  // sign-in again after a login it started, as after a sign-out in place, unless the popup
  // offers it a choice of account or the person picked one, as after a fill-only login,
  // whose next login counts from the login before it.
  const pick = rt.picked.get(document.tabId);
  const choosing =
    rt.pending.get(document.tabId)?.document.documentId === document.documentId ||
    (pick?.attemptId === undefined && pick?.documentId === document.documentId);
  const announcing = Boolean(start || signIn || entryHello || list);
  // A sign-in shown without a ready first step counts as showing it again too.
  const showsSignIn = announcing || Boolean(shown && (shown.miss || shown.later || shown.accounts));
  const restart =
    !sameDocument ||
    oldLive.reason === "vault-unavailable" ||
    oldLive.path !== path ||
    (oldLive.loginStarted === true && showsSignIn && !choosing);
  // What the document keeps of its current path: nothing once its time starts again.
  const keepsPath = sameDocument && oldLive.path === path && !restart;

  const live: LiveDocument = {
    document,
    token,
    url,
    path,
    ...(topUrl ? { topUrl } : {}),
    ...(incognito === undefined ? {} : { incognito }),
    ...(previousUrl ? { previousUrl } : {}),
    // A document announcing again on the same path logs each generation skip once.
    ...(sameDocument && oldLive.path === path && oldLive.generationSkip
      ? { generationSkip: oldLive.generationSkip }
      : {}),
    ...(sameDocument && oldLive.path === path && oldLive.notStarted
      ? { notStarted: oldLive.notStarted }
      : {}),
    seenAt: sameDocument ? oldLive.seenAt : Date.now(),
    // When it first announced a sign-in on this path, for the local log (ADR 0019).
    ...(announcing
      ? { shownAt: (keepsPath && oldLive.shownAt) || receivedAt }
      : keepsPath && oldLive.shownAt !== undefined
        ? { shownAt: oldLive.shownAt }
        : {}),
    // A new object, so time a request of the earlier one adds later stays with it.
    timing: restart
      ? { since: receivedAt, serviceMs: 0, networkMs: 0, personMs: 0 }
      : oldLive.timing,
    // Kept until the document shows a sign-in that starts the time again, so a sign-in it
    // shows later on a path it moved to after the login still does.
    ...(sameDocument && oldLive.loginStarted && !(restart && showsSignIn)
      ? { loginStarted: true as const }
      : {}),
    ...(sameDocument && oldLive.path === path && oldLive.entryRefusals
      ? { entryRefusals: oldLive.entryRefusals }
      : {}),
  };

  if (oldLive && !sameDocument)
    dropReprompt(rt, oldLive.document.tabId, oldLive.document.documentId);

  rt.documents.set(key, live);

  // The tab's next page after a page Pateat does not fill (ADR 0035).
  const earlier = rt.confirmVisits.get(document.tabId);

  if (
    earlier &&
    document.frameId === 0 &&
    (earlier.document.documentId !== document.documentId || earlier.path !== path)
  )
    leaveConfirm(rt, earlier, live);

  // Automatic login of the page's site is paused (ADR 0062): its own site's or, for a
  // frame, also its tab's. The tab's page shows the pause on the badge.
  const pauseState = await pauseOf(rt, live);

  const paused = pauseState !== undefined;

  if (document.frameId === 0) rt.badge.paused?.(document.tabId, pauseState);

  if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };

  // The first other document in the step's frame after an effect step (the tab's top
  // document for a top-level step, ADR 0086), when it comes soon enough to be the site's
  // answer to it (ADR 0029). One announced later, as after the person's own retry in a page
  // the login settled on, is never read as that answer.
  const effect = rt.effects.get(document.tabId);

  if (
    effect &&
    effect.next === undefined &&
    document.frameId === effect.document.frameId &&
    !sameLoginDocument(effect.document, document) &&
    Date.now() - effect.at <= SITE_MOVE_MS
  )
    effect.next = document.documentId;

  const ctx: AdmitContext = {
    document: document,
    received: { at: receivedAt, spentMs: live.timing.serviceMs + live.timing.personMs },
    key: key,
    incognito: incognito,
    siteOrigin: siteOrigin,
    live: live,
    paused: paused && !(manual && manualAuthorizationCurrent(rt, live, manual)),
    ...(manual ? { manual } : {}),
    refuse: undefined!,
    notStarted: undefined!,
    recorded: undefined!,
    askKey: undefined!,
    ask: undefined!,
    switched: undefined!,
    previous: undefined!,
    recipe: undefined!,
    layoutChoices: undefined!,
    layoutCount: undefined!,
    chooser: undefined!,
    shownOther: undefined!,
    later: undefined!,
    revised: undefined!,
    start: start,
    signIn: signIn,
    shown: shown,
    list: list,
    entryHello: entryHello,
    unoffered: unoffered,
  };

  ctx.refuse = async (
    reason: string,
    detail?: string,
    unrelated?: boolean,
    candidates?: number,
  ) => {
    note(rt, ctx.document, ctx.live.url, reason, detail, unrelated, candidates);
    ctx.live.state = "denied";
    ctx.live.reason = reason;
    if (detail === undefined) delete ctx.live.refusal;
    else ctx.live.refusal = detail;
    await publish(rt, ctx.live);
    return { ok: false, reason };
  };

  if (manual && !manualAuthorizationCurrent(rt, live, manual))
    return ctx.refuse("manual-request-ended");

  // A sign-in input shows on this path, but the page only watches: logged once per
  // document and path, so a login that silently does not start can be told apart.
  ctx.notStarted = (detail: string, visit?: ConfirmVisit) =>
    noteNotStarted(rt, ctx.live, ctx.shown, detail, ctx.recipe, visit);

  // The page after a sign-in entry press is checked before anything else runs on it, and
  // one that blocked the entry is neither sent for generation nor logged in to (ADR 0031).
  const refusedKey = documentKey(ctx.document);

  if (!rt.entryRefused.has(refusedKey)) {
    await checkAfterPress(rt, ctx.live);
    if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
  }

  if (rt.entryRefused.has(refusedKey)) return ctx.refuse("entry-blocked");

  // A report sent only for the log does not log the tab's hold again. A passkey page
  // (ADR 0053) is answered as the announcement it would be without its button: its list,
  // its entry, or, with neither, the log-only report of a page that offered nothing.
  const quiet = ctx.signIn?.passkey
    ? ctx.list || !ctx.entryHello
    : ctx.shown || ctx.list || ctx.unoffered;

  // A later frame may fill a confirmation using the top-level login's authenticated
  // account. Only that confirmation path bypasses frame ownership: ordinary login
  // admission, manual starts and active attempts retain the existing busy rule.
  if (
    busy &&
    rt.vars.storageHealthy &&
    !ctx.manual &&
    owner?.document.frameId === 0 &&
    ctx.document.frameId !== 0 &&
    owner.account.origin === ctx.document.origin &&
    hasConfirmAuthentication(rt, owner) &&
    recordFor(rt, ctx.document.tabId, ctx.document.origin)?.id === owner.id &&
    page !== undefined &&
    rt.documents.get(frameKey(page.document)) === page &&
    page.url === ctx.live.topUrl &&
    !page.leftUnread
  ) {
    ctx.recorded = owner;
    const confirmation = await admitConfirm(rt, ctx);
    if (confirmation) return confirmation;
    ctx.recorded = undefined;
  }

  if (busy)
    return quiet && !ctx.start && (!ctx.signIn || ctx.signIn.passkey)
      ? { ok: false, reason: "tab-busy" }
      : ctx.refuse("tab-busy");

  if (!rt.vars.storageHealthy)
    return ctx.refuse(
      "storage-unavailable",
      undefined,
      !(await loginRelated(rt, ctx.document.tabId, ctx.document.frameId, ctx.document.origin)),
    );

  const holder = tabAttempt(rt, ctx.document.tabId);

  /** Logs why a move of `record` did not complete it, or that it was kept (ADR 0022). */
  const reportMove = (record: LoginAttemptMetadata, reason: MoveMiss, kept?: true) =>
    report(rt, ctx.document, {
      type: "move",
      tabId: ctx.document.tabId,
      origin: ctx.siteOrigin,
      recipeId: record.recipeId,
      recipeRevision: record.recipeRevision,
      route: record.route,
      reason,
      ...(ctx.document.frameId === 0 ? {} : { frame: true as const }),
      ...(kept ? { kept } : {}),
    });

  /**
   * Ends the tab's top-level attempt `latest`, run by `run` if it still runs, on its
   * tab's move to the page of `moved`, completed when `signedIn` (ADR 0022). Returns a
   * refusal when the record could not be stored.
   */
  const endMove = async (
    run: Execution | undefined,
    latest: LoginAttemptMetadata,
    moved: LoginDocument,
    signedIn: boolean,
  ) => {
    const before = run?.metadata ?? recoverLoginAttempt(latest);
    // A login that did not sign in here ended when its wait for the site or its watch ran
    // out, if one did before this page showed; the time between counts for nothing (ADR
    // 0019, ADR 0022 amended 2026-11-03).
    const now = Date.now();
    const endedAt = signedIn
      ? now
      : (siteWaitOver(before, now) ??
        (watchOver(before, now) ? Math.min(now, before.watch!.since + WATCH_MS) : now));
    const ended = transitionLoginAttempt(
      before,
      { type: "NAVIGATED", document: moved, ...(signedIn ? { signedIn } : {}) },
      endedAt,
    );
    noteSignedIn(rt, before, ended, moved.origin);
    countRelogin(rt, before, ended, ctx.incognito === true);
    if (signedInNow(rt, before, ended)) void endPickedPause(rt, ended, run?.live);
    if (run) run.metadata = ended;
    reportAttempt(rt, ended, run?.recipe, undefined, { endedAt });
    try {
      await keep(rt, ended);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    if (ended.state === "authenticated" && run?.choice) await remember(rt, run);
    return undefined;
  };

  if (
    frameMoved &&
    holder?.id === frameMoved.id &&
    !terminal(holder) &&
    holder.document.frameId !== 0 &&
    ctx.document.frameId === 0
  ) {
    // The page around a frame's login was replaced right after its step or during its
    // watch, as by a sign-in in a frame that hands its result to its page (ADR 0086): the
    // new page completes the login when its URL matches the login's item and it reads as
    // signed in, as a top-level login's move to another origin of the site does (ADR
    // 0022). Otherwise the login ends without resubmitting, as before (ADR 0017).
    const check = signedInAfterFrame(rt, holder, ctx.live);
    rt.siteMoves.set(ctx.document.tabId, check);
    let signedIn: boolean;
    try {
      signedIn = await check;
    } finally {
      if (rt.siteMoves.get(ctx.document.tabId) === check) rt.siteMoves.delete(ctx.document.tabId);
    }
    if (rt.hellos.get(helloKey) !== sequence || rt.documents.get(ctx.key) !== ctx.live)
      return { ok: false, reason: "stale-document" };
    const run = rt.attempts.get(ctx.document.tabId);
    const latest = run?.metadata ?? tabAttempt(rt, ctx.document.tabId);
    if (latest?.id === holder.id && !terminal(latest)) {
      // A page that went away before it could be read leaves the login to the tab's next
      // page, which must still come within the same bounds.
      if (ctx.live.moveMiss === "page-gone") {
        reportMove(holder, ctx.live.moveMiss, true);
        return { ok: false, reason: "stale-document" };
      }
      if (!signedIn && ctx.live.moveMiss) reportMove(holder, ctx.live.moveMiss);
      if (rt.leftFrames.get(ctx.document.tabId) === holder.id)
        rt.leftFrames.delete(ctx.document.tabId);
      const refusal = await endMove(run, latest, ctx.document, signedIn);
      if (refusal) return refusal;
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  } else if (holder && !terminal(holder) && holder.document.frameId === 0 && leftSite(holder)) {
    // The tab's page moved to another origin: the attempt there ends without
    // resubmitting and keeps its record, and this page or its frame may start its own.
    // A frame stands for the tab's page, which left the attempt's origin. A move to a
    // quiet page of any site right after a credential step, or to another origin of the
    // site right after a login's other step, to a page that shows the account's
    // username, completes the attempt instead (`signedInByMove`), which only the top page
    // can tell: a frame of the new page waits for that check, or leaves the move to the
    // top page when one may follow.
    let ending = true;
    let signedIn = false;
    if (ctx.document.frameId !== 0) {
      // The top page announcing again during a check starts another, which is waited for
      // too; each check's own hello drops it once it settles.
      for (
        let check = rt.siteMoves.get(ctx.document.tabId), last: Promise<boolean> | undefined;
        check && check !== last;
        last = check, check = rt.siteMoves.get(ctx.document.tabId)
      )
        // eslint-disable-next-line no-await-in-loop
        await check;
      // A check that went stale, as when the top page announced again, ended nothing.
      // A login held by a page that asked for a passkey is left to the tab's top pages.
      if (
        credentialMoveFits(rt, holder, ctx.document.tabId, ctx.siteOrigin) ||
        stepMoveFits(rt, holder, ctx.document.tabId, ctx.siteOrigin) ||
        // A page of any site that asks for a passkey may still hold it.
        requestMoveFits(rt, holder, ctx.document.tabId, ctx.siteOrigin) ||
        rt.passkeyPages.get(ctx.document.tabId)?.attemptId === holder.id
      ) {
        ending = false;
        // The frame announces again once the top page ended the attempt, as a sign-in form
        // of the new site in a frame then starts its own login.
        const refused = rt.movedFrames.get(ctx.document.tabId);
        const frames =
          refused?.attemptId === holder.id
            ? refused.frames.filter((frame) => frame.documentId !== ctx.document.documentId)
            : [];
        rt.movedFrames.set(ctx.document.tabId, {
          attemptId: holder.id,
          frames: [...frames, ctx.document],
        });
      }
    } else {
      const check = signedInByMove(rt, holder, ctx.live);
      rt.siteMoves.set(ctx.document.tabId, check);
      try {
        signedIn = await check;
      } finally {
        if (rt.siteMoves.get(ctx.document.tabId) === check) rt.siteMoves.delete(ctx.document.tabId);
      }
    }
    if (rt.hellos.get(helloKey) !== sequence || rt.documents.get(ctx.key) !== ctx.live)
      return { ok: false, reason: "stale-document" };
    const miss: MoveMiss | undefined =
      ctx.document.frameId !== 0 ? (ending ? "no-factor" : undefined) : ctx.live.moveMiss;
    // Another page of the tab may have ended the attempt meanwhile.
    const running = () => {
      const latest =
        rt.attempts.get(ctx.document.tabId)?.metadata ?? tabAttempt(rt, ctx.document.tabId);
      return latest?.id === holder.id && !terminal(latest);
    };
    // A page that went away before it could be read, as a redirect through another
    // page does, is not where the move ended: the tab's next page is checked instead.
    if (miss === "page-gone" && running()) {
      reportMove(holder, miss, true);
      return { ok: false, reason: "stale-document" };
    }
    // Nor is a page of another origin, of any site, that asks for a passkey soon after the
    // attempt's last step: the attempt waits for the tab's next page, which a passkey
    // answered there with the attempt's own item lets complete it (`credentialMoveFits`).
    // This page starts no login of its own meanwhile.
    const asked = async () =>
      passkeyPageFits(rt, holder, ctx.document, ctx.siteOrigin) &&
      (rt.passkeyPages.get(ctx.document.tabId)?.document.documentId !== ctx.document.documentId ||
        (await stillAsking(rt, ctx.live)));
    const held =
      ctx.document.frameId === 0 && !signedIn && miss !== undefined && running() && (await asked());
    if (rt.hellos.get(helloKey) !== sequence || rt.documents.get(ctx.key) !== ctx.live)
      return { ok: false, reason: "stale-document" };
    if (held && running()) {
      rt.passkeyPages.set(ctx.document.tabId, {
        attemptId: holder.id,
        document: { ...ctx.document, frameId: 0, origin: ctx.siteOrigin },
        requestedAt: Math.max(
          rt.passkeyRequests.get(`${ctx.document.tabId} ${ctx.siteOrigin}`) ?? 0,
          rt.passkeyPages.get(ctx.document.tabId)?.attemptId === holder.id
            ? rt.passkeyPages.get(ctx.document.tabId)!.requestedAt
            : 0,
        ),
      });
      holdForPasskey(rt, ctx.document.tabId);
      reportMove(holder, "passkey-request", true);
      return { ok: false, reason: "stale-document" };
    }
    const run = rt.attempts.get(ctx.document.tabId);
    const latest = run?.metadata ?? tabAttempt(rt, ctx.document.tabId);
    if (ending && latest?.id === holder.id && !terminal(latest)) {
      if (!signedIn && miss) reportMove(holder, miss);
      const refusal = await endMove(
        run,
        latest,
        { ...ctx.document, frameId: 0, origin: ctx.siteOrigin },
        signedIn,
      );
      const refused = rt.movedFrames.get(ctx.document.tabId);
      if (ctx.document.frameId === 0 && refused?.attemptId === holder.id) {
        rt.movedFrames.delete(ctx.document.tabId);
        for (const frame of refused.frames)
          void browser.tabs
            .sendMessage(
              ctx.document.tabId,
              { version: 1, type: "login.reconnect" },
              { frameId: frame.frameId, documentId: frame.documentId },
            )
            .catch(() => undefined);
      }
      if (refusal) return refusal;
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  } else if (
    holder &&
    !terminal(holder) &&
    ctx.document.frameId === 0 &&
    rt.passkeyPages.get(ctx.document.tabId)?.attemptId === holder.id
  ) {
    // The tab came back to the attempt's origin from a page of another origin
    // that asked for a passkey (ADR 0022). A passkey answered there with the attempt's
    // own item, and this page quiet, complete the attempt; otherwise it ends as that move
    // would have, without resubmitting. A page that goes away before it is read leaves
    // the decision to the tab's next page.
    const asking = rt.passkeyPages.get(ctx.document.tabId)!;
    const check = signedInByMove(rt, holder, ctx.live);
    rt.siteMoves.set(ctx.document.tabId, check);
    let signedIn: boolean;
    try {
      signedIn = await check;
    } finally {
      if (rt.siteMoves.get(ctx.document.tabId) === check) rt.siteMoves.delete(ctx.document.tabId);
    }
    if (
      rt.hellos.get(helloKey) !== sequence ||
      rt.documents.get(ctx.key) !== ctx.live ||
      rt.passkeyPages.get(ctx.document.tabId) !== asking
    )
      return { ok: false, reason: "stale-document" };
    const run = rt.attempts.get(ctx.document.tabId);
    const latest = run?.metadata ?? tabAttempt(rt, ctx.document.tabId);
    if (latest?.id === holder.id && !terminal(latest)) {
      if (ctx.live.moveMiss === "page-gone") {
        reportMove(holder, ctx.live.moveMiss, true);
        return { ok: false, reason: "stale-document" };
      }
      rt.passkeyPages.delete(ctx.document.tabId);
      if (!signedIn && ctx.live.moveMiss) reportMove(holder, ctx.live.moveMiss);
      const refusal = await endMove(run, latest, asking.document, signedIn);
      if (refusal) return refusal;
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  }

  return admitRecord(rt, ctx);
}
