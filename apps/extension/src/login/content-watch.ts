import * as v from "valibot";
import { type LoginTarget } from "@pateat/contracts";
import { autocompleteTokens } from "../page/targets";
import { closestAcross, formOf, inputsOf, readingPage, shadowRoots } from "../page/shadow";
import { targetState } from "../page/target-state";
import { answerInput, identifierInput } from "../page/identifier-field";
import { showsAmount } from "../page/amount";
import { visible } from "../page/code-submission";
import { askDefinitions, ELEMENT_DEFINED } from "../page/element-definitions";
import { nextFrame } from "../page/frames";
import { watchFrameShown } from "../page/frame-shown";
import { breaksQuiet, pageWatch, settled } from "../page/quiet";
import {
  listedAccounts,
  listsAccounts,
  logOnly,
  noInputOffer,
  type ListedAccounts,
} from "./no-input-offer";
import { sendMessage } from "../messaging/protocol";
import {
  LOGIN_STEP_WAIT_MS,
  readySchema,
  START_TRIES,
  type LoginReadiness,
  LATER_MISSES,
  type ShownLater,
  type StartMiss,
} from "./wire";
import type { ContentState } from "./content-state";
import {
  pagePath,
  pageUrl,
  matches,
  ready,
  stepMiss,
  showsSignIn,
  navigationStatus,
  checkGapMs,
  offerQuietMs,
  offerWaitMs,
  accountQuietMs,
  accountWaitMs,
  lookOnChange,
} from "./content-dom";

type WatchState = Pick<
  ContentState,
  | "afterSubmit"
  | "announced"
  | "announcedPath"
  | "at"
  | "cancelled"
  | "carrying"
  | "checkedAt"
  | "checking"
  | "confirmPage"
  | "ended"
  | "entryOffered"
  | "entryWanted"
  | "followed"
  | "frameLooks"
  | "generate"
  | "inTab"
  | "lateWatch"
  | "mayOffer"
  | "navigation"
  | "observedRoots"
  | "observer"
  | "offerCap"
  | "offerQuiet"
  | "offerUrl"
  | "offerWindow"
  | "offered"
  | "offeredPaths"
  | "personSubmits"
  | "rejected"
  | "retries"
  | "routePath"
  | "shown"
  | "shownTimer"
  | "ssoCarrying"
  | "starts"
  | "submitListeners"
  | "submitPath"
  | "submitRoots"
  | "timer"
  | "token"
  | "urlWatch"
  | "waits"
>;

export function createContentWatch(session: WatchState) {
  session.inTab = watchFrameShown(window, () => {
    if (session.cancelled || !session.inTab.shown()) return;
    // A decision already taken in the offer's window is taken again, after the page's quiet.
    if (session.offerWindow !== undefined && !session.offered) {
      clearDecision();
      session.offerQuiet = setTimeout(decideOffer, offerQuietMs);
      session.offerCap = setTimeout(decideOffer, offerWaitMs);
    }
    if (session.observer) schedule();
    for (const look of session.frameLooks) look();
  });
  // These resources originally follow frame visibility registration.
  session.observedRoots = new WeakSet<ShadowRoot>();
  session.submitRoots = new WeakSet<ShadowRoot>();
  session.submitListeners = new AbortController();
  session.navigation = (globalThis as unknown as { navigation?: EventTarget }).navigation;

  // Checks at the page's next frame after a change, however many changes come before it
  // (ADR 0082), and at most once per `checkGapMs`, so a page that changes every frame, as
  // a spinner does, is not checked every frame while it is watched. A pending retry
  // checks then instead.
  const schedule = () => {
    if (session.checking || session.timer !== undefined) return;
    session.checking = true;
    const run = () => {
      session.checking = false;
      if (session.timer === undefined) check();
    };
    const gap = session.checkedAt + checkGapMs - Date.now();
    if (gap <= 0) void nextFrame().then(run);
    else setTimeout(() => void nextFrame().then(run), gap);
  };

  function clearDecision(): void {
    clearTimeout(session.offerQuiet);
    session.offerQuiet = undefined;
    clearTimeout(session.offerCap);
    session.offerCap = undefined;
  }

  function clearOffer(): void {
    clearDecision();
    clearTimeout(session.offerWindow);
    session.offerWindow = undefined;
  }

  // A DOM change or a same-document URL change: check the starts, and wait again for quiet
  // while the decision is pending.
  const pageChanged = () => {
    schedule();
    if (session.offerCap === undefined) return;
    clearTimeout(session.offerQuiet);
    session.offerQuiet = setTimeout(decideOffer, offerQuietMs);
  };

  // Every DOM change checks the starts; only some restart a pending decision's quiet wait
  // (`breaksQuiet`).
  const domChanged = (records: MutationRecord[]) => {
    if (session.offerCap !== undefined && records.some(breaksQuiet)) pageChanged();
    else schedule();
  };

  function unwatch(): void {
    clearOffer();
    clearTimeout(session.shownTimer);
    session.shownTimer = undefined;
    session.observer?.disconnect();
    session.observer = undefined;
    clearTimeout(session.timer);
    session.timer = undefined;
    removeEventListener(ELEMENT_DEFINED, schedule);
    removeEventListener("popstate", pageChanged);
    session.navigation?.removeEventListener("currententrychange", pageChanged);
  }

  /**
   * Decides what a page offered for generation that showed no sign-in input is. When it is
   * nothing to send, a sign-in input may still be offered until the window ends.
   */
  function decideOffer(): void {
    readingPage(decideOfferNow);
  }

  function decideOfferNow(): void {
    clearDecision();
    // A shadow root attached since the last check is no change the page watch sees, so a
    // sign-in input it holds is checked for now (ADR 0070).
    if (!session.cancelled && showsSignIn()) check();
    // A page that shows no sign-in input by now may list accounts (ADR 0028) or, when
    // its URL names another path of its site, hold the site's sign-in entry (ADR
    // 0031), ask for an account identifier alone (ADR 0016) or show a passkey button (ADR
    // 0053). The page right after a submitted sign-in form offers none of them.
    // A frame that does not show yet offers nothing (ADR 0086).
    const bare =
      !session.cancelled &&
      !session.starts.some(ready) &&
      !showsSignIn() &&
      !afterSubmitted() &&
      session.inTab.shown();
    // A page asking a secret answer is a verification, never a site's sign-in entry, even
    // when its URL names the page it guards (ADR 0035, #1376): it waits for the window,
    // which counts it.
    const answer = bare && answerInput(document);
    const noInput = bare
      ? noInputOffer(document, session.entryWanted && !session.entryOffered && !answer)
      : undefined;
    // Nothing to send yet, or a list announced only for the log, which waits for the window.
    // Short texts beside the button of a page asking a secret answer name no account: the
    // page waits for the window too, which counts it (ADR 0035).
    if (
      !noInput ||
      (noInput.kind === "list" &&
        !noInput.entry &&
        noInput.accounts &&
        (logOnly(noInput.accounts) || (noInput.accounts.names && answer)))
    )
      return;
    if (noInput.kind !== "identifier" && noInput.entry) session.entryOffered = true;
    session.offered = true;
    watch(session.starts);
    // A passkey page also carries its list and entry, which the runtime uses when no
    // matching item holds a passkey (ADR 0053).
    if (noInput.kind === "identifier") void announce(false, "identifier").catch(() => undefined);
    else
      void announce(
        false,
        noInput.kind === "passkey" ? "passkey" : false,
        noInput.accounts,
        noInput.entry,
      ).catch(() => undefined);
  }

  /** Ends the window in which a page that showed nothing else is offered a sign-in input. */
  function endOffer(): void {
    readingPage(endOfferNow);
  }

  function endOfferNow(): void {
    session.offered = true;
    watch(session.starts);
    watchLate();
    const bare =
      !session.cancelled && !session.starts.some(ready) && !showsSignIn() && !afterSubmitted();
    const accounts = bare && !answerInput(document) ? listedAccounts(document) : undefined;
    if (accounts && logOnly(accounts)) void announce(false, false, accounts).catch(() => undefined);
    // Nothing was sent: the log says why (ADR 0019). A secret answer of `type="text"` looks
    // like a verification that is never sent, so it is counted (ADR 0035) when no sign-in
    // reason holds, also on a page with a list of accounts.
    else if (!session.cancelled && !session.starts.some(ready))
      void sendMessage("login", {
        version: 1,
        type: "login.document.ready",
        token: session.token,
        unoffered: {
          path: pagePath(),
          why: afterSubmitted()
            ? "after-sign-in"
            : showsSignIn()
              ? "sign-in-shown"
              : answerInput(document)
                ? "text-answer"
                : "no-list",
        },
      }).catch(() => undefined);
  }

  function watch(list: LoginReadiness[], offer = false, entryPage = false): void {
    session.starts = list;
    session.generate = offer && !session.offered;
    session.entryWanted = session.generate && entryPage;
    if (!session.generate) clearOffer();
    else if (session.offerWindow === undefined) {
      session.offerUrl = pageUrl();
      session.offerQuiet = setTimeout(decideOffer, offerQuietMs);
      session.offerCap = setTimeout(decideOffer, offerWaitMs);
      session.offerWindow = setTimeout(endOffer, LOGIN_STEP_WAIT_MS);
    }
    // A page Pateat does not fill keeps watching until its first step is reported (ADR 0035).
    const confirmWaiting =
      session.confirmPage !== undefined && !session.shown.has(session.confirmPage.path);
    if ((!session.starts.length && !session.generate && !confirmWaiting) || session.cancelled) {
      unwatch();
      return;
    }
    if (!session.observer) {
      session.observer = new MutationObserver(domChanged);
      session.observer.observe(document, pageWatch);
      session.observedRoots = new WeakSet();
      watchShadowRoots();
      addEventListener(ELEMENT_DEFINED, schedule);
      addEventListener("popstate", pageChanged);
      session.navigation?.addEventListener("currententrychange", pageChanged);
    }
  }

  /**
   * After an account switch this document may change in place, as a single-page app shows
   * its form for another account (Duolingo, 2026-10-23): once it has settled, it is
   * announced as a new page, so a recipe that starts there starts a new attempt and a page
   * without one may be offered for generation once more (ADR 0078). Only a page that
   * no longer shows the switch changed in place: one that still does is waiting for the
   * next document, which announces itself.
   */
  async function switchedInPlace(element: HTMLElement): Promise<void> {
    await settled(document, accountQuietMs, Date.now() + accountWaitMs);
    if (session.cancelled || (element.isConnected && visible(element))) return;
    session.ended = false;
    session.announced = false;
    session.retries = 0;
    session.offered = false;
    // The new page's window offers its input; a late look would offer it twice.
    session.lateWatch?.();
    void announce(false, false, undefined, false, true).catch(() => undefined);
  }

  function retry(): void {
    if (!session.observer) return;
    session.retries += 1;
    if (session.retries >= START_TRIES) return;
    session.announced = false;
    clearTimeout(session.timer);
    session.timer = setTimeout(check, 500);
  }

  /**
   * Watches the shadow trees found since the last check as the document is watched, and
   * asks to hear when the page defines an element it has not defined yet: the element may
   * attach a shadow root and render into it then, which no observer reports (ADR 0070,
   * ADR 0082).
   */
  function watchShadowRoots(): void {
    const roots = shadowRoots(document);
    // After the read: the ask runs the page's listeners, which a read must not.
    queueMicrotask(() => askDefinitions(document, roots));
    for (const root of roots) {
      if (session.observer && !session.observedRoots.has(root)) {
        session.observer.observe(root, pageWatch);
        session.observedRoots.add(root);
      }
      if (!session.submitRoots.has(root)) {
        session.submitRoots.add(root);
        root.addEventListener("submit", onSubmit, {
          capture: true,
          signal: session.submitListeners.signal,
        });
      }
    }
  }

  // Announce once per appearance; a form that disappears and reappears announces again.
  function check(): void {
    readingPage(checkNow);
  }

  function checkNow(): void {
    clearTimeout(session.timer);
    session.timer = undefined;
    session.checkedAt = Date.now();
    if (!session.observer) return;
    watchShadowRoots();
    noteConfirm();
    const startable = session.starts.some(ready);
    // A step that shows on another path of the same document is a new appearance too, as
    // the password step a single-page app renders in place of its email step (ADR 0049).
    if (startable && session.announced && session.announcedPath !== pagePath()) {
      session.announced = false;
      session.retries = 0;
    }
    if (startable && !session.announced) void announce(true).catch(retry);
    else if (!startable) {
      session.announced = false;
      session.retries = 0;
      // Offered once per page; the background keeps its own daily limit as well.
      if (session.generate && !session.offered && showsSignIn() && session.inTab.shown()) {
        session.offered = true;
        session.offeredPaths.add(pagePath());
        // The page's one offer: the window's end would only report it for the log, and
        // could overtake this announcement in the worker.
        clearOffer();
        void announce(false, true).catch(() => undefined);
      }
      noteShown();
    }
  }

  /** The first steps watched on this path, other than a chooser's list or a later step. */
  function watchedHere(): LoginReadiness[] {
    const path = pagePath();
    return session.starts.filter((start) => start.path === path && !start.accounts && !start.later);
  }

  /**
   * Whether the page asks for a sign-in: a password, username or one-time-code input, or,
   * where a first step is watched on this path, an identifier alone (ADR 0016), as a
   * recipe's identifier-first start page does (ADR 0041).
   */
  function asksSignIn(): boolean {
    return showsSignIn() || (watchedHere().length > 0 && identifierInput(document) === "sole");
  }

  /**
   * Whether a path where a first step is watched lists accounts by email instead of asking
   * for a sign-in, as a start page that became a list of accounts (ADR 0028, ADR 0041).
   */
  function listsHere(): boolean {
    return watchedHere().length > 0 && !showsSignIn() && listsAccounts(document);
  }

  /**
   * What the first steps watched on this path miss (ADR 0041): the targets that match no
   * element, several, or one not rendered, and the HTTP status of this document's load, which a maintenance
   * page served on the login page's URL usually answers with (503). Undefined where no
   * first step is watched. A chooser's list counts too, so a chooser path that shows a
   * form instead carries what it missed, for its repair as a form (ADR 0041 section 6).
   */
  function startMiss(): StartMiss | undefined {
    const path = pagePath();
    const watched = session.starts.filter((start) => start.path === path && !start.later);
    if (!watched.length) return undefined;
    const missing = new Map<string, LoginTarget>();
    let found = false;
    for (const start of watched) {
      let all = true;
      for (const target of start.targets) {
        const state = targetState(document, target, start.require);
        // An element still not rendered after the step wait counts as missing, as a form a
        // page swapped for another and kept hidden: only a shown one may be a slow page's.
        if (
          state === "missing" ||
          state === "ambiguous" ||
          targetState(document, target, "shown") === "unusable"
        ) {
          missing.set(JSON.stringify(target), target);
          all = false;
        }
      }
      found ||= all;
    }
    const status = navigationStatus();
    const listed = [...missing.values()];
    return {
      missing: listed.slice(0, 20),
      // The worker cannot tell found targets from unlisted ones past the limit.
      ...(listed.length > 20
        ? { more: true as const, ...(found ? { found: true as const } : {}) }
        : {}),
      ...(status ? { status } : {}),
    };
  }

  /**
   * For the log, the later steps a login may start at on this path (ADR 0049): how many,
   * how many with their password alone, and the furthest check any of them reached before
   * it was refused (`LaterMiss`). Undefined where none is.
   */
  function laterReport(): ShownLater | undefined {
    const path = pagePath();
    const here = session.starts.filter((start) => start.later && start.path === path);
    if (!here.length) return undefined;
    const misses = here.map((start) => stepMiss(start) ?? "target");
    return {
      steps: here.length,
      partial: here.filter((start) => start.absent).length,
      miss: LATER_MISSES[Math.max(...misses.map((miss) => LATER_MISSES.indexOf(miss)))]!,
    };
  }

  /**
   * Reports a sign-in input, or a list of accounts where a first step is watched, that
   * still shows without a ready first step after the step wait, once per path: for the log,
   * and with what the first steps missed, for a stale recipe's repair (ADR 0041). A page
   * that renders its form in parts starts its login before then and is not reported. The reply changes nothing here: the page keeps
   * watching until the background reconnects it, as after a repaired recipe.
   */
  function noteShown(): void {
    const path = pagePath();
    // A frame that does not show in the tab's page reports nothing yet (ADR 0086), so a
    // hidden frame is never repaired as a stale page.
    if (
      session.shownTimer ||
      session.shown.has(path) ||
      !(asksSignIn() || listsHere()) ||
      !session.inTab.shown()
    )
      return;
    session.shownTimer = setTimeout(() => {
      session.shownTimer = undefined;
      if (
        !session.observer ||
        session.cancelled ||
        pagePath() !== path ||
        session.shown.has(path) ||
        readingPage(() => session.starts.some(ready))
      )
        return;
      const asks = asksSignIn();
      if ((!asks && !listsHere()) || !session.inTab.shown()) return;
      session.shown.add(path);
      const miss = startMiss();
      const later = laterReport();
      void sendMessage("login", {
        version: 1,
        type: "login.document.ready",
        token: session.token,
        shown: {
          ...shownReport(path),
          ...(miss ? { miss } : {}),
          ...(later ? { later } : {}),
          ...(asks ? {} : { accounts: true as const }),
        },
      }).catch(() => undefined);
    }, LOGIN_STEP_WAIT_MS);
  }

  /**
   * Reports, for the log only, the first step of a page Pateat does not fill as soon as it
   * shows, once per path (ADR 0035).
   */
  function noteConfirm(): void {
    const path = pagePath();
    if (
      !session.confirmPage ||
      session.cancelled ||
      session.shown.has(path) ||
      !ready(session.confirmPage)
    )
      return;
    session.shown.add(path);
    void sendMessage("login", {
      version: 1,
      type: "login.document.ready",
      token: session.token,
      shown: shownReport(path),
    }).catch(() => undefined);
    // Nothing else to watch: only the path is followed, for a return to the page.
    if (!session.starts.length && !session.generate) unwatch();
  }

  const confirmPathChanged = () => {
    const path = pagePath();
    if (!session.followed || session.cancelled || path === session.at) return;
    const leaving = session.at === session.followed;
    session.at = path;
    if (leaving) {
      session.shown.delete(session.followed);
      session.personSubmits.delete(session.followed);
    }
    if (leaving || path === session.followed) void announce(false).catch(() => undefined);
  };

  function followConfirmPath(path: string | undefined): void {
    removeEventListener("popstate", confirmPathChanged);
    session.navigation?.removeEventListener("currententrychange", confirmPathChanged);
    session.followed = path;
    session.at = pagePath();
    if (!path) return;
    addEventListener("popstate", confirmPathChanged);
    session.navigation?.addEventListener("currententrychange", confirmPathChanged);
  }

  /**
   * A `shown` report of `path`: on a page Pateat does not fill, with whether an amount shows
   * in the form of its first step, never the amount; nothing when that step is in no form
   * (ADR 0035).
   */
  function shownReport(path: string): { path: string; amount?: boolean } {
    const forms = confirmForms();
    return forms.length ? { path, amount: forms.some((form) => showsAmount(form)) } : { path };
  }

  /** The forms that hold the first step's elements of a page Pateat does not fill (ADR 0035). */
  function confirmForms(): HTMLFormElement[] {
    if (!session.confirmPage || pagePath() !== session.confirmPage.path) return [];
    const forms = session.confirmPage.targets
      .flatMap((target) => matches(target))
      .flatMap((element) => {
        // `formOf` also follows a control's `form` attribute and a component's host.
        const form =
          element instanceof HTMLInputElement || element instanceof HTMLButtonElement
            ? formOf(element)
            : (closestAcross(element, "form") as HTMLFormElement | null);
        return form ? [form] : [];
      });
    return [...new Set(forms)];
  }

  /** Whether this path is the one this document showed next after a submitted sign-in form. */
  function afterSubmitted(): boolean {
    const path = pagePath();
    if (session.submitPath !== undefined && path !== session.submitPath)
      session.afterSubmit ??= path;
    return path === session.afterSubmit;
  }

  async function announce(
    start: boolean,
    /** `identifier` for a page that asks for an account identifier alone (ADR 0016). */
    signIn: boolean | "identifier" | "passkey" = false,
    list?: ListedAccounts,
    entryPage = false,
    /** The document changed in place after an account switch (ADR 0078). */
    switched = false,
    /**
     * Announced again after a same-document URL change, or as a new page after a default
     * was chosen, to be offered once more.
     */
    again = false,
  ): Promise<unknown> {
    session.announced = start;
    session.announcedPath = pagePath();
    const result: unknown = await sendMessage("login", {
      version: 1,
      type: "login.document.ready",
      token: session.token,
      ...(start ? { start: { path: pagePath() } } : {}),
      ...(signIn
        ? {
            signIn: {
              path: pagePath(),
              ...(signIn === "identifier" ? { identifier: true as const } : {}),
              ...(signIn === "passkey" ? { passkey: true as const } : {}),
            },
          }
        : {}),
      ...(list ? { list } : {}),
      ...(entryPage ? { entry: { path: pagePath() } } : {}),
      ...(switched ? { switched: true as const } : {}),
    });
    const parsed = v.safeParse(readySchema, result);
    if (parsed.success && parsed.output.generate === true) session.mayOffer = true;
    else if (!parsed.success || parsed.output.ok || parsed.output.reason === "generating")
      session.mayOffer = false;
    if (session.mayOffer && session.offerWindow === undefined) watchLate();
    if (parsed.success) {
      // A page Pateat does not fill stays one until an answer on another path (ADR 0035).
      if (parsed.output.confirm) session.confirmPage = parsed.output.confirm;
      else if (session.confirmPage?.path !== session.announcedPath) session.confirmPage = undefined;
      // Its path stays followed after the page moves on, for a return in place.
      if (session.cancelled) followConfirmPath(undefined);
      else if (session.confirmPage && session.followed !== session.confirmPage.path)
        followConfirmPath(session.confirmPage.path);
    }
    if (parsed.success && parsed.output.ok && parsed.output.starts) {
      // A page of a watched login: its recipe's first step showing releases the login
      // (ADR 0027).
      watch(parsed.output.starts);
      check();
    } else if (!parsed.success || parsed.output.ok) {
      unwatch();
    } else if (parsed.output.starts) {
      watch(parsed.output.starts, parsed.output.generate === true, parsed.output.entry === true);
      // In the document that logged in, a form still showing does not log in again; only its
      // next appearance does (ADR 0021 D, ADR 0062). After a rejection it is the form shown
      // again.
      if (session.ended && !session.rejected && !start)
        session.announced = session.starts.some(ready);
      // A refused start means the background did not see the form on this path yet, for
      // example while the tab still shows the previous URL.
      if (start) retry();
      else check();
    } else if (parsed.output.reason === "generating") {
      // The background announces a generated recipe with `login.reconnect`.
      unwatch();
    } else if (
      ["stale-document", "closed-tab", "runtime-unavailable"].includes(parsed.output.reason ?? "")
    ) {
      retry();
    } else if (!(again && parsed.output.reason === "duplicate-document")) {
      // A policy refusal (no account, another tab owns the site, ...) holds until the page
      // is loaded again; re-announcing on every re-render would only repeat it. A document
      // announced again that already carries a login keeps watching for it.
      unwatch();
    }
    return result;
  }

  /**
   * After an entry press, a same-document URL change within the step wait is the next page
   * (ADR 0031): the document announces again so the worker checks it. A press that leads to
   * a new document needs nothing here; that document announces itself.
   */
  function watchPressedUrl(): void {
    const from = location.href;
    const listening = new AbortController();
    const options = { signal: listening.signal };
    // Every same-document URL change sends one of these (ADR 0082).
    const look = () => {
      if (session.cancelled) return stop();
      if (location.href === from) return;
      stop();
      void announce(false).catch(() => undefined);
    };
    const end = setTimeout(stop, LOGIN_STEP_WAIT_MS);
    function stop(): void {
      listening.abort();
      clearTimeout(end);
    }
    addEventListener("popstate", look, options);
    addEventListener("hashchange", look, options);
    session.navigation?.addEventListener("currententrychange", look, options);
    session.waits.signal.addEventListener("abort", stop, options);
  }

  /**
   * A form with a password input, or a code input marked `autocomplete="one-time-code"`,
   * submitted in this document, whatever the sign-in method (owner, 2026-11-08): its next path here, and the tab's next document if it is
   * of the same origin, are not offered as a list of accounts (ADR 0028), as a sign-in
   * entry (ADR 0031) or as a page asking for an identifier alone (ADR 0016). The
   * background counts a passkey Pateat answered for the tab's next document the same way.
   * Nothing about the form or its values is sent. Pateat's own submissions count too;
   * their pages belong to a login anyway.
   */
  const onSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    // The person submitted the form of a page Pateat does not fill: only the fact, once per
    // path, before the page leaves (ADR 0035).
    const path = pagePath();
    if (
      event.isTrusted &&
      !session.cancelled &&
      !session.personSubmits.has(path) &&
      confirmForms().includes(form)
    ) {
      session.personSubmits.add(path);
      void sendMessage("login", {
        version: 1,
        type: "login.document.person-submitted",
        token: session.token,
      }).catch(() => undefined);
    }
    // A code counts only when the page marks its field so: a short numeric field alone may
    // be a postcode or a quantity.
    if (
      !inputsOf(form, document).some(
        (input) => input.type === "password" || autocompleteTokens(input).includes("one-time-code"),
      )
    )
      return;
    session.submitPath = pagePath();
    session.afterSubmit = undefined;
    void sendMessage("login", {
      version: 1,
      type: "login.document.submitted",
      token: session.token,
    }).catch(() => undefined);
  };

  function watchLate(): void {
    if (
      session.lateWatch ||
      session.cancelled ||
      !session.mayOffer ||
      !session.offered ||
      session.submitPath !== undefined
    )
      return;
    const { later, stop: unlook } = lookOnChange(document, () => {
      // A submitted sign-in form signed the page in: its later forms, as a re-entry of
      // the password on a settings page, are not sent.
      if (
        session.cancelled ||
        !session.mayOffer ||
        !session.offered ||
        session.submitPath !== undefined
      )
        return stop();
      // An open window, after a load or a URL change, offers the input itself.
      if (session.offerWindow !== undefined || session.urlWatch) return;
      const path = pagePath();
      if (
        session.offeredPaths.has(path) ||
        !showsSignIn() ||
        !session.inTab.shown() ||
        session.starts.some(ready) ||
        afterSubmitted()
      )
        return;
      session.offeredPaths.add(path);
      void announce(false, true, undefined, false, false, true).catch(() => undefined);
    });
    session.frameLooks.add(later);
    function stop(): void {
      unlook();
      session.frameLooks.delete(later);
      if (session.lateWatch === stop) session.lateWatch = undefined;
    }
    session.lateWatch = stop;
    later();
  }

  const urlChanged = () => {
    if (!session.cancelled && pagePath() !== session.routePath) {
      session.routePath = pagePath();
      if (session.carrying || session.ssoCarrying)
        void sendMessage("login", {
          version: 1,
          type: "login.document.moved",
          token: session.token,
        }).catch(() => undefined);
    }
    if (session.cancelled || pageUrl() === session.offerUrl) return;
    session.offerUrl = pageUrl();
    if (!session.mayOffer || !session.offered || session.offerWindow !== undefined) return;
    session.urlWatch?.();
    const { later, stop: unlook } = lookOnChange(document, () => {
      if (session.cancelled || !session.mayOffer) return stop();
      if (
        !showsSignIn() ||
        !session.inTab.shown() ||
        session.starts.some(ready) ||
        afterSubmitted()
      )
        return;
      stop();
      session.offeredPaths.add(pagePath());
      void announce(false, true, undefined, false, false, true).catch(() => undefined);
    });
    session.frameLooks.add(later);
    const end = setTimeout(stop, LOGIN_STEP_WAIT_MS);
    function stop(): void {
      unlook();
      session.frameLooks.delete(later);
      clearTimeout(end);
      if (session.urlWatch === stop) session.urlWatch = undefined;
      watchLate();
    }
    session.urlWatch = stop;
    later();
  };
  return {
    announce,
    unwatch,
    clearOffer,
    followConfirmPath,
    switchedInPlace,
    watchPressedUrl,
    onSubmit,
    urlChanged,
  };
}
export type ContentWatch = ReturnType<typeof createContentWatch>;
