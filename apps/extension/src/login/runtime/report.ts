import {
  type AttemptTimes,
  type LoginAttemptMetadata,
  type ChooserClick,
  type PageKind,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginRoute,
  type LoginEntryRecipe,
  type LogoutPurpose,
} from "@pateat/contracts";
import type { ServiceTiming } from "../../service/transport";
import { type ListMissReport as ListMiss, type ExecutionDetail, type LaterMiss } from "../wire";
import { type AskReason } from "../choice-wire";
import { type PauseLength } from "../pause";
import { decideSignInState, type ReshownMiss, type SignInSigns } from "../sign-in-state";
import type { AlertMiss } from "../../page/sign-in-state";
import { type LogoutSource } from "../switch";

/**
 * Why a login's move to another origin did not complete it (ADR 0022): no step or second
 * factor fits the move, the account has no username to look for, the page went away or
 * could not be read, it shows a sign-in step or asked for a passkey, or it never read
 * quiet twice.
 */
export type MoveMiss =
  | "no-factor"
  | "no-username"
  | "page-gone"
  | "unreadable"
  | "sign-in-shown"
  | "passkey-request"
  | "not-quiet";

/**
 * Why a page is not sent now: no paired service, its request is in flight, or a request
 * for it reached the model within the retry window (ADR 0016).
 */
export type GenerationHold = "not-connected" | "sending" | "sent";

/**
 * What came of a repeat login's signed-in page sample (ADR 0029, owner 2026-10-18 08:05
 * UTC): `not-due` when none is due (this device sent one of the recipe and branch in the
 * last 30 days, or no service is paired), `not-sent` with why when one was due but the page
 * could not be described, the sample recorded, or the site was excluded before it left,
 * `kept`, `recent`, `gone` or `refused` for the service's answer (it logged the page, had a
 * sample already, no longer holds the recipe revision, or turned the page away), `failed`
 * with the transport's code.
 */
export type PageSampleOutcome =
  | { outcome: "not-due"; reason?: string }
  | { outcome: "not-sent"; reason: string }
  | { outcome: "kept" | "recent" | "gone" | "refused" }
  | { outcome: "failed"; reason: string };

/**
 * Whether a repair of a recipe the chosen item cannot run may be sent (ADR 0058 A, amended
 * by ADR 0041): `claimed`, with `release` to drop the claim for a request that never reached
 * the model; `not-due` when no service is paired (`not-connected`) or this device sent one
 * for the recipe and route in the last 3 days; `not-sent` when the claim could not be recorded first
 * (`storage-unavailable`).
 */
export type RecipeRepairClaim =
  | { outcome: "claimed"; release(): Promise<void> }
  | { outcome: "not-due" | "not-sent"; reason?: string };

/**
 * What came of one page offered for generation: the model's recipe, with the fields its
 * custom slots name remembered for `slotFields` and the recipe cache pulled once (a failed
 * pull is not reported, so the cache may not hold it yet: a continuation's login takes the
 * returned recipe itself), or its abstention, a failure or refusal with its code, or why
 * nothing was sent, for the local log. `retry` marks a page left free to send again: its
 * request did not reach the model, or it was not sent because no service is paired,
 * storage could not be written or a request for it is still in flight (ADR 0016); a
 * continuation's login then gives its request back for a later document to send (ADR
 * 0018). A continuation of a revoked or since-changed recipe is not marked.
 */
export type GenerationOutcome =
  /** A route recipe, or a chooser recipe for a list of accounts (ADR 0028). */
  (
    | { outcome: "recipe"; recipe: LoginRecipe | LoginChooserRecipe }
    | {
        outcome: "abstained" | "failed" | "unavailable" | "skipped";
        reason: string;
        retry?: true;
      }
    | {
        outcome: "failed";
        reason: "invalid-output";
        /** Which check refused the model's output (`json`, `schema` or `plan`). */
        check: "json" | "schema" | "plan";
        /** The plan check's code or the output format's issue. */
        detail?: string;
        /** For an output format issue: where in the output it was. */
        path?: string;
        /** Refused output came from a model call, so the page is never left free. */
        retry?: never;
      }
  ) &
    ServiceTimed;

/** What came of a page sent as a site's sign-in entry (ADR 0031): its entry recipe, or not. */
export type EntryGenerationOutcome =
  | ({ outcome: "recipe"; recipe: LoginEntryRecipe } & ServiceTimed)
  | Exclude<GenerationOutcome, { outcome: "recipe" }>;

/** How long a request that reached the service took, for the local log (ADR 0019). */
export type ServiceTimed = { timing?: ServiceTiming };

/**
 * Why an advance whose next step is on its own path was not confirmed, for the log only
 * (ADR 0019): per next target, joined by `.`, its state just before the advance
 * (`TargetState`, or `unmeasured`), its state when the advance settled, and the check that
 * decided that (`TargetCheck`), and whether the page was on the step's path. Codes only.
 */
export type AdvanceMiss = {
  advanceBefore: string;
  advanceAfter: string;
  advanceWhy: string;
  advancePath: "same" | "other";
};

/**
 * Coordinator is packaged production code. Production admits only `sites` documents and
 * uses `recipes`; the loopback probe adapter and its controls exist only in the probe build.
 * Account metadata comes from each live settings read; values come from `fields` per fill.
 */
/**
 * How a login's account was chosen (ADR 0013, ADR 0021): the saved default, the only match,
 * a pick in the popup, an account switch's pick (ADR 0063), or the account the page set in
 * its input (ADR 0028).
 */
export type AccountSource = "default" | "match" | "pick" | "switch" | "site-value";

/**
 * A value-free account of what the runtime decided, for the local log (ADR 0019). The
 * origin and recipe ID are reduced there; no account ID is included, and the only item ID,
 * a `start`'s, is logged as a pseudonym.
 */
export type LoginReport = (
  | {
      type: "attempt";
      tabId: number;
      origin: string;
      recipeId: string;
      /** The recipe revision the login runs. */
      recipeRevision: number;
      /**
       * The layout the login runs (ADR 0060), and for a chooser login (ADR 0028) the branch
       * whose route it runs, as `recipeBranch` names them.
       */
      branch?: string;
      /** The route and password variant the login took when it started (ADR 0027). */
      route: LoginRoute;
      variant?: number;
      state: LoginAttemptMetadata["state"];
      stepIndex: number;
      stepCount: number;
      /** The current step's kind and effect, and the entered handler it belongs to. */
      operation?: string;
      effect?: string;
      handler?: number;
      outcome?: string;
      /** An undecided page ended the login without a confirmed sign-in (ADR 0029). */
      unconfirmed?: true;
      /**
       * For a `policy-changed` outcome: its cause, and a refused plan's reason. For a login
       * that failed or was cancelled: why, as the worker or the page saw it (ADR 0019).
       */
      cause?: PolicyChangeCause | StopCause;
      reason?: string;
      /** The result of the current effect step just settled as unknown (`unknown-submit`). */
      settled?: true;
      /** The login is watched for its result (ADR 0027): its watch has not ended. */
      watched?: true;
      /** A new document of the tab resumed the attempt without changing its state or outcome. */
      repeat?: true;
      /**
       * Nothing was submitted yet, and the login is still in the document it began in, so
       * the page is the one it started on or the same document after a fill (ADR 0066).
       */
      unsubmitted?: true;
      /**
       * A fill-only login of a tab that asks (ADR 0062 B), whose log lines stay on the device
       * (ADR 0066). Its `reason` is `fill-only` too, unless a stop names another.
       */
      fillOnly?: true;
      /** Why the login just changed route (ADR 0034). */
      routeChange?: RouteChange;
      /**
       * The layout the login ran until it just switched to `branch`'s, where the layouts of
       * its recipe part (ADR 0060).
       */
      layoutFrom?: string;
      /** The login stops before the password its item lacks (ADR 0036). */
      stop?: "password";
      /** For a login that just ended, signed in or blocked: how long it took (ADR 0019). */
      times?: AttemptTimes;
    }
  | {
      type: "refused";
      tabId: number;
      origin: string;
      reason: string;
      /** The refused document is a frame, not the tab's page. */
      frame?: true;
      /**
       * For `no-route` on a recipe with several password variants: why its first variant
       * did not fit, such as `binding-not-found` (ADR 0027). For `account-asked`, why the
       * tab asks ({@link AskReason}); for `not-started`, why a shown sign-in input did not
       * start a login.
       */
      detail?: string;
      /**
       * For `account-ambiguous`, `account-asked` and `relogin-limit`: how many accounts the
       * tab may ask with.
       */
      candidates?: number;
      /**
       * For `not-started` with `confirm-unsupported`: the recipe generated as `confirm` or
       * `unclear` that starts on the page, and its kind (ADR 0035); with
       * `first-step-missing`, the recipe whose first step missed.
       */
      recipeId?: string;
      recipeRevision?: number;
      pageKind?: PageKind;
      /**
       * Also for `confirm-unsupported`, what the page showed for the evaluation of page
       * kinds, never a value or page text (ADR 0035): whether an amount shows in the form of
       * its first step (absent when that step is in no form), whether a signed-in marker of
       * the origin's recipes shows (ADR 0029's E1), whether a matching item's username shows
       * in the header or navigation (E2, absent when the usernames could not be read), and
       * the URL of the tab's previous page of the origin.
       */
      amount?: boolean;
      e1?: boolean;
      e2?: boolean;
      previousUrl?: string;
      /**
       * For `not-started`: the later steps watched on the page's path (ADR 0049), how many,
       * how many with their password alone, and the furthest check they reached
       * (`LaterMiss`).
       */
      laterSteps?: number;
      laterPartial?: number;
      laterMiss?: LaterMiss;
      /** The same reason was already logged for this page (ADR 0019). */
      repeat?: true;
      /**
       * The page is not login-related: its origin has no recipe and no login runs in the
       * tab, or the tab no longer shows it, so the refusal is ordinary browsing (ADR 0019).
       */
      unrelated?: true;
    }
  | {
      /** A new login started (ADR 0019). */
      type: "start";
      tabId: number;
      origin: string;
      recipeId: string;
      /** The recipe revision the login runs. */
      recipeRevision: number;
      /** The layout of the recipe the login runs (ADR 0060); absent for one without layouts. */
      layout?: string;
      /** How many layouts of the recipe it chose among, when more than one (ADR 0060). */
      layouts?: number;
      route: LoginRoute;
      variant?: number;
      /** How the account was chosen; absent in the probe build. */
      account?: AccountSource;
      /** For an account found by URI match: the candidate count. */
      candidates?: number;
      /** For an account found by URI match: the item, logged only as a pseudonym. */
      itemId?: string;
      /**
       * The login fills the page without pressing anything while its tab asks for an
       * account (ADR 0021 D).
       */
      fillOnly?: true;
      /** The later step of its variant the login started at (ADR 0049). */
      startStep?: number;
      /** It started at that step with the step's password fields alone (ADR 0049). */
      startPartial?: true;
      /**
       * For a login on a chooser's list (ADR 0028): what it clicks there, or `none` when
       * it ends `account-not-listed`; `other-shown` when its path showed the `other`
       * branch's form instead, so it clicked nothing there.
       */
      click?: ChooserClick | "none";
      /** With `none`: what the list showed, without any name or address. */
      listMiss?: ListMiss;
    }
  | {
      /**
       * The tab stopped asking for an account of the origin after a rejection or a stopped
       * login (ADR 0021 D), because it closed. After a rejection, the origin's other tabs
       * stop asking with it unless `elsewhere`; a stopped login asked in its own tab only.
       */
      type: "ask-ended";
      tabId: number;
      origin: string;
      ask: "rejected" | "stopped-login";
      cause: "tab-closed";
      /** Another tab still asks after the site rejected its own login of the origin. */
      elsewhere?: true;
    }
  | {
      /**
       * Automatic login of a registrable site was paused or resumed from the popup, or its
       * pause ended because a login picked in the popup authenticated (ADR 0062). `origin`
       * is the page's the pause was set from or the picked login's.
       */
      type: "pause";
      tabId: number;
      origin: string;
      action: "paused" | "resumed" | "picked";
      /** For `paused`: the length the person chose. */
      length?: PauseLength;
      /** The pause is the incognito windows'. */
      incognito?: true;
    }
  | {
      /**
       * The tab left a page logged `not-started` with `confirm-unsupported`, for its next
       * page or by closing (ADR 0035). `url` is that page's.
       */
      type: "confirm-left";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      pageKind: PageKind;
      /** The person submitted the page's form themselves: a trusted `submit` event. */
      personSubmitted: boolean;
      /**
       * For a page that showed neither E1 nor E2 (E2 also when unread), read as the
       * `signedIn` false its generation request carried: whether the tab's next page shows a
       * signed-in marker of the origin's recipes (E1). Absent when the tab closed or its next
       * page was not read.
       */
      nextE1?: boolean;
    }
  | {
      /**
       * Whether an automatic or picked account choice was saved after the login
       * authenticated (ADR 0013), and why not.
       */
      type: "choice";
      tabId: number;
      origin: string;
      outcome:
        | "saved"
        | "already-saved"
        | "account-changed"
        | "login-in-progress"
        | "settings-unavailable"
        | "write-failed";
    }
  | {
      /**
       * What the toolbar popup was told about a tab's account choice (ADR 0021), logged when
       * it changes for the tab: offered with how many accounts, or none, with the tab's
       * login record and the page's last answer that explain why.
       */
      type: "popup";
      tabId: number;
      origin: string;
      choice: "offered" | "none";
      candidates?: number;
      /** Why the tab asks for an account (ADR 0021 D, ADR 0062). */
      ask?: AskReason;
      /** Automatic login of the site is paused (ADR 0062). */
      paused?: true;
      held?: true;
      /** The site rejected another tab's login, so the popup chooses no account. */
      rejectedElsewhere?: true;
      recordState?: string;
      recordOutcome?: string;
      pageReason?: string;
    }
  | {
      /** An exception stopped a login; only its class name and message are passed on. */
      type: "exception";
      tabId: number;
      origin: string;
      recipeId: string;
      /** The recipe revision the login runs. */
      recipeRevision: number;
      route: LoginRoute;
      /** The state the login was left in, and the step it stopped at. */
      state: LoginAttemptMetadata["state"];
      stepIndex: number;
      /** As for `attempt`: nothing was submitted yet, in the document the login began in. */
      unsubmitted?: true;
      /** As for `attempt`: a fill-only login of a tab that asks (ADR 0062 B, ADR 0066). */
      fillOnly?: true;
      name: string;
      /** Logged only when it is one of Pateat's own error codes. */
      message?: string;
      /** Logged as the extension's own file positions only (ADR 0019). */
      stack?: string;
    }
  | {
      type: "generation";
      tabId: number;
      origin: string;
      /** `sent` when the page went out; the outcome follows unless no answer came (ADR 0019). */
      outcome: GenerationOutcome["outcome"] | "sent";
      /** Unless a recipe came back: the refusal or failure code, or why nothing was sent. */
      reason?: string;
      /** For refused model output: which check refused it, and why. */
      check?: "json" | "schema" | "plan";
      detail?: string;
      path?: string;
      /**
       * For the page after a recipe's final `advance` step (ADR 0018): the recipe and the
       * revision it continues, and for a returned recipe whether this login took it over.
       */
      recipeId?: string;
      baseRevision?: number;
      takenOver?: boolean;
      /**
       * For a returned recipe this login did not take over: a value-free code for why, such
       * as the plan's refusal (`binding-slots-mismatch`, `field-missing`) or
       * `settings-revision` (ADR 0019).
       */
      notTakenOver?: string;
      /**
       * `accounts` for a page that lists accounts (ADR 0028), `entry` for a page sent as a
       * site's sign-in entry (ADR 0031), `other` for a form shown on a chooser's path sent
       * as its `other` branch's first page (ADR 0028), `repair` for a stale recipe's start
       * page sent to add a layout, with the recipe and the revision it repairs (ADR 0041).
       */
      page?: "accounts" | "entry" | "other" | "repair";
      /** A returned route recipe's page kind (ADR 0035). */
      pageKind?: PageKind;
      /** The `signedIn` hint the request carried (ADR 0035). */
      signedIn?: boolean;
      /** How long the request took, once it was answered or failed (ADR 0019). */
      timing?: ServiceTiming;
    }
  | {
      /**
       * A login's tab moved to a page of another origin that did not complete it (ADR
       * 0022), and why; `origin` is that page's. Logged when the move ends the login, or,
       * with `kept`, when the page went away before it was read and the tab's next page is
       * checked instead. A move the judge decided is logged as `judge` instead.
       */
      type: "move";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      route: LoginRoute;
      reason: MoveMiss;
      /** A frame of the new page announced first; only the top page reads the sign-in. */
      frame?: true;
      kept?: true;
    }
  | {
      type: "judge";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      route: LoginRoute;
      /**
       * `sent` when the page goes out; the service's verdict when it answers; `not-sent`,
       * with the reason, when the page is not sent or could not be described for it.
       */
      verdict:
        | "sent"
        | "not-sent"
        | "signed-in"
        | "rejected"
        | "challenge"
        | "optional"
        | "unclear"
        | "retry";
      reason?: string;
      /** For a returned revision: whether this login took it over. */
      takenOver?: boolean;
      /** A page of a watched login, judged from the watch's own pages (ADR 0027). */
      watched?: true;
      /**
       * The judge could not decide a page with no sign and no evidence, or found it an
       * optional page after the sign-in, so the login completed on it (ADR 0029, ADR 0065).
       */
      completed?: true;
      /**
       * The page's description left out a disabled field that may not be a sign-in field,
       * so only `signed-in` completes the login on it (ADR 0029).
       */
      disabledLeftOut?: true;
      /**
       * Why an undecided answer that would have completed the login did not: the page's
       * description left out a disabled field (ADR 0029), or the login stopped before the
       * password its item lacks, which an undecided answer never completes (ADR 0036).
       */
      notCompleted?: "disabled-left-out" | "password-empty";
      /**
       * The page is on another origin, which a `password` login's tab moved to right after
       * the submission or a second factor (ADR 0022); `origin` is that page's.
       */
      moved?: true;
      /**
       * The page of a login's stop before its item's missing password, judged for a passkey
       * button beside the password field (ADR 0036, owner 2026-10-13 05:39 UTC).
       */
      stop?: "password";
      /**
       * The page still shows the route's sign-in form beside another form, judged for a
       * `detail` handler only (ADR 0061).
       */
      beside?: true;
      /** How long the request took, once it was answered or failed (ADR 0019). */
      timing?: ServiceTiming;
    }
  | {
      /**
       * A repeat login's signed-in page sample (ADR 0029): `sent` just before it leaves the
       * device, then the answer, or `not-sent` with why when one was due.
       */
      type: "sample";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      route: LoginRoute;
      outcome: "sent" | Exclude<PageSampleOutcome["outcome"], "not-due">;
      reason?: string;
    }
  | ({
      type: "state";
      tabId: number;
      origin: string;
      recipeId: string;
      /** The recipe revision the login runs. */
      recipeRevision: number;
      route: LoginRoute;
      /** What ADR 0029 would do with the page; logged only (delivery 1). */
      decision: ReturnType<typeof decideSignInState>;
      /** A later page of an attempt whose result already settled as unknown. */
      settled?: true;
      /** Why S1 was not read as the sign-in form shown again, when it holds without it. */
      reshownMiss?: ReshownMiss;
      /** Why F2 does not hold on the sign-in form shown again. */
      alertMiss?: AlertMiss;
    } & SignInSigns &
      Partial<AdvanceMiss>)
  | {
      /**
       * A site's sign-in entry (ADR 0031): `pressed`; `refused` with the check before the
       * press that failed, or `unconfirmed` for a press the page never answered; `blocked`
       * with why the page after the press blocked the recipe revision (`left-site`,
       * `no-sign-in`, `sign-up`), and `detail` `storage-unavailable` when the block could
       * not be stored on the device.
       */
      type: "entry";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      outcome: "pressed" | "refused" | "blocked";
      reason?: string;
      detail?: string;
      /** A refusal the document already logged for the same reason. */
      repeat?: true;
    }
  | {
      /**
       * A generated recipe's start page showed a sign-in input for the step wait without a
       * ready first step (ADR 0041): `due` when the page is sent for repair, or
       * why not (`skipped`, with the `StartMissVerdict`, the `RepairNote` or why the page
       * cannot be sent as `reason`).
       */
      type: "repair";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      outcome: "due" | "skipped";
      reason?: string;
    }
  | {
      /**
       * A new login's recipe the chosen item cannot run, whose start page is sent for repair
       * (ADR 0058 A, amended by ADR 0041): `route` is the route the item would take that the
       * recipe lacks, `detail` the plan's refusal, and the outcome the claim's
       * ({@link RecipeRepairClaim}).
       */
      type: "unfit";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      route: LoginRoute;
      /** `newer` when a newer revision was pulled, which the page tries first. */
      outcome: RecipeRepairClaim["outcome"] | "newer";
      reason?: string;
      detail?: string;
    }
  | {
      /**
       * An account switch from the popup (ADR 0063): `start` once it began, `click` for each
       * logout click with its `purpose` and whether the model gave it in this switch
       * (`learned`), and `end` with `outcome` `signed-out` or `failed`, why (`reason`) and the
       * model's or page's code (`detail`).
       */
      type: "switch";
      tabId: number;
      origin: string;
      stage: "start" | "click" | "end";
      outcome?: "signed-out" | "failed";
      reason?: string;
      detail?: string;
      purpose?: LogoutPurpose;
      /** Where a click came from: the stored recipe, the model or the control's words. */
      source?: LogoutSource;
      learned?: true;
      clicks?: number;
      recipeId?: string;
      recipeRevision?: number;
      makeDefault?: true;
    }
  | {
      type: "handler";
      tabId: number;
      origin: string;
      recipeId: string;
      /** The recipe revision the login runs. */
      recipeRevision: number;
      handler: number;
      kind: string;
      /**
       * `entered`; `shown-again` after this login already ran it; `missing-fact` when the
       * item lacks what the handler needs, including a `totp` handler's code field;
       * `code-used` when the login already types a TOTP code; `no-room` when the attempt's
       * budget is spent, or the login is at its stop before a missing password (ADR 0036);
       * for a `detail` handler (ADR 0061), `detail-manual` when its inputs ask only for
       * details Pateat never fills, `detail-unlinked` when no usable vault field is linked
       * for a shown input, `detail-reprompt` when the only linked value is in an item that
       * waits for the master password, which the chooser window asks for before the fill,
       * `detail-unreadable` when the linked value is no date or has too
       * few digits, `detail-unavailable` when the vault could not give it, `detail-unfit`
       * when a value split over several inputs fits none of them, as when no option of a
       * select matches its part or a card's digits do not fit its boxes, and, about the
       * site's links, `detail-saved` when the popup's fill was saved after the login was
       * confirmed, `detail-forgotten` when a refused value's link was removed, and
       * `detail-kept` when it could not be removed now.
       */
      outcome:
        | "entered"
        | "shown-again"
        | "missing-fact"
        | "code-used"
        | "no-room"
        | "detail-manual"
        | "detail-unlinked"
        | "detail-reprompt"
        | "detail-unreadable"
        | "detail-unavailable"
        | "detail-unfit"
        | "detail-saved"
        | "detail-forgotten"
        | "detail-kept"
        | "detail-not-saved";
      steps: number;
    }
) & {
  /**
   * The tab's page URL when the report is made, for a report on the page's own origin and
   * not about a frame (ADR 0019). The log keeps its path and its parameters' names, never
   * their values, only for a site it names in full.
   */
  url?: string | undefined;
};

/**
 * Why a login changed route (ADR 0034): to the `passkey` route because the page asked for
 * a passkey by itself (`page-request`); back to its password variant because that request
 * went away before the answer (`request-missing`), the item could not answer it
 * (`answer-failed`), the recipe's rejection showed after the answer (`sign-in-rejected`),
 * or the sign-in form still showed after the answer (`sign-in-shown`).
 */
export type RouteChange =
  | "page-request"
  | "request-missing"
  | "answer-failed"
  | "sign-in-rejected"
  | "sign-in-shown";

/**
 * What withdrew a running login's authorization (`POLICY_CHANGED`): a settings sync or a
 * save on the settings page; a settings revision other than the login's, or settings that
 * could not be read; a plan the
 * settings or vault no longer allow; a vault snapshot replaced before delivery; a
 * vault field that could not be read; or a recipe that no longer runs a resumed login.
 */
export type PolicyChangeCause =
  | "settings-synced"
  | "settings-saved"
  | "settings-revision"
  | "settings-unavailable"
  | "plan"
  | "vault-replaced"
  | "field-unavailable"
  // Automatic login of the site was paused (ADR 0062).
  | "paused"
  | "recipe-changed";

export type PolicyChange = { cause: PolicyChangeCause; reason?: string };

/**
 * Why a login failed or was cancelled, for the log (ADR 0019): its step's elements did not
 * show in time (`elements-timeout`), a code page neither submitted the code nor took the
 * click (`code-not-submitted`), no operation could be built (`no-operation`), the operation
 * no longer validated (`operation-invalid`), a field had no binding (`slot-unbound`), the
 * page did not answer or its answer failed its check (`no-answer`), a code page said it
 * submitted the code itself but no check confirmed it (`page-submitted`), the document
 * could not be reached, as when a submit replaced it (`document-gone`), the login's item
 * could not answer its page's own passkey request (`answer-failed`, ADR 0034), the page
 * showed a CAPTCHA, so its click was left to the person (`captcha-shown`, ADR 0029), the
 * page after an effect step settled as unknown while it still showed the sign-in form
 * (S1) with no failure that acted (`sign-in-shown`, ADR 0029), or the page's own reason
 * (`ExecutionDetail`).
 */
export type StopCause =
  | "elements-timeout"
  | "answer-failed"
  | "code-not-submitted"
  | "no-operation"
  | "operation-invalid"
  | "slot-unbound"
  | "no-answer"
  | "page-submitted"
  | "document-gone"
  | "captcha-shown"
  | "sign-in-shown"
  | ExecutionDetail;
