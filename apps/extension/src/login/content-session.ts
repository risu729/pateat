import * as v from "valibot";
import { createSsoBridge } from "./content-sso-bridge";
import type { LoginTarget } from "@pateat/contracts";
import { autocompleteTokens } from "../page/targets";
import { closestAcross, formOf, inputsOf, readingPage, shadowRoots } from "../page/shadow";
import { targetState } from "../page/target-state";
import { answerInput, identifierInput } from "../page/identifier-field";
import { showsAmount } from "../page/amount";
import { askDefinitions, ELEMENT_DEFINED } from "../page/element-definitions";
import { nextFrame } from "../page/frames";
import { watchFrameShown } from "../page/frame-shown";
import { navigationStatus } from "../page/document-load";
import { breaksQuiet, pageWatch } from "../page/quiet";
import {
  listedAccounts,
  listsAccounts,
  logOnly,
  noInputOffer,
  type ListedAccounts,
} from "./no-input-offer";
import type { SubmittedPage } from "../page/sign-in-state";
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
import { newId } from "@pateat/contracts/ids";
import type { LoginContentOptions } from "./content";
import {
  pagePath,
  type Control,
  pageUrl,
  offerQuietMs,
  offerWaitMs,
  checkGapMs,
  showsSignIn,
  ready,
  stepMiss,
  matches,
  lookOnChange,
} from "./content-dom";

/** One installed document's login state and the watches that keep it, shared with its command handlers. */
export function createContentSession({ probeStatus = false }: LoginContentOptions = {}) {
  const token = newId();
  let cancelled = false;
  const sso = createSsoBridge(
    document,
    token,
    () => cancelled,
    (attemptId) => {
      if (pendingSwitch?.attemptId === attemptId) pendingSwitch = undefined;
      if (filledAttempt === attemptId) forgetAttempt();
    },
  );
  // Ends every wait for a change of the page once `cancelled` is set.
  const waits = new AbortController();
  // Ends the running `login.extract.watch`, once another replaces it or the login cancels.
  let describedWatch: AbortController | undefined;
  // Whether the background asked for the value the page set in an account input.
  let siteAccountAsked = false;
  // Set once this document's login has ended; it then watches for its first step to show
  // again, as after a logout, when the page logs in again (ADR 0062).
  let ended = false;
  // The site rejected that login here: the form showing with the failure asks at once.
  let rejected = false;
  // This document carries a login that has not ended, and the path its page last showed:
  // a same-document URL change to another path is reported, so a login watched after its
  // submission reads a single-page site's next route as the tab's next page (ADR 0027).
  let carrying = false;
  let routePath = pagePath();
  const used = new Set<string>();
  // What this document showed when its last effect step ran (ADR 0029: F1, F2).
  let submitted: SubmittedPage | undefined;
  /**
   * Inputs this document's fills wrote to since the last click of the same attempt, and
   * the password inputs that were writable when the first of those fills began, for the
   * check before a click.
   */
  let filled = new WeakSet<HTMLInputElement>();
  /**
   * The selects a split date's parts were chosen in since the last click, each with its
   * option (ADR 0061): the click goes on only while each still shows it.
   */
  let chosen: [HTMLSelectElement, HTMLOptionElement][] = [];
  let shownBefore: WeakSet<HTMLInputElement> | undefined;
  const forgetFills = () => {
    filled = new WeakSet();
    chosen = [];
    shownBefore = undefined;
  };
  // The submit buttons this document showed when a fill began, which Enter never presses
  // (ADR 0064). A fill whose fields already hold values adds none once one fill has, so a
  // button such a page shows only for a value is not taken as one the model saw.
  const submitsBefore = new WeakSet<Element>();
  let submitsTaken = false;
  let filledAttempt: string | undefined;
  /**
   * A fill's check of the account the page shows, left to the next click or Enter of the
   * same attempt because the page showed no identifier when it filled (ADR 0049 amendment
   * of 2026-11-03): the item's username, the form, the inputs it filled and the switch the
   * fill was sent. It never leaves this content script.
   */
  let deferredAccount:
    | {
        username: string;
        masked: boolean;
        form: HTMLFormElement | null;
        inputs: Control[];
        accountSwitch?: LoginTarget;
        otherSwitch?: true;
      }
    | undefined;
  const forgetAttempt = () => {
    forgetFills();
    if (deferredAccount) deferredAccount.username = "";
    deferredAccount = undefined;
  };
  // The account switch a `wrong-account` result reported, clicked only by `login.switch`.
  let pendingSwitch:
    | {
        operationId: string;
        attemptId: string;
        element: HTMLElement;
        /** Finds the switch again: the recipe's target, or the page's own controls. */
        find: () => Element[];
        path: string;
        expiresAt: number;
      }
    | undefined;
  // First steps of the origin's recipes. A new attempt starts only once one is ready on
  // the current path, including after a same-document URL change or a dialog opening.
  let starts: LoginReadiness[] = [];
  let announced = false;
  // The path the last announcement was made on.
  let announcedPath: string | undefined;
  // The background may generate a recipe for this page if it shows a sign-in input within
  // the step wait after it may be sent (ADR 0016); a form shown only later, for example
  // after a click, is not sent, unless the document's URL changed first.
  let generate = false;
  let offered = false;
  // The background answered that this document may be sent (ADR 0016) and no login took
  // it over since, and the URL, without its fragment, its window last opened at: a
  // same-document URL change, as a single-page app's route to its sign-in form, opens a
  // window for a sign-in input once more (`urlChanged`).
  let mayOffer = false;
  let offerUrl = pageUrl();
  // The path where this document last submitted a sign-in form (ADR 0028, amended 2026-11-08), and the
  // next path it showed after it: that page is never offered as a list of accounts or as a
  // sign-in entry.
  let submitPath: string | undefined;
  let afterSubmit: string | undefined;
  // The page's URL names another path of its site: once the offer wait passes without a
  // sign-in input, it is offered as a site's sign-in entry, once (ADR 0031).
  let entryWanted = false;
  let entryOffered = false;
  // Paths where a sign-in input stayed shown without a ready first step, reported once
  // each so the background can log a login that did not start.
  const shown = new Set<string>();
  let shownTimer: ReturnType<typeof setTimeout> | undefined;
  // A recipe generated as `confirm` or `unclear` starts on this path, so the page only
  // watches (ADR 0035): its first step is reported with `shown` as soon as it shows, and
  // the person's own submission of its form once per path.
  let confirmPage: LoginReadiness | undefined;
  const personSubmits = new Set<string>();
  // Whether this document shows in the tab's page: a frame's page is offered for
  // generation only once it does (ADR 0086), and the looks waiting for it look again then.
  const frameLooks = new Set<() => void>();
  const inTab = watchFrameShown(window, () => {
    if (cancelled || !inTab.shown()) return;
    // A decision already taken in the offer's window is taken again, after the page's quiet.
    if (offerWindow !== undefined && !offered) {
      clearDecision();
      offerQuiet = setTimeout(decideOffer, offerQuietMs);
      offerCap = setTimeout(decideOffer, offerWaitMs);
    }
    if (observer) schedule();
    for (const look of frameLooks) look();
  });
  // The pending offer's timers: its decision once the DOM is quiet (`offerQuiet`) or at the
  // latest (`offerCap`, ADR 0057), and the end of its window for a sign-in input
  // (`offerWindow`, ADR 0016). The decision is pending while `offerCap` is set.
  let offerQuiet: ReturnType<typeof setTimeout> | undefined;
  let offerCap: ReturnType<typeof setTimeout> | undefined;
  let offerWindow: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  // The shadow trees `observer` watches, and those whose form submissions `onSubmit` hears:
  // neither a document's observer nor its listener for an event that does not cross a
  // shadow boundary, as `submit`, sees inside one (ADR 0070).
  let observedRoots = new WeakSet<ShadowRoot>();
  const submitRoots = new WeakSet<ShadowRoot>();
  const submitListeners = new AbortController();
  // A start's retry (`retry`), whether a check is pending, and when the last one ran.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  const navigation = (globalThis as unknown as { navigation?: EventTarget }).navigation;
  // Checks at the page's next frame after a change, however many changes come before it
  // (ADR 0082), and at most once per `checkGapMs`, so a page that changes every frame, as
  // a spinner does, is not checked every frame while it is watched. A pending retry
  // checks then instead.
  const schedule = () => {
    if (checking || timer !== undefined) return;
    checking = true;
    const run = () => {
      checking = false;
      if (timer === undefined) check();
    };
    const gap = checkedAt + checkGapMs - Date.now();
    if (gap <= 0) void nextFrame().then(run);
    else setTimeout(() => void nextFrame().then(run), gap);
  };
  function clearDecision(): void {
    clearTimeout(offerQuiet);
    offerQuiet = undefined;
    clearTimeout(offerCap);
    offerCap = undefined;
  }
  function clearOffer(): void {
    clearDecision();
    clearTimeout(offerWindow);
    offerWindow = undefined;
  }
  // A DOM change or a same-document URL change: check the starts, and wait again for quiet
  // while the decision is pending.
  const pageChanged = () => {
    schedule();
    if (offerCap === undefined) return;
    clearTimeout(offerQuiet);
    offerQuiet = setTimeout(decideOffer, offerQuietMs);
  };
  // Every DOM change checks the starts; only some restart a pending decision's quiet wait
  // (`breaksQuiet`).
  const domChanged = (records: MutationRecord[]) => {
    if (offerCap !== undefined && records.some(breaksQuiet)) pageChanged();
    else schedule();
  };
  function unwatch(): void {
    clearOffer();
    clearTimeout(shownTimer);
    shownTimer = undefined;
    observer?.disconnect();
    observer = undefined;
    clearTimeout(timer);
    timer = undefined;
    removeEventListener(ELEMENT_DEFINED, schedule);
    removeEventListener("popstate", pageChanged);
    navigation?.removeEventListener("currententrychange", pageChanged);
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
    if (!cancelled && showsSignIn()) check();
    // A page that shows no sign-in input by now may list accounts (ADR 0028) or, when
    // its URL names another path of its site, hold the site's sign-in entry (ADR
    // 0031), ask for an account identifier alone (ADR 0016) or show a passkey button (ADR
    // 0053). The page right after a submitted sign-in form offers none of them.
    // A frame that does not show yet offers nothing (ADR 0086).
    const bare =
      !cancelled && !starts.some(ready) && !showsSignIn() && !afterSubmitted() && inTab.shown();
    // A page asking a secret answer is a verification, never a site's sign-in entry, even
    // when its URL names the page it guards (ADR 0035, #1376): it waits for the window,
    // which counts it.
    const answer = bare && answerInput(document);
    const noInput = bare
      ? noInputOffer(document, entryWanted && !entryOffered && !answer)
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
    if (noInput.kind !== "identifier" && noInput.entry) entryOffered = true;
    offered = true;
    watch(starts);
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
    offered = true;
    watch(starts);
    watchLate();
    const bare = !cancelled && !starts.some(ready) && !showsSignIn() && !afterSubmitted();
    const accounts = bare && !answerInput(document) ? listedAccounts(document) : undefined;
    if (accounts && logOnly(accounts)) void announce(false, false, accounts).catch(() => undefined);
    // Nothing was sent: the log says why (ADR 0019). A secret answer of `type="text"` looks
    // like a verification that is never sent, so it is counted (ADR 0035) when no sign-in
    // reason holds, also on a page with a list of accounts.
    else if (!cancelled && !starts.some(ready))
      void sendMessage("login", {
        version: 1,
        type: "login.document.ready",
        token,
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
    starts = list;
    generate = offer && !offered;
    entryWanted = generate && entryPage;
    if (!generate) clearOffer();
    else if (offerWindow === undefined) {
      offerUrl = pageUrl();
      offerQuiet = setTimeout(decideOffer, offerQuietMs);
      offerCap = setTimeout(decideOffer, offerWaitMs);
      offerWindow = setTimeout(endOffer, LOGIN_STEP_WAIT_MS);
    }
    // A page Pateat does not fill keeps watching until its first step is reported (ADR 0035).
    const confirmWaiting = confirmPage !== undefined && !shown.has(confirmPage.path);
    if ((!starts.length && !generate && !confirmWaiting) || cancelled) {
      unwatch();
      return;
    }
    if (!observer) {
      observer = new MutationObserver(domChanged);
      observer.observe(document, pageWatch);
      observedRoots = new WeakSet();
      watchShadowRoots();
      addEventListener(ELEMENT_DEFINED, schedule);
      addEventListener("popstate", pageChanged);
      navigation?.addEventListener("currententrychange", pageChanged);
    }
  }
  /**
   * Checks again shortly when a start could not be confirmed for a passing reason. Each
   * appearance of the form gets a few retries; after that it waits until the form goes.
   */
  let retries = 0;
  function retry(): void {
    if (!observer) return;
    retries += 1;
    if (retries >= START_TRIES) return;
    announced = false;
    clearTimeout(timer);
    timer = setTimeout(check, 500);
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
      if (observer && !observedRoots.has(root)) {
        observer.observe(root, pageWatch);
        observedRoots.add(root);
      }
      if (!submitRoots.has(root)) {
        submitRoots.add(root);
        root.addEventListener("submit", onSubmit, {
          capture: true,
          signal: submitListeners.signal,
        });
      }
    }
  }
  // Announce once per appearance; a form that disappears and reappears announces again.
  function check(): void {
    readingPage(checkNow);
  }
  function checkNow(): void {
    clearTimeout(timer);
    timer = undefined;
    checkedAt = Date.now();
    if (!observer) return;
    watchShadowRoots();
    noteConfirm();
    const startable = starts.some(ready);
    // A step that shows on another path of the same document is a new appearance too, as
    // the password step a single-page app renders in place of its email step (ADR 0049).
    if (startable && announced && announcedPath !== pagePath()) {
      announced = false;
      retries = 0;
    }
    if (startable && !announced) void announce(true).catch(retry);
    else if (!startable) {
      announced = false;
      retries = 0;
      // Offered once per page; the background keeps its own daily limit as well.
      if (generate && !offered && showsSignIn() && inTab.shown()) {
        offered = true;
        offeredPaths.add(pagePath());
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
    return starts.filter((start) => start.path === path && !start.accounts && !start.later);
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
    const watched = starts.filter((start) => start.path === path && !start.later);
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
    const here = starts.filter((start) => start.later && start.path === path);
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
    if (shownTimer || shown.has(path) || !(asksSignIn() || listsHere()) || !inTab.shown()) return;
    shownTimer = setTimeout(() => {
      shownTimer = undefined;
      if (
        !observer ||
        cancelled ||
        pagePath() !== path ||
        shown.has(path) ||
        readingPage(() => starts.some(ready))
      )
        return;
      const asks = asksSignIn();
      if ((!asks && !listsHere()) || !inTab.shown()) return;
      shown.add(path);
      const miss = startMiss();
      const later = laterReport();
      void sendMessage("login", {
        version: 1,
        type: "login.document.ready",
        token,
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
    if (!confirmPage || cancelled || shown.has(path) || !ready(confirmPage)) return;
    shown.add(path);
    void sendMessage("login", {
      version: 1,
      type: "login.document.ready",
      token,
      shown: shownReport(path),
    }).catch(() => undefined);
    // Nothing else to watch: only the path is followed, for a return to the page.
    if (!starts.length && !generate) unwatch();
  }
  /**
   * Follows the path of a page Pateat does not fill (ADR 0035), `followed`, from `at`, the
   * path last seen. Left in place, the page announces its new path, so the worker logs the
   * visit as left with that page next; back on it, the page announces again, and the
   * worker's answer names its first step, which with the person's submit is reported again
   * as a new visit.
   */
  let followed: string | undefined;
  let at: string | undefined;
  const confirmPathChanged = () => {
    const path = pagePath();
    if (!followed || cancelled || path === at) return;
    const leaving = at === followed;
    at = path;
    if (leaving) {
      shown.delete(followed);
      personSubmits.delete(followed);
    }
    if (leaving || path === followed) void announce(false).catch(() => undefined);
  };
  function followConfirmPath(path: string | undefined): void {
    removeEventListener("popstate", confirmPathChanged);
    navigation?.removeEventListener("currententrychange", confirmPathChanged);
    followed = path;
    at = pagePath();
    if (!path) return;
    addEventListener("popstate", confirmPathChanged);
    navigation?.addEventListener("currententrychange", confirmPathChanged);
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
    if (!confirmPage || pagePath() !== confirmPage.path) return [];
    const forms = confirmPage.targets
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
    if (submitPath !== undefined && path !== submitPath) afterSubmit ??= path;
    return path === afterSubmit;
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
    announced = start;
    announcedPath = pagePath();
    const result: unknown = await sendMessage("login", {
      version: 1,
      type: "login.document.ready",
      token,
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
    if (parsed.success && parsed.output.generate === true) mayOffer = true;
    else if (!parsed.success || parsed.output.ok || parsed.output.reason === "generating")
      mayOffer = false;
    if (mayOffer && offerWindow === undefined) watchLate();
    if (parsed.success) {
      // A page Pateat does not fill stays one until an answer on another path (ADR 0035).
      if (parsed.output.confirm) confirmPage = parsed.output.confirm;
      else if (confirmPage?.path !== announcedPath) confirmPage = undefined;
      // Its path stays followed after the page moves on, for a return in place.
      if (cancelled) followConfirmPath(undefined);
      else if (confirmPage && followed !== confirmPage.path) followConfirmPath(confirmPage.path);
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
      if (ended && !rejected && !start) announced = starts.some(ready);
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
      !cancelled &&
      !personSubmits.has(path) &&
      confirmForms().includes(form)
    ) {
      personSubmits.add(path);
      void sendMessage("login", {
        version: 1,
        type: "login.document.person-submitted",
        token,
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
    submitPath = pagePath();
    afterSubmit = undefined;
    void sendMessage("login", { version: 1, type: "login.document.submitted", token }).catch(
      () => undefined,
    );
  };
  /**
   * A same-document URL change after the page's window to be sent closed, as Duolingo's
   * "I already have an account" routing to its sign-in form in place (2026-10-24), opens a
   * new window of the step wait for a sign-in input alone: one that shows within it is
   * announced, once, and the background decides as for a new page. Nothing is sent for a
   * route without one, and a list of accounts, an identifier alone or an entry is still
   * offered only after a load. Only once the background answered that the page may be
   * sent and no login took it over since, so a login under way is never announced over.
   */
  let urlWatch: (() => void) | undefined;
  /**
   * Paths of this document whose sign-in input was announced to be sent, and the watch
   * that, once the page's window to be sent closed, announces a sign-in input shown in
   * place later, as Discord's form after "Add an account" (2026-11-04), once per path
   * (ADR 0016, amended 2026-11-04). Only while the background answered that the page may
   * be sent and no login took it over since; the background decides as for a new page.
   */
  const offeredPaths = new Set<string>();
  let lateWatch: (() => void) | undefined;
  function watchLate(): void {
    if (lateWatch || cancelled || !mayOffer || !offered || submitPath !== undefined) return;
    const { later, stop: unlook } = lookOnChange(document, () => {
      // A submitted sign-in form signed the page in: its later forms, as a re-entry of
      // the password on a settings page, are not sent.
      if (cancelled || !mayOffer || !offered || submitPath !== undefined) return stop();
      // An open window, after a load or a URL change, offers the input itself.
      if (offerWindow !== undefined || urlWatch) return;
      const path = pagePath();
      if (
        offeredPaths.has(path) ||
        !showsSignIn() ||
        !inTab.shown() ||
        starts.some(ready) ||
        afterSubmitted()
      )
        return;
      offeredPaths.add(path);
      void announce(false, true, undefined, false, false, true).catch(() => undefined);
    });
    frameLooks.add(later);
    function stop(): void {
      unlook();
      frameLooks.delete(later);
      if (lateWatch === stop) lateWatch = undefined;
    }
    lateWatch = stop;
    later();
  }
  const urlChanged = () => {
    if (!cancelled && pagePath() !== routePath) {
      routePath = pagePath();
      if (carrying || sso.carrying())
        void sendMessage("login", { version: 1, type: "login.document.moved", token }).catch(
          () => undefined,
        );
    }
    if (cancelled || pageUrl() === offerUrl) return;
    offerUrl = pageUrl();
    if (!mayOffer || !offered || offerWindow !== undefined) return;
    urlWatch?.();
    const { later, stop: unlook } = lookOnChange(document, () => {
      if (cancelled || !mayOffer) return stop();
      if (!showsSignIn() || !inTab.shown() || starts.some(ready) || afterSubmitted()) return;
      stop();
      offeredPaths.add(pagePath());
      void announce(false, true, undefined, false, false, true).catch(() => undefined);
    });
    frameLooks.add(later);
    const end = setTimeout(stop, LOGIN_STEP_WAIT_MS);
    function stop(): void {
      unlook();
      frameLooks.delete(later);
      clearTimeout(end);
      if (urlWatch === stop) urlWatch = undefined;
      watchLate();
    }
    urlWatch = stop;
    later();
  };
  // Accessors read and update the bindings above from the modules that use them.
  return {
    probeStatus,
    token,
    get cancelled() {
      return cancelled;
    },
    set cancelled(value: typeof cancelled) {
      cancelled = value;
    },
    sso,
    waits,
    get describedWatch() {
      return describedWatch;
    },
    set describedWatch(value: typeof describedWatch) {
      describedWatch = value;
    },
    get siteAccountAsked() {
      return siteAccountAsked;
    },
    set siteAccountAsked(value: typeof siteAccountAsked) {
      siteAccountAsked = value;
    },
    get ended() {
      return ended;
    },
    set ended(value: typeof ended) {
      ended = value;
    },
    get rejected() {
      return rejected;
    },
    set rejected(value: typeof rejected) {
      rejected = value;
    },
    get carrying() {
      return carrying;
    },
    set carrying(value: typeof carrying) {
      carrying = value;
    },
    used,
    get submitted() {
      return submitted;
    },
    set submitted(value: typeof submitted) {
      submitted = value;
    },
    get filled() {
      return filled;
    },
    set filled(value: typeof filled) {
      filled = value;
    },
    get chosen() {
      return chosen;
    },
    get shownBefore() {
      return shownBefore;
    },
    set shownBefore(value: typeof shownBefore) {
      shownBefore = value;
    },
    forgetFills,
    submitsBefore,
    get submitsTaken() {
      return submitsTaken;
    },
    set submitsTaken(value: typeof submitsTaken) {
      submitsTaken = value;
    },
    get filledAttempt() {
      return filledAttempt;
    },
    set filledAttempt(value: typeof filledAttempt) {
      filledAttempt = value;
    },
    get deferredAccount() {
      return deferredAccount;
    },
    set deferredAccount(value: typeof deferredAccount) {
      deferredAccount = value;
    },
    forgetAttempt,
    get pendingSwitch() {
      return pendingSwitch;
    },
    set pendingSwitch(value: typeof pendingSwitch) {
      pendingSwitch = value;
    },
    get starts() {
      return starts;
    },
    get announced() {
      return announced;
    },
    set announced(value: typeof announced) {
      announced = value;
    },
    get generate() {
      return generate;
    },
    set generate(value: typeof generate) {
      generate = value;
    },
    get offered() {
      return offered;
    },
    set offered(value: typeof offered) {
      offered = value;
    },
    get entryOffered() {
      return entryOffered;
    },
    set entryOffered(value: typeof entryOffered) {
      entryOffered = value;
    },
    inTab,
    submitListeners,
    navigation,
    clearOffer,
    unwatch,
    get retries() {
      return retries;
    },
    set retries(value: typeof retries) {
      retries = value;
    },
    followConfirmPath,
    announce,
    onSubmit,
    get urlWatch() {
      return urlWatch;
    },
    offeredPaths,
    get lateWatch() {
      return lateWatch;
    },
    urlChanged,
  };
}
export type ContentSession = ReturnType<typeof createContentSession>;
