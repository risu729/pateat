import type { LoginAttemptMetadata, ChooserClick, LoginRoute } from "@pateat/contracts";
import type { ListMissReport as ListMiss, ExecutionDetail } from "../wire";
import type { LogoutReason } from "../choice-wire";
import { decideSignInState, type ReshownMiss, type SignInSigns } from "../sign-in-state";
import type { AlertMiss } from "../../page/sign-in-state";
import type { MoveMiss } from "./model";
import type { GenerationOutcome } from "./recipes";

/** How a login's account was chosen (ADR 0013, ADR 0021). */
export type AccountSource = "default" | "match" | "pick";
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
      /**
       * For a `policy-changed` outcome: its cause, and a refused plan's reason. For a login
       * that failed or was cancelled: why, as the worker or the page saw it (ADR 0019).
       */
      cause?: PolicyChangeCause | StopCause;
      reason?: string;
      /** The result of the current effect step just settled as unknown (`unknown-submit`). */
      settled?: true;
      /** A new document of the tab resumed the attempt without changing its state or outcome. */
      repeat?: true;
      /** Why the login just changed route (ADR 0034). */
      routeChange?: RouteChange;
      /** The login stops before the password its item lacks (ADR 0036). */
      stop?: "password";
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
       * did not fit, such as `binding-not-found` (ADR 0027). For `logged-out`, which tab
       * logged out; for `not-started`, why a shown sign-in input did not start a login.
       */
      detail?: string;
      /** For `account-ambiguous` and `logged-out`: how many accounts the tab may ask with. */
      candidates?: number;
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
      route: LoginRoute;
      variant?: number;
      /** How the account was chosen; absent in the probe build. */
      account?: AccountSource;
      /** For an account found by URI match or asked after a logout: the candidate count. */
      candidates?: number;
      /** For an account found by URI match: the item, logged only as a pseudonym. */
      itemId?: string;
      /** The login fills the page without pressing anything, after a logout (ADR 0021 D). */
      fillOnly?: true;
      /**
       * For a login on a chooser's list (ADR 0028): what it clicks there, or `none` when
       * it ends `account-not-listed`.
       */
      click?: ChooserClick | "none";
      /** With `none`: what the list showed, without any name or address. */
      listMiss?: ListMiss;
    }
  | {
      /** The recipe's first step showed again after a finished login (ADR 0021 D). */
      type: "logout";
      tabId: number;
      origin: string;
      recipeId: string;
      /** The recipe revision the login runs. */
      recipeRevision: number;
      /** The site rejected the login; its page showing that asks at once. */
      rejected?: true;
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
      /** Why the tab asks after a logout (ADR 0021 D). */
      logout?: LogoutReason;
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
       * `accounts` for a page that lists accounts (ADR 0028), `entry` for a page sent as a
       * site's sign-in entry (ADR 0031).
       */
      page?: "accounts" | "entry";
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
      verdict: "sent" | "not-sent" | "signed-in" | "rejected" | "challenge" | "unclear" | "retry";
      reason?: string;
      /** For a returned revision: whether this login took it over. */
      takenOver?: boolean;
      /** A page of a watched login, judged from the watch's own pages (ADR 0027). */
      watched?: true;
      /**
       * The judge could not decide a page with no sign and no evidence, so the login
       * completed on it (ADR 0029).
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
    } & SignInSigns)
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
       * item lacks what the handler needs, including a `totp` handler's built-in field;
       * `code-used` when the login already types a TOTP code; `no-room` when the attempt's
       * budget is spent, or the login is at its stop before a missing password (ADR 0036).
       */
      outcome: "entered" | "shown-again" | "missing-fact" | "code-used" | "no-room";
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
 * settings or vault no longer allow; a vault snapshot replaced before delivery; or a
 * vault field that could not be read.
 */
export type PolicyChangeCause =
  | "settings-synced"
  | "settings-saved"
  | "settings-revision"
  | "settings-unavailable"
  | "plan"
  | "vault-replaced"
  | "field-unavailable";
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
