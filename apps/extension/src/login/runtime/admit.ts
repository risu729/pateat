import {
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
import { AFTER_SIGN_IN_MS, SITE_MOVE_MS } from "./constants";
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
import { leaveConfirm, previousPage, confirmSigns } from "./markers";
import { noteUnadmitted, note, loginRelated } from "./generation";
import { tabAttempt } from "./hold";
import { terminal, finishedLogin } from "./attempt-state";
import { dropReprompt } from "./master-password";
import { type MoveMiss } from "./report";
import { countRelogin, signedInNow } from "./relogin";
import { remember } from "./choice-save";
import {
  passkeyMoveFits,
  passwordMoveFits,
  passkeyPageFits,
  stillAsking,
  holdForPasskey,
} from "./moves";
import { signedInByPasskey, signedInByPassword } from "./passkey";
import type { Runtime } from "./state";
import { admitRecord } from "./admit-record";
import type { AdmitContext } from "./admit-context";

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
  await rt.vars.loaded;

  await rt.vars.sessionLoaded;

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

  // The tab's next page of the origin after a submitted password form (ADR 0028).
  const submitted = rt.passwordSubmits.get(document.tabId);

  if (submitted && document.frameId === 0 && submitted.documentId !== document.documentId) {
    // Only the tab's next page counts: one of another origin ends the skip.
    rt.passwordSubmits.delete(document.tabId);
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

  // A tab runs one attempt. Another frame of the tab, such as an embedded widget or the
  // page around a framed login, never takes it over or disturbs it. Only a new page in
  // the tab (another top document) ends an attempt held by a frame of the old page.
  let owner = tabAttempt(rt, document.tabId);

  const page = rt.documents.get(frameKey({ tabId: document.tabId, frameId: 0 }));

  let newPage =
    document.frameId === 0 &&
    page !== undefined &&
    page.document.documentId !== document.documentId;

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
      if (!answers[index]) rt.documents.delete(other);
    if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    owner = tabAttempt(rt, document.tabId);
    const holder = owner && rt.documents.get(frameKey(owner.document));
    if (owner && owner.document.frameId !== 0) {
      if (holder && sameLoginDocument(holder.document, owner.document)) {
        // The frame holding the attempt is still there, so this page is its parent.
        newPage = false;
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
    !newPage;

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
    // A document that waited for a locked vault starts its login's time again once it can
    // read it: unlocking the vault comes before any login (ADR 0019).
    timing:
      sameDocument && oldLive.reason !== "vault-unavailable"
        ? oldLive.timing
        : { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
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

  // The first other top document of the tab after an effect step, when it comes soon
  // enough to be the site's answer to it (ADR 0029). One announced later, as after the
  // person's own retry in a page the login settled on, is never read as that answer.
  const effect = rt.effects.get(document.tabId);

  if (
    effect &&
    effect.next === undefined &&
    document.frameId === 0 &&
    !sameLoginDocument(effect.document, document) &&
    Date.now() - effect.at <= SITE_MOVE_MS
  )
    effect.next = document.documentId;

  const ctx: AdmitContext = {
    document: document,
    key: key,
    incognito: incognito,
    siteOrigin: siteOrigin,
    live: live,
    paused: paused,
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

  // A sign-in input shows on this path, but the page only watches: logged once per
  // document and path, so a login that silently does not start can be told apart.
  ctx.notStarted = (detail: string, visit?: ConfirmVisit) => {
    if (ctx.shown?.path !== ctx.live.path || ctx.live.notStarted === detail) return;
    ctx.live.notStarted = detail;
    const refused = {
      type: "refused" as const,
      tabId: ctx.document.tabId,
      origin: ctx.document.origin,
      reason: "not-started",
      detail,
      ...(ctx.document.frameId === 0 ? {} : { frame: true as const }),
    };
    if (!visit) {
      const later = ctx.shown?.later;
      report(rt, ctx.document, {
        ...refused,
        ...(detail === "first-step-missing" && ctx.recipe
          ? { recipeId: ctx.recipe.id, recipeRevision: ctx.recipe.revision }
          : {}),
        ...(later
          ? { laterSteps: later.steps, laterPartial: later.partial, laterMiss: later.miss }
          : {}),
      });
      return;
    }
    // A page Pateat does not fill also logs what it shows for the evaluation of page kinds
    // (ADR 0035), read first, so the entry names this page's URL; its visit logs the
    // person's submission and the next page once the tab leaves it.
    const amount = ctx.shown?.amount;
    visit.logged = confirmSigns(rt, ctx.live).then((signs) => {
      report(rt, ctx.document, {
        ...refused,
        recipeId: visit.recipe.id,
        recipeRevision: visit.recipe.revision,
        pageKind: visit.recipe.pageKind,
        ...(amount === undefined ? {} : { amount }),
        ...signs,
        url: ctx.live.url,
      });
      // Read as the `signedIn` hint false: the page was read and neither shows, E2 also
      // when it was not read.
      return signs.e1 === false && signs.e2 !== true;
    });
    void visit.logged.catch(() => undefined);
  };

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
    const ended = transitionLoginAttempt(before, {
      type: "NAVIGATED",
      document: moved,
      ...(signedIn ? { signedIn } : {}),
    });
    noteSignedIn(rt, before, ended, moved.origin);
    countRelogin(rt, before, ended, ctx.incognito === true);
    if (signedInNow(rt, before, ended)) void endPickedPause(rt, ended, run?.live);
    if (run) run.metadata = ended;
    reportAttempt(rt, ended, run?.recipe);
    try {
      await keep(rt, ended);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    if (ended.state === "authenticated" && run?.choice) await remember(rt, run);
    return undefined;
  };

  if (holder && !terminal(holder) && holder.document.frameId === 0 && leftSite(holder)) {
    // The tab's page moved to another origin: the attempt there ends without
    // resubmitting and keeps its record, and this page or its frame may start its own.
    // A frame stands for the tab's page, which left the attempt's origin. A move to the
    // passkey's site right after Pateat answered it, or to another origin of the site
    // right after a password submission, or of any site right after a second factor, to a
    // page that shows the account's username, completes the attempt instead, which only
    // the top page can tell: a frame of the new page waits for that check, or leaves the
    // move to the top page when one may follow.
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
        passkeyMoveFits(rt, holder, ctx.document.tabId, ctx.siteOrigin) ||
        passwordMoveFits(rt, holder, ctx.document.tabId, ctx.siteOrigin) ||
        rt.passkeyPages.get(ctx.document.tabId)?.attemptId === holder.id
      )
        ending = false;
    } else {
      const check = passkeyMoveFits(rt, holder, ctx.document.tabId, ctx.siteOrigin)
        ? signedInByPasskey(rt, holder, ctx.live)
        : signedInByPassword(rt, holder, ctx.live);
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
    // Nor is a page of another origin of the site that asks for a passkey soon after the
    // attempt's last step: the attempt waits for the tab's next page, which a passkey
    // answered there with the attempt's own item lets complete it (`passkeyMoveFits`).
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
      if (refusal) return refusal;
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  } else if (
    holder &&
    !terminal(holder) &&
    ctx.document.frameId === 0 &&
    rt.passkeyPages.get(ctx.document.tabId)?.attemptId === holder.id
  ) {
    // The tab came back to the attempt's origin from a page of another origin of the site
    // that asked for a passkey (ADR 0022). A passkey answered there with the attempt's
    // own item, and this page quiet, complete the attempt; otherwise it ends as that move
    // would have, without resubmitting. A page that goes away before it is read leaves
    // the decision to the tab's next page.
    const asking = rt.passkeyPages.get(ctx.document.tabId)!;
    const check = signedInByPasskey(rt, holder, ctx.live);
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
