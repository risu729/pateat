import * as v from "valibot";
import type { LoginMarkerTarget, LoginTarget } from "@pateat/contracts";
import { browser } from "wxt/browser";
import {
  accountText,
  comparableAccounts,
  showsOtherAccount,
  shownAccounts,
} from "../page/accounts";
import { isButton } from "../page/text";
import { findLogoutTargets, shownLayers } from "../page/logout-controls";
import { pressElement } from "../page/script-url-click";
import { autocompleteTokens, findTargets } from "../page/targets";
import {
  clickable,
  passwordChoice,
  targetCheck,
  targetState,
  writable,
} from "../page/target-state";
import { identifierInput } from "../page/identifier-field";
import {
  CODE_SETTLE_MS,
  splitCodeInputs,
  visible,
  watchCodeSubmission,
} from "../page/code-submission";
import { fillBaseline, inputValueMismatch, rejectsFill, unreadyForm } from "../page/fill-checks";
import { clickDestinations, formDestination, type FormDestination } from "../page/form-destination";
import { FIELD_GAP_MS, typeValue } from "../page/enter-value";
import {
  extractAccountListObservation,
  extractEntryObservation,
  extractLocalLogout,
  extractLogoutObservation,
  extractLoginObservation,
  extractPasskeyObservation,
  extractSignedInObservation,
  presence,
} from "../observation/extract";
import { listChoice, listControls } from "../page/account-list";
import {
  listedAccounts,
  listsAccounts,
  logOnly,
  noInputOffer,
  type ListedAccounts,
} from "./no-input-offer";
import { entryElementRefusal, entryHosts, showsSignUp } from "../page/entry";
import {
  pageSigns,
  passedCaptcha,
  showsCaptcha,
  submittedPage,
  type SubmittedPage,
} from "../page/sign-in-state";
import { observedPath } from "../observation/path";
import { sendMessage } from "../messaging/protocol";
import { acceptsSecret } from "./inputs";
import {
  commandSchema,
  destinationAnswerSchema,
  LOGIN_STEP_WAIT_MS,
  readySchema,
  START_TRIES,
  reconnectSchema,
  type ExecutionDetail,
  type LoginReadiness,
  type TargetState,
} from "./wire";
import { newId } from "@pateat/contracts/ids";

/**
 * This page's path as observations and recipes carry it, each token-like segment replaced
 * (`observedPath`, ADR 0039): every path this script reports, or compares with a step's,
 * reads this, so a step on `/[id]/login` runs on the same page of any tenant.
 */
const pagePath = () => observedPath(location.pathname);
/** Fixed locators deliberately reject duplicates rather than taking the first match. */
function matches(target: LoginMarkerTarget, links = false): Element[] {
  return findTargets(document, target, { links });
}
/** A button that submits its form: `<button type=submit>` or `<input type=submit|image>`. */
function submitButton(element: Element): element is HTMLButtonElement | HTMLInputElement {
  return (
    (element instanceof HTMLButtonElement && element.type === "submit") ||
    (element instanceof HTMLInputElement && (element.type === "submit" || element.type === "image"))
  );
}
function followable(element: Element | undefined): element is HTMLAnchorElement {
  return element instanceof HTMLAnchorElement && element.hasAttribute("href") && visible(element);
}
const isOnly = (found: readonly Element[], element: Element) =>
  found.length === 1 && found[0] === element;
/** How long after a `wrong-account` result its account switch may still be clicked. */
const switchTimeoutMs = 10_000;
/**
 * Whether `element` is an account switch the executor may click: a shown link, or a shown
 * button that does not submit a form (that would send the sign-in form instead).
 */
function switchable(element: Element | undefined): element is HTMLElement {
  if (followable(element)) return true;
  if (!clickable(element) || !isButton(element)) return false;
  const submits = element.type === "submit" || element.type === "image";
  return !(submits && element.form);
}
/** Whether a step's elements are ready now: the path matches and each target is unique and usable. */
function ready(readiness: LoginReadiness): boolean {
  if (pagePath() !== readiness.path) return false;
  // A chooser's list (ADR 0028): one of its buttons, or an account it lists by email.
  if (readiness.accounts)
    return (
      !showsSignIn() &&
      (readiness.targets.some((target) => listControls(document, target).length === 1) ||
        listsAccounts(document))
    );
  return (
    readiness.targets.every((target) => {
      const found = matches(target);
      if (found.length !== 1) return false;
      if (readiness.require === "writable") return writable(found[0]);
      // A control named by its accessible name may be a link to a fragment of its page.
      if (readiness.require === "clickable")
        return clickable(found[0], { fragment: target.by === "accessible-name" });
      return true;
    }) &&
    // A later step is no start while the page also asks for an identifier the step does not
    // fill, as a form for another account with its own email input (ADR 0049).
    !(readiness.later && credentialInputs(readiness.targets).identifier)
  );
}
/**
 * Whether the page shows a visible password input, or one marked for a username or a
 * one-time code: the only pages without a recipe that may be sent for generation
 * (ADR 0016).
 */
function showsSignIn(): boolean {
  return [...document.querySelectorAll("input")].some((input) => {
    const tokens = autocompleteTokens(input);
    return (
      (input.type === "password" ||
        tokens.includes("username") ||
        tokens.includes("one-time-code")) &&
      writable(input)
    );
  });
}
/**
 * The sign-in inputs the page shows that a generated recipe can continue on after its final
 * `advance` step (ADR 0018), other than the recipe's own `targets`: `password`, a visible
 * writable password input; `identifier`, a visible writable email input or one marked for a
 * username or an email address. Visible as the page's description reads it, so an input
 * hidden from assistive technology, transparent, tiny or moved before the page's start, as
 * a password input kept on an email form for the browser to fill, never counts. An input marked
 * `new-password` or `one-time-code`, and every input of a form that holds one, never
 * counts: a sign-up, password change or code form is not a sign-in page to continue on,
 * and a code page is judged instead (ADR 0027).
 */
function credentialInputs(targets: readonly LoginMarkerTarget[]): {
  password: boolean;
  identifier: boolean;
} {
  const own = new Set(targets.flatMap((target) => matches(target)));
  const other = (input: HTMLInputElement) =>
    autocompleteTokens(input).some(
      (token) => token === "new-password" || token === "one-time-code",
    );
  const inputs = [...document.querySelectorAll("input")].filter(
    (input) =>
      !own.has(input) &&
      writable(input) &&
      presence(input) === "visible" &&
      !other(input) &&
      // `elements` also holds inputs tied to the form by a `form` attribute.
      !(
        input.form &&
        [...input.form.elements].some(
          (element) => element instanceof HTMLInputElement && other(element),
        )
      ),
  );
  return {
    password: inputs.some((input) => input.type === "password"),
    identifier: inputs.some(
      (input) =>
        input.type === "email" ||
        autocompleteTokens(input).some((token) => token === "username" || token === "email"),
    ),
  };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * How long a preparing fill waits for the page's own input handlers before checking that
 * the page accepted the values (ADR 0010).
 */
const fillSettleMs = 500;
/**
 * What a first-visit page without a sign-in input is gets decided once its DOM has had no
 * change for `offerQuietMs`, or `offerWaitMs` after the wait began while it keeps changing
 * (ADR 0057). A sign-in input is still offered until `LOGIN_STEP_WAIT_MS` (ADR 0016).
 */
const offerQuietMs = 1000;
const offerWaitMs = 5000;
/**
 * A fill compared with the account the page shows, while the page shows no identifier
 * to compare with, waits until the document has loaded and its DOM has had no change for
 * `accountQuietMs`, or `accountWaitMs` while it keeps changing: Duolingo's sign-in shows its remembered account's address after the password
 * field (2026-10-23), and a check before it would pass. It ends `accountReserveMs` before
 * the operation expires, so a page that keeps changing is still compared and filled.
 */
const accountQuietMs = 1000;
const accountWaitMs = 5000;
const accountReserveMs = 2000;

/**
 * Resolves once `document` has loaded and its DOM has had no change for `quietMs`, or at
 * `until` (a time in ms since the epoch), whichever comes first.
 */
function settled(document: Document, quietMs: number, until: number): Promise<void> {
  return new Promise((resolve) => {
    const view = document.defaultView;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(quiet);
      if (document.readyState === "complete") quiet = setTimeout(done, quietMs);
    };
    const observer = new MutationObserver(restart);
    const cap = setTimeout(done, Math.max(0, until - Date.now()));
    function done(): void {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      view?.removeEventListener("load", restart);
      resolve();
    }
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    view?.addEventListener("load", restart);
    restart();
  });
}
export interface LoginContentOptions {
  /** Echo attempt status to the page; only the synthetic probe fixture page may see it. */
  readonly probeStatus?: boolean;
}

export function installLoginContent({ probeStatus = false }: LoginContentOptions = {}): () => void {
  const token = newId();
  let cancelled = false;
  // Set once this document's login has ended; it then watches for its first step to show
  // again, as after a logout, when the page logs in again (ADR 0062).
  let ended = false;
  // The site rejected that login here: the form showing with the failure asks at once.
  let rejected = false;
  const used = new Set<string>();
  // What this document showed when its last effect step ran (ADR 0029: F1, F2).
  let submitted: SubmittedPage | undefined;
  /**
   * Inputs this document's fills wrote to since the last click of the same attempt, and
   * the password inputs that were writable when the first of those fills began, for the
   * check before a click.
   */
  let filled = new WeakSet<HTMLInputElement>();
  let shownBefore: WeakSet<HTMLInputElement> | undefined;
  // The submit buttons this document showed when a fill began, which Enter never presses
  // (ADR 0064). A fill whose fields already hold values adds none once one fill has, so a
  // button such a page shows only for a value is not taken as one the model saw.
  const submitsBefore = new WeakSet<Element>();
  let submitsTaken = false;
  let filledAttempt: string | undefined;
  // The account switch a `wrong-account` result reported, clicked only by `login.switch`.
  let pendingSwitch:
    | {
        operationId: string;
        element: HTMLElement;
        target: LoginTarget;
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
  // after a click, is not sent.
  let generate = false;
  let offered = false;
  // The path where this document last submitted a form with a password input, and the
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
  // The pending offer's timers: its decision once the DOM is quiet (`offerQuiet`) or at the
  // latest (`offerCap`, ADR 0057), and the end of its window for a sign-in input
  // (`offerWindow`, ADR 0016). The decision is pending while `offerCap` is set.
  let offerQuiet: ReturnType<typeof setTimeout> | undefined;
  let offerCap: ReturnType<typeof setTimeout> | undefined;
  let offerWindow: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const navigation = (globalThis as unknown as { navigation?: EventTarget }).navigation;
  const schedule = () => {
    timer ??= setTimeout(check, 100);
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
  function unwatch(): void {
    clearOffer();
    clearTimeout(shownTimer);
    shownTimer = undefined;
    observer?.disconnect();
    observer = undefined;
    clearTimeout(timer);
    timer = undefined;
    removeEventListener("popstate", pageChanged);
    navigation?.removeEventListener("currententrychange", pageChanged);
  }
  /**
   * Decides what a page offered for generation that showed no sign-in input is. When it is
   * nothing to send, a sign-in input may still be offered until the window ends.
   */
  function decideOffer(): void {
    clearDecision();
    // A page that shows no sign-in input by now may list accounts (ADR 0028) or, when
    // its URL names another path of its site, hold the site's sign-in entry (ADR
    // 0031), ask for an account identifier alone (ADR 0016) or show a passkey button (ADR
    // 0053). The page right after a submitted password form offers none of them.
    const bare = !cancelled && !starts.some(ready) && !showsSignIn() && !afterSubmitted();
    const noInput = bare ? noInputOffer(document, entryWanted && !entryOffered) : undefined;
    // Nothing to send yet, or a list announced only for the log, which waits for the window.
    if (
      !noInput ||
      (noInput.kind === "list" && !noInput.entry && noInput.accounts && logOnly(noInput.accounts))
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
    offered = true;
    watch(starts);
    const bare = !cancelled && !starts.some(ready) && !showsSignIn() && !afterSubmitted();
    const accounts = bare ? listedAccounts(document) : undefined;
    if (accounts && logOnly(accounts)) void announce(false, false, accounts).catch(() => undefined);
    // Nothing was sent: the log says why (ADR 0019).
    else if (!cancelled && !starts.some(ready))
      void sendMessage("login", {
        version: 1,
        type: "login.document.ready",
        token,
        unoffered: {
          path: pagePath(),
          why: afterSubmitted() ? "after-sign-in" : showsSignIn() ? "sign-in-shown" : "no-list",
        },
      }).catch(() => undefined);
  }
  function watch(list: LoginReadiness[], offer = false, entryPage = false): void {
    starts = list;
    generate = offer && !offered;
    entryWanted = generate && entryPage;
    if (!generate) clearOffer();
    else if (offerWindow === undefined) {
      offerQuiet = setTimeout(decideOffer, offerQuietMs);
      offerCap = setTimeout(decideOffer, offerWaitMs);
      offerWindow = setTimeout(endOffer, LOGIN_STEP_WAIT_MS);
    }
    if ((!starts.length && !generate) || cancelled) {
      unwatch();
      return;
    }
    if (!observer) {
      observer = new MutationObserver(pageChanged);
      // Only attributes that can change whether a target matches, shows or accepts input.
      observer.observe(document, {
        subtree: true,
        childList: true,
        // Button text locators also depend on text, `value`, `alt` and hidden subtrees.
        characterData: true,
        attributes: true,
        attributeFilter: [
          "id",
          "name",
          "data-testid",
          "data-test",
          "type",
          "autocomplete",
          "hidden",
          "style",
          "class",
          "open",
          "disabled",
          "readonly",
          "value",
          "alt",
          "aria-hidden",
          "aria-disabled",
          "inert",
          "role",
          "onclick",
          "href",
        ],
      });
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
  // Announce once per appearance; a form that disappears and reappears announces again.
  function check(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!observer) return;
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
      if (generate && !offered && showsSignIn()) {
        offered = true;
        // The page's one offer: the window's end would only report it for the log, and
        // could overtake this announcement in the worker.
        clearOffer();
        void announce(false, true).catch(() => undefined);
      }
      noteShown();
    }
  }
  /**
   * Reports, for the log only, a sign-in input that still shows without a ready first step
   * after the step wait, once per path. A page that renders its form in parts starts its
   * login before then and is not reported. The reply changes nothing here: the page keeps
   * watching, and no generation is offered for it.
   */
  function noteShown(): void {
    const path = pagePath();
    if (shownTimer || shown.has(path) || !showsSignIn()) return;
    shownTimer = setTimeout(() => {
      shownTimer = undefined;
      if (
        !observer ||
        cancelled ||
        pagePath() !== path ||
        shown.has(path) ||
        starts.some(ready) ||
        !showsSignIn()
      )
        return;
      shown.add(path);
      void sendMessage("login", {
        version: 1,
        type: "login.document.ready",
        token,
        shown: { path },
      }).catch(() => undefined);
    }, LOGIN_STEP_WAIT_MS);
  }
  /** Whether this path is the one this document showed next after a submitted password form. */
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
    });
    const parsed = v.safeParse(readySchema, result);
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
    } else {
      // A policy refusal (no account, another tab owns the site, ...) holds until the page
      // is loaded again; re-announcing on every re-render would only repeat it.
      unwatch();
    }
    return result;
  }
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
    message,
    sender,
    respond,
  ) => {
    if (sender.id !== browser.runtime.id || sender.tab) return false;
    if (v.safeParse(reconnectSchema, message).success) {
      // A restarted worker forgot earlier refusals; a ready form may start again.
      void announce(starts.some(ready)).then(respond, () => respond({ ok: false }));
      return true;
    }
    const parsed = v.safeParse(commandSchema, message);
    if (!parsed.success || parsed.output.token !== token) return false;
    const command = parsed.output;
    if (command.type === "login.cancel") {
      cancelled = true;
      unwatch();
      respond({ ok: true });
      return false;
    }
    if (command.type === "login.choose") {
      const choice =
        cancelled || pagePath() !== command.path || showsSignIn()
          ? undefined
          : listChoice(document, command.list);
      command.list.username = "";
      command.list.others.fill("");
      respond(
        !choice
          ? { ok: false }
          : choice.click === "none"
            ? { ok: true, click: "none", miss: choice.miss }
            : { ok: true, click: choice.click },
      );
      return false;
    }
    if (command.type === "login.switch") {
      const pending = pendingSwitch;
      pendingSwitch = undefined;
      // The page may have changed since the fill; click only the same, still unique element.
      const click =
        !cancelled &&
        pending?.operationId === command.operationId &&
        Date.now() < pending.expiresAt &&
        pagePath() === pending.path &&
        switchable(pending.element) &&
        isOnly(findTargets(document, pending.target, { links: true }), pending.element);
      if (!click) {
        respond({ ok: false });
        return false;
      }
      // The switch is withdrawn only when the page got no press: one the page stopped after
      // `pointerdown` may already have switched.
      const pressing = () => !cancelled && pagePath() === pending.path;
      void pressElement(pending.element, pressing).then(
        (pressed) => respond({ ok: pressed !== "missed" }),
        () => respond({ ok: true }),
      );
      return true;
    }
    if (command.type === "login.await") {
      // Polls the current DOM serially until the step's elements are ready; never mutates.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        // Cancellation is set by the independent background message listener.
        // eslint-disable-next-line no-unmodified-loop-condition
        while (!cancelled && !ready(command.readiness)) {
          if (Date.now() >= until) return { ok: false, reason: "timeout" };
          // eslint-disable-next-line no-await-in-loop
          await pause(50);
        }
        return cancelled ? { ok: false, reason: "cancelled" } : { ok: true };
      })().then(respond, () => respond({ ok: false, reason: "cancelled" }));
      return true;
    }
    if (command.type === "login.status") {
      // Pages are untrusted; only the synthetic probe fixture observes attempt status.
      if (probeStatus)
        window.postMessage(
          {
            type: "pateat.login.probe.status",
            status: {
              state: command.state,
              stepIndex: command.stepIndex,
              ...(command.outcome ? { outcome: command.outcome } : {}),
            },
          },
          location.origin,
        );
      respond({ ok: true });
      // A finished login keeps watching: its first step showing again logs in again.
      // A new login in this document, as after a pick, watches for its own end.
      if (command.state === "executing") ended = false;
      if (!ended && (command.state === "authenticated" || command.state === "blocked")) {
        ended = true;
        rejected = command.outcome === "credential-rejected";
        void announce(false).catch(() => undefined);
      }
      return false;
    }
    if (command.type === "login.entry.hosts") {
      respond(cancelled ? { ok: false } : { ok: true, hosts: entryHosts(document) });
      return false;
    }
    if (command.type === "login.entry.inspect") {
      // Polls the current DOM until the target names one shown element; never mutates.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        const find = () => matches(command.target, true);
        let found = find();
        // A link still rendering, or not shown yet, gets the step wait. Cancellation is set
        // by the independent background message listener.
        for (;;) {
          const waiting =
            found.length === 0 ||
            (found.length === 1 && entryElementRefusal(found[0]!) === "hidden");
          if (cancelled || Date.now() >= until || !waiting) break;
          // eslint-disable-next-line no-await-in-loop
          await pause(100);
          found = find();
        }
        if (cancelled) return { ok: false };
        const url = location.href;
        if (found.length !== 1)
          return { ok: true, state: found.length ? "ambiguous" : "missing", url };
        const element = found[0]!;
        const refusal = entryElementRefusal(element);
        return {
          ok: true,
          state: "unique",
          url,
          ...(refusal ? { refusal } : {}),
          ...(element instanceof HTMLAnchorElement ? { href: element.href } : {}),
        };
      })().then(respond, () => respond({ ok: false }));
      return true;
    }
    if (command.type === "login.entry.press") {
      // Pressed only as the worker checked it: the same URL, one link, the same `href`.
      const found = matches(command.target, true);
      const element = found.length === 1 ? found[0] : undefined;
      const reason = cancelled
        ? "cancelled"
        : location.href !== command.url
          ? "page-changed"
          : !(element instanceof HTMLAnchorElement) ||
              entryElementRefusal(element) !== undefined ||
              element.href !== command.href
            ? "target-changed"
            : undefined;
      if (reason || !(element instanceof HTMLAnchorElement)) {
        respond({ ok: false, reason: reason ?? "target-changed" });
        return false;
      }
      watchPressedUrl();
      // A press the page stopped after `pointerdown` is answered as made, so the link is not
      // pressed again; one that never reached `pointerdown` did not press it.
      void pressElement(element, () => !cancelled && location.href === command.url).then(
        (pressed) =>
          respond(
            pressed !== "missed"
              ? { ok: true }
              : {
                  ok: false,
                  reason: cancelled
                    ? "cancelled"
                    : location.href === command.url
                      ? "target-changed"
                      : "page-changed",
                },
          ),
        () => respond({ ok: true }),
      );
      return true;
    }
    if (command.type === "login.logout.click") {
      // An account switch's click (ADR 0063): waits for the control to show, as a menu's
      // item does once the menu opens, then presses it as the executor presses a button.
      const url = location.href;
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        const find = () =>
          findLogoutTargets(document, command.target).filter(
            (element): element is HTMLElement => element instanceof HTMLElement && visible(element),
          );
        let found = find();
        for (;;) {
          if (cancelled || found.length > 0 || Date.now() >= until) break;
          // eslint-disable-next-line no-await-in-loop
          await pause(100);
          found = find();
        }
        if (cancelled) return { ok: false, reason: "cancelled" };
        if (location.href !== url) return { ok: false, reason: "page-changed" };
        if (found.length !== 1)
          return { ok: false, reason: found.length ? "ambiguous" : "missing" };
        const control = found[0]!;
        const before = shownLayers(document);
        const pressed = await pressElement(control, () => !cancelled && location.href === url);
        if (pressed === "missed")
          return { ok: false, reason: cancelled ? "cancelled" : "page-changed" };
        if (command.watchMs === undefined) return { ok: true };
        // How the page reacts to a control found by its words (ADR 0063): a page that
        // navigates away ends this script, which the worker reads as navigated.
        const watchUntil = Date.now() + command.watchMs;
        for (;;) {
          if (cancelled) return { ok: false, reason: "cancelled" };
          if (location.href !== url) return { ok: true, reacted: "navigated" };
          if (shownLayers(document) > before) return { ok: true, reacted: "dialog" };
          if (!control.isConnected || !visible(control)) return { ok: true, reacted: "changed" };
          if (Date.now() >= watchUntil) return { ok: true, reacted: "none" };
          // eslint-disable-next-line no-await-in-loop
          await pause(100);
        }
      })().then(respond, () => respond({ ok: false, reason: "missing" }));
      return true;
    }
    if (command.type === "login.logout.local") {
      try {
        respond(extractLocalLogout(document));
      } catch {
        respond({ ok: false, reason: "none" });
      }
      return true;
    }
    if (command.type === "login.entry.check") {
      // The page after an entry press: polls until a sign-in input, an input that asks for
      // an account identifier alone (ADR 0016), or a first step shows.
      void (async () => {
        const until = Date.now() + command.timeoutMs;
        for (;;) {
          if (cancelled) return { ok: false };
          const signIn = showsSignIn() || identifierInput(document) !== undefined;
          const start = command.starts.some(ready);
          if (signIn || start || Date.now() >= until)
            return { ok: true, signIn, start, signUp: showsSignUp(document) };
          // eslint-disable-next-line no-await-in-loop
          await pause(100);
        }
      })().then(respond, () => respond({ ok: false }));
      return true;
    }
    if (command.type === "login.extract") {
      if (cancelled) {
        respond({ ok: false, reason: "cancelled" });
        return false;
      }
      let result: unknown;
      try {
        const onSite = new Set(command.onSite ?? []);
        result =
          command.page === "passkey"
            ? extractPasskeyObservation(document)
            : command.page === "login"
              ? extractLoginObservation(document, command.known)
              : command.page === "accounts"
                ? extractAccountListObservation(document, command.names)
                : command.page === "entry"
                  ? extractEntryObservation(document, (url) => onSite.has(url.hostname))
                  : command.page === "logout"
                    ? extractLogoutObservation(document)
                    : extractSignedInObservation();
      } catch {
        // A page the extractor cannot read still gets an answer the log can name.
        result = { ok: false, reason: "extract-error" };
      }
      respond(result);
      return false;
    }
    if (command.type === "login.state") {
      const username = command.account?.username;
      if (command.account) command.account.username = "";
      // The sign-in form shown again in a new document: its inputs each target names alone.
      const reshown = command.fields?.flatMap((target) => {
        const found = matches(target);
        return found.length === 1 && writable(found[0]) ? [found[0]] : [];
      });
      respond(
        cancelled
          ? { ok: false }
          : {
              ok: true,
              signs: pageSigns(document, {
                ...(reshown ? { reshown } : submitted ? { submitted } : {}),
                ...(username === undefined ? {} : { username }),
              }),
              loaded: document.readyState === "complete",
            },
      );
      return false;
    }
    if (command.type === "login.observe") {
      if (cancelled) {
        respond({ ok: false, reason: "cancelled" });
        return false;
      }
      const observeOptions = (index: number) => ({
        links: command.links?.[index] === true,
        hidden: command.hidden?.[index] === true,
      });
      respond({
        path: pagePath(),
        targets: command.targets.map((target, index) =>
          targetState(document, target, command.require?.[index], observeOptions(index)),
        ),
        ...(command.signIn
          ? {
              signIn: {
                loaded: document.readyState === "complete",
                ...credentialInputs(command.targets),
              },
            }
          : {}),
        ...(command.explain
          ? {
              checks: command.targets.map((target, index) =>
                targetCheck(document, target, command.require?.[index], observeOptions(index)),
              ),
            }
          : {}),
      });
      return false;
    }
    // An advance's next step as measured just before its effect, answered with the result.
    let before: TargetState[] | undefined;
    void (async () => {
      const operation = command.operation;
      let mutated = false;
      const fail = (
        reason:
          | "structural-mismatch"
          | "timeout"
          | "cancelled"
          | "wrong-account"
          | "value-mismatch"
          | "fill-rejected"
          | "submitted"
          | "captcha",
        detail?: ExecutionDetail,
      ) => ({
        ok: false,
        reason,
        ...(detail ? { detail } : {}),
        mutation: mutated ? "possible" : "none",
      });
      const authorized: unknown = await sendMessage("login", {
        version: 1,
        type: "login.operation.authorize",
        token,
        attemptId: operation.attemptId,
        operationId: operation.operationId,
      });
      if (authorized !== true) return fail("cancelled", "not-authorized");
      /**
       * Why the step may not send its form where `read` says it goes: a destination the
       * page refuses, or one off the document's origin that the background does not allow
       * by the login's vault item (ADR 0051). The destinations are read again after the
       * answers, and one that changed meanwhile refuses the step as a changed form.
       */
      const destinationRefusal = async (
        read: () => FormDestination[],
      ): Promise<ExecutionDetail | undefined> => {
        const destinations = read();
        if (destinations.some((entry) => entry.kind === "refused")) return "form-off-origin";
        const answers = await Promise.all(
          destinations.flatMap((entry) =>
            entry.kind === "other-origin"
              ? [
                  sendMessage("login", {
                    version: 1,
                    type: "login.destination.check",
                    token,
                    attemptId: operation.attemptId,
                    operationId: operation.operationId,
                    destination: entry.url,
                  })
                    // A worker that cannot answer, as while it restarts, leaves it unchecked.
                    .catch(() => undefined)
                    .then((answer) => v.safeParse(destinationAnswerSchema, answer)),
                ]
              : [],
          ),
        );
        if (cancelled) return "document-cancelled";
        if (Date.now() >= operation.expiresAt) return "operation-expired";
        if (answers.some((answer) => !answer.success)) return "form-destination-unchecked";
        const refusals = answers.flatMap((answer) =>
          answer.success && !answer.output.ok ? [answer.output.reason] : [],
        );
        if (refusals.some((reason) => reason !== "unchecked")) return "form-off-origin";
        if (refusals.length) return "form-destination-unchecked";
        if (JSON.stringify(read()) !== JSON.stringify(destinations)) return "form-changed";
        return undefined;
      };
      if (cancelled) return fail("cancelled", "document-cancelled");
      if (used.has(operation.operationId)) return fail("cancelled", "operation-used");
      if (Date.now() >= operation.expiresAt) return fail("cancelled", "operation-expired");
      // The document's own origin, opaque ("null") in a sandboxed document whatever its URL.
      if (operation.document.origin !== self.origin || operation.step.path !== pagePath())
        return fail("cancelled", "page-changed");
      used.add(operation.operationId);
      const step = operation.step;
      // Another attempt in this document starts from nothing filled.
      if (operation.attemptId !== filledAttempt) {
        filled = new WeakSet();
        shownBefore = undefined;
        filledAttempt = operation.attemptId;
      }
      // With an advance whose next step is on its path, that step's elements just before
      // the click or the first input; the answer reports them (ADR 0013).
      const measureNext = () => {
        const next = command.next;
        if (next)
          before = next.targets.map((target) => targetState(document, target, next.require));
      };
      /**
       * Submits the form of `target`, the field the fill just before typed last, as pressing
       * Enter there does (ADR 0064): a click on the form's default button, its first submit
       * button in tree order, or `requestSubmit()` when it has none, as the official
       * auto-submit falls back to. Enter on a disabled default button submits nothing, and
       * a default button that showed when a fill began (`submitsBefore`), which the
       * generation could have named, or one only associated with the form from outside it,
       * is never pressed. The
       * page's own validation must pass, and the checks of a click run first: the
       * destination (ADR 0051), the form still holding its fills, and a CAPTCHA left to the
       * person, who then presses Enter or the button.
       */
      const pressEnter = async (target: LoginTarget, submit: boolean) => {
        const found = matches(target);
        const field = found.length === 1 ? found[0] : undefined;
        if (!writable(field) || !filled.has(field) || !field.form)
          return fail("structural-mismatch", "target-missing");
        const form = field.form;
        // The first submit button the form owns in tree order; `form.elements` leaves out
        // image inputs.
        const defaultButton = () =>
          [...document.querySelectorAll("button, input")].find(
            (element): element is HTMLButtonElement | HTMLInputElement =>
              submitButton(element) && element.form === form,
          );
        const button = defaultButton();
        if (
          button &&
          (button.matches(":disabled") || submitsBefore.has(button) || !form.contains(button))
        )
          return fail("structural-mismatch", "target-missing");
        if (!form.noValidate && !button?.formNoValidate && !form.checkValidity())
          return fail("fill-rejected");
        const refused = await destinationRefusal(() =>
          button ? clickDestinations(button) : [formDestination(field, "fill")],
        );
        if (refused === "document-cancelled" || refused === "operation-expired")
          return fail("cancelled", refused);
        if (refused) return fail("structural-mismatch", refused);
        if (pagePath() !== step.path) return fail("cancelled", "page-changed");
        // The page may have changed the form while the background answered.
        if (
          !form.isConnected ||
          field.form !== form ||
          defaultButton() !== button ||
          button?.matches(":disabled")
        )
          return fail("structural-mismatch", "form-changed");
        const formInputs = [...form.elements].filter((input) => input instanceof HTMLInputElement);
        const fills = filled;
        const passwordsBefore = shownBefore;
        filled = new WeakSet();
        shownBefore = undefined;
        if (
          unreadyForm(formInputs, {
            filled: (input) => fills.has(input),
            shownBefore: (input) => passwordsBefore?.has(input) === true,
            writable,
            submit,
          })
        )
          return fail("structural-mismatch", "form-changed");
        measureNext();
        submitted = submittedPage(document, formInputs.filter(writable));
        if (showsCaptcha(document) && !passedCaptcha(document)) return fail("captcha");
        mutated = true;
        if (button) button.click();
        else form.requestSubmit();
        return { ok: true, mutation: "possible" } as const;
      };
      if (step.kind === "fill") {
        // A fill compared with the shown account waits for the page to settle while the
        // page shows nothing to compare with, so an account it shows after its fields is
        // compared too (`accountQuietMs`).
        const masked = command.values.some(
          (entry) => entry.secret === "password" || entry.secret === "hidden",
        );
        if (command.account) {
          const first = step.fields[0] ? matches(step.fields[0].target) : [];
          const form =
            first.length === 1 && first[0] instanceof HTMLInputElement ? first[0].form : null;
          const comparable = comparableAccounts(
            shownAccounts(accountText(document, form)),
            command.account.username,
            { masked },
          );
          if (comparable?.length === 0) {
            await settled(
              document,
              accountQuietMs,
              Math.min(Date.now() + accountWaitMs, operation.expiresAt - accountReserveMs),
            );
            if (cancelled) return fail("cancelled", "document-cancelled");
            if (Date.now() >= operation.expiresAt) return fail("cancelled", "operation-expired");
            if (step.path !== pagePath()) return fail("cancelled", "page-changed");
          }
        }
        // Resolve every target first so a partial/ambiguous mapping never causes partial fill.
        const inputs = step.fields.map((field) => {
          const found = matches(field.target);
          return found.length === 1 ? found[0] : undefined;
        });
        if (inputs.some((input) => !writable(input)))
          return fail("structural-mismatch", "target-missing");
        if (
          command.values.length !== step.fields.length ||
          step.fields.some(
            (field) => command.values.filter((entry) => entry.slot === field.slot).length !== 1,
          )
        )
          return fail("structural-mismatch", "unexpected-values");
        // Each field has its own input: two locators that name one input would leave only
        // the second value in it, and the form would be sent with the wrong value.
        if (new Set(inputs).size !== inputs.length)
          return fail("structural-mismatch", "fields-shared");
        // One step fills one form (or only inputs outside any form), and secrets only fit their inputs.
        const writableInputs = inputs as HTMLInputElement[];
        const form = writableInputs[0]!.form;
        if (writableInputs.some((input) => input.form !== form))
          return fail("structural-mismatch", "fields-split");
        // The form sends its values only to this document's origin, or to a destination
        // the background allows (ADR 0051).
        const formRefused = await destinationRefusal(() => [
          formDestination(writableInputs[0]!, "fill"),
        ]);
        if (formRefused === "document-cancelled" || formRefused === "operation-expired")
          return fail("cancelled", formRefused);
        if (formRefused) return fail("structural-mismatch", formRefused);
        if (
          step.fields.some(
            (field, index) =>
              !acceptsSecret(
                writableInputs[index]!,
                command.values.find((entry) => entry.slot === field.slot)!.secret,
              ),
          )
        )
          return fail("structural-mismatch", "secret-refused");
        // A secret goes only to the account the page shows, when it shows one (owner
        // decision, 2026-10-11). The comparison stays in this content script.
        if (command.account) {
          const other = showsOtherAccount(
            shownAccounts(accountText(document, form)),
            command.account.username,
            { masked },
          );
          command.account.username = "";
          if (other) {
            // The recipe's account switch is clicked once the background has recorded the
            // switch, so a recipe that starts on the page it leads to can log in.
            const found = command.accountSwitch
              ? findTargets(document, command.accountSwitch, { links: true })
              : [];
            const element = found.length === 1 ? found[0] : undefined;
            if (command.accountSwitch && switchable(element)) {
              pendingSwitch = {
                operationId: operation.operationId,
                element,
                target: command.accountSwitch,
                path: pagePath(),
                expiresAt: Date.now() + switchTimeoutMs,
              };
              return { ...fail("wrong-account"), switchable: true as const };
            }
            return fail("wrong-account");
          }
        }
        // A `totp` handler's code split into one input per digit goes in one digit per
        // input (ADR 0027, owner decision 2026-10-12 19:21 UTC).
        const split =
          command.code && step.effect === "prepare" && step.fields.length === 1
            ? splitCodeInputs(writableInputs[0]!, command.values[0]!.value.length, writable)
            : undefined;
        const fits = (input: HTMLInputElement, value: string) =>
          split
            ? split.every((digit, index) => inputValueMismatch(digit, value[index]!) === undefined)
            : inputValueMismatch(input, value) === undefined;
        // Every value must fit its input before anything is filled (ADR 0010).
        if (
          step.fields.some(
            (field, index) =>
              !fits(
                writableInputs[index]!,
                command.values.find((entry) => entry.slot === field.slot)!.value,
              ),
          )
        )
          return fail("value-mismatch");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) return fail("structural-mismatch", "unsupported-input");
        // Messages already shown are not the page's answer to this fill.
        const baseline =
          step.effect === "prepare" ? fillBaseline(split ?? writableInputs) : undefined;
        // A code field fills alone; its watch starts before the code goes in (ADR 0027).
        const code =
          command.code && step.effect === "prepare" && step.fields.length === 1
            ? watchCodeSubmission(
                writableInputs[0]!,
                step.fields[0]!.target,
                command.code.submit,
                step.path,
              )
            : undefined;
        if (command.code && !code) return fail("structural-mismatch", "code-watch-failed");
        try {
          for (const [index, field] of step.fields.entries()) {
            const input = inputs[index] as HTMLInputElement;
            // A preparing fill lets the page's handlers for the previous field run first.
            // eslint-disable-next-line no-await-in-loop
            if (index > 0 && step.effect === "prepare") await pause(FIELD_GAP_MS);
            // Each mutation repeats scope/connected checks; events and the wait between
            // fields may change the page.
            const current = matches(field.target);
            const value = command.values.find((entry) => entry.slot === field.slot)!;
            if (
              cancelled ||
              pagePath() !== step.path ||
              current.length !== 1 ||
              current[0] !== input ||
              !writable(input) ||
              input.form !== form ||
              !acceptsSecret(input, value.secret) ||
              !fits(input, value.value)
            )
              return fail(
                "cancelled",
                cancelled
                  ? "document-cancelled"
                  : pagePath() !== step.path
                    ? "page-changed"
                    : "field-changed",
              );
            // An advance's next step is measured in this task, just before its first input,
            // and so is what the page shows before an effect (ADR 0029).
            if (index === 0) {
              measureNext();
              if (step.effect !== "prepare") submitted = submittedPage(document, writableInputs);
            }
            // Mark uncertainty before calling into DOM/page code, including a throwing setter.
            mutated = true;
            if (!shownBefore && (!submitsTaken || writableInputs.every((other) => !other.value))) {
              for (const other of document.querySelectorAll("button, input"))
                if (submitButton(other) && visible(other)) submitsBefore.add(other);
              submitsTaken = true;
            }
            shownBefore ??= new WeakSet(
              [...document.querySelectorAll("input")].filter(
                (other) => other.type === "password" && writable(other),
              ),
            );
            if (split) {
              // As typed: the code is in with its last digit.
              for (const [place, digit] of split.entries()) {
                // eslint-disable-next-line no-await-in-loop
                if (place > 0) await pause(FIELD_GAP_MS);
                // The page's handlers for an earlier digit may have changed this input; the
                // same checks run after each wait of the digit's own typing.
                const scope = () =>
                  cancelled
                    ? "document-cancelled"
                    : pagePath() !== step.path
                      ? "page-changed"
                      : !writable(digit) ||
                          digit.form !== form ||
                          digit.maxLength !== 1 ||
                          !acceptsSecret(digit, value.secret) ||
                          inputValueMismatch(digit, value.value[place]!) !== undefined
                        ? "field-changed"
                        : undefined;
                const changed = scope();
                if (changed) return fail("cancelled", changed);
                filled.add(digit);
                // eslint-disable-next-line no-await-in-loop
                const stopped = await typeValue(digit, value.value[place]!, setter, {
                  beforeInput: place === split.length - 1 ? code?.typed : undefined,
                  between: scope,
                });
                // A page that took the code with its last digit may change or clear its
                // form at once; the code watch says so first.
                if (stopped && code?.submitted()) return fail("submitted");
                // A digit the page kept out is never followed by the rest.
                if (stopped === "refused") return fail("fill-rejected");
                if (stopped) return fail("cancelled", stopped);
              }
            } else if (step.effect === "prepare") {
              filled.add(input);
              // The code goes in now; the page's own reaction is measured from here. The
              // page may change between characters, so each one repeats the checks.
              // eslint-disable-next-line no-await-in-loop
              const stopped = await typeValue(input, value.value, setter, {
                beforeInput: code?.typed,
                between: () => {
                  if (cancelled) return "document-cancelled";
                  if (pagePath() !== step.path) return "page-changed";
                  const now = matches(field.target);
                  return now.length !== 1 ||
                    now[0] !== input ||
                    !writable(input) ||
                    input.form !== form ||
                    !acceptsSecret(input, value.secret) ||
                    !fits(input, value.value)
                    ? "field-changed"
                    : undefined;
                },
              });
              if (stopped && code?.submitted()) return fail("submitted");
              // A value the page kept a character of out is never submitted.
              if (stopped === "refused") return fail("fill-rejected");
              if (stopped) return fail("cancelled", stopped);
            } else {
              // An advance or a submission through the page's own event gets that one event
              // alone, with no focus, keys or blur that could run its effect again.
              filled.add(input);
              setter.call(input, value.value);
              input.dispatchEvent(new Event(step.event!, { bubbles: true }));
            }
            value.value = "";
          }
          // A fill that submits through its own event ends what the next click checks.
          if (step.effect !== "prepare") {
            filled = new WeakSet();
            shownBefore = undefined;
          }
          // A code page that submits the code by itself must not get a click as well: the
          // button is clicked only when nothing showed a submission during the watch. Its
          // status regions may announce that submission, so only alerts and the field's own
          // marks reject the code (ADR 0027).
          if (code && baseline) {
            const until = Date.now() + CODE_SETTLE_MS;
            // eslint-disable-next-line no-unmodified-loop-condition
            while (!cancelled && Date.now() < until) {
              if (code.submitted()) return fail("submitted");
              // eslint-disable-next-line no-await-in-loop
              await pause(50);
            }
            if (cancelled) return fail("cancelled", "document-cancelled");
            if (code.submitted()) return fail("submitted");
            if (rejectsFill(split ?? writableInputs, baseline, { statuses: false }))
              return fail("fill-rejected");
            return { ok: true, mutation: "possible" };
          }
          // A preparing fill is followed by a click; the page's own validation must accept
          // the values first. An effectful fill has already submitted through its event.
          if (baseline) {
            await pause(fillSettleMs);
            if (cancelled) return fail("cancelled", "document-cancelled");
            // The page replaced the form, perhaps signing in by itself; the background
            // observes the page instead of clicking.
            if (writableInputs.some((input) => !input.isConnected))
              return fail("structural-mismatch", "form-replaced");
            if (rejectsFill(writableInputs, baseline)) return fail("fill-rejected");
          }
          return { ok: true, mutation: "possible" };
        } finally {
          code?.stop();
        }
      }
      if (command.values.length) return fail("structural-mismatch", "unexpected-values");
      if (step.kind === "click" && step.press === "enter")
        return await pressEnter(step.target, step.purpose === "submit");
      if (step.kind === "click") {
        let element: HTMLElement | undefined;
        if (command.list) {
          // A chooser's click on its list goes where the list's choice is now (ADR 0028).
          const choice = listChoice(document, command.list);
          command.list.username = "";
          command.list.others.fill("");
          element = choice.click === command.list.click ? choice.element : undefined;
          if (!element) return fail("structural-mismatch", "target-missing");
        } else {
          // A control named by its accessible name is only ever a `password` handler's
          // button, which may be a link to a fragment of the page (ADR 0048 amendment of
          // 2026-10-19).
          const named = step.target.by === "accessible-name";
          if (named && !command.passwordChoice)
            return fail("structural-mismatch", "target-missing");
          const found = matches(step.target);
          const only = found.length === 1 ? found[0] : undefined;
          if (!clickable(only, { fragment: named }))
            return fail("structural-mismatch", "target-missing");
          // A `password` handler's button whose text no longer names the password, as one
          // the page rendered again with other text, is never pressed (ADR 0048).
          if (command.passwordChoice && !passwordChoice(only, { fragment: named }))
            return fail("structural-mismatch", "target-missing");
          element = only;
        }
        // A click that submits a form sends it, through the button's own `formaction` too,
        // only to this document's origin or a destination the background allows (ADR 0051),
        // also when the element sits inside the submit button or labels it. Any other click
        // submits no form.
        const clicked = element;
        const submitRefused = await destinationRefusal(() => clickDestinations(clicked));
        if (submitRefused === "document-cancelled" || submitRefused === "operation-expired")
          return fail("cancelled", submitRefused);
        if (submitRefused) return fail("structural-mismatch", submitRefused);
        // The click's form's inputs, or the page's for an element outside a form.
        const form = isButton(element) ? element.form : element.closest("form");
        const formInputs = [...(form ? form.elements : document.querySelectorAll("input"))].filter(
          (input) => input instanceof HTMLInputElement,
        );
        const fills = filled;
        const passwordsBefore = shownBefore;
        // The next fills are checked against the next click.
        filled = new WeakSet();
        shownBefore = undefined;
        // The page changed the form under the fill: never send it without its values.
        if (
          unreadyForm(formInputs, {
            filled: (input) => fills.has(input),
            shownBefore: (input) => passwordsBefore?.has(input) === true,
            writable,
            submit: step.purpose === "submit",
          })
        )
          return fail("structural-mismatch", "form-changed");
        // An advance's next step is measured in this task, just before the click, and so
        // is what the page shows before it (ADR 0029).
        measureNext();
        submitted = submittedPage(document, formInputs.filter(writable));
        // A CAPTCHA the page shows and that has not passed is left to the person, who
        // presses the button after solving it; the background reads the page as after a
        // click (ADR 0029, S4).
        if (!command.list && showsCaptcha(document) && !passedCaptcha(document))
          return fail("captcha");
        mutated = true;
        // The page may change between the press's events, as the fill's checks allow for:
        // a press the page stopped after `pointerdown` may have acted as the click, so it is
        // answered as made; one the moving events already stopped clicked nothing.
        const pressing = () =>
          !cancelled && pagePath() === step.path && Date.now() < operation.expiresAt;
        if ((await pressElement(element, pressing)) === "missed")
          return cancelled
            ? fail("cancelled", "document-cancelled")
            : pagePath() !== step.path
              ? fail("cancelled", "page-changed")
              : Date.now() >= operation.expiresAt
                ? fail("cancelled", "operation-expired")
                : fail("structural-mismatch", "target-missing");
        return { ok: true, mutation: "possible" };
      }
      // An element that must be missing counts every copy, hidden or not, as a marker's
      // `absent` element does (ADR 0037 amendment of 2026-10-22).
      const satisfied = () => {
        const count = findTargets(document, step.target, { hidden: !step.present }).length;
        return step.present ? count === 1 : count === 0;
      };
      if (step.kind === "assert")
        return satisfied()
          ? { ok: true, mutation: "none" }
          : fail("structural-mismatch", "assert-failed");
      const until = Math.min(operation.expiresAt, Date.now() + step.timeoutMs);
      // Cancellation is set by the independent background message listener.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!cancelled && Date.now() < until && pagePath() === step.path) {
        if (satisfied()) return { ok: true, mutation: "none" };
        // Poll the current DOM serially; parallel polls cannot observe later render states.
        // eslint-disable-next-line no-await-in-loop
        await pause(50);
      }
      // The page moving to another path ends the wait early; that is not a timeout.
      return cancelled
        ? fail("cancelled", "document-cancelled")
        : pagePath() !== step.path
          ? fail("timeout", "page-changed")
          : fail("timeout");
    })()
      // A thrown execution may already have mutated the page. Never advertise a safe retry.
      .then(
        (result) =>
          respond({
            ...result,
            ...(before && (result.ok || ("reason" in result && result.reason === "captcha"))
              ? { before }
              : {}),
            operationId: command.operation.operationId,
            documentId: command.operation.document.documentId,
          }),
        () =>
          respond({
            ok: false,
            reason: "cancelled",
            detail: "threw",
            mutation: "possible",
            operationId: command.operation.operationId,
            documentId: command.operation.document.documentId,
          }),
      )
      .finally(() => {
        for (const entry of command.values) entry.value = "";
        if (command.account) command.account.username = "";
        if (command.list) {
          command.list.username = "";
          command.list.others.fill("");
        }
      });
    return true;
  };
  /**
   * After an entry press, a same-document URL change within the step wait is the next page
   * (ADR 0031): the document announces again so the worker checks it. A press that leads to
   * a new document needs nothing here; that document announces itself.
   */
  function watchPressedUrl(): void {
    const from = location.href;
    const until = Date.now() + LOGIN_STEP_WAIT_MS;
    const poll = setInterval(() => {
      if (cancelled || Date.now() > until) clearInterval(poll);
      else if (location.href !== from) {
        clearInterval(poll);
        void announce(false).catch(() => undefined);
      }
    }, 100);
  }
  /**
   * A form with a password input submitted in this document: its next path here, and the
   * tab's next document if it is of the same origin, are not offered as a list of accounts
   * (ADR 0028), as a sign-in entry (ADR 0031) or as a page asking for an identifier alone
   * (ADR 0016). Nothing about the form or its values is
   * sent. Pateat's own submissions count too; their pages belong to a login anyway.
   */
  const onSubmit = (event: Event) => {
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      ![...form.elements].some(
        (element) => element instanceof HTMLInputElement && element.type === "password",
      )
    )
      return;
    submitPath = pagePath();
    afterSubmit = undefined;
    void sendMessage("login", { version: 1, type: "login.document.submitted", token }).catch(
      () => undefined,
    );
  };
  document.addEventListener("submit", onSubmit, true);
  browser.runtime.onMessage.addListener(listener);
  void announce(false).catch(() => undefined);
  return () => {
    cancelled = true;
    unwatch();
    document.removeEventListener("submit", onSubmit, true);
    browser.runtime.onMessage.removeListener(listener);
  };
}
