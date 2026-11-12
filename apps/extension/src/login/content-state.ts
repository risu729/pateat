import { createSsoContent } from "./content-sso";
import { type LoginTarget } from "@pateat/contracts";

import { watchFrameShown } from "../page/frame-shown";
import { type SubmittedPage } from "../page/sign-in-state";
import { sendMessage } from "../messaging/protocol";
import { type LoginReadiness } from "./wire";
import { newId } from "@pateat/contracts/ids";

import { pagePath, pageUrl, type Control } from "./content-dom";

/** The single live owner of one installed document's authority and execution/watch memory. */
export class ContentState {
  token = newId();

  cancelled = false;

  cancelledNative = new Set<string>();

  ssoContent = createSsoContent(document, {
    cancelled: () => this.cancelled,
    authorize: async ({ flowId, operationId, handle, phase }) => {
      const answer: unknown = await sendMessage("login", {
        version: 1,
        type: "login.sso.authorize",
        phase,
        token: this.token,
        flowId,
        operationId,
        handle,
      });
      return answer !== null && typeof answer === "object" && "ok" in answer && answer.ok === true;
    },
  });

  // Ends every wait for a change of the page once `cancelled` is set.
  waits = new AbortController();

  // Ends the running `login.extract.watch`, once another replaces it or the login cancels.
  describedWatch: AbortController | undefined;

  // Whether the background asked for the value the page set in an account input.
  siteAccountAsked = false;

  // Set once this document's login has ended; it then watches for its first step to show
  // again, as after a logout, when the page logs in again (ADR 0062).
  ended = false;

  // The site rejected that login here: the form showing with the failure asks at once.
  rejected = false;

  // This document carries a login that has not ended, and the path its page last showed:
  // a same-document URL change to another path is reported, so a login watched after its
  // submission reads a single-page site's next route as the tab's next page (ADR 0027).
  carrying = false;

  // The SSO parent may still own this IdP document after its native child finishes.
  ssoCarrying = false;

  routePath = pagePath();

  used = new Set<string>();

  // What this document showed when its last effect step ran (ADR 0029: F1, F2).
  submitted: SubmittedPage | undefined;

  /**
   * Inputs this document's fills wrote to since the last click of the same attempt, and
   * the password inputs that were writable when the first of those fills began, for the
   * check before a click.
   */
  filled = new WeakSet<HTMLInputElement>();

  /**
   * The selects a split date's parts were chosen in since the last click, each with its
   * option (ADR 0061): the click goes on only while each still shows it.
   */
  chosen: [HTMLSelectElement, HTMLOptionElement][] = [];

  shownBefore: WeakSet<HTMLInputElement> | undefined;

  // The submit buttons this document showed when a fill began, which Enter never presses
  // (ADR 0064). A fill whose fields already hold values adds none once one fill has, so a
  // button such a page shows only for a value is not taken as one the model saw.
  submitsBefore = new WeakSet<Element>();

  submitsTaken = false;

  filledAttempt: string | undefined;

  /**
   * A fill's check of the account the page shows, left to the next click or Enter of the
   * same attempt because the page showed no identifier when it filled (ADR 0049 amendment
   * of 2026-11-03): the item's username, the form, the inputs it filled and the switch the
   * fill was sent. It never leaves this content script.
   */
  deferredAccount:
    | {
        username: string;
        masked: boolean;
        form: HTMLFormElement | null;
        inputs: Control[];
        accountSwitch?: LoginTarget;
        otherSwitch?: true;
      }
    | undefined;

  // The account switch a `wrong-account` result reported, clicked only by `login.switch`.
  pendingSwitch:
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
  starts: LoginReadiness[] = [];

  announced = false;

  // The path the last announcement was made on.
  announcedPath: string | undefined;

  // The background may generate a recipe for this page if it shows a sign-in input within
  // the step wait after it may be sent (ADR 0016); a form shown only later, for example
  // after a click, is not sent, unless the document's URL changed first.
  generate = false;

  offered = false;

  // The background answered that this document may be sent (ADR 0016) and no login took
  // it over since, and the URL, without its fragment, its window last opened at: a
  // same-document URL change, as a single-page app's route to its sign-in form, opens a
  // window for a sign-in input once more (`urlChanged`).
  mayOffer = false;

  offerUrl = pageUrl();

  // The path where this document last submitted a sign-in form (ADR 0028, amended 2026-11-08), and the
  // next path it showed after it: that page is never offered as a list of accounts or as a
  // sign-in entry.
  submitPath: string | undefined;

  afterSubmit: string | undefined;

  // The page's URL names another path of its site: once the offer wait passes without a
  // sign-in input, it is offered as a site's sign-in entry, once (ADR 0031).
  entryWanted = false;

  entryOffered = false;

  // Paths where a sign-in input stayed shown without a ready first step, reported once
  // each so the background can log a login that did not start.
  shown = new Set<string>();

  shownTimer: ReturnType<typeof setTimeout> | undefined;

  // A recipe generated as `confirm` or `unclear` starts on this path, so the page only
  // watches (ADR 0035): its first step is reported with `shown` as soon as it shows, and
  // the person's own submission of its form once per path.
  confirmPage: LoginReadiness | undefined;

  personSubmits = new Set<string>();

  // Whether this document shows in the tab's page: a frame's page is offered for
  // generation only once it does (ADR 0086), and the looks waiting for it look again then.
  frameLooks = new Set<() => void>();

  inTab!: ReturnType<typeof watchFrameShown>;

  // The pending offer's timers: its decision once the DOM is quiet (`offerQuiet`) or at the
  // latest (`offerCap`, ADR 0057), and the end of its window for a sign-in input
  // (`offerWindow`, ADR 0016). The decision is pending while `offerCap` is set.
  offerQuiet: ReturnType<typeof setTimeout> | undefined;

  offerCap: ReturnType<typeof setTimeout> | undefined;

  offerWindow: ReturnType<typeof setTimeout> | undefined;

  observer: MutationObserver | undefined;

  // The shadow trees `observer` watches, and those whose form submissions `onSubmit` hears:
  // neither a document's observer nor its listener for an event that does not cross a
  // shadow boundary, as `submit`, sees inside one (ADR 0070).
  observedRoots!: WeakSet<ShadowRoot>;

  submitRoots!: WeakSet<ShadowRoot>;

  submitListeners!: AbortController;

  // A start's retry (`retry`), whether a check is pending, and when the last one ran.
  timer: ReturnType<typeof setTimeout> | undefined;

  checking = false;

  checkedAt = Number.NEGATIVE_INFINITY;

  navigation: EventTarget | undefined;

  /**
   * Checks again shortly when a start could not be confirmed for a passing reason. Each
   * appearance of the form gets a few retries; after that it waits until the form goes.
   */
  retries = 0;

  /**
   * Follows the path of a page Pateat does not fill (ADR 0035), `followed`, from `at`, the
   * path last seen. Left in place, the page announces its new path, so the worker logs the
   * visit as left with that page next; back on it, the page announces again, and the
   * worker's answer names its first step, which with the person's submit is reported again
   * as a new visit.
   */
  followed: string | undefined;

  at: string | undefined;

  /**
   * A same-document URL change after the page's window to be sent closed, as Duolingo's
   * "I already have an account" routing to its sign-in form in place (2026-10-24), opens a
   * new window of the step wait for a sign-in input alone: one that shows within it is
   * announced, once, and the background decides as for a new page. Nothing is sent for a
   * route without one, and a list of accounts, an identifier alone or an entry is still
   * offered only after a load. Only once the background answered that the page may be
   * sent and no login took it over since, so a login under way is never announced over.
   */
  urlWatch: (() => void) | undefined;

  /**
   * Paths of this document whose sign-in input was announced to be sent, and the watch
   * that, once the page's window to be sent closed, announces a sign-in input shown in
   * place later, as Discord's form after "Add an account" (2026-11-04), once per path
   * (ADR 0016, amended 2026-11-04). Only while the background answered that the page may
   * be sent and no login took it over since; the background decides as for a new page.
   */
  offeredPaths = new Set<string>();

  lateWatch: (() => void) | undefined;
}
