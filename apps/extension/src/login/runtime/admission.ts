import {
  attemptRouteChoice,
  continuesRecipe,
  createAttemptMetadata,
  extendsRecipe,
  passkeyAnswersRequest,
  recipeStartSteps,
  recoverLoginAttempt,
  sameLoginDocument,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  type LoginDocument,
  chooserRoute,
  type ChooserClick,
  type LoginChooserRecipe,
  type LoginRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  type unofferedReasons,
  type ListMissReport as ListMiss,
  loginReadiness,
  START_TRIES,
  START_TRY_WINDOW_MS,
  type LoginReadiness,
} from "../wire";
import { probeRecipe } from "../dummy";
import { namesReturnPath } from "../entry";
import { newId } from "@pateat/contracts/ids";
import {
  AFTER_SIGN_IN_MS,
  autoSubmitted,
  CHOICE_SAVED,
  codeAwaitsClick,
  documentKey,
  type Execution,
  finishedLogin,
  frameKey,
  type GenerationMiss,
  holdsSite,
  type ListOffer,
  type LiveDocument,
  logCode,
  type MoveMiss,
  probeMode,
  recordKey,
  sameSiteAs,
  type Sender,
  SITE_MOVE_MS,
  stoppedByPateat,
  terminal,
  watchOver,
} from "./model";
import type { PolicyChange } from "./reports";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * The documents that announce themselves: identifying the sender, admitting its page, and
 * deciding whether it starts, resumes or asks for a login, or is refused and logged.
 */
export function createAdmission(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    sites,
    noted,
    quietly,
    report,
    recipes,
    options,
    savingChoices,
    pending,
    documents,
    send,
    attempts,
    reportAttempt,
    effects,
    publish,
    entryRefused,
    siteMoves,
    passkeyPages,
    passkeyRequests,
    picked,
    logouts,
    rejectedAsks,
    logoutFills,
    stoppedAsks,
    persisted,
    settings,
    badge,
  } = shared;
  const hellos = new Map<string, number>();
  /**
   * Per tab, the document that last submitted a form with a password input, and the
   * tab's next document of that origin when it loads within a minute of the submission:
   * the page right after a sign-in, which is never sent as a list of accounts (ADR 0028).
   * A later load, such as a reload after a logout in a single-page app, is not one. Kept
   * in memory only.
   */
  const passwordSubmits = new Map<number, { origin: string; documentId: string; at: number }>();
  const afterSignIn = new Map<number, string>();
  /** The latest announcement of each frame while it is admitted, by the same key. */
  const admitting = new Map<string, Promise<unknown>>();
  const probeDocument = (url: URL) =>
    probeMode &&
    url.origin === runtime.origin &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1";
  // The synthetic fixture embeds its frames in a page on another loopback port to test refusal.
  const probeTop = (url: URL) =>
    probeMode && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const admitted = async (url: URL) =>
    probeDocument(url) || (sites !== undefined && (await sites.admission(url)) === "admitted");
  /**
   * The browser-identified document. A frame inside the page is admitted only when the
   * tab's page is admitted too; excluded sites stop it on either side (ADR 0017).
   */
  async function identify(sender: Sender): Promise<LoginDocument | undefined> {
    if (
      sender.id !== browser.runtime.id ||
      sender.tab?.id === undefined ||
      sender.frameId === undefined ||
      !sender.documentId ||
      // A prerendered page also has a nonzero frame ID; it is not a frame of the tab.
      (sender as { documentLifecycle?: string }).documentLifecycle === "prerender" ||
      !sender.url
    )
      return undefined;
    try {
      const url = new URL(sender.url);
      if (!(await admitted(url))) return undefined;
      if (sender.frameId !== 0) {
        const top = sender.tab.url ? new URL(sender.tab.url) : undefined;
        if (!top || !(probeTop(top) || (await admitted(top)))) return undefined;
      }
      return {
        origin: url.origin,
        tabId: sender.tab.id,
        frameId: sender.frameId,
        documentId: sender.documentId,
      };
    } catch {
      return undefined;
    }
  }
  const trusted = (sender: Sender) =>
    sender.id === browser.runtime.id &&
    sender.url === browser.runtime.getURL("/options.html") &&
    !sender.tab?.url?.startsWith("http:");
  /**
   * Logs why Pateat did nothing on a page. The same reason again on the same page is
   * logged as a repeat (ADR 0019).
   */
  function note(
    document: LoginDocument,
    url: string,
    reason: string,
    detail?: string,
    unrelated?: boolean,
    candidates?: number,
  ): void {
    const key = `${document.tabId} ${document.documentId} ${new URL(url).pathname}`;
    const reasons = noted.get(key) ?? new Set<string>();
    const id = `${reason} ${detail ?? ""}`;
    const repeat = reasons.has(id);
    reasons.add(id);
    noted.delete(key);
    noted.set(key, reasons);
    for (const old of noted.keys()) {
      if (noted.size <= 256) break;
      noted.delete(old);
    }
    // Kept for the worker's next start. A repeat changes nothing worth storing, and
    // ordinary browsing logs only at debug.
    if (!repeat && !unrelated) void quietly(runtime.saveSession);
    report(document, {
      type: "refused",
      tabId: document.tabId,
      origin: document.origin,
      reason,
      ...(detail ? { detail } : {}),
      ...(candidates === undefined ? {} : { candidates }),
      ...(document.frameId === 0 ? {} : { frame: true as const }),
      ...(repeat ? { repeat: true as const } : {}),
      ...(unrelated ? { unrelated: true as const } : {}),
      // The refused page's own URL, which may not be the tab's admitted page yet.
      url: document.frameId === 0 ? url : undefined,
    });
  }
  /**
   * Whether a page is login-related: its origin has a recipe, or it is the tab's page and a
   * login runs in the tab (ADR 0019). Other pages are ordinary browsing.
   */
  async function loginRelated(
    tabId: number,
    frameId: number,
    documentOrigin: string,
  ): Promise<boolean> {
    // A frame counts only on its own origin's recipe, as a login form embedded in the page.
    const running = frameId === 0 ? runtime.tabAttempt(tabId) : undefined;
    if (running && !terminal(running)) return true;
    if (probeMode && documentOrigin === runtime.origin) return true;
    return (await recipes.starts(documentOrigin).catch(() => [])).length > 0;
  }
  /**
   * Logs why the tab's own page was not admitted, such as an excluded site, when the page
   * is login-related. A frame or a prerendered page is not the tab's page.
   */
  async function noteUnadmitted(sender: Sender): Promise<void> {
    const tabId = sender.tab?.id;
    if (
      !sites ||
      sender.id !== browser.runtime.id ||
      tabId === undefined ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      (sender as { documentLifecycle?: string }).documentLifecycle === "prerender" ||
      !sender.url
    )
      return;
    try {
      const url = new URL(sender.url);
      const refusal = await sites.admission(url);
      // A page that is not HTTPS never runs the content script in production.
      if (refusal === "admitted" || refusal === "not-https") return;
      if (!(await loginRelated(tabId, 0, url.origin))) return;
      note(
        { tabId, frameId: 0, documentId: sender.documentId, origin: url.origin },
        url.href,
        refusal,
      );
    } catch {
      // A report must never change the answer.
    }
  }
  /**
   * Consecutive answers that make a document try its start again, by frame and document.
   * The content script tries a start `START_TRIES` times, about half a second apart, and
   * then waits until its form goes; the worker counts the answers to log the page giving up.
   */
  const startTries = new Map<string, { count: number; at: number }>();
  function countStartTry(sender: Sender, helloKey: string, result: Readiness): void {
    const key = `${helloKey}:${sender.documentId}`;
    if (
      result.reason !== "stale-document" &&
      result.reason !== "closed-tab" &&
      result.starts === undefined
    ) {
      startTries.delete(key);
      return;
    }
    const now = Date.now();
    const last = startTries.get(key);
    const count = last && now - last.at < START_TRY_WINDOW_MS ? last.count + 1 : 1;
    startTries.delete(key);
    startTries.set(key, { count, at: now });
    for (const old of startTries.keys()) {
      if (startTries.size <= 256) break;
      startTries.delete(old);
    }
    const tabId = sender.tab?.id;
    if (
      count !== START_TRIES ||
      result.reason !== "stale-document" ||
      tabId === undefined ||
      sender.frameId === undefined ||
      !sender.documentId ||
      !sender.url
    )
      return;
    try {
      const url = new URL(sender.url);
      note(
        { tabId, frameId: sender.frameId, documentId: sender.documentId, origin: url.origin },
        url.href,
        "stale-document",
        "gave-up",
      );
    } catch {
      // A report must never change the answer.
    }
  }
  type Readiness = {
    ok: boolean;
    reason?: string;
    starts?: LoginReadiness[];
    generate?: true;
    entry?: true;
  };
  type Announced = { path: string } | undefined;
  type Unoffered = { path: string; why: (typeof unofferedReasons)[number] } | undefined;
  async function ready(
    sender: Sender,
    token: string,
    start?: { path: string },
    signIn?: { path: string; identifier?: true | undefined },
    shown?: { path: string },
    list?: ListOffer,
    entryHello?: Announced,
    unoffered?: Unoffered,
  ): Promise<Readiness> {
    // Admission is async; a later hello from the same frame must not be overtaken by an older one.
    const helloKey = `${sender.tab?.id}:${sender.frameId}`;
    const sequence = (hellos.get(helloKey) ?? 0) + 1;
    hellos.set(helloKey, sequence);
    // Entered after the sequence is taken, so a hello waiting on the vault check is stale
    // once a later one from the same frame arrives (ADR 0025).
    const admission = (async () => {
      const leave = await options.vault?.enter(start !== undefined);
      try {
        return await admitFresh(
          sender,
          token,
          helloKey,
          sequence,
          start,
          signIn,
          shown,
          list,
          entryHello,
          unoffered,
        );
      } finally {
        leave?.();
      }
    })();
    admitting.set(helloKey, admission);
    try {
      const result = await admission;
      if (start) countStartTry(sender, helloKey, result);
      return result;
    } finally {
      if (admitting.get(helloKey) === admission) admitting.delete(helloKey);
    }
  }
  /**
   * A new login is admitted again with fresh settings when another login's account choice
   * was saved meanwhile.
   */
  async function admitFresh(
    sender: Sender,
    token: string,
    helloKey: string,
    sequence: number,
    start?: { path: string },
    signIn?: { path: string; identifier?: true | undefined },
    shown?: { path: string },
    list?: ListOffer,
    entryHello?: Announced,
    unoffered?: Unoffered,
    tries = 0,
  ): Promise<Readiness> {
    const result = await admit(
      sender,
      token,
      helloKey,
      sequence,
      start,
      signIn,
      shown,
      list,
      entryHello,
      unoffered,
    );
    if (result.reason !== CHOICE_SAVED) return result;
    return tries < 2
      ? admitFresh(
          sender,
          token,
          helloKey,
          sequence,
          start,
          signIn,
          shown,
          list,
          entryHello,
          unoffered,
          tries + 1,
        )
      : { ok: false, reason: "stale-document" };
  }
  /** Resolves once no account choice is being saved. */
  async function choicesSaved(): Promise<void> {
    if (!savingChoices.size) return;
    await Promise.all(savingChoices);
    return choicesSaved();
  }
  async function admit(
    sender: Sender,
    token: string,
    helloKey: string,
    sequence: number,
    start?: { path: string },
    signIn?: { path: string; identifier?: true | undefined },
    shown?: { path: string },
    list?: ListOffer,
    entryHello?: Announced,
    unoffered?: Unoffered,
  ): Promise<Readiness> {
    await runtime.loaded;
    await runtime.sessionLoaded;
    const document = await identify(sender);
    if (!document || !sender.url) {
      await noteUnadmitted(sender);
      return { ok: false, reason: "unauthorized-document" };
    }
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    const key = frameKey(document);
    // The tab's next page of the origin after a submitted password form (ADR 0028).
    const submitted = passwordSubmits.get(document.tabId);
    if (submitted && document.frameId === 0 && submitted.documentId !== document.documentId) {
      // Only the tab's next page counts: one of another origin ends the skip.
      passwordSubmits.delete(document.tabId);
      // A clock that went back keeps the skip: sending the page is the less safe outcome.
      if (submitted.origin === document.origin && Date.now() - submitted.at < AFTER_SIGN_IN_MS)
        afterSignIn.set(document.tabId, document.documentId);
    }
    // A new page in the tab replaces the document that waited for a choice.
    const waiting = pending.get(document.tabId);
    if (
      waiting?.document.frameId === 0 &&
      document.frameId === 0 &&
      waiting.document.documentId !== document.documentId
    )
      runtime.clearChoice(document.tabId);
    // `sender.url` keeps the URL the document loaded with; a same-document URL change
    // (history.pushState) of the tab's page shows only in the tab's committed URL. A frame
    // inside the page keeps its load URL and records the tab's URL to match as well.
    let url = sender.url;
    let topUrl: string | undefined;
    try {
      const tab = await browser.tabs.get(document.tabId);
      if (document.frameId !== 0) {
        // A frame's page is a web page; any other URL means the tab moved on.
        if (!tab.url || !/^https?:$/.test(new URL(tab.url).protocol))
          return { ok: false, reason: "stale-document" };
        topUrl = tab.url;
      } else if (tab.url && new URL(tab.url).origin === document.origin) url = tab.url;
    } catch {
      return { ok: false, reason: "closed-tab" };
    }
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    // A tab runs one attempt. Another frame of the tab, such as an embedded widget or the
    // page around a framed login, never takes it over or disturbs it. Only a new page in
    // the tab (another top document) ends an attempt held by a frame of the old page.
    let owner = runtime.tabAttempt(document.tabId);
    const page = documents.get(frameKey({ tabId: document.tabId, frameId: 0 }));
    let newPage =
      document.frameId === 0 &&
      page !== undefined &&
      page.document.documentId !== document.documentId;
    if (newPage) {
      // Frames of this page may have announced before it did. Only documents that no
      // longer answer went away with the old page.
      // A frame that does not answer in time counts as still there.
      const frames = [...documents].filter(
        ([, entry]) => entry.document.tabId === document.tabId && entry.document.frameId !== 0,
      );
      const answers = await Promise.all(
        frames.map(([, entry]) =>
          Promise.race([
            send(entry, { type: "login.observe", path: entry.path, targets: [] }).then(
              () => true,
              () => false,
            ),
            new Promise<boolean>((resolve) => setTimeout(resolve, 1000, true)),
          ]),
        ),
      );
      for (const [index, [other]] of frames.entries()) if (!answers[index]) documents.delete(other);
      if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
      owner = runtime.tabAttempt(document.tabId);
      const holder = owner && documents.get(frameKey(owner.document));
      if (owner && owner.document.frameId !== 0) {
        if (holder && sameLoginDocument(holder.document, owner.document)) {
          // The frame holding the attempt is still there, so this page is its parent.
          newPage = false;
        } else if (!terminal(owner)) {
          // The frame's page is gone: its attempt ends without resubmitting, whatever
          // origin the new page has.
          const run = attempts.get(document.tabId);
          const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(owner), {
            type: "NAVIGATED",
            document,
          });
          if (run) run.metadata = ended;
          reportAttempt(ended, run?.recipe);
          try {
            await runtime.keep(ended);
          } catch {
            return { ok: false, reason: "storage-unavailable" };
          }
          if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
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
    const oldLive = documents.get(key);
    const sameDocument = oldLive !== undefined && sameLoginDocument(oldLive.document, document);
    // A document may announce again when its form appears or its URL changes in place,
    // but never while it already carries an attempt, unless that login finished and the
    // document now watches for a logout (ADR 0021 D), or the login is watched and its first
    // step shows in the document (ADR 0027).
    const carried = attempts.get(document.tabId);
    if (
      sameDocument &&
      (oldLive.token !== token ||
        (carried?.live === oldLive &&
          !(
            document.frameId === 0 &&
            (finishedLogin(carried.metadata) ||
              (carried.metadata.watch !== undefined &&
                start?.path === new URL(url).pathname &&
                document.documentId !== carried.metadata.watch.documentId))
          )))
    ) {
      note(document, url, "duplicate-document");
      return { ok: false, reason: "duplicate-document" };
    }
    if (oldLive && !sameDocument)
      await send(oldLive, { type: "login.cancel" }).catch(() => undefined);
    const path = new URL(url).pathname;
    const live: LiveDocument = {
      document,
      token,
      url,
      path,
      ...(topUrl ? { topUrl } : {}),
      // A document announcing again on the same path logs each generation skip once.
      ...(sameDocument && oldLive.path === path && oldLive.generationSkip
        ? { generationSkip: oldLive.generationSkip }
        : {}),
      ...(sameDocument && oldLive.path === path && oldLive.notStarted
        ? { notStarted: oldLive.notStarted }
        : {}),
      seenAt: sameDocument ? oldLive.seenAt : Date.now(),
      ...(sameDocument && oldLive.path === path && oldLive.entryRefusals
        ? { entryRefusals: oldLive.entryRefusals }
        : {}),
    };
    documents.set(key, live);
    // The first other top document of the tab after an effect step, when it comes soon
    // enough to be the site's answer to it (ADR 0029). One announced later, as after the
    // person's own retry in a page the login settled on, is never read as that answer.
    const effect = effects.get(document.tabId);
    if (
      effect &&
      effect.next === undefined &&
      document.frameId === 0 &&
      !sameLoginDocument(effect.document, document) &&
      Date.now() - effect.at <= SITE_MOVE_MS
    )
      effect.next = document.documentId;
    const refuse = async (
      reason: string,
      detail?: string,
      unrelated?: boolean,
      candidates?: number,
    ) => {
      note(document, live.url, reason, detail, unrelated, candidates);
      live.state = "denied";
      live.reason = reason;
      await publish(live);
      return { ok: false, reason };
    };
    // A sign-in input shows on this path, but the page only watches: logged once per
    // document and path, so a login that silently does not start can be told apart.
    const notStarted = (detail: string) => {
      if (shown?.path !== live.path || live.notStarted === detail) return;
      live.notStarted = detail;
      report(document, {
        type: "refused",
        tabId: document.tabId,
        origin: document.origin,
        reason: "not-started",
        detail,
        ...(document.frameId === 0 ? {} : { frame: true as const }),
      });
    };
    // The page after a sign-in entry press is checked before anything else runs on it, and
    // one that blocked the entry is neither sent for generation nor logged in to (ADR 0031).
    const refusedKey = documentKey(document);
    if (!entryRefused.has(refusedKey)) {
      await runtime.checkAfterPress(live);
      if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    }
    if (entryRefused.has(refusedKey)) return refuse("entry-blocked");
    // A report sent only for the log does not log the tab's hold again.
    if (busy)
      return (shown || list || unoffered) && !start && !signIn
        ? { ok: false, reason: "tab-busy" }
        : refuse("tab-busy");
    if (!runtime.storageHealthy)
      return refuse(
        "storage-unavailable",
        undefined,
        !(await loginRelated(document.tabId, document.frameId, document.origin)),
      );
    const holder = runtime.tabAttempt(document.tabId);
    /** Logs why a move of `record` did not complete it, or that it was kept (ADR 0022). */
    const reportMove = (record: LoginAttemptMetadata, reason: MoveMiss, kept?: true) =>
      report(document, {
        type: "move",
        tabId: document.tabId,
        origin: siteOrigin,
        recipeId: record.recipeId,
        recipeRevision: record.recipeRevision,
        route: record.route,
        reason,
        ...(document.frameId === 0 ? {} : { frame: true as const }),
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
      runtime.noteSignedIn(before, ended, moved.origin);
      if (run) run.metadata = ended;
      reportAttempt(ended, run?.recipe);
      try {
        await runtime.keep(ended);
      } catch {
        return refuse("storage-unavailable");
      }
      if (ended.state === "authenticated" && run?.choice) await runtime.remember(run);
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
      if (document.frameId !== 0) {
        // The top page announcing again during a check starts another, which is waited for
        // too; each check's own hello drops it once it settles.
        for (
          let check = siteMoves.get(document.tabId), last: Promise<boolean> | undefined;
          check && check !== last;
          last = check, check = siteMoves.get(document.tabId)
        )
          // eslint-disable-next-line no-await-in-loop
          await check;
        // A check that went stale, as when the top page announced again, ended nothing.
        // A login held by a page that asked for a passkey is left to the tab's top pages.
        if (
          runtime.passkeyMoveFits(holder, document.tabId, siteOrigin) ||
          runtime.passwordMoveFits(holder, document.tabId, siteOrigin) ||
          passkeyPages.get(document.tabId)?.attemptId === holder.id
        )
          ending = false;
      } else {
        const check = runtime.passkeyMoveFits(holder, document.tabId, siteOrigin)
          ? runtime.signedInByPasskey(holder, live)
          : runtime.signedInByPassword(holder, live);
        siteMoves.set(document.tabId, check);
        try {
          signedIn = await check;
        } finally {
          if (siteMoves.get(document.tabId) === check) siteMoves.delete(document.tabId);
        }
      }
      if (hellos.get(helloKey) !== sequence || documents.get(key) !== live)
        return { ok: false, reason: "stale-document" };
      const miss: MoveMiss | undefined =
        document.frameId !== 0 ? (ending ? "no-factor" : undefined) : live.moveMiss;
      // Another page of the tab may have ended the attempt meanwhile.
      const running = () => {
        const latest = attempts.get(document.tabId)?.metadata ?? runtime.tabAttempt(document.tabId);
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
        runtime.passkeyPageFits(holder, document, siteOrigin) &&
        (passkeyPages.get(document.tabId)?.document.documentId !== document.documentId ||
          (await runtime.stillAsking(live)));
      const held =
        document.frameId === 0 && !signedIn && miss !== undefined && running() && (await asked());
      if (hellos.get(helloKey) !== sequence || documents.get(key) !== live)
        return { ok: false, reason: "stale-document" };
      if (held && running()) {
        passkeyPages.set(document.tabId, {
          attemptId: holder.id,
          document: { ...document, frameId: 0, origin: siteOrigin },
          requestedAt: Math.max(
            passkeyRequests.get(`${document.tabId} ${siteOrigin}`) ?? 0,
            passkeyPages.get(document.tabId)?.attemptId === holder.id
              ? passkeyPages.get(document.tabId)!.requestedAt
              : 0,
          ),
        });
        runtime.holdForPasskey(document.tabId);
        reportMove(holder, "passkey-request", true);
        return { ok: false, reason: "stale-document" };
      }
      const run = attempts.get(document.tabId);
      const latest = run?.metadata ?? runtime.tabAttempt(document.tabId);
      if (ending && latest?.id === holder.id && !terminal(latest)) {
        if (!signedIn && miss) reportMove(holder, miss);
        const refusal = await endMove(
          run,
          latest,
          { ...document, frameId: 0, origin: siteOrigin },
          signedIn,
        );
        if (refusal) return refusal;
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    } else if (
      holder &&
      !terminal(holder) &&
      document.frameId === 0 &&
      passkeyPages.get(document.tabId)?.attemptId === holder.id
    ) {
      // The tab came back to the attempt's origin from a page of another origin of the site
      // that asked for a passkey (ADR 0022). A passkey answered there with the attempt's
      // own item, and this page quiet, complete the attempt; otherwise it ends as that move
      // would have, without resubmitting. A page that goes away before it is read leaves
      // the decision to the tab's next page.
      const asking = passkeyPages.get(document.tabId)!;
      const check = runtime.signedInByPasskey(holder, live);
      siteMoves.set(document.tabId, check);
      let signedIn: boolean;
      try {
        signedIn = await check;
      } finally {
        if (siteMoves.get(document.tabId) === check) siteMoves.delete(document.tabId);
      }
      if (
        hellos.get(helloKey) !== sequence ||
        documents.get(key) !== live ||
        passkeyPages.get(document.tabId) !== asking
      )
        return { ok: false, reason: "stale-document" };
      const run = attempts.get(document.tabId);
      const latest = run?.metadata ?? runtime.tabAttempt(document.tabId);
      if (latest?.id === holder.id && !terminal(latest)) {
        if (live.moveMiss === "page-gone") {
          reportMove(holder, live.moveMiss, true);
          return { ok: false, reason: "stale-document" };
        }
        passkeyPages.delete(document.tabId);
        if (!signedIn && live.moveMiss) reportMove(holder, live.moveMiss);
        const refusal = await endMove(run, latest, asking.document, signedIn);
        if (refusal) return refusal;
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
    // A document resumes only its own origin's record in the tab, even an ended one, also
    // one of a site the tab left, so a login never submits there again.
    let recorded = runtime.recordFor(document.tabId, document.origin);
    const logoutKey = recordKey(document.tabId, document.origin);
    // A fill-only login is forgotten when it ends; one a stopped worker left ended is too.
    if (recorded?.fillOnly && terminal(recorded)) {
      try {
        await runtime.forget(logoutKey);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = undefined;
    }
    /**
     * Releases a tab's record for this origin as after a logout: that tab asks for an
     * account, and so do the site's other tabs (ADR 0021 D). Returns a refusal when it could
     * not, else undefined.
     */
    const releaseAsLogout = async (
      released: LoginAttemptMetadata,
    ): Promise<Readiness | undefined> => {
      const { tabId } = released.document;
      const releasedKey = recordKey(tabId, document.origin);
      const rejected = released.outcome === "credential-rejected";
      if (attempts.get(tabId)?.metadata.id === released.id) attempts.delete(tabId);
      if (picked.get(tabId)?.attemptId === released.id) picked.delete(tabId);
      // The tab must keep asking after a restart, so its logout is stored first.
      logouts.add(releasedKey);
      if (rejected) rejectedAsks.add(releasedKey);
      else rejectedAsks.delete(releasedKey);
      // The page that showed the rejection is never filled with an account again: the site
      // just refused what was filled there.
      const rejectedPage = `${tabId} ${released.document.documentId}`;
      const unfilled = rejected && !logoutFills.has(rejectedPage);
      if (unfilled) {
        logoutFills.add(rejectedPage);
        for (const old of logoutFills) {
          if (logoutFills.size <= 256) break;
          logoutFills.delete(old);
        }
      }
      try {
        await runtime.saveSession();
      } catch {
        logouts.delete(releasedKey);
        rejectedAsks.delete(releasedKey);
        if (unfilled) logoutFills.delete(rejectedPage);
        return refuse("storage-unavailable");
      }
      // Logged once the logout is stored; a failed store undoes it, and the page's next
      // announcement recognizes it again.
      report(document, {
        type: "logout",
        tabId,
        origin: document.origin,
        recipeId: released.recipeId,
        recipeRevision: released.recipeRevision,
        ...(rejected ? { rejected: true as const } : {}),
      });
      try {
        await runtime.forget(releasedKey);
      } catch {
        return refuse("storage-unavailable");
      }
      // A page of that tab admitted meanwhile may have resumed the record; it stops too.
      if (attempts.get(tabId)?.metadata.id === released.id) attempts.delete(tabId);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      return undefined;
    };
    /**
     * Ends a watched login, which never signed in, once the recipe's first step shows again,
     * as after a code or an approval expired (ADR 0027): no logout (ADR 0021 D). Only the
     * watched login's tab asks and fills, as after a stopped login, while the site's other
     * tabs log in as before (owner, 2026-10-13). Returns a refusal when it could not, else
     * undefined.
     */
    const abandonWatch = async (
      watchedLogin: LoginAttemptMetadata,
    ): Promise<Readiness | undefined> => {
      const { tabId } = watchedLogin.document;
      const watchedKey = recordKey(tabId, document.origin);
      const run = attempts.get(tabId);
      const own = run?.metadata.id === watchedLogin.id ? run : undefined;
      if (own) attempts.delete(tabId);
      if (picked.get(tabId)?.attemptId === watchedLogin.id) picked.delete(tabId);
      // The tab must keep asking after a restart, so its ask is stored first.
      stoppedAsks.add(watchedKey);
      try {
        await runtime.saveSession();
      } catch {
        stoppedAsks.delete(watchedKey);
        return refuse("storage-unavailable");
      }
      reportAttempt(
        transitionLoginAttempt(own?.metadata ?? watchedLogin, {
          type: "WATCH_ENDED",
          abandoned: true,
        }),
        own?.recipe,
      );
      try {
        await runtime.forget(watchedKey);
      } catch {
        return refuse("storage-unavailable");
      }
      // A page of that tab admitted meanwhile may have resumed the record; it stops too.
      if (attempts.get(tabId)?.metadata.id === watchedLogin.id) attempts.delete(tabId);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      return undefined;
    };
    // A watch that ran out ends the login where it stopped (ADR 0027). Its record keeps its
    // time, so it does not hold the site again.
    // The page a watch that ran out began in; another page that shows the first step then
    // asks as after a stopped login (below).
    let watchEnded: string | undefined;
    if (recorded && watchOver(recorded, Date.now())) {
      watchEnded = recorded.watch?.documentId;
      const run = attempts.get(document.tabId);
      const own = run?.metadata.id === recorded.id ? run : undefined;
      const ended = transitionLoginAttempt(own?.metadata ?? recorded, { type: "WATCH_ENDED" });
      if (own) own.metadata = ended;
      reportAttempt(ended, own?.recipe);
      try {
        await runtime.keep(ended, false);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = ended;
    }
    // While a login is watched, its recipe's first step showing in a new page of the tab
    // means the person is back at the start, as when a code or an approval expired: the
    // login never signed in, so this is no logout. It ends, and only this tab asks and fills
    // without pressing anything (ADR 0027). The page the watch began in never ends it.
    if (
      recorded?.watch &&
      document.frameId === 0 &&
      start?.path === live.path &&
      document.documentId !== recorded.watch.documentId
    ) {
      const refused = await abandonWatch(recorded);
      if (refused) return refused;
      recorded = undefined;
    }
    if (
      recorded &&
      finishedLogin(recorded) &&
      recorded.document.frameId === 0 &&
      document.frameId === 0
    ) {
      // Until the recipe's first step shows again, the page keeps watching for it. The page
      // a rejection was read in shows the sign-in form again with the failure, which may be
      // on another path, such as the one the form posted to: it asks at once.
      const rejectedHere =
        recorded.outcome === "credential-rejected" &&
        recorded.document.documentId === document.documentId;
      if (start?.path !== live.path && !rejectedHere) {
        const starts = await runtime.startsFor(document.origin);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        // Not a recipe's first step on its path, so not taken as a logout (ADR 0021 D).
        notStarted("logged-in");
        return { ok: false, reason: "logged-in", starts };
      }
      // It shows again after a finished login: a logout. Only this tab's record for this
      // origin is released, and the tab asks for an account (ADR 0021 D).
      const refused = await releaseAsLogout(recorded);
      if (refused) return refused;
      recorded = undefined;
    }
    if (
      recorded &&
      stoppedByPateat(recorded) &&
      !finishedLogin(recorded) &&
      recorded.outcome !== "account-switched" &&
      recorded.submissions === 0 &&
      recorded.document.documentId !== document.documentId
    ) {
      // A login Pateat itself stopped before submitting anything holds no tab, its own
      // included: a new page of the tab logs in as a new tab would, with the saved default
      // or by asking when several accounts match (ADR 0022). One that submitted is resumed,
      // so a site that sends the tab back to its first step never gets it again; only its
      // form showing on a later page makes the tab ask and fill (below).
      const released = recorded;
      if (attempts.get(document.tabId)?.metadata.id === released.id)
        attempts.delete(document.tabId);
      if (picked.get(document.tabId)?.attemptId === released.id) {
        picked.delete(document.tabId);
        void quietly(runtime.saveSession);
      }
      try {
        await runtime.forget(logoutKey);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = undefined;
    }
    if (
      recorded &&
      recorded.state === "blocked" &&
      !finishedLogin(recorded) &&
      recorded.outcome !== "account-switched" &&
      recorded.submissions > 0 &&
      recorded.document.frameId === 0 &&
      document.frameId === 0 &&
      // A page the watch already followed is this login's too, but not the one it began in.
      (recorded.document.documentId !== document.documentId ||
        (watchEnded !== undefined && watchEnded !== document.documentId)) &&
      // While it still holds the site against other tabs, it is resumed as before.
      !holdsSite(recorded, Date.now())
    ) {
      // A login that stopped after it submitted is resumed by the tab's later pages, so it
      // never submits again. Its form showing again on one of them asks like a logout, in
      // this tab only, and fills without pressing anything (ADR 0021 D, owner's choice
      // 2026-10-12); until then the page watches for it.
      if (start?.path !== live.path) {
        const starts = await runtime.startsFor(document.origin);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        notStarted("stopped-login");
        return { ok: false, reason: "login-stopped", starts };
      }
      const released = recorded;
      if (attempts.get(document.tabId)?.metadata.id === released.id)
        attempts.delete(document.tabId);
      if (picked.get(document.tabId)?.attemptId === released.id) picked.delete(document.tabId);
      stoppedAsks.add(logoutKey);
      try {
        await runtime.saveSession();
      } catch {
        stoppedAsks.delete(logoutKey);
        return refuse("storage-unavailable");
      }
      try {
        await runtime.forget(logoutKey);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = undefined;
    }
    // The same holds when the person starts over in another tab, such as after closing a
    // code page that expired: another tab's watched login of the site ends, so this tab logs
    // in as before instead of waiting for that login's hold to end, and only the watched
    // tab asks if its own first step shows again (ADR 0027). Only a page first seen during
    // the watch does, not one left open from before.
    if (!recorded && document.frameId === 0 && start?.path === live.path) {
      const keys = [...persisted.keys()];
      // One at a time, each read again: ending one awaits, and another watched login may
      // have moved on meanwhile.
      /* eslint-disable no-await-in-loop */
      for (const entryKey of keys) {
        const entry = persisted.get(entryKey);
        if (!entry) continue;
        const run = attempts.get(entry.document.tabId);
        const latest = run?.metadata.id === entry.id ? run.metadata : entry;
        if (
          !latest.watch ||
          watchOver(latest, Date.now()) ||
          latest.account.origin !== document.origin ||
          latest.document.tabId === document.tabId ||
          live.seenAt < latest.watch.since
        )
          continue;
        const refused = await abandonWatch(latest);
        if (refused) return refused;
      }
      /* eslint-enable no-await-in-loop */
    }
    // A logout in another tab ends the shared session too, so this tab asks as well.
    const asking =
      !recorded &&
      (logouts.has(logoutKey) ||
        stoppedAsks.has(logoutKey) ||
        runtime.askedElsewhere(document.tabId, document.origin));
    // A tab runs one attempt at a time; another one still running holds it.
    const running = runtime.tabAttempt(document.tabId);
    if (running && !terminal(running) && running.id !== recorded?.id) return refuse("tab-busy");
    // After an account switch, the tab's next document of that origin starts a new
    // attempt, which may use another recipe. It carries the switch, so it never clicks
    // another one.
    const switched = recorded?.state === "blocked" && recorded.outcome === "account-switched";
    const previous = switched ? undefined : recorded;
    // Look up the recipe first: a page without one never opens the policy catalog or vault.
    let recipe =
      probeMode && document.origin === runtime.origin
        ? previous
          ? probeRecipe(runtime.origin, `/${previous.recipeId.replace(/^demo-/, "")}`)
          : probeRecipe(runtime.origin, live.path)
        : await recipes.recipe(document.origin, live.path, previous?.recipeId);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A chooser recipe (ADR 0028): a new login on its list runs the route of its account
    // entry until it decides what to click, and a resumed one the route of its click.
    let chooser: LoginChooserRecipe | undefined;
    if (
      !recipe &&
      !(probeMode && document.origin === runtime.origin) &&
      (!previous || previous.chooser)
    ) {
      chooser = await Promise.resolve(
        recipes.chooser?.(document.origin, live.path, previous?.recipeId),
      ).catch(() => undefined);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (chooser) recipe = chooserRoute(chooser, previous?.chooser?.click ?? "entry");
    }
    // A new attempt starts only once the document reports a first step of its recipe ready:
    // any route's or variant's, or the path alone when one of them needs no element. Until
    // then it watches the first steps of every recipe for its origin; this reads no
    // settings, policy catalog or vault.
    if (
      !previous &&
      (!recipe ||
        (recipeStartSteps(recipe).every((step) => loginReadiness(step).targets.length) &&
          start?.path !== live.path))
    ) {
      const starts = await runtime.startsFor(document.origin);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // A site's sign-in entry on this path is pressed once its checks pass (ADR 0031).
      const entryRecipe =
        recipe || document.frameId !== 0 || live.topUrl
          ? undefined
          : (await recipes.entries(document.origin).catch(() => [])).find(
              (candidate) => candidate.entry.path === live.path,
            );
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (entryRecipe) {
        live.state = "watching";
        delete live.reason;
        await publish(live);
        void runtime
          .pressEntry(live, entryRecipe)
          .catch(() => runtime.refuseEntry(live, entryRecipe, "exception"));
        return { ok: false, reason: "entry", starts };
      }
      const availability = recipe ? undefined : await runtime.offersGeneration(live);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      let offer = availability === true;
      // Only a page that was sent is held, so the log says why it is not sent again.
      if (availability === "sending" || availability === "sent")
        runtime.skipGeneration(live, availability);
      // Without the service no page is sent; logged at debug level, as every page is.
      if (availability === "not-connected") runtime.skipGeneration(live, availability);
      const shownList = !signIn && list?.path === live.path ? list : undefined;
      // A shown email address that is no list entry is logged only (ADR 0028).
      if (offer && shownList?.missed)
        runtime.skipGeneration(live, "not-a-list", undefined, shownList.missed);
      const listing = shownList && (shownList.names || !shownList.missed) ? shownList : undefined;
      // A page whose URL names another path of its site may be sent as a sign-in entry
      // once no sign-in input showed (ADR 0031); a list of accounts goes first.
      const entryPage =
        offer && namesReturnPath(new URL(live.url), sameSiteAs(live.url)) ? true : undefined;
      const entryOffer = !signIn && entryHello?.path === live.path;
      // A list announced only for the log is never sent, but may hold the site's entry.
      if (shownList && !listing && !entryOffer) offer = false;
      // The page right after a sign-in is never sent as a list of accounts (ADR 0028) or as
      // a sign-in entry.
      if (offer && listing && afterSignIn.get(document.tabId) === document.documentId) {
        // Logged for a list with an email, one with a control for another account, or an
        // offered entry only: short texts alone are ordinary browsing.
        if (!listing.names || listing.other || entryOffer)
          runtime.skipGeneration(live, "after-sign-in");
        offer = false;
      }
      // Nor as a page that asks for an identifier alone (ADR 0016), such as a profile page
      // with an email field.
      if (offer && signIn?.identifier && afterSignIn.get(document.tabId) === document.documentId) {
        runtime.skipGeneration(live, "after-sign-in");
        offer = false;
      }
      if (offer && (signIn?.path === live.path || listing)) {
        let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
        const scope = await runtime
          .generationSlotsFor(live, (...reason) => {
            missed = reason;
          })
          .catch(() => undefined);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        // Without an email listed, a shown text must name a matching item's username. A
        // list on a page whose path holds one is not sent: the page would be refused as
        // `username-shown` once read (owner 2026-10-12 19:45 UTC).
        const listed =
          scope && listing
            ? await runtime.listedNames(live.document.origin, scope, listing.names ?? [], live.path)
            : undefined;
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        const names = listing?.names ? listed?.names : undefined;
        // Or the page shows a control to sign in with another account (ADR 0028, owner
        // 2026-10-12 19:11 UTC), as Instagram's list of a profile whose username is not the
        // item's: then every shown text is hidden from the page sent, as a possible account
        // name, and the login continues through that control.
        const otherOnly =
          !names?.length && listing?.names && listing.other ? listing.names : undefined;
        // A list by email lists no account a matching item's username that is not an email
        // can be chosen by: it is sent only for its control for another account.
        const unmatched = listing && !listing.names && !listing.other && listed?.email === false;
        if (
          scope &&
          !listed?.inPath &&
          !unmatched &&
          (!listing?.names || names?.length || otherOnly)
        ) {
          live.state = "generating";
          delete live.reason;
          await publish(live);
          void runtime.generateFor(
            live,
            scope,
            listing ? { names: otherOnly ?? names ?? [] } : undefined,
          );
          return { ok: false, reason: "generating" };
        }
        // No vault item matches this page, the vault could not tell, or no shown text names
        // an item's username, so it is not sent. A page offered only by its short texts is
        // mostly ordinary browsing, so that is logged at debug level (ADR 0019): most pages
        // show a short text beside a button. Such a page may still hold the site's sign-in
        // entry.
        if (listed?.inPath)
          runtime.skipGeneration(live, "no-listed-account", undefined, "username-in-path");
        else if (unmatched)
          runtime.skipGeneration(live, "no-listed-account", undefined, "no-email-username");
        else if (!listing?.names) runtime.skipGeneration(live, missed[0], undefined, missed[1]);
        else
          runtime.skipGeneration(
            live,
            "no-listed-account",
            undefined,
            scope
              ? (listing.otherMiss ?? "no-name-match")
              : logCode(missed.filter(Boolean).join(":")),
          );
        // A page whose path holds a username is not sent as a sign-in entry either.
        if (listed?.inPath || !(listing?.names && entryOffer)) offer = false;
      }
      if (offer && entryOffer) {
        const refusal = entryPage ? await runtime.entryOfferRefusal(live) : "no-return-target";
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if (!refusal) {
          live.state = "generating";
          delete live.reason;
          await publish(live);
          void runtime.generateEntryFor(live);
          return { ok: false, reason: "generating" };
        }
        runtime.skipGeneration(live, refusal, "entry");
        offer = false;
      }
      // A page offered for generation that showed nothing to send by the end of the step
      // wait is logged with why; mostly ordinary browsing, so at debug level (ADR 0019).
      // The tab's next document after a submitted password form is known only here.
      if (offer && unoffered?.path === live.path && !signIn && !shownList && !entryOffer)
        runtime.skipGeneration(
          live,
          "nothing-offered",
          undefined,
          unoffered.why === "no-list" && afterSignIn.get(document.tabId) === document.documentId
            ? "after-sign-in"
            : unoffered.why,
        );
      // No recipe of the origin and no login in the tab: ordinary browsing (ADR 0019).
      if (!recipe && !starts.length && !offer) return refuse("recipe-not-found", undefined, true);
      // Only an origin with a recipe: elsewhere every sign-in page would be logged.
      if (starts.length) notStarted(recipe ? "first-step-missing" : "no-recipe-on-path");
      live.state = "watching";
      delete live.reason;
      await publish(live);
      return {
        ok: false,
        reason: recipe ? "form-not-ready" : "recipe-not-found",
        starts,
        ...(offer ? { generate: true as const } : {}),
        ...(offer && entryPage ? { entry: true as const } : {}),
      };
    }
    // A resumed attempt keeps its own recipe revision; a replaced or different recipe never
    // takes it over. A newer revision that only adds handlers or markers is taken over
    // when this worker still holds the recorded one to compare (ADR 0027); after a restart
    // only the recorded revision resumes.
    let revised = false;
    if (
      previous &&
      recipe &&
      previous.recipeId === recipe.id &&
      previous.recipeRevision !== recipe.revision
    ) {
      const known = attempts.get(document.tabId);
      const held =
        known?.metadata.id === previous.id &&
        known.recipe.id === previous.recipeId &&
        known.recipe.revision === previous.recipeRevision
          ? known.recipe
          : undefined;
      // A cache that lags behind the attempt keeps the attempt's own recipe.
      if (held && recipe.revision < held.revision) recipe = held;
      else if (held && extendsRecipe(held, recipe)) revised = true;
      // A revision that continues the recipe after its final advance is taken over on the
      // page, after the same checks as an answer to the continuation (ADR 0018); until then
      // the attempt keeps its own revision.
      else if (
        held &&
        previous.operationEffect === "advance" &&
        previous.stepIndex + 1 === previous.stepCount &&
        continuesRecipe(held, recipe)
      )
        recipe = held;
      else recipe = undefined;
    }
    if (
      !recipe ||
      recipe.origin !== document.origin ||
      (previous && previous.recipeId !== recipe.id)
    )
      return refuse("recipe-not-found");
    const savedBefore = runtime.remembered;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return refuse(snapshot.error.code);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A close/navigation can happen while settings storage was awaited.
    try {
      const tab = await browser.tabs.get(document.tabId);
      if (
        !tab.url ||
        documents.get(key) !== live ||
        (live.topUrl
          ? new URL(tab.url).origin !== new URL(live.topUrl).origin
          : new URL(tab.url).origin !== document.origin || new URL(tab.url).pathname !== live.path)
      )
        return refuse("stale-document");
    } catch {
      return refuse("closed-tab");
    }
    if (asking && runtime.heldElsewhere(document.tabId, document.origin)) {
      runtime.showHeld(document.tabId);
      return refuse("origin-busy");
    }
    // A new login reads its item's facts once and chooses its route from them (ADR 0027);
    // a resumed one keeps those in its record, so a sync cannot change its route.
    // After a logout, a document is filled once with the single account to use, without
    // pressing anything (ADR 0021 D); the passkey route has nothing to fill.
    const filledKey = `${document.tabId} ${document.documentId}`;
    const fill = asking && !previous && !switched && !logoutFills.has(filledKey);
    // A new login answers the page's own passkey request when its item holds a passkey
    // (ADR 0034), as one picked in the popup after a logout and one on a chooser's list do,
    // instead of clicking there; a login that only fills after a logout keeps its form.
    const pageRequest =
      !previous && document.frameId === 0 && runtime.parkedFor(document) !== undefined;
    let plan = await runtime.planFor(snapshot, live, recipe, {
      asking,
      fill,
      ...(previous ? { route: attemptRouteChoice(previous) } : {}),
      ...(pageRequest ? { pageRequest } : {}),
    });
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (plan.ok && "fillOnly" in plan && plan.route.route !== "password") {
      plan = await runtime.planFor(snapshot, live, recipe, { asking });
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
    // A passkey-only item on a list whose account branch cannot take the stop (ADR 0036,
    // owner 2026-10-13 06:32 UTC: the account's row, else "another account") still reads
    // the list first, planned on the click alone: it goes on only through `other`, and is
    // refused with the account branch's reason, pressing nothing, when its row fits.
    let deferred: { route: LoginRecipe; detail?: string } | undefined;
    if (!plan.ok && plan.reason === "no-route" && !previous && chooser) {
      const { afterAccount: _afterAccount, ...lists } = chooser.chooser;
      const bare = chooserRoute({ ...chooser, chooser: lists }, "entry");
      const alone =
        bare &&
        (await runtime.planFor(snapshot, live, bare, {
          asking,
          fill,
          ...(pageRequest ? { pageRequest } : {}),
        }));
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (bare && alone && alone.ok && "stopAt" in alone && !("fillOnly" in alone)) {
        deferred = {
          route: bare,
          ...("detail" in plan && typeof plan.detail === "string" ? { detail: plan.detail } : {}),
        };
        plan = alone;
      }
    }
    if (!plan.ok) {
      // Only a fresh start can be restarted with a picked account (ADR 0021). The page
      // after an account switch belongs to that login, so it offers none.
      if (!previous && !switched && "candidates" in plan && plan.candidates) {
        const logout = "logout" in plan && plan.logout === true;
        runtime.offerChoice(
          document,
          plan.candidates,
          logout ? runtime.logoutDetail(recordKey(document.tabId, document.origin)) : undefined,
        );
        // Outside a logout, the page's own conditional request may wait for the pick, on a
        // recipe without a passkey button (ADR 0034).
        runtime.noteChoice(
          document,
          plan.candidates,
          !logout && document.frameId === 0 && passkeyAnswersRequest(recipe),
        );
      }
      const refused = await refuse(
        plan.reason,
        "detail" in plan && typeof plan.detail === "string"
          ? plan.detail
          : plan.reason === "logged-out"
            ? // Which tab logged out: this one, or another tab of the site (ADR 0021 D).
              runtime.logoutDetail(logoutKey)
            : // No vault item matches the page, which a vault sync may change.
              "noUriMatch" in plan && plan.noUriMatch
              ? "no-uri-match"
              : undefined,
        undefined,
        "candidates" in plan && plan.candidates ? plan.candidates.length : undefined,
      );
      // Asked while the page still holds vault replacement off, so a check started by
      // this page's announcement cannot apply before the miss is registered.
      if (!previous && !switched && "noUriMatch" in plan && plan.noUriMatch)
        runtime.retryAfterSync(live, plan.reason);
      return refused;
    }
    if (runtime.heldElsewhere(document.tabId, document.origin)) {
      runtime.showHeld(document.tabId);
      return refuse("origin-busy");
    }
    // A new login on a chooser's list decides what it clicks there for its account (ADR
    // 0028), and takes the route that click leads to. A fill-only login presses nothing.
    let click: ChooserClick | "none" | undefined;
    let listMiss: ListMiss | undefined;
    if (!previous && chooser && !("fillOnly" in plan)) {
      const chosen = await runtime.listClick(snapshot, live, chooser, plan.account);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // Without the account's username nothing on the list can be compared with it.
      if (chosen === "unreadable") return refuse("field-unavailable", "list-username");
      // The page no longer shows the list, or could not be asked: it announces again.
      if (!chosen) return { ok: false, reason: "stale-document" };
      if (typeof chosen === "string") click = chosen;
      else {
        click = "none";
        listMiss = chosen;
      }
      // The account's row or its button leads to the branch that cannot take the stop.
      if (deferred && (click === "entry" || click === "continue"))
        return refuse("no-route", deferred.detail);
      // Nothing fits and there is no button: the login ends on the click alone's route.
      if (deferred && click === "none") recipe = deferred.route;
      if (click === "other" || click === "continue") {
        const route = chooserRoute(chooser, click);
        if (!route) return refuse("recipe-not-found");
        // Another branch's route has other slots, and is planned again for the same account.
        if (click === "other") {
          const replanned = await runtime.planFor(snapshot, live, route, {
            asking,
            ...(pageRequest ? { pageRequest } : {}),
          });
          if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
          // An item without a password goes on only when that branch can take its stop
          // (ADR 0036); the log names why not, as for the list's own route.
          if (!replanned.ok)
            return refuse(
              replanned.reason,
              "detail" in replanned && typeof replanned.detail === "string"
                ? replanned.detail
                : undefined,
            );
          // The click was chosen for the planned account; another one is not logged in.
          if (
            replanned.account.connectionId !== plan.account.connectionId ||
            replanned.account.itemId !== plan.account.itemId
          )
            return refuse("account-changed", "list-other");
          plan = replanned;
        }
        recipe = route;
      }
    }
    if (!previous) {
      // Another login's account choice, being saved now or saved since this snapshot was read,
      // bumps the revision this new login would be checked against: it is admitted again.
      await choicesSaved();
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (savingChoices.size || runtime.remembered !== savedBefore)
        return { ok: false, reason: CHOICE_SAVED };
      if (runtime.heldElsewhere(document.tabId, document.origin)) {
        runtime.showHeld(document.tabId);
        return refuse("origin-busy");
      }
    }
    if (!previous && persisted.size >= 100) return refuse("attempt-limit");
    // Another document of the tab, such as a frame, may have started an attempt while this
    // one was checked, and the tab runs one attempt at a time. Nothing below awaits until
    // the attempt is registered.
    const latest = runtime.tabAttempt(document.tabId);
    if (
      runtime.recordFor(document.tabId, document.origin)?.id !== recorded?.id ||
      (latest && !terminal(latest) && latest.id !== recorded?.id)
    )
      return refuse("tab-busy");
    let metadata: LoginAttemptMetadata;
    let resumedPolicy: PolicyChange | undefined;
    if (previous) {
      let resumed = recoverLoginAttempt(previous);
      // The page left the document a TOTP code was filled into before its click,
      // as a code input that submits on its last digit does: the page submitted the code
      // itself, and it is never filled again (ADR 0027).
      if (previous.document.documentId !== document.documentId && codeAwaitsClick(recipe, resumed))
        resumed = transitionLoginAttempt(resumed, autoSubmitted(recipe, resumed));
      metadata = transitionLoginAttempt(resumed, {
        type: "NAVIGATED",
        document,
      });
      if (revised)
        metadata = transitionLoginAttempt(metadata, {
          type: "REVISED",
          recipeRevision: recipe.revision,
        });
      if (metadata.policyRevision !== snapshot.snapshot.revision && !terminal(metadata)) {
        // A watched login keeps watching while the newer settings still plan its account
        // (ADR 0027).
        const kept =
          metadata.watch !== undefined &&
          snapshot.snapshot.revision > metadata.policyRevision &&
          plan.ok &&
          plan.account.connectionId === metadata.account.connectionId &&
          plan.account.itemId === metadata.account.itemId;
        metadata = transitionLoginAttempt(
          metadata,
          kept
            ? { type: "POLICY_REVISED", policyRevision: snapshot.snapshot.revision }
            : { type: "POLICY_CHANGED" },
        );
        if (!kept) resumedPolicy = { cause: "settings-revision" };
      }
    } else {
      // A new login's plan carries the facts it chose its route with.
      if (!("facts" in plan)) return refuse("no-route");
      metadata = transitionLoginAttempt(
        createAttemptMetadata({
          id: newId(),
          recipe,
          policyRevision: snapshot.snapshot.revision,
          account: {
            origin: document.origin,
            connectionId: plan.account.connectionId,
            itemId: plan.account.itemId,
          },
          choice: plan.route,
          ...("fallback" in plan ? { fallback: plan.fallback } : {}),
          facts: plan.facts,
          document,
          ...(document.frameId === 0 ? {} : { pageOrigin: siteOrigin }),
          accountSwitched: switched,
          fillOnly: "fillOnly" in plan,
          ...(chooser
            ? { chooser: click === undefined || click === "none" ? "entry" : click }
            : {}),
          // An item without a password stops before it (ADR 0036).
          ...("stopAt" in plan && typeof plan.stopAt === "number" ? { stopAt: plan.stopAt } : {}),
        }),
        { type: "RESOLVE" },
      );
      // No listed account fits, and the list has no button for another one (ADR 0028).
      if (click === "none") metadata = transitionLoginAttempt(metadata, { type: "NOT_LISTED" });
    }
    const run: Execution = {
      metadata,
      recipe,
      live,
      running: false,
      ...(chooser && metadata.chooser ? { chooser } : {}),
      // Each document re-derives the choice; every step still checks it is the attempt's account.
      ...(plan.choice &&
      !terminal(metadata) &&
      plan.account.connectionId === metadata.account.connectionId &&
      plan.account.itemId === metadata.account.itemId
        ? { choice: plan.choice }
        : {}),
      ...("asked" in plan ? { asked: plan.asked } : {}),
    };
    // A new document after an advance on the same path, as a form posted back to its own
    // path, is checked against what the advancing document showed before it (ADR 0013).
    const before = attempts.get(document.tabId);
    if (
      before?.inPlace &&
      before.metadata.id === metadata.id &&
      before.inPlace.operationId === metadata.operationId
    )
      run.inPlace = before.inPlace;
    attempts.set(document.tabId, run);
    runtime.reviewRequests();
    if (!previous)
      report(document, {
        type: "start",
        tabId: document.tabId,
        origin: document.origin,
        recipeId: metadata.recipeId,
        recipeRevision: metadata.recipeRevision,
        route: metadata.route,
        ...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
        ...("chosen" in plan && plan.chosen
          ? {
              account: plan.chosen.source,
              ...(plan.chosen.candidates === undefined
                ? {}
                : { candidates: plan.chosen.candidates }),
              ...(plan.chosen.source === "match" ? { itemId: metadata.account.itemId } : {}),
            }
          : {}),
        ...(metadata.fillOnly ? { fillOnly: true as const } : {}),
        ...(click ? { click } : {}),
        ...(listMiss ? { listMiss } : {}),
      });
    // Each new document of the tab resumes the attempt; only a change is news.
    reportAttempt(
      metadata,
      recipe,
      resumedPolicy,
      previous && metadata.state === previous.state && metadata.outcome === previous.outcome
        ? { repeat: true }
        : {},
    );
    // A page that resumes a login stopped after a submission while it still holds the site
    // (ADR 0022) does nothing, and says why once (ADR 0019).
    if (
      previous?.state === "blocked" &&
      metadata.state === "blocked" &&
      previous.submissions > 0 &&
      holdsSite(previous, Date.now())
    )
      note(document, live.url, "not-started", "stopped-login");
    runtime.clearChoice(document.tabId);
    // A hold's tooltip no longer applies once the tab logs in.
    badge.note(document.tabId, undefined);
    const pick = picked.get(document.tabId);
    if (
      !previous &&
      pick?.connectionId === plan.account.connectionId &&
      pick.itemId === plan.account.itemId &&
      (pick.attemptId === undefined
        ? pick.documentId === document.documentId
        : // The login a pick started goes on past an account switch.
          switched && pick.attemptId === recorded?.id)
    ) {
      pick.attemptId = metadata.id;
      void quietly(runtime.saveSession);
    }
    // A login started after a logout ends the tab's asking for this origin; filling the
    // page only does not, and the document is not filled again.
    if (metadata.fillOnly) {
      logoutFills.add(filledKey);
      for (const old of logoutFills) {
        if (logoutFills.size <= 256) break;
        logoutFills.delete(old);
      }
      void quietly(runtime.saveSession);
    } else if (!previous) {
      const loggedOut = logouts.delete(logoutKey);
      rejectedAsks.delete(logoutKey);
      if (stoppedAsks.delete(logoutKey) || loggedOut) void quietly(runtime.saveSession);
    }
    await runtime.save(run);
    await publish(live, metadata);
    void runtime.drive(run);
    // A page of a watched login watches for the recipe's first step, which ends the
    // login (ADR 0027).
    if (metadata.watch && document.documentId !== metadata.watch.documentId) {
      const starts = await runtime.startsFor(document.origin);
      if (documents.get(key) === live) return { ok: true, starts };
    }
    return { ok: true };
  }
  return { admitting, note, afterSignIn, trusted, identify, passwordSubmits, ready, hellos };
}
