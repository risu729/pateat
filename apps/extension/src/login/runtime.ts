import * as v from "valibot";
import {
  attemptPlan,
  attemptRouteChoice,
  attemptUsesCode,
  bindingGaps,
  builtInLoginSlots,
  chooseLoginRoute,
  continuesRecipe,
  createAttemptMetadata,
  defaultLoginBinding,
  fillOnlyStops,
  extendsRecipe,
  fillLoginBinding,
  findLoginBinding,
  connectionEnabled,
  getItemEligibility,
  isFieldExcluded,
  handlerFact,
  handlerSlots,
  handlerSteps,
  handlerTargets,
  heldRouteMissing,
  isGeneratedRecipeId,
  isPasskeyBrowserSite,
  isSiteAllowed,
  isSiteExcluded,
  loginFieldFacts,
  loginFieldSource,
  manualDetails,
  pagesLeft,
  watchedAtStop,
  loginDocumentSchema,
  loginDisplayNames,
  loginObservationSchema,
  isEntryObservation,
  nextLoginOperation,
  keypadStep,
  loginStepEffect,
  parseAttemptMetadata,
  passkeyAnswersRequest,
  passwordStopOrMiss,
  passwordVariants,
  languageDecides,
  layoutFirstSteps,
  layoutShown,
  rankLayouts,
  layoutStartTargets,
  MAX_ATTEMPT_SUBMISSIONS,
  recipeBranch,
  recipeHasRoute,
  recipeStartSteps,
  laterStartSteps,
  recoverLoginAttempt,
  addAttemptTime,
  attemptTimes,
  awaitPerson,
  followPage,
  personAnswered,
  type AttemptTimes,
  resolveBindingFields,
  resolveLoginPlan,
  routeFillTargets,
  routeSignInPaths,
  routeSignInTargets,
  routeSlots,
  routeSteps,
  runsLogin,
  sameLoginDocument,
  sameLoginTarget,
  saveLoginChoice,
  showsBesideForm,
  siteDefaultConnection,
  templateLoginBinding,
  TOTP_HANDLER_SLOT,
  detailFieldFormat,
  detailFieldInputs,
  detailFieldSchema,
  detailSlot,
  isDetailSlot,
  customFieldReference,
  resolveDetailSourceField,
  detailLinkSchema,
  loginDetailSchema,
  loginTargetSchema,
  type DatePart,
  type DetailLink,
  type LoginFieldTarget,
  questionText,
  shownQuestionSchema,
  storedQuestionSchema,
  detailSourceFieldSchema,
  detailFormatFits,
  detailFormatSchema,
  loginFieldTargetSchema,
  type LoginDetail,
  totpFieldMismatch,
  totpFieldReference,
  transitionLoginAttempt,
  withdrawAccountSwitch,
  validateLoginOperation,
  valueShapeOf,
  type LoginAttemptEvent,
  type LoginAccount,
  type LoginBindingTemplate,
  type LoginAccountBinding,
  type LoginChoiceAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginHandler,
  type LoginItemFacts,
  type LoginObservation,
  type LoginOperation,
  isLoginRouteRecipe,
  itemAsksForMasterPassword,
  chooserClickBranch,
  chooserRoute,
  type ChooserClick,
  type ListClick,
  type LayoutCandidate,
  type PageKind,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginRoute,
  type LoginRouteChoice,
  type PasswordStopMiss,
  type LoginStep,
  type LoginMarkerTarget,
  type LoginTarget,
  type LocalSettings,
  type EntryGenerationRequest,
  type LoginEntryRecipe,
  type LoginLogoutRecipe,
  type LogoutPurpose,
  type RecipeGenerationRequest,
  type SavedLoginBinding,
  type SemanticSlot,
  type SettingsResponse,
  type SettingsChangeCause,
  type SettingsSnapshot,
  type ValueShape,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { browser, type Browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { sessionValue, trustedRecord } from "../storage";
import { MAX_SETTINGS_DEFER_MS } from "../service/settings-sync";
import type { ServiceTiming } from "../service/transport";
import { createLoginBadge, memoryBadgeStorage, setActionBadge, type LoginBadge } from "./badge";
import { domainKey } from "@pateat/bitwarden";
import {
  authorizeSchema,
  destinationCheckSchema,
  keypadPressSchema,
  type DestinationAnswer,
  entryCheckResultSchema,
  entryHostsResultSchema,
  entryInspectResultSchema,
  entryPressResultSchema,
  awaitResultSchema,
  cancelSchema,
  configureSchema,
  executionResultSchema,
  extractResultSchema,
  helloSchema,
  type unofferedReasons,
  observationSchema,
  stateResultSchema,
  statusSchema,
  submittedSchema,
  localLogoutResultSchema,
  logoutClickResultSchema,
  LOGOUT_REACTION_MS,
  personSubmittedSchema,
  chooseResultSchema,
  siteAccountResultSchema,
  type ListMissReport as ListMiss,
  probeControlSchema,
  laterReadiness,
  loginReadiness,
  HELD_CLICK_WAIT_MS,
  LOGIN_STEP_WAIT_MS,
  START_TRIES,
  START_TRY_WINDOW_MS,
  type ExecutionDetail,
  type InPlaceNext,
  type LaterMiss,
  type LoginReadiness,
  type ShownLater,
  type StartMiss,
  type TargetRequirement,
  type TargetState,
  type LoginSecretKind,
  type AskedQuestion,
} from "./wire";
import {
  DEFAULT_PROBE_ORIGIN,
  DEMO_PROBE_ACCOUNT,
  grantProbeOrigin,
  probeBinding,
  probeRecipe,
  probeStarts,
  type ProbeAccount,
} from "./dummy";
import {
  findLiveSiteCandidates,
  type LiveSiteCandidate,
  type LiveUriMatcher,
} from "../vault/site-candidates";
import {
  askReasonSchema,
  choiceRequestSchema,
  pauseRequestSchema,
  pauseStateRequestSchema,
  pickRequestSchema,
  repromptRequestSchema,
  statusRequestSchema,
  switchRequestSchema,
  type AskReason,
  type ChoiceResponse,
  type PauseResponse,
  type PickResponse,
  type RepromptResponse,
  type StatusResponse,
  type SwitchResponse,
} from "./choice-wire";
import {
  allowlistOf,
  createLoginPauses,
  LOGIN_PAUSES_KEY,
  pauseSite,
  pausedInPrivate,
  pausingRule,
  type LoginPauses,
  type PauseLength,
  type PauseState,
} from "./pause";
import { customFieldOffers, type CustomFieldOffer } from "./generation-slots";
import { classifyStartMiss, type RecipeRepairs } from "./repair";
import { emailUsername, namesUsername, type EntryMiss, type OtherMiss } from "../page/account-list";
import { observedPath } from "../observation/path";
import { senderDocumentOrigin, senderPageUrl } from "../messaging/sender";
import { pathShowsUsername, withoutUsernames } from "../observation/usernames";
import {
  decideSignInState,
  reachedReturnTarget,
  type ReshownMiss,
  type SignInDecision,
  type SignInSigns,
} from "./sign-in-state";
import { judgedCompletionResult, settleCompletion, undecidedCandidate } from "./completion-policy";
import type { AlertMiss } from "../page/sign-in-state";
import type { LoginSites, PausingSettings } from "./sites";
import { linkRefusal, namesReturnPath, type OnSite } from "./entry";
import type { ConditionalDecision, PasskeyItem } from "../passkeys/runtime";
import { passkeyOrigin, passkeyScriptsRun } from "../passkeys/rp-id";
import {
  loginFillsUsername,
  loginSecretKind,
  loginUsernameFieldId,
  type LoginFieldSource,
} from "./vault";
import { newId } from "@pateat/contracts/ids";
import { loginMoveFits } from "@pateat/contracts/site";
import { isoTime, isoTimeMs, isoTimeSchema } from "../time";
import {
  createAccountPicks,
  runLogout,
  siteDefaultsMark,
  type LogoutPress,
  type LogoutSource,
  type LogoutService,
} from "./switch";
import {
  cardGuessFields,
  cardLast4,
  detailCandidates,
  detailFieldIds,
  detailFieldLabel,
  detailFieldValues,
  detailValue,
  isCardDetail,
  linkedField,
  MAX_CARD_GUESS_READS,
  MAX_DETAIL_CANDIDATES,
  rankCards,
  savedDetailLink,
  savedDetailLinks,
  type CardFacts,
  type DetailFillValue,
  type DetailOwner,
  type DetailSite,
  waitsForMasterPassword,
} from "./details";
import { cardBrandOf, cardBrands, MAX_CARD_LAST_4 } from "../page/card-hints";
import {
  detailFillRequestSchema,
  detailRemoveRequestSchema,
  detailRequestSchema,
  type DetailFillResponse,
  type DetailRemoveResponse,
  type DetailResponse,
} from "./detail-wire";

const STORAGE_KEY = "pateat.login-attempts.v5";
/** Accounts picked in the toolbar popup, per tab; session storage survives a worker restart. */
const PICKS_KEY = "session:pateat.login-picks.v1";
const CHOICES_KEY = "session:pateat.login-choices.v1";
/**
 * Tabs whose login of an origin stopped after a submission and whose login form then
 * showed again on a later page, or whose watched login was abandoned (ADR 0027); they ask
 * for an account, in that tab only, and fill the page once without pressing anything
 * (ADR 0021 D).
 */
const STOPPED_ASKS_KEY = "session:pateat.login-stopped-asks.v1";
/**
 * Tabs whose login of an origin the site rejected; they ask for an account, and so do the
 * origin's other tabs while one asks, each filling a page once without pressing anything
 * (ADR 0021 D).
 */
const REJECTED_ASKS_KEY = "session:pateat.login-rejected-asks.v1";
/**
 * Pages filled once while their tab asks for an account, as `${tabId} ${documentId} ${path}`,
 * and documents a rejected login keeps unfilled, as `${tabId} ${documentId}` (ADR 0021 D).
 */
const ASK_FILLS_KEY = "session:pateat.login-ask-fills.v1";
/**
 * When automatic logins of a registrable site ended `authenticated`, by site and incognito,
 * so a site that keeps logging out again is not logged in over and over (ADR 0062).
 */
const RELOGINS_KEY = "session:pateat.login-relogins.v1";
/**
 * Automatic logins of a site that may end `authenticated` within `RELOGIN_WINDOW_MS`; the
 * next one asks for an account instead (`relogin-limit`, ADR 0062).
 */
const RELOGIN_LIMIT = 2;
const RELOGIN_WINDOW_MS = 10 * 60_000;
/**
 * Refusal reasons already logged, by tab, document and path, so a page that announces
 * again after a worker restart does not log the same reason as news (ADR 0019).
 */
const NOTED_KEY = "session:pateat.login-noted.v1";
/**
 * Per tab, the `detail` handler its login stopped at for want of a linked value, and the
 * links filled from the popup that wait for the tab's login to be confirmed (ADR 0061).
 */
const DETAIL_OFFERS_KEY = "session:pateat.login-detail-offers.v1";
const PENDING_DETAILS_KEY = "session:pateat.login-pending-details.v1";
/**
 * Links whose value a site refused and that could not be removed from the settings yet;
 * no login uses them, and their removal is tried again after each login (ADR 0061).
 */
const REFUSED_DETAILS_KEY = "session:pateat.login-refused-details.v1";
const CONFIG_KEY = "pateat.login-probe-origin.v1";
/**
 * How long another tab's login that has not succeeded holds its origin after its record
 * last changed (ADR 0022, owner's choice on 2026-10-12).
 */
const HOLD_MS = 5 * 60_000;
/**
 * How often a login page offered for generation is read before it counts as one that
 * cannot be described, and how long apart: a form rendered in steps or fading in settles
 * meanwhile, for about nine seconds after the page offers itself (ADR 0016).
 */
const EXTRACT_READS = 10;
/**
 * At most this many matching items' usernames are looked for in a page's header or
 * navigation for its generation request's `signedIn` hint (ADR 0035), one page read each.
 */
const MAX_HINT_USERNAMES = 8;
const EXTRACT_RETRY_MS = 1000;
/** How soon after a password submission the tab's next page counts as right after it (ADR 0028). */
const AFTER_SIGN_IN_MS = 60_000;
/**
 * How long after another tab's login of an origin authenticated a list of accounts showing
 * on it is not sent for generation (ADR 0028, owner 2026-10-17).
 */
const SIGNED_IN_ELSEWHERE_MS = 60 * 60_000;
/**
 * How long after evidence of a sign-in the page is read again before the login completes
 * on it (ADR 0029), so a page that is still redirecting or about to ask for a second
 * factor does not settle the login, and how many times it is read again at most while
 * the document is still loading.
 */
const SIGN_IN_RECHECK_MS = 1000;
const SIGN_IN_RECHECKS = 10;
/**
 * How soon after a passkey answer, or after a password login's last effect step, a move to
 * another origin of that site may complete (ADR 0022), and a new document may be the site's
 * answer to the step, read for a sign-in form shown again (ADR 0029).
 */
const SITE_MOVE_MS = 30_000;
/**
 * How long after the passkey bridge answered a tab's top document outside a login no new
 * automatic login starts on that page: the assertion is the page's sign-in, and the site
 * moves on by itself. A form still showing after it is read as the site's refusal, as for
 * a login's own answer (ADR 0034 rule 6).
 */
const PASSKEY_SIGN_IN_MS = 15_000;
const PASSKEY_SIGNED_IN = "passkey-signed-in";
/** How long a master password typed for a re-prompt item lets its document's login start. */
const REPROMPT_GRANT_MS = 60_000;
/** Readings of that move's new page, a second apart, before it must have loaded quietly. */
const SITE_MOVE_READINGS = 5;
/**
 * How long a login stays watched after its result stopped at `challenge` or settled as
 * unknown (ADR 0027, owner's choice on 2026-10-12), and how long each new page of its tab
 * is checked for a signed-in marker before its sign-in state is read, as after a click.
 */
const WATCH_MS = 10 * 60_000;
const WATCH_SETTLE_MS = 3000;
/**
 * The sign-in state of ADR 0029 for a page no check explained, and whether a later reading
 * in the fully loaded document agreed, which every outcome but logging needs. `reshown`:
 * read on the sign-in form shown again in the first new document after the submission.
 */
type SignInReading = {
  decision: SignInDecision;
  confirmed: boolean;
  reshown?: true;
  /**
   * With `reshown`: the page shows the sign-in form with its password input and no other
   * sign of a sign-in going on or done (no S3, S4, S5 or E sign), so the login did not go
   * through and the tab asks again (ADR 0021 D).
   */
  formAgain?: true;
  /**
   * The page shows a password input (S2) and no CAPTCHA (S4): after an `advance` whose next
   * step never showed, the page a repair continues (ADR 0041 section 4).
   */
  asksPassword?: true;
};
/**
 * The sign-in form with its password input shown again in the first new document after
 * the password submission, with no sign of another step or of a sign-in (ADR 0021 D).
 */
const formAgain = (signs: SignInSigns) =>
  signs.reshown === true &&
  signs.s2 &&
  !signs.s3 &&
  !signs.s4 &&
  !signs.s5 &&
  !signs.e1 &&
  !signs.e2 &&
  !signs.e3;
/** Sign-in entry presses per tab, until the tab closes (ADR 0031). */
const ENTRY_PRESSES_KEY = "session:pateat.login-entry-presses.v1";
/** Entry recipe revisions blocked on this device after a press that led nowhere (ADR 0031). */
const ENTRY_BLOCKS_KEY = "pateat.login-entry-blocks.v1";
/** A tab presses a sign-in entry at most once in this time (ADR 0031). */
const ENTRY_PRESS_MS = 10 * 60_000;
/** How soon after a press the next page must show: a new document or a URL change. */
const ENTRY_NEXT_PAGE_MS = 10_000;
/** Blocks kept at most; the oldest go first. */
const MAX_ENTRY_BLOCKS = 100;
const tabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const revisionSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
/**
 * A sign-in entry press (ADR 0031), kept in session storage until its tab closes so the
 * one-press-per-10-minutes limit and the check of the next page survive a worker restart.
 * `documentId` and `url` are the pressed page's, so the same page announcing again is not
 * taken as the next one; `checked` once the next page passed or the recipe was blocked.
 */
const entryPressSchema = v.strictObject({
  tabId: tabIdSchema,
  origin: v.string(),
  recipeId: v.string(),
  revision: revisionSchema,
  pressedAt: isoTimeSchema,
  documentId: v.string(),
  url: v.string(),
  checked: v.optional(v.literal(true)),
  /**
   * The time the login after the press took on the pressed page (ADR 0019): since when
   * that page was seen, with its service and person time. The login on the next page
   * takes it over once, and it is dropped then.
   */
  timing: v.optional(
    v.strictObject({
      since: v.pipe(v.number(), v.integer(), v.minValue(0)),
      serviceMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
      networkMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
      personMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
});
type EntryPress = v.InferOutput<typeof entryPressSchema>;
/**
 * The times automatic logins of a registrable site ended `authenticated`, in epoch
 * milliseconds, in the browser's normal or incognito session (ADR 0062).
 */
const reloginSchema = v.strictObject({
  site: v.string(),
  incognito: v.boolean(),
  at: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(0))), v.maxLength(RELOGIN_LIMIT)),
});
type Relogins = v.InferOutput<typeof reloginSchema>;
/** Why the page after an entry press blocked its recipe revision (ADR 0031). */
type EntryBlockReason = "left-site" | "no-sign-in" | "sign-up";
/**
 * An entry recipe revision blocked on this device, until the recipe sync brings a newer
 * revision or removes it (ADR 0031). Revisions only grow, also for a recipe generated
 * again after a revocation, so a block never applies to a later revision.
 */
const entryBlockSchema = v.strictObject({
  recipeId: v.string(),
  revision: revisionSchema,
  reason: v.picklist(["left-site", "no-sign-in", "sign-up"]),
  blockedAt: isoTimeSchema,
});
type EntryBlock = v.InferOutput<typeof entryBlockSchema>;
/** The registrable domain of an origin or URL, as Bitwarden's Domain match compares it. */
function siteOf(value: string | URL): string | undefined {
  const url = typeof value === "string" ? URL.parse(value) : value;
  if (!url) return undefined;
  // Keep domain matching failures separate from an invalid URL.
  try {
    return domainKey(url);
  } catch {
    return undefined;
  }
}
/** Names a site's automatic login completions in the normal or the incognito session. */
const reloginKey = (site: string, incognito: boolean) =>
  `${incognito ? "incognito" : "normal"} ${site}`;
/** Whether a URL is on the site of `page` (its registrable domain). */
const sameSiteAs =
  (page: string): OnSite =>
  (url) => {
    const site = siteOf(page);
    return site !== undefined && siteOf(url) === site;
  };
/**
 * An account switch's waits (ADR 0063): how often the tab is looked at after a click, how
 * long a page that stays the same must be quiet before it counts as settled, as when a menu
 * opened, how long the tab may take to settle at all, and how long its sign-in input is
 * waited for once it did.
 */
const SWITCH_POLL_MS = 250;
const SWITCH_QUIET_MS = 1500;
const SWITCH_SETTLE_MS = 15_000;
const SWITCH_CHECK_MS = 1500;
/**
 * How long a page's own conditional passkey request waits for a login of its document to
 * start before it is handed on (ADR 0034).
 */
const REQUEST_START_WAIT_MS = 3000;
/**
 * Longest a conditional request waits for its login to end, or for a pick while its tab
 * asks for an account (ADR 0021 D); it is then withheld, so a login that runs that long never meets another provider's prompt
 * (ADR 0034). One that waits this long for a pick in an ordinary popup choice is handed on.
 */
const REQUEST_PARK_MS = 4 * 60_000;
/**
 * How long the `passkey` route waits for its page's own request before it falls back, and
 * a login of an item without a password waits at its stop (ADR 0036).
 */
const REQUEST_WAIT_MS = 3000;
/**
 * How long the start page's sign-in form may still show in the document after the
 * `passkey` route answered its request, before the login falls back (ADR 0034), and the
 * form after an answer at a login's stop, before it ends (ADR 0036).
 */
const REQUEST_HOLD_MS = 15_000;
type Sender = Browser.runtime.MessageSender;
type SettingsRuntime = {
  handle(value: unknown): Promise<SettingsResponse>;
  /** Trusted background mutation; saves an automatic account choice after confirmed `authenticated`. */
  update?(
    expectedRevision: number | undefined,
    cause: SettingsChangeCause,
    mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ): Promise<SettingsSnapshot>;
};
/**
 * An account choice used by an attempt but not saved yet (ADR 0013); `connectionId` is the
 * local connection the attempt used, so only that account is saved. A login on the
 * `passkey` route fills nothing, so it saves the site default without a binding (ADR 0027).
 */
type UnsavedChoice = {
  binding: SavedLoginBinding | LoginChoiceAccount;
  connectionId: string;
  replace?: boolean;
};
/**
 * Settings with the choice added where missing, or replacing the site default for an
 * account picked to become it; the same object when nothing changes.
 */
const withChoice = (value: SettingsSnapshot["settings"], choice: UnsavedChoice) =>
  saveLoginChoice(value, choice.binding, { replace: choice.replace === true });
/**
 * A document's time before its login's attempt exists (ADR 0019): `AttemptTiming` without
 * a running wait or a wait for the site.
 */
type StartTiming = { since: number; serviceMs: number; networkMs: number; personMs: number };
/** A document's path before its token-like segments are replaced (ADR 0039). */
const rawPath = (live: LiveDocument) => new URL(live.url).pathname;
type LiveDocument = {
  document: LoginDocument;
  token: string;
  /**
   * The document's browser-provided URL: the tab's committed URL for a same-origin top
   * document (it follows history.pushState), else `sender.url`. Provider URI rules match it.
   */
  url: string;
  /**
   * The URL's path as observations carry it (`observedPath`, ADR 0039): every comparison
   * with a recipe's, an observation's or the content script's path reads this one. A
   * username in the path is looked for in `url`'s raw path (`rawPath`).
   */
  path: string;
  /**
   * For a document in a frame inside the page: the tab's URL. The account must match it
   * as well as the frame's own URL (ADR 0017).
   */
  topUrl?: string;
  /**
   * Whether the document's tab is in an incognito window, as its sender or tab said when it
   * announced. Incognito keeps its own pauses and relogin counts (ADR 0062); absent when the
   * browser did not say, and then either window kind's pause counts.
   */
  incognito?: boolean;
  state?: string;
  reason?: string;
  /** The detail of the refusal `reason` names, as the log has it, if any. */
  refusal?: string;
  /** A provider URI match for this document only, valid while its snapshot is unchanged. */
  uriMatch?: { connectionId: string; itemId: string; snapshotId: string };
  /** A single-match account choice, valid while every connection's snapshot is unchanged. */
  autoChoice?: { snapshots: string; connectionId: string; itemId: string };
  /**
   * The document's content script compared the value the page set in its account input
   * (ADR 0028 amendment of 2026-10-23), which it answers only once.
   */
  siteAsked?: true;
  /** A provider URI match for `topUrl`, valid while its snapshot is unchanged. */
  topMatch?: { connectionId: string; itemId: string; snapshotId: string };
  /** Why generation last skipped this document, so each reason is logged once. */
  generationSkip?: string;
  /** Why this document's sign-in input last did not start a login, logged once. */
  notStarted?: string;
  /**
   * For the tab's own page: the URL of the tab's previous page of the same origin, or of
   * this document before it changed its path in place, for the log of a page Pateat does
   * not fill (ADR 0035).
   */
  previousUrl?: string;
  /** The tab's top page went on to a page Pateat does not admit, so it is no previous page. */
  leftUnread?: true;
  /**
   * When this worker first saw the document. Only a page first seen after another tab's
   * login began to be watched ends that login (ADR 0027).
   */
  seenAt: number;
  /**
   * The time a login this document starts takes before it starts, for the local log (ADR
   * 0019): since when it waits for one, and its service and person time so far, such as
   * its first page's generation or an account pick. Shared with the same document's later
   * announcements, so time added to an earlier one counts too.
   */
  timing: StartTiming;
  /** Why this document's sign-in entry was not pressed, each reason logged once at info. */
  entryRefusals?: string[];
  /**
   * Why the last check of this page, the new top page of a login's move to another origin
   * (ADR 0022), did not find the sign-in complete, for the log.
   */
  moveMiss?: MoveMiss;
  /** Probe build only: how many observations of the page a login got back, for its status. */
  observations?: number;
};
/**
 * A tab's page on whose path a recipe generated as `confirm` or `unclear` starts, which
 * Pateat only watches (ADR 0035), for the log entry written when the tab leaves it.
 */
type ConfirmVisit = {
  document: LoginDocument;
  path: string;
  url: string;
  recipe: Pick<LoginRecipe, "id" | "revision" | "pageKind">;
  /** The recipe's first step, for the document to report once it shows. */
  first: LoginReadiness;
  /** The person submitted the page's form themselves (a trusted `submit` event). */
  submitted: boolean;
  /**
   * Once the page was logged `confirm-unsupported`: resolves after that entry is written, to
   * whether the tab's next page is read for E1 (neither its own E1 nor E2 showed).
   */
  logged?: Promise<boolean>;
};
/**
 * Why a login's move to another origin did not complete it (ADR 0022): no step or second
 * factor fits the move, the account has no username to look for, the page went away or
 * could not be read, it shows a sign-in step or asked for a passkey, or it never read
 * quiet twice.
 */
type MoveMiss =
  | "no-factor"
  | "no-username"
  | "page-gone"
  | "unreadable"
  | "sign-in-shown"
  | "passkey-request"
  | "not-quiet";
/** Why a page offered for generation is not sent, for the log (ADR 0019). */
type GenerationMiss = "no-vault-match" | "vault-unavailable" | "connection-disabled";
/**
 * The popup's codes within its 200 characters: a page's own refusal reason is any text the
 * content script sent.
 */
const clipCodes = <T extends Record<string, string | undefined>>(fields: T): T =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, value?.slice(0, 200)]),
  ) as T;
/** A provider's or vault's reason as a log code, within the log's 64 characters. */
const logCode = (reason: string) =>
  reason
    .toLowerCase()
    .replace(/[^a-z0-9.:-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 64) || "unknown";
/**
 * A page offered as a list of accounts (ADR 0028): its path, and without an email listed,
 * the short texts that may name an account by a username that is not an email, and why a
 * shown email address is not a list entry, for the log only.
 */
type ListOffer = {
  path: string;
  names?: string[] | undefined;
  other?: true | undefined;
  otherMiss?: OtherMiss | undefined;
  missed?: EntryMiss | undefined;
};
/** Whether a record holds its origin against other tabs at `now` (ADR 0022). */
const holdsSite = (entry: LoginAttemptMetadata, now: number) =>
  entry.state !== "authenticated" &&
  // A fill-only login never submits (ADR 0021 D).
  !entry.fillOnly &&
  // A login interrupted before anything was submitted never submits.
  !(entry.state === "blocked" && entry.outcome === "interrupted" && !entry.submissions) &&
  !stoppedByPateat(entry) &&
  // A clock set back ends the hold rather than prolonging it.
  now - (entry.changedAt ?? 0) >= 0 &&
  now - (entry.changedAt ?? 0) < HOLD_MS;
/**
 * Whether a record holds its origin against the site's other tabs at `now` (ADR 0022): as
 * {@link holdsSite}, and a watched login for as long as its watch, as while its tab waits
 * for a code, so a second tab does not log in and send a second code (owner, 2026-10-23).
 */
const holdsOthers = (entry: LoginAttemptMetadata, now: number) =>
  holdsSite(entry, now) || (entry.watch !== undefined && !watchOver(entry, now));
/** Documents are tracked per frame; a tab still runs at most one attempt. */
const frameKey = (document: { tabId: number; frameId: number }) =>
  `${document.tabId}:${document.frameId}`;
/**
 * Attempt records are kept per tab and origin: each origin a tab shows keeps its own
 * record until the tab closes, while the tab still runs one attempt at a time.
 */
const recordKey = (tabId: number, origin: string) => `${tabId} ${origin}`;
/** A document's key in the entry press's sets and maps (ADR 0031). */
const documentKey = (page: { tabId: number; documentId: string }) =>
  `${page.tabId} ${page.documentId}`;
/**
 * An account the user picked in the toolbar popup (ADR 0021). It is used instead of the
 * saved default by the refused document it restarted and then by the attempt that
 * document started, on that login's later pages too. It is saved as the default after
 * confirmed `authenticated` only with `makeDefault`.
 */
const pickedAccountSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
  documentId: v.string(),
  /** Set once the picked login starts; until then the pick applies to `documentId` only. */
  attemptId: v.optional(v.string()),
  connectionId: v.string(),
  itemId: v.string(),
  makeDefault: v.boolean(),
  /** How long the popup offered the choice before the pick: the person's time (ADR 0019). */
  waitedMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Chosen by the value the page set in its account input, not in the popup (ADR 0028
   * amendment of 2026-10-23): kept like a pick so the login's later pages use it too, and
   * never saved as the default.
   */
  site: v.optional(v.literal(true)),
});
type PickedAccount = v.InferOutput<typeof pickedAccountSchema>;
/**
 * A document refused because several accounts match it, or because its tab asks for an
 * account (`ask`, ADR 0021 D, ADR 0062); the popup offers these candidates.
 */
const pendingChoiceSchema = v.strictObject({
  document: loginDocumentSchema,
  /** When the document was first offered the choice, in epoch milliseconds (ADR 0019). */
  at: v.pipe(v.number(), v.integer(), v.minValue(0)),
  candidates: v.array(v.strictObject({ connectionId: v.string(), itemId: v.string() })),
  ask: v.optional(askReasonSchema),
  /** Refused because automatic login of the site is paused (ADR 0062). */
  paused: v.optional(v.literal(true)),
});
/**
 * A secret question the judge paired with one of the login item's custom fields (ADR 0061,
 * owner 2026-10-23): the answer input, the field, the question in its compared form, which
 * the page must show as one whole question, and as the judge copied it from the page
 * (`shown`, trimmed), for the popup only. The popup proposes it; only the owner's
 * confirmation links it.
 */
const pairedQuestionSchema = v.strictObject({
  field: detailSourceFieldSchema.options[1],
  question: storedQuestionSchema,
  shown: shownQuestionSchema,
});
type PairedQuestion = v.InferOutput<typeof pairedQuestionSchema> & { target: LoginFieldTarget };
/**
 * The judge's pairings as a login keeps them (ADR 0061): each answer input with the custom
 * field whose slot the judge named, and the question. A slot sent for no custom field, or
 * a question too short or too long to store, pairs nothing.
 */
function pairedQuestions(
  path: string,
  questions: readonly { field: LoginFieldTarget; slot: string; shown: string }[] | undefined,
  offers: readonly CustomFieldOffer[],
): { path: string; questions: PairedQuestion[] } | undefined {
  const kept = (questions ?? []).flatMap((entry) => {
    const offer = offers.find((candidate) => candidate.slot.id === entry.slot);
    const question = questionText(entry.shown);
    const shown = entry.shown.trim();
    return offer && v.is(storedQuestionSchema, question) && v.is(shownQuestionSchema, shown)
      ? [{ target: entry.field, field: offer.reference, question, shown }]
      : [];
  });
  return kept.length ? { path, questions: kept } : undefined;
}
/**
 * A `detail` handler that a tab's login stopped at because no linked vault field had a
 * value for it (ADR 0061); the popup proposes fields for it while the tab shows `document`.
 */
const detailOfferSchema = v.strictObject({
  document: loginDocumentSchema,
  path: v.string(),
  attemptId: v.string(),
  /** The handler's index in the login's recipe, for the log. */
  handler: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The login item and its site. */
  account: v.strictObject({ connectionId: v.string(), itemId: v.string(), origin: v.string() }),
  /**
   * The handler's fields Pateat fills: one in one input, which for a secret question's
   * answer may carry the judge's pairing until the owner confirms it, or one split over
   * several inputs.
   */
  fields: v.pipe(
    v.array(
      v.union([
        v.pipe(
          v.strictObject({
            detail: loginDetailSchema,
            format: v.optional(detailFormatSchema),
            target: loginFieldTargetSchema,
            paired: v.optional(pairedQuestionSchema),
          }),
          v.check(
            (entry) => detailFormatFits(entry.detail, entry.format),
            "A birth date or card expiry input has a format of its own, and no other input has one",
          ),
        ),
        detailFieldSchema.options[1],
      ]),
    ),
    v.minLength(1),
    v.maxLength(3),
  ),
  /** The handler's button, which must still show for the popup's fill. */
  target: loginTargetSchema,
});
type DetailOffer = v.InferOutput<typeof detailOfferSchema>;
/** A saved link's field that a login reads only after the master password (ADR 0061). */
type DetailWait = {
  detail: LoginDetail;
  itemId: string;
  fieldId: string;
  /** The waiting field's inputs, so its fill goes to that field and no other. */
  targets: LoginFieldTarget[];
};
/** Whether two fields' inputs are the same, in the same order. */
const sameInputs = (left: readonly LoginFieldTarget[], right: readonly LoginFieldTarget[]) =>
  left.length === right.length && left.every((target, at) => sameLoginTarget(target, right[at]!));
/** A link filled from the popup, saved once the tab's login `attemptId` is confirmed. */
const pendingDetailSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  attemptId: v.string(),
  handler: v.pipe(v.number(), v.integer(), v.minValue(0)),
  connectionId: v.string(),
  link: detailLinkSchema,
});
type PendingDetail = v.InferOutput<typeof pendingDetailSchema>;
type DetailSourceField = DetailLink["source"]["field"];
/** A link's source field as a key, the same whatever order its properties came in. */
const sourceFieldKey = (field: DetailSourceField) =>
  typeof field === "string"
    ? field
    : JSON.stringify([field.custom, field.position ?? null, field.count ?? null]);
/** A refused link; a secret question's answer names its question's field too. */
const refusedDetailSchema = v.strictObject({
  ...v.omit(detailLinkSchema, ["source"]).entries,
  field: v.optional(detailLinkSchema.entries.source.entries.field),
});
type RefusedDetail = v.InferOutput<typeof refusedDetailSchema>;
/** A tab and origin that asks for an account until a pick logs in (ADR 0021 D). */
const askSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
});
/**
 * A login that ended with a result, or that ended when the tab left its origin (ADR 0022);
 * its first step showing again in the tab's page releases its record, and the page logs in
 * again as on any visit (ADR 0062), or asks after a rejection. A switch, a stop, or a
 * result still being reconciled does not.
 */
const finishedLogin = (metadata: LoginAttemptMetadata) =>
  metadata.state === "authenticated" ||
  (metadata.state === "blocked" &&
    ["credential-rejected", "wrong-account", "left-origin", "interrupted"].includes(
      metadata.outcome ?? "",
    ));
/**
 * A login Pateat itself stopped with nothing in flight: a withdrawn authorization, a
 * cancel, a value the page would not take, another account shown, or retries spent on
 * failures that changed nothing. It does not hold the origin against other tabs (ADR
 * 0022). A refusal by the site, a second-factor challenge, a submission limit, an
 * operation the page may have received or a result that may still arrive keeps holding.
 */
const stoppedByPateat = (metadata: LoginAttemptMetadata) =>
  metadata.state === "blocked" &&
  ([
    "policy-changed",
    "value-mismatch",
    "wrong-account",
    "account-switched",
    "retry-limit",
    // Nothing on a chooser's list fit the account (ADR 0028); nothing was clicked.
    "account-not-listed",
  ].includes(metadata.outcome ?? "") ||
    // A frame login whose page went away also ends `cancelled`; after a submission that
    // is the tab leaving, which holds like `interrupted`.
    (metadata.outcome === "cancelled" && metadata.submissions === 0)) &&
  metadata.mutationIntent !== true &&
  metadata.settled !== true &&
  !(metadata.operationKind === "click" && metadata.operationId !== undefined);
type PendingChoice = v.InferOutput<typeof pendingChoiceSchema>;
type Execution = {
  metadata: LoginAttemptMetadata;
  /** The links this login's `detail` fills used were already removed as refused (ADR 0061). */
  detailsForgotten?: boolean;
  /**
   * The question field each `detail` handler this login filled a secret question's answer
   * into read from, by handler (ADR 0061). Kept in memory only.
   */
  answers?: Map<number, DetailSourceField>;
  /**
   * The secret questions the judge paired with the login item's custom fields on the page
   * at `path` (ADR 0061), for the popup to propose once the login stops at their handler.
   * Unconfirmed, so nothing is ever filled from them. Kept in memory only.
   */
  paired?: { path: string; questions: PairedQuestion[] };
  /** A chooser login's recipe (ADR 0028), whose list its first step clicks on. */
  chooser?: LoginChooserRecipe;
  /** A fill-only login's accounts and why its tab asks, offered once it ends (ADR 0021 D). */
  asked?: { candidates: PendingChoice["candidates"]; ask: AskReason };
  recipe: LoginRecipe;
  live: LiveDocument;
  running: boolean;
  operation?: LoginOperation;
  /** `operation` was sent to the page, so its effect may have started. */
  delivered?: boolean;
  /** Saved only once this attempt reaches confirmed `authenticated`. */
  choice?: UnsavedChoice;
  /**
   * The step index of a held click this document performed (ADR 0027): a handler's click
   * or the `passkey` route's. Its page is not judged while the clicked button still shows.
   */
  heldClick?: number;
  /**
   * The elements of the step after an advance on the same path, as the document measured
   * them in the same task as the advance, just before it (ADR 0013): only elements that
   * were not usable then confirm it. Kept in memory and carried to the attempt's next
   * document, never stored.
   */
  inPlace?: { operationId: string; before: TargetState[] };
  /**
   * Likewise each other layout's next step on the advance's path, by the layout's key (ADR
   * 0060): only elements not usable then confirm a switch to that layout on that path.
   */
  siblingsInPlace?: { operationId: string; siblings: { layout: string; before: TargetState[] }[] };
  /**
   * Since when the page after the final `advance` step `operationId` has shown a sign-in
   * input on `path`, so the recipe may be continued there (ADR 0018). Kept in memory only.
   */
  qualified?: { operationId: string; path: string; since: number };
  /**
   * The final `advance` step whose continuation this document will not send or take over
   * again: its request was spent or its answer could not be used (ADR 0018). Kept apart
   * from `qualified`, so a path change or a page that stops qualifying for a moment does
   * not clear it. Kept in memory only.
   */
  continuationRefused?: string;
  /**
   * When the `passkey` route's answer to its page's own request went back (ADR 0034), or a
   * login's answer at its stop (ADR 0036). Kept per document in memory only, so a new
   * document or a worker restart counts as long after it.
   */
  answeredAt?: number;
  /**
   * The path a login's answer at a stop just past its plan's last step was given on (ADR
   * 0036): with no step at the stop, the page held after the answer is the one on this
   * path, as the stop step's path is otherwise. Kept with `answeredAt`.
   */
  answeredPath?: string;
  /**
   * Why a continuation could not take a stop just past the plan's last step over (ADR 0036,
   * `continuedStop`), as `fills-lacking`: the `challenge` at that stop names it after
   * `password-empty:`. Kept in memory only, so a later document logs the bare reason.
   */
  stopMiss?: PasswordStopMiss;
  /** The login's item could not answer its page's own request; the login never asks again. */
  passkeyFailed?: true;
  /**
   * The recipe's rejection showed when the login fell back from the passkey answer to the
   * password (ADR 0034). It does not reject the password in this document until it has gone.
   */
  staleRejection?: true;
};
/**
 * A top document's own `conditional` passkey request, waiting for the login of that
 * document (ADR 0034). `settle` answers it once and says whether it still waited.
 */
type ParkedRequest = {
  tabId: number;
  origin: string;
  documentId: string;
  /** Whether its tab is incognito, as its sender or the tab says; absent when not known. */
  incognito?: boolean;
  since: number;
  /** The login of its document was seen running, so its end decides the request. */
  during?: true;
  /**
   * Its document was asked for an account (ADR 0021 D, ADR 0062), so it waits for the
   * pick while the tab asks.
   */
  asked?: true;
  /**
   * Its document was offered a popup choice outside an ask in which an item holds a
   * discoverable passkey, so it waits for the pick while that choice is offered (ADR 0034).
   */
  picking?: true;
  /**
   * When a pick for its document started no login, or the choice it waited for went away;
   * it waits briefly for the choice again.
   */
  dropped?: number;
  settle(decision: ConditionalDecision): boolean;
};
/**
 * A popup choice offered to a tab's top document outside an ask, on a recipe without a
 * passkey button (ADR 0034): whether one of its items holds a discoverable passkey, checked
 * once while a conditional request of that document waits. Kept in memory only.
 */
type ChoicePasskeys = {
  /** The choice it describes, as `choiceKey` names it. */
  key: string;
  /** The document the choice was offered to. */
  documentId: string;
  /** Unset until the check ends. */
  holds?: boolean;
  checking?: true;
  /** A site default was saved for the origin since, which ends the choice. */
  defaulted?: true;
};
/** Names a popup choice by its document and the accounts it offers. */
const choiceKey = (choice: {
  document: { documentId: string; origin: string };
  candidates: readonly { connectionId: string; itemId: string }[];
}) =>
  JSON.stringify([
    choice.document.documentId,
    choice.document.origin,
    choice.candidates.map((entry) => `${entry.connectionId} ${entry.itemId}`).sort(),
  ]);
/** An in-memory catalog copy in which one item covers `origin`; never persisted. */
function withItemOrigin(
  catalog: VaultCatalog,
  account: { connectionId: string; itemId: string },
  origin: string,
): VaultCatalog {
  const granted = structuredClone(catalog);
  const item = granted.connections
    .find((entry) => entry.id === account.connectionId)
    ?.items.find((entry) => entry.id === account.itemId);
  if (item && !item.allowedOrigins.includes(origin)) item.allowedOrigins.push(origin);
  return granted;
}
/** Internal: admit again, because an account choice was saved while admitting (ADR 0022). */
const CHOICE_SAVED = "choice-saved";
const terminal = (metadata: LoginAttemptMetadata) =>
  ["authenticated", "blocked"].includes(metadata.state);
/**
 * A login with no step left to run: its result settled as unknown, or it is watched after a
 * `challenge` (ADR 0027). Its later pages are checked, but it is not a login in progress.
 */
const idle = (metadata: LoginAttemptMetadata) =>
  metadata.settled === true || metadata.state === "watching";
/**
 * Whether a login of an item without a password stands at its stop with nothing in flight
 * (ADR 0036): the step there fills the password, so it never runs, or the stop lies just
 * past the plan's last step and no step is there.
 */
const atStop = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" &&
  metadata.stopAt !== undefined &&
  metadata.stepIndex === metadata.stopAt &&
  metadata.operationId === undefined;
/** Whether such a login answered a passkey request at its stop (`STOP_ANSWERED`). */
const answeredAtStop = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" &&
  metadata.stopAt !== undefined &&
  metadata.stepIndex === metadata.stopAt &&
  metadata.operationId !== undefined;
/** Whether the plan step at `index` lies past such a login's stop. */
const pastStop = (metadata: LoginAttemptMetadata, index: number) =>
  metadata.route === "password" && metadata.stopAt !== undefined && index > metadata.stopAt;
/**
 * Whether such a login's stop lies just past its plan's last step (ADR 0036): its route
 * fills no password and ends with an `advance`, as a recipe whose page after the identifier
 * is not generated yet. The page that advance leads to is the stop's.
 */
const stopsPastPlan = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" && metadata.stopAt === metadata.stepCount;
/** Whether the step in flight is the final `advance` that leads to such a stop. */
const advancingToStop = (metadata: LoginAttemptMetadata) =>
  stopsPastPlan(metadata) &&
  metadata.operationId !== undefined &&
  metadata.operationEffect === "advance" &&
  metadata.stepIndex + 1 === metadata.stopAt;
/**
 * Whether a login whose result settled as unknown runs in the document its watch began in
 * (ADR 0027), which was already read for that result.
 */
const settledHere = (run: Execution) =>
  run.metadata.state === "reconciling" &&
  run.metadata.settled === true &&
  run.metadata.watch?.documentId === run.live.document.documentId;
/** Whether a login's watch is over at `now`; a clock set back ends it too (ADR 0027). */
const watchOver = (metadata: LoginAttemptMetadata, now: number) =>
  metadata.watch !== undefined &&
  (now - metadata.watch.since >= WATCH_MS || now < metadata.watch.since);

/**
 * Where one recipe starts: its start path and the first step of each of its routes and
 * variants, all on that path (ADR 0027).
 */
/**
 * Where a recipe starts: its first steps, or for a chooser recipe (ADR 0028) `list`, the
 * list's own buttons, when it shows the list of accounts, and as its steps the first step
 * of its `other` branch when that starts on the list's path.
 */
/**
 * One layout a new login may run (ADR 0060), in the order it is tried, with the later
 * steps that show of it when the login starts at one (ADR 0049).
 */
/**
 * Where a login may start later in its recipe (ADR 0049): each variant's showing steps, in
 * order, `partial` holding `variant:index` for a step that shows only with its password
 * fields alone, and whether the start page's passkey button shows beside them.
 */
type LaterStart = { variants: Map<number, number[]>; partial: Set<string>; button: boolean };
type LayoutChoice = {
  recipe: LoginRecipe;
  later?: LaterStart | undefined;
};
export type LoginRecipeStart = {
  path: string;
  steps: LoginStep[];
  list?: LoginTarget[];
  /** What the later steps a login may start at when no first step shows wait for (ADR 0049). */
  later?: LoginReadiness[];
};
/**
 * Cached recipes. Account bindings come from synced settings (`settings.bindings`,
 * ADR 0013); neither carries values.
 */
export interface LoginRecipes {
  /**
   * The recipe for a document, or an attempt's own recipe by ID after navigation: one
   * layout of it (ADR 0060), the one named or else the newest.
   */
  recipe(
    origin: string,
    path: string,
    recipeId?: string,
    layout?: string,
  ): Promise<LoginRecipe | undefined>;
  /**
   * Every layout of the recipe that starts on the path, for a new login to choose from
   * (ADR 0060); none when no single recipe starts there.
   */
  layouts?(origin: string, path: string): Promise<LayoutCandidate<LoginRecipe>[]>;
  /**
   * Every layout of a recipe by ID, a chooser's branches for a chooser recipe: a sign-in
   * check reads all their signed-in markers (ADR 0060).
   */
  layoutsOf?(origin: string, recipeId: string): Promise<LoginRecipe[]>;
  /**
   * Whether the recipes, read without failure, no longer hold a layout of the recipe by ID
   * that runs: the recipe or its layout was withdrawn. False when they cannot be read, so a
   * resumed login whose lookup failed stays resumable (owner, 2026-10-23). A sync running
   * or being started by a lookup ends first, for at most a few seconds.
   */
  withdrawn?(origin: string, recipeId: string, layout?: string): Promise<boolean>;
  /** Where every recipe for the origin starts; a document watches for its first steps. */
  starts(origin: string): Promise<LoginRecipeStart[]>;
  /**
   * Each layout of the origin's login recipes with a later step on the path a login may
   * start at (ADR 0049, ADR 0060).
   */
  later?(origin: string, path: string): Promise<LoginRecipe[]>;
  /**
   * The chooser recipe (ADR 0028) whose list shows on the path, or a chooser login's own
   * recipe by ID after navigation: one layout of it, the one named or else the newest.
   */
  chooser?(
    origin: string,
    path: string,
    recipeId?: string,
    layout?: string,
  ): Promise<LoginChooserRecipe | undefined>;
  /** Every layout of the chooser whose list shows on the path (ADR 0060). */
  choosers?(origin: string, path: string): Promise<LayoutCandidate<LoginChooserRecipe>[]>;
  /** The origin's entry recipes (ADR 0031): a start path and the link pressed there. */
  entries(origin: string): Promise<LoginEntryRecipe[]>;
  /** The origin's logout recipes (ADR 0063), for an account switch. */
  logouts?(origin: string): Promise<LoginLogoutRecipe[]>;
  /**
   * Every route recipe of the origin whatever its page kind, and each chooser branch (ADR
   * 0028), which is `sign-in`. `recipe` and `starts` leave out one generated as `confirm`
   * or `unclear` (ADR 0035): its page is never logged in to and is not sent for generation
   * again. Their signed-in markers tell the generation request whether a page shows the
   * user signed in.
   */
  routes?(origin: string): Promise<LoginRecipe[]>;
}
export const noLoginRecipes: LoginRecipes = {
  recipe: async () => undefined,
  starts: async () => [],
  entries: async () => [],
};

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
type ServiceTimed = { timing?: ServiceTiming };

/** An outcome's fields for the local log: never the recipe itself or `retry`. */
function outcomeFields(answer: GenerationOutcome | EntryGenerationOutcome) {
  const timed = answer.timing ? { timing: answer.timing } : {};
  // A route recipe's kind (ADR 0035); a chooser and an entry recipe are always `sign-in`.
  if (answer.outcome === "recipe")
    return {
      outcome: answer.outcome,
      ...("recipe" in answer && "pageKind" in answer.recipe
        ? { pageKind: answer.recipe.pageKind }
        : {}),
      ...timed,
    };
  if (!("check" in answer)) return { outcome: answer.outcome, reason: answer.reason, ...timed };
  const { outcome, reason, check, detail, path } = answer;
  return {
    outcome,
    reason,
    check,
    ...(detail === undefined ? {} : { detail }),
    ...(path === undefined ? {} : { path }),
    ...timed,
  };
}

/**
 * A page's description as generation may send it (ADR 0016), or why not as a value-free
 * code for the log's `detail` (ADR 0019): `invalid-observation` when it fails its check,
 * the extractor's `gap` when it is incomplete (`incomplete` without one), and for a
 * complete one `origin-changed` or `path-changed` when it describes another origin or path
 * than expected, or `list-mismatch` when `list` is given and the description lists
 * accounts on a page not announced as a list, or none on one that was.
 */
function acceptedObservation(
  described: { readonly observation: unknown; readonly gap?: string | undefined },
  expected: { readonly origin: string; readonly path: string; readonly list?: boolean },
): { observation: LoginObservation } | { detail: string } {
  const parsed = v.safeParse(loginObservationSchema, described.observation);
  if (!parsed.success) return { detail: "invalid-observation" };
  const observation = parsed.output;
  if (!observation.complete) return { detail: described.gap ?? "incomplete" };
  if (observation.origin !== expected.origin) return { detail: "origin-changed" };
  if (observation.path !== expected.path) return { detail: "path-changed" };
  if (expected.list !== undefined && (observation.accounts !== undefined) !== expected.list)
    return { detail: "list-mismatch" };
  return { observation };
}

/** Roles of a field that can take an account's email address, username or ID. */
const accountRoles = new Set(["text", "email", "tel", "number"]);
/**
 * A field's `autocomplete` that leaves it free to take an account: none, or one for a
 * username, an email address or a phone number.
 */
const accountTokens = new Set([undefined, "off", "username", "email", "tel"]);
/**
 * Whether a page asks for an account (ADR 0028): it holds a field that can take one, in the
 * same form as a password field when it shows one, so a search box or another form's
 * field beside a password-only form does not count.
 */
const asksAccount = (observation: LoginObservation) => {
  const passwords = observation.candidates.filter((candidate) => candidate.role === "password");
  return observation.candidates.some(
    (candidate) =>
      accountRoles.has(candidate.role) &&
      accountTokens.has(candidate.autocomplete) &&
      (!passwords.length || passwords.some((password) => password.group === candidate.group)),
  );
};

/** The service's recipe generation routes (ADR 0016, ADR 0018). */
export interface LoginGeneration {
  /**
   * `true` when a page may be sent, else why not; with `base` and `branch`, as the first
   * page of that chooser branch (ADR 0028). A branch is the name `recipeBranch` gives a
   * layout and chooser branch (ADR 0060).
   */
  available(
    origin: string,
    path: string,
    base?: RecipeGenerationRequest["base"],
    branch?: string,
  ): Promise<true | GenerationHold>;
  /**
   * Sends one page: a recipe's first page, or with `base` the page after the final
   * `advance` step of that revision, which continues it. A continuation pulls recipes only,
   * so the login it belongs to is not stopped by a settings write. `sent` is called just
   * before the request leaves the device, for the local log (ADR 0019).
   */
  generate(request: RecipeGenerationRequest, sent?: () => void): Promise<GenerationOutcome>;
  /**
   * Sends a page without a login form, without slots (ADR 0031); its answer names the
   * page's sign-in entry. Claimed and held as `generate` claims a first page.
   */
  generateEntry(
    request: EntryGenerationRequest,
    sent?: () => void,
  ): Promise<EntryGenerationOutcome>;
  /**
   * Which vault field each custom slot of a recipe generated from this device names, from
   * the request that produced it (ADR 0027); nothing for a recipe it did not generate.
   */
  slotFields(recipeId: string): Promise<LoginBindingTemplate | undefined>;
  /**
   * Sends a page no recipe check explained after an effect step, so the service can
   * learn a signed-in marker or a handler (ADR 0027). `recipe` is the newer
   * revision with a handler added, already in the recipe cache. `sent` is called just
   * before the request leaves the device.
   */
  judge(
    recipeId: string,
    revision: number,
    route: LoginRoute,
    observation: LoginObservation,
    sent?: () => void,
    /**
     * The layout the login ran (ADR 0060), and for a chooser login (ADR 0028) the branch
     * whose route is judged, as `recipeBranch` names them; none for a recipe without layouts.
     */
    branch?: string,
    /**
     * The description left out a disabled field that may not be a sign-in field: the
     * service keeps the model's abstention as `partial`, so a page of the path described
     * in full is judged again (ADR 0029).
     */
    partial?: true,
    /**
     * The page of a login's stop before its item's missing password, which still shows the
     * stop step's password field: the service keeps only a `passkey` handler from it (ADR
     * 0036, owner 2026-10-13 05:39 UTC).
     */
    stop?: true,
    /**
     * The login account's slots, built as for generation (owner 2026-10-23: the same
     * information goes to every model call unless there is a sound reason); `totp` goes
     * only with a page that shows a code field.
     */
    slots?: readonly SemanticSlot[],
    /**
     * The page still shows the route's sign-in form beside another form that may ask for a
     * detail (`showsBesideForm`): the service keeps only a `detail` handler from it (ADR
     * 0061).
     */
    beside?: true,
  ): Promise<{
    /**
     * `retry` for a temporary refusal before any model call, which gives the page back:
     * no paired service, a rejected device, an unreachable or busy service, the service's
     * own request limit, or a request that failed before the model. `unclear` covers
     * every other answer, including permanent refusals and failed model calls. `optional`
     * is a page after the sign-in that the person may put off (ADR 0065).
     */
    verdict: "signed-in" | "rejected" | "challenge" | "optional" | "unclear" | "retry";
    /** For `retry` and `unclear`: the refusal or failure code, for the local log. */
    reason?: string;
    /** A chooser login's is the whole chooser (ADR 0028); either is the judged layout. */
    recipe?: LoginRecipe | LoginChooserRecipe;
    /**
     * With `recipe`: the secret questions the judge paired with a slot sent, by the answer
     * input, for the owner to confirm in the popup (ADR 0061).
     */
    questions?: { field: LoginFieldTarget; slot: string; shown: string }[];
    /** How long the request took, when one was sent (ADR 0019). */
    timing?: ServiceTiming;
  }>;
  /**
   * Sends a repeat login's signed-in page, which the service logs for evaluation without a
   * model call (ADR 0029, owner 2026-10-18 08:05 UTC), when this device sent none of the
   * recipe and branch in the last 30 days and a service is paired. `describe` is called
   * only then; the sample is recorded on the device before it is sent. `sending` is called
   * after that, just before the request leaves the device: a reason it answers, such as a
   * site excluded meanwhile, stops the request and leaves the record. Absent, no page is
   * sampled.
   */
  samplePage?(
    sample: { recipeId: string; revision: number; route: LoginRoute; branch?: string },
    describe: () => Promise<
      { observation: LoginObservation; slots: readonly SemanticSlot[] } | { unsent: string }
    >,
    sending?: () => Promise<string | undefined>,
  ): Promise<PageSampleOutcome>;
  /**
   * Claims a repair of a generated recipe the chosen item cannot run (ADR 0058 A, amended by
   * ADR 0041), at most once per recipe ID and missing `route` in 3 days for this service
   * and device, recorded before the request leaves. Absent, no such repair is sent.
   */
  claimRepair?(recipeId: string, route: LoginRoute): Promise<RecipeRepairClaim>;
  /**
   * Pulls the service's recipes into the cache, so a repair is never asked for a recipe
   * another device has already changed (ADR 0041).
   */
  pullRecipes?(): Promise<void>;
}

/**
 * Slot meanings sent for generation, each read from the vault item's built-in field of
 * the same name by `defaultLoginBinding`; `totp` reads a custom field holding a TOTP key
 * instead when the built-in one holds no value (`totpFieldReference`, owner 2026-10-23).
 */
const generationSlots: { slot: SemanticSlot; fieldId: string }[] = [
  { slot: builtInLoginSlots.username, fieldId: "login.username" },
  { slot: builtInLoginSlots.password, fieldId: "login.password" },
  { slot: builtInLoginSlots.totp, fieldId: "login.totp-code" },
];
/**
 * Whether a matching item offers a generation slot's built-in field. The password counts
 * only when it holds a value and is not excluded (ADR 0027); the TOTP field counts when
 * present, so the TOTP flag never decides what the model is offered.
 */
function offersGenerationField(
  settings: LocalSettings,
  catalog: VaultCatalog,
  entry: { connectionId: string; item: VaultItemMetadata },
  fieldId: string,
): boolean {
  const field = entry.item.fields.find((candidate) => candidate.id === fieldId);
  if (!field) return false;
  if (fieldId !== "login.password") return true;
  return (
    field.empty !== true &&
    !isFieldExcluded(settings, catalog, entry.connectionId, entry.item.id, fieldId)
  );
}
/**
 * The field a `totp` handler makes its code from for the login's item (ADR 0027): the
 * field the item's saved binding for the recipe names for `totp`, else the one
 * `totpFieldReference` picks (the built-in TOTP field when it holds a value, else the one
 * custom field flagged as holding a key, owner 2026-10-23), or the synthetic probe item's
 * `totp` field. A custom field counts only when it is a Text or Hidden field the catalog
 * flags as holding a TOTP key (`totpSeed`). The code is always generated from the field's
 * key; its raw value is never typed. Undefined when the item has no such field, or when
 * the binding names any other field for `totp`.
 */
function codeFieldOf(
  connection: VaultConnectionMetadata,
  itemId: string,
  bindings: readonly SavedLoginBinding[],
  recipe: LoginRecipe,
): string | undefined {
  const item = connection.items.find((entry) => entry.id === itemId);
  if (!item) return undefined;
  if (connection.provider === "dummy")
    return item.fields.some((field) => field.id === "totp") ? "totp" : undefined;
  if (connection.provider !== "bitwarden" || !connection.userId) return undefined;
  const saved = findLoginBinding(bindings, recipe, {
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
    itemId,
  });
  const reference =
    saved?.slots.find((entry) => entry.slot === TOTP_HANDLER_SLOT)?.field ??
    totpFieldReference(item.fields);
  if (reference !== "totp") {
    const resolved = resolveBindingFields(
      { slots: [{ slot: TOTP_HANDLER_SLOT, field: reference }] },
      [TOTP_HANDLER_SLOT],
      item.fields,
    );
    const fieldId = resolved.ok ? resolved.slots[0]!.fieldId : undefined;
    const field = item.fields.find((entry) => entry.id === fieldId);
    return field?.id.startsWith("custom.") &&
      (field.kind === "text" || field.kind === "hidden") &&
      field.totpSeed === true
      ? field.id
      : undefined;
  }
  return item.fields.some((field) => field.id === "login.totp-code")
    ? "login.totp-code"
    : undefined;
}
/**
 * Why an item's password fact is false, for the log (ADR 0027): the item's password is
 * missing or empty (`password-empty`), or it holds one that the account may not fill,
 * directly or through a field linked to it (`password-not-allowed`). Never a value.
 */
function passwordMiss(
  item: Pick<VaultItemMetadata, "fields"> | undefined,
  allowedFieldIds: readonly string[],
): "password-not-allowed" | "password-empty" {
  const held = item?.fields.some((field) => field.id === "login.password" && field.empty !== true);
  return item &&
    held &&
    !allowedFieldIds.some((allowed) => loginFieldSource(item, allowed) === "login.password")
    ? "password-not-allowed"
    : "password-empty";
}
/**
 * Where the plan step at `index` stands in a TOTP code's entry (ADR 0027): the code fill
 * of an entered `totp` handler or of a route step that fills only the `totp` slot, or
 * the click on its button that follows the fill on the same path. A route's code fill
 * counts only when that click, a submit, follows it. A `totp` handler without a button
 * has only its fill, which submits by itself (ADR 0027 amendment of 2026-10-23).
 */
function codeStep(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): "fill" | "click" | undefined {
  const plan = attemptPlan(recipe, metadata);
  const entry = plan?.[index];
  if (!entry) return undefined;
  const before = plan![index - 1];
  if (entry.handler !== undefined) {
    if (recipe.handlers?.[entry.handler]?.kind !== "totp") return undefined;
    if (entry.step.kind === "fill") return "fill";
    return entry.step.kind === "click" &&
      before?.handler === entry.handler &&
      before.step.kind === "fill"
      ? "click"
      : undefined;
  }
  const routeCode = (at: { step: LoginStep; handler?: number } | undefined) =>
    at?.handler === undefined &&
    at?.step.kind === "fill" &&
    at.step.fields.length === 1 &&
    at.step.fields[0]!.slot === TOTP_HANDLER_SLOT;
  const after = plan![index + 1];
  if (routeCode(entry))
    return after?.handler === undefined &&
      after?.step.kind === "click" &&
      after.step.purpose === "submit" &&
      after.step.path === entry.step.path
      ? "fill"
      : undefined;
  return entry.step.kind === "click" &&
    entry.step.purpose === "submit" &&
    routeCode(before) &&
    before!.step.path === entry.step.path
    ? "click"
    : undefined;
}
/**
 * Where the plan step at `index` stands in an entry the page may submit by itself: a TOTP
 * code's (`codeStep`, ADR 0027), or a route step's fill on a software keyboard followed on
 * the same path by its submit click, as a PIN pad that submits at its last digit
 * (ADR 0067).
 */
function selfSubmitStep(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): "fill" | "click" | undefined {
  const code = codeStep(recipe, metadata, index);
  if (code) return code;
  const plan = attemptPlan(recipe, metadata);
  type Entry = { step: LoginStep; handler?: number } | undefined;
  const keyed = (fill: Entry, click: Entry) =>
    fill?.handler === undefined &&
    click?.handler === undefined &&
    fill !== undefined &&
    keypadStep(fill.step) &&
    click?.step.kind === "click" &&
    click.step.purpose === "submit" &&
    click.step.path === fill.step.path;
  if (keyed(plan?.[index], plan?.[index + 1])) return "fill";
  if (keyed(plan?.[index - 1], plan?.[index])) return "click";
  return undefined;
}
/**
 * Whether a TOTP code's fill (see `codeStep`) went in, or may have, and its click has not
 * run (ADR 0027): a page that moved on meanwhile submitted the code by itself. A fill on a
 * software keyboard counts only after the page told of its first key press (`press`, ADR
 * 0067), while the fill is still running or once it went in and before its click is
 * prepared: a document that replaced the page before any press, as after the person's own
 * link click or a reload, submitted nothing, and neither did one after a stopped fill.
 */
const codeAwaitsClick = (
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  press: KeypadPress | undefined,
) =>
  metadata.operationId === undefined
    ? codeStep(recipe, metadata, metadata.stepIndex) === "click" ||
      (press?.filled === true &&
        press.stepIndex === metadata.stepIndex - 1 &&
        selfSubmitStep(recipe, metadata, metadata.stepIndex) === "click")
    : metadata.operationKind === "fill" &&
      metadata.operationEffect === "prepare" &&
      metadata.mutationIntent === true &&
      (codeStep(recipe, metadata, metadata.stepIndex) === "fill" ||
        (press?.filled !== true &&
          press?.operationId === metadata.operationId &&
          selfSubmitStep(recipe, metadata, metadata.stepIndex) === "fill"));
/**
 * A keypad fill whose page told of its first key press (ADR 0067): its operation and plan
 * step, and whether it went in.
 */
interface KeypadPress {
  operationId: string;
  stepIndex: number;
  filled?: true;
}
/** The event for a code the page submitted by itself, marking a route step's code. */
const autoSubmitted = (recipe: LoginRecipe, metadata: LoginAttemptMetadata) => ({
  type: "AUTO_SUBMITTED" as const,
  operationId: newId(),
  ...(attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.handler === undefined
    ? { routeStep: true as const }
    : {}),
});
/** The step may have submitted or moved the page, so its result can show a handler. */
const effectful = (metadata: LoginAttemptMetadata) =>
  metadata.operationKind === "click" ||
  metadata.operationEffect === "advance" ||
  metadata.operationEffect === "submit";
const stepTargets = (step: LoginStep) =>
  step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target];
/**
 * The name of the layout a login runs (ADR 0060) and, for a chooser login (ADR 0028), the
 * branch its click led to, as the service's records and requests name them; `undefined` for
 * a recipe without layouts, as the probe build's.
 */
function branchOf(metadata: LoginAttemptMetadata): string | undefined {
  return metadata.layout === undefined
    ? undefined
    : recipeBranch(
        metadata.layout,
        metadata.chooser ? chooserClickBranch(metadata.chooser.click) : undefined,
      );
}
/** `branchOf` as an optional `branch` member. */
function branchField(metadata: LoginAttemptMetadata): { branch?: string } {
  const branch = branchOf(metadata);
  return branch ? { branch } : {};
}
/**
 * The recipe's signed-in markers as elements to observe (ADR 0029): each marker, which may
 * be a link located by its text (ADR 0018), then the elements it needs missing. `proves`
 * reads their states from `offset`: whether one marker shows once, visible, while each
 * element it needs missing is missing even hidden, on any path. Only the markers learned
 * on `pageOrigin` count: the recipe's own origin by default, or another origin that a
 * login's tab moved to (ADR 0022).
 */
/** Whether two recipes hold the same signed-in markers, so reading one reads the other. */
const sameMarkers = (left: LoginRecipe, right: LoginRecipe) =>
  JSON.stringify(left.completion ?? []) === JSON.stringify(right.completion ?? []);
function markerProof(recipe: LoginRecipe, pageOrigin = recipe.origin) {
  const markers = (recipe.completion ?? []).filter(
    (marker) => (marker.origin ?? recipe.origin) === pageOrigin,
  );
  return {
    targets: markers.flatMap((marker) => [marker.target, ...(marker.absent ?? [])]),
    links: markers.flatMap((marker) => [true, ...(marker.absent ?? []).map(() => false)]),
    /** Every copy counts, hidden or not, as the markers were learned (ADR 0037 amendment). */
    hidden: markers.flatMap((marker) => [true, ...(marker.absent ?? []).map(() => true)]),
    /** Each marker must be visible; the elements it needs gone count even when hidden. */
    shown: markers.flatMap((marker) => [
      "shown" as const,
      ...(marker.absent ?? []).map(() => "present" as const),
    ]),
    proves(states: readonly string[], offset = 0): boolean {
      let at = offset;
      for (const marker of markers) {
        const absent = marker.absent ?? [];
        if (
          states[at] === "unique" &&
          absent.every((_target, index) => states[at + 1 + index] === "missing")
        )
          return true;
        at += 1 + absent.length;
      }
      return false;
    },
  };
}
/**
 * What confirms the route step at `index` when it is an advance whose next route step is
 * on the same path, as an identifier-first form that swaps in its password form in place
 * (ADR 0013): the next step's elements, as that step waits for them and also visible as
 * the page's description reads them (ADR 0018), so a password input an email form keeps
 * off-screen or hidden from assistive technology for the browser is not taken for the
 * password form before or after the advance. Undefined when no element could confirm it: a
 * next step that needs none, one that shares an element with the advance, or a handler's
 * step, which keeps its own rules (ADR 0027). A `password` handler's click is the exception:
 * the route's next step on its path confirms it as it confirms an advance (ADR 0048).
 */
function inPlaceNext(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): InPlaceNext | undefined {
  const plan = attemptPlan(recipe, metadata);
  const done = plan?.[index];
  const next = plan?.[index + 1];
  if (
    !done ||
    !next ||
    (done.handler !== undefined && recipe.handlers?.[done.handler]?.kind !== "password") ||
    next.handler !== undefined ||
    loginStepEffect(done.step) !== "advance" ||
    done.step.path !== next.step.path
  )
    return undefined;
  const readiness = loginReadiness(next.step);
  const own = stepTargets(done.step);
  if (
    !readiness.targets.length ||
    readiness.targets.some((target) => own.some((other) => sameLoginTarget(other, target)))
  )
    return undefined;
  return {
    require:
      readiness.require === "writable"
        ? "described-writable"
        : readiness.require === "clickable"
          ? "described-clickable"
          : "present",
    targets: readiness.targets,
  };
}
const probeMode = import.meta.env.MODE === "probe";
/** How many of an unconfirmed in-place advance's next targets the log names (ADR 0019). */
const ADVANCE_LOG_TARGETS = 4;
/**
 * Why an advance whose next step is on its own path was not confirmed, for the log only
 * (ADR 0019): per next target, joined by `.`, its state just before the advance
 * (`TargetState`, or `unmeasured`), its state when the advance settled, and the check that
 * decided that (`TargetCheck`), and whether the page was on the step's path. Codes only.
 */
type AdvanceMiss = {
  advanceBefore: string;
  advanceAfter: string;
  advanceWhy: string;
  advancePath: "same" | "other";
};
/**
 * The order in which handlers shown together are tried: a `password` handler first, so a
 * login that types its password goes on to it rather than to a passkey beside it (ADR
 * 0048), then a passkey, which types nothing.
 */
const handlerOrder = { password: 0, passkey: 1, totp: 2, detail: 3 } as const satisfies Record<
  LoginHandler["kind"],
  number
>;

/**
 * How long the page after a recipe's final `advance` step must keep showing a sign-in input,
 * on one path, before it is sent to continue the recipe (ADR 0018).
 */
const CONTINUATION_STABLE_MS = 1000;
/**
 * How long a later document of the login waits for the continuation its earlier document
 * asked for (ADR 0018); the request itself gives up after 90 seconds.
 */
const CONTINUATION_WAIT_MS = 100_000;

/** Custom-field values read for their shapes per generation request (ADR 0027). */
const MAX_CUSTOM_SHAPE_READS = 32;

/** What a page without a recipe is sent with: its slots and the items that matched it. */
type GenerationScope = {
  /** The built-in slots a matching item can fill. */
  slots: SemanticSlot[];
  /** One slot per custom field a matching item allows, numbered over all of them. */
  offers: CustomFieldOffer[];
  items: {
    connection: VaultConnectionMetadata;
    item: VaultCatalog["connections"][number]["items"][number];
  }[];
  settings: SettingsSnapshot["settings"];
  catalog: VaultCatalog;
  /** Every enabled connection answered and every item's URI rules were evaluated. */
  complete: boolean;
};
/** The items that matched a page and the settings they were matched under. */
type VaultMatch = Pick<GenerationScope, "items" | "settings" | "catalog">;

/**
 * The recipe's inputs for the `username` slot on `path`, over every password variant, each
 * once: where a site may show the account it remembers (ADR 0028 amendment of 2026-10-23).
 */
function accountTargetsOn(recipe: LoginRecipe, path: string): LoginFieldTarget[] {
  const targets: LoginFieldTarget[] = [];
  for (const variant of passwordVariants(recipe))
    for (const step of variant.steps)
      if (step.kind === "fill" && step.path === path)
        for (const field of step.fields)
          if (
            field.slot === "username" &&
            !targets.some((target) => sameLoginTarget(target, field.target))
          )
            targets.push(field.target);
  return targets;
}
/** Each URI match's connection and item in the catalog; one the catalog lacks is left out. */
function catalogItems(
  catalog: VaultCatalog,
  candidates: readonly Pick<LiveSiteCandidate, "connectionId" | "itemId">[],
): GenerationScope["items"] {
  return candidates.flatMap((candidate) => {
    const connection = catalog.connections.find((entry) => entry.id === candidate.connectionId);
    const item = connection?.items.find((entry) => entry.id === candidate.itemId);
    return connection && item ? [{ connection, item }] : [];
  });
}

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
type PolicyChange = { cause: PolicyChangeCause; reason?: string };
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

/**
 * A message to a login document that went unanswered, mostly because the document is gone:
 * a submit or a redirect replaced it, or its tab closed. Its replacement resumes the login.
 * `reason` keeps what the browser said: no listener was left, or the page went into the
 * back/forward cache (`no-receiver`), the listener did not answer, as when the document
 * unloads while it handles the message or a content script fault leaves it unanswered
 * (`port-closed`), or anything else (`send-failed`).
 */
class DocumentGone extends Error {
  override name = "DocumentGone";
  readonly reason: "no-receiver" | "port-closed" | "send-failed";
  constructor(cause: unknown) {
    super("document-gone");
    const message = cause instanceof Error ? cause.message : "";
    this.reason = /Receiving end does not exist|back\/forward cache/u.test(message)
      ? "no-receiver"
      : /message (?:port|channel) closed/u.test(message)
        ? "port-closed"
        : "send-failed";
  }
}

/** The badge of a tab whose login waits for an account choice (ADR 0021). */
function choiceBadge(
  candidates: readonly unknown[],
  ask: AskReason | undefined,
  paused?: boolean,
): { count: number; ask?: AskReason; paused?: true } {
  return {
    count: candidates.length,
    ...(ask ? { ask } : {}),
    ...(paused ? { paused: true as const } : {}),
  };
}

export function createLoginRuntime(
  settings: SettingsRuntime,
  options: {
    fields: LoginFieldSource;
    sites?: LoginSites;
    recipes?: LoginRecipes;
    /** Live provider URI matching; without it only static `allowedOrigins` apply. */
    uris?: LiveUriMatcher;
    /** Recipe generation for pages without a recipe; needs `uris` for the vault match. */
    generation?: LoginGeneration;
    /**
     * Which generated recipes' start pages were sent for repair through `generation`
     * (ADR 0041); without it no recipe is repaired.
     */
    repairs?: RecipeRepairs;
    /**
     * The account item's passkey facts, read once when a login starts (ADR 0027). Without
     * it the item counts as holding no passkey, so a `passkey` handler is never run.
     */
    passkeys?: (account: LoginAccount) => Promise<{ passkey: boolean; discoverable: boolean }>;
    /**
     * The items holding a discoverable, usable passkey for the origin, by the criterion of
     * `passkeys`, from one vault search per RP ID (ADR 0034). Without it no popup choice
     * keeps a page's own conditional request waiting.
     */
    passkeyItems?: (origin: string) => Promise<readonly PasskeyItem[]>;
    /**
     * An account switch's logout (ADR 0063): the stored logout recipes and the logout role.
     * Without it the popup offers no switch.
     */
    logout?: LogoutService;
    /**
     * Whether the origin's hostname was just chosen "Always for this site" and its settings
     * write still waits (ADR 0007): the login treats it as listed already.
     */
    pendingBrowserSite?: (origin: string) => boolean;
    /** Receives each attempt state change, refusal and generation result. */
    report?: (report: LoginReport) => void;
    /**
     * The toolbar badge (ADR 0038): the account choice a tab waits on, a tooltip, and a
     * spin while a model request for its page is in flight, from the request's `sent` until
     * it returns; and the tab's last login and model request it read from the reports, for
     * the popup's page section. Without one the runtime writes `chrome.action` itself and
     * keeps nothing across worker restarts.
     */
    badge?: Pick<LoginBadge, "choice" | "note" | "spin" | "status" | "asking"> &
      Partial<Pick<LoginBadge, "paused">>;
    /**
     * The paused sites (ADR 0062); without it they are kept in `storage.session` under
     * `LOGIN_PAUSES_KEY`.
     */
    pauses?: LoginPauses;
    /**
     * Told of each origin of a login that reached signed in, on any route, so a site's
     * passkey registration right after it can be refused (ADR 0007). Never changes the login.
     */
    signedIn?: (tabId: number, origin: string) => void;
    /**
     * Automatic vault sync (ADR 0025). Each page announcement starts a due check and
     * holds vault replacement off while it is handled; a page that may start a login
     * first waits briefly for a running check.
     */
    vault?: {
      refreshIfStale(): void;
      enter(waitForCheck: boolean): Promise<() => void>;
      /**
       * Asked when a page with a recipe found no matching vault item: a check limited to
       * once every ten seconds. Answers true when a check applied a new snapshot within
       * ten seconds, after which the refused document is asked to announce again.
       */
      checkAfterMiss?(): Promise<boolean>;
    };
    /**
     * Told once the runtime has handled a tab's top-frame announcement, which may count
     * the site's items for the toolbar badge (ADR 0021).
     */
    announced?: (tabId: number, url: string) => void;
    /**
     * Asks for the master password of a login's item that has Bitwarden's re-prompt, on a
     * site whose settings honour it, in Pateat's chooser window (ADR 0021; owner, 2026-10-23
     * 12:46 UTC). `verified` once the vault accepted it; `unavailable` when no window may
     * open, as for a tab in the background or in incognito. Without it such an item never
     * starts a login there.
     */
    askMasterPassword?: (input: {
      tabId: number;
      origin: string;
      account: LoginAccount;
      connection: VaultConnectionMetadata;
      item: VaultItemMetadata;
      signal: AbortSignal;
    }) => Promise<"verified" | "closed" | "unavailable">;
  },
) {
  /** A hostname whose passkey requests go to the browser, listed or just chosen (ADR 0007). */
  const listedBrowserSite = (saved: LocalSettings, origin: string) =>
    isPasskeyBrowserSite(saved, origin) || options.pendingBrowserSite?.(origin) === true;
  const { fields, sites, recipes = noLoginRecipes, uris, generation, repairs } = options;
  /** Account switches' and the browser session's picks (ADR 0063). */
  const accountPicks = createAccountPicks();
  const badge =
    options.badge ?? createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() });
  const pauses = options.pauses ?? createLoginPauses(sessionValue(LOGIN_PAUSES_KEY));
  /**
   * When the pause the person set for a document's site ends, while it runs: a frame is
   * paused when its own site or its tab's is (ADR 0062). `unreadable` when the paused
   * sites cannot be read.
   */
  const pausedUntil = (live: {
    url: string;
    topUrl?: string | undefined;
    incognito?: boolean | undefined;
  }): Promise<number | "unreadable" | undefined> =>
    pauses.until([live.url, live.topUrl], live.incognito).catch(() => "unreadable" as const);
  /**
   * What of the saved settings pauses automatic login, read as document admission reads
   * them, before any recipe or vault access; undefined when they cannot be read, or without
   * site admission.
   */
  const pausingSettings = () =>
    sites?.pausing().catch(() => undefined) ?? Promise.resolve(undefined);
  /**
   * What of `policy` pauses a document (ADR 0062): automatic login being off in private
   * windows, for a page of one, else an exclusion rule covering its site or its tab's, or
   * the allowed sites leaving one of them out (ADR 0077).
   */
  const settingsPause = (
    policy: PausingSettings | undefined,
    live: { url: string; topUrl?: string | undefined; incognito?: boolean | undefined },
  ): PauseState | undefined => {
    if (!policy) return undefined;
    if (pausedInPrivate(policy, live.incognito)) return { private: true };
    const rules = [live.url, live.topUrl].map((page) =>
      page === undefined ? undefined : pausingRule(policy, page),
    );
    if (rules.includes("excluded")) return { rule: true };
    return rules.includes("not-allowed") ? { rule: true, notAllowed: true } : undefined;
  };
  /**
   * What pauses automatic login of a document, if anything (ADR 0062): automatic login
   * being off in private windows, or an exclusion rule of the settings covering its site or
   * its tab's, both until changed in the settings, else a pause of a chosen length. Settings
   * that cannot be read count as none; paused sites that cannot be read pause every site,
   * failing safe. `private: false` leaves out automatic login being off in private windows,
   * as for the person's own passkey requests there (ADR 0062 E).
   */
  const pauseOf = async (
    live: {
      url: string;
      topUrl?: string | undefined;
      incognito?: boolean | undefined;
    },
    kinds: { private?: false; policy?: PausingSettings } = {},
  ): Promise<PauseState | undefined> => {
    // Both are read at once, so the pause costs a request no more time than before.
    const [policy, until] = await Promise.all([
      kinds.policy ?? pausingSettings(),
      pausedUntil(live),
    ]);
    const ruled = settingsPause(
      policy && kinds.private === false ? { ...policy, loginInPrivateWindows: true } : policy,
      live,
    );
    if (ruled) return ruled;
    if (until === "unreadable") return { unreadable: true };
    return until === undefined ? undefined : { until };
  };
  /** Spins the tab's badge from a model request's `sent` until `stop`, once the request returns. */
  function spinning(tabId: number) {
    let stop: (() => void) | undefined;
    return {
      sent: (then: () => void) => () => {
        stop ??= badge.spin(tabId);
        then();
      },
      stop: () => stop?.(),
    };
  }
  /** Reports about `source`'s document; only the tab's own page gets its URL (ADR 0019). */
  const report = (source: { frameId: number }, value: LoginReport) => {
    try {
      // A report that names its page's URL, even as none, keeps it.
      const page = documents.get(frameKey({ tabId: value.tabId, frameId: 0 }));
      const url =
        "url" in value
          ? value.url
          : source.frameId === 0 && page && page.document.origin === value.origin
            ? page.url
            : undefined;
      const { url: _named, ...rest } = value;
      options.report?.(url ? { ...rest, url } : rest);
    } catch {
      // A report must never change the answer.
    }
  };
  const reportAttempt = (
    metadata: LoginAttemptMetadata,
    recipe: LoginRecipe | undefined,
    policy?: PolicyChange,
    flags: {
      settled?: true;
      repeat?: true;
      stop?: StopCause;
      reason?: string;
      routeChange?: RouteChange;
      layoutFrom?: string;
      /** When the login ended, if earlier than now, such as when its watch ran out. */
      endedAt?: number;
    } = {},
  ) => {
    const { stop, endedAt, ...marks } = flags;
    // A login that just ended, signed in or blocked, says how long it took (ADR 0019); a
    // watched one only when its watch ends, which may have been before it was noticed.
    const times = terminal(metadata) && !flags.repeat ? attemptTimes(metadata, endedAt) : undefined;
    // Handler steps sit inside the plan, so the plan names the handler a step belongs to.
    const handler =
      recipe && metadata.handlers.length
        ? attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.handler
        : undefined;
    report(metadata.document, {
      type: "attempt",
      tabId: metadata.document.tabId,
      origin: metadata.document.origin,
      recipeId: metadata.recipeId,
      recipeRevision: metadata.recipeRevision,
      ...branchField(metadata),
      route: metadata.route,
      ...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
      state: metadata.state,
      stepIndex: metadata.stepIndex,
      stepCount: metadata.stepCount,
      ...(metadata.operationKind ? { operation: metadata.operationKind } : {}),
      ...(metadata.operationEffect ? { effect: metadata.operationEffect } : {}),
      ...(handler === undefined ? {} : { handler }),
      ...(metadata.outcome ? { outcome: metadata.outcome } : {}),
      ...(metadata.unconfirmed ? { unconfirmed: true as const } : {}),
      ...(metadata.watch ? { watched: true as const } : {}),
      ...(unsubmitted(metadata) ? { unsubmitted: true as const } : {}),
      ...(metadata.fillOnly ? { fillOnly: true as const, reason: "fill-only" } : {}),
      ...(metadata.stopAt === undefined ? {} : { stop: "password" as const }),
      ...(policy && metadata.outcome === "policy-changed" ? policy : {}),
      ...(stop ? { cause: stop } : {}),
      ...marks,
      ...(times ? { times } : {}),
    });
  };
  let origin = DEFAULT_PROBE_ORIGIN;
  let account: ProbeAccount = DEMO_PROBE_ACCOUNT;
  let probePasskey: "discoverable" | "second-factor" | undefined;
  let probeTotp = false;
  // The probe's own step wait; undefined, as always in production, for the full one.
  let probeStepWaitMs: number | undefined;
  const stepWaitMs = () => (probeMode ? probeStepWaitMs : undefined) ?? LOGIN_STEP_WAIT_MS;
  const documents = new Map<string, LiveDocument>();
  const attempts = new Map<number, Execution>();
  /**
   * The keypad fill of each attempt whose page told of its first key press, by attempt ID
   * (ADR 0067), until the fill stops or the next operation answers. Kept in memory only:
   * after a worker restart a replaced page is not taken as the keypad's own submission.
   */
  const keypadPresses = new Map<string, KeypadPress>();
  /**
   * By attempt ID, the document each new login of this worker began in; a resumed or
   * recovered one has none, so it never counts as unsubmitted (ADR 0066).
   */
  const begunIn = new Map<string, string>();
  /** Nothing was submitted yet, and the login is still in the document it began in. */
  const unsubmitted = (metadata: LoginAttemptMetadata) =>
    metadata.submissions === 0 && begunIn.get(metadata.id) === metadata.document.documentId;
  // ADR 0029's sign-in state reads these, kept in memory only and never stored.
  /**
   * By tab: when the attempt last delivered an effect step, the document it ran in, whether
   * the step submits (`submit`), whether it asks for a passkey itself (the `passkey` route,
   * or a `passkey` handler's click; `request` for its own step only, so S5 counts its
   * request only while no answer of Pateat's followed it), and the first other top
   * document of the
   * tab announced after it, within `SITE_MOVE_MS` (`next`). After a password step's
   * submission, that first new document alone is read for a sign-in form shown again
   * (ADR 0029). `code`: when the attempt last submitted a TOTP code, or may have, as the
   * code's click or a code fill the page may submit by itself, which lets a move to
   * another site stand for its result (ADR 0022).
   */
  const effects = new Map<
    number,
    {
      attemptId: string;
      at: number;
      document: LoginDocument;
      submits: boolean;
      passkey: boolean;
      /**
       * The step itself asks for a passkey: the `passkey` route's own step or a `passkey`
       * handler's click, not a later handler's step on that route.
       */
      request: boolean;
      /**
       * When this attempt's latest step that asked for a passkey was delivered, kept by the
       * later steps of a handler after it, which Pateat's answer must follow for an undecided
       * page of the `passkey` route to complete it.
       */
      requestAt?: number;
      next?: string;
      code?: number;
    }
  >();
  /**
   * By tab: the attempt that filled the item's password into its page and whether a
   * submitting step followed (`submitted`), so a passkey answered after that is a second
   * factor rather than the sign-in itself (ADR 0022).
   */
  const passwordFills = new Map<number, { attemptId: string; submitted: boolean }>();
  /** By tab: the URL of the document the attempt's first fill ran in, for E3. */
  const signInUrls = new Map<number, { attemptId: string; url: string }>();
  /** By tab and origin: the last passkey request of the top document, outside conditional mediation. */
  const passkeyRequests = new Map<string, number>();
  /**
   * By tab and origin: the last assertion the passkey bridge returned, its RP ID, the vault
   * item it was signed with and, when no login of the tab's origin ran, the top document it
   * signed in.
   */
  const passkeyAnswers = new Map<
    string,
    {
      at: number;
      rpId: string;
      item?: { connectionId: string; itemId: string };
      signedIn?: string;
    }
  >();
  /**
   * By tab: the page of another origin of the site that a top-level attempt's tab moved to
   * and that asked for a passkey, while the attempt waits for the tab's next top page (ADR
   * 0022): a passkey answered there with the attempt's own item lets that page complete it.
   */
  const passkeyPages = new Map<
    number,
    { attemptId: string; document: LoginDocument; requestedAt: number }
  >();
  /**
   * By tab: the check of a move to another origin after a passkey answer, a password
   * submission or a second factor, while its new top page is read (ADR 0022).
   */
  const siteMoves = new Map<number, Promise<boolean>>();
  /**
   * By attempt: the judgement of the page its tab moved to after a password submission
   * (ADR 0022), while it runs, so the same document announcing again waits for it rather
   * than sending the page twice.
   */
  const moveJudgements = new Map<string, { documentId: string; verdict: Promise<boolean> }>();
  /** Top documents' own conditional passkey requests, waiting for their login (ADR 0034). */
  const parkedRequests = new Set<ParkedRequest>();
  /** By tab: its popup choice outside an ask and whether it offers a passkey (ADR 0034). */
  const choicePasskeys = new Map<number, ChoicePasskeys>();
  let reviewTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The continuation each attempt asked for and the step it was asked for, by attempt ID
   * (ADR 0018): a later document of the login may use the answer. Kept in memory only, so
   * after a worker restart only the recipe cache can bring it.
   */
  const continuations = new Map<
    string,
    { operationId: string; answer: Promise<GenerationOutcome> }
  >();
  /** By `recordKey`, in the order they were last written. */
  const persisted = new Map<string, LoginAttemptMetadata>();
  /**
   * Tabs Chrome replaced, by their old ID: their records move to the new ID once loaded,
   * so the startup check keeps them although their old ID is no longer open.
   */
  const replacedTabs = new Set<number>();
  const picked = new Map<number, PickedAccount>();
  /** Tabs whose account switch is logging out (ADR 0063). */
  const switchesRunning = new Set<number>();
  /**
   * The tab each running switch drives, by its current ID: Chrome may replace the tab
   * meanwhile (`tabs.onReplaced`), and the switch goes on in the new one.
   */
  const switchTabs = new Map<number, { id: number }>();
  /** Each tab's last account switch, as the popup shows it (ADR 0063). */
  const switchStates = new Map<
    number,
    {
      state: "running" | "signed-out" | "failed";
      reason?: string;
      connectionId: string;
      itemId: string;
    }
  >();
  /**
   * A master password typed for a re-prompt item, by tab and document: the document's next
   * login with that item starts once, within `REPROMPT_GRANT_MS`. Kept in memory only, so a
   * restarted worker asks again.
   */
  const repromptGrants = new Map<string, { connectionId: string; itemId: string; at: number }>();
  /**
   * Logins that hold the master password, by attempt ID, with its vault account: typed in
   * the chooser window before the login started, or before it read a personal detail from
   * another re-prompt item (ADR 0061, owner 2026-10-23 21:50 UTC). Such a login reads that
   * account's re-prompt items without asking again. Kept in memory only, so a restarted
   * worker asks again.
   */
  const repromptTyped = new Map<string, string>();
  const holdPassword = (attemptId: string, connectionId: string) => {
    repromptTyped.delete(attemptId);
    repromptTyped.set(attemptId, connectionId);
    for (const old of repromptTyped.keys()) {
      if (repromptTyped.size <= 256) break;
      repromptTyped.delete(old);
    }
  };
  /** Where a login reads personal details from `connectionId` (`DetailSite`). */
  const detailSite = (attemptId: string, connectionId: string, url: string): DetailSite => ({
    url,
    verified: repromptTyped.get(attemptId) === connectionId,
  });
  /**
   * The chooser window asking for the master password, by tab and document: for a login's
   * own item (`login`) or before a detail's read (`detail`), with the vault account it
   * checks the password for. A second ask for the document waits for its answer.
   */
  const passwordAsks = new Map<
    string,
    {
      kind: "login" | "detail";
      connectionId: string;
      answer: Promise<{ answer: "verified" | "closed" | "unavailable"; aborted: boolean }>;
    }
  >();
  /** The login each tab's top document refused for the master password, for the popup. */
  const repromptWaiting = new Map<
    number,
    { document: LoginDocument; account: LoginAccount; pick?: PickedAccount }
  >();
  /** Windows asking, by tab and document, so a document announcing again opens no second. */
  const repromptAsking = new Map<string, AbortController>();
  /**
   * Ends the master password state of one document, or of every document of the tab: its
   * window closes, so a document that replaced it can ask, and an unused grant goes.
   */
  function dropReprompt(tabId: number, documentId?: string): void {
    const matches = (key: string) =>
      documentId === undefined ? key.startsWith(`${tabId} `) : key === `${tabId} ${documentId}`;
    for (const [key, controller] of repromptAsking)
      if (matches(key)) {
        repromptAsking.delete(key);
        controller.abort();
      }
    // A closing window settles later; a document coming back meanwhile asks in a new one.
    for (const key of passwordAsks.keys()) if (matches(key)) passwordAsks.delete(key);
    for (const key of repromptGrants.keys()) if (matches(key)) repromptGrants.delete(key);
    const waiting = repromptWaiting.get(tabId);
    if (waiting && (documentId === undefined || waiting.document.documentId === documentId))
      repromptWaiting.delete(tabId);
  }
  const pending = new Map<number, PendingChoice>();
  /** Reasons already logged, by tab, document and path; stored with the asks. */
  const noted = new Map<string, Set<string>>();
  /**
   * By `recordKey`: tabs that ask after their own login stopped once it submitted, or after
   * their watched login was abandoned.
   */
  const stoppedAsks = new Set<string>();
  /** By `recordKey`: tabs that ask because the site rejected their login of the origin. */
  const rejectedAsks = new Set<string>();
  /**
   * Documents filled once while their tab asks, each as `tabId documentId path`, so neither
   * a re-announcement nor a restarted worker fills over what the user typed (ADR 0021 D); a
   * whole document, as `tabId documentId`, that showed the site's rejection of a login is
   * never filled again. The oldest go first.
   */
  const askFills = new Set<string>();
  /** Records a page or document in `askFills`, keeping the 256 newest. */
  function addAskFill(entry: string): void {
    askFills.add(entry);
    for (const old of askFills) {
      if (askFills.size <= 256) break;
      askFills.delete(old);
    }
  }
  /**
   * By `reloginKey`: when automatic logins of a site ended `authenticated` in the last
   * `RELOGIN_WINDOW_MS`, the oldest first (ADR 0062).
   */
  const relogins = new Map<string, Relogins>();
  /** By tab: its sign-in entry press, kept until the tab closes (ADR 0031). */
  const entryPresses = new Map<number, EntryPress>();
  /** By tab: the document whose sign-in entry is being checked and pressed now (ADR 0031). */
  const pressing = new Map<number, string>();
  /**
   * By `${tabId} ${documentId}`: the check of a page after an entry press while it runs, so
   * the same document announcing again waits for it.
   */
  const entryChecks = new Map<string, Promise<void>>();
  /** By tab: when an entry press with no next page so far is checked. */
  const entryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * Pages after an entry press that blocked its recipe, as `${tabId} ${documentId}`: they
   * are never sent for generation and start no login (ADR 0031). The oldest go first.
   */
  const entryRefused = new Set<string>();
  /**
   * Blocks this worker could not store, because the device's blocks could not be read or
   * written; they hold until the worker stops (ADR 0031).
   */
  const unsavedBlocks: EntryBlock[] = [];
  /** By tab: the `detail` handler its login stopped at for want of a link (ADR 0061). */
  const detailOffers = new Map<number, DetailOffer>();
  /**
   * The popup's last card guess for an offer's input (ADR 0061), by attempt, document and
   * input: its key (the settings revision, vault snapshot, candidates and a digest of the
   * page's answer), the item IDs in order and whether it selects; never a digit.
   */
  const cardGuesses = new Map<
    string,
    { key: string; vault: string; order: string[]; preselect: boolean }
  >();
  /** By tab: links filled from the popup, saved once its login is confirmed (ADR 0061). */
  const pendingDetails = new Map<number, PendingDetail[]>();
  /** Refused links not removed yet, by site, login item and detail (ADR 0061). */
  const refusedDetails = new Map<string, RefusedDetail>();
  // A secret question's answer has a link per question field; the other details one each.
  const refusalKey = (owner: DetailOwner, detail: LoginDetail, field?: DetailSourceField) =>
    JSON.stringify([
      owner.origin,
      owner.provider,
      owner.userId,
      owner.itemId,
      detail,
      detail === "secret-answer" && field !== undefined ? sourceFieldKey(field) : null,
    ]);
  /** Account choices being saved; each bumps the policy revision (ADR 0022). */
  const savingChoices = new Set<Promise<void>>();
  /** Counts account choices saved or attempted, so a new login sees a bump it missed. */
  let remembered = 0;
  // Toolbar and session storage failures only lose the badge or a pick; never a login.
  const quietly = (work: () => Promise<unknown>) =>
    Promise.try(work).then(
      () => undefined,
      () => undefined,
    );
  // Picks and waiting choices outlive a worker restart, as the tab's badge does. Every
  // change to them happens after this load.
  const sessionRead = quietly(async () => {
    const items = await storage.getItems([
      PICKS_KEY,
      CHOICES_KEY,
      STOPPED_ASKS_KEY,
      REJECTED_ASKS_KEY,
      ASK_FILLS_KEY,
      ENTRY_PRESSES_KEY,
      NOTED_KEY,
      RELOGINS_KEY,
      DETAIL_OFFERS_KEY,
      PENDING_DETAILS_KEY,
      REFUSED_DETAILS_KEY,
    ]);
    const stored = Object.fromEntries(items.map(({ key, value }) => [key, value]));
    const picks = v.safeParse(v.array(pickedAccountSchema), stored[PICKS_KEY] ?? []);
    if (picks.success) for (const entry of picks.output) picked.set(entry.tabId, entry);
    const choices = v.safeParse(v.array(pendingChoiceSchema), stored[CHOICES_KEY] ?? []);
    if (choices.success)
      for (const entry of choices.output) {
        pending.set(entry.document.tabId, entry);
        // Chrome kept the tab's badge; the badge learns the choice it shows again.
        badge.choice(entry.document.tabId, choiceBadge(entry.candidates, entry.ask, entry.paused));
      }
    const stopped = v.safeParse(v.array(askSchema), stored[STOPPED_ASKS_KEY] ?? []);
    if (stopped.success)
      for (const entry of stopped.output) stoppedAsks.add(recordKey(entry.tabId, entry.origin));
    const rejected = v.safeParse(v.array(askSchema), stored[REJECTED_ASKS_KEY] ?? []);
    if (rejected.success)
      for (const entry of rejected.output) rejectedAsks.add(recordKey(entry.tabId, entry.origin));
    const filled = v.safeParse(
      v.pipe(v.array(v.string()), v.maxLength(256)),
      stored[ASK_FILLS_KEY] ?? [],
    );
    if (filled.success) for (const entry of filled.output) askFills.add(entry);
    const counted = v.safeParse(
      v.pipe(v.array(reloginSchema), v.maxLength(256)),
      stored[RELOGINS_KEY] ?? [],
    );
    if (counted.success)
      for (const entry of counted.output)
        relogins.set(reloginKey(entry.site, entry.incognito), entry);
    const logged = v.safeParse(
      v.pipe(v.array(v.tuple([v.string(), v.array(v.string())])), v.maxLength(256)),
      stored[NOTED_KEY] ?? [],
    );
    // Every note waits for this load.
    if (logged.success)
      for (const [key, reasons] of logged.output) noted.set(key, new Set(reasons));
    const presses = v.safeParse(
      v.pipe(v.array(entryPressSchema), v.maxLength(256)),
      stored[ENTRY_PRESSES_KEY] ?? [],
    );
    if (presses.success)
      for (const entry of presses.output) {
        entryPresses.set(entry.tabId, entry);
        // A press whose next page was not checked before a restart is checked in time.
        if (!entry.checked) armEntryTimer(entry);
      }
    const offers = v.safeParse(
      v.pipe(v.array(detailOfferSchema), v.maxLength(256)),
      stored[DETAIL_OFFERS_KEY] ?? [],
    );
    if (offers.success)
      for (const entry of offers.output) detailOffers.set(entry.document.tabId, entry);
    const kept = v.safeParse(
      v.pipe(v.array(pendingDetailSchema), v.maxLength(1024)),
      stored[PENDING_DETAILS_KEY] ?? [],
    );
    if (kept.success)
      for (const entry of kept.output)
        pendingDetails.set(entry.tabId, [...(pendingDetails.get(entry.tabId) ?? []), entry]);
    const refused = v.safeParse(
      v.pipe(v.array(refusedDetailSchema), v.maxLength(1000)),
      stored[REFUSED_DETAILS_KEY] ?? [],
    );
    if (refused.success)
      for (const entry of refused.output)
        refusedDetails.set(refusalKey(entry, entry.detail, entry.field), entry);
  });
  // An account switch whose worker stopped while it logged out ended with it: its pick is
  // dropped and the popup says so. One that had signed out still waits for the login page
  // (ADR 0063).
  const sessionLoaded = sessionRead.then(() =>
    quietly(async () => {
      const { interrupted, signedOut } = await accountPicks.restored();
      for (const pick of interrupted)
        switchStates.set(pick.tabId, {
          state: "failed",
          reason: "interrupted",
          connectionId: pick.connectionId,
          itemId: pick.itemId,
        });
      for (const pick of signedOut)
        switchStates.set(pick.tabId, {
          state: "signed-out",
          connectionId: pick.connectionId,
          itemId: pick.itemId,
        });
    }),
  );
  const scopes = (keys: Set<string>) =>
    [...keys].map((key) => {
      const at = key.indexOf(" ");
      return { tabId: Number(key.slice(0, at)), origin: key.slice(at + 1) };
    });
  async function saveSession(): Promise<void> {
    await storage.setItems([
      { key: PICKS_KEY, value: [...picked.values()] },
      { key: CHOICES_KEY, value: [...pending.values()] },
      { key: STOPPED_ASKS_KEY, value: scopes(stoppedAsks) },
      { key: REJECTED_ASKS_KEY, value: scopes(rejectedAsks) },
      { key: ASK_FILLS_KEY, value: [...askFills] },
      { key: ENTRY_PRESSES_KEY, value: [...entryPresses.values()] },
      { key: NOTED_KEY, value: [...noted].map(([page, ids]) => [page, [...ids]]) },
      { key: RELOGINS_KEY, value: [...relogins.values()] },
      { key: DETAIL_OFFERS_KEY, value: [...detailOffers.values()] },
      { key: PENDING_DETAILS_KEY, value: [...pendingDetails.values()].flat() },
      { key: REFUSED_DETAILS_KEY, value: [...refusedDetails.values()] },
    ]);
  }
  /**
   * Why a tab asks for an account of an origin (ADR 0021 D): the site rejected its own
   * login, its own login stopped after a submission or its watch was abandoned, or the
   * site rejected another tab's login that still asks. Undefined when it does not ask.
   */
  function askFor(tabId: number, siteOrigin: string): AskReason | undefined {
    const key = recordKey(tabId, siteOrigin);
    if (rejectedAsks.has(key)) return "rejected";
    if (stoppedAsks.has(key)) return "stopped-login";
    return rejectedElsewhere(tabId, siteOrigin) ? "rejected-elsewhere" : undefined;
  }
  /** Badges the tab and records the refused document for the popup (ADR 0021). */
  function offerChoice(
    document: LoginDocument,
    candidates: PendingChoice["candidates"],
    ask?: AskReason,
    paused?: boolean,
  ): void {
    // The same document offered the choice again still waits since its first offer.
    const offered = pending.get(document.tabId);
    pending.set(document.tabId, {
      document,
      at: offered?.document.documentId === document.documentId ? offered.at : Date.now(),
      candidates,
      ...(ask ? { ask } : {}),
      ...(paused ? { paused: true as const } : {}),
    });
    void quietly(saveSession);
    badge.choice(document.tabId, choiceBadge(candidates, ask, paused));
  }
  function clearChoice(tabId: number): void {
    if (!pending.delete(tabId)) return;
    void quietly(saveSession);
    badge.choice(tabId, undefined);
    badge.note(tabId, undefined);
  }
  // Attempts, the probe configuration and entry blocks are trusted-only device records.
  const attemptRecords = trustedRecord<LoginAttemptMetadata[]>(STORAGE_KEY);
  const probeConfig = trustedRecord<object>(CONFIG_KEY);
  const entryBlockRecords = trustedRecord<EntryBlock[]>(ENTRY_BLOCKS_KEY);
  let storageQueue: Promise<void> = Promise.resolve();
  let storageHealthy = true;
  let checkpoint: "before-delivery" | "before-ack" | undefined;
  let armed: "before-delivery" | "before-ack" | "intent-write-failure" | undefined;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseCheckpoint: (() => void) | undefined;
  async function pause(at: "before-delivery" | "before-ack"): Promise<void> {
    if (import.meta.env.MODE !== "probe" || armed !== at) return;
    clearTimeout(armTimer);
    armed = undefined;
    checkpoint = at;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        releaseCheckpoint = undefined;
        checkpoint = undefined;
        reject(new Error("Synthetic checkpoint expired"));
      }, 5000);
      releaseCheckpoint = () => {
        clearTimeout(timer);
        checkpoint = undefined;
        releaseCheckpoint = undefined;
        resolve();
      };
    });
  }
  /**
   * By tab: whether it is in an incognito window, as Chrome reported it. Incognito windows
   * keep their own cookies, so a tab there never shares a site's session with a tab
   * outside them, and neither holds the other back (owner, 2026-10-23).
   */
  const incognitoTabs = new Map<number, boolean>();
  const loaded = (async () => {
    try {
      const [config, stored] = await Promise.all([probeConfig.read(), attemptRecords.read()]);
      if (probeMode && config !== undefined) {
        const parsed = v.parse(configureSchema, {
          version: 1,
          type: "login.probe.configure",
          ...(config as object),
        });
        origin = parsed.origin;
        account = parsed.account ?? DEMO_PROBE_ACCOUNT;
        probePasskey = parsed.passkey;
        probeTotp = parsed.totp === true;
        probeStepWaitMs = parsed.stepWaitMs;
      }
      if (stored === undefined) return;
      if (!Array.isArray(stored) || stored.length > 100) throw new Error("Invalid attempt store");
      for (const entry of stored) {
        const metadata = recoverLoginAttempt(parseAttemptMetadata(entry));
        const key = recordKey(metadata.document.tabId, metadata.account.origin);
        if (persisted.has(key)) throw new Error("Duplicate attempt scope");
        persisted.set(key, metadata);
      }
      // Complete startup reconciliation before accepting any hello or checking
      // ownership. Closing a tab can wake a worker whose in-memory map is empty.
      const openTabs = await browser.tabs.query({});
      for (const tab of openTabs)
        if (tab.id !== undefined && !incognitoTabs.has(tab.id))
          incognitoTabs.set(tab.id, tab.incognito);
      const liveIds = new Set(openTabs.map((tab) => tab.id));
      for (const [key, metadata] of persisted)
        if (!liveIds.has(metadata.document.tabId) && !replacedTabs.has(metadata.document.tabId))
          persisted.delete(key);
      await attemptRecords.write([...persisted.values()]);
    } catch {
      storageHealthy = false;
    }
  })();
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
  /**
   * Per tab, its page on whose path a recipe generated as `confirm` or `unclear` starts
   * (ADR 0035), until the tab leaves it: kept in memory only, so a worker restart loses it.
   */
  const confirmVisits = new Map<number, ConfirmVisit>();
  /** The latest announcement of each frame while it is admitted, by the same key. */
  const admitting = new Map<string, Promise<unknown>>();
  /** The site count's crypto job in flight (ADR 0021), which an admission waits for. */
  let counting: Promise<unknown> | undefined;
  const probeDocument = (url: URL) =>
    probeMode && url.origin === origin && url.protocol === "http:" && url.hostname === "127.0.0.1";
  // The synthetic fixture embeds its frames in a page on another loopback port to test refusal.
  const probeTop = (url: URL) =>
    probeMode && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const admitted = async (url: URL) =>
    probeDocument(url) || (sites !== undefined && (await sites.admission(url)) === "admitted");
  /**
   * The browser-identified document. A frame inside the page is admitted only when the
   * tab's page is admitted too; excluded sites stop it on either side (ADR 0017). A
   * document whose origin is not its URL's, such as a page the site isolates with a CSP
   * `sandbox` header or a sandboxed frame, is not the site and is refused.
   */
  async function identify(sender: Sender): Promise<LoginDocument | undefined> {
    if (
      sender.id !== browser.runtime.id ||
      sender.tab?.id === undefined ||
      sender.frameId === undefined ||
      !sender.documentId ||
      // A prerendered page also has a nonzero frame ID; it is not a frame of the tab.
      (sender as { documentLifecycle?: string }).documentLifecycle === "prerender" ||
      !sender.url ||
      senderDocumentOrigin(sender) === undefined
    )
      return undefined;
    if (sender.tab.incognito !== undefined) incognitoTabs.set(sender.tab.id, sender.tab.incognito);
    try {
      const url = new URL(sender.url);
      if (!(await admitted(url))) return undefined;
      if (sender.frameId !== 0) {
        // Only the top page's URL is known here, not its origin. A sandboxed top page still
        // cannot have a login filled under it: its frames inherit the sandbox, so their own
        // origin check above refuses them.
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
    senderPageUrl(sender) === browser.runtime.getURL("/options.html") &&
    !sender.tab?.url?.startsWith("http:");
  /**
   * The record of a tab for one origin, also once it ended. A document resumes only its
   * own origin's record; a logout may release exactly this one.
   */
  function recordFor(tabId: number, documentOrigin: string): LoginAttemptMetadata | undefined {
    const run = attempts.get(tabId);
    return run?.metadata.account.origin === documentOrigin
      ? run.metadata
      : persisted.get(recordKey(tabId, documentOrigin));
  }
  /**
   * Whether another tab's login still holds the origin. Cookies can be shared across tabs,
   * so a login that is running, awaits its result, or ended without success there keeps this
   * tab from submitting until that tab closes or its record has not changed for
   * `HOLD_MS` (ADR 0022). One that authenticated, ended without ever submitting, or was
   * stopped by Pateat with nothing in flight does not: the login form showing in this tab
   * then means the site's session has ended.
   */
  function heldElsewhere(tabId: number, siteOrigin: string): boolean {
    const now = Date.now();
    return (
      switchingElsewhere(tabId, siteOf(siteOrigin)) ||
      persisted
        .values()
        .some(
          (entry) =>
            entry.account.origin === siteOrigin &&
            entry.document.tabId !== tabId &&
            sharesCookies(entry.document.tabId, tabId) &&
            holdsOthers(entry, now),
        )
    );
  }
  /**
   * Whether another tab sharing its cookies switches accounts on `site` (ADR 0063): from
   * its start until its pick starts a login, the switch fails or the pick expires. A login
   * here meanwhile would sign the site back in with the account being left.
   */
  function switchingElsewhere(tabId: number, site: string | undefined): boolean {
    return accountPicks.switchingElsewhere(tabId, site, incognitoTabs.get(tabId));
  }
  /**
   * Whether two tabs may share a site's cookies: unless one is known to be in an incognito
   * window and the other known not to be (owner, 2026-10-23).
   */
  function sharesCookies(tabId: number, otherTabId: number): boolean {
    const incognito = incognitoTabs.get(tabId);
    const other = incognitoTabs.get(otherTabId);
    return incognito === undefined || other === undefined || incognito === other;
  }
  /** The tab of a `recordKey`. */
  const keyTab = (key: string) => Number(key.slice(0, key.indexOf(" ")));
  /**
   * Whether another tab sharing its cookies logged in to the origin within the last hour. A list of
   * accounts showing then is most likely the signed-in site's own, such as its accounts or
   * workspaces, so it is not sent for generation (ADR 0028, owner 2026-10-17). The record
   * stays until that tab shows the recipe's first step again or closes, so the hour bounds
   * how long a tab left open keeps a real list of the site from being sent.
   */
  function signedInElsewhere(tabId: number, siteOrigin: string): boolean {
    const now = Date.now();
    return persisted.values().some((entry) => {
      const age = now - (entry.changedAt ?? Number.NEGATIVE_INFINITY);
      return (
        entry.account.origin === siteOrigin &&
        entry.document.tabId !== tabId &&
        sharesCookies(entry.document.tabId, tabId) &&
        entry.state === "authenticated" &&
        // A clock set back ends the skip rather than prolonging it.
        age >= 0 &&
        age < SIGNED_IN_ELSEWHERE_MS
      );
    });
  }
  /** Whether another tab sharing its cookies still asks after the site rejected its login (ADR 0021). */
  function rejectedElsewhere(tabId: number, siteOrigin: string): boolean {
    return [...rejectedAsks].some(
      (key) =>
        key !== recordKey(tabId, siteOrigin) &&
        key.endsWith(` ${siteOrigin}`) &&
        sharesCookies(keyTab(key), tabId),
    );
  }
  /** Tells the tab why it does not log in while another tab's login holds the site (a key). */
  function showHeld(tabId: number): void {
    badge.note(
      tabId,
      "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.",
    );
  }
  /** The attempt a tab runs, else the one it last recorded. */
  function tabAttempt(tabId: number): LoginAttemptMetadata | undefined {
    const run = attempts.get(tabId);
    if (run) return run.metadata;
    const records = [...persisted.values()].filter((entry) => entry.document.tabId === tabId);
    return records.find((entry) => !terminal(entry)) ?? records.at(-1);
  }
  const fromPopup = (sender: Sender) =>
    sender.id === browser.runtime.id &&
    senderPageUrl(sender) === browser.runtime.getURL("/popup.html");
  const reviving = new Map<number, Promise<void>>();
  /**
   * Asks a refused document that a restarted worker knows only from session storage to
   * announce again; that offers its choice again, or clears it once the document is gone.
   */
  function revive(waiting: PendingChoice): Promise<void> {
    const { tabId, frameId, documentId } = waiting.document;
    let running = reviving.get(tabId);
    if (!running) {
      running = browser.tabs
        .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId, documentId })
        .then(
          () => undefined,
          () => {
            if (pending.get(tabId) === waiting) clearChoice(tabId);
          },
        )
        .finally(() => reviving.delete(tabId));
      reviving.set(tabId, running);
    }
    return running;
  }
  /** The refused document of a tab and the accounts it could use, for the popup. */
  async function choiceFor(tabId: number): Promise<ChoiceResponse> {
    // The attempt records decide whether another tab holds the site.
    await loaded;
    await sessionLoaded;
    let waiting = pending.get(tabId);
    if (waiting && !documents.has(frameKey(waiting.document))) {
      await revive(waiting);
      // The document may have answered as stale because another announcement of it, such
      // as one asked for by the restarted worker's reconnect of every tab, overtook it.
      await admitting.get(`${tabId}:${waiting.document.frameId}`)?.catch(() => undefined);
      // A document that answered but could not be admitted again, for example after its
      // site access was withdrawn, offers nothing; asking again would only repeat that.
      if (pending.get(tabId) === waiting && !documents.has(frameKey(waiting.document)))
        clearChoice(tabId);
      waiting = pending.get(tabId);
    }
    const live = waiting && documents.get(frameKey(waiting.document));
    if (
      !waiting ||
      !live ||
      !sameLoginDocument(live.document, waiting.document) ||
      recordFor(tabId, waiting.document.origin) !== undefined
    ) {
      // The document announced again without being refused for several accounts.
      if (waiting && live) clearChoice(tabId);
      return { ok: false, reason: "no-choice" };
    }
    // A default saved since the refusal decides the page's next login instead.
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (pending.get(tabId) !== waiting) return { ok: false, reason: "no-choice" };
    // A paused choice ends once its pause has (ADR 0062); the page's next announcement
    // logs in.
    if (waiting.paused && (await pauseOf(live)) === undefined) {
      if (pending.get(tabId) === waiting) clearChoice(tabId);
      return { ok: false, reason: "no-choice" };
    }
    if (pending.get(tabId) !== waiting) return { ok: false, reason: "no-choice" };
    const held = heldElsewhere(tabId, waiting.document.origin) ? { held: true as const } : {};
    // A tab that asks, and a paused site (ADR 0062), offers any matching account.
    if (waiting.ask || waiting.paused)
      return {
        ok: true,
        origin: waiting.document.origin,
        documentId: waiting.document.documentId,
        candidates: waiting.candidates,
        ...(waiting.ask ? { ask: waiting.ask } : {}),
        ...(waiting.paused ? { paused: true as const } : {}),
        ...held,
        ...(waiting.ask !== "rejected" && rejectedElsewhere(tabId, waiting.document.origin)
          ? { rejectedElsewhere: true as const }
          : {}),
      };
    if (
      !snapshot.ok ||
      snapshot.snapshot.settings.siteDefaults.some(
        (entry) => entry.origin === waiting.document.origin,
      )
    ) {
      if (snapshot.ok) clearChoice(tabId);
      return { ok: false, reason: "no-choice" };
    }
    return {
      ok: true,
      origin: waiting.document.origin,
      documentId: waiting.document.documentId,
      candidates: waiting.candidates,
      ...held,
      ...(rejectedElsewhere(tabId, waiting.document.origin)
        ? { rejectedElsewhere: true as const }
        : {}),
    };
  }
  /** By tab: the popup's last logged answer, so an open popup asking each second logs once. */
  const popupAnswers = new Map<number, string>();
  /** Answers the popup and logs, value-free, what it was told when that changes (ADR 0019). */
  async function popupChoice(tabId: number): Promise<ChoiceResponse> {
    const answer = await choiceFor(tabId);
    const page = documents.get(frameKey({ tabId, frameId: 0 }));
    const pageOrigin = answer.ok ? answer.origin : page?.document.origin;
    if (pageOrigin === undefined) return answer;
    const record = recordFor(tabId, pageOrigin);
    const entry: LoginReport = {
      type: "popup",
      tabId,
      origin: pageOrigin,
      choice: answer.ok ? "offered" : "none",
      ...(answer.ok
        ? {
            candidates: answer.candidates.length,
            ...(answer.ask ? { ask: answer.ask } : {}),
            ...(answer.paused ? { paused: true as const } : {}),
            ...(answer.held ? { held: true as const } : {}),
            ...(answer.rejectedElsewhere ? { rejectedElsewhere: true as const } : {}),
          }
        : {}),
      ...(record
        ? {
            recordState: record.state,
            ...(record.outcome ? { recordOutcome: record.outcome } : {}),
          }
        : {}),
      ...(page?.reason ? { pageReason: page.reason } : {}),
    };
    const key = JSON.stringify(entry);
    if (popupAnswers.get(tabId) !== key) {
      popupAnswers.set(tabId, key);
      report({ frameId: 0 }, entry);
    }
    return answer;
  }
  /**
   * What the popup's page section shows for a tab (ADR 0038): whether the top page's origin
   * has a recipe, and for which path; the page's state as this worker last saw it; and the
   * tab's last login and model request on that origin. Never a value, recipe step or query.
   */
  async function popupStatus(tabId: number): Promise<StatusResponse> {
    const live = documents.get(frameKey({ tabId, frameId: 0 }));
    // The tab's own URL, since its page may not have announced yet.
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    const url = tab?.url ?? live?.url;
    const page = url ? (URL.parse(url) ?? undefined) : undefined;
    // The popup shows its page section only on HTTP(S) pages.
    if (page?.protocol !== "https:" && page?.protocol !== "http:")
      return { ok: false, reason: "no-page" };
    const till = await pausedUntil({
      url: page.href,
      incognito: tab?.incognito ?? live?.incognito,
    });
    const pausedTill = typeof till === "number" ? till : undefined;
    const pageOrigin = page.origin;
    const path = observedPath(page.pathname);
    const [starts, entries, routes] = await Promise.all([
      recipes.starts(pageOrigin).catch(() => []),
      recipes.entries(pageOrigin).catch(() => []),
      routesOf(pageOrigin),
    ]);
    // A later step a login may start at counts as a start on its path (ADR 0049), and so
    // does the first page of a recipe generated as a verification (ADR 0035).
    const paths = [
      ...starts.flatMap((start) => [start.path, ...(start.later ?? []).map((entry) => entry.path)]),
      ...entries.map((entry) => entry.entry.path),
      ...(routes ?? [])
        .filter((recipe) => !runsLogin(recipe))
        .map((recipe) => recipe.steps[0]!.path),
    ];
    await loaded;
    const status = badge.status(tabId);
    const known = status?.origin === pageOrigin ? status : undefined;
    // A login whose result settled as unknown has nothing in flight; its next pages are
    // checked (ADR 0027), so the popup does not show it as logging in. A login in a frame
    // is recorded under the frame's origin.
    const attempt = recordFor(tabId, pageOrigin) ?? tabAttempt(tabId);
    const settled =
      known?.login?.state === "reconciling" &&
      attempt?.state === "reconciling" &&
      attempt.settled === true &&
      (attempt.pageOrigin ?? attempt.account.origin) === pageOrigin;
    // The worker's view of the page holds only while the tab still shows its path.
    const shown = live?.document.origin === pageOrigin && live.path === path ? live : undefined;
    const pageState = shown && {
      ...(shown.state ? { state: shown.state } : {}),
      ...(shown.reason ? { reason: shown.reason } : {}),
      ...(shown.notStarted ? { notStarted: shown.notStarted } : {}),
      ...(shown.generationSkip ? { generationSkip: shown.generationSkip } : {}),
    };
    return {
      ok: true,
      origin: pageOrigin,
      recipe: paths.includes(path) ? "page" : paths.length ? "other-paths" : "none",
      ...(badge.asking(tabId) ? { asking: true as const } : {}),
      ...(pageState ? { page: clipCodes(pageState) } : {}),
      ...(known?.login
        ? {
            login: {
              ...clipCodes({
                state: known.login.state,
                outcome: known.login.outcome,
                cause: known.login.cause,
              }),
              ...(known.login.unconfirmed ? { unconfirmed: true as const } : {}),
              ...(known.login.fillOnly ? { fillOnly: true as const } : {}),
              ...(settled ? { settled: true as const } : {}),
            },
          }
        : {}),
      ...(known?.refused ? { refused: clipCodes(known.refused) } : {}),
      ...(pausedTill === undefined ? {} : { pause: { until: pausedTill } }),
      ...(known?.generation ? { generation: clipCodes(known.generation) } : {}),
      ...usedAndSwitch(tabId, pageOrigin),
    };
  }
  /**
   * For the popup (ADR 0063): the account of the tab's latest login on the page's site that
   * signed in, and the tab's account switch.
   */
  function usedAndSwitch(
    tabId: number,
    pageOrigin: string,
  ): Pick<Extract<StatusResponse, { ok: true }>, "used" | "switch"> {
    const site = siteOf(pageOrigin);
    const run = attempts.get(tabId)?.metadata;
    const signedIn = [
      ...persisted.values().filter((entry) => entry.id !== run?.id),
      ...(run ? [run] : []),
    ]
      .filter(
        (entry) =>
          entry.document.tabId === tabId &&
          entry.state === "authenticated" &&
          site !== undefined &&
          siteOf(entry.account.origin) === site,
      )
      .sort((left, right) => (left.changedAt ?? 0) - (right.changedAt ?? 0))
      .at(-1);
    const switching = switchStates.get(tabId);
    return {
      ...(signedIn
        ? {
            used: {
              connectionId: signedIn.account.connectionId,
              itemId: signedIn.account.itemId,
            },
          }
        : {}),
      ...(switching
        ? {
            switch: {
              state: switching.state,
              ...(switching.reason ? { reason: logCode(switching.reason) } : {}),
              connectionId: switching.connectionId,
              itemId: switching.itemId,
            },
          }
        : {}),
    };
  }
  /**
   * The open tabs whose page is on `url`'s registrable site, in the windows of that kind:
   * normal or incognito (ADR 0062).
   */
  async function siteTabs(url: string, incognito: boolean): Promise<Browser.tabs.Tab[]> {
    const site = pauseSite(url);
    const tabs = await browser.tabs.query({}).catch(() => []);
    return tabs.filter(
      (tab) =>
        tab.id !== undefined &&
        (tab.incognito === true) === incognito &&
        tab.url !== undefined &&
        site !== undefined &&
        pauseSite(tab.url) === site,
    );
  }
  /** Shows the pause of the tab's page, or its end, on the tab's badge (ADR 0062). */
  async function showTabPause(tab: Browser.tabs.Tab): Promise<void> {
    if (tab.id === undefined || !tab.url || pauseSite(tab.url) === undefined) return;
    badge.paused?.(tab.id, await pauseOf({ url: tab.url, incognito: tab.incognito }));
  }
  /** Shows the pause of `url`'s site, or its end, on the badge of each of its tabs. */
  async function showPause(url: string, incognito: boolean): Promise<Browser.tabs.Tab[]> {
    const tabs = await siteTabs(url, incognito);
    await Promise.all(tabs.map(showTabPause));
    return tabs;
  }
  /**
   * The tabs that show the site of `url` in a window of that kind, also in a frame of
   * another site's page, or hold a choice of a document of the site (ADR 0062).
   */
  async function pausedTabs(url: string, incognito: boolean): Promise<Set<number>> {
    const site = pauseSite(url);
    const tabs = await browser.tabs.query({}).catch(() => []);
    const kindOf = new Map(tabs.map((tab) => [tab.id, tab.incognito === true]));
    const ids = new Set((await siteTabs(url, incognito)).map((tab) => tab.id!));
    // Only the documents and choices of tabs of that window kind: the other kind keeps its
    // own pause. One whose kind is not known is left out.
    const ofKind = (tabId: number, known: boolean | undefined) =>
      (known ?? kindOf.get(tabId)) === incognito;
    for (const live of documents.values())
      if (pauseSite(live.url) === site && ofKind(live.document.tabId, live.incognito))
        ids.add(live.document.tabId);
    for (const [tabId, waiting] of pending)
      if (
        waiting.paused &&
        pauseSite(waiting.document.origin) === site &&
        ofKind(tabId, documents.get(frameKey(waiting.document))?.incognito)
      )
        ids.add(tabId);
    return ids;
  }
  /**
   * Stops a running automatic login of a site whose pause just started, before its next
   * step, as a settings change does (outcome `policy-changed`, cause `paused`). Its record
   * is let go, so it holds nothing, and its document asks as a paused one (ADR 0062).
   */
  async function stopForPause(run: Execution): Promise<void> {
    if (!current(run) || terminal(run.metadata)) return;
    void send(run.live, { type: "login.cancel" }).catch(() => undefined);
    await change(run, { type: "POLICY_CHANGED" }, { cause: "paused" }).catch(() => undefined);
    const { document } = run.live;
    if (attempts.get(document.tabId) !== run || !terminal(run.metadata)) return;
    attempts.delete(document.tabId);
    await forget(recordKey(document.tabId, run.metadata.account.origin)).catch(() => undefined);
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (documents.get(frameKey(document)) !== run.live) return;
    const candidates = snapshot?.ok
      ? await pausedCandidates(
          snapshot,
          run.live,
          snapshot.snapshot.settings.siteDefaults.find((entry) => entry.origin === document.origin),
        ).catch(() => [])
      : [];
    if (documents.get(frameKey(document)) !== run.live) return;
    if (candidates.length) offerChoice(document, candidates, undefined, true);
    note(document, run.live.url, "paused", undefined, undefined, candidates.length || undefined);
    run.live.state = "denied";
    run.live.reason = "paused";
    delete run.live.refusal;
    await publish(run.live);
  }
  /**
   * Pauses automatic login of the tab's registrable site for `length`, in every tab of the
   * tab's window kind, or resumes it without one (ADR 0062). A pause stops the site's running automatic
   * logins and hands on its waiting conditional passkey requests at once. A resume ends the
   * site's paused choices, also once the pause ended by itself, and asks the site's tabs,
   * and frames of the site in other tabs, to announce again, so they log in at once.
   * Nothing goes to the service.
   */
  /**
   * When the timed pause of the tab's site ends, for the popup's pause row (ADR 0062): read
   * from the tab's URL and window kind alone, as the row shows while the page section and
   * its status are hidden.
   */
  async function pauseStateFor(tabId: number): Promise<PauseResponse> {
    await sessionLoaded;
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    const url = tab?.url;
    if (!url || pauseSite(url) === undefined) return { ok: false, reason: "no-site" };
    const till = await pausedUntil({ url, incognito: tab.incognito === true });
    if (till === "unreadable") return { ok: false, reason: "storage-unavailable" };
    return till === undefined ? { ok: true } : { ok: true, until: till };
  }
  async function pauseFor(tabId: number, length: PauseLength | undefined): Promise<PauseResponse> {
    const paused = length !== undefined;
    await sessionLoaded;
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    const url = tab?.url;
    if (!url || pauseSite(url) === undefined) return { ok: false, reason: "no-site" };
    const incognito = tab.incognito === true;
    let until: number | undefined;
    let resumed = false;
    try {
      if (paused) until = await pauses.pause(url, incognito, length);
      else resumed = await pauses.resume(url, incognito);
    } catch {
      return { ok: false, reason: "storage-unavailable" };
    }
    if (paused || resumed)
      report(
        { frameId: 0 },
        {
          type: "pause",
          tabId,
          origin: new URL(url).origin,
          action: paused ? "paused" : "resumed",
          ...(paused ? { length } : {}),
          ...(incognito ? { incognito: true as const } : {}),
        },
      );
    await showPause(url, incognito);
    const ids = await pausedTabs(url, incognito);
    if (paused) {
      // Waiting conditional requests of the site's pages go to the browser at once.
      for (const parked of [...parkedRequests])
        if (ids.has(parked.tabId) && pauseSite(parked.origin) === pauseSite(url))
          parked.settle({ kind: "delegate", reason: "paused" });
      reviewRequests();
      // Running automatic logins of the site stop; one a popup pick started goes on.
      const stopping: Promise<void>[] = [];
      for (const run of attempts.values())
        if (
          !terminal(run.metadata) &&
          run.metadata.watch === undefined &&
          picked.get(run.live.document.tabId)?.attemptId !== run.metadata.id &&
          (run.live.incognito ?? incognito) === incognito &&
          [run.live.url, run.live.topUrl].some(
            (page) => page !== undefined && pauseSite(page) === pauseSite(url),
          )
        )
          stopping.push(stopForPause(run));
      await Promise.all(stopping);
    } else
      for (const id of ids) {
        // A choice offered because of the pause ends; the page's announcement decides anew.
        const hadChoice = pending.get(id)?.paused === true;
        if (hadChoice) clearChoice(id);
        // Every frame announces again, so the site's pages log in at once; after a pause
        // that ran out by itself, those still refused as paused do.
        if (
          resumed ||
          hadChoice ||
          documents.values().some((live) => live.document.tabId === id && live.reason === "paused")
        )
          void browser.tabs
            .sendMessage(id, { version: 1, type: "login.reconnect" })
            .catch(() => undefined);
      }
    return { ok: true, ...(until === undefined ? {} : { until }) };
  }
  /**
   * Ends the pause of the site of a login picked in the popup once it signed in, confirmed
   * as `noteSignedIn` counts it (ADR 0062): the person signed in, so nothing is left to keep
   * paused. Its own site's pause ends, and for a login in a frame the tab's site's too.
   */
  async function endPickedPause(
    metadata: LoginAttemptMetadata,
    live: LiveDocument | undefined,
  ): Promise<void> {
    const { tabId } = metadata.document;
    if (picked.get(tabId)?.attemptId !== metadata.id) return;
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    const incognito = live?.incognito ?? tab?.incognito;
    // A login whose window kind is not known ends no pause, since the other kind's pause is
    // the person's own.
    if (incognito === undefined) return;
    const urls = new Set(
      [metadata.account.origin, metadata.pageOrigin, live?.topUrl].filter(
        (value): value is string => value !== undefined,
      ),
    );
    const ended: string[] = [];
    for (const url of urls)
      if (await pauses.resume(url, incognito).catch(() => false)) ended.push(url);
    for (const url of ended) {
      report(metadata.document, {
        type: "pause",
        tabId,
        origin: new URL(url).origin,
        action: "picked",
        ...(incognito ? { incognito: true as const } : {}),
      });
      // eslint-disable-next-line no-await-in-loop
      await showPause(url, incognito);
    }
  }
  /**
   * Opens the chooser window for the master password of a refused login's re-prompt item,
   * once per document at a time. Once the vault accepts it, the document announces again and
   * its login starts with that item, as after a pick in the popup (ADR 0021 B), whose pick it
   * keeps. The check is never cut off by the page: an aborted check would lock the vault.
   */
  function openPasswordWindow(
    kind: "login" | "detail",
    key: string,
    input: {
      tabId: number;
      origin: string;
      account: LoginAccount;
      connection: VaultConnectionMetadata;
      item: VaultItemMetadata;
    },
  ) {
    const ask = options.askMasterPassword!;
    const controller = new AbortController();
    let settle!: (value: {
      answer: "verified" | "closed" | "unavailable";
      aborted: boolean;
    }) => void;
    const entry = {
      kind,
      connectionId: input.connection.id,
      answer: new Promise<{ answer: "verified" | "closed" | "unavailable"; aborted: boolean }>(
        (resolve) => (settle = resolve),
      ),
    };
    // Both are set before the window is asked for, so its end always removes them.
    repromptAsking.set(key, controller);
    passwordAsks.set(key, entry);
    void (async () => {
      let answer: "verified" | "closed" | "unavailable";
      try {
        answer = await ask({ ...input, signal: controller.signal });
      } catch {
        answer = "unavailable";
      } finally {
        if (repromptAsking.get(key) === controller) repromptAsking.delete(key);
        if (passwordAsks.get(key) === entry) passwordAsks.delete(key);
      }
      settle({ answer, aborted: controller.signal.aborted });
    })();
    return entry;
  }
  async function askMasterPassword(
    asking: { document: LoginDocument; account: LoginAccount; pick?: PickedAccount },
    connection: VaultConnectionMetadata,
    item: VaultItemMetadata,
  ): Promise<RepromptResponse> {
    const { document, account: login } = asking;
    const key = `${document.tabId} ${document.documentId}`;
    if (!options.askMasterPassword) return { ok: false, reason: "unavailable" };
    const open = passwordAsks.get(key);
    if (open?.kind === "login") return { ok: true };
    // A window that asks before a detail's read is answered first; its password counts
    // for this login only when it was checked for the same vault account.
    const asked =
      open ??
      openPasswordWindow("login", key, {
        tabId: document.tabId,
        origin: document.origin,
        account: login,
        connection,
        item,
      });
    const { answer, aborted } = await asked.answer;
    // Checked for another vault account, whatever its answer: once it ends, this login
    // asks for its own, while the document still waits for it.
    const other = asked.connectionId !== connection.id;
    if (answer !== "verified" && !other) return { ok: false, reason: answer };
    const live = documents.get(frameKey(document));
    if (live?.document.documentId !== document.documentId || aborted)
      return { ok: false, reason: "document-gone" };
    // The document may have started another login meanwhile, as after a pick in the popup.
    if (live.reason !== "master-password-reprompt") return { ok: false, reason: "not-waiting" };
    if (other) return askMasterPassword(asking, connection, item);
    repromptGrants.set(key, {
      connectionId: login.connectionId,
      itemId: login.itemId,
      at: Date.now(),
    });
    if (asking.pick) {
      picked.set(document.tabId, { ...asking.pick });
      await quietly(saveSession);
    }
    try {
      await browser.tabs.sendMessage(
        document.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: document.frameId, documentId: document.documentId },
      );
    } catch {
      repromptGrants.delete(key);
      return { ok: false, reason: "document-gone" };
    }
    return { ok: true };
  }
  /**
   * Asks for the master password before a personal detail is read from `item`, another item
   * of the login's vault account with Bitwarden's re-prompt (ADR 0061; owner, 2026-10-23
   * 21:50 UTC), in the chooser window that asks for a login's own item, under its rules.
   * Once the vault accepts it, the offer's login holds it (`holdPassword`), while the tab
   * still runs that login. One window at a time per document: a second ask waits for the
   * first one's answer. A closed window or one that cannot open gives no password.
   */
  async function askDetailPassword(
    offer: DetailOffer,
    connection: VaultConnectionMetadata,
    item: VaultItemMetadata,
  ): Promise<boolean> {
    const { document } = offer;
    const key = `${document.tabId} ${document.documentId}`;
    if (!options.askMasterPassword) return false;
    // A window already open for the document, for its login's item or another detail's,
    // is answered once; each ask then checks its own login.
    const asked =
      passwordAsks.get(key) ??
      openPasswordWindow("detail", key, {
        tabId: document.tabId,
        origin: document.origin,
        account: offer.account,
        connection,
        item,
      });
    const { answer, aborted } = await asked.answer;
    if (aborted || tabAttempt(document.tabId)?.id !== offer.attemptId) return false;
    // Checked for another vault account: once it ends, this read asks for its own.
    if (asked.connectionId !== connection.id) return askDetailPassword(offer, connection, item);
    if (answer !== "verified") return false;
    holdPassword(offer.attemptId, connection.id);
    return true;
  }
  /** The popup's button for a tab whose login waits for the master password. */
  async function repromptFor(tabId: number): Promise<RepromptResponse> {
    const waiting = repromptWaiting.get(tabId);
    const live = documents.get(frameKey({ tabId, frameId: 0 }));
    if (
      !waiting ||
      live?.document.documentId !== waiting.document.documentId ||
      live.reason !== "master-password-reprompt"
    )
      return { ok: false, reason: "not-waiting" };
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return { ok: false, reason: "unavailable" };
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === waiting.account.connectionId,
    );
    const item = connection?.items.find((entry) => entry.id === waiting.account.itemId);
    if (!connection || !item) return { ok: false, reason: "unavailable" };
    // The site may have stopped asking since.
    if (!itemAsksForMasterPassword(snapshot.snapshot.settings, item, live.url))
      return { ok: false, reason: "not-waiting" };
    return askMasterPassword(waiting, connection, item);
  }
  /**
   * Restarts the refused document's login with the picked account: the document announces
   * again and a new attempt starts from the recipe's first step, if that step still shows.
   */
  async function pickFor(request: v.InferOutput<typeof pickRequestSchema>): Promise<PickResponse> {
    const offered = await choiceFor(request.tabId);
    const waiting = pending.get(request.tabId);
    if (!offered.ok || !waiting || offered.documentId !== request.documentId)
      return { ok: false, reason: "no-choice" };
    if (
      !offered.candidates.some(
        (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
      )
    )
      return { ok: false, reason: "not-a-candidate" };
    // The pick would be refused as the page announces; the choice stays for a later pick.
    if (offered.held) return { ok: false, reason: "origin-busy" };
    const pick: PickedAccount = {
      tabId: request.tabId,
      origin: waiting.document.origin,
      documentId: waiting.document.documentId,
      connectionId: request.connectionId,
      itemId: request.itemId,
      makeDefault: request.makeDefault,
      waitedMs: Math.max(0, Date.now() - waiting.at),
    };
    picked.set(request.tabId, pick);
    clearChoice(request.tabId);
    let gone = false;
    try {
      await saveSession();
      // The document answers once its new announce is handled, started or refused.
      await browser.tabs.sendMessage(
        request.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: waiting.document.frameId, documentId: waiting.document.documentId },
      );
      // Another announcement of the document may have overtaken this one and take the pick.
      await admitting.get(`${request.tabId}:${waiting.document.frameId}`)?.catch(() => undefined);
    } catch {
      gone = true;
    }
    if (pick.attemptId !== undefined) return { ok: true };
    // A pick that started nothing is dropped; the form's next appearance asks again.
    if (picked.get(request.tabId) === pick) {
      picked.delete(request.tabId);
      await quietly(saveSession);
    }
    // Nothing answers the document's passkey request then, unless its choice is offered
    // again soon, as when the document announces again (ADR 0034).
    for (const parked of parkedRequests)
      if (parked.tabId === request.tabId && parked.documentId === waiting.document.documentId)
        parked.dropped = Date.now();
    if (gone) return { ok: false, reason: "document-gone" };
    // Another tab's login started holding the site after the choice was offered. The page
    // does not announce again once that hold ends, so its choice waits for a later pick.
    const live = documents.get(frameKey(waiting.document));
    if (
      live?.reason === "origin-busy" &&
      live.document.documentId === waiting.document.documentId &&
      !pending.has(request.tabId)
    ) {
      offerChoice(waiting.document, waiting.candidates, waiting.ask, waiting.paused);
      return { ok: false, reason: "origin-busy" };
    }
    // On a paused site an item without a password is not handed on to its passkey; the
    // page's own passkey button signs in with it through the chooser window (ADR 0062).
    if (
      waiting.paused &&
      live?.document.documentId === waiting.document.documentId &&
      live.reason === "no-route" &&
      live.refusal?.startsWith("password-empty") === true
    )
      return { ok: false, reason: "paused-no-password" };
    return { ok: false, reason: "not-started" };
  }
  /**
   * Starts an account switch from the popup (ADR 0063) on the tab's top page: only one
   * Pateat watches, that waits for no account choice and runs no login or other switch, whose
   * site no login or switch of another tab sharing its cookies holds, for an account that
   * matches the page, and with a paired service's logout recipes; also on a paused or
   * excluded site, as the switch is the person's pick. The switch's pick is stored first; the logout
   * runs on behind the answer.
   */
  async function switchFor(
    request: v.InferOutput<typeof switchRequestSchema>,
  ): Promise<SwitchResponse> {
    await sessionLoaded;
    const { tabId } = request;
    const live = documents.get(frameKey({ tabId, frameId: 0 }));
    const site = live && siteOf(live.document.origin);
    if (!live || site === undefined) return { ok: false, reason: "no-page" };
    if (pending.has(tabId)) return { ok: false, reason: "choice-waiting" };
    if (switchesRunning.has(tabId)) return { ok: false, reason: "in-progress" };
    const running = tabAttempt(tabId);
    if (running && !terminal(running) && !idle(running)) return { ok: false, reason: "tab-busy" };
    // Another tab's login of the site, as one waiting for a code, holds the session the
    // logout would end, and the switch's own login would wait for it (ADR 0022); another
    // tab's switch on the site holds it until it ends.
    if (siteHeldElsewhere(tabId, site)) return { ok: false, reason: "site-held" };
    if (!options.logout) return { ok: false, reason: "unavailable" };
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return { ok: false, reason: "settings-unavailable" };
    // A paused site, also one an exclusion rule or a private window pauses, still switches:
    // the switch is the person's pick (ADR 0062, ADR 0063).
    const found = uris ? await siteCandidates(snapshot, live) : { reason: "no-uri-matcher" };
    if (
      "reason" in found ||
      !found.candidates.some(
        (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
      )
    )
      return { ok: false, reason: "not-a-candidate" };
    // Checked again after the reads: the tab may have started a login or switch meanwhile,
    // and so may another tab of the site.
    if (switchesRunning.has(tabId)) return { ok: false, reason: "in-progress" };
    if (siteHeldElsewhere(tabId, site)) return { ok: false, reason: "site-held" };
    if (documents.get(frameKey(live.document)) !== live) return { ok: false, reason: "no-page" };
    switchesRunning.add(tabId);
    try {
      await accountPicks.startSwitch({
        tabId,
        site,
        incognito: live.incognito === true,
        connectionId: request.connectionId,
        itemId: request.itemId,
        makeDefault: request.makeDefault,
      });
    } catch {
      switchesRunning.delete(tabId);
      return { ok: false, reason: "settings-unavailable" };
    }
    switchStates.set(tabId, {
      state: "running",
      connectionId: request.connectionId,
      itemId: request.itemId,
    });
    report(live.document, {
      type: "switch",
      tabId,
      origin: live.document.origin,
      stage: "start",
      ...(request.makeDefault ? { makeDefault: true as const } : {}),
    });
    // The records the tab holds for the site now are the account being signed out of.
    const before = new Set(
      [...persisted.values()]
        .filter((entry) => entry.document.tabId === tabId && siteOf(entry.account.origin) === site)
        .map((entry) => entry.id),
    );
    const tab = { id: tabId };
    switchTabs.set(tabId, tab);
    void runSwitch(live, site, before, request).finally(() => {
      switchesRunning.delete(tab.id);
      if (switchTabs.get(tab.id) === tab) switchTabs.delete(tab.id);
    });
    return { ok: true };
  }
  /**
   * Signs the tab out for its switch (ADR 0063), then lets the site's next login page log
   * in with the picked account: the tab's records of the signed-out account are released,
   * as after a logout, and its page announces again.
   */
  async function runSwitch(
    started: LiveDocument,
    site: string,
    before: ReadonlySet<string>,
    request: v.InferOutput<typeof switchRequestSchema>,
  ): Promise<void> {
    // The tab, followed when Chrome replaces it (`tabs.onReplaced`).
    const tab = switchTabs.get(request.tabId) ?? { id: request.tabId };
    const top = () => {
      const live = documents.get(frameKey({ tabId: tab.id, frameId: 0 }));
      return live && siteOf(live.document.origin) === site ? live : undefined;
    };
    const logout = options.logout!;
    let run: Awaited<ReturnType<typeof runLogout>>;
    try {
      run = await runLogout<LiveDocument>(
        {
          page: top,
          describe: async (live) => {
            const extracted = v.safeParse(
              extractResultSchema,
              await send(live, { type: "login.extract", page: "logout" }).catch(() => undefined),
            );
            if (!extracted.success) return { unsent: "extract-failed" };
            if (!extracted.output.ok) return { unsent: extracted.output.reason };
            const accepted = acceptedObservation(extracted.output, {
              origin: live.document.origin,
              path: live.path,
            });
            if ("detail" in accepted) return { unsent: accepted.detail };
            return isEntryObservation(accepted.observation)
              ? { observation: accepted.observation }
              : { unsent: "not-entry" };
          },
          click: async (live, target, purpose): Promise<LogoutPress> => {
            let answer: unknown;
            try {
              answer = await send(live, {
                type: "login.logout.click",
                target,
                purpose,
                timeoutMs: LOGIN_STEP_WAIT_MS,
              });
            } catch {
              // The page went while it was pressed: the press led there.
              return "clicked";
            }
            const parsed = v.safeParse(logoutClickResultSchema, answer);
            if (!parsed.success) return "missing";
            if (parsed.output.ok) return "clicked";
            const { reason } = parsed.output;
            return reason === "ambiguous" || reason === "missing" || reason === "unsafe"
              ? reason
              : "page-changed";
          },
          findLocal: async (live) => {
            // A logout link elsewhere is not this site's (ADR 0031's link check).
            const onSite = await hostsOnSite(live);
            if (onSite === undefined) return "none";
            const parsed = v.safeParse(
              localLogoutResultSchema,
              await send(live, { type: "login.logout.local", onSite }).catch(() => undefined),
            );
            if (!parsed.success) return "none";
            return parsed.output.ok ? parsed.output.target : parsed.output.reason;
          },
          pressLocal: async (live, target) => {
            let answer: unknown;
            try {
              answer = await send(live, {
                type: "login.logout.click",
                target,
                purpose: "logout",
                timeoutMs: SWITCH_CHECK_MS,
                watchMs: LOGOUT_REACTION_MS,
              });
            } catch {
              // The page went while it was pressed or watched: the press led there.
              return { press: "clicked", reacted: "navigated" };
            }
            const parsed = v.safeParse(logoutClickResultSchema, answer);
            if (!parsed.success) return { press: "missing" };
            if (parsed.output.ok)
              return { press: "clicked", reacted: parsed.output.reacted ?? "none" };
            const { reason } = parsed.output;
            return {
              press:
                reason === "ambiguous" || reason === "missing" || reason === "unsafe"
                  ? reason
                  : "page-changed",
            };
          },
          settle: (live) => settleSwitch(tab, site, live),
        },
        {
          recipes: (recipeOrigin) => logout.recipes(recipeOrigin),
          generate: async (logoutRequest) => {
            const spin = spinning(tab.id);
            spin.sent(() => undefined)();
            try {
              return await logout.generate(logoutRequest);
            } finally {
              spin.stop();
            }
          },
        },
        (purpose, learned, source) =>
          report(started.document, {
            type: "switch",
            tabId: tab.id,
            origin: started.document.origin,
            stage: "click",
            purpose,
            source,
            ...(learned ? { learned: true as const } : {}),
          }),
      );
    } catch {
      run = { outcome: "failed", reason: "page-unreadable", detail: "exception", clicks: 0 };
    }
    report(top()?.document ?? started.document, {
      type: "switch",
      tabId: tab.id,
      origin: started.document.origin,
      stage: "end",
      outcome: run.outcome,
      ...(run.outcome === "failed" ? { reason: run.reason } : {}),
      ...(run.outcome === "failed" && run.detail ? { detail: logCode(run.detail) } : {}),
      clicks: run.clicks,
      ...(run.recipe ? { recipeId: run.recipe.id, recipeRevision: run.recipe.revision } : {}),
      ...(run.learned ? { learned: true as const } : {}),
    });
    if (run.outcome === "failed") {
      switchStates.set(tab.id, {
        state: "failed",
        reason: run.reason,
        connectionId: request.connectionId,
        itemId: request.itemId,
      });
      await accountPicks.endSwitch(tab.id).catch(() => undefined);
      return;
    }
    // The login the switch's pick started may already have taken it over.
    if (switchStates.get(tab.id)?.state === "running")
      switchStates.set(tab.id, {
        state: "signed-out",
        connectionId: request.connectionId,
        itemId: request.itemId,
      });
    // Signed out, the pick waits for the login page also past a worker restart.
    await accountPicks.signedOut(tab.id).catch(() => undefined);
    // The signed-out account's records no longer hold the tab: its next login page logs in
    // as a new one, and a page without a login form may press the site's sign-in entry.
    for (const [key, entry] of persisted)
      if (before.has(entry.id) && entry.document.tabId === tab.id) {
        if (attempts.get(tab.id)?.metadata.id === entry.id) attempts.delete(tab.id);
        if (picked.get(tab.id)?.attemptId === entry.id) {
          picked.delete(tab.id);
          void quietly(saveSession);
        }
        await forget(key).catch(() => undefined);
      }
    const page = top();
    if (page)
      await browser.tabs
        .sendMessage(
          tab.id,
          { version: 1, type: "login.reconnect" },
          { frameId: 0, documentId: page.document.documentId },
        )
        .catch(() => undefined);
  }
  /**
   * Waits for the tab's page after a switch's click to settle (ADR 0063): a new top
   * document of the site once it announced, or the same one after a short quiet time, as
   * when a menu opened. Then reads whether it shows a sign-in input or a recipe's first
   * step. Nothing once the tab left the site or closed.
   */
  async function settleSwitch(
    tab: { readonly id: number },
    site: string,
    before: LiveDocument,
  ): Promise<{ page: LiveDocument; signIn: boolean } | undefined> {
    const since = Date.now();
    let page: LiveDocument | undefined;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, SWITCH_POLL_MS));
      // eslint-disable-next-line no-await-in-loop
      const shown = await browser.tabs.get(tab.id).catch(() => undefined);
      if (shown?.url === undefined) return undefined;
      const over = Date.now() - since >= SWITCH_SETTLE_MS;
      const live = documents.get(frameKey({ tabId: tab.id, frameId: 0 }));
      // The tab may pass through another site, as an identity provider's logout does, and
      // a page still loading may yet be replaced.
      if (siteOf(shown.url) !== site || shown.status === "loading") {
        if (over) return undefined;
        continue;
      }
      // A new document, or the same one announcing again, as after a URL change in place.
      if (live && live !== before && siteOf(live.document.origin) === site) {
        page = live;
        break;
      }
      // The same document after a quiet time: a menu or dialog opened in place.
      if (live === before && Date.now() - since >= SWITCH_QUIET_MS) {
        page = live;
        break;
      }
      if (over) return undefined;
    }
    if (!page) return undefined;
    const starts = await startsFor(page.document.origin).catch(() => []);
    const checked = v.safeParse(
      entryCheckResultSchema,
      await send(page, { type: "login.entry.check", starts, timeoutMs: SWITCH_CHECK_MS }).catch(
        () => undefined,
      ),
    );
    return { page, signIn: checked.success && (checked.output.signIn || checked.output.start) };
  }
  /**
   * Adds time a login waited for the service to its attempt (ADR 0019): to the run that
   * holds it now, which may be a later document's, and to its stored record, both written
   * with the attempt's next change.
   */
  function spend(attemptId: string, waitedMs: number, timing: ServiceTiming | undefined): void {
    const add = { serviceMs: waitedMs, networkMs: timing?.networkMs ?? 0 };
    for (const run of attempts.values())
      if (run.metadata.id === attemptId) run.metadata = addAttemptTime(run.metadata, add);
    for (const [key, record] of persisted)
      if (record.id === attemptId) persisted.set(key, addAttemptTime(record, add));
  }
  /**
   * The time a new login took before it started (ADR 0019): since its page was seen, or the
   * sign-in entry pressed just before it was, with the service time spent on them, the
   * person's time picking its account in the popup and, after a press, the wait for the site
   * from the press until its page was seen. An entry press's time is taken once.
   */
  function startTiming(
    live: LiveDocument,
    chosen: { connectionId: string; itemId: string },
  ): StartTiming & { pageMs: number } {
    const { tabId, documentId, frameId } = live.document;
    const timing = { ...live.timing, pageMs: 0 };
    const press = entryPresses.get(tabId);
    const pressedAt = press && isoTimeMs(press.pressedAt);
    if (
      press?.timing &&
      pressedAt !== undefined &&
      frameId === 0 &&
      !(press.documentId === documentId && press.url === live.url) &&
      timing.since >= pressedAt &&
      timing.since - pressedAt <= ENTRY_NEXT_PAGE_MS + LOGIN_STEP_WAIT_MS
    ) {
      timing.pageMs = timing.since - pressedAt;
      timing.since = Math.min(timing.since, press.timing.since);
      timing.serviceMs += press.timing.serviceMs;
      timing.networkMs += press.timing.networkMs;
      timing.personMs += press.timing.personMs;
      const { timing: _taken, ...spent } = press;
      entryPresses.set(tabId, spent);
      void quietly(saveSession);
    }
    const pick = picked.get(tabId);
    if (
      pick?.attemptId === undefined &&
      pick?.documentId === documentId &&
      pick.connectionId === chosen.connectionId &&
      pick.itemId === chosen.itemId
    )
      timing.personMs += pick.waitedMs;
    // The document's time so far is this login's; another login it starts later counts
    // from now (ADR 0019).
    Object.assign(live.timing, { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 });
    return timing;
  }
  /** Adds time spent on a document's login before it started, such as its generation. */
  function spendBefore(live: LiveDocument, waitedMs: number, timing: ServiceTiming | undefined) {
    live.timing.serviceMs += Math.max(0, Math.round(waitedMs));
    live.timing.networkMs += timing?.networkMs ?? 0;
  }
  function current(run: Execution): boolean {
    return (
      attempts.get(run.live.document.tabId) === run &&
      documents.get(frameKey(run.live.document)) === run.live
    );
  }
  /**
   * Whether a policy write now would stop this attempt while it can still make progress. A
   * login whose result settled as unknown, or that is watched, counts only while this
   * worker checks or judges one of its pages: such a record stays for a while, and counting
   * it would hold policy writes for as long (ADR 0027).
   */
  function inProgress(run: Execution): boolean {
    return current(run) && !terminal(run.metadata) && (run.running || !idle(run.metadata));
  }
  async function save(run: Execution): Promise<void> {
    await keep(run.metadata);
  }
  /** Stores a record; `progress` false keeps its time, as for a watch that ran out. */
  async function keep(metadata: LoginAttemptMetadata, progressed = true): Promise<void> {
    const key = recordKey(metadata.document.tabId, metadata.account.origin);
    const previous = persisted.get(key);
    const next = parseAttemptMetadata({ ...metadata, changedAt: undefined });
    // Only the login's own progress counts as a change. A new page of its tab (another
    // `documentId`), a page sent to be judged, newer settings a watch took over or the
    // login's own times keep the time, so a tab left browsing the site after a login that
    // did not succeed stops holding it.
    const progress = (record: LoginAttemptMetadata) =>
      JSON.stringify({
        ...record,
        document: { ...record.document, documentId: undefined },
        judged: undefined,
        watch: undefined,
        policyRevision: undefined,
        changedAt: undefined,
        timing: undefined,
      });
    const unchanged =
      previous?.changedAt !== undefined && (!progressed || progress(previous) === progress(next));
    // Re-inserted, so the last record of a tab is the one it wrote last.
    persisted.delete(key);
    persisted.set(key, { ...next, changedAt: unchanged ? previous.changedAt : Date.now() });
    await write();
  }
  /** Releases one tab's record for one origin, as after a logout (ADR 0062). */
  async function forget(key: string): Promise<void> {
    persisted.delete(key);
    await write();
  }
  /** Throws `storage-failed`, a Pateat error code the log keeps (ADR 0019). */
  async function write(): Promise<void> {
    const snapshot = [...persisted.values()];
    storageQueue = storageQueue.then(async () => {
      if (!storageHealthy) throw new Error("storage-failed");
      await attemptRecords.write(snapshot);
      return undefined;
    });
    try {
      await storageQueue;
    } catch {
      storageHealthy = false;
      throw new Error("storage-failed");
    }
  }
  /** A login just signed in, confirmed: what `noteSignedIn` tells (ADR 0007, ADR 0062). */
  const signedInNow = (previous: LoginAttemptMetadata, next: LoginAttemptMetadata) =>
    next.state === "authenticated" && !next.unconfirmed && previous.state !== "authenticated";
  /**
   * Tells `options.signedIn` of an attempt that has just reached signed in: its origin, the
   * top page's origin for a frame's login, and the page it ended on.
   */
  const noteSignedIn = (
    previous: LoginAttemptMetadata,
    next: LoginAttemptMetadata,
    pageOrigin?: string,
  ) => {
    // A login confirmed signed in keeps its account for the site's session (ADR 0063).
    if (
      next.state === "authenticated" &&
      !next.unconfirmed &&
      !(previous.state === "authenticated" && !previous.unconfirmed)
    )
      void keepPick(next);
    if (!signedInNow(previous, next)) return;
    const origins = new Set(
      [next.account.origin, next.pageOrigin, pageOrigin].filter(
        (value): value is string => value !== undefined,
      ),
    );
    for (const signedOrigin of origins)
      try {
        options.signedIn?.(next.document.tabId, signedOrigin);
      } catch {
        // Never changes the login.
      }
  };
  /**
   * Keeps the account a popup pick or an account switch signed in with as the site's pick
   * for the browser session, unless it was made the default, which drops the session's
   * pick instead (ADR 0063).
   */
  async function keepPick(signedIn: LoginAttemptMetadata): Promise<void> {
    const { tabId } = signedIn.document;
    const pick = picked.get(tabId);
    const site = siteOf(signedIn.account.origin);
    const live =
      documents.get(frameKey(signedIn.document)) ?? documents.get(frameKey({ tabId, frameId: 0 }));
    if (!pick || pick.attemptId !== signedIn.id || site === undefined || !live) return;
    if (pick.makeDefault) {
      await accountPicks.stopAsking(site, live.incognito === true).catch(() => undefined);
      return;
    }
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return;
    // Picking the saved default itself chose nothing else: the site goes on as before.
    const saved = snapshot.snapshot.settings.siteDefaults.find(
      (entry) => entry.origin === signedIn.account.origin,
    );
    const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
    if (saved?.itemId === pick.itemId && mapped?.ok && mapped.connectionId === pick.connectionId) {
      await accountPicks.stopAsking(site, live.incognito === true).catch(() => undefined);
      return;
    }
    await accountPicks
      .askEveryTime({
        site,
        incognito: live.incognito === true,
        defaults: siteDefaultsMark(snapshot.snapshot.settings.siteDefaults, site, siteOf),
      })
      .catch(() => undefined);
  }
  async function change(
    run: Execution,
    event: LoginAttemptEvent,
    policy?: PolicyChange,
    stop?: StopCause,
    routeChange?: RouteChange,
    /** Why the login stopped where it did, for the log: `password-empty` (ADR 0036). */
    reason?: string,
  ): Promise<void> {
    if (!current(run)) return;
    // A stop before the page received the prepared operation takes its effect back, so the
    // record does not hold the origin as if a submission were in flight (ADR 0022).
    const undelivered =
      event.type === "POLICY_CHANGED" &&
      run.operation &&
      !run.delivered &&
      run.operation.operationId === run.metadata.operationId
        ? run.operation.operationId
        : undefined;
    const previous = run.metadata;
    run.metadata = transitionLoginAttempt(
      run.metadata,
      undelivered ? { type: "POLICY_CHANGED", undelivered } : event,
    );
    noteSignedIn(
      previous,
      run.metadata,
      run.live.document.frameId === 0 ? run.live.document.origin : undefined,
    );
    countRelogin(previous, run.metadata, run.live.incognito === true);
    if (signedInNow(previous, run.metadata)) void endPickedPause(run.metadata, run.live);
    // Settling as unknown keeps the state, but it is how a login ends without a result.
    const settled = run.metadata.settled === true && previous.settled !== true ? true : undefined;
    // An ended login no longer waits for a continuation it asked for (ADR 0018).
    if (terminal(run.metadata) || idle(run.metadata)) continuations.delete(run.metadata.id);
    // The layout it ran before, when the login just switched layouts (ADR 0060).
    const layoutFrom = run.metadata.layout !== previous.layout ? previous.layout : undefined;
    if (
      run.metadata.state !== previous.state ||
      settled ||
      (routeChange && run.metadata.route !== previous.route) ||
      layoutFrom !== undefined
    )
      // The log still names the step that was withdrawn.
      reportAttempt(
        undelivered
          ? {
              ...run.metadata,
              operationKind: previous.operationKind,
              operationEffect: previous.operationEffect,
            }
          : run.metadata,
        run.recipe,
        policy,
        {
          ...(settled ? { settled } : {}),
          ...(stop ? { stop } : {}),
          ...(reason ? { reason } : {}),
          ...(routeChange && run.metadata.route !== previous.route ? { routeChange } : {}),
          ...(layoutFrom === undefined ? {} : { layoutFrom }),
        },
      );
    if (
      import.meta.env.MODE === "probe" &&
      armed === "intent-write-failure" &&
      (event.type === "MUTATION_INTENT" || event.type === "SUBMIT_INTENT")
    ) {
      armed = undefined;
      clearTimeout(armTimer);
      storageHealthy = false;
      throw new Error("Synthetic intent write failed");
    }
    await save(run);
    await publish(run.live, run.metadata);
    // A conditional request of the page waits for how this login ends (ADR 0034).
    if (terminal(run.metadata) || idle(run.metadata)) reviewRequests();
    if (run.metadata.state === "authenticated" && !run.metadata.unconfirmed && run.choice)
      await remember(run);
    // Links filled from the popup are saved once the login is confirmed, and links whose
    // value the site rejected are removed (ADR 0061).
    if (run.metadata.state === "authenticated" && !run.metadata.unconfirmed)
      await settleDetails(run, true);
    else if (
      run.metadata.outcome === "credential-rejected" &&
      previous.outcome !== "credential-rejected"
    ) {
      await settleDetails(run, false);
      await forgetDetail(run);
    }
    // Refused links that another login kept from being removed are removed once one ends.
    if (refusedDetails.size && terminal(run.metadata) && !terminal(previous))
      await removeRefused(run).catch(() => undefined);
  }
  /**
   * Ends a fill-only login before its first step with an effect and forgets its record, so
   * it neither holds the site nor counts as a login of the tab. The document announces again
   * on this status and asks for an account, as before the fill (ADR 0021 D).
   */
  async function endFillOnly(run: Execution): Promise<void> {
    if (!current(run)) return;
    if (!terminal(run.metadata)) {
      run.metadata = transitionLoginAttempt(run.metadata, { type: "CANCEL" });
      reportAttempt(run.metadata, run.recipe);
    }
    const { document } = run.live;
    const key = recordKey(document.tabId, run.metadata.account.origin);
    attempts.delete(document.tabId);
    await forget(key).catch(() => undefined);
    // The page then waits for a pick; its own announcement after this status carries no
    // start, so the choice is offered and the asking logged here.
    if (run.asked?.candidates.length) {
      const ask = askFor(document.tabId, document.origin) ?? run.asked.ask;
      offerChoice(document, run.asked.candidates, ask);
      run.live.state = "denied";
      run.live.reason = "account-asked";
      report(document, {
        type: "refused",
        tabId: document.tabId,
        origin: document.origin,
        reason: "account-asked",
        detail: ask,
        candidates: run.asked.candidates.length,
        ...(document.frameId === 0 ? {} : { frame: true as const }),
      });
    }
    await publish(run.live, run.metadata);
  }
  /**
   * The times automatic logins of `site` ended `authenticated` that still count at `now`
   * (ADR 0062); a clock set back drops them rather than keeping them longer.
   */
  function reloginTimes(site: string, incognito: boolean, now: number): number[] {
    return (relogins.get(reloginKey(site, incognito))?.at ?? []).filter(
      (at) => now - at >= 0 && now - at < RELOGIN_WINDOW_MS,
    );
  }
  /**
   * Whether a new automatic login of the origin would be one too many: two of its site
   * ended `authenticated` within the last 10 minutes, in any tab of the same normal or
   * incognito session (ADR 0062).
   */
  function reloginLimited(siteOrigin: string, incognito: boolean): boolean {
    const site = siteOf(siteOrigin);
    return site !== undefined && reloginTimes(site, incognito, Date.now()).length >= RELOGIN_LIMIT;
  }
  /**
   * Forgets the re-logins of each site none of whose tabs is open any more in its normal or
   * incognito session, and those past the window (ADR 0062). Returns whether any went.
   */
  async function forgetClosedSites(): Promise<boolean> {
    const open = await browser.tabs.query({}).catch(() => undefined);
    if (!open) return false;
    const shown = new Set(
      open.flatMap((tab) => {
        const site = tab.url ? siteOf(tab.url) : undefined;
        return site === undefined ? [] : [reloginKey(site, tab.incognito === true)];
      }),
    );
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of relogins)
      if (!shown.has(key) || !reloginTimes(entry.site, entry.incognito, now).length) {
        relogins.delete(key);
        changed = true;
      }
    return changed;
  }
  /**
   * Counts a login that just ended `authenticated`, an undecided completion (ADR 0029)
   * included, for its registrable site (ADR 0062). A login a popup pick started is the
   * person's own and is not counted.
   */
  function countRelogin(
    previous: LoginAttemptMetadata,
    next: LoginAttemptMetadata,
    incognito: boolean,
  ): void {
    if (next.state !== "authenticated" || previous.state === "authenticated") return;
    if (picked.get(next.document.tabId)?.attemptId === next.id) return;
    countSignIn(next.account.origin, incognito);
  }
  /**
   * Counts a sign-in Pateat made by itself on the origin's registrable site towards the
   * relogin guard (ADR 0062): a login that ended `authenticated`, or a passkey request the
   * page started without user activation that it answered with no login and no choice, as
   * a login page that asks on load after each logout.
   */
  function countSignIn(siteOrigin: string, incognito: boolean): void {
    const site = siteOf(siteOrigin);
    if (site === undefined) return;
    const now = Date.now();
    const key = reloginKey(site, incognito);
    const at = [...reloginTimes(site, incognito, now), now].slice(-RELOGIN_LIMIT);
    // The most recently counted site is kept last, so the cap drops the oldest first.
    relogins.delete(key);
    relogins.set(key, { site, incognito, at });
    for (const oldest of relogins.keys()) {
      if (relogins.size <= 256) break;
      relogins.delete(oldest);
    }
    void quietly(saveSession);
  }
  async function withdrawSwitch(run: Execution): Promise<void> {
    const tabId = run.live.document.tabId;
    if (
      attempts.get(tabId) !== run ||
      persisted.get(recordKey(tabId, run.metadata.account.origin))?.id !== run.metadata.id
    )
      return;
    run.metadata = withdrawAccountSwitch(run.metadata);
    await save(run);
    await publish(run.live, run.metadata);
  }
  /**
   * Saves an automatic account choice after confirmed `authenticated` (ADR 0013). The settings must
   * still be the revision the attempt was authorized under, or the newer one a watch took
   * over after checking its account; otherwise nothing is saved and the next login chooses
   * again.
   */
  async function remember(run: Execution): Promise<void> {
    const choice = run.choice;
    delete run.choice;
    const { account: used } = run.metadata;
    if (!choice || !settings.update) return;
    const outcome = (value: Extract<LoginReport, { type: "choice" }>["outcome"]) =>
      report(run.metadata.document, {
        type: "choice",
        tabId: run.metadata.document.tabId,
        origin: run.metadata.document.origin,
        outcome: value,
      });
    // Only the account this attempt authenticated with may be saved.
    if (
      choice.connectionId !== used.connectionId ||
      choice.binding.itemId !== used.itemId ||
      choice.binding.origin !== used.origin
    ) {
      outcome("account-changed");
      return;
    }
    // Saving bumps the revision every attempt checks; never stop another login with it. A
    // login between pages has no current run, as while its next page is admitted or after
    // a worker restart, so its stored record counts too, as `active` counts it, but only
    // while it changed within the settings sync's two-minute cap: an older one is likely
    // left over, and saving may stop it `policy-changed` (owner, 2026-10-24).
    const now = Date.now();
    if (
      attempts.values().some((other) => other !== run && inProgress(other)) ||
      persisted.values().some((other) => {
        const age = now - (other.changedAt ?? Number.NEGATIVE_INFINITY);
        return (
          other.id !== run.metadata.id &&
          !terminal(other) &&
          !idle(other) &&
          // A clock set back ends the wait rather than prolonging it.
          age >= 0 &&
          age < MAX_SETTINGS_DEFER_MS
        );
      })
    ) {
      outcome("login-in-progress");
      return;
    }
    // A login another tab is admitting waits for this save, which the checks above may not
    // see yet: it has no run or record before its first step (see `admit`).
    const { promise: saving, resolve: finish } = Promise.withResolvers<void>();
    savingChoices.add(saving);
    let writing = false;
    try {
      // Writing bumps the policy revision for every attempt, so skip a choice already saved.
      const latest = await settings
        .handle({ version: 1, type: "settings.get" })
        .catch((error: unknown) => {
          outcome("settings-unavailable");
          throw error;
        });
      if (!latest.ok) {
        outcome("settings-unavailable");
        return;
      }
      if (withChoice(latest.snapshot.settings, choice) === latest.snapshot.settings) {
        outcome("already-saved");
        return;
      }
      writing = true;
      const written = await settings
        .update(run.metadata.policyRevision, "account-choice", (snapshot) => ({
          ...snapshot,
          settings: withChoice(snapshot.settings, choice),
        }))
        .then(
          () => "saved" as const,
          () => "write-failed" as const,
        );
      outcome(written);
      // The saved default ends another tab's choice of the same origin (ADR 0034).
      if (written === "saved") void choiceDefaults();
    } finally {
      if (writing) remembered += 1;
      savingChoices.delete(saving);
      finish();
    }
  }
  async function send(live: LiveDocument, message: Record<string, unknown>): Promise<unknown> {
    try {
      return await browser.tabs.sendMessage(
        live.document.tabId,
        { version: 1, token: live.token, ...message },
        { documentId: live.document.documentId, frameId: live.document.frameId },
      );
    } catch (error) {
      // The browser rejects when no listener in the document answered: the document has no
      // receiver anymore, or it unloaded before its answer.
      throw new DocumentGone(error);
    }
  }
  async function publish(live: LiveDocument, metadata?: LoginAttemptMetadata): Promise<void> {
    if (documents.get(frameKey(live.document)) !== live) return;
    await send(live, {
      type: "login.status",
      state: metadata?.state ?? live.state ?? "denied",
      stepIndex: metadata?.stepIndex ?? 0,
      ...(metadata?.outcome || live.reason ? { outcome: metadata?.outcome ?? live.reason } : {}),
    }).catch(() => undefined);
  }
  /**
   * Every eligible provider URI match for the document across all enabled connections;
   * in a frame, only items that also match the tab's URL (ADR 0017). Any connection or
   * item that could not be evaluated refuses rather than listing part of them.
   */
  async function siteCandidates(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
  ) {
    const find = (url: string) =>
      findLiveSiteCandidates({
        settings: snapshot.snapshot.settings,
        catalog: snapshot.catalog,
        url,
        match: uris!,
      });
    const scope = await find(live.url);
    if (!scope.ok) return { reason: scope.reason };
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
    if (!live.topUrl) return { candidates: scope.candidates };
    const top = await find(live.topUrl);
    if (!top.ok) return { reason: top.reason };
    if (top.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (top.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
    return {
      candidates: scope.candidates.filter((entry) =>
        top.candidates.some(
          (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
        ),
      ),
    };
  }
  type Choice = {
    connectionId: string;
    itemId: string;
    saved: boolean;
    /**
     * How the account was chosen: the saved site default, the only provider URI match
     * (ADR 0013) or a pick in the popup; with how many candidates there were.
     */
    source: AccountSource;
    candidates?: number;
    pick?: PickedAccount;
    /** While the tab asks: fill the page without any step with an effect (ADR 0021 D). */
    fillOnly?: true;
    /** With `fillOnly`: the accounts the tab offers once the fill ends. */
    asked?: PendingChoice["candidates"];
  };
  /** `noUriMatch` marks a refusal because no vault item matches the page, or the saved
   * default's item no longer does, which a vault sync may change; it is logged as the
   * refusal's `no-uri-match` detail and never answered to the page. */
  type Refusal = {
    reason: string;
    candidates?: PendingChoice["candidates"];
    /** The tab asks for an account, with `candidates` (ADR 0021 D, ADR 0062). */
    ask?: true;
    /** Automatic login of the site is paused; the candidates are offered (ADR 0062). */
    paused?: true;
    noUriMatch?: true;
  };
  /**
   * The accounts a paused page offers in the popup (ADR 0062): the saved default when its
   * connection is there, then every item that matches the page, at most 100. Matches that
   * could not be listed leave the saved default alone.
   */
  async function pausedCandidates(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    saved: LocalSettings["siteDefaults"][number] | undefined,
  ): Promise<PendingChoice["candidates"]> {
    const listed: PendingChoice["candidates"] = [];
    const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
    if (saved && mapped?.ok)
      listed.push({ connectionId: mapped.connectionId, itemId: saved.itemId });
    const found = uris ? await siteCandidates(snapshot, live) : undefined;
    for (const entry of found && !("reason" in found) ? found.candidates : [])
      if (
        !listed.some(
          (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
        )
      )
        listed.push({ connectionId: entry.connectionId, itemId: entry.itemId });
    return listed.slice(0, 100);
  }
  /**
   * The account for this document. A saved site default wins. Without one, a single
   * eligible provider URI match across all enabled connections is used for this attempt
   * only (ADR 0013); none, several, or any connection or item that could not be evaluated
   * refuses rather than guessing. While the tab asks (`asking`, the refusal's reason), only
   * a pick logs in; with `fill`, the one account to use fills the page without pressing
   * anything (ADR 0021 D).
   */
  async function choose(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    asking?: "account-asked" | "relogin-limit",
    paused = false,
    fill = false,
    /** The recipe's inputs for the `username` slot on the document's path. */
    accountTargets: readonly LoginFieldTarget[] = [],
  ): Promise<Choice | Refusal> {
    await sessionLoaded;
    // An account switch's pick (ADR 0063) wins for the tab's next login page of its site,
    // over an older pick, a logout's asking and the saved default: it becomes the pick of
    // this document, and of the login it starts, which ends the switch's pick.
    const switching = await accountPicks.switchFor(
      live.document.tabId,
      siteOf(live.document.origin),
      live.incognito === true,
    );
    if (switching) {
      const held = picked.get(live.document.tabId);
      const pick =
        held?.attemptId === undefined &&
        held?.documentId === live.document.documentId &&
        held.origin === live.document.origin &&
        held.connectionId === switching.connectionId &&
        held.itemId === switching.itemId
          ? held
          : {
              tabId: live.document.tabId,
              origin: live.document.origin,
              documentId: live.document.documentId,
              connectionId: switching.connectionId,
              itemId: switching.itemId,
              makeDefault: switching.makeDefault,
              waitedMs: 0,
            };
      if (pick !== held) {
        picked.set(live.document.tabId, pick);
        void quietly(saveSession);
      }
      return {
        connectionId: pick.connectionId,
        itemId: pick.itemId,
        saved: false,
        source: "switch",
        pick,
      };
    }
    // An account picked in the popup wins for the document it restarted and the attempt that
    // document started; its item must still match the page and pass every check below.
    let pick = picked.get(live.document.tabId);
    // The page's own account input is honoured only where an automatic login would choose
    // among several matches: never on a paused site or a tab that asks (ADR 0062), where
    // only the person's pick logs in.
    if (pick?.site && pick.attemptId === undefined && (paused || asking)) {
      picked.delete(live.document.tabId);
      void quietly(saveSession);
      pick = undefined;
    }
    const owner = recordFor(live.document.tabId, live.document.origin);
    if (
      pick?.origin === live.document.origin &&
      (pick.attemptId === undefined
        ? pick.documentId === live.document.documentId
        : owner?.id === pick.attemptId)
    )
      return {
        connectionId: pick.connectionId,
        itemId: pick.itemId,
        saved: false,
        source: pick.site ? "site-value" : "pick",
        pick,
      };
    const saved = snapshot.snapshot.settings.siteDefaults.find(
      (entry) => entry.origin === live.document.origin,
    );
    if (paused) {
      // A paused site logs in only with an account picked in the popup, which lists any
      // matching account, the saved default first (ADR 0062).
      const listed = await pausedCandidates(snapshot, live, saved);
      return { reason: "paused", paused: true, ...(listed.length ? { candidates: listed } : {}) };
    }
    if (asking) {
      // The tab asks, with the saved default first (ADR 0021 D).
      const listed: PendingChoice["candidates"] = [];
      const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
      if (saved && mapped?.ok)
        listed.push({ connectionId: mapped.connectionId, itemId: saved.itemId });
      if (uris) {
        const found = await siteCandidates(snapshot, live);
        // Without the matches, the saved default alone is still offered.
        if ("reason" in found && !listed.length) return { reason: found.reason };
        for (const entry of "reason" in found ? [] : found.candidates)
          if (
            !listed.some(
              (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
            )
          )
            listed.push({ connectionId: entry.connectionId, itemId: entry.itemId });
      }
      if (!listed.length) return { reason: saved ? "default-unavailable" : "default-not-set" };
      // With one account to use, the saved default or the only match, the page is filled
      // without any click or submitting fill; the tab still asks (ADR 0021 D). A saved
      // default that cannot be used fills nothing, as it would refuse a login.
      const only = saved
        ? mapped?.ok
          ? listed[0]
          : undefined
        : listed.length === 1
          ? listed[0]
          : undefined;
      if (fill && only)
        return {
          ...only,
          saved: Boolean(saved),
          source: saved ? "default" : "match",
          candidates: listed.length,
          fillOnly: true,
          asked: listed.slice(0, 100),
        };
      return { reason: asking, candidates: listed.slice(0, 100), ask: true };
    }
    if (saved) {
      const connection = siteDefaultConnection(saved, snapshot.catalog);
      return connection.ok
        ? {
            connectionId: connection.connectionId,
            itemId: saved.itemId,
            saved: true,
            source: "default",
          }
        : { reason: connection.reason };
    }
    if (!uris) return { reason: "default-not-set" };
    // Any sync replaces a snapshot ID, so a new match from a later sync is still noticed.
    const snapshots = JSON.stringify(
      snapshot.catalog.connections.map((entry) => [entry.id, entry.snapshotId, entry.state]),
    );
    const cached = live.autoChoice;
    if (cached?.snapshots === snapshots)
      return {
        connectionId: cached.connectionId,
        itemId: cached.itemId,
        saved: false,
        source: "match",
        candidates: 1,
      };
    delete live.autoChoice;
    const found = await siteCandidates(snapshot, live);
    if ("reason" in found) return { reason: found.reason };
    const { candidates } = found;
    if (candidates.length > 1) {
      // The account the page itself put into the recipe's account input picks one of them,
      // for this document and the login it starts only, and is never saved (ADR 0028
      // amendment of 2026-10-23). It is kept as a pick, which the login's later pages use.
      const shown =
        accountTargets.length > 0 && !live.siteAsked
          ? await siteAccount(snapshot, live, candidates, accountTargets)
          : undefined;
      if (shown) {
        const site: PickedAccount = {
          tabId: live.document.tabId,
          origin: live.document.origin,
          documentId: live.document.documentId,
          connectionId: shown.connectionId,
          itemId: shown.itemId,
          makeDefault: false,
          waitedMs: 0,
          site: true,
        };
        // A running login's pick in the tab stays; this choice then covers this document.
        if (picked.get(live.document.tabId)?.attemptId === undefined) {
          picked.set(live.document.tabId, site);
          await quietly(saveSession);
        }
        return {
          connectionId: shown.connectionId,
          itemId: shown.itemId,
          saved: false,
          source: "site-value",
          candidates: candidates.length,
          pick: site,
        };
      }
    }
    if (candidates.length > 1)
      return {
        reason: "account-ambiguous",
        candidates: candidates.map((entry) => ({
          connectionId: entry.connectionId,
          itemId: entry.itemId,
        })),
      };
    const [only] = candidates;
    if (!only) return { reason: "default-not-set", noUriMatch: true };
    // The same answer covers the item origin check below; no second query is needed.
    live.uriMatch = {
      connectionId: only.connectionId,
      itemId: only.itemId,
      snapshotId: only.snapshotId,
    };
    live.autoChoice = { snapshots, connectionId: only.connectionId, itemId: only.itemId };
    return {
      connectionId: only.connectionId,
      itemId: only.itemId,
      saved: false,
      source: "match",
      candidates: candidates.length,
    };
  }
  /**
   * The one candidate whose username equals the value the page itself set in one of
   * `targets` before anyone typed, as the document's content script compares them (ADR
   * 0028 amendment of 2026-10-23). The usernames are read one at a time, only for this
   * comparison, and never kept, logged or sent; a username that cannot be read, or one
   * the person excluded, compares nothing.
   */
  async function siteAccount(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    candidates: readonly LiveSiteCandidate[],
    targets: readonly LoginFieldTarget[],
  ): Promise<LiveSiteCandidate | undefined> {
    if (candidates.length > 32) return undefined;
    const settingsValue = snapshot.snapshot.settings;
    const usernames: string[] = [];
    try {
      for (const candidate of candidates) {
        const connection = snapshot.catalog.connections.find(
          (entry) => entry.id === candidate.connectionId,
        );
        if (!connection) return undefined;
        const fieldId = loginUsernameFieldId(connection, candidate.itemId);
        if (!fieldId) {
          usernames.push("");
          continue;
        }
        if (
          isFieldExcluded(settingsValue, snapshot.catalog, connection.id, candidate.itemId, fieldId)
        )
          return undefined;
        // Serial reads through the shared vault host, as for a fill.
        // eslint-disable-next-line no-await-in-loop
        const value = await fields({
          account: {
            origin: live.document.origin,
            connectionId: connection.id,
            itemId: candidate.itemId,
          },
          connection,
          fieldId,
        }).catch(() => undefined);
        if (value === undefined) return undefined;
        usernames.push(value);
      }
      const parsed = v.safeParse(
        siteAccountResultSchema,
        await send(live, {
          type: "login.site.account",
          path: live.path,
          targets: targets.slice(0, 8),
          usernames,
        }).catch(() => undefined),
      );
      if (!parsed.success) return undefined;
      // The document compared its value and answers no more (ADR 0028 amendment of
      // 2026-10-23), so it is not asked again.
      if (!parsed.output.ok) {
        if (parsed.output.spent) live.siteAsked = true;
        return undefined;
      }
      live.siteAsked = true;
      return candidates[parsed.output.index];
    } finally {
      usernames.fill("");
    }
  }
  /**
   * Origin scope for the chosen account of this document. A live provider URI match for
   * the document's own URL satisfies the item origin check for that document only; it is
   * never saved as `allowedOrigins`. Only the chosen account's connection is asked, and a
   * match is reused while that connection's snapshot is unchanged.
   */
  async function liveScope(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    selected: { connectionId: string; itemId: string },
  ): Promise<
    | { catalog: VaultCatalog }
    | { reason: "vault-unavailable" | "item-uri-unevaluated" | "url-too-long" }
  > {
    const { catalog } = snapshot;
    const connection = catalog.connections.find((entry) => entry.id === selected.connectionId);
    const item = connection?.items.find((entry) => entry.id === selected.itemId);
    if (!uris || !connection?.snapshotId || connection.provider !== "bitwarden") return { catalog };
    if (!item || item.allowedOrigins.includes(live.document.origin)) return { catalog };
    // An item awaiting field review is unavailable; do not report it as a URI mismatch.
    if (connection.quarantinedItemIds?.includes(item.id)) return { reason: "vault-unavailable" };
    const cached = live.uriMatch;
    if (
      !cached ||
      cached.connectionId !== selected.connectionId ||
      cached.itemId !== selected.itemId ||
      cached.snapshotId !== connection.snapshotId
    ) {
      delete live.uriMatch;
      const scope = await findLiveSiteCandidates({
        settings: snapshot.snapshot.settings,
        catalog: { ...catalog, connections: [connection] },
        url: live.url,
        match: uris,
      });
      if (!scope.ok)
        return scope.reason === "url-too-long" ? { reason: scope.reason } : { catalog };
      const matched = scope.candidates.some(
        (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
      );
      if (!matched) {
        // Unevaluated rules may still cover this page; never treat them as a mismatch.
        if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
        return scope.incompleteItems.some((entry) => entry.itemId === selected.itemId)
          ? { reason: "item-uri-unevaluated" }
          : { catalog };
      }
      live.uriMatch = {
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        snapshotId: connection.snapshotId,
      };
    }
    return { catalog: withItemOrigin(catalog, selected, live.document.origin) };
  }
  /**
   * Whether the chosen item matches `url`: by its static `allowedOrigins` in `granted`, or
   * by a live provider URI match of the full URL, which needs a Bitwarden connection with a
   * snapshot. `vault-unavailable` and `item-uri-unevaluated` when rules that could match
   * were not evaluated, and the matcher's own reason when it could not run.
   */
  async function itemMatchesUrl(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    selected: { connectionId: string; itemId: string },
    url: string,
    granted: VaultCatalog,
  ): Promise<{ snapshotId?: string } | { reason: string }> {
    const item = granted.connections
      .find((entry) => entry.id === selected.connectionId)
      ?.items.find((entry) => entry.id === selected.itemId);
    if (item?.allowedOrigins.includes(new URL(url).origin)) return {};
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === selected.connectionId,
    );
    if (!uris || !connection?.snapshotId || connection.provider !== "bitwarden")
      return { reason: "mismatch" };
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: { ...snapshot.catalog, connections: [connection] },
      url,
      match: uris,
    });
    if (!scope.ok) return { reason: scope.reason };
    if (
      scope.candidates.some(
        (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
      )
    )
      return { snapshotId: connection.snapshotId };
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.some((entry) => entry.itemId === selected.itemId))
      return { reason: "item-uri-unevaluated" };
    return { reason: "mismatch" };
  }
  /**
   * For a document in a frame inside the page, the chosen item must also match the tab's
   * URL, as the official Bitwarden client requires before it fills a frame (ADR 0017).
   * `granted` is the catalog whose static `allowedOrigins` count; a live provider URI
   * match is reused while that connection's snapshot is unchanged.
   */
  async function topScope(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    selected: { connectionId: string; itemId: string },
    granted: VaultCatalog,
  ): Promise<{ reason: string } | undefined> {
    if (!live.topUrl) return undefined;
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === selected.connectionId,
    );
    const cached = live.topMatch;
    if (
      cached?.connectionId === selected.connectionId &&
      cached.itemId === selected.itemId &&
      cached.snapshotId === connection?.snapshotId
    )
      return undefined;
    delete live.topMatch;
    const matched = await itemMatchesUrl(snapshot, selected, live.topUrl, granted);
    if ("reason" in matched)
      return { reason: matched.reason === "mismatch" ? "frame-top-mismatch" : matched.reason };
    if (matched.snapshotId)
      live.topMatch = {
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        snapshotId: matched.snapshotId,
      };
    return undefined;
  }
  /**
   * Why a step's form may not submit to `destination`, an HTTP(S) URL off the document's
   * origin (ADR 0051): it must be on the document's site, with no credentials in the URL
   * (`cross-site`), through HTTPS
   * unless the document itself is HTTP (`insecure`), at a site Pateat may act on
   * (`no-site-access`, also for an excluded site), and matched by the login's item under
   * its URI match detection (`item-mismatch`). `unchecked` when the settings changed or the
   * item's rules could not be evaluated now.
   */
  async function destinationRefusal(
    run: Execution,
    destination: URL,
  ): Promise<Exclude<DestinationAnswer, { ok: true }>["reason"] | undefined> {
    const page = new URL(run.live.document.origin);
    // HTTPS, or HTTP from an HTTP document (ADR 0050); the content script sends no other.
    if (
      destination.protocol !== "https:" &&
      (destination.protocol !== "http:" || page.protocol !== "http:")
    )
      return "insecure";
    if (destination.username || destination.password || !sameSiteAs(page.origin)(destination))
      return "cross-site";
    const admission = probeDocument(destination)
      ? "admitted"
      : await sites?.admission(destination).catch(() => "settings-unavailable" as const);
    if (admission === "settings-unavailable") return "unchecked";
    if (admission !== "admitted") return "no-site-access";
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok || snapshot.snapshot.revision !== run.metadata.policyRevision)
      return "unchecked";
    const matched = await itemMatchesUrl(
      snapshot,
      run.metadata.account,
      destination.href,
      snapshot.catalog,
    );
    if (!("reason" in matched)) return undefined;
    // A Bitwarden connection without a snapshot is one whose vault is not readable now.
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === run.metadata.account.connectionId,
    );
    const unreadable = connection?.provider === "bitwarden" && !connection.snapshotId;
    return matched.reason === "mismatch" && !unreadable ? "item-mismatch" : "unchecked";
  }
  /**
   * The chosen item's binding for one route's `slots` (ADR 0027): the synced binding, else
   * the automatic one for built-in slots, else one built from a template: another item's
   * saved binding of the recipe, then the slot map of a recipe generated from this device.
   * The synced binding's entries are used as they are, and its entries for other slots are
   * ignored. With `fillGaps`, the slots it holds no entry for are filled as for an item
   * without one (amended 2026-10-19, `fillLoginBinding`), and the widened binding counts as
   * unsaved, so it is saved after `authenticated`; without, such a binding refuses
   * `binding-slots-mismatch`. It is mapped to this device's field IDs by the catalog's raw
   * field names. A binding that would fill a field holding a TOTP key as text, or make the
   * code from a custom field holding none, refuses `totp-field-mismatch`
   * (`totpFieldMismatch`).
   */
  async function bindingFor(
    catalog: VaultCatalog,
    settingsValue: SettingsSnapshot["settings"],
    recipe: LoginRecipe,
    choice: Choice,
    documentOrigin: string,
    slots: readonly string[],
    slotMap: () => Promise<LoginBindingTemplate | undefined>,
    fillGaps: boolean,
  ): Promise<
    | { ok: true; binding: LoginAccountBinding; synced: SavedLoginBinding; saved: boolean }
    | { ok: false; reason: string }
  > {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return { ok: false, reason: "vault-unavailable" };
    const owner = {
      provider: connection.provider,
      server: connection.server,
      userId: connection.userId,
      itemId: item.id,
    };
    const named = { ...owner, itemName: item.label, accountName: connection.label };
    // Names, and the flags that pick the `totp` slot's field (`totpFieldReference`).
    const fieldNames = item.fields.map(({ id, name, empty, totpSeed }) => ({
      id,
      name,
      ...(empty ? { empty } : {}),
      ...(totpSeed ? { totpSeed } : {}),
    }));
    // Sibling bindings were proven by an authenticated login, so they go first.
    const templates = async () => {
      const found: LoginBindingTemplate[] = settingsValue.bindings
        .filter((entry) => entry.recipeId === recipe.id && entry.origin === recipe.origin)
        .map((entry) => entry.slots);
      const generated = await slotMap();
      if (generated) found.push(generated);
      return found;
    };
    const saved = findLoginBinding(settingsValue.bindings, recipe, owner);
    let binding = saved ?? defaultLoginBinding(slots, recipe, named, fieldNames);
    let widened = false;
    if (saved && fillGaps && bindingGaps(saved, slots).length > 0) {
      const filled = fillLoginBinding(saved, slots, await templates(), fieldNames);
      if (!filled.ok) return { ok: false, reason: filled.reason };
      binding = filled.binding;
      widened = filled.widened;
    } else if (!binding) {
      const built = templateLoginBinding(slots, recipe, named, await templates(), fieldNames);
      if (!built.ok) return { ok: false, reason: built.reason };
      binding = built.binding;
    }
    const resolved = resolveBindingFields(binding, slots, fieldNames);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    // A TOTP key is never filled as text and a code is made only from a key, so such a
    // binding is refused before any step runs (ADR 0027, owner 2026-10-23).
    if (
      resolved.slots.some(({ slot, fieldId }) =>
        totpFieldMismatch(
          slot,
          item.fields.find((field) => field.id === fieldId),
        ),
      )
    )
      return { ok: false, reason: "totp-field-mismatch" };
    return {
      ok: true,
      binding: {
        origin: documentOrigin,
        connectionId: connection.id,
        itemId: item.id,
        slots: resolved.slots,
      },
      // A default saved from a stored binding is named after this device's connection
      // too. The stored binding itself is only ever widened, keeping its entries.
      synced: saved ? { ...binding, accountName: connection.label } : binding,
      saved: saved !== undefined && !widened,
    };
  }
  /**
   * The item's facts for a new login (ADR 0027): its password and TOTP fields from the
   * catalog's value-free flags and the account's allowed fields, and its passkeys from one
   * vault search. Read once per login; never sent anywhere. Without `passkeys`, as on a site
   * whose passkey requests go to the browser (ADR 0007), the item holds no passkey here and
   * the vault is not searched.
   */
  async function itemFacts(
    connection: VaultConnectionMetadata,
    owner: { origin: string; connectionId: string; itemId: string; fieldIds: string[] },
    passkeys = true,
  ): Promise<LoginItemFacts> {
    const item = connection.items.find((entry) => entry.id === owner.itemId);
    const fieldFacts = item
      ? loginFieldFacts(item, owner.fieldIds)
      : { password: false, totp: false };
    // The synthetic probe item names its password field `password`; it holds a value.
    if (probeMode && owner.origin === origin && owner.fieldIds.includes("password"))
      fieldFacts.password = true;
    // Its synthetic `totp` field counts as a TOTP secret only when the probe says so.
    if (probeMode && owner.origin === origin && probeTotp && owner.fieldIds.includes("totp"))
      fieldFacts.totp = true;
    if (!passkeys) return { ...fieldFacts, passkey: false, discoverablePasskey: false };
    // The synthetic item's configured passkey stands in for the vault search.
    if (probeMode && owner.origin === origin && probePasskey)
      return {
        ...fieldFacts,
        passkey: true,
        discoverablePasskey: probePasskey === "discoverable",
      };
    const held = await Promise.resolve(
      options.passkeys?.({
        origin: owner.origin,
        connectionId: owner.connectionId,
        itemId: owner.itemId,
      }),
    ).catch(() => undefined);
    return {
      ...fieldFacts,
      passkey: held?.passkey === true,
      discoverablePasskey: held?.passkey === true && held.discoverable,
    };
  }
  /** Reasons a password variant does not fit the item; any other refusal stops the plan. */
  const variantRefusals = new Set([
    "binding-not-found",
    "binding-slots-mismatch",
    "binding-field-excluded",
    "field-missing",
    "field-ambiguous",
    "field-count-changed",
    "totp-field-mismatch",
    "no-route",
  ]);
  /**
   * The chosen item named as a saved default names it, for a login whose route fills
   * nothing (ADR 0027); undefined when its connection or item cannot name it.
   */
  function choiceAccount(
    catalog: VaultCatalog,
    choice: Choice,
    documentOrigin: string,
  ): LoginChoiceAccount | undefined {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return undefined;
    return {
      origin: documentOrigin,
      provider: connection.provider,
      server: connection.server,
      userId: connection.userId,
      itemId: item.id,
      // Named as a binding built for the item is.
      ...loginDisplayNames(item.id, item.label, connection.label),
    };
  }
  /**
   * One account must resolve from a usable connection, and its item must not await review.
   * A new login reads the item's facts once and chooses its route in the owner's order
   * (ADR 0027): the `passkey` route when the recipe has it and the item holds a
   * discoverable passkey, whatever its bindings; otherwise the first password variant
   * whose binding resolves, whose fields are all allowed and whose bound password or TOTP
   * fields hold values. A recipe with one variant keeps that variant's own refusal, and
   * one with several refuses `no-route` with the first variant's reason as its detail. A
   * running or resumed login passes its recorded `route`, which is checked alone and never
   * reads the facts again. On a recipe without a passkey button, the `passkey` route is
   * chosen when the page asked for a passkey by itself (`pageRequest`), and its plan names
   * the password variant it falls back to, when one fits (ADR 0034).
   */
  async function planFor(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    recipe: LoginRecipe,
    request: {
      /** The tab asks for an account, refused with this reason unless a pick logs in. */
      asking?: "account-asked" | "relogin-limit";
      /** While the tab asks, the single account to use may fill the page (ADR 0021 D). */
      fill?: boolean;
      route?: LoginRouteChoice;
      /** Slots of the handlers a running login entered; `totp` reads the code field. */
      handlerSlots?: readonly string[];
      /** The document asked for a passkey by itself, with conditional mediation (ADR 0034). */
      pageRequest?: boolean;
      /**
       * The login starts at a later step (ADR 0049): the `passkey` route's button, on the
       * first page, is not there to click.
       */
      later?: boolean;
      /**
       * Automatic login of the page's site is paused (ADR 0062): only an account picked in
       * the popup logs in, once, on the password route.
       */
      paused?: boolean;
    } = {},
  ) {
    let catalog: VaultCatalog;
    let chosen: Choice | undefined;
    let savedDefault = false;
    if (probeMode && recipe.origin === origin) {
      // The tab asks, as `choose` answers it (ADR 0021 D); the probe has no list to offer. A
      // page to fill while the tab asks still logs in fully here, without production's
      // fill-only.
      if (request.paused) return { ok: false as const, reason: "paused" as const };
      if (request.asking && !request.fill)
        return { ok: false as const, reason: request.asking, ask: true as const };
      catalog = grantProbeOrigin(snapshot.catalog, origin, account);
      const top = await topScope(snapshot, live, account, catalog);
      if (top) return { ok: false as const, reason: top.reason };
    } else {
      const found = await choose(
        snapshot,
        live,
        request.asking,
        request.paused === true,
        request.fill === true,
        accountTargetsOn(recipe, live.path),
      );
      if ("reason" in found)
        return {
          ok: false as const,
          reason: found.reason,
          ...(found.candidates ? { candidates: found.candidates } : {}),
          ...(found.ask ? { ask: true as const } : {}),
          ...(found.paused ? { paused: true as const } : {}),
          ...(found.noUriMatch ? { noUriMatch: true as const } : {}),
        };
      chosen = found;
      savedDefault = found.saved;
      const scope = await liveScope(snapshot, live, found);
      if ("reason" in scope) return { ok: false as const, reason: scope.reason };
      const top = await topScope(snapshot, live, found, snapshot.catalog);
      if (top) return { ok: false as const, reason: top.reason };
      catalog = scope.catalog;
    }
    // The generated slot map is read at most once per plan.
    let generated: Promise<LoginBindingTemplate | undefined> | undefined;
    const slotMap = () =>
      (generated ??= Promise.resolve(generation?.slotFields(recipe.id)).catch(() => undefined));
    /**
     * The plan for one route, or why it does not resolve. Without `fillGaps`, a saved binding
     * that holds no entry for one of the route's slots refuses `binding-slots-mismatch`
     * rather than having it filled (ADR 0027, amended 2026-10-19).
     */
    const resolveRoute = async (route: LoginRouteChoice, fillGaps = true) => {
      const slots = routeSlots(recipe, route);
      let policy = snapshot.snapshot;
      let binding: LoginAccountBinding;
      let choice: UnsavedChoice | undefined;
      if (!chosen) binding = probeBinding(recipe, account, slots);
      else {
        let named: SavedLoginBinding | LoginChoiceAccount;
        let unsaved: boolean;
        if (route.route === "passkey") {
          // The route fills nothing, so no binding is read, built or saved (ADR 0027).
          const owner = choiceAccount(catalog, chosen, live.document.origin);
          if (!owner) return { ok: false as const, reason: "vault-unavailable" };
          binding = {
            origin: live.document.origin,
            connectionId: chosen.connectionId,
            itemId: chosen.itemId,
            slots: [],
          };
          named = owner;
          unsaved = !chosen.saved;
        } else {
          const bound = await bindingFor(
            catalog,
            snapshot.snapshot.settings,
            recipe,
            chosen,
            live.document.origin,
            slots,
            slotMap,
            fillGaps,
          );
          if (!bound.ok) return { ok: false as const, reason: bound.reason };
          binding = bound.binding;
          named = bound.synced;
          unsaved = !chosen.saved || !bound.saved;
        }
        if (!chosen.saved) {
          // The automatic choice acts as this document's default in memory only, named by
          // the chosen item's provider account as a saved default would be. An account
          // connected more than once therefore stays ambiguous, as it would once saved.
          policy = structuredClone(policy);
          // A found account replaces a saved default for this document.
          policy.settings.siteDefaults = policy.settings.siteDefaults.filter(
            (entry) => entry.origin !== live.document.origin,
          );
          policy.settings.siteDefaults.push({
            origin: live.document.origin,
            provider: named.provider,
            server: named.server,
            userId: named.userId,
            itemId: named.itemId,
            itemName: named.itemName,
            ...(named.accountName ? { accountName: named.accountName } : {}),
          });
        }
        // A pick made for this login only is never saved, nor an account the page's own
        // value picked (ADR 0028 amendment of 2026-10-23).
        if (unsaved && chosen.source !== "site-value" && (!chosen.pick || chosen.pick.makeDefault))
          choice = {
            binding: named,
            connectionId: chosen.connectionId,
            // An account found to become the default replaces another saved one.
            ...(chosen.pick?.makeDefault ? { replace: true } : {}),
          };
      }
      // An entered `totp` handler makes its code from the item's code field (`codeFieldOf`,
      // ADR 0027), for this login only: the binding saved after it authenticates covers the
      // route's slots.
      let planSlots = slots;
      if (request.handlerSlots?.includes(TOTP_HANDLER_SLOT)) {
        const owner = catalog.connections.find((entry) => entry.id === binding.connectionId);
        const code =
          owner && codeFieldOf(owner, binding.itemId, snapshot.snapshot.settings.bindings, recipe);
        if (!code) return { ok: false as const, reason: "code-field-missing" as const };
        binding = {
          ...binding,
          slots: [...binding.slots, { slot: TOTP_HANDLER_SLOT, fieldId: code }],
        };
        planSlots = [...slots, TOTP_HANDLER_SLOT];
      }
      const plan = resolveLoginPlan(policy, catalog, live.url, recipe, binding, planSlots);
      // A saved default's item that no longer matches the page, as after its URI was edited
      // on another device, is also no matching item.
      if (!plan.ok && plan.reason === "item-origin-mismatch" && savedDefault)
        return { ...plan, noUriMatch: true as const };
      if (!plan.ok) return plan;
      const connection = catalog.connections.find(
        (entry) => entry.id === plan.account.connectionId,
      );
      if (
        !connection ||
        // Review blocks only the affected items; unrelated items in the connection stay usable.
        (connection.state !== undefined &&
          connection.state !== "ready" &&
          connection.state !== "review-required") ||
        connection.quarantinedItemIds?.includes(plan.account.itemId)
      )
        return { ok: false as const, reason: "vault-unavailable" as const };
      return {
        ...plan,
        connection,
        route,
        ...(chosen
          ? {
              chosen: {
                source: chosen.source,
                ...(chosen.candidates === undefined ? {} : { candidates: chosen.candidates }),
              },
            }
          : {}),
        ...(choice ? { choice } : {}),
        ...(chosen?.fillOnly ? { fillOnly: true as const, asked: chosen.asked ?? [] } : {}),
      };
    };
    // A running or resumed login checks its recorded route alone.
    if (request.route) return resolveRoute(request.route);
    let facts: LoginItemFacts | undefined;
    // Only a page the passkey scripts run on can answer a passkey request (ADR 0050), and
    // none on a site whose passkey requests go to the browser (ADR 0007): there the item
    // holds no passkey, so the login takes a password route or none.
    const passkeyScripts = passkeyScriptsRun(live.document.origin, probeMode);
    const browserSite =
      passkeyScripts && listedBrowserSite(snapshot.snapshot.settings, live.document.origin);
    const passkeyPage = passkeyScripts && !browserSite;
    const factsOf = async (
      resolved: Extract<Awaited<ReturnType<typeof resolveRoute>>, { ok: true }>,
    ): Promise<LoginItemFacts> => {
      const read = await itemFacts(
        resolved.connection,
        { ...resolved.account, origin: live.document.origin },
        passkeyPage,
      );
      // The `totp` fact describes the field a `totp` handler makes its code from: a custom
      // field the saved binding names, or the one flagged as holding a key when the built-in
      // TOTP holds no value, counts when the account may read it, and the built-in TOTP then
      // does not. A binding naming a field no code is made from leaves none.
      const code = codeFieldOf(
        resolved.connection,
        resolved.account.itemId,
        snapshot.snapshot.settings.bindings,
        recipe,
      );
      if (!code) return { ...read, totp: false };
      return code.startsWith("custom.")
        ? { ...read, totp: resolved.account.fieldIds.includes(code) }
        : read;
    };
    const pageRequest =
      request.pageRequest === true && !chosen?.fillOnly && passkeyAnswersRequest(recipe);
    const { passkey: _button, ...buttonless } = recipe;
    const routeRecipe: LoginRecipe = request.later ? buttonless : recipe;
    // A pick on a paused site logs in on the password route (ADR 0062).
    if (!request.paused && passkeyPage && (recipeHasRoute(routeRecipe, "passkey") || pageRequest)) {
      const resolved = await resolveRoute({ route: "passkey" });
      if (resolved.ok) {
        facts = await factsOf(resolved);
        // No binding matters on this route, so a password variant that does not fit never
        // refuses such a login.
        if (chooseLoginRoute(routeRecipe, facts, [], pageRequest)?.route === "passkey") {
          if (!pageRequest) return { ...resolved, facts };
          // Answering the page's request falls back to the variant that fits (ADR 0034),
          // never to one that stops before the password the item lacks (ADR 0036).
          const password = await passwordPlan();
          return {
            ...resolved,
            facts,
            ...(password.ok && password.route.route === "password" && !("stopAt" in password)
              ? { fallback: password.route.variant }
              : {}),
          };
        }
      }
      // Otherwise the password route decides, with its own refusals.
    }
    const password = await passwordPlan();
    // A paused site never hands a login on to the browser's passkey sign-in: an item
    // without a password stops before anything, pressing nothing (ADR 0062).
    if (request.paused && password.ok && "stopAt" in password)
      return { ok: false as const, reason: "no-route" as const, detail: "password-empty:paused" };
    return password;
    /**
     * The first password variant that fits, or why none does. A saved binding is first tried
     * as it is on every variant, so an item keeps the variant its binding fits even when an
     * earlier one could be filled; only when none fits are its gaps filled (ADR 0027,
     * amended 2026-10-19).
     */
    async function passwordPlan() {
      let gapped = false;
      const exact = await variantPlan(false, () => {
        gapped = true;
      });
      return exact.ok || !gapped ? exact : variantPlan(true);
    }
    /** The first password variant that fits, with or without filling a saved binding. */
    async function variantPlan(fillGaps: boolean, gap?: () => void) {
      const routes: LoginRouteChoice[] = passwordVariants(recipe).map((_, variant) => ({
        route: "password",
        variant,
      }));
      const fits: boolean[] = [];
      const refusals: (string | undefined)[] = [];
      /** For a `no-route` refusal, which fact was missing (never a value). */
      const missing: (string | undefined)[] = [];
      /**
       * An item without a password, but with a passkey, goes on up to the step that fills
       * its password, or to the end of a route that fills none, in the tab's own page (ADR
       * 0036), also on a chooser's route, whose click on the list advances to its branch
       * (owner, 2026-10-13 06:32 UTC). Its binding still names the empty password, so the
       * item signs in with its password once it has one. Undefined for a password the
       * account may not fill. Otherwise the stop, or why there is none, for a value-free
       * `password-empty:<why>` detail in the log. A route whose binding reads a password
       * from another field (`passwordField`) fills one, so it never stops at its end
       * (`password-field`).
       */
      const stopOrMiss = (
        route: LoginRouteChoice,
        miss: ReturnType<typeof passwordMiss>,
        known: LoginItemFacts,
        passwordSlots: readonly string[],
        lacking: readonly string[],
        passwordField = false,
      ) => {
        if (miss !== "password-empty") return undefined;
        if (live.document.frameId !== 0) return { miss: "frame" as const };
        const result = passwordStopOrMiss(recipe, route, known, passwordSlots, lacking);
        // The item's passkey is not used there, so the copy names the list (ADR 0007).
        if (browserSite && "miss" in result && result.miss === "no-passkey")
          return { miss: "passkey-browser-site" as const };
        return passwordField && ("stop" in result || result.miss === "no-password-step")
          ? { miss: "password-field" as const }
          : result;
      };
      // Variants are tried in recipe order and the first that fits stops the search, so the
      // facts and the generated map are read once.
      /* eslint-disable no-await-in-loop */
      for (const [index, route] of routes.entries()) {
        const resolved = await resolveRoute(route, fillGaps);
        if (!resolved.ok) {
          if (!variantRefusals.has(resolved.reason)) return resolved;
          if (resolved.reason === "binding-slots-mismatch") gap?.();
          refusals[index] = resolved.reason;
          continue;
        }
        facts ??= await factsOf(resolved);
        // The password route needs every bound password or TOTP field, built in or Linked to
        // one, to hold a value the account may fill.
        const item = resolved.connection.items.find(
          (entry) => entry.id === resolved.account.itemId,
        );
        const known = facts;
        const lacking = resolved.binding.slots
          .map(({ slot, fieldId }) => ({
            slot,
            source: item ? loginFieldSource(item, fieldId) : fieldId,
          }))
          .filter(
            ({ source }) =>
              (source === "login.password" && !known.password) ||
              (source === "login.totp-code" && !known.totp),
          );
        const unheld = lacking[0]?.source;
        if (unheld) {
          const miss = passwordMiss(item, resolved.account.fieldIds);
          const passwordSlots = lacking
            .filter(({ source }) => source === "login.password")
            .map(({ slot }) => slot);
          const stop =
            passwordSlots.length === 0
              ? undefined
              : stopOrMiss(
                  route,
                  miss,
                  known,
                  passwordSlots,
                  lacking.map(({ slot }) => slot),
                );
          if (stop && "stop" in stop) return { ...resolved, facts: known, stopAt: stop.stop };
          refusals[index] = "no-route";
          missing[index] =
            unheld !== "login.password" ? "no-totp" : stop ? `${miss}:${stop.miss}` : miss;
          continue;
        }
        fits[index] = true;
        const taken = chooseLoginRoute(routeRecipe, known, fits);
        if (taken?.route === "password" && taken.variant === index)
          return { ...resolved, facts: known };
        // The first variant that fits decides; without the item's password none is taken.
        // The passkey route, when the facts choose it here, did not resolve, so nothing is.
        refusals[index] = "no-route";
        if (taken?.route === "passkey") {
          missing[index] = "passkey-unresolved";
          break;
        }
        // A variant whose binding reads nothing from the empty password, as one whose page
        // after the identifier is not generated yet, stops at the end of its route, unless
        // a slot reads a password from another field: the `password` slot, the password
        // through a Linked field, or a concealed (hidden) custom field.
        const miss = passwordMiss(item, resolved.account.fieldIds);
        const passwordField = resolved.binding.slots.some(
          ({ slot, fieldId }) =>
            slot === "password" ||
            (item ? loginFieldSource(item, fieldId) : fieldId) === "login.password" ||
            item?.fields.find((field) => field.id === fieldId)?.kind === "hidden",
        );
        const stop = stopOrMiss(route, miss, known, [], [], passwordField);
        if (stop && "stop" in stop) return { ...resolved, facts: known, stopAt: stop.stop };
        missing[index] = stop ? `${miss}:${stop.miss}` : miss;
        break;
      }
      /* eslint-enable no-await-in-loop */
      const first = refusals[0] ?? "no-route";
      // A `no-route` names the fact the first variant missed, so the log tells an item
      // without a password from one without its TOTP secret.
      const detail = first === "no-route" ? missing[0] : first;
      // Every variant tried was refused for the item's facts, not for a binding or field it
      // names, and the item holds what another route needs, which the recipe lacks: a recipe
      // generated again for the page may have it (ADR 0058 A). The caller decides whether
      // that may happen.
      const unfit =
        facts && refusals.every((reason) => reason === "no-route")
          ? heldRouteMissing(recipe, facts, passkeyPage)
          : undefined;
      const marked = unfit ? { unfit } : {};
      return routes.length === 1
        ? {
            ok: false as const,
            reason: first,
            ...(detail && detail !== first ? { detail } : {}),
            ...marked,
          }
        : {
            ok: false as const,
            reason: "no-route" as const,
            ...(detail ? { detail } : {}),
            ...marked,
          };
    }
  }
  type Authorized = {
    connection: VaultConnectionMetadata;
    binding: LoginAccountBinding;
    /** The account's allowed field IDs and the synced bindings it was authorized with. */
    fieldIds: string[];
    bindings: SavedLoginBinding[];
    /** The settings and whole catalog it was authorized with, for linked details (ADR 0061). */
    settings: LocalSettings;
    catalog: VaultCatalog;
  };
  /** Resolve against a fresh live catalog; returns the authorizing metadata and binding. */
  async function allowed(run: Execution): Promise<Authorized | undefined> {
    if (!current(run) || !storageHealthy) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!current(run)) return undefined;
    // A watched login only reads, so newer settings stop it only when they no longer plan
    // its account on this page, as another site's saved account choice does not (ADR 0027).
    const revised =
      snapshot.ok &&
      run.metadata.watch !== undefined &&
      snapshot.snapshot.revision > run.metadata.policyRevision;
    // A read that another check of the same watch overtook says nothing.
    if (
      snapshot.ok &&
      run.metadata.watch !== undefined &&
      snapshot.snapshot.revision < run.metadata.policyRevision
    )
      return undefined;
    if (!snapshot.ok || (snapshot.snapshot.revision !== run.metadata.policyRevision && !revised)) {
      await change(
        run,
        { type: "POLICY_CHANGED" },
        { cause: snapshot.ok ? "settings-revision" : "settings-unavailable" },
      );
      return undefined;
    }
    // The recorded route alone is checked, so an excluded field of another variant never
    // stops this login, with the fields of the handlers it entered (ADR 0027).
    const plan = await planFor(snapshot, run.live, run.recipe, {
      route: attemptRouteChoice(run.metadata),
      handlerSlots: handlerSlots(run.recipe, run.metadata),
    });
    if (
      !plan.ok ||
      plan.account.connectionId !== run.metadata.account.connectionId ||
      plan.account.itemId !== run.metadata.account.itemId
    ) {
      await change(
        run,
        { type: "POLICY_CHANGED" },
        { cause: "plan", reason: plan.ok ? "account-changed" : plan.reason },
      );
      return undefined;
    }
    if (revised) {
      await change(run, { type: "POLICY_REVISED", policyRevision: snapshot.snapshot.revision });
      if (!current(run) || run.metadata.policyRevision !== snapshot.snapshot.revision)
        return undefined;
    }
    return {
      connection: plan.connection,
      binding: plan.binding,
      fieldIds: plan.account.fieldIds,
      bindings: snapshot.snapshot.settings.bindings,
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
    };
  }
  async function observe(
    run: Execution,
    targets: LoginMarkerTarget[],
    require?: TargetRequirement[],
    {
      links,
      hidden,
      signIn = false,
      explain = false,
    }: { links?: boolean[]; hidden?: boolean[]; signIn?: boolean; explain?: boolean } = {},
  ) {
    // Exclusion/default/policy checks precede even metadata observation.
    if (!(await allowed(run))) return undefined;
    const response = await send(run.live, {
      type: "login.observe",
      path: run.live.path,
      targets,
      ...(require ? { require } : {}),
      ...(links ? { links } : {}),
      ...(hidden ? { hidden } : {}),
      ...(signIn ? { signIn: true } : {}),
      ...(explain ? { explain: true } : {}),
    });
    if (!current(run)) return undefined;
    const parsed = v.safeParse(observationSchema, response);
    if (probeMode && parsed.success) run.live.observations = (run.live.observations ?? 0) + 1;
    return parsed.success ? parsed.output : undefined;
  }
  /**
   * Asks the document to wait for a step's elements. A document that went away or was
   * cancelled leaves the attempt as it is; its replacement document resumes it.
   */
  async function waitFor(
    run: Execution,
    readiness: LoginReadiness,
    timeoutMs = stepWaitMs(),
  ): Promise<"ready" | "timeout" | "gone"> {
    try {
      const response = await send(run.live, {
        type: "login.await",
        readiness,
        timeoutMs,
      });
      const parsed = v.safeParse(awaitResultSchema, response);
      if (!parsed.success) return "gone";
      return parsed.output.ok ? "ready" : parsed.output.reason === "timeout" ? "timeout" : "gone";
    } catch {
      return "gone";
    }
  }
  /**
   * How a page that does not prove the sign-in ends the login: as itself on the `password`
   * route, and always as `challenge` on the `passkey` route, which never falls back to
   * typing the password (ADR 0027). A login that stops before its item's missing password
   * ends an unproven page as `challenge` too, watched (ADR 0036).
   */
  const unproven = (run: Execution, result: "credential-rejected" | "challenge" | "unknown") =>
    run.metadata.route === "passkey" || (run.metadata.stopAt !== undefined && result === "unknown")
      ? "challenge"
      : result;
  /**
   * Checks the page after an effect step: the signed-in markers, the rejection, the plan's next
   * step, then a handler on the page (ADR 0027), and once the result would settle as
   * unknown, the sign-in state (ADR 0029) before the judge. Returns `held` while a held click's button
   * still shows in the document that clicked it, or while the sign-in form still shows after
   * a passkey answer, so the page is neither judged nor settled yet. A login with a stop
   * goes on at most to it (ADR 0036). The page after the final `advance` before a stop just
   * past the plan's last step takes the login to that stop at once when it asks for a
   * passkey (`asksPasskey`); otherwise it is continued as any login's page, or judged once
   * the step's wait ran out, and the login goes on to its stop when neither moved it on.
   */
  async function reconcile(run: Execution, settleUnknown = false): Promise<"held" | undefined> {
    const nextIndex =
      run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance"
        ? run.metadata.stepIndex + 1
        : run.metadata.stepIndex;
    const plan = attemptPlan(run.recipe, run.metadata) ?? [];
    // A login with a stop never goes on past it (ADR 0036).
    const next = pastStop(run.metadata, nextIndex) ? undefined : plan[nextIndex]?.step;
    // An advance on the next step's own path is confirmed only by that step's elements
    // being ready, as it waits for them and as the page's description sees them, and only
    // if they were not ready that way before it ran.
    const inPlace =
      run.metadata.operationEffect === "advance"
        ? inPlaceNext(run.recipe, run.metadata, run.metadata.stepIndex)
        : undefined;
    const nextTargets = inPlace ? inPlace.targets : next ? stepTargets(next) : [];
    const { rejection } = run.recipe;
    const proof = markerProof(run.recipe);
    const checks = [...proof.targets, ...(rejection ? [rejection] : [])];
    const targets = [...checks, ...nextTargets];
    const observed = await observe(
      run,
      targets,
      [
        ...proof.shown,
        ...(rejection ? ["present" as const] : []),
        ...nextTargets.map(() => inPlace?.require ?? "present"),
      ],
      proof.links.length > 0 ? { links: proof.links, hidden: proof.hidden } : {},
    );
    if (!observed) return undefined;
    // Without a marker only the sign-in state below proves a sign-in.
    if (proof.proves(observed.targets)) {
      const before = run.metadata;
      await change(run, { type: "OBSERVED", result: "authenticated", document: run.live.document });
      // A repeat login's page may be sampled, in the background (ADR 0029).
      sampleSignedIn(run, before, observed.path);
      return undefined;
    }
    const rejectionIndex = proof.targets.length;
    const rejected = rejection !== undefined && observed.targets[rejectionIndex] === "unique";
    if (!rejected) delete run.staleRejection;
    if (rejected && !run.staleRejection) {
      // A site that refused the passkey answer gets the password instead (ADR 0034).
      if (
        effectful(run.metadata) &&
        run.metadata.route === "passkey" &&
        passkeyAnswersRequest(run.recipe)
      ) {
        // The banner still shows when the password is submitted in this document.
        run.staleRejection = true;
        await fallBack(run, "sign-in-rejected");
        return undefined;
      }
      await change(run, {
        type: "OBSERVED",
        result: unproven(run, "credential-rejected"),
        document: run.live.document,
      });
      return undefined;
    }
    // A login back at a stop just past its plan's last step, as after a restart or in a new
    // document, stands there again: no step's elements show the stop (ADR 0036).
    if (
      stopsPastPlan(run.metadata) &&
      run.metadata.stepIndex === run.metadata.stopAt &&
      run.metadata.operationId === undefined
    ) {
      await change(run, { type: "OBSERVED", result: "continue", document: run.live.document });
      return undefined;
    }
    const offset = rejectionIndex + (rejection ? 1 : 0);
    if (
      next &&
      observed.path === next.path &&
      nextTargets.length &&
      observed.targets.slice(offset).every((state) => state === "unique") &&
      // A pending click advances only after evidence of its configured next page: another
      // path, or on the same path, next elements the advance made ready. A click that
      // submits never continues on its own path.
      (!(run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance") ||
        plan[run.metadata.stepIndex]?.step.path !== next.path ||
        (inPlace !== undefined &&
          run.inPlace !== undefined &&
          run.inPlace.operationId === run.metadata.operationId &&
          run.inPlace.before.every((state) => state === "missing" || state === "unusable")))
    ) {
      const continuation: LoginAttemptEvent = {
        type: "OBSERVED",
        result: "continue",
        document: run.live.document,
      };
      // Remaining fields alone do not prove that an uncertain input effect finished.
      const candidate = transitionLoginAttempt(run.metadata, continuation);
      if (candidate.state === "ready" || candidate.state === "retryable") {
        await change(run, continuation);
        return undefined;
      }
    }
    // Where the recipe's layouts part, the page may show another layout's next step instead
    // of the login's own: the login goes on with that layout (ADR 0060).
    const ownShows =
      next !== undefined &&
      observed.path === next.path &&
      nextTargets.length > 0 &&
      observed.targets.slice(offset).every((state) => state === "unique");
    if (!ownShows && (await switchLayout(run))) return undefined;
    if (!current(run)) return undefined;
    let continued: Awaited<ReturnType<typeof continueOn>> = "none";
    // After a passkey answer at the stop, the sign-in form still showing means the site has
    // not signed in: it may still be checking the assertion for a while, then the login
    // ends at its stop (ADR 0036). A stop just past the plan's last step has no form of its
    // own; its page is held below instead.
    const stop = answeredAtStop(run.metadata) ? plan[run.metadata.stopAt!] : undefined;
    if (stop) {
      const stopFields = stepTargets(stop.step);
      const form = await observe(
        run,
        stopFields,
        stopFields.map(() => "shown" as const),
      );
      if (!form) return undefined;
      if (form.path === stop.step.path && form.targets.some((state) => state === "unique")) {
        if (run.answeredAt !== undefined && Date.now() - run.answeredAt < REQUEST_HOLD_MS)
          return "held";
        await change(
          run,
          { type: "OBSERVED", result: "challenge", document: run.live.document },
          undefined,
          undefined,
          undefined,
          "password-empty",
        );
        return undefined;
      }
    }
    if (effectful(run.metadata)) {
      // A held click, a handler's or the passkey route's, is not judged while its button
      // still shows in the document that clicked it, whatever path a same-document URL
      // change has moved it to: a WebAuthn exchange or a chooser the person answers can
      // take a while (ADR 0027). A new document that shows a handler's button again goes
      // to the person through the handler's own check below; one that shows the passkey
      // route's button again on its path, as after a reload back to the start page, goes
      // to the person at once: it is never clicked again or judged.
      const inFlight = plan[run.metadata.stepIndex];
      const routeClick =
        inFlight !== undefined &&
        inFlight.handler === undefined &&
        run.metadata.route === "passkey";
      // The page after a `password` handler's click that asks for the password is continued
      // before the click's hold is read, since the button may stay beside the password form;
      // such a page is not held, judged or handled (ADR 0048).
      const choseByPassword =
        inFlight?.handler !== undefined &&
        run.recipe.handlers?.[inFlight.handler]?.kind === "password";
      if (choseByPassword) {
        continued = await continueOn(run);
        if (continued === "moved") return undefined;
      }
      const asksPassword = continued === "qualified";
      // After answering the page's own request, the start page's sign-in form still
      // showing on its path means the site has not signed in: it may still be exchanging
      // the assertion in this document for a while, then the login falls back to its
      // password variant (ADR 0034).
      if (!asksPassword && inFlight && routeClick && passkeyAnswersRequest(run.recipe)) {
        let shows: boolean;
        const onList = listOf(run);
        if (onList) {
          // A chooser login's start page is its list, read as its click's wait reads it,
          // since the click's target names no element by itself (ADR 0028).
          if (!(await allowed(run))) return undefined;
          const list = await waitFor(run, listReadiness(onList.chooser), 1);
          if (!current(run) || list === "gone") return undefined;
          shows = list === "ready";
        } else {
          const form = await observe(run, stepTargets(inFlight.step), ["shown"]);
          if (!form) return undefined;
          shows = form.path === inFlight.step.path && form.targets[0] === "unique";
        }
        if (shows) {
          if (run.answeredAt !== undefined && Date.now() - run.answeredAt < REQUEST_HOLD_MS)
            return "held";
          await fallBack(run, "sign-in-shown");
          return undefined;
        }
      } else if (
        !asksPassword &&
        inFlight &&
        (run.heldClick === run.metadata.stepIndex || routeClick)
      ) {
        // A button the page only hid counts as gone, as an app that moved on in the same
        // document and kept its old view there hidden.
        const clickTargets = stepTargets(inFlight.step);
        const clicked = await observe(
          run,
          clickTargets,
          clickTargets.map(() => "shown" as const),
        );
        if (!clicked) return undefined;
        if (clicked.targets.some((state) => state !== "missing" && state !== "unusable")) {
          if (run.heldClick === run.metadata.stepIndex) return "held";
          if (clicked.path === inFlight.step.path) {
            await change(run, {
              type: "OBSERVED",
              result: "challenge",
              document: run.live.document,
            });
            return undefined;
          }
        }
      }
      if (!asksPassword && (await enterHandler(run, observed.path))) return undefined;
      // The page after the final advance before a stop just past the plan's last step that
      // asks for a passkey takes the login to that stop at once (ADR 0036).
      if (advancingToStop(run.metadata) && asksPasskey(run) && (await toStop(run)))
        return undefined;
      if (!choseByPassword) {
        continued = await continueOn(run);
        if (continued === "moved") return undefined;
      }
    }
    if (!settleUnknown) return undefined;
    // Otherwise that page is continued as any login's, or judged once the step's wait ran
    // out, and the login goes on to its stop when neither moved it on. An advance the record
    // cannot go on from, as one that failed before its intent, ends here unjudged.
    if (advancingToStop(run.metadata) && !canReachStop(run)) {
      await change(run, {
        type: "OBSERVED",
        result: unproven(run, "unknown"),
        document: run.live.document,
      });
      return undefined;
    }
    // After answering the page's own request, a page still on the start page's path may be
    // exchanging the assertion before the site moves on, with its form already gone: it is
    // not judged until the request's hold ends, nor while it shows nothing to describe, as
    // a loader does, until the held click's wait ends (ADR 0034).
    // So is the page after an answer at a login's stop, on the path of the step it stopped at,
    // or for a stop just past the plan's last step, on the path it answered on (ADR 0036).
    const answered = plan[run.metadata.stepIndex];
    const answeredPath =
      answered === undefined
        ? answeredAtStop(run.metadata)
          ? run.answeredPath
          : undefined
        : answered.handler === undefined
          ? answered.step.path
          : undefined;
    if (
      ((run.metadata.route === "passkey" && passkeyAnswersRequest(run.recipe)) ||
        answeredAtStop(run.metadata)) &&
      answeredPath !== undefined &&
      observed.path === answeredPath &&
      run.answeredAt !== undefined &&
      (Date.now() - run.answeredAt < REQUEST_HOLD_MS || (await showsNothing(run)))
    )
      return current(run) ? "held" : undefined;
    // An advance on the next step's own path that was never confirmed says why in the log,
    // in a top document, the only one whose sign-in state is read.
    const advance =
      inPlace && next && run.live.topUrl === undefined
        ? await advanceMiss(run, inPlace, next.path)
        : undefined;
    if (!current(run) || terminal(run.metadata)) return undefined;
    const state = effectful(run.metadata) ? await signInState(run, advance) : undefined;
    if (!current(run) || terminal(run.metadata)) return undefined;
    // Evidence of a sign-in completes the login without a model call, on the passkey route
    // too (owner, 2026-10-24), and a failure shown next to the sign-in fields rejects it
    // (ADR 0029); the passkey route rejects no credential, and goes on as before.
    if (
      state?.confirmed &&
      (state.decision === "signed-in" ||
        (state.decision === "rejected" && run.metadata.route !== "passkey"))
    ) {
      await change(run, {
        type: "OBSERVED",
        result: state.decision === "signed-in" ? "authenticated" : "credential-rejected",
        document: run.live.document,
      });
      return undefined;
    }
    // A sign-in page after the final advance is never judged: the judge cannot learn
    // anything from it (ADR 0018).
    if (continued === "qualified") notJudged(run, "continuation");
    else if (await learn(run, state)) return undefined;
    // A login before a stop just past its plan's last step goes on to it (ADR 0036).
    if (await toStop(run)) return undefined;
    // A page that was not judged settles as unknown, whatever its signs (ADR 0029). One
    // that still showed the sign-in form (S1) without a failure that acted says so in the
    // log, as `sign-in-shown`.
    const result = unproven(run, "unknown");
    // A password page on the next step's path after an advance whose next step never showed
    // there is sent for repair (ADR 0041 section 4).
    const stale =
      result === "unknown" &&
      state?.decision === "continuing" &&
      state.asksPassword &&
      run.metadata.operationEffect === "advance" &&
      next !== undefined &&
      observed.path === next.path
        ? nextIndex
        : undefined;
    await change(
      run,
      { type: "OBSERVED", result, document: run.live.document },
      undefined,
      result === "unknown" && (state?.decision === "unknown" || state?.decision === "rejected")
        ? "sign-in-shown"
        : undefined,
    );
    if (stale !== undefined) void repairLaterStep(run, stale).catch(() => undefined);
    // The sign-in form shown again in the first new page after the password submission,
    // with nothing else on it, means the login did not go through: the tab asks at once.
    if (state?.formAgain && state.confirmed && state.decision === "unknown") await askAgain(run);
    return undefined;
  }
  /**
   * Whether the page after the final `advance` before a stop just past the plan's last step
   * asked for a passkey after that step (ADR 0036): its document's request waits, having
   * come after the step, or the passkey bridge answered one since it.
   */
  function asksPasskey(run: Execution): boolean {
    const effect = effects.get(run.live.document.tabId);
    const parked = parkedFor(run.live.document);
    return (
      bridgeAnswer(run) !== undefined ||
      (parked !== undefined && effect?.attemptId === run.metadata.id && parked.since >= effect.at)
    );
  }
  /** Whether the record of such a login can go on from its final advance to its stop. */
  function canReachStop(run: Execution): boolean {
    const candidate = transitionLoginAttempt(run.metadata, {
      type: "OBSERVED",
      result: "continue",
      document: run.live.document,
    });
    return candidate.state === "ready" || candidate.state === "retryable";
  }
  /**
   * Takes such a login from its final advance to its stop, where it waits for the page's
   * passkey request (ADR 0036). Returns whether it went there.
   */
  async function toStop(run: Execution): Promise<boolean> {
    if (!advancingToStop(run.metadata) || !canReachStop(run)) return false;
    await change(run, { type: "OBSERVED", result: "continue", document: run.live.document });
    return true;
  }
  /**
   * Releases a login whose submission the site answered with its sign-in form again, as
   * after a rejection: the tab, and the origin's other tabs, ask for an account instead of
   * watching, and the page that showed the form is never filled again (ADR 0021 D, amended
   * 2026-10-13). Nothing is submitted again by itself. Its page is asked to announce again,
   * so it asks once a recipe's first step is ready there, or may be sent for a recipe like
   * any sign-in page.
   */
  async function askAgain(run: Execution): Promise<void> {
    if (!current(run) || run.live.document.frameId !== 0) return;
    const { metadata } = run;
    const { document } = run.live;
    const { tabId } = document;
    const key = recordKey(tabId, document.origin);
    if (persisted.get(key)?.id !== metadata.id) return;
    const page = documentKey(document);
    const asked = rejectedAsks.has(key);
    const unfilled = !askFills.has(page);
    rejectedAsks.add(key);
    if (unfilled) addAskFill(page);
    try {
      await saveSession();
    } catch {
      // The login stays watched, as before.
      if (!asked) rejectedAsks.delete(key);
      if (unfilled) askFills.delete(page);
      return;
    }
    if (!current(run) || persisted.get(key)?.id !== metadata.id) {
      // The page went meanwhile: the login stays as it was, and so does the tab.
      if (!asked) rejectedAsks.delete(key);
      if (unfilled) askFills.delete(page);
      await quietly(saveSession);
      return;
    }
    attempts.delete(tabId);
    if (picked.get(tabId)?.attemptId === metadata.id) {
      picked.delete(tabId);
      void quietly(saveSession);
    }
    await forget(key).catch(() => undefined);
    reviewRequests();
    await browser.tabs
      .sendMessage(
        tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: 0, documentId: document.documentId },
      )
      .catch(() => undefined);
  }
  /**
   * Whether Pateat's answer to the passkey request of this attempt's latest step that asked
   * for one went back after that step, on the page's origin or the recipe's, also when a
   * handler's steps ran after it (ADR 0029 amendment of 2026-10-24).
   */
  function passkeyStepAnswered(run: Execution): boolean {
    const { tabId, origin: pageOrigin } = run.live.document;
    const effect = effects.get(tabId);
    const requestAt = effect?.attemptId === run.metadata.id ? effect.requestAt : undefined;
    if (requestAt === undefined) return false;
    return [pageOrigin, run.recipe.origin].some(
      (from) => (passkeyAnswers.get(`${tabId} ${from}`)?.at ?? -1) >= requestAt,
    );
  }
  /** Whether the page has nothing a signed-in page's description could carry. */
  async function showsNothing(run: Execution): Promise<boolean> {
    const extracted = v.safeParse(
      extractResultSchema,
      await send(run.live, { type: "login.extract", page: "signed-in" }).catch(() => undefined),
    );
    return extracted.success && !extracted.output.ok && extracted.output.reason === "no-candidates";
  }
  /**
   * Reads and logs the sign-in state of ADR 0029 for a page no check explained: its signs
   * and what the ADR does with it. Returns the decision, `confirmed` only when a later
   * reading, a second apart, agrees in the fully loaded document, on the passkey route too
   * (ADR 0029 amendment of 2026-10-24). A login in a frame is not read, as the ADR reads
   * the top document.
   */
  async function signInState(
    run: Execution,
    advance?: AdvanceMiss,
  ): Promise<SignInReading | undefined> {
    let reading = await readSignInState(run);
    let confirmed = false;
    // A decision counts once a later reading agrees in a fully loaded document, so a page
    // that is still redirecting or about to ask for a second factor is not settled; a
    // document still loading is read again, a second apart, up to `SIGN_IN_RECHECKS` times.
    // `unknown` changes nothing and is not read again, unless it is the sign-in form shown
    // again with nothing else, on which the tab asks again (ADR 0021 D). Each reading
    // depends on the time passed since the last, so they run one after another.
    /* eslint-disable no-await-in-loop */
    for (
      let recheck = 0;
      reading !== undefined &&
      (reading.decision !== "unknown" || formAgain(reading.signs)) &&
      recheck < SIGN_IN_RECHECKS;
      recheck++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
      if (!current(run) || terminal(run.metadata)) return undefined;
      const next = await readSignInState(run);
      const agrees =
        next?.decision === reading.decision &&
        formAgain(next.signs) === formAgain(reading.signs) &&
        next.loaded;
      reading = next;
      if (agrees) {
        confirmed = true;
        break;
      }
    }
    /* eslint-enable no-await-in-loop */
    if (!reading) return undefined;
    report(run.live.document, {
      type: "state",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: run.recipe.id,
      recipeRevision: run.recipe.revision,
      route: run.metadata.route,
      ...reading.signs,
      decision: reading.decision,
      ...(run.metadata.settled ? { settled: true as const } : {}),
      ...reading.misses,
      ...advance,
    });
    return {
      decision: reading.decision,
      confirmed,
      ...(reading.signs.reshown ? { reshown: true as const } : {}),
      ...(formAgain(reading.signs) ? { formAgain: true as const } : {}),
      ...(reading.signs.s2 && !reading.signs.s4 ? { asksPassword: true as const } : {}),
    };
  }
  /**
   * Why an advance whose next step is on its own path (ADR 0013) was not confirmed, for the
   * log only (ADR 0019): the next step's first targets as measured just before the advance
   * (`unmeasured` without that measurement, as in another document after a worker restart
   * or for another operation), as read now with the same requirement, the check that
   * decided each reading now, and whether the page is on the step's path. Codes only.
   */
  async function advanceMiss(
    run: Execution,
    inPlace: InPlaceNext,
    path: string,
  ): Promise<AdvanceMiss | undefined> {
    const targets = inPlace.targets.slice(0, ADVANCE_LOG_TARGETS);
    const observed = await observe(
      run,
      targets,
      targets.map(() => inPlace.require),
      { explain: true },
    );
    if (!observed?.checks) return undefined;
    const measured =
      run.inPlace && run.inPlace.operationId === run.metadata.operationId
        ? run.inPlace.before
        : undefined;
    return {
      advanceBefore: measured ? measured.slice(0, ADVANCE_LOG_TARGETS).join(".") : "unmeasured",
      advanceAfter: observed.targets.join("."),
      advanceWhy: observed.checks.join("."),
      advancePath: observed.path === path ? "same" : "other",
    };
  }
  /** Whether a sign-in target is the passkey route's button rather than a field (ADR 0027). */
  function passkeyButton(run: Execution, target: LoginTarget): boolean {
    const button = run.metadata.route === "passkey" ? run.recipe.passkey?.target : undefined;
    return button !== undefined && sameLoginTarget(target, button);
  }
  /**
   * The page's signs of ADR 0029 and the decision they give, and whether the document has
   * finished loading. The username goes to the page's content script for its comparison
   * only.
   */
  /**
   * Whether a signed-in marker of another layout of the login's recipe shows (ADR 0060),
   * read as the login's own markers are; `undefined` when the page could not be read.
   */
  async function otherLayoutsMarked(run: Execution): Promise<boolean | undefined> {
    const { recipe } = run;
    const layouts = await Promise.resolve(recipes.layoutsOf?.(recipe.origin, recipe.id)).catch(
      () => undefined,
    );
    /* eslint-disable no-await-in-loop */
    for (const other of layouts ?? []) {
      if (other.layout === recipe.layout && sameMarkers(other, recipe)) continue;
      const proof = markerProof(other);
      if (!proof.targets.length) continue;
      const marked = await observe(run, proof.targets, proof.shown, {
        links: proof.links,
        hidden: proof.hidden,
      });
      if (!marked) return undefined;
      if (proof.proves(marked.targets)) return true;
    }
    /* eslint-enable no-await-in-loop */
    return false;
  }
  async function readSignInState(run: Execution): Promise<
    | {
        signs: SignInSigns;
        decision: SignInDecision;
        loaded: boolean;
        /** The path the reading was taken on. */
        path: string;
        /** Why S1 is not read as the form shown again, or F2 not on it, for the log. */
        misses: { reshownMiss?: ReshownMiss; alertMiss?: AlertMiss };
      }
    | undefined
  > {
    const { recipe, metadata } = run;
    if (run.live.topUrl !== undefined) return undefined;
    // Each marker shown, with the fields it needs gone counted even when hidden, as the
    // completion check counts them: a login form that hides itself again after a failed
    // sign-in is not a sign-in.
    // The markers are read on their own, so they never crowd out the sign-in fields.
    const proof = markerProof(recipe);
    const fills = routeSignInTargets(recipe, metadata.route).slice(0, 24);
    // Only a shown input counts as a field: another page may give a sign-in field's locator
    // to another element, as Wise's signed-in page gave its React ID to an empty div
    // (2026-10-12). The passkey route's button is no input and counts when shown.
    const observed = await observe(
      run,
      fills,
      fills.map((target) => (passkeyButton(run, target) ? "shown" : "shown-input")),
    );
    if (!observed) return undefined;
    const marked =
      proof.targets.length > 0
        ? await observe(run, proof.targets, proof.shown, {
            links: proof.links,
            hidden: proof.hidden,
          })
        : undefined;
    if (proof.targets.length > 0 && !marked) return undefined;
    // The signed-in markers the recipe's other layouts learned count as well (ADR 0060): a
    // page of one layout's site may sign in to a page another layout learned.
    const otherMarked = await otherLayoutsMarked(run);
    if (otherMarked === undefined) return undefined;
    const authorized = await allowed(run);
    if (!authorized) return undefined;
    let username: string | undefined;
    // A login that stops before its item's missing password is not signed in by its
    // username in the header or navigation (E2): the page after the identifier may show it
    // before the sign-in (ADR 0036). The username is not read for it at all.
    const usernameField =
      metadata.stopAt === undefined
        ? loginUsernameFieldId(authorized.connection, metadata.account.itemId)
        : undefined;
    if (usernameField) {
      try {
        username = await fields({
          account: metadata.account,
          connection: authorized.connection,
          fieldId: usernameField,
        });
      } catch {
        username = undefined;
      }
      if (!current(run)) return undefined;
    }
    const s1 = observed.targets.slice(0, fills.length).some((state) => state === "unique");
    const { tabId, origin: pageOrigin } = run.live.document;
    const effect = effects.get(tabId);
    // The sign-in form shown again in the first new top document after this attempt's
    // password submission, as by a site that answers a failed submission with its sign-in
    // page: its inputs' marks and the alerts next to it are read without the step's own
    // reading (owner, 2026-10-12 22:03 UTC). A later document, such as the person's own
    // retry, is not; nor is one after an advance or a passkey step. Without the step in
    // memory, as after a worker restart, it is not read.
    const reshownMiss: ReshownMiss | undefined =
      effect?.attemptId !== metadata.id
        ? "no-effect"
        : effect.passkey
          ? "passkey-step"
          : !effect.submits
            ? "not-submit"
            : sameLoginDocument(effect.document, run.live.document)
              ? "same-document"
              : effect.next === undefined
                ? "late"
                : effect.next !== run.live.document.documentId
                  ? "later-document"
                  : undefined;
    const reshown = s1 && reshownMiss === undefined;
    let response: unknown;
    try {
      response = await send(run.live, {
        type: "login.state",
        ...(username ? { account: { username } } : {}),
        ...(reshown ? { fields: fills } : {}),
      });
    } catch {
      return undefined;
    }
    if (!current(run)) return undefined;
    const parsed = v.safeParse(stateResultSchema, response);
    if (!parsed.success || !parsed.output.ok) return undefined;
    const page = parsed.output.signs;
    const requested = passkeyRequests.get(`${tabId} ${pageOrigin}`);
    const answered = passkeyAnswers.get(`${tabId} ${pageOrigin}`)?.at;
    const signInUrl = signInUrls.get(tabId);
    const signs: SignInSigns = {
      s1,
      s2: page.password,
      s3: page.code,
      s4: page.captcha,
      // After a step that asked for a passkey itself, its request counts only while no
      // answer of Pateat's followed it: one still open, left to the browser, or another
      // after the answer (ADR 0029 amendment of 2026-10-24).
      s5:
        effect?.attemptId === metadata.id &&
        requested !== undefined &&
        requested >= effect.at &&
        (!effect.request || answered === undefined || answered < requested),
      // A failure counts only next to the sign-in fields.
      f1: s1 && page.invalid,
      f2: s1 && page.alert,
      e1: (marked !== undefined && proof.proves(marked.targets)) || otherMarked,
      e2: page.username === true,
      // The document's path now, which follows a route change of a single-page site.
      e3:
        signInUrl?.attemptId === metadata.id &&
        reachedReturnTarget(
          signInUrl.url,
          `${pageOrigin}${observed.path}`,
          routeSignInPaths(recipe, metadata.route),
        ),
      ...(reshown ? { reshown: true as const } : {}),
    };
    // Value-free reasons for the log: why the form was not read as shown again, or why no
    // alert beside it counted (ADR 0019).
    const misses =
      s1 && reshownMiss !== undefined
        ? { reshownMiss }
        : reshown && !signs.f2 && page.alertMiss !== undefined
          ? { alertMiss: page.alertMiss }
          : {};
    return {
      signs,
      decision: decideSignInState(signs),
      loaded: parsed.output.loaded,
      path: observed.path,
      misses,
    };
  }
  type DetailHandler = Extract<LoginHandler, { kind: "detail" }>;
  /** The login item a run's links belong to, or none while its vault account is unknown. */
  function detailOwner(
    login: Pick<LoginAccount, "connectionId" | "itemId" | "origin">,
    catalog: VaultCatalog,
  ): { owner: DetailOwner; connection: VaultConnectionMetadata } | undefined {
    const connection = catalog.connections.find((entry) => entry.id === login.connectionId);
    if (!connection?.userId) return undefined;
    return {
      owner: {
        origin: login.origin,
        provider: connection.provider,
        server: connection.server,
        userId: connection.userId,
        itemId: login.itemId,
      },
      connection,
    };
  }
  /** Reports a `login.handler` outcome about a `detail` handler (ADR 0061). */
  function reportDetail(
    document: LoginDocument,
    recipe: LoginRecipe,
    handler: number,
    outcome: Extract<Extract<LoginReport, { type: "handler" }>["outcome"], `detail-${string}`>,
  ): void {
    const entry = recipe.handlers?.[handler];
    report(document, {
      type: "handler",
      tabId: document.tabId,
      origin: document.origin,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      handler,
      kind: "detail",
      outcome,
      steps: entry ? handlerSteps(entry).length : 0,
    });
  }
  /**
   * Which input of a shown `detail` handler a login fills (ADR 0061): the first whose
   * detail Pateat fills, that has a saved link to a field the device may read, and that is
   * writable now. Undefined when none is.
   */
  async function detailInput(
    run: Execution,
    handler: DetailHandler,
    waiting?: (wait: DetailWait) => void,
  ): Promise<number | undefined> {
    const authorized = await allowed(run);
    if (!authorized) return undefined;
    const found = detailOwner(run.metadata.account, authorized.catalog);
    if (!found) return undefined;
    const answers = answerSources(authorized, found);
    const site = detailSite(run.metadata.id, found.connection.id, run.live.url);
    const linked = handler.fields.flatMap((field, index) => {
      if (manualDetails.includes(field.detail)) return [];
      // A value split over several inputs needs every one of them (ADR 0061).
      const targets = detailFieldInputs(field).map((input) => input.target);
      if (field.detail === "secret-answer")
        return answers.length ? [{ index, targets, answer: true }] : [];
      if (refusedDetails.has(refusalKey(found.owner, field.detail))) return [];
      const link = savedDetailLink(authorized.settings, found.owner, field.detail);
      const source =
        link && linkedField(authorized.settings, authorized.catalog, found.connection, link);
      if (!source) return [];
      // A linked item with Bitwarden's re-prompt is read only once this login holds the
      // master password (owner, 2026-10-23 21:50 UTC).
      const item = found.connection.items.find((entry) => entry.id === source.itemId);
      const wait =
        item && waitsForMasterPassword(authorized.settings, item, found.owner.itemId, site)
          ? { detail: field.detail, itemId: source.itemId, fieldId: source.fieldId, targets }
          : undefined;
      return [{ index, targets, answer: false, ...(wait ? { wait } : {}) }];
    });
    if (!linked.length) return undefined;
    const targets = linked.flatMap((entry) => entry.targets);
    const observed = await observe(
      run,
      targets,
      targets.map(() => "settable" as const),
    );
    // The page's own path, as `enterHandler` matched it: a same-document URL change may
    // not have reached `run.live.path` yet.
    if (!observed || observed.path !== handler.path) return undefined;
    let first = 0;
    // The first input whose linked item waits for the master password, when no other fits.
    let waits: DetailWait | undefined;
    for (const entry of linked) {
      const states = observed.targets.slice(first, first + entry.targets.length);
      first += entry.targets.length;
      if (states.some((state) => state !== "unique")) continue;
      if (entry.wait) {
        waits ??= entry.wait;
        continue;
      }
      // An answer input needs one of the item's question fields to be the page's question.
      if (
        !entry.answer ||
        // eslint-disable-next-line no-await-in-loop
        (await askedSource(run.live, handler.path, entry.targets[0]!, answers))
      )
        return entry.index;
      if (!current(run)) return undefined;
    }
    if (waits) waiting?.(waits);
    return undefined;
  }
  /**
   * What the page must show beside an answer input for a field (ADR 0061): the question the
   * owner confirmed for it, as one whole question, when there is one; else its name.
   */
  const askOf = (name: string, question: string | undefined): AskedQuestion =>
    question === undefined ? { name } : { question };
  /**
   * The login item's saved links for secret questions' answers that the device may read
   * and the site has not refused, each with what the page must show beside its input
   * (`askOf`).
   */
  function answerSources(
    authorized: Pick<Authorized, "settings" | "catalog">,
    found: NonNullable<ReturnType<typeof detailOwner>>,
  ) {
    return savedDetailLinks(authorized.settings, found.owner, "secret-answer").flatMap((link) => {
      if (refusedDetails.has(refusalKey(found.owner, link.detail, link.source.field))) return [];
      const source = linkedField(authorized.settings, authorized.catalog, found.connection, link);
      return source?.name
        ? [
            {
              link,
              source,
              ask: askOf(source.name, link.question),
            },
          ]
        : [];
    });
  }
  /**
   * The question the owner confirmed for the login item's answer field `fieldId`, saved
   * with its link (ADR 0061), or none.
   */
  function confirmedQuestion(
    policy: Pick<LocalSettings, "detailLinks">,
    owner: DetailOwner,
    item: Pick<VaultItemMetadata, "fields">,
    fieldId: string,
  ): string | undefined {
    return savedDetailLinks(policy, owner, "secret-answer").find(
      (link) =>
        link.source.itemId === owner.itemId &&
        resolveDetailSourceField(link.source.field, item.fields) === fieldId,
    )?.question;
  }
  /**
   * Which of `sources` is the question the page asks beside `target` (ADR 0061), each by
   * what `askOf` gives, which the document compares with its own text, which never leaves
   * it.
   */
  async function askedSource<T extends { ask: AskedQuestion }>(
    live: LiveDocument,
    path: string,
    target: LoginFieldTarget,
    sources: readonly T[],
  ): Promise<T | undefined> {
    const named = sources
      .filter(({ ask }) => ("name" in ask ? ask.name : ask.question).length <= 200)
      .slice(0, 100);
    if (!named.length) return undefined;
    const answer = v.safeParse(
      v.object({
        ok: v.literal(true),
        index: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      }),
      await send(live, {
        type: "login.detail.question",
        path,
        target,
        names: named.map(({ ask }) => ask),
      }).catch(() => undefined),
    );
    return answer.success && answer.output.index !== undefined
      ? named[answer.output.index]
      : undefined;
  }
  /**
   * Whether the page now asks, beside an answer input of `handler`, another of the login
   * item's questions than the one whose answer this login filled (ADR 0061).
   */
  async function asksAnotherQuestion(
    run: Execution,
    handler: DetailHandler,
    answered: DetailSourceField,
  ): Promise<boolean> {
    const authorized = await allowed(run);
    if (!authorized) return false;
    const found = detailOwner(run.metadata.account, authorized.catalog);
    const item = found?.connection.items.find((entry) => entry.id === run.metadata.account.itemId);
    if (!found || !item) return false;
    const answeredId = resolveDetailSourceField(answered, item.fields);
    const questions = detailCandidates(
      authorized.settings,
      authorized.catalog,
      found.connection,
      "secret-answer",
      { host: new URL(run.metadata.account.origin).hostname, loginItemId: item.id },
      Infinity,
    ).flatMap((candidate) => {
      const name = item.fields.find((entry) => entry.id === candidate.fieldId)?.name;
      const question = confirmedQuestion(authorized.settings, found.owner, item, candidate.fieldId);
      return name ? [{ fieldId: candidate.fieldId, ask: askOf(name, question) }] : [];
    });
    for (const field of handler.fields) {
      if (field.detail !== "secret-answer" || "parts" in field) continue;
      // eslint-disable-next-line no-await-in-loop
      const asked = await askedSource(run.live, handler.path, field.target, questions);
      if (asked) return asked.fieldId !== answeredId;
    }
    return false;
  }
  /**
   * Keeps the `detail` handler a login stopped at for want of a link, so the popup can
   * propose vault fields for it while the tab shows this document (ADR 0061), with the
   * judge's pairing of each answer input with one of the item's fields, when this login's
   * judgement of the page made one.
   */
  async function offerDetails(run: Execution, handler: DetailHandler, index: number) {
    const paired = run.paired?.path === handler.path ? run.paired.questions : [];
    const asked = handler.fields
      .filter((field) => !manualDetails.includes(field.detail))
      .map((field) => {
        const pairing =
          field.detail === "secret-answer" && !("parts" in field)
            ? paired.find((entry) => sameLoginTarget(entry.target, field.target))
            : undefined;
        return pairing
          ? {
              ...field,
              paired: { field: pairing.field, question: pairing.question, shown: pairing.shown },
            }
          : field;
      });
    if (!asked.length) return;
    await sessionLoaded;
    detailOffers.set(run.live.document.tabId, {
      document: run.live.document,
      // The handler's path, which the page showed: `run.live.path` may lag a same-document
      // URL change.
      path: handler.path,
      attemptId: run.metadata.id,
      handler: index,
      account: {
        connectionId: run.metadata.account.connectionId,
        itemId: run.metadata.account.itemId,
        origin: run.metadata.account.origin,
      },
      fields: asked,
      target: handler.target,
    });
    await quietly(saveSession);
  }
  /**
   * The saved link a login filled an entered `detail` handler's input from, by handler, for
   * removal once the site refused the value (ADR 0061).
   */
  function filledDetails(
    run: Execution,
  ): { handler: number; detail: LoginDetail; field?: DetailSourceField }[] {
    return run.metadata.handlers.flatMap(
      (entry): { handler: number; detail: LoginDetail; field?: DetailSourceField }[] => {
        const handler = run.recipe.handlers?.[entry.index];
        if (handler?.kind !== "detail" || entry.field === undefined) return [];
        const field = handler.fields[entry.field];
        if (field?.detail !== "secret-answer")
          return field ? [{ handler: entry.index, detail: field.detail }] : [];
        // An answer is refused per question; one whose question is unknown here keeps it.
        const answered = run.answers?.get(entry.index);
        return answered === undefined
          ? []
          : [{ handler: entry.index, detail: field.detail, field: answered }];
      },
    );
  }
  /**
   * Writes `mutate` to the settings unless another tab's login is in progress, whose
   * policy revision the write would bump (ADR 0022). Returns whether it wrote.
   */
  async function writeDetailLinks(
    run: Execution | undefined,
    mutate: (links: DetailLink[]) => DetailLink[],
  ): Promise<"saved" | "unchanged" | "busy" | "failed"> {
    if (!settings.update) return "failed";
    if (attempts.values().some((other) => other !== run && inProgress(other))) return "busy";
    // A login another tab is admitting waits for this write from here, before any await,
    // as for an account choice (see `admit`).
    const { promise: saving, resolve: finish } = Promise.withResolvers<void>();
    savingChoices.add(saving);
    let writing = false;
    try {
      const latest = await settings
        .handle({ version: 1, type: "settings.get" })
        .catch(() => undefined);
      if (!latest?.ok) return "failed";
      const before = latest.snapshot.settings.detailLinks ?? [];
      if (JSON.stringify(mutate(before)) === JSON.stringify(before)) return "unchanged";
      writing = true;
      return await settings
        .update(latest.snapshot.revision, "detail-link", (snapshot) => ({
          ...snapshot,
          settings: {
            ...snapshot.settings,
            detailLinks: mutate(snapshot.settings.detailLinks ?? []),
          },
        }))
        .then(
          () => "saved" as const,
          () => "failed" as const,
        );
    } finally {
      if (writing) remembered += 1;
      savingChoices.delete(saving);
      finish();
    }
  }
  /**
   * Whether `link` is the login item's link for `detail`; for a secret question's answer,
   * the one for `field`, or any of them without one.
   */
  const sameLink = (
    link: DetailLink,
    owner: DetailOwner,
    detail: LoginDetail,
    field?: DetailSourceField,
  ) =>
    link.origin === owner.origin &&
    link.provider === owner.provider &&
    link.userId === owner.userId &&
    link.itemId === owner.itemId &&
    link.detail === detail &&
    (detail !== "secret-answer" ||
      field === undefined ||
      sourceFieldKey(link.source.field) === sourceFieldKey(field));
  /** Whether two of a login item's answer links hold the same confirmed question. */
  const sameQuestion = (link: DetailLink, other: DetailLink) =>
    link.question !== undefined &&
    link.question === other.question &&
    sameLink(link, other, "secret-answer");
  /**
   * Removes the links whose values a login filled once the site refused them, as when the
   * handler's page showed again or the login was rejected, so the next login asks again
   * rather than submitting the same value (ADR 0061).
   */
  async function forgetDetail(run: Execution, kept: ReadonlySet<number> = new Set()) {
    if (run.detailsForgotten) return;
    const filled = filledDetails(run).filter((entry) => !kept.has(entry.handler));
    if (!filled.length) return;
    run.detailsForgotten = true;
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    const found = snapshot?.ok ? detailOwner(run.metadata.account, snapshot.catalog) : undefined;
    const { document } = run.live;
    if (!found) {
      for (const entry of filled) reportDetail(document, run.recipe, entry.handler, "detail-kept");
      return;
    }
    // No login uses a refused link from here, even one the settings still hold.
    await sessionLoaded;
    for (const entry of filled)
      refusedDetails.set(refusalKey(found.owner, entry.detail, entry.field), {
        ...found.owner,
        detail: entry.detail,
        ...(entry.field === undefined ? {} : { field: entry.field }),
      });
    await quietly(saveSession);
    const written = await removeRefused(run);
    for (const entry of filled)
      reportDetail(
        document,
        run.recipe,
        entry.handler,
        written === "saved" || written === "unchanged" ? "detail-forgotten" : "detail-kept",
      );
  }
  /** Removes the refused links from the owner's settings, when no other login runs. */
  async function removeRefused(run?: Execution) {
    const refused = [...refusedDetails.values()];
    if (!refused.length) return "unchanged" as const;
    const written = await writeDetailLinks(run, (links) =>
      links.filter(
        (link) => !refused.some((entry) => sameLink(link, entry, entry.detail, entry.field)),
      ),
    );
    if (written === "saved" || written === "unchanged") {
      for (const entry of refused)
        refusedDetails.delete(refusalKey(entry, entry.detail, entry.field));
      await quietly(saveSession);
    }
    return written;
  }
  /**
   * After a login is confirmed `authenticated`, saves the links its tab filled from the
   * popup (ADR 0061); after any other ending they are dropped, as an unconfirmed account
   * choice is (ADR 0023).
   */
  async function settleDetails(run: Execution, confirmed: boolean): Promise<void> {
    const { tabId } = run.live.document;
    await sessionLoaded;
    // The offer ends with its login, also when the person typed the value themselves and
    // the page stays in the same document.
    const offered = detailOffers.get(tabId)?.attemptId === run.metadata.id;
    if (offered) detailOffers.delete(tabId);
    const kept = pendingDetails.get(tabId)?.filter((entry) => entry.attemptId === run.metadata.id);
    if (!kept?.length) {
      if (offered) await quietly(saveSession);
      return;
    }
    const rest = pendingDetails.get(tabId)!.filter((entry) => entry.attemptId !== run.metadata.id);
    if (rest.length) pendingDetails.set(tabId, rest);
    else pendingDetails.delete(tabId);
    await quietly(saveSession);
    if (!confirmed) return;
    // A confirmed question replaces the link that held it, so one page's question never
    // matches two fields.
    const written = await writeDetailLinks(run, (links) => [
      ...links.filter(
        (link) =>
          !kept.some(
            (entry) =>
              sameLink(link, entry.link, entry.link.detail, entry.link.source.field) ||
              sameQuestion(link, entry.link),
          ),
      ),
      ...kept.map((entry) => entry.link),
    ]);
    // A link the owner chose again replaces one refused before, once it is written: until
    // then the settings may still hold the refused one. The session keeps the refusals, so
    // a restarted worker does not bring a lifted one back.
    if (written === "saved" || written === "unchanged") {
      const lifted = kept.filter(({ link }) =>
        refusedDetails.delete(refusalKey(link, link.detail, link.source.field)),
      );
      if (lifted.length) await quietly(saveSession);
    }
    for (const entry of kept)
      reportDetail(
        run.live.document,
        run.recipe,
        entry.handler,
        written === "saved" || written === "unchanged" ? "detail-saved" : "detail-not-saved",
      );
  }
  /**
   * The vault values a detail's value is made from (`detailFieldIds`), read one after
   * another from `itemId`; undefined when any read fails.
   */
  async function readDetail(
    login: LoginAccount,
    connection: VaultConnectionMetadata,
    detail: LoginDetail,
    itemId: string,
    fieldId: string,
  ): Promise<[string, ...string[]] | undefined> {
    const read: string[] = [];
    for (const id of detailFieldIds(detail, fieldId)) {
      let value: string | undefined;
      try {
        // eslint-disable-next-line no-await-in-loop
        value = await fields({ account: { ...login, itemId }, connection, fieldId: id });
      } catch {
        value = undefined;
      }
      if (value === undefined) {
        read.fill("");
        return undefined;
      }
      read.push(value);
    }
    return read as [string, ...string[]];
  }
  /**
   * The value an entered `detail` handler's fill types (ADR 0061): read from the linked
   * field and made into what the input asks for, in this worker, so the whole phone number
   * never reaches the page, nor the whole card number except for a `card-number` input.
   * A card code fills only a password or short numeric input; a secret question's answer
   * only while the page still asks its field's question.
   */
  async function detailFill(
    run: Execution,
    authorized: Authorized,
    stepIndex: number,
  ): Promise<
    | (Omit<DetailFillValue, "secret"> & { secret?: LoginSecretKind; question?: AskedQuestion })[]
    | "unreadable"
    | "unavailable"
    | "unfit"
  > {
    const index = attemptPlan(run.recipe, run.metadata)?.[stepIndex]?.handler;
    const handler = index === undefined ? undefined : run.recipe.handlers?.[index];
    const at = run.metadata.handlers.find((entry) => entry.index === index)?.field;
    const field = handler?.kind === "detail" && at !== undefined ? handler.fields[at] : undefined;
    const found = detailOwner(run.metadata.account, authorized.catalog);
    if (!field || !found || index === undefined || handler?.kind !== "detail") return "unavailable";
    let source: { itemId: string; fieldId: string } | undefined;
    let question: { field: DetailSourceField; ask: AskedQuestion } | undefined;
    if (field.detail === "secret-answer") {
      if ("parts" in field) return "unavailable";
      const asked = await askedSource(
        run.live,
        handler.path,
        field.target,
        answerSources(authorized, found),
      );
      if (!current(run)) return "unavailable";
      source = asked?.source;
      question = asked && { field: asked.link.source.field, ask: asked.ask };
    } else {
      const link = savedDetailLink(authorized.settings, found.owner, field.detail);
      source =
        link && !refusedDetails.has(refusalKey(found.owner, field.detail))
          ? linkedField(authorized.settings, authorized.catalog, found.connection, link)
          : undefined;
    }
    if (!source) return "unavailable";
    // Never a re-prompt item's value before the login holds the master password, which
    // `detailInput` asks for instead of choosing such an input.
    const sourceItem = found.connection.items.find((entry) => entry.id === source.itemId);
    if (
      sourceItem &&
      waitsForMasterPassword(
        authorized.settings,
        sourceItem,
        found.owner.itemId,
        detailSite(run.metadata.id, found.connection.id, run.live.url),
      )
    )
      return "unavailable";
    const read = await readDetail(
      run.metadata.account,
      authorized.connection,
      field.detail,
      source.itemId,
      source.fieldId,
    );
    if (read === undefined) return "unavailable";
    if (question && !("parts" in field)) {
      const value = detailValue(field.detail, field.format, read[0]);
      read.fill("");
      if (value === undefined) return "unreadable";
      // Refused, the answer's link is removed by its question field.
      (run.answers ??= new Map()).set(index, question.field);
      return [{ value, secret: "answer", question: question.ask }];
    }
    // An answer always goes with its question. A split value is made into all its parts
    // here, right after the read (ADR 0061).
    if (field.detail === "secret-answer") {
      read.fill("");
      return "unavailable";
    }
    const values = detailFieldValues(field, read[0], read[1]);
    read.fill("");
    return values ?? "unreadable";
  }
  /** The tab's page, when it is an HTTP(S) page the popup has a section for. */
  async function popupPage(tabId: number) {
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    const page = tab?.url ? (URL.parse(tab.url) ?? undefined) : undefined;
    return page?.protocol === "https:" || page?.protocol === "http:"
      ? { url: page, title: tab?.title }
      : undefined;
  }
  /** The tab's offer while the tab still shows its document on the page's origin. */
  function shownOffer(tabId: number, pageOrigin: string): DetailOffer | undefined {
    const offer = detailOffers.get(tabId);
    const live = offer && documents.get(frameKey(offer.document));
    // An offer belongs to the tab's login that stopped at it, not to a later one.
    return offer &&
      offer.account.origin === pageOrigin &&
      live?.document.documentId === offer.document.documentId &&
      tabAttempt(tabId)?.id === offer.attemptId
      ? offer
      : undefined;
  }
  /** The login item whose links the popup shows for the tab: its offer's, or its login's. */
  function detailAccount(tabId: number, pageOrigin: string) {
    return shownOffer(tabId, pageOrigin)?.account ?? recordFor(tabId, pageOrigin)?.account;
  }
  /**
   * Which of `candidates`, the login item's answer fields, the popup offers for an answer
   * input (ADR 0061), with what the page must show beside it for the fill (`askOf`): the
   * field whose name, or whose confirmed question, the page shows there; or else the field
   * the judge paired with the input, while the page still shows the paired question there
   * as one whole question, with that question for the owner to confirm and as the page
   * showed it (`shown`).
   */
  async function answerCandidate<T extends { itemId: string; fieldId: string }>(
    live: LiveDocument,
    path: string,
    field: Extract<DetailOffer["fields"][number], { target: LoginFieldTarget }>,
    found: NonNullable<ReturnType<typeof detailOwner>>,
    policy: Pick<LocalSettings, "detailLinks">,
    candidates: readonly T[],
  ): Promise<{ candidate: T; ask: AskedQuestion; question?: string; shown?: string } | undefined> {
    const item = found.connection.items.find((entry) => entry.id === found.owner.itemId);
    if (!item) return undefined;
    const named = candidates.flatMap((candidate) => {
      const name =
        candidate.itemId === item.id
          ? item.fields.find((entry) => entry.id === candidate.fieldId)?.name
          : undefined;
      const question = name
        ? confirmedQuestion(policy, found.owner, item, candidate.fieldId)
        : undefined;
      return name ? [{ candidate, ask: askOf(name, question) }] : [];
    });
    const asked = await askedSource(live, path, field.target, named);
    if (asked) return { candidate: asked.candidate, ask: asked.ask };
    const { paired } = field;
    const pairing =
      paired &&
      named.find((entry) => {
        const reference = customFieldReference(item.fields, entry.candidate.fieldId);
        return reference && sourceFieldKey(reference) === sourceFieldKey(paired.field);
      });
    if (!paired || !pairing) return undefined;
    // Nothing fuzzy: the question the judge copied must be one whole question beside the
    // input, never a part of one, such as its label.
    const ask = { question: paired.question };
    const shown = await askedSource(live, path, field.target, [{ ask }]);
    return shown
      ? { candidate: pairing.candidate, ask, question: paired.question, shown: paired.shown }
      : undefined;
  }
  /**
   * The popup's card candidates in the order of `rankCards` (ADR 0061, owner 2026-10-23
   * 12:26 UTC): the document answers which last four digits and brand it shows beside
   * `target` (the digits in its title too), then each candidate card's number and brand,
   * the first `MAX_CARD_GUESS_READS` cards, are read one at a time, as a fill reads them,
   * and only their last four digits and brand are kept until the ranking. Neither the
   * page's answer nor a value is sent or logged. The site and the login item must still be
   * allowed, as for a fill. A page that shows nothing reads nothing; a field without a
   * value is unknown; a read that throws, or a vault that locks or changes during the
   * reads, keeps the order by name. The result is kept for the offer's input as its order
   * of item IDs and whether it selects, so the popup's polls read the vault again only
   * when the page's answer, the settings or the vault change, and an answer that fails
   * keeps the last result.
   */
  async function guessCard<T extends { itemId: string }>(
    live: LiveDocument,
    offer: DetailOffer,
    target: LoginFieldTarget,
    snapshot: { settings: LocalSettings; revision: number },
    catalog: VaultCatalog,
    candidates: T[],
  ): Promise<{ candidates: T[]; preselect: boolean }> {
    const policy = snapshot.settings;
    let byName = { candidates, preselect: true };
    const connection = catalog.connections.find((entry) => entry.id === offer.account.connectionId);
    if (
      !connection ||
      (connection.state !== "ready" && connection.state !== "review-required") ||
      isSiteExcluded(policy, offer.account.origin) ||
      !isSiteAllowed(policy, offer.account.origin) ||
      !getItemEligibility(policy, catalog, connection.id, offer.account.itemId).eligible
    )
      return byName;
    const items = [...new Set(candidates.map((entry) => entry.itemId))];
    // A card with Bitwarden's re-prompt is never read for the guess while the login does not
    // hold the master password: it stays a candidate, not read, so the guess selects none,
    // even by name, and its Fill asks (owner, 2026-10-23 21:50 UTC).
    const site = detailSite(offer.attemptId, connection.id, live.url);
    const readable = items.filter((itemId) => {
      const item = connection.items.find((entry) => entry.id === itemId);
      return !item || !waitsForMasterPassword(policy, item, offer.account.itemId, site);
    });
    if (readable.length < items.length) byName = { candidates, preselect: false };
    const slot = `${offer.attemptId} ${offer.document.documentId} ${JSON.stringify(target)}`;
    // Whether the login holds the master password changes which cards are read.
    const holds = repromptTyped.get(offer.attemptId) === connection.id;
    const vault = `${snapshot.revision} ${connection.snapshotId ?? ""} ${items.join(",")} ${holds}`;
    const kept = cardGuesses.get(slot);
    const apply = (guess: { order: readonly string[]; preselect: boolean }) => ({
      candidates: [
        ...guess.order.flatMap((id) => candidates.filter((entry) => entry.itemId === id)),
        ...candidates.filter((entry) => !guess.order.includes(entry.itemId)),
      ],
      preselect: guess.preselect,
    });
    const answer = v.safeParse(
      v.object({
        ok: v.literal(true),
        last4: v.pipe(
          v.array(v.pipe(v.string(), v.regex(/^\d{4}$/u))),
          v.maxLength(MAX_CARD_LAST_4),
        ),
        brands: v.pipe(v.array(v.picklist(cardBrands)), v.maxLength(cardBrands.length)),
      }),
      await send(live, { type: "login.detail.card", path: offer.path, target }).catch(
        () => undefined,
      ),
    );
    // The page did not answer: the last result for this input, while the vault is the same.
    if (!answer.success) return kept?.vault === vault ? apply(kept) : byName;
    const hints = answer.output;
    // Only a digest of the page's answer is kept, never its digits.
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([[...hints.last4].sort(), hints.brands])),
      ),
    );
    const key = `${vault} ${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (kept?.key === key) {
      hints.last4.fill("");
      return apply(kept);
    }
    const keepGuess = (guess: { candidates: T[]; preselect: boolean }) => {
      cardGuesses.delete(slot);
      // A few inputs' results at most; the oldest goes first.
      if (cardGuesses.size >= 32) cardGuesses.delete(cardGuesses.keys().next().value!);
      cardGuesses.set(slot, {
        key,
        vault,
        order: guess.candidates.map((entry) => entry.itemId),
        preselect: guess.preselect,
      });
      return guess;
    };
    if (!hints.last4.length && !hints.brands.length) return keepGuess(byName);
    const facts = new Map<string, CardFacts>();
    let gave = false;
    try {
      for (const itemId of readable.slice(0, MAX_CARD_GUESS_READS)) {
        const held: CardFacts = {};
        for (const fieldId of cardGuessFields(policy, catalog, connection, itemId)) {
          let value: string | undefined;
          try {
            // Serial reads through the shared vault host, as for a fill.
            // eslint-disable-next-line no-await-in-loop
            value = await fields({ account: { ...offer.account, itemId }, connection, fieldId });
          } catch {
            return byName;
          }
          // A card without a number or a brand gives nothing for that field.
          gave ||= value !== undefined;
          if (value !== undefined && fieldId === "card.number") held.last4 = cardLast4(value);
          else if (value !== undefined) held.brand = cardBrandOf(value);
          value = "";
        }
        facts.set(itemId, held);
      }
      // A read gives nothing too when the vault is locked or changed meanwhile, which is no
      // field without a value: no read giving a value reads as a locked vault, and the
      // guess is kept only while the vault is still the same.
      if (!gave) return byName;
      const after = await settings
        .handle({ version: 1, type: "settings.get" })
        .catch(() => undefined);
      const now = after?.ok
        ? after.catalog.connections.find((entry) => entry.id === connection.id)
        : undefined;
      if (
        !after?.ok ||
        after.snapshot.revision !== snapshot.revision ||
        !now ||
        now.state !== connection.state ||
        now.snapshotId !== connection.snapshotId
      )
        return byName;
      return keepGuess(rankCards(candidates, facts, hints));
    } finally {
      facts.clear();
      hints.last4.fill("");
    }
  }
  /**
   * What the popup shows about a page's personal details (ADR 0061): the handler the tab's
   * login stopped at with the fields that could give each detail, and the site's links for
   * the login item, by their names in the device's catalog only.
   */
  async function popupDetail(tabId: number): Promise<DetailResponse> {
    const page = await popupPage(tabId);
    if (!page) return { ok: false, reason: "no-page" };
    const pageOrigin = page.url.origin;
    await sessionLoaded;
    const login = detailAccount(tabId, pageOrigin);
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    const found = login && snapshot?.ok ? detailOwner(login, snapshot.catalog) : undefined;
    if (!found || !snapshot?.ok) return { ok: true, origin: pageOrigin, links: [] };
    const policy = snapshot.snapshot.settings;
    const { catalog } = snapshot;
    const offer = shownOffer(tabId, pageOrigin);
    const live = offer && documents.get(frameKey(offer.document));
    const details = [];
    for (const [at, field] of (offer?.fields ?? []).entries()) {
      if (offer!.fields.findIndex((other) => other.detail === field.detail) !== at) continue;
      // Every card is ranked, so one past the popup's list counts against a selection.
      let candidates = detailCandidates(
        policy,
        catalog,
        found.connection,
        field.detail,
        { host: page.url.hostname, title: page.title, loginItemId: found.owner.itemId },
        isCardDetail(field.detail) ? Infinity : MAX_DETAIL_CANDIDATES,
      );
      // A secret question's answer is offered only from the field named as the page's
      // question, or confirmed for it, which the document finds; or from the field the
      // judge paired with it, with the question for the owner to confirm.
      let question: string | undefined;
      if (field.detail === "secret-answer") {
        const asked =
          live &&
          !("parts" in field) &&
          // eslint-disable-next-line no-await-in-loop
          (await answerCandidate(live, offer!.path, field, found, policy, candidates));
        candidates = asked ? [asked.candidate] : [];
        // The popup shows the question as the page showed it.
        question = asked ? asked.shown : undefined;
      }
      // A card is guessed from the last digits and brand the page shows too, beside a split
      // value's first input.
      let preselect = field.detail !== "member-id";
      if (live && isCardDetail(field.detail) && candidates.length > 1) {
        // eslint-disable-next-line no-await-in-loop
        const guess = await guessCard(
          live,
          offer!,
          "parts" in field ? field.parts[0]!.target : field.target,
          snapshot.snapshot,
          catalog,
          candidates,
        );
        ({ candidates } = guess);
        preselect &&= guess.preselect;
      }
      candidates = candidates.slice(0, MAX_DETAIL_CANDIDATES);
      // A split birth date is named as the one input it reads as (ADR 0061).
      const format = detailFieldFormat(field);
      if (candidates.length)
        details.push({
          detail: field.detail,
          ...(format ? { format } : {}),
          candidates: candidates as [(typeof candidates)[number], ...typeof candidates],
          // A member ID's fields' names say little, and two cards may show the same last
          // digits, so none is chosen for the owner.
          ...(preselect ? {} : { preselect: false as const }),
          ...(question ? { question } : {}),
        });
    }
    const kept = pendingDetails.get(tabId) ?? [];
    const label = (detail: LoginDetail, itemId: string, field: DetailLink["source"]["field"]) => {
      const item = found.connection.items.find((entry) => entry.id === itemId);
      const fieldId = item && resolveDetailSourceField(field, item.fields);
      return {
        itemLabel: item?.label ?? "An item no longer in the vault",
        fieldLabel:
          item && fieldId
            ? detailFieldLabel(detail, fieldId, item)
            : "A field no longer in the item",
      };
    };
    // One row per detail; a secret question's answers, one link per question, share one.
    const links = loginDetailSchema.options.flatMap((detail) => {
      const waiting = kept
        .filter((entry) => sameLink(entry.link, found.owner, detail))
        .map((entry) => entry.link);
      const all = [
        ...waiting,
        ...savedDetailLinks(policy, found.owner, detail).filter(
          (link) => !waiting.some((other) => sameLink(link, other, detail, other.source.field)),
        ),
      ];
      const first = all[0];
      if (!first) return [];
      return [
        {
          detail,
          ...label(detail, first.source.itemId, first.source.field),
          ...(all.length > 1 ? { fieldLabel: `${all.length} questions` } : {}),
          ...(waiting.length ? { pending: true as const } : {}),
        },
      ];
    });
    return {
      ok: true,
      origin: pageOrigin,
      ...(offer && details.length
        ? {
            offer: {
              documentId: offer.document.documentId,
              details: details as [(typeof details)[number], ...typeof details],
            },
          }
        : {}),
      links,
    };
  }
  /**
   * The popup's **Fill** (ADR 0061): fills the offer's input with the value made from the
   * chosen field, after its choosing radio, without pressing the button, and keeps the link
   * for the tab until its login is confirmed.
   */
  async function popupDetailFill(
    request: v.InferOutput<typeof detailFillRequestSchema>,
    /**
     * `asked` once the window asked for the master password; `targets` for the fill after
     * a login's own ask, which names the field it stopped at among those of the detail.
     */
    within: { asked?: boolean; targets?: LoginFieldTarget[] } = {},
  ): Promise<DetailFillResponse> {
    await sessionLoaded;
    const offer = detailOffers.get(request.tabId);
    const live = offer && documents.get(frameKey(offer.document));
    if (
      !offer ||
      offer.document.documentId !== request.documentId ||
      live?.document.documentId !== offer.document.documentId ||
      tabAttempt(request.tabId)?.id !== offer.attemptId
    )
      return { ok: false, reason: "document-gone" };
    const field = offer.fields.find(
      (entry) =>
        entry.detail === request.detail &&
        (within.targets === undefined ||
          sameInputs(
            detailFieldInputs(entry).map((input) => input.target),
            within.targets,
          )),
    );
    if (!field) return { ok: false, reason: "not-a-candidate" };
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return { ok: false, reason: "unavailable" };
    // The site and the login item may have been excluded since the login stopped.
    if (
      isSiteExcluded(snapshot.snapshot.settings, offer.account.origin) ||
      !isSiteAllowed(snapshot.snapshot.settings, offer.account.origin) ||
      !getItemEligibility(
        snapshot.snapshot.settings,
        snapshot.catalog,
        offer.account.connectionId,
        offer.account.itemId,
      ).eligible
    )
      return { ok: false, reason: "unavailable" };
    const found = detailOwner(offer.account, snapshot.catalog);
    if (!found || found.connection.id !== request.connectionId)
      return { ok: false, reason: "not-a-candidate" };
    const offered = detailCandidates(
      snapshot.snapshot.settings,
      snapshot.catalog,
      found.connection,
      field.detail,
      { host: new URL(offer.account.origin).hostname, loginItemId: offer.account.itemId },
      Infinity,
    );
    const chosen = offered.find(
      (entry) => entry.itemId === request.itemId && entry.fieldId === request.fieldId,
    );
    if (!chosen) return { ok: false, reason: "not-a-candidate" };
    // An item with Bitwarden's re-prompt is read only once the login holds the master
    // password; the window asks first, and then every check above is made again (owner,
    // 2026-10-23 21:50 UTC).
    const chosenItem = found.connection.items.find((entry) => entry.id === request.itemId);
    if (
      chosenItem &&
      waitsForMasterPassword(
        snapshot.snapshot.settings,
        chosenItem,
        offer.account.itemId,
        detailSite(offer.attemptId, found.connection.id, live.url),
      )
    ) {
      if (within.asked || !(await askDetailPassword(offer, found.connection, chosenItem)))
        return { ok: false, reason: "no-master-password" };
      return popupDetailFill(request, { ...within, asked: true });
    }
    // A secret question's answer goes only under the page's own question: its field's name
    // or the question confirmed for it, or, confirmed by this Fill, the question the judge
    // paired with the field (ADR 0061).
    const answer =
      field.detail === "secret-answer" && !("parts" in field)
        ? await answerCandidate(live, offer.path, field, found, snapshot.snapshot.settings, [
            chosen,
          ])
        : undefined;
    if (field.detail === "secret-answer" && !answer)
      return { ok: false, reason: "not-a-candidate" };
    const item = found.connection.items.find((entry) => entry.id === request.itemId);
    const reference = request.fieldId.startsWith("custom.")
      ? item && customFieldReference(item.fields, request.fieldId)
      : request.fieldId;
    const source = v.safeParse(detailLinkSchema.entries.source.entries.field, reference);
    if (!source.success) return { ok: false, reason: "not-a-candidate" };
    // The page must still show the handler: its inputs writable, a split date's selects
    // choosable (ADR 0061), and its button shown.
    const targets = detailFieldInputs(field).map((input) => input.target);
    const observed = v.safeParse(
      observationSchema,
      await send(live, {
        type: "login.observe",
        path: offer.path,
        targets: [...targets, offer.target],
        require: [...targets.map(() => "settable" as const), "shown"],
      }).catch(() => undefined),
    );
    if (
      !observed.success ||
      observed.output.path !== offer.path ||
      observed.output.targets.some((state) => state !== "unique")
    )
      return { ok: false, reason: "document-gone" };
    // The value goes only to the login item's account when the page shows one, as a login's
    // fill does (owner decision, 2026-10-11); the page compares it in the content script.
    const usernameField = loginUsernameFieldId(found.connection, offer.account.itemId);
    let username: string | undefined;
    if (usernameField)
      try {
        username = await fields({
          account: offer.account,
          connection: found.connection,
          fieldId: usernameField,
        });
      } catch {
        username = undefined;
      }
    const own = username ? { username } : undefined;
    username = "";
    const read = await readDetail(
      offer.account,
      found.connection,
      field.detail,
      request.itemId,
      request.fieldId,
    );
    if (read === undefined) return { ok: false, reason: "unavailable" };
    // An answer goes only with its question; every other value, a split one's parts
    // included, is made here right after the read.
    const values =
      field.detail === "secret-answer" && !("parts" in field)
        ? ((value) =>
            value === undefined || !answer
              ? undefined
              : [{ value, secret: "answer" as const, question: answer.ask }])(
            detailValue(field.detail, field.format, read[0]),
          )
        : detailFieldValues(field, read[0], read[1]);
    read.fill("");
    if (values === undefined || values === "unfit") return { ok: false, reason: "unreadable" };
    const command = {
      type: "login.detail.fill",
      path: offer.path,
      fields: values.map((entry, at) => ({ ...entry, target: targets[at]! })),
      ...(own ? { account: own } : {}),
    };
    const response = await send(live, command).catch(() => undefined);
    for (const entry of [...values, ...command.fields]) entry.value = "";
    if (own) own.username = "";
    if (
      v.safeParse(v.object({ ok: v.literal(false), reason: v.literal("other-account") }), response)
        .success
    )
      return { ok: false, reason: "other-account" };
    if (!v.safeParse(v.object({ ok: v.literal(true) }), response).success)
      return { ok: false, reason: "not-filled" };
    const link: DetailLink = {
      ...found.owner,
      detail: field.detail,
      source: { itemId: request.itemId, field: source.output },
      // The owner confirmed the judge's pairing: later logins look for the stored question.
      ...(answer?.question ? { question: answer.question } : {}),
    };
    pendingDetails.set(request.tabId, [
      // One link per handler: a second Fill, as after choosing another radio, replaces
      // the first, so only the value last filled is saved; a secret question's answers,
      // one per question.
      ...(pendingDetails.get(request.tabId) ?? []).filter(
        (entry) =>
          !sameLink(entry.link, found.owner, field.detail, link.source.field) &&
          !sameQuestion(entry.link, link) &&
          !(
            entry.attemptId === offer.attemptId &&
            entry.handler === offer.handler &&
            field.detail !== "secret-answer"
          ),
      ),
      {
        tabId: request.tabId,
        attemptId: offer.attemptId,
        handler: offer.handler,
        connectionId: found.connection.id,
        link,
      },
    ]);
    await quietly(saveSession);
    return { ok: true };
  }
  /** The popup's **Remove** (ADR 0061): drops the site's link for a detail, kept or saved. */
  async function popupDetailRemove(
    tabId: number,
    detail: LoginDetail,
  ): Promise<DetailRemoveResponse> {
    const page = await popupPage(tabId);
    await sessionLoaded;
    const login = page && detailAccount(tabId, page.url.origin);
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    const found = login && snapshot?.ok ? detailOwner(login, snapshot.catalog) : undefined;
    if (!found || !snapshot?.ok) return { ok: false, reason: "no-link" };
    const kept = pendingDetails.get(tabId) ?? [];
    const rest = kept.filter((entry) => !sameLink(entry.link, found.owner, detail));
    if (rest.length !== kept.length) {
      if (rest.length) pendingDetails.set(tabId, rest);
      else pendingDetails.delete(tabId);
      await quietly(saveSession);
      return { ok: true };
    }
    // A secret question's answers go together, as the popup shows them in one row.
    if (!savedDetailLinks(snapshot.snapshot.settings, found.owner, detail).length)
      return { ok: false, reason: "no-link" };
    const written = await writeDetailLinks(undefined, (links) =>
      links.filter((link) => !sameLink(link, found.owner, detail)),
    );
    return written === "saved" || written === "unchanged"
      ? { ok: true }
      : { ok: false, reason: "not-saved" };
  }
  /**
   * Enters a handler of the recipe on this path all of whose elements show (ADR 0027).
   * Several shown: the first not yet entered whose fact the item has, a `passkey` handler
   * before a `totp` handler, as the routes put the passkey first and it types nothing. A
   * `totp` handler is never entered by a login that already types a code, and needs the
   * item's code field (`codeFieldOf`). Returns whether the attempt moved on: to the handler's
   * steps, or to `challenge` when no shown handler qualifies or the attempt's budget has
   * no room for it. At a login's stop before its item's missing password (`stop`, ADR
   * 0036), only a `passkey` handler is entered, before the stop step, and the login ends
   * there with `stop.end` instead. A `password` handler goes first, and only for a login
   * that types its password and has not filled it yet; one shown but refused ends the login
   * as `challenge` rather than letting another handler beside it be entered (ADR 0048).
   */
  async function enterHandler(
    run: Execution,
    path: string,
    stop?: { end: () => Promise<void> },
  ): Promise<boolean> {
    // A fresh handler's elements must be usable: its code field a shown writable input and
    // its button shown, enabled or not, as a Verify button disabled until the code is typed
    // is; so a hidden code input rendered with the sign-in form never stands for a code
    // page. The click step itself waits for the button to be enabled. A `totp` handler whose
    // button is also a route step's on this path, as in a form that asks for the code after
    // the password, needs every fill field of the route there gone: while one shows, the
    // page is still the sign-in page. A handler that already ran counts as shown again
    // whenever its elements are there, hidden or disabled, so it never runs twice; only in
    // the document that holds its click is one the page hid gone instead.
    const routeFields = passwordVariants(run.recipe)
      .flatMap((variant) => variant.steps)
      .filter((step) => step.path === path)
      .flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.target) : []))
      .filter(
        (target, index, all) => all.findIndex((other) => sameLoginTarget(other, target)) === index,
      );
    const routeClicks = passwordVariants(run.recipe)
      .flatMap((variant) => variant.steps)
      .filter((step) => step.path === path)
      .flatMap((step) => (step.kind === "click" ? [step.target] : []));
    // A login that may still type its password, on the `password` route without a stop, never
    // enters a `passkey` handler on a path where its plan still has a route step to run that
    // fills the password, nor while a fill field of the route shows on this path, as one
    // learned beside the password field at another login's stop (ADR 0036): the button never
    // pre-empts the password it types, even while the page swaps its identifier for its
    // password field. A route step still to run that fills only another slot, as a code on
    // the page after the password, does not keep it out. A login with a stop, recorded when
    // it started and kept whatever the vault later holds, never types it.
    const typesPassword = run.metadata.route === "password" && run.metadata.stopAt === undefined;
    // The first plan step not yet run: the one after the step in flight, or the current one.
    const unrun =
      run.metadata.operationId === undefined ? run.metadata.stepIndex : run.metadata.stepIndex + 1;
    const plan = attemptPlan(run.recipe, run.metadata) ?? [];
    const passwordAhead =
      typesPassword &&
      plan.some(
        (entry, index) =>
          index >= unrun &&
          entry.handler === undefined &&
          entry.step.kind === "fill" &&
          entry.step.path === path &&
          entry.step.fields.some((field) => field.slot === "password"),
      );
    // A `password` handler's button goes on to the password this login types (ADR 0048): only
    // a login that types it, does not only fill, runs in the tab's top document on the
    // recipe's own origin and has not filled its password yet presses it.
    const choosesPassword =
      typesPassword &&
      run.metadata.fillOnly !== true &&
      run.live.document.frameId === 0 &&
      run.live.topUrl === undefined &&
      run.live.document.origin === run.recipe.origin &&
      !plan.some(
        (entry, index) =>
          index < unrun &&
          entry.step.kind === "fill" &&
          entry.step.fields.some((field) => field.slot === "password"),
      );
    // The handler whose click this document performed and holds: its button the page only
    // hid is gone, as for the hold, not shown again (ADR 0027).
    const held =
      run.heldClick === run.metadata.stepIndex ? plan[run.metadata.stepIndex]?.handler : undefined;
    const entries = (run.recipe.handlers ?? []).flatMap((handler, index) => {
      if (
        handler.path !== path ||
        (stop && handler.kind !== "passkey") ||
        (passwordAhead && handler.kind === "passkey") ||
        (!choosesPassword && handler.kind === "password")
      )
        return [];
      const ran = run.metadata.handlers.some((entered) => entered.index === index);
      // A `password` handler is pressed only while none of the route's fill fields shows on
      // its path: a page that shows one gets it filled instead.
      const sameForm =
        !ran &&
        ((handler.kind === "totp" &&
          routeClicks.some(
            (target) => handler.target !== undefined && sameLoginTarget(target, handler.target),
          )) ||
          (handler.kind === "passkey" && typesPassword) ||
          handler.kind === "password");
      const targets = handlerTargets(handler);
      return [
        {
          handler,
          index,
          targets: [...targets, ...(sameForm ? routeFields : [])],
          require: [
            ...(ran
              ? targets.map(() => (index === held ? ("shown" as const) : ("present" as const)))
              : handler.kind === "totp"
                ? (["writable", "shown"] as const).slice(0, targets.length)
                : handler.kind === "detail"
                  ? // Its inputs present, as a choice page may disable all but one, and its
                    // button shown (ADR 0061).
                    ([...targets.slice(0, -1).map(() => "present" as const), "shown"] as const)
                  : handler.kind === "password"
                    ? // Shown, and its rendered text names the password choice (ADR 0048).
                      (["password-choice"] as const)
                    : (["shown"] as const)),
            ...(sameForm ? routeFields.map(() => "writable" as const) : []),
          ],
          own: targets.length,
        },
      ];
    });
    if (!entries.length) return false;
    // A separate observation, so the recipe's own bound of 24 elements still holds; past it,
    // the handlers that do not fit are not entered.
    let room = 24;
    const observable = entries.filter((entry) => {
      if (entry.targets.length > room) return false;
      room -= entry.targets.length;
      return true;
    });
    if (!observable.length) return false;
    const observed = await observe(
      run,
      observable.flatMap((entry) => entry.targets),
      observable.flatMap((entry) => entry.require),
    );
    if (!observed || observed.path !== path) return false;
    let offset = 0;
    let shown = observable
      .filter((entry) => {
        const states = observed.targets.slice(offset, offset + entry.targets.length);
        offset += entry.targets.length;
        return (
          states.length === entry.targets.length &&
          states.slice(0, entry.own).every((state) => state === "unique") &&
          states.slice(entry.own).every((state) => state !== "unique")
        );
      })
      .sort((left, right) => handlerOrder[left.handler.kind] - handlerOrder[right.handler.kind]);
    if (!shown.length) return false;
    // A `detail` handler learned beside the sign-in form on a route path (ADR 0061) is not
    // entered for the first time while that form shows a failure beside its fields: the
    // password was wrong, and the login ends rejected rather than with the handler.
    if (
      shown.some(
        (entry) =>
          entry.handler.kind === "detail" &&
          !run.metadata.handlers.some((entered) => entered.index === entry.index),
      ) &&
      routeSignInPaths(run.recipe, run.metadata.route).includes(path)
    ) {
      const reading = await readSignInState(run);
      if (!current(run)) return true;
      if (reading?.decision === "rejected") {
        shown = shown.filter(
          (entry) =>
            entry.handler.kind !== "detail" ||
            run.metadata.handlers.some((entered) => entered.index === entry.index),
        );
        if (!shown.length) return false;
      }
    }
    const reportHandler = (
      entry: (typeof entries)[number],
      outcome: Extract<LoginReport, { type: "handler" }>["outcome"],
    ) =>
      report(run.live.document, {
        type: "handler",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: run.recipe.id,
        recipeRevision: run.recipe.revision,
        handler: entry.index,
        kind: entry.handler.kind,
        outcome,
        steps: handlerSteps(entry.handler).length,
      });
    const challenge = () =>
      stop
        ? stop.end()
        : change(run, { type: "OBSERVED", result: "challenge", document: run.live.document });
    // A handler page shown again after its handler ran is left to the person, and so is a
    // second code in one login, so a wrong code or key is never retried into a lockout.
    const refusal = (entry: (typeof entries)[number]) => {
      if (run.metadata.handlers.some((entered) => entered.index === entry.index))
        return "shown-again" as const;
      const { handler } = entry;
      // A `detail` handler fills a value of a vault item linked to the login (ADR 0061):
      // one whose inputs ask only for details Pateat never fills is left to the person as
      // such, and so is one with no linked value for a writable input.
      if (handler.kind === "detail") {
        if (detailPicks.get(entry.index) !== undefined) return undefined;
        if (detailWaits.has(entry.index)) return "detail-reprompt" as const;
        return handler.fields.every((field) => manualDetails.includes(field.detail))
          ? ("detail-manual" as const)
          : ("detail-unlinked" as const);
      }
      const fact = handlerFact[handler.kind];
      if (!run.metadata.facts[fact]) return "missing-fact" as const;
      return handler.kind === "totp" && attemptUsesCode(run.recipe, run.metadata)
        ? ("code-used" as const)
        : undefined;
    };
    // Which input of each shown `detail` handler this login fills: the first with a linked
    // value it may read and that is writable now (ADR 0061).
    const detailPicks = new Map<number, number | undefined>();
    // A handler whose only linked value is in an item that waits for the master password.
    const detailWaits = new Map<number, DetailWait>();
    for (const entry of shown)
      if (
        entry.handler.kind === "detail" &&
        !run.metadata.handlers.some((entered) => entered.index === entry.index)
      )
        detailPicks.set(
          entry.index,
          await detailInput(run, entry.handler, (wait) => detailWaits.set(entry.index, wait)),
        );
    if (!current(run)) return true;
    // A `password` handler goes first; refused, as when its button shows again after its
    // press, it ends the login there, so the passkey button beside it is never pressed by a
    // login that types its password (ADR 0048).
    // A `detail` handler's page shown again after its fill means the site refused the
    // value, so its link is not used again (ADR 0061); one that now asks another of the
    // item's secret questions asks a new question instead, so the answer's link stays.
    const newQuestion = new Set<number>();
    for (const entry of shown) {
      const answered = run.answers?.get(entry.index);
      if (
        entry.handler.kind === "detail" &&
        answered !== undefined &&
        refusal(entry) === "shown-again" &&
        // eslint-disable-next-line no-await-in-loop
        (await asksAnotherQuestion(run, entry.handler, answered))
      )
        newQuestion.add(entry.index);
      if (!current(run)) return true;
    }
    if (
      shown.some((entry) => entry.handler.kind === "detail" && refusal(entry) === "shown-again")
    ) {
      await forgetDetail(run, newQuestion);
      if (!current(run)) return true;
    }
    const fresh =
      shown[0]!.handler.kind === "password" && refusal(shown[0]!) !== undefined
        ? undefined
        : shown.find((entry) => refusal(entry) === undefined);
    if (!fresh) {
      const refused = refusal(shown[0]!)!;
      reportHandler(shown[0]!, refused);
      // The popup proposes the vault fields that could give the details (ADR 0061), and a
      // link whose value the page asked for again is not used again.
      const handler = shown[0]!.handler;
      if (
        handler.kind === "detail" &&
        (refused === "detail-unlinked" ||
          refused === "detail-reprompt" ||
          newQuestion.has(shown[0]!.index)) &&
        !stop
      )
        await offerDetails(run, handler, shown[0]!.index);
      await challenge();
      // The linked value's item waits for the master password (owner, 2026-10-23 21:50
      // UTC): the window asks, and once the vault accepts it the value is filled as the
      // popup's Fill fills it, leaving the button to the person.
      const wait = detailWaits.get(shown[0]!.index);
      if (refused === "detail-reprompt" && wait && !stop)
        void popupDetailFill(
          {
            version: 1,
            type: "login.detail.fill",
            tabId: run.live.document.tabId,
            documentId: run.live.document.documentId,
            detail: wait.detail,
            connectionId: run.metadata.account.connectionId,
            itemId: wait.itemId,
            fieldId: wait.fieldId,
          },
          { targets: wait.targets },
        ).catch(() => undefined);
      return true;
    }
    if (fresh.handler.kind === "totp") {
      // The code is made from the item's code field: its built-in TOTP, or the Text or
      // Hidden custom field its saved binding names, which the account must allow.
      const authorized = await allowed(run);
      if (!authorized) return true;
      const code = codeFieldOf(
        authorized.connection,
        run.metadata.account.itemId,
        authorized.bindings,
        run.recipe,
      );
      if (!code || !authorized.fieldIds.includes(code)) {
        reportHandler(fresh, "missing-fact");
        await challenge();
        return true;
      }
    }
    const field = fresh.handler.kind === "detail" ? detailPicks.get(fresh.index) : undefined;
    const steps = handlerSteps(fresh.handler, field);
    const event: LoginAttemptEvent = {
      type: "HANDLER",
      handler: fresh.index,
      ...(field === undefined ? {} : { field }),
      steps: steps.length,
      effects: steps.filter((step) => {
        const effect = loginStepEffect(step);
        return effect === "advance" || effect === "submit";
      }).length,
      document: run.live.document,
    };
    // At a stop the attempt stays ready either way: only an entered handler counts.
    const entered = transitionLoginAttempt(run.metadata, event);
    if (entered.state !== "ready" || entered.handlers.length === run.metadata.handlers.length) {
      reportHandler(fresh, "no-room");
      await challenge();
      return true;
    }
    reportHandler(fresh, "entered");
    await change(run, event);
    return true;
  }
  /**
   * After a `totp` handler's fill, whether the page moved on by itself before the click
   * found its button (ADR 0027): to another path, or to a signed-in marker or the rejection
   * without the button. A button still shown is clicked once as planned.
   */
  async function submittedByPage(
    run: Execution,
    click: Extract<LoginStep, { kind: "click" }>,
  ): Promise<boolean> {
    const { rejection } = run.recipe;
    const proof = markerProof(run.recipe);
    const observed = await observe(
      run,
      [click.target, ...proof.targets, ...(rejection ? [rejection] : [])],
      ["shown", ...proof.shown, ...(rejection ? ["present" as const] : [])],
      proof.links.length > 0
        ? { links: [false, ...proof.links], hidden: [false, ...proof.hidden] }
        : {},
    );
    if (!observed || !current(run)) return false;
    if (observed.path !== click.path) return true;
    if (observed.targets[0] === "unique") return false;
    return (
      proof.proves(observed.targets, 1) ||
      (rejection !== undefined && observed.targets[1 + proof.targets.length] === "unique")
    );
  }
  /**
   * The page submitted a TOTP code by itself, a `totp` handler's or a route step's: the
   * code's click counts as done, and the page is settled as after a click. The code is
   * never filled again.
   * Returns whether the attempt took it.
   */
  async function codeSubmitted(run: Execution): Promise<boolean> {
    await change(run, autoSubmitted(run.recipe, run.metadata));
    if (
      !current(run) ||
      run.metadata.state !== "reconciling" ||
      run.metadata.operationKind !== "click"
    )
      return false;
    // Held as after the click: a page that shows "Verifying" with the button still there
    // is neither judged nor settled while it verifies.
    run.heldClick = run.metadata.stepIndex;
    await reconcileBounded(run);
    return true;
  }
  /**
   * After an effect step that no check explained, sends the resulting page so the
   * service can judge it and learn a signed-in marker or a handler (ADR 0018, ADR 0027).
   * Returns whether the attempt settled or moved on. A page that still shows the route's
   * fields on one of its paths, or a signed-in marker, is not sent. At most
   * `MAX_JUDGED_PAGES` pages count per effect step, and as many again while the login is
   * watched (ADR 0027): a page counts in the attempt once its complete description is in
   * hand, before the request, so a restart cannot resend without bound, and is given back
   * only for a temporary refusal before any model call.
   */
  /** Logs why the page was not sent to the judge, as a code: never page text. */
  function notJudged(run: Execution, reason: string): false {
    report(run.live.document, {
      type: "judge",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: run.recipe.id,
      recipeRevision: run.recipe.revision,
      route: run.metadata.route,
      verdict: "not-sent",
      reason,
      ...(run.metadata.watch ? { watched: true as const } : {}),
    });
    return false;
  }
  /**
   * The usernames hidden from a judged page: those of the items that match it, as for a
   * page sent for generation, and the login's own account's even when it does not match
   * the page's URL, with the shape of the login's own (`usernameShape`) for the judge's
   * slots, so it is read once. `undefined` when one cannot be read.
   */
  async function judgedUsernames(
    run: Execution,
  ): Promise<{ usernames: string[]; shape: ValueShape | undefined } | undefined> {
    const { connectionId, itemId } = run.metadata.account;
    const scope = await generationSlotsFor(run.live).catch(() => undefined);
    let reads = scope ? usernameReads(scope) : [];
    if (
      !scope?.items.some(
        ({ connection, item }) => connection.id === connectionId && item.id === itemId,
      )
    ) {
      const snapshot = await settings.handle({ version: 1, type: "settings.get" });
      if (!snapshot.ok) return undefined;
      const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
      const item = connection?.items.find((entry) => entry.id === itemId);
      if (!connection || !item) return undefined;
      reads = [
        ...reads,
        ...usernameReads({
          items: [{ connection, item }],
          settings: snapshot.snapshot.settings,
          catalog: snapshot.catalog,
        }),
      ];
    }
    const own = (read: (typeof reads)[number]) =>
      read.connection.id === connectionId && read.itemId === itemId;
    const mine = await readUsernames(run.live.document.origin, reads.filter(own));
    if (!mine) return undefined;
    const shape = usernameShape({ complete: true }, mine);
    const others = await readUsernames(
      run.live.document.origin,
      reads.filter((read) => !own(read)),
    );
    if (!others) {
      mine.fill("");
      return undefined;
    }
    return { usernames: [...mine, ...others], shape };
  }
  /**
   * The page's description for the judge, on `path`, with the usernames of the items that
   * match it and the login's own hidden; or why it is not sent (`unsent`), or nothing when
   * the run was superseded meanwhile.
   */
  async function describeForJudge(
    run: Execution,
    path: string,
  ): Promise<
    | {
        observation: LoginObservation;
        disabledLeftOut: boolean;
        inputLeftOut: boolean;
        usernameShape?: ValueShape;
      }
    | { unsent: string }
    | undefined
  > {
    let observation: LoginObservation | undefined;
    let unsent = "unreachable";
    let disabledLeftOut = false;
    let inputLeftOut = false;
    try {
      const extracted = v.safeParse(
        extractResultSchema,
        await send(run.live, { type: "login.extract", page: "signed-in" }),
      );
      const parsed =
        extracted.success && extracted.output.ok
          ? v.safeParse(loginObservationSchema, extracted.output.observation)
          : undefined;
      if (!extracted.success || !parsed?.success)
        unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "invalid-page";
      else if (!parsed.output.complete)
        unsent = (extracted.output.ok && extracted.output.gap) || "incomplete";
      else if (
        parsed.output.origin !== run.live.document.origin ||
        // The description carries the path with any token-like segment replaced.
        parsed.output.path !== observedPath(path)
      )
        unsent = "page-changed";
      else {
        observation = parsed.output;
        disabledLeftOut = extracted.output.ok && extracted.output.disabledLeftOut === true;
        inputLeftOut = extracted.output.ok && extracted.output.inputLeftOut === true;
      }
    } catch {
      // The page could not be asked: `unreachable`.
    }
    if (!current(run)) return undefined;
    if (!observation) return { unsent };
    // A judged page can show the identifier just entered: the usernames of the items that
    // match it, and the login's own, are hidden first.
    const usernames = await judgedUsernames(run).catch(() => undefined);
    const hidden = hideUsernames(observation, usernames?.usernames, run.live);
    if (!current(run)) return undefined;
    if ("reason" in hidden) return { unsent: hidden.reason };
    return {
      observation: hidden.observation,
      disabledLeftOut,
      inputLeftOut,
      ...(usernames?.shape ? { usernameShape: usernames.shape } : {}),
    };
  }
  /**
   * Sends the page a login ended on, once its recipe's signed-in marker completed it with no
   * model call in the login, as a sample for evaluation (ADR 0029, owner 2026-10-18 08:05
   * UTC): described as for the judge, with the same usernames hidden, at most once in 30
   * days per recipe and branch on this device. It runs in the background after the login
   * ended and never changes it, its badge or its timing; any failure only loses the sample.
   * Conservatively (agent's choice), a login that sent a page to the judge or for
   * continuation, was watched or settled as unknown before, was in a frame, filled only, or
   * stopped at a missing password, is never sampled, nor is a page described with a
   * disabled field left out, or a site excluded since the login started.
   */
  function sampleSignedIn(run: Execution, before: LoginAttemptMetadata, path: string): void {
    const { metadata, recipe, live } = run;
    const sample = generation?.samplePage?.bind(generation);
    if (
      !sample ||
      !current(run) ||
      metadata.state !== "authenticated" ||
      metadata.outcome !== "authenticated" ||
      metadata.unconfirmed ||
      before.state === "authenticated" ||
      live.document.frameId !== 0 ||
      metadata.pageOrigin !== undefined ||
      live.document.origin !== recipe.origin ||
      before.fillOnly ||
      before.judged !== undefined ||
      before.watch !== undefined ||
      before.settled ||
      before.stopAt !== undefined ||
      before.stopJudged ||
      before.continuation !== undefined
    )
      return;
    const branch = branchOf(metadata);
    const reportSample = (
      outcome: Extract<LoginReport, { type: "sample" }>["outcome"],
      reason?: string,
    ) =>
      report(live.document, {
        type: "sample",
        tabId: live.document.tabId,
        origin: live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        route: metadata.route,
        outcome,
        ...(reason ? { reason } : {}),
      });
    /**
     * Why the sample is not sent: the site is paused, as when a pause or an exclusion rule
     * started meanwhile, since a paused site sends no page (ADR 0062).
     */
    const excluded = async (): Promise<string | undefined> => {
      const snapshot = await settings.handle({ version: 1, type: "settings.get" });
      if (!snapshot.ok) return "settings-unavailable";
      return (await pauseOf(live)) ? "paused" : undefined;
    };
    /** The page as the judge would get it, while it is still the one the login ended on. */
    const describe = async (): Promise<
      { observation: LoginObservation; slots: SemanticSlot[] } | { unsent: string }
    > => {
      const ended = () =>
        current(run) && run.metadata.id === metadata.id && run.metadata.state === "authenticated";
      if (!ended()) return { unsent: "page-changed" };
      const stop = await excluded();
      if (stop) return { unsent: stop };
      if (!ended()) return { unsent: "page-changed" };
      const described = await describeForJudge(run, path);
      if (!described || !ended()) return { unsent: "page-changed" };
      if ("unsent" in described) return described;
      if (described.disabledLeftOut) return { unsent: "disabled-left-out" };
      // The account's slots, as the judge request would carry them (owner 2026-10-23).
      const judged = await judgeSlots(live.document.origin, metadata.account, metadata.route, {
        usernameShape: described.usernameShape,
      });
      if (!ended()) return { unsent: "page-changed" };
      return { observation: described.observation, slots: judged.slots };
    };
    void sample(
      {
        recipeId: recipe.id,
        revision: recipe.revision,
        // As the judge is told it (`learn`).
        route:
          metadata.route === "passkey" && passkeyAnswersRequest(recipe)
            ? "password"
            : metadata.route,
        ...(branch ? { branch } : {}),
      },
      describe,
      // A pause started while the page was described or the sample recorded still stops it.
      async () => {
        const stop = await excluded();
        if (!stop) reportSample("sent");
        return stop;
      },
    )
      .then((answer) =>
        answer.outcome === "not-due"
          ? undefined
          : reportSample(answer.outcome, "reason" in answer ? answer.reason : undefined),
      )
      .catch(() => undefined);
  }
  /**
   * Whether this attempt has sent the account's credential (ADR 0065): its latest effect
   * step submitted, after a route step that typed the password or a second factor's
   * handler (a handler missing from the recipe does not count). The page after an
   * identifier's Next, or after a `password` handler's button, is no page after the
   * sign-in. The `passkey` route never completes on an optional page (ADR 0027), so its
   * own step does not count.
   */
  function credentialSent(run: Execution): boolean {
    const { metadata, recipe } = run;
    if (metadata.operationEffect !== "submit") return false;
    const ran = metadata.operationId === undefined ? metadata.stepIndex : metadata.stepIndex + 1;
    return (attemptPlan(recipe, metadata) ?? [])
      .slice(0, ran)
      .some((entry) =>
        entry.handler === undefined
          ? entry.step.kind === "fill" &&
            entry.step.fields.some((field) => field.slot === "password")
          : ![undefined, "password"].includes(recipe.handlers?.[entry.handler]?.kind),
      );
  }
  async function learn(run: Execution, reading?: SignInReading): Promise<boolean> {
    const { recipe, metadata } = run;
    const { operationId } = metadata;
    // A login watched at its stop has no step in flight; its watch's pages are judged as any
    // watched login's are (ADR 0036, ADR 0027).
    const stopWatched = watchedAtStop(metadata);
    if (!generation || (!stopWatched && (!effectful(metadata) || !operationId))) return false;
    const notSent = (reason: string) => notJudged(run, reason);
    if (pagesLeft(metadata, operationId) <= 0) return notSent("page-limit");
    // Every variant's fill fields and paths count, as on the service, which is never told
    // the variant; on the passkey route, its button and the password form, on its path and
    // the password route's (ADR 0027).
    const paths = routeSignInPaths(recipe, metadata.route);
    const marker = (recipe.completion ?? [])
      .filter((entry) => entry.origin === undefined)
      .map((entry) => entry.target);
    const fills = routeSignInTargets(recipe, metadata.route).slice(0, 24 - marker.length);
    // A hidden marker proves nothing and does not keep the page from the judge.
    const remaining = await observe(
      run,
      [...fills, ...marker],
      [
        ...fills.map((target) => (passkeyButton(run, target) ? "present" : "input")),
        ...marker.map(() => "shown" as const),
      ],
      marker.length > 0
        ? {
            links: [...fills.map(() => false), ...marker.map(() => true)],
            hidden: [...fills.map(() => false), ...marker.map(() => true)],
          }
        : {},
    );
    if (!remaining) {
      // A superseded run or a refused one (logged with its own cause) says nothing here.
      if (current(run) && !terminal(run.metadata)) notSent("unreachable");
      return false;
    }
    // A route's sign-in field shows on another path too (S1): such a page is never complete
    // (ADR 0029), and the description may leave the field out when no locator names it.
    const fieldShown =
      paths.includes(remaining.path) &&
      remaining.targets
        .slice(0, fills.length)
        .some((state) => state !== "missing" && state !== "unusable");
    // One on a route path of a password login without a chooser or a stop, read in the tab's
    // top document on the recipe's own origin, may stand beside another form that asks for
    // a detail, which is judged on its own (ADR 0061); a failure shown beside the sign-in
    // form never is, nor a page whose sign-in state was not read.
    const besideCandidate =
      fieldShown &&
      reading !== undefined &&
      reading.decision !== "rejected" &&
      metadata.route === "password" &&
      !metadata.chooser &&
      metadata.stopAt === undefined &&
      metadata.pageOrigin === undefined &&
      run.live.document.frameId === 0 &&
      run.live.topUrl === undefined &&
      run.live.document.origin === recipe.origin;
    if (
      !besideCandidate &&
      (reading?.decision === "unknown" || reading?.decision === "rejected" || fieldShown)
    )
      return notSent("sign-in-shown");
    // A marker shows, but the completion check did not prove the sign-in: more than one
    // match, or an element it needs gone is there.
    if (
      remaining.targets
        .slice(fills.length)
        .some((state) => state === "unique" || state === "ambiguous")
    )
      return notSent("marker-shown");
    const described = await describeForJudge(run, remaining.path);
    if (!described) return true;
    // A page that cannot be described completely is not sent and does not count.
    if ("unsent" in described) return notSent(besideCandidate ? "sign-in-shown" : described.unsent);
    const { observation, disabledLeftOut, inputLeftOut, usernameShape: shape } = described;
    // The sign-in form beside another form with a text-like input and its own button, on a
    // path without a `detail` handler, as the service checks (ADR 0061); otherwise the page
    // is still the sign-in page.
    const beside =
      besideCandidate &&
      showsBesideForm(observation, routeFillTargets(recipe, "password")) &&
      !(recipe.handlers ?? []).some(
        (handler) => handler.kind === "detail" && handler.path === observation.path,
      );
    if (besideCandidate && !beside) return notSent("sign-in-shown");
    const left = pagesLeft(run.metadata, operationId);
    await change(run, { type: "JUDGING", operationId });
    if (!current(run)) return true;
    if (pagesLeft(run.metadata, operationId) !== left - 1) return false;
    // The account's slots go with the page, as with a generation request (owner 2026-10-23).
    const judged = await judgeSlots(run.live.document.origin, metadata.account, metadata.route, {
      usernameShape: shape,
    });
    if (!current(run)) return true;
    const watchedPage = run.metadata.watch !== undefined;
    // The answer's timing, once it came (ADR 0019).
    let timed: { timing?: ServiceTiming } = {};
    const reportJudge = (
      verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
      detail: {
        reason?: string;
        takenOver?: boolean;
        completed?: true;
        notCompleted?: "disabled-left-out" | "password-empty";
      } = {},
    ) =>
      report(run.live.document, {
        type: "judge",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        route: metadata.route,
        verdict,
        ...detail,
        ...(watchedPage ? { watched: true as const } : {}),
        ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
        ...(beside ? { beside: true as const } : {}),
        ...timed,
      });
    // The login's layout and chooser branch (ADR 0060), and whether the description left a
    // disabled field out (ADR 0029). The account's slots go after them, and `beside` only
    // for a page beside the sign-in form (ADR 0061).
    const branch = branchOf(metadata);
    const spin = spinning(run.live.document.tabId);
    const asked = Date.now();
    const {
      verdict,
      reason,
      recipe: added,
      questions,
      timing,
    } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        // The service knows no `passkey` route on a recipe without its button; the page's
        // own request is answered beside the password form, which the service checks for
        // that route the same way (ADR 0034).
        metadata.route === "passkey" && passkeyAnswersRequest(recipe) ? "password" : metadata.route,
        observation,
        spin.sent(() => reportJudge("sent")),
        branch,
        disabledLeftOut ? true : undefined,
        undefined,
        judged.slots,
        ...(beside ? [true as const] : []),
      )
      .finally(spin.stop);
    // The judge's pairings of the page's secret questions with the account's fields, kept
    // for the popup to propose, never to fill from (ADR 0061).
    const paired = pairedQuestions(remaining.path, questions, judged.offers);
    if (paired) run.paired = paired;
    else delete run.paired;
    spend(metadata.id, Date.now() - asked, timing);
    if (timing) timed = { timing };
    if (!current(run)) {
      reportJudge(verdict, {
        ...(reason ? { reason } : {}),
        ...(added ? { takenOver: false } : {}),
      });
      return true;
    }
    // A temporary refusal, such as a busy service, gives the page back.
    if (verdict === "retry") await change(run, { type: "UNJUDGED", operationId });
    // A page with no sign and no evidence completes when the judge cannot decide, unless
    // the login is watched (ADR 0027); one with a sign of another sign-in step goes to the
    // person, as does a page judged `challenge` before (ADR 0029). An optional page after
    // the sign-in completes as signed in, watched or not, and is left as it is (ADR 0065),
    // but only on the `password` route once this attempt sent the credential, without a
    // stop before a missing password and with no radio button, select or text area left
    // out of its description; on the same path once read again.
    const sent = credentialSent(run);
    const candidate = undecidedCandidate({
      verdict,
      reason,
      reading,
      watched: run.metadata.watch !== undefined,
      route: run.metadata.route,
      stopAt: run.metadata.stopAt,
      sent,
      inputLeftOut,
      answered: passkeyStepAnswered(run),
    });
    let again: Awaited<ReturnType<typeof readSignInState>>;
    // The judge's answer can take a while: the page completes only if, once the answer is
    // back, it has loaded and still shows no sign of a sign-in going on.
    if (candidate.completes) {
      again = await readSignInState(run);
      if (!current(run)) {
        reportJudge(verdict, { ...(reason ? { reason } : {}) });
        return true;
      }
    }
    const { completes, notCompleted } = settleCompletion({
      ...candidate,
      again,
      disabledLeftOut,
      // Only an optional page must still be on its path: an undecided one keeps ADR 0029's
      // rule, as on a single-page app that routes on while it is judged.
      ...(verdict === "optional" ? { path: remaining.path } : {}),
    });
    // Reported before the takeover's own entries, once whether it is taken over is known.
    let reported = false;
    // A watched login only reads its pages; it never runs a learned handler (ADR 0027).
    const movedOn =
      verdict === "challenge" &&
      added !== undefined &&
      run.metadata.state !== "watching" &&
      current(run) &&
      (await takeOver(run, added, remaining.path, () => {
        reported = true;
        reportJudge(verdict, { takenOver: true });
      }));
    if (!reported)
      reportJudge(verdict, {
        ...(reason ? { reason } : {}),
        ...(added ? { takenOver: false } : {}),
        ...(completes ? { completed: true } : {}),
        ...(notCompleted ? { notCompleted } : {}),
      });
    if (movedOn || !current(run)) return true;
    const { result, confirmed } = judgedCompletionResult({
      verdict,
      reason,
      reading,
      completes,
      stopHeld: candidate.stopHeld,
      route: run.metadata.route,
      stopAt: run.metadata.stopAt,
      sent,
    });
    // The page after the final advance before a stop just past the plan's last step, not
    // found signed in or rejected and with no handler taken over, takes the login to its
    // stop, where the page's passkey request is answered (ADR 0036).
    if (result === "challenge" && (await toStop(run))) return true;
    // A login watched at its stop submitted no password, so a page judged rejected refuses
    // none: the login stays watched (ADR 0036).
    if (stopWatched && result === "credential-rejected") return true;
    const unconfirmed = result === "authenticated" && !confirmed;
    if (unconfirmed) delete run.choice;
    await change(run, {
      type: "OBSERVED",
      result,
      document: run.live.document,
      ...(unconfirmed ? { unconfirmed: true } : {}),
    });
    return true;
  }
  /**
   * The first login takes over the revision its judged page added a handler to and runs
   * the handler on the page it is on (ADR 0027). Only a revision that keeps the routes and
   * their steps is taken over. Returns whether the attempt moved on.
   */
  async function takeOver(
    run: Execution,
    answered: LoginRecipe | LoginChooserRecipe,
    path: string,
    taking: () => void,
    stop?: { end: () => Promise<void> },
  ): Promise<boolean> {
    const next = routeOf(run, answered);
    if (!next || next.id !== run.recipe.id || !extendsRecipe(run.recipe, next)) return false;
    const event: LoginAttemptEvent = { type: "REVISED", recipeRevision: next.revision };
    if (transitionLoginAttempt(run.metadata, event).recipeRevision !== next.revision) return false;
    taking();
    // The recipe is replaced before the record that names its revision is written.
    run.recipe = next;
    if (!isLoginRouteRecipe(answered)) run.chooser = answered;
    await change(run, event);
    return current(run) && (await enterHandler(run, path, stop));
  }
  /**
   * The route a login runs of a recipe the service sent or the cache holds: a chooser
   * login's is the route of its click on the chooser (ADR 0028), and a chooser is never
   * another login's.
   */
  function routeOf(
    run: Execution,
    next: LoginRecipe | LoginChooserRecipe | undefined,
  ): LoginRecipe | undefined {
    if (!next) return undefined;
    const click = run.metadata.chooser?.click;
    if (isLoginRouteRecipe(next)) return click ? undefined : next;
    return click ? chooserRoute(next, click) : undefined;
  }
  /** The newest cached revision of a login's own recipe, as the route it runs. */
  async function cachedRoute(run: Execution, path: string): Promise<LoginRecipe | undefined> {
    const { origin: pageOrigin } = run.live.document;
    // The layout the login started on (ADR 0060).
    const { layout } = run.metadata;
    if (!run.metadata.chooser) return recipes.recipe(pageOrigin, path, run.recipe.id, layout);
    return routeOf(run, await recipes.chooser?.(pageOrigin, path, run.recipe.id, layout));
  }
  /**
   * The other layouts of a login's recipe it may run from plan step `at` on (ADR 0060),
   * newest first: each whose steps before `at` are the login's own, with a different step
   * at `at`. Only a `password` login on its recipe's own steps (variant 0) has any, with no
   * handler entered, no stop, no chooser and not only filling, past its first step: the
   * layouts were told apart there already.
   */
  async function siblingsAt(run: Execution, at: number): Promise<LoginRecipe[]> {
    const { metadata, recipe } = run;
    if (
      !recipes.layoutsOf ||
      metadata.layout === undefined ||
      metadata.route !== "password" ||
      metadata.variant !== 0 ||
      metadata.handlers.length > 0 ||
      metadata.chooser !== undefined ||
      metadata.stopAt !== undefined ||
      metadata.fillOnly === true ||
      at < 1
    )
      return [];
    const plan = attemptPlan(recipe, metadata);
    if (!plan || plan.length !== metadata.stepCount) return [];
    const layouts = await Promise.resolve(recipes.layoutsOf(recipe.origin, recipe.id)).catch(
      () => [],
    );
    const stepsOf = (entries: { step: LoginStep }[]) =>
      JSON.stringify(entries.map((entry) => entry.step));
    const before = stepsOf(plan.slice(0, at));
    const own = plan[at] && stepsOf([plan[at]]);
    return layouts
      .filter((other) => {
        if (
          other.id !== recipe.id ||
          other.layout === undefined ||
          other.layout === metadata.layout ||
          other.revision < metadata.recipeRevision ||
          !runsLogin(other)
        )
          return false;
        const steps = attemptPlan(other, metadata);
        return (
          steps !== undefined &&
          steps.length > at &&
          stepsOf(steps.slice(0, at)) === before &&
          stepsOf([steps[at]!]) !== own
        );
      })
      .sort((left, right) => Number(right.layout) - Number(left.layout));
  }
  /**
   * Switches the login to another layout of its recipe at the step where they part (ADR
   * 0060), when the page shows that layout's step there and not the login's own: after an
   * effect step that may have advanced, the step after it, confirmed as the login's own next
   * step would be (on its path, or on the advance's path by elements the advance made
   * ready); with nothing in flight, the step at hand, ready to run. The account's plan must
   * pass on that layout. Returns whether the login switched; the newest layout that fits
   * wins.
   */
  // The layouts are tried in order, each against the page as it is now.
  /* eslint-disable no-await-in-loop */
  async function switchLayout(run: Execution): Promise<boolean> {
    const { metadata } = run;
    const inFlight = metadata.operationId !== undefined;
    if (
      inFlight &&
      !(
        (metadata.operationKind === "click" || metadata.operationEffect === "advance") &&
        metadata.mutationIntent === true &&
        metadata.submissions > 0
      )
    )
      return false;
    if (!inFlight && metadata.retryRequired === true) return false;
    // A click left to the person is theirs to press first.
    if (inFlight && run.heldClick === metadata.stepIndex) return false;
    const at = inFlight ? metadata.stepIndex + 1 : metadata.stepIndex;
    // Past the login's own last step only an advance goes on (`LAYOUT`'s guard).
    if (at >= metadata.stepCount && metadata.operationEffect !== "advance") return false;
    const siblings = await siblingsAt(run, at);
    if (!current(run)) return false;
    const done = inFlight
      ? attemptPlan(run.recipe, metadata)?.[metadata.stepIndex]?.step
      : undefined;
    for (const sibling of siblings) {
      const step = attemptPlan(sibling, metadata)![at]!.step;
      let shows: boolean;
      if (!inFlight) {
        // As the step would wait for its elements before it runs; a step that needs none
        // shows nothing of the layout.
        const readiness = loginReadiness(step);
        if (!readiness.targets.length) continue;
        const waited = await waitFor(run, readiness, 1);
        if (!current(run) || waited === "gone") return false;
        shows = waited === "ready";
      } else {
        // An advance on the step's own path is confirmed only by elements it made ready, as
        // the login's own next step is (ADR 0013).
        const inPlace =
          done?.path === step.path ? inPlaceNext(sibling, metadata, metadata.stepIndex) : undefined;
        const measured =
          run.siblingsInPlace && run.siblingsInPlace.operationId === metadata.operationId
            ? run.siblingsInPlace.siblings.find((entry) => entry.layout === sibling.layout)
            : undefined;
        if (
          done?.path === step.path &&
          !(
            inPlace &&
            measured?.before.length === inPlace.targets.length &&
            measured.before.every((state) => state === "missing" || state === "unusable")
          )
        )
          continue;
        const targets = inPlace ? inPlace.targets : stepTargets(step);
        if (!targets.length) continue;
        const observed = await observe(
          run,
          targets,
          targets.map(() => inPlace?.require ?? "present"),
        );
        if (!observed) return false;
        shows =
          observed.path === step.path && observed.targets.every((state) => state === "unique");
      }
      if (!shows) continue;
      // The account's binding and fields must fit the layout's route, as at a login's start.
      const snapshot = await settings.handle({ version: 1, type: "settings.get" });
      if (!current(run)) return false;
      if (!snapshot.ok || snapshot.snapshot.revision !== run.metadata.policyRevision) return false;
      const plan = await planFor(snapshot, run.live, sibling, {
        route: { route: "password", variant: 0 },
      });
      if (!current(run) || run.metadata !== metadata) return false;
      if (
        !plan.ok ||
        plan.account.connectionId !== metadata.account.connectionId ||
        plan.account.itemId !== metadata.account.itemId
      )
        continue;
      const event: LoginAttemptEvent = {
        type: "LAYOUT",
        layout: sibling.layout!,
        recipeRevision: sibling.revision,
        steps: attemptPlan(sibling, metadata)!.length,
        // What the login holds beyond its recipe's budget, as the submissions a passkey
        // answer spent before it fell back to the password (ADR 0034), stays with it.
        maxSubmissions: Math.min(
          MAX_ATTEMPT_SUBMISSIONS,
          sibling.maxSubmissions + Math.max(0, metadata.maxSubmissions - run.recipe.maxSubmissions),
        ),
        document: run.live.document,
      };
      if (transitionLoginAttempt(metadata, event).layout !== sibling.layout) continue;
      // The recipe is replaced before the record that names its layout is written.
      run.recipe = sibling;
      // The account's choice is saved for the layout the login signs in on.
      if (plan.choice) run.choice = plan.choice;
      else delete run.choice;
      delete run.inPlace;
      delete run.siblingsInPlace;
      delete run.qualified;
      await change(run, event);
      return true;
    }
    return false;
  }
  /* eslint-enable no-await-in-loop */
  /**
   * Whether the attempt's in-flight step is the final `advance` step of a recipe that can be
   * continued on the page it leads to (ADR 0018): a `password` route login on the recipe's
   * own steps (variant 0), in the tab's own page, with recipe generation configured, whose
   * recipe has no completion and no alternatives. A login of an item without a password
   * asks only when its stop lies just past that advance (ADR 0036). A `password` handler's
   * click counts as that advance when it is the plan's last step and the recipe's own last
   * step is an advance (ADR 0048).
   */
  function continuable(run: Execution): boolean {
    const { metadata, recipe } = run;
    if (
      !generation ||
      !uris ||
      (probeMode && metadata.account.origin === origin) ||
      // A fill-only login ends before any advance (ADR 0021 D).
      metadata.fillOnly === true ||
      metadata.route !== "password" ||
      metadata.variant !== 0 ||
      (metadata.stopAt !== undefined && !stopsPastPlan(metadata)) ||
      run.live.document.frameId !== 0 ||
      run.live.topUrl !== undefined ||
      metadata.operationId === undefined ||
      metadata.operationEffect !== "advance" ||
      recipe.completion !== undefined ||
      recipe.alternatives !== undefined
    )
      return false;
    const plan = attemptPlan(recipe, metadata);
    const inFlight = plan?.[metadata.stepIndex];
    return (
      plan !== undefined &&
      plan.length === metadata.stepCount &&
      metadata.stepIndex + 1 === plan.length &&
      inFlight !== undefined &&
      (inFlight.handler === undefined ||
        recipe.handlers?.[inFlight.handler]?.kind === "password") &&
      loginStepEffect(inFlight.step) === "advance" &&
      recipe.steps.at(-1) !== undefined &&
      loginStepEffect(recipe.steps.at(-1)!) === "advance"
    );
  }
  /**
   * After a recipe's final `advance` step, sends the page it led to so the service appends
   * that page's steps, and takes the continued revision over (ADR 0018). The page qualifies
   * once it has finished loading and has shown, for a second on one path, a sign-in input
   * for a built-in slot the recipe does not fill yet, other than the recipe's own fields: a
   * password input, or, while none of the recipe's fill fields is writable on the page, a
   * username or email input. A complete description of it that shows such an input is sent
   * once per effect step, offering only the slots the recipe does not fill yet: the request
   * is recorded in the attempt first, and given back for a later document to send when the
   * generation claim was freed or the request was not sent (`retry`). A later document of the login waits
   * for an answer still on its way. Returns `moved` once the attempt moved on or this document is no longer
   * current, `qualified` for a qualifying page that was not continued (yet), which is never
   * judged, and `none` for any other page.
   */
  async function continueOn(run: Execution): Promise<"none" | "qualified" | "moved"> {
    if (!continuable(run) || !generation) return "none";
    const { recipe, metadata } = run;
    const operationId = metadata.operationId!;
    const fills = routeFillTargets(recipe, "password").slice(0, 24);
    const observed = await observe(
      run,
      fills,
      fills.map(() => "writable" as const),
      { signIn: true },
    );
    if (!current(run)) return "moved";
    if (!observed) return "none";
    const filled = new Set(
      recipe.steps.flatMap((step) =>
        step.kind === "fill" ? step.fields.map((field) => field.slot) : [],
      ),
    );
    const shown = observed.signIn;
    const byPassword = shown?.password === true && !filled.has("password");
    // A page that asks for the account again, such as the identifier form shown again
    // where it posted, shows one of the recipe's fill fields writable, on any path. A
    // revealed password input below the identifier the recipe filled still qualifies.
    const byIdentifier =
      shown?.identifier === true &&
      !filled.has("username") &&
      !observed.targets.some((target) => target === "unique");
    if (shown?.loaded !== true || !(byPassword || byIdentifier)) {
      if (run.qualified?.operationId === operationId) delete run.qualified;
      return "none";
    }
    const now = Date.now();
    if (run.qualified?.operationId !== operationId || run.qualified.path !== observed.path)
      run.qualified = { operationId, path: observed.path, since: now };
    const state = run.qualified;
    const refuse = () => {
      run.continuationRefused = operationId;
      return "qualified" as const;
    };
    /** Logs once per document why the qualifying page is not sent (yet). */
    const unsent = (reason: string, detail?: string) => {
      if (run.live.generationSkip !== reason) {
        run.live.generationSkip = reason;
        report(run.live.document, {
          type: "generation",
          tabId: run.live.document.tabId,
          origin: run.live.document.origin,
          outcome: "skipped",
          reason,
          ...(detail ? { detail } : {}),
          recipeId: recipe.id,
          baseRevision: recipe.revision,
        });
      }
      return "qualified" as const;
    };
    if (run.continuationRefused === operationId) return "qualified";
    // Spent for this step. A revision that continues the recipe and reached the cache, as
    // after a restart during the request, is taken over; so is an answer an earlier
    // document of the login still waits for, or that arrived after it was left. While that
    // answer is on its way this document waits for it, past the step's ten seconds.
    if (metadata.continuation?.operationId === operationId) {
      const fromCache = async (): Promise<"moved" | "refused" | "none"> => {
        const cached = await cachedRoute(run, observed.path).catch(() => undefined);
        if (!current(run)) return "moved";
        if (!cached || cached.revision <= recipe.revision || !continuesRecipe(recipe, cached))
          return "none";
        if ((await continueWith(run, cached)) || !current(run)) return "moved";
        return "refused";
      };
      const cached = await fromCache();
      if (cached === "moved") return "moved";
      if (cached === "refused") return refuse();
      const earlier = continuations.get(metadata.id);
      if (earlier?.operationId !== operationId) return "qualified";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        earlier.answer,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), CONTINUATION_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!current(run)) return "moved";
      if (continuations.get(metadata.id) === earlier) continuations.delete(metadata.id);
      if (answer?.outcome === "recipe") {
        if ((await continueWith(run, answer.recipe)) || !current(run)) return "moved";
      } else if (answer?.retry) {
        // Given back, as the earlier document would have: this one sends it again.
        await change(run, { type: "UNCONTINUED", operationId });
        return current(run) ? "qualified" : "moved";
      } else if (!answer) {
        // No answer in time; only the cache can still bring it.
        return (await fromCache()) === "moved" ? "moved" : "qualified";
      }
      return refuse();
    }
    if (now - state.since < CONTINUATION_STABLE_MS) return "qualified";
    // The fields the recipe already filled, on any path, may show again read-only, as an
    // email a password page on another path of the same document keeps (#831).
    const known = recipe.steps
      .flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.target) : []))
      .slice(0, 24);
    let observation: LoginObservation | undefined;
    let missing = "extract-failed";
    // Why a described page is not sent, for the log (ADR 0019).
    let detail: string | undefined;
    try {
      const extracted = v.safeParse(
        extractResultSchema,
        await send(run.live, {
          type: "login.extract",
          page: "login",
          ...(known.length ? { known } : {}),
        }),
      );
      // The content script's refusal, such as `no-locator` or `extract-error`, as for a
      // first page; `extract-failed` for an answer that fails its check or never came.
      if (extracted.success && !extracted.output.ok) {
        missing = extracted.output.reason;
        if (extracted.output.detail) detail = logCode(extracted.output.detail);
      } else if (extracted.success && extracted.output.ok) {
        const accepted = acceptedObservation(extracted.output, {
          origin: run.live.document.origin,
          path: observed.path,
        });
        if ("observation" in accepted) observation = accepted.observation;
        else {
          missing = "incomplete-observation";
          detail = accepted.detail;
        }
      }
    } catch {
      observation = undefined;
    }
    if (!current(run)) return "moved";
    // An incomplete description is not sent and does not count; a later round tries again.
    if (!observation) return unsent(missing, detail);
    // The description must show the input the page qualified with, which it can leave out
    // where the two read the page differently, as an input in a form the description does
    // not keep. The page must then qualify for another second before it is read again.
    const fillTargets = recipe.steps.flatMap((step) =>
      step.kind === "fill" ? step.fields.map((field) => field.target) : [],
    );
    const described = observation.candidates.some(
      (candidate) =>
        (byPassword &&
          candidate.role === "password" &&
          candidate.autocomplete !== "new-password" &&
          candidate.autocomplete !== "one-time-code") ||
        (byIdentifier &&
          (candidate.role === "email" ||
            candidate.autocomplete === "username" ||
            candidate.autocomplete === "email") &&
          !fillTargets.some((target) => sameLoginTarget(target, candidate.target))),
    );
    if (!described) {
      state.since = Date.now();
      return unsent("field-not-described");
    }
    // The login's own item must match the page, as for a recipe's first page (ADR 0016).
    const scope = await generationSlotsFor(run.live).catch(() => undefined);
    if (!current(run)) return "moved";
    // The tab or the vault could not answer now, or no item matches; a later round asks again.
    if (!scope) return unsent("no-vault-match");
    if (
      !scope.items.some(
        ({ connection, item }) =>
          connection.id === metadata.account.connectionId && item.id === metadata.account.itemId,
      )
    ) {
      // A connection that did not answer or an item whose URI rules were not evaluated may
      // still hold it: a later round asks again.
      if (!scope.complete) return unsent("scope-incomplete");
      unsent("no-vault-match");
      return refuse();
    }
    const pageOrigin = run.live.document.origin;
    // A slot the recipe already fills is not offered again, so the model cannot map it to a
    // field the page still shows (the service refuses such a page too).
    // A login that stops before its item's missing password offers the password slot too,
    // so the page can be continued up to its password step, which this login never runs
    // (ADR 0036). Only the slot goes out, never a value.
    const offered =
      metadata.stopAt !== undefined &&
      !scope.slots.some((slot) => slot.id === "password") &&
      ownPasswordField(scope, metadata.account)
        ? [...scope.slots, builtInLoginSlots.password]
        : scope.slots;
    const slots = offered.filter((slot) => !filled.has(slot.id));
    // Likewise a custom field the recipe's generated slot map already names (ADR 0027).
    const named = await Promise.resolve(generation.slotFields(recipe.id)).catch(() => undefined);
    const offers = scope.offers.filter(
      (offer) =>
        !named?.some(
          ({ field }) =>
            typeof field !== "string" &&
            field.custom === offer.reference.custom &&
            field.position === offer.reference.position &&
            field.count === offer.reference.count,
        ),
    );
    const usernames = await readUsernames(pageOrigin, usernameReads(scope));
    const shape = usernames && usernameShape(scope, usernames);
    // The page after an `advance` step can show the identifier just entered.
    const hidden = hideUsernames(observation, usernames, run.live);
    if (!current(run)) return "moved";
    // A username that could not be read now may be read on a later round; one that shows
    // where it cannot be hidden shows again.
    if ("reason" in hidden) {
      unsent(hidden.reason);
      return hidden.reason === "username-unread" ? "qualified" : refuse();
    }
    const custom = await customSlots(pageOrigin, { ...scope, offers });
    if (!current(run)) return "moved";
    if (!slots.length && !custom.length) {
      unsent("no-slots");
      return refuse();
    }
    // Recorded before the request, so a restart never sends this step's page again.
    await change(run, { type: "CONTINUING", operationId });
    // Left during the write, the record may hold `CONTINUING` with nothing sent: fail-closed,
    // the step's page then settles `unknown` unless the cache brings the continuation.
    if (!current(run)) return "moved";
    if (run.metadata.continuation?.operationId !== operationId) return refuse();
    // The page that asks, logged when its request leaves the device (ADR 0019).
    const page = run.live.document;
    const spin = spinning(page.tabId);
    const askedAt = Date.now();
    const asked = generation
      .generate(
        {
          version: 1,
          observation: hidden.observation,
          slots: [
            ...slots.map((slot) =>
              slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
            ),
            ...custom,
          ],
          base: { recipeId: recipe.id, revision: recipe.revision },
          // The page continues the login's layout (ADR 0060); a chooser login's is its
          // branch's next page (ADR 0028).
          ...branchField(metadata),
        },
        spin.sent(() =>
          report(page, {
            type: "generation",
            tabId: page.tabId,
            origin: pageOrigin,
            outcome: "sent",
            recipeId: recipe.id,
            baseRevision: recipe.revision,
          }),
        ),
      )
      .finally(spin.stop)
      // A thrown request frees its claim, so it is given back like any request that did not
      // reach the model.
      .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error", retry: true }))
      // Counted once, for whichever document of the login takes the answer (ADR 0019).
      .then((answer) => {
        if (answer.outcome !== "skipped") spend(metadata.id, Date.now() - askedAt, answer.timing);
        return answer;
      });
    // Kept in memory for a later document of this login, which the form may post to
    // before the answer arrives.
    const request = { operationId, answer: asked };
    continuations.set(metadata.id, request);
    const answer = await asked;
    const reportGeneration = (takenOver?: boolean, notTakenOver?: string) =>
      report(run.live.document, {
        type: "generation",
        tabId: run.live.document.tabId,
        origin: pageOrigin,
        ...outcomeFields(answer),
        recipeId: recipe.id,
        baseRevision: recipe.revision,
        ...(takenOver === undefined ? {} : { takenOver }),
        ...(notTakenOver === undefined ? {} : { notTakenOver }),
      });
    // Left meanwhile: the attempt's next document uses the answer.
    if (!current(run)) {
      reportGeneration();
      return "moved";
    }
    if (continuations.get(metadata.id) === request) continuations.delete(metadata.id);
    run.continuationRefused = operationId;
    if (answer.outcome !== "recipe") {
      reportGeneration();
      // A request that did not reach the model, or was not sent, gives the request back
      // for the attempt's next document to send.
      if (answer.retry) await change(run, { type: "UNCONTINUED", operationId });
      return current(run) ? "qualified" : "moved";
    }
    let reported = false;
    let taken = false;
    // Why the login did not take the revision over, always logged (ADR 0019).
    let refusal = "not-recorded";
    try {
      taken = await continueWith(
        run,
        answer.recipe,
        () => {
          reported = true;
          reportGeneration(true);
        },
        (reason) => {
          refusal = reason;
        },
      );
    } finally {
      // Not taken over, or the `CONTINUED` write failed.
      if (!reported) reportGeneration(false, refusal);
    }
    if (taken || !current(run)) return "moved";
    // A chooser the other branch changed meanwhile comes back without this branch's page
    // (ADR 0028): the login takes that revision over and sends the page again against it.
    const newer = routeOf(run, answer.recipe);
    if (
      run.metadata.chooser &&
      !isLoginRouteRecipe(answer.recipe) &&
      newer &&
      extendsRecipe(run.recipe, newer) &&
      newer.steps.length === run.recipe.steps.length
    ) {
      const revised: LoginAttemptEvent = { type: "REVISED", recipeRevision: newer.revision };
      if (transitionLoginAttempt(run.metadata, revised).recipeRevision === newer.revision) {
        run.recipe = newer;
        run.chooser = answer.recipe;
        await change(run, revised);
        if (!current(run)) return "moved";
        await change(run, { type: "UNCONTINUED", operationId });
        if (!current(run)) return "moved";
        delete run.continuationRefused;
        delete run.qualified;
      }
    }
    return "qualified";
  }
  /**
   * Whether the login's own item, among a page's matching items, has a password field the
   * account may use, empty or not (ADR 0036).
   */
  function ownPasswordField(
    scope: GenerationScope,
    owner: { connectionId: string; itemId: string },
  ): boolean {
    return scope.items.some(
      ({ connection, item }) =>
        connection.id === owner.connectionId &&
        item.id === owner.itemId &&
        item.fields.some((field) => field.id === "login.password") &&
        !isFieldExcluded(scope.settings, scope.catalog, connection.id, item.id, "login.password"),
    );
  }
  /**
   * The new stop, in the attempt's plan, of a login whose stop lay just past its plan's
   * last step, once `next` continues its recipe (ADR 0036): the continued step that first
   * fills a slot reading a password (the `password` slot, the item's password directly or
   * through a Linked field, or a hidden custom field), or just past the continued steps
   * when they fill none and end with an `advance`. Otherwise why the continuation has no
   * such stop, as `fills-lacking` for one that first fills another value the item lacks.
   */
  function continuedStop(
    run: Execution,
    next: LoginRecipe,
    route: LoginRouteChoice,
    plan: Extract<Awaited<ReturnType<typeof planFor>>, { ok: true }>,
  ): number | PasswordStopMiss {
    const { facts } = run.metadata;
    const item = plan.connection.items.find((entry) => entry.id === plan.account.itemId);
    const slots = plan.binding.slots.map(({ slot, fieldId }) => ({
      slot,
      source: item ? loginFieldSource(item, fieldId) : fieldId,
      hidden: item?.fields.find((field) => field.id === fieldId)?.kind === "hidden",
    }));
    const passwordSlots = slots
      .filter(
        ({ slot, source, hidden }) => slot === "password" || source === "login.password" || hidden,
      )
      .map(({ slot }) => slot);
    const lacking = slots
      .filter(
        ({ source }) =>
          (source === "login.password" && !facts.password) ||
          (source === "login.totp-code" && !facts.totp),
      )
      .map(({ slot }) => slot);
    const found = passwordStopOrMiss(next, route, facts, passwordSlots, lacking);
    const known = routeSteps(run.recipe, route).length;
    if (!("stop" in found)) return found.miss;
    // A password step among the steps already run: no such stop is reachable, since those
    // steps were checked to fill no password when the login started, and no `PasswordStopMiss`
    // fits it better; the continued steps hold no step the login could still stop at.
    if (found.stop < known) return "no-password-step";
    // Entered handlers' steps all come before the continued ones.
    return found.stop + (run.metadata.stepCount - known);
  }
  /**
   * The login at its final `advance` step takes over the revision that continues its recipe
   * on the page it is on (ADR 0018, "use immediately"): only a revision that keeps the steps
   * it ran (`continuesRecipe`), and only when a dry run of the recorded route on it resolves
   * to the attempt's own account. Its earlier steps never run again; the account choice to
   * save after `authenticated` is derived again, so it covers the new slots too, filling
   * the ones a saved binding lacks (ADR 0027, amended 2026-10-19). Returns whether the
   * attempt moved on; otherwise `refused` gets a value-free code for why, for the log.
   */
  async function continueWith(
    run: Execution,
    next: LoginRecipe | LoginChooserRecipe,
    taking?: () => void,
    refused?: (reason: string) => void,
  ): Promise<boolean> {
    const refuse = (reason: string) => {
      refused?.(reason);
      return false;
    };
    const route = attemptRouteChoice(run.metadata);
    const answered = next;
    const converted = routeOf(run, next);
    if (!current(run)) return refuse("left");
    if (!converted) return refuse("route-missing");
    if (route.route !== "password") return refuse("route-not-password");
    if (converted.id !== run.recipe.id) return refuse("recipe-changed");
    if (!continuesRecipe(run.recipe, converted)) return refuse("not-continued");
    next = converted;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!current(run)) return refuse("left");
    if (!snapshot.ok) return refuse("settings-unavailable");
    if (snapshot.snapshot.revision !== run.metadata.policyRevision)
      return refuse("settings-revision");
    const plan = await planFor(snapshot, run.live, next, {
      route,
      handlerSlots: handlerSlots(next, run.metadata),
    });
    if (!current(run)) return refuse("left");
    // The plan's own refusal, such as `binding-slots-mismatch` or `field-missing`.
    if (!plan.ok) return refuse(plan.reason);
    if (
      plan.account.connectionId !== run.metadata.account.connectionId ||
      plan.account.itemId !== run.metadata.account.itemId
    )
      return refuse("account-changed");
    const added = routeSteps(next, route).slice(routeSteps(run.recipe, route).length);
    // A login whose stop lay just past its plan moves it to the continued step that fills a
    // password, or past them again; one the continuation cannot stop in is not taken over.
    const stopAt =
      run.metadata.stopAt === undefined ? undefined : continuedStop(run, next, route, plan);
    if (typeof stopAt === "string") {
      run.stopMiss = stopAt;
      return refuse(`stop:${stopAt}`);
    }
    const event: LoginAttemptEvent = {
      type: "CONTINUED",
      recipeRevision: next.revision,
      steps: added.length,
      effects: added.filter((step) => {
        const effect = loginStepEffect(step);
        return effect === "advance" || effect === "submit";
      }).length,
      document: run.live.document,
      ...(stopAt === undefined ? {} : { stopAt }),
    };
    try {
      if (transitionLoginAttempt(run.metadata, event).state !== "ready") return refuse("not-ready");
    } catch {
      // More steps or effects than one page may add.
      return refuse("budget-exceeded");
    }
    // The recipe is replaced before the record that names its revision is written.
    run.recipe = next;
    if (!isLoginRouteRecipe(answered)) run.chooser = answered;
    if (plan.choice) run.choice = plan.choice;
    else delete run.choice;
    delete run.qualified;
    delete run.stopMiss;
    await change(run, event);
    // Reported as taken over only once the record names the new revision.
    if (run.metadata.recipeRevision === next.revision) taking?.();
    return current(run) && run.metadata.state === "ready";
  }
  // State transitions, journal writes and DOM effects form an ordered protocol.
  // Parallel execution would race policy checks or repeat submission side effects.
  /* eslint-disable no-await-in-loop */
  async function reconcileBounded(run: Execution): Promise<void> {
    // An advance is confirmed by the next step's elements, which get the same wait as any
    // fill or click; other results keep the shorter observation budget.
    let until = Date.now() + (run.metadata.operationEffect === "advance" ? stepWaitMs() : 3000);
    // A held click's button may show this long before the page is left to the person.
    const holdUntil = Date.now() + HELD_CLICK_WAIT_MS;
    const observing = () => ["awaiting-result", "reconciling"].includes(run.metadata.state);
    // Each round re-authorizes against settings, so the longer advance budget polls slower.
    const interval = run.metadata.operationEffect === "advance" ? 200 : 50;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    while (current(run) && observing()) {
      const settle = Date.now() >= until;
      const held = await reconcile(run, settle);
      if (!current(run) || !observing()) return;
      // A held button gone means the person pressed it (ADR 0019); the site's answer to the
      // press is then waited for.
      if (!held) run.metadata = followPage(personAnswered(run.metadata));
      if (held) {
        if (Date.now() >= holdUntil) {
          await change(run, { type: "OBSERVED", result: "challenge", document: run.live.document });
          return;
        }
        // Once the button is gone, the result gets the usual budget.
        until = Math.max(until, Date.now() + 3000);
        await sleep(500);
        continue;
      }
      // A failed observation leaves the attempt for its next document to reconcile.
      if (settle) return;
      await sleep(interval);
    }
  }
  /**
   * Checks a new page of the tab while the login is watched after a `challenge` (ADR 0027),
   * reading only: it never fills or clicks. The login completes on a signed-in marker,
   * read for a short while as after a click, or on a confirmed sign-in state (ADR 0029: E1
   * to E3). A page with no sign of a sign-in going on and no evidence is judged, from the
   * watch's own pages: `signed-in` completes and `rejected` ends the login as a refused
   * password, while any other answer, a refusal or a spent budget leaves it watched, with a
   * warning in the log. The document the watch began in is not checked again.
   */
  async function watchPage(run: Execution): Promise<void> {
    const { watch } = run.metadata;
    if (!watch || run.live.document.documentId === watch.documentId) return;
    const proof = markerProof(run.recipe);
    const watching = () => current(run) && run.metadata.state === "watching";
    if (proof.targets.length > 0) {
      const until = Date.now() + WATCH_SETTLE_MS;
      for (;;) {
        const observed = await observe(run, proof.targets, proof.shown, {
          links: proof.links,
          hidden: proof.hidden,
        });
        if (!observed || !watching()) return;
        if (proof.proves(observed.targets)) {
          await change(run, {
            type: "OBSERVED",
            result: "authenticated",
            document: run.live.document,
          });
          return;
        }
        if (Date.now() >= until) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    } else await new Promise<void>((resolve) => setTimeout(resolve, WATCH_SETTLE_MS));
    if (!watching()) return;
    const state = await signInState(run);
    if (!watching()) return;
    if (state?.decision === "signed-in" && state.confirmed) {
      await change(run, { type: "OBSERVED", result: "authenticated", document: run.live.document });
      return;
    }
    // The sign-in form shown again with a failure, in the first new document after the
    // submission, rejects the password even after the watch began (owner, 22:03 UTC).
    if (state?.decision === "rejected" && state.confirmed && state.reshown) {
      await change(run, {
        type: "OBSERVED",
        result: "credential-rejected",
        document: run.live.document,
      });
      return;
    }
    // So does that form shown again with nothing else on it ask again, as when the
    // submitted page settled first.
    if (state?.formAgain && state.confirmed && state.decision === "unknown") {
      await askAgain(run);
      return;
    }
    // Only a page with no sign of a sign-in going on is judged; an undecided answer never
    // completes a watched login, an optional page after the sign-in does (ADR 0065).
    if (state?.decision === "judge") await learn(run, state);
  }
  async function drive(run: Execution): Promise<void> {
    if (run.running) return;
    run.running = true;
    try {
      // A failure that changed nothing on the page is tried again from the same step, up
      // to the attempt's retry budget; a spent budget ends it `retry-limit` (owner
      // decision, 2026-10-12). A TOTP code's click after the code is in is never retried:
      // a late click could submit an expired code (ADR 0027).
      for (;;) {
        await runSteps(run);
        if (!current(run) || run.metadata.state !== "retryable") return;
        const final = codeStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
        await change(run, final ? { type: "RETRY", final: true } : { type: "RETRY" });
      }
    } catch (error) {
      if (current(run) && !terminal(run.metadata)) {
        run.metadata = recoverLoginAttempt(run.metadata);
        // A submit that replaced the document is how most logins go on: the next document
        // resumes the attempt, so this is no exception (2026-10-12 logs).
        if (error instanceof DocumentGone)
          reportAttempt(run.metadata, run.recipe, undefined, {
            stop: "document-gone",
            // A fill-only login keeps `fill-only` as its reason.
            ...(run.metadata.fillOnly ? {} : { reason: error.reason }),
          });
        else
          report(run.metadata.document, {
            type: "exception",
            tabId: run.metadata.document.tabId,
            origin: run.metadata.document.origin,
            recipeId: run.metadata.recipeId,
            recipeRevision: run.metadata.recipeRevision,
            route: run.metadata.route,
            state: run.metadata.state,
            stepIndex: run.metadata.stepIndex,
            ...(unsubmitted(run.metadata) ? { unsubmitted: true as const } : {}),
            ...(run.metadata.fillOnly ? { fillOnly: true as const } : {}),
            name: error instanceof Error ? error.name : typeof error,
            ...(error instanceof Error ? { message: error.message } : {}),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          });
        await save(run).catch(() => undefined);
        await publish(run.live, run.metadata);
      }
    } finally {
      run.running = false;
    }
  }
  /** Runs the attempt's steps until it leaves `ready`; `drive` owns errors and retries. */
  async function runSteps(run: Execution): Promise<void> {
    if (run.metadata.state === "watching") {
      await watchPage(run);
      return;
    }
    // A result that settled as unknown is watched from the next page on: the document the
    // watch began in is not read again, as when a restarted worker resumes the login there
    // (ADR 0027).
    if (settledHere(run)) return;
    if (run.metadata.state === "reconciling" || run.metadata.state === "awaiting-result")
      await reconcileBounded(run);
    while (current(run) && run.metadata.state === "ready") {
      // The page's own passkey request decides the route before anything is submitted,
      // and that route answers it instead of taking a step on the page (ADR 0034).
      if (await switchToPasskey(run)) continue;
      if (
        run.metadata.route === "passkey" &&
        run.metadata.stepIndex === 0 &&
        passkeyAnswersRequest(run.recipe)
      ) {
        await answerRequest(run);
        // A step that was not authorized or not prepared leaves the login where it was, as
        // a refused step does below; it is driven again from the page.
        if (
          current(run) &&
          run.metadata.state === "ready" &&
          run.metadata.route === "passkey" &&
          run.metadata.stepIndex === 0
        )
          return;
        continue;
      }
      // A login of an item without a password fills nothing at its stop, but answers its
      // page's passkey request there (ADR 0036).
      if (atStop(run.metadata)) {
        await stopBeforePassword(run);
        if (current(run) && run.metadata.state === "ready" && atStop(run.metadata)) return;
        continue;
      }
      if (!(await allowed(run))) return;
      // A fill or click waits for its elements before any intent, vault read or value
      // delivery; a slow render is not a failure until the owner-approved limit passes.
      const upcoming = attemptPlan(run.recipe, run.metadata)?.[run.metadata.stepIndex]?.step;
      // A fill-only login stops before anything that may advance or submit, and before a
      // fill on a software keyboard, whose presses the page may act on (ADR 0021 D, 0067).
      if (run.metadata.fillOnly && (!upcoming || fillOnlyStops(upcoming))) {
        await endFillOnly(run);
        return;
      }
      if (upcoming?.kind === "fill" || upcoming?.kind === "click") {
        // A code input may submit by itself once the code is in, as one that submits on
        // its last digit does, and so may a software keyboard; its click then has nothing
        // left to do (ADR 0027, ADR 0067).
        const afterCode =
          upcoming.kind === "click" &&
          selfSubmitStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
        if (afterCode && (await submittedByPage(run, upcoming))) {
          if (!current(run) || run.metadata.state !== "ready") return;
          if (await codeSubmitted(run)) continue;
          await change(
            run,
            { type: "FAILED", reason: "structural-mismatch" },
            undefined,
            "code-not-submitted",
          );
          return;
        }
        if (!current(run) || run.metadata.state !== "ready") return;
        // A chooser login's click on its list waits for the list (ADR 0028).
        const onList = run.metadata.stepIndex === 0 ? listOf(run) : undefined;
        const waited = await waitFor(
          run,
          onList ? listReadiness(onList.chooser) : loginReadiness(upcoming),
        );
        if (!current(run) || run.metadata.state !== "ready") return;
        if (waited === "timeout") {
          if (
            afterCode &&
            (await submittedByPage(run, upcoming)) &&
            current(run) &&
            run.metadata.state === "ready" &&
            (await codeSubmitted(run))
          )
            continue;
          if (!current(run) || run.metadata.state !== "ready") return;
          // Another layout's step may show where the layouts part (ADR 0060).
          if (await switchLayout(run)) continue;
          if (!current(run) || run.metadata.state !== "ready") return;
          await change(
            run,
            { type: "FAILED", reason: "structural-mismatch" },
            undefined,
            "elements-timeout",
          );
          return;
        }
        if (waited !== "ready" || !(await allowed(run))) return;
        // A request the page made while the step waited still decides the route before the
        // first submission, as a chooser login's click on its list is (ADR 0034).
        if (await switchToPasskey(run)) continue;
      }
      const operation = nextLoginOperation(run.metadata, run.recipe, run.live.document, newId());
      if (!operation) {
        await change(
          run,
          { type: "FAILED", reason: "structural-mismatch" },
          undefined,
          "no-operation",
        );
        return;
      }
      // An advance whose next step is on its path is confirmed by that step's elements
      // only if they were not usable just before it (ADR 0013).
      const inPlace = inPlaceNext(run.recipe, run.metadata, operation.stepIndex);
      // So is a switch to another layout whose next step is on its path (ADR 0060).
      const siblingsNext =
        loginStepEffect(operation.step) === "advance"
          ? (await siblingsAt(run, operation.stepIndex + 1))
              .flatMap((sibling) => {
                const next = inPlaceNext(sibling, run.metadata, operation.stepIndex);
                return next ? [{ layout: sibling.layout!, next }] : [];
              })
              .slice(0, 2)
          : [];
      if (!current(run) || run.metadata.state !== "ready") return;
      delete run.inPlace;
      delete run.siblingsInPlace;
      // Known before its intent is recorded, so a stop in between takes the intent back.
      run.operation = operation;
      run.delivered = false;
      await change(run, {
        type: "PREPARE",
        operationId: operation.operationId,
        kind: operation.step.kind,
        effect: loginStepEffect(operation.step),
      });
      if (operation.step.kind === "click")
        await change(run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
      else if (operation.step.kind === "fill")
        await change(run, { type: "MUTATION_INTENT", operationId: operation.operationId });
      const authorized = await allowed(run);
      if (!authorized) return;
      if (
        !validateLoginOperation(
          operation,
          run.metadata,
          run.live.document,
          run.metadata.policyRevision,
        )
      ) {
        // Nothing went to the page, so a fill is tried again, as one the page refused before
        // any input is, rather than observed as one that may have submitted.
        await change(
          run,
          {
            type: "FAILED",
            reason: "timeout",
            ...(operation.step.kind === "fill" &&
            run.metadata.operationId === operation.operationId &&
            run.metadata.mutationIntent === true
              ? {
                  mutation: "none" as const,
                  operationId: operation.operationId,
                  document: operation.document,
                }
              : {}),
          },
          undefined,
          "operation-invalid",
        );
        return;
      }
      const values: {
        slot: string;
        value: string;
        secret?: LoginSecretKind;
        question?: AskedQuestion;
        group?: number;
        part?: DatePart;
        shortYear?: true;
      }[] = [];
      let expected: { username: string } | undefined;
      let list: ({ username: string; others: string[] } & Record<string, unknown>) | undefined;
      let response: unknown;
      try {
        if (operation.step.kind === "fill") {
          for (const field of operation.step.fields) {
            // A `detail` handler's input reads the vault field linked to the login item,
            // not one of its own slots (ADR 0061).
            const own = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
            if (
              isDetailSlot(field.slot) &&
              own !== undefined &&
              run.recipe.handlers?.[own]?.kind === "detail"
            ) {
              // Every part of a split value is made at once, after one read (ADR 0061).
              if (values.some((entry) => isDetailSlot(entry.slot))) continue;
              const made = await detailFill(run, authorized, operation.stepIndex);
              if (!current(run)) return;
              const handler = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
              // A card number or PIN whose digits its groups cannot take is left to the
              // person, as a split value no input takes is (ADR 0061).
              if (made === "unfit") {
                if (handler !== undefined)
                  reportDetail(run.live.document, run.recipe, handler, "detail-unfit");
                await change(run, {
                  type: "VALUE_REJECTED",
                  operationId: operation.operationId,
                  document: run.live.document,
                  stage: "before-fill",
                  challenge: true,
                });
                return;
              }
              if (typeof made === "string") {
                if (handler !== undefined)
                  reportDetail(run.live.document, run.recipe, handler, `detail-${made}`);
                await change(
                  run,
                  { type: "POLICY_CHANGED" },
                  { cause: "field-unavailable", reason: `detail-${made}` },
                );
                return;
              }
              const slots = operation.step.fields.filter((entry) => isDetailSlot(entry.slot));
              if (made.length !== slots.length) {
                for (const entry of made) entry.value = "";
                await change(
                  run,
                  { type: "FAILED", reason: "structural-mismatch" },
                  undefined,
                  "unexpected-values",
                );
                return;
              }
              for (const [at, entry] of made.entries())
                values.push({ slot: detailSlot(at), ...entry });
              continue;
            }
            const reference = authorized.binding.slots.find((entry) => entry.slot === field.slot);
            if (!reference) {
              await change(
                run,
                { type: "FAILED", reason: "structural-mismatch" },
                undefined,
                "slot-unbound",
              );
              return;
            }
            // Vault reads are serial so a denial stops before any later field is released.
            // The `totp` slot always fills a code made from its field, never the raw value.
            const code = field.slot === TOTP_HANDLER_SLOT;
            let value: string | undefined;
            try {
              value = await fields({
                account: run.metadata.account,
                connection: authorized.connection,
                fieldId: reference.fieldId,
                ...(code ? { code: true as const } : {}),
              });
            } catch {
              // A failed read is not a page mutation; never reclassify it as uncertain.
              value = undefined;
            }
            if (!current(run)) return;
            // Locked, resynchronized or newly denied vault access withdraws this grant.
            if (value === undefined) {
              await change(run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
              return;
            }
            // A code, as any `totp` handler's fill, fills only a code input.
            const secret: LoginSecretKind | undefined =
              code ||
              (codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
                attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler !== undefined)
                ? "otp"
                : loginSecretKind(
                    authorized.connection,
                    run.metadata.account.itemId,
                    reference.fieldId,
                  );
            values.push({ slot: field.slot, value, ...(secret ? { secret } : {}) });
          }
          // A step that fills a secret but no username, such as a password page for a
          // remembered account, must not show another account (owner decision,
          // 2026-10-11). Without a readable username the page is not compared.
          const usernameField = loginUsernameFieldId(
            authorized.connection,
            run.metadata.account.itemId,
          );
          if (
            usernameField &&
            values.some((entry) => entry.secret) &&
            !operation.step.fields.some((field) =>
              authorized.binding.slots.some(
                (entry) =>
                  entry.slot === field.slot &&
                  loginFillsUsername(
                    authorized.connection,
                    run.metadata.account.itemId,
                    entry.fieldId,
                  ),
              ),
            )
          ) {
            let username: string | undefined;
            try {
              username = await fields({
                account: run.metadata.account,
                connection: authorized.connection,
                fieldId: usernameField,
              });
            } catch {
              username = undefined;
            }
            if (!current(run)) return;
            if (username) expected = { username };
          }
        }
        // A chooser login's click on its list goes where the list's choice for its account
        // is now (ADR 0028), read just before the click as a fill's values are.
        const onList = operation.stepIndex === 0 ? listOf(run) : undefined;
        if (operation.step.kind === "click" && onList) {
          const snapshot = await settings.handle({ version: 1, type: "settings.get" });
          if (!current(run)) return;
          if (!snapshot.ok) {
            await change(run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
            return;
          }
          const usernames = await listUsernames(snapshot, run.live, run.metadata.account);
          if (!current(run)) return;
          if (!usernames) {
            await change(run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
            return;
          }
          list = { ...usernames, ...listButtons(onList.chooser), click: onList.click };
        }
        if (operation.step.kind === "fill" || operation.step.kind === "click")
          await pause("before-delivery");
        if (!current(run)) return;
        const latest = await allowed(run);
        if (!latest) return;
        // Values belong to the snapshot that authorized them; a replacement withdraws them.
        if (latest.connection.snapshotId !== authorized.connection.snapshotId) {
          await change(run, { type: "POLICY_CHANGED" }, { cause: "vault-replaced" });
          return;
        }
        const after = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex + 1]?.step;
        const codeSubmit =
          codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
          codeStep(run.recipe, run.metadata, operation.stepIndex + 1) === "click" &&
          after?.kind === "click"
            ? after.target
            : undefined;
        const ownHandler = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
        // A `password` handler's button is pressed only while its rendered text, read in the
        // same task as the press, still names the password choice (ADR 0048).
        const passwordChoice =
          operation.step.kind === "click" &&
          ownHandler !== undefined &&
          run.recipe.handlers?.[ownHandler]?.kind === "password";
        run.delivered = true;
        const { tabId } = run.live.document;
        if (
          values.some((entry) => entry.secret === "password") &&
          passwordFills.get(tabId)?.attemptId !== run.metadata.id
        )
          passwordFills.set(tabId, { attemptId: run.metadata.id, submitted: false });
        if (
          operation.step.kind === "click" ||
          (operation.step.kind === "fill" && operation.step.effect !== "prepare")
        ) {
          const at = Date.now();
          const request =
            (run.metadata.route === "passkey" && ownHandler === undefined) ||
            (ownHandler !== undefined && run.recipe.handlers?.[ownHandler]?.kind === "passkey");
          const before = effects.get(tabId);
          const requestAt = request
            ? at
            : before?.attemptId === run.metadata.id
              ? before.requestAt
              : undefined;
          effects.set(tabId, {
            attemptId: run.metadata.id,
            at,
            document: run.live.document,
            submits: loginStepEffect(operation.step) === "submit",
            passkey:
              run.metadata.route === "passkey" ||
              (ownHandler !== undefined && run.recipe.handlers?.[ownHandler]?.kind === "passkey"),
            request,
            ...(requestAt === undefined ? {} : { requestAt }),
            ...(codeStep(run.recipe, run.metadata, operation.stepIndex) ? { code: at } : {}),
          });
          // A passkey handler's click asks for the passkey; it does not submit the password.
          const fill = passwordFills.get(tabId);
          if (
            fill?.attemptId === run.metadata.id &&
            loginStepEffect(operation.step) === "submit" &&
            !effects.get(tabId)?.passkey
          )
            fill.submitted = true;
        } else if (codeSubmit) {
          // The page may submit the code by itself once it is in (ADR 0027), and leave
          // before it answers, so the code counts from its delivery; the page the tab moves
          // to must still show the sign-in (ADR 0022).
          const effect = effects.get(tabId);
          if (effect?.attemptId === run.metadata.id) effect.code = Date.now();
        }
        if (operation.step.kind === "fill" && signInUrls.get(tabId)?.attemptId !== run.metadata.id)
          signInUrls.set(tabId, { attemptId: run.metadata.id, url: run.live.url });
        response = await send(run.live, {
          type: "login.execute",
          operation,
          values,
          ...(expected ? { account: expected } : {}),
          ...(list ? { list } : {}),
          // One switch per tab: an attempt that follows a switch never clicks another.
          // A fill-only login never clicks, not even a switch (ADR 0021 D).
          ...(expected && !run.metadata.accountSwitched && !run.metadata.fillOnly
            ? run.recipe.accountSwitch
              ? { accountSwitch: run.recipe.accountSwitch }
              : { otherSwitch: true as const }
            : {}),
          // A `totp` handler's code fill watches for the page submitting the code itself; a
          // handler's without a button types the code as its submission (ADR 0027).
          ...(codeSubmit
            ? { code: { submit: codeSubmit } }
            : operation.step.kind === "fill" &&
                operation.step.effect === "submit" &&
                codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill"
              ? { code: {} }
              : {}),
          ...(passwordChoice ? { passwordChoice: true as const } : {}),
          // A `detail` handler's input is filled after its choosing radio (ADR 0061).
          ...(operation.step.kind === "fill" &&
          operation.step.fields.some((field) => isDetailSlot(field.slot))
            ? { choose: true as const }
            : {}),
          // An advance whose next step is on its path has the document measure that step
          // just before its effect, in the same task (ADR 0013).
          ...(inPlace ? { next: inPlace } : {}),
          ...(siblingsNext.length ? { siblings: siblingsNext.map(({ next }) => next) } : {}),
        });
      } finally {
        for (const entry of values) entry.value = "";
        if (expected) expected.username = "";
        if (list) {
          list.username = "";
          list.others.fill("");
        }
      }
      if (!current(run)) return;
      if (operation.step.kind === "fill" || operation.step.kind === "click")
        await pause("before-ack");
      if (!current(run)) return;
      delete run.operation;
      const result = v.safeParse(executionResultSchema, response);
      const matchedResult =
        result.success &&
        result.output.operationId === operation.operationId &&
        result.output.documentId === run.live.document.documentId;
      // A keypad fill's key press counts toward the page's own submission while the fill
      // runs, and once it went in until its click is prepared; an answered stop ends it, as
      // does the next operation's answer (ADR 0067). A fill left unanswered, as by a page
      // that went away during it, keeps it for the page that follows.
      const press = keypadPresses.get(run.metadata.id);
      if (press?.operationId === operation.operationId && matchedResult && result.output.ok)
        press.filled = true;
      else if (press && (press.operationId !== operation.operationId || matchedResult))
        keypadPresses.delete(run.metadata.id);
      // A click left to the person under a CAPTCHA is then observed as Pateat's own click.
      const leftToPerson =
        matchedResult &&
        !result.output.ok &&
        result.output.reason === "captcha" &&
        operation.step.kind === "click";
      // Without the measurement the advance can only be confirmed on another path.
      if (
        matchedResult &&
        (result.output.ok || leftToPerson) &&
        inPlace &&
        result.output.before?.length === inPlace.targets.length
      )
        run.inPlace = { operationId: operation.operationId, before: result.output.before };
      if (matchedResult && (result.output.ok || leftToPerson)) {
        const siblings = siblingsNext.flatMap(({ layout, next }, index) => {
          const before = result.output.siblingsBefore?.[index];
          return before?.length === next.targets.length ? [{ layout, before }] : [];
        });
        if (siblings.length) run.siblingsInPlace = { operationId: operation.operationId, siblings };
      }
      if (
        matchedResult &&
        !result.output.ok &&
        result.output.reason === "wrong-account" &&
        result.output.mutation === "none"
      ) {
        const switched =
          result.output.switchable === true &&
          !run.metadata.accountSwitched &&
          !run.metadata.fillOnly;
        await change(run, {
          type: "WRONG_ACCOUNT",
          operationId: operation.operationId,
          document: run.live.document,
          ...(switched ? { switched: true } : {}),
        });
        // The page shows another account: a fill-only login ends and asks.
        if (run.metadata.fillOnly) {
          await endFillOnly(run);
          return;
        }
        // The switch is recorded before the click, so the page it leads to starts a new
        // attempt instead of resuming this one (owner decision, 2026-10-11).
        if (run.metadata.outcome === "account-switched") {
          const clicked =
            current(run) &&
            v.safeParse(
              v.object({ ok: v.literal(true) }),
              await send(run.live, {
                type: "login.switch",
                operationId: operation.operationId,
              }).catch(() => undefined),
            ).success;
          // Without the click the attempt ends as `wrong-account` and keeps its tab.
          if (!clicked) await withdrawSwitch(run);
        }
        return;
      }
      // The page would not accept the values; the same values would fail again. A code
      // typed as its own submission whose character the page kept out never went in whole.
      const codeRefused =
        operation.step.kind === "fill" &&
        operation.step.effect === "submit" &&
        codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill";
      if (
        matchedResult &&
        !result.output.ok &&
        operation.step.kind === "fill" &&
        ((result.output.reason === "value-mismatch" && result.output.mutation === "none") ||
          (result.output.reason === "fill-rejected" &&
            (operation.step.effect === "prepare" || codeRefused)))
      ) {
        // A `detail` handler's value split over several inputs that fits none of them, as
        // when no option of a select matches its part, fills nothing and leaves the page
        // to the person (ADR 0061).
        const own = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
        const unfit =
          result.output.reason === "value-mismatch" &&
          own !== undefined &&
          run.recipe.handlers?.[own]?.kind === "detail" &&
          operation.step.fields.filter((field) => isDetailSlot(field.slot)).length > 1;
        if (unfit) reportDetail(run.live.document, run.recipe, own, "detail-unfit");
        // The page's detail goes to the log and the popup, as `keypad-pressed` after a key
        // press on its keypad (ADR 0067).
        await change(
          run,
          {
            type: "VALUE_REJECTED",
            operationId: operation.operationId,
            document: run.live.document,
            stage:
              result.output.reason === "value-mismatch"
                ? "before-fill"
                : codeRefused
                  ? "code-refused"
                  : "after-fill",
            ...(unfit ? { challenge: true as const } : {}),
          },
          undefined,
          result.output.detail,
        );
        return;
      }
      // The code page showed that it submits the code by itself, or replaced its form
      // once the code was in. A code typed as its own submission is settled as one below.
      // A software keyboard's page moved or took its field away once a key was pressed,
      // as a PIN pad that submits at its last digit (ADR 0067); a keypad step's other
      // failures, as a missing key, are no submission.
      if (
        matchedResult &&
        !result.output.ok &&
        result.output.mutation === "possible" &&
        operation.step.kind === "fill" &&
        operation.step.effect === "prepare" &&
        (result.output.reason === "submitted"
          ? selfSubmitStep(run.recipe, run.metadata, operation.stepIndex) === "fill"
          : result.output.reason === "structural-mismatch" &&
            codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill") &&
        (await codeSubmitted(run))
      )
        continue;
      if (leftToPerson) {
        // The person's own click, while the button is held, is their time (ADR 0019).
        run.metadata = awaitPerson(run.metadata);
        await change(
          run,
          { type: "SUBMITTED", operationId: operation.operationId },
          undefined,
          "captcha-shown",
        );
        // Its button is held until the person presses it or the hold ends (ADR 0029, S4),
        // and a rejection the page already showed is not taken as the person's.
        run.heldClick = operation.stepIndex;
        run.staleRejection = true;
        await reconcileBounded(run);
        if (run.metadata.state !== "ready") return;
        continue;
      }
      if (!matchedResult || !result.output.ok) {
        await change(
          run,
          matchedResult && result.output.reason === "cancelled"
            ? { type: "CANCEL" }
            : {
                type: "FAILED",
                reason:
                  matchedResult && result.output.reason === "timeout"
                    ? "timeout"
                    : "structural-mismatch",
                mutation: matchedResult ? result.output.mutation : "possible",
                operationId: operation.operationId,
                document: run.live.document,
              },
          undefined,
          !matchedResult
            ? "no-answer"
            : result.output.reason === "submitted"
              ? "page-submitted"
              : result.output.detail,
        );
        return;
      }
      if (
        operation.step.kind !== "click" &&
        !(operation.step.kind === "fill" && operation.step.effect !== "prepare")
      ) {
        await change(run, { type: "OPERATION_OK", operationId: operation.operationId });
        continue;
      }
      await change(run, { type: "SUBMITTED", operationId: operation.operationId });
      // A handler's click and the passkey route's click are held (ADR 0027).
      const done = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex];
      if (done && (done.handler !== undefined || run.metadata.route === "passkey"))
        run.heldClick = operation.stepIndex;
      // DOM navigation can replace this document. A same-page result is observed with a finite budget.
      await reconcileBounded(run);
      if (run.metadata.state !== "ready") return;
    }
  }
  /* eslint-enable no-await-in-loop */
  /**
   * First steps a document watches for: every route's and variant's of each recipe,
   * deduplicated and bounded for the wire. A path where several recipes start is left out,
   * because such a page cannot start (ADR 0013); several variants of one recipe starting
   * there do not (ADR 0027).
   */
  async function startsFor(documentOrigin: string): Promise<LoginReadiness[]> {
    const all =
      probeMode && documentOrigin === origin
        ? probeStarts(origin)
        : await recipes.starts(documentOrigin).catch(() => []);
    // A chooser's list is ready once one of its buttons or a listed account shows, and so
    // is its path once it shows the `other` branch's first step instead (ADR 0028).
    const readiness = all
      .filter((start) => all.filter((other) => other.path === start.path).length === 1)
      .flatMap((start): LoginReadiness[] => [
        ...(start.list
          ? [
              {
                path: start.path,
                require: "clickable" as const,
                targets: start.list,
                accounts: true as const,
              },
            ]
          : []),
        ...start.steps.map(loginReadiness),
      ]);
    // Later steps come after every first step, so the bound for the wire drops them first
    // (ADR 0049); a path several recipes start on keeps them, as another recipe may own them.
    const later = all.flatMap((start) => start.later ?? []);
    const unique = new Map([...readiness, ...later].map((entry) => [JSON.stringify(entry), entry]));
    return [...unique.values()].slice(0, 32);
  }
  /**
   * Whether this document may be sent for generation once it shows a sign-in input: a
   * top-level page on whose path no cached recipe of its origin starts (several starting
   * there count too), and whose path was not sent within the retry window (ADR 0016). An
   * entry recipe's path counts as a start (ADR 0031); it is added here only, since
   * `startsFor` leaves out a path several starts share. So does the first page of a recipe
   * generated as `confirm` or `unclear`, which never starts (ADR 0035). A frame is never
   * sent; one that would be offered as the tab's page is `frame`, asked to report a sign-in
   * input or a secret answer so that such pages are counted (ADR 0035).
   */
  async function offersGeneration(
    live: LiveDocument,
  ): Promise<true | "frame" | GenerationHold | undefined> {
    const framed = live.document.frameId !== 0;
    if (!generation || !uris || (!framed && live.topUrl)) return undefined;
    if (probeMode && live.document.origin === origin) return undefined;
    const starts = await recipes.starts(live.document.origin).catch(() => undefined);
    if (starts === undefined || starts.some((start) => start.path === live.path)) return undefined;
    const entries = await recipes.entries(live.document.origin).catch(() => undefined);
    if (entries === undefined || entries.some((entry) => entry.entry.path === live.path))
      return undefined;
    const routes = await routesOf(live.document.origin);
    if (
      routes === undefined ||
      routes.some((recipe) => !runsLogin(recipe) && recipe.steps[0]?.path === live.path)
    )
      return undefined;
    const hold = await generation.available(live.document.origin, live.path).catch(() => undefined);
    // A frame counts only where its page would be sent now.
    if (framed) return hold === true ? "frame" : undefined;
    return hold;
  }
  /**
   * Every route recipe of the origin whatever its kind, and each chooser branch (ADR 0035),
   * or undefined unread.
   */
  async function routesOf(pageOrigin: string): Promise<LoginRecipe[] | undefined> {
    if (probeMode && pageOrigin === origin) return [];
    return Promise.resolve(recipes.routes?.(pageOrigin) ?? []).catch(() => undefined);
  }
  /**
   * The origin's recipe generated as `confirm` or `unclear` whose first page is `path`
   * (ADR 0035): its page never starts a login.
   */
  async function confirmRecipeOn(
    pageOrigin: string,
    path: string,
  ): Promise<LoginRecipe | undefined> {
    return (await routesOf(pageOrigin))?.find(
      (recipe) => !runsLogin(recipe) && recipe.steps[0]?.path === path,
    );
  }
  /**
   * Whether a chooser's path may be sent as its `other` branch's first page (ADR 0028):
   * `true`, why not, or `undefined` for a page that is never sent.
   */
  async function offersOther(
    live: LiveDocument,
    chooser: LoginChooserRecipe,
  ): Promise<true | GenerationHold | undefined> {
    if (!generation || !uris || live.document.frameId !== 0 || live.topUrl) return undefined;
    if (probeMode && live.document.origin === origin) return undefined;
    return generation
      .available(
        live.document.origin,
        live.path,
        { recipeId: chooser.id, revision: chooser.revision },
        chooser.layout === undefined ? undefined : recipeBranch(chooser.layout, "other"),
      )
      .catch(() => undefined);
  }
  /**
   * The slots to generate for when a vault item's URI matches the page, with the
   * matching items. No field value is read here. Without them, `miss` hears why, for the
   * log: `no-vault-match` when no item fits, or why the vault could not tell. For a
   * passkey-only page (ADR 0053), `passkeyOnly` says whether `some` matching item or
   * `every` one must hold a discoverable passkey.
   */
  async function generationSlotsFor(
    live: LiveDocument,
    miss: (reason: GenerationMiss, detail?: string) => void = () => undefined,
    passkeyOnly: false | "some" | "every" = false,
  ): Promise<GenerationScope | undefined> {
    if (!uris) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) {
      miss("vault-unavailable", "settings");
      return undefined;
    }
    // The URL the page shows now: a same-document URL change (history.pushState) since the
    // document announced shows only in the tab's committed URL.
    let url = live.url;
    try {
      const tab = await browser.tabs.get(live.document.tabId);
      if (
        live.document.frameId === 0 &&
        tab.url &&
        new URL(tab.url).origin === live.document.origin
      )
        url = tab.url;
    } catch {
      miss("vault-unavailable", "tab");
      return undefined;
    }
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url,
      match: uris,
    });
    if (!scope.ok) {
      miss("no-vault-match", scope.reason);
      return undefined;
    }
    const items = catalogItems(snapshot.catalog, scope.candidates);
    // Only slots a matching item can fill; built-in fields keep these IDs on every device.
    const slots = generationSlots.filter(({ fieldId }) =>
      items.some(({ connection, item }) =>
        offersGenerationField(
          snapshot.snapshot.settings,
          snapshot.catalog,
          { connectionId: connection.id, item },
          fieldId,
        ),
      ),
    );
    // Custom fields are offered by name only when the item allows them (ADR 0027).
    const offers = customFieldOffers(
      items.flatMap(({ connection, item }) => {
        const eligibility = getItemEligibility(
          snapshot.snapshot.settings,
          snapshot.catalog,
          connection.id,
          item.id,
        );
        return eligibility.eligible
          ? [{ connectionId: connection.id, item, allowedFieldIds: eligibility.fieldIds }]
          : [];
      }),
    );
    // A passkey-only page fills nothing, so it needs a matching item rather than a slot.
    if (passkeyOnly ? !items.length : !slots.length && !offers.length) {
      const enabled = snapshot.catalog.connections.some((connection) =>
        connectionEnabled(snapshot.snapshot.settings, snapshot.catalog, connection.id),
      );
      const unavailable = scope.unavailableConnections[0]?.reason;
      if (items.length) miss("no-vault-match", "no-slots");
      // A device without any vault connection is not a problem to log at info level.
      else if (!snapshot.catalog.connections.length) miss("no-vault-match", "no-connection");
      else if (!enabled) miss("connection-disabled");
      else if (unavailable) miss("vault-unavailable", logCode(unavailable));
      // An item whose URIs could not all be checked may still belong to the page.
      else if (scope.incompleteItems.length) miss("no-vault-match", "incomplete-item");
      else miss("no-vault-match", "no-item");
      return undefined;
    }
    // A passkey-only page also needs a usable discoverable passkey held by one of the
    // matching items (ADR 0053), looked up only once an item matched; passwords and
    // unrelated RP matches never authorize generation. On a site whose passkey requests go
    // to the browser no item holds one Pateat may use (ADR 0007).
    if (passkeyOnly) {
      const browserSite = listedBrowserSite(snapshot.snapshot.settings, live.document.origin);
      const leave = browserSite
        ? undefined
        : await options.vault?.enter(false).catch(() => undefined);
      let held: readonly PasskeyItem[] = [];
      try {
        if (!browserSite) held = (await options.passkeyItems?.(live.document.origin)) ?? [];
      } catch {
        held = [];
      } finally {
        leave?.();
      }
      const holds = ({ connection, item }: (typeof items)[number]) =>
        held.some((key) => key.connectionId === connection.id && key.itemId === item.id);
      if (passkeyOnly === "every" ? !items.every(holds) : !items.some(holds)) {
        miss("no-vault-match", "no-passkey");
        return undefined;
      }
    }
    return {
      slots: slots.map(({ slot }) => slot),
      offers,
      items,
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      // An item that could not be checked might have another username.
      complete: !scope.unavailableConnections.length && !scope.incompleteItems.length,
    };
  }
  /**
   * The shape the given values share (ADR 0010), read locally just before the page is sent
   * (owner decision, 2026-10-11): only when every non-empty value gives the same length,
   * character classes and email form. An empty value does not count; a scope with items
   * that could not be checked, a read that fails, or a value too long to shape sends no
   * shape. Values are read one at a time and never kept.
   */
  async function sharedShape(
    pageOrigin: string,
    scope: GenerationScope,
    reads: readonly {
      connection: VaultConnectionMetadata;
      itemId: string;
      fieldId: string;
      source: "username" | "text";
    }[],
  ): Promise<ValueShape | undefined> {
    if (!scope.complete) return undefined;
    let shape: ValueShape | undefined;
    for (const { connection, itemId, fieldId, source } of reads) {
      let value: string | undefined;
      try {
        // Serial reads through the shared vault host, as for a fill.
        // eslint-disable-next-line no-await-in-loop
        value = await fields({
          account: { origin: pageOrigin, connectionId: connection.id, itemId },
          connection,
          fieldId,
        });
      } catch {
        value = undefined;
      }
      if (value === undefined) return undefined;
      if (!value) continue;
      const itemShape = valueShapeOf({ source, value });
      value = "";
      // A value too long to shape cannot be compared.
      if (!itemShape) return undefined;
      if (shape && JSON.stringify(shape) !== JSON.stringify(itemShape)) return undefined;
      shape = itemShape;
    }
    return shape;
  }
  /**
   * The matching items' username reads: none for an item without one, with an empty one
   * (the catalog's value-free `empty` flag) or whose username the user excluded.
   */
  function usernameReads(scope: Pick<GenerationScope, "items" | "settings" | "catalog">) {
    return scope.items.flatMap(({ connection, item }) => {
      const excluded = isFieldExcluded(
        scope.settings,
        scope.catalog,
        connection.id,
        item.id,
        "login.username",
      );
      return excluded ||
        !item.fields.some((field) => field.id === "login.username" && field.empty !== true)
        ? []
        : [
            {
              connection,
              itemId: item.id,
              fieldId: "login.username",
              source: "username" as const,
            },
          ];
    });
  }
  /**
   * The shown texts that name a matching item's username that is not an email: the whole
   * text equals it, ignoring case and a leading `@` (ADR 0028, owner 2026-10-12 08:36
   * UTC); and whether the page's path holds a matching item's username, as a signed-in
   * page under the account's own name does, where the list is not read (owner
   * 2026-10-12 19:45 UTC). Usernames are read one at a time here and never kept or sent
   * to the page.
   */
  async function listedNames(
    pageOrigin: string,
    scope: GenerationScope,
    texts: readonly string[],
    path: string,
  ): Promise<{ names: string[]; inPath: boolean; email: boolean }> {
    const found = new Set<string>();
    let inPath = false;
    let email = false;
    for (const { connection, itemId, fieldId } of usernameReads(scope)) {
      let value: string | undefined;
      try {
        // Serial reads through the shared vault host, as for a fill.
        // eslint-disable-next-line no-await-in-loop
        value = await fields({
          account: { origin: pageOrigin, connectionId: connection.id, itemId },
          connection,
          fieldId,
        });
      } catch {
        value = undefined;
      }
      if (value) {
        for (const text of texts) if (namesUsername(text, value)) found.add(text);
        if (pathShowsUsername(path, [value])) inPath = true;
        if (emailUsername(value)) email = true;
      }
      value = "";
    }
    return { names: [...found], inPath, email };
  }
  /**
   * What a chooser login compares on its list (ADR 0028): the account's username and, for
   * an email username, the other matching items' usernames, one at a time through the
   * vault and never kept. The others are complete only when every matching item was read:
   * an item that cannot be read, or whose username the user excluded, or more than 32
   * items, leave them incomplete, and then no masked address fits. `undefined` when the
   * account's username cannot be read.
   */
  async function listUsernames(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    chosen: { connectionId: string; itemId: string },
  ): Promise<{ username: string; others: string[]; othersComplete: boolean } | undefined> {
    const settingsValue = snapshot.snapshot.settings;
    /** The item's username; `""` for an item without one, `undefined` when unknown. */
    const read = async (connectionId: string, itemId: string, excluded: boolean) => {
      const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
      if (!connection) return undefined;
      const fieldId = loginUsernameFieldId(connection, itemId);
      if (!fieldId) return "";
      if (
        excluded &&
        isFieldExcluded(settingsValue, snapshot.catalog, connectionId, itemId, fieldId)
      )
        return undefined;
      try {
        return await fields({
          account: { origin: live.document.origin, connectionId, itemId },
          connection,
          fieldId,
        });
      } catch {
        return undefined;
      }
    };
    const username = await read(chosen.connectionId, chosen.itemId, false);
    if (!username) return undefined;
    const others: string[] = [];
    // Only an email username is compared with the others' (ADR 0028).
    if (!emailUsername(username)) return { username, others, othersComplete: true };
    const found = uris ? await siteCandidates(snapshot, live).catch(() => undefined) : undefined;
    const candidates = (found && "candidates" in found ? found.candidates : undefined)?.filter(
      (candidate) =>
        candidate.connectionId !== chosen.connectionId || candidate.itemId !== chosen.itemId,
    );
    let othersComplete = candidates !== undefined && candidates.length <= 32;
    for (const candidate of candidates?.slice(0, 32) ?? []) {
      // Serial reads through the shared vault host, as for a fill.
      // eslint-disable-next-line no-await-in-loop
      const value = await read(candidate.connectionId, candidate.itemId, true);
      if (value === undefined) othersComplete = false;
      else if (value) others.push(value);
    }
    return { username, others, othersComplete };
  }
  /**
   * Whether one of the recipe's signed-in markers proves a sign-in on the page as ADR 0029
   * reads it: a later step there is no start (ADR 0049).
   */
  async function showsMarker(live: LiveDocument, recipe: LoginRecipe): Promise<boolean> {
    const proof = markerProof(recipe);
    if (!proof.targets.length) return false;
    try {
      const parsed = v.safeParse(
        observationSchema,
        await send(live, {
          type: "login.observe",
          path: live.path,
          targets: proof.targets,
          require: proof.shown,
          links: proof.links,
          hidden: proof.hidden,
        }),
      );
      // A page that cannot be read starts nothing either.
      return !parsed.success || proof.proves(parsed.output.targets);
    } catch {
      return true;
    }
  }
  /** Whether the document shows a signed-in marker of any layout of the recipe (ADR 0060). */
  async function showsAnyMarker(live: LiveDocument, recipe: LoginRecipe): Promise<boolean> {
    const layouts = await Promise.resolve(recipes.layoutsOf?.(recipe.origin, recipe.id)).catch(
      () => undefined,
    );
    const all = [recipe, ...(layouts ?? []).filter((other) => other.layout !== recipe.layout)];
    for (const layout of all) if (await showsMarker(live, layout)) return true;
    return false;
  }
  /**
   * Which of `targets` the document shows now, each as one visible element: `true` shown,
   * `false` not, `undefined` not asked. The wire takes at most 24, and a page that cannot be
   * asked answers none.
   */
  async function shownTargets(
    live: LiveDocument,
    targets: readonly LoginTarget[],
  ): Promise<(target: LoginTarget) => boolean | undefined> {
    const asked = targets.slice(0, 24);
    let states: readonly string[] = [];
    if (asked.length)
      try {
        const parsed = v.safeParse(
          observationSchema,
          await send(live, {
            type: "login.observe",
            path: live.path,
            targets: asked,
            require: asked.map(() => "shown" as const),
          }),
        );
        if (parsed.success) states = parsed.output.targets;
      } catch {
        // Nothing is known of a page that could not be asked.
      }
    return (target) => {
      const at = asked.findIndex((other) => sameLoginTarget(other, target));
      return at === -1 || states[at] === undefined ? undefined : states[at] === "unique";
    };
  }
  /**
   * The page's language as its observation names it (ADR 0060), the same reading that gave
   * a layout its language when it was generated; `undefined` when the page cannot be
   * described. Read only when it decides between layouts.
   */
  async function observedLanguage(
    live: LiveDocument,
    page: "login" | "accounts",
  ): Promise<LoginObservation["language"] | undefined> {
    try {
      const extracted = v.safeParse(
        extractResultSchema,
        await send(live, { type: "login.extract", page }),
      );
      if (!extracted.success || !extracted.output.ok) return undefined;
      const described = v.safeParse(
        v.object({ language: v.picklist(["ja", "en", "mixed"]) }),
        extracted.output.observation,
      );
      return described.success ? described.output.language : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * Layouts of one recipe best first for a new login (ADR 0060): those one of whose first
   * steps (`firstStepsOf`) the document shows whole, then with the fewest of their start
   * page elements (`targetsOf`) missing, then the most shown; then the page's language, read
   * only when the best ones differ in it, and the newest (`rankLayouts`). The others drop
   * out.
   */
  async function rankedLayouts<Recipe>(
    live: LiveDocument,
    candidates: readonly LayoutCandidate<Recipe>[],
    targetsOf: (recipe: Recipe) => readonly LoginTarget[],
    firstStepsOf: (recipe: Recipe) => readonly (readonly LoginTarget[])[],
    page: "login" | "accounts",
  ): Promise<LayoutCandidate<Recipe>[]> {
    const all = candidates.flatMap((candidate) => targetsOf(candidate.recipe));
    const shows = await shownTargets(
      live,
      all.filter(
        (target, index) => all.findIndex((other) => sameLoginTarget(other, target)) === index,
      ),
    );
    const shown = candidates.map((candidate) =>
      layoutShown(firstStepsOf(candidate.recipe), targetsOf(candidate.recipe), shows),
    );
    const ranked = rankLayouts(candidates, shown);
    return languageDecides(ranked)
      ? rankLayouts(candidates, shown, await observedLanguage(live, page))
      : ranked;
  }
  /**
   * The `signedIn` hint of a page sent as a recipe's first page (ADR 0035): whether a
   * signed-in marker learned on its origin by any layout of the origin's recipes shows (ADR
   * 0060), as ADR 0029's E1 reads it, or one of `usernames`, the matching items', shows in
   * the page's header or navigation (E2). Markers past the wire's bound are left out. Only
   * the flag leaves the device; a page that cannot be read shows neither.
   */
  async function signedInHint(live: LiveDocument, usernames: readonly string[]): Promise<boolean> {
    return (
      (await showsMarkers(live, await markerProofs(live.document.origin, live.document.origin))) ||
      (await showsUsername(live, usernames))
    );
  }
  /**
   * The signed-in markers of every route recipe of `recipesOrigin` that a page of
   * `pageOrigin` may show (ADR 0029's E1), within the wire's bound of 24 targets.
   */
  async function markerProofs(
    recipesOrigin: string,
    pageOrigin: string,
  ): Promise<ReturnType<typeof markerProof>[]> {
    const proofs: ReturnType<typeof markerProof>[] = [];
    let bound = 24;
    for (const recipe of (await routesOf(recipesOrigin)) ?? []) {
      const proof = markerProof(recipe, pageOrigin);
      if (!proof.targets.length || proof.targets.length > bound) continue;
      bound -= proof.targets.length;
      proofs.push(proof);
    }
    return proofs;
  }
  /** Whether the document shows one of `proofs`' markers (E1); one that cannot be read does not. */
  async function showsMarkers(
    live: LiveDocument,
    proofs: readonly ReturnType<typeof markerProof>[],
  ): Promise<boolean> {
    if (!proofs.length) return false;
    const parsed = v.safeParse(
      observationSchema,
      await send(live, {
        type: "login.observe",
        path: live.path,
        targets: proofs.flatMap((proof) => proof.targets),
        require: proofs.flatMap((proof) => proof.shown),
        links: proofs.flatMap((proof) => proof.links),
        hidden: proofs.flatMap((proof) => proof.hidden),
      }).catch(() => undefined),
    );
    let offset = 0;
    for (const proof of proofs) {
      if (parsed.success && proof.proves(parsed.output.targets, offset)) return true;
      offset += proof.targets.length;
    }
    return false;
  }
  /**
   * Whether one of `usernames`, the matching items', shows in the document's header or
   * navigation (E2); one that cannot be read shows none. Only the flag is kept.
   */
  async function showsUsername(live: LiveDocument, usernames: readonly string[]): Promise<boolean> {
    for (const username of usernames.slice(0, MAX_HINT_USERNAMES)) {
      if (!username) continue;
      // Serial reads of one page, as for a login's own check.
      const parsed = v.safeParse(
        stateResultSchema,
        // eslint-disable-next-line no-await-in-loop
        await send(live, { type: "login.state", account: { username } }).catch(() => undefined),
      );
      if (parsed.success && parsed.output.ok && parsed.output.signs.username === true) return true;
    }
    return false;
  }
  /**
   * The tab's visit of its page `live`, on whose path `confirm`, a recipe generated as
   * `confirm` or `unclear`, starts (ADR 0035), logged when the tab leaves it. Admission
   * already left a visit of another document or path.
   */
  function confirmPage(live: LiveDocument, confirm: LoginRecipe): ConfirmVisit {
    const { tabId, documentId } = live.document;
    const kept = confirmVisits.get(tabId);
    const visit = (kept?.document.documentId === documentId && kept.path === live.path
      ? kept
      : undefined) ?? {
      document: live.document,
      path: live.path,
      url: live.url,
      recipe: { id: confirm.id, revision: confirm.revision, pageKind: confirm.pageKind },
      first: loginReadiness(confirm.steps[0]!),
      submitted: false,
    };
    confirmVisits.set(tabId, visit);
    return visit;
  }
  /**
   * What a page Pateat does not fill shows, for the evaluation of page kinds (ADR 0035),
   * never a value or page text: whether a signed-in marker of the origin's recipes shows (E1)
   * and whether a matching item's username shows in its header or navigation (E2, absent
   * when the vault matched nothing or a username could not be read), read as the `signedIn`
   * hint is, and the tab's previous page of the origin. A header rendered after the form is
   * waited for as on the next page: read a second apart at most `SITE_MOVE_READINGS` times
   * until either shows or the page goes, both from the last reading.
   */
  async function confirmSigns(
    live: LiveDocument,
  ): Promise<{ e1?: boolean; e2?: boolean; previousUrl?: string }> {
    const proofs = await markerProofs(live.document.origin, live.document.origin);
    const scope = await generationSlotsFor(live).catch(() => undefined);
    const usernames = scope && (await readUsernames(live.document.origin, usernameReads(scope)));
    // Unset until the page is read: one gone before its first reading shows neither.
    let e1: boolean | undefined;
    let e2: boolean | undefined;
    // Each reading waits for the one before, as the page goes on rendering.
    /* eslint-disable no-await-in-loop */
    for (let reading = 0; reading < SITE_MOVE_READINGS; reading++) {
      if (reading > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
      const page = documents.get(frameKey(live.document));
      if (page?.document.documentId !== live.document.documentId || page.path !== live.path) break;
      e1 = await showsMarkers(page, proofs);
      e2 = usernames && (await showsUsername(page, usernames));
      if (e1 || e2) break;
    }
    /* eslint-enable no-await-in-loop */
    usernames?.fill("");
    return {
      ...(e1 === undefined ? {} : { e1 }),
      ...(e2 === undefined ? {} : { e2 }),
      ...(live.previousUrl ? { previousUrl: live.previousUrl } : {}),
    };
  }
  /**
   * Logs the tab leaving `visit`'s page, once that page was logged (ADR 0035): whether the
   * person submitted its form and, when it showed neither E1 nor E2, whether `next`, the
   * tab's next page, shows E1. Without `next` (the tab closed, or its next page is not read)
   * that is left out.
   */
  function leaveConfirm(visit: ConfirmVisit, next?: LiveDocument): void {
    const { tabId, origin: visitOrigin } = visit.document;
    if (confirmVisits.get(tabId) === visit) confirmVisits.delete(tabId);
    void visit.logged
      ?.then(async (watchNext) => {
        const nextE1 = watchNext && next ? await nextShowsMarker(visitOrigin, next) : undefined;
        report(
          { frameId: 0 },
          {
            type: "confirm-left",
            tabId,
            origin: visitOrigin,
            recipeId: visit.recipe.id,
            recipeRevision: visit.recipe.revision,
            pageKind: visit.recipe.pageKind,
            personSubmitted: visit.submitted,
            ...(nextE1 === undefined ? {} : { nextE1 }),
            url: visit.url,
          },
        );
        return undefined;
      })
      .catch(() => undefined);
  }
  /**
   * Whether `next`, the tab's next top page after a page of `recipesOrigin` Pateat does not
   * fill, shows a signed-in marker of that origin's recipes (ADR 0035), read a second apart
   * at most `SITE_MOVE_READINGS` times while the document stays, as a page that renders its
   * header late does; undefined when it went before its first reading.
   */
  async function nextShowsMarker(
    recipesOrigin: string,
    next: LiveDocument,
  ): Promise<boolean | undefined> {
    const proofs = await markerProofs(recipesOrigin, next.document.origin);
    if (!proofs.length) return false;
    const key = frameKey(next.document);
    // Each reading waits for the one before, as the page goes on rendering.
    /* eslint-disable no-await-in-loop */
    for (let reading = 0; reading < SITE_MOVE_READINGS; reading++) {
      if (reading > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
      const nextLive = documents.get(key);
      if (nextLive?.document.documentId !== next.document.documentId)
        return reading ? false : undefined;
      if (await showsMarkers(nextLive, proofs)) return true;
    }
    /* eslint-enable no-await-in-loop */
    return false;
  }
  /**
   * The URL of the tab's previous page for its top `document`, newly announced on `path`,
   * for the log of a page Pateat does not fill (ADR 0035): `oldLive`, the tab's last read
   * top page, when it was another page of the same origin or this document before its path
   * changed in place, and what `oldLive` had when this is the same page again. A page of
   * another origin, or one Pateat did not admit in between, leaves it out.
   */
  function previousPage(
    document: LoginDocument,
    oldLive: LiveDocument | undefined,
    sameDocument: boolean,
    path: string,
  ): string | undefined {
    if (document.frameId !== 0 || !oldLive) return undefined;
    if (sameDocument && oldLive.path === path) return oldLive.previousUrl;
    if (oldLive.leftUnread || oldLive.document.origin !== document.origin) return undefined;
    return oldLive.url;
  }
  /** Whether the document shows a step's elements now, without waiting for them. */
  async function showsNow(live: LiveDocument, readiness: LoginReadiness): Promise<boolean> {
    try {
      const parsed = v.safeParse(
        awaitResultSchema,
        await send(live, { type: "login.await", readiness, timeoutMs: 0 }),
      );
      return parsed.success && parsed.output.ok;
    } catch {
      return false;
    }
  }
  /**
   * Whether a chooser login's first step is its click on the list (ADR 0028): not when it
   * started on the `other` branch's form already shown on the list's path.
   */
  const listOf = (run: Execution) =>
    run.chooser && run.metadata.chooser && run.metadata.chooser.click !== "other-shown"
      ? { chooser: run.chooser, click: run.metadata.chooser.click }
      : undefined;
  /** A chooser's buttons and what its readiness waits for on its list (ADR 0028). */
  const listButtons = (chooser: LoginChooserRecipe) => ({
    ...(chooser.chooser.other ? { other: chooser.chooser.other } : {}),
    ...(chooser.chooser.continue ? { continue: chooser.chooser.continue } : {}),
  });
  const listReadiness = (chooser: LoginChooserRecipe): LoginReadiness => ({
    path: chooser.chooser.path,
    require: "clickable",
    targets: [chooser.chooser.other, chooser.chooser.continue].filter(
      (target) => target !== undefined,
    ),
    accounts: true,
  });
  /**
   * What a new login on a chooser's list clicks for its account (ADR 0028), as the
   * document decides it now without clicking; when nothing fits, what the list showed
   * (`ListMiss`, for the log); `unreadable` when the account's username cannot be read,
   * and `undefined` when the document could not be asked or no longer shows the list.
   */
  async function listClick(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    chooser: LoginChooserRecipe,
    chosen: { connectionId: string; itemId: string },
  ): Promise<ListClick | ListMiss | "unreadable" | undefined> {
    const usernames = await listUsernames(snapshot, live, chosen);
    if (!usernames) return "unreadable";
    const list = { ...usernames, ...listButtons(chooser) };
    try {
      const parsed = v.safeParse(
        chooseResultSchema,
        await send(live, { type: "login.choose", path: chooser.chooser.path, list }),
      );
      if (!parsed.success || !parsed.output.ok) return undefined;
      return parsed.output.miss ?? (parsed.output.click as ListClick);
    } catch {
      return undefined;
    } finally {
      list.username = "";
      list.others.fill("");
    }
  }
  /**
   * The shape the matching items' usernames share (ADR 0016), from the usernames
   * {@link readUsernames} read for the page: an item without a username, or whose username
   * the user excluded, does not count. A scope with items that could not be checked, or a
   * username too long to shape, sends no shape.
   */
  function usernameShape(
    scope: Pick<GenerationScope, "complete">,
    usernames: readonly string[],
  ): ValueShape | undefined {
    if (!scope.complete) return undefined;
    let shape: ValueShape | undefined;
    for (const value of usernames) {
      const itemShape = valueShapeOf({ source: "username", value });
      // A value too long to shape cannot be compared.
      if (!itemShape) return undefined;
      if (shape && JSON.stringify(shape) !== JSON.stringify(itemShape)) return undefined;
      shape = itemShape;
    }
    return shape;
  }
  /**
   * Reads the given usernames one at a time, for the username's shape and for hiding them
   * from the page sent to the service, and never for anything else: they are never sent
   * or logged. An empty username does not count. `undefined` when one cannot be read, so
   * the page is not sent: a username that was not read cannot be hidden.
   */
  async function readUsernames(
    pageOrigin: string,
    reads: ReturnType<typeof usernameReads>,
  ): Promise<string[] | undefined> {
    const usernames: string[] = [];
    for (const { connection, itemId, fieldId } of reads) {
      let value: string | undefined;
      try {
        // Serial reads through the shared vault host, as for a fill.
        // eslint-disable-next-line no-await-in-loop
        value = await fields({
          account: { origin: pageOrigin, connectionId: connection.id, itemId },
          connection,
          fieldId,
        });
      } catch {
        value = undefined;
      }
      if (value === undefined) {
        usernames.fill("");
        return undefined;
      }
      if (value) usernames.push(value);
      value = "";
    }
    return usernames;
  }
  /**
   * The page with the account's usernames hidden (`withoutUsernames`), or why it is not
   * sent: `username-unread` when one could not be read, `username-shown` when one shows
   * where it cannot be hidden, including in a segment of `live`'s raw path that the
   * observation carries as `[id]` (ADR 0039). The usernames are dropped once it is built.
   */
  function hideUsernames(
    observation: LoginObservation,
    usernames: string[] | undefined,
    live: LiveDocument,
  ): { observation: LoginObservation } | { reason: string } {
    if (!usernames) return { reason: "username-unread" };
    const hidden = withoutUsernames(observation, usernames, rawPath(live));
    usernames.fill("");
    return hidden.ok ? { observation: hidden.observation } : { reason: hidden.reason };
  }
  /**
   * The custom-field slots with the shapes their fields share (ADR 0027): only for Text
   * fields and Linked fields that read the username or a Text field, never for Hidden
   * fields or the password, and within a bound on the values read per request.
   */
  async function customSlots(pageOrigin: string, scope: GenerationScope) {
    let budget = MAX_CUSTOM_SHAPE_READS;
    const slots: SemanticSlot[] = [];
    for (const offer of scope.offers) {
      const reads = offer.members.flatMap(({ connectionId, itemId, fieldId, source }) => {
        const connection = scope.items.find(
          (entry) => entry.connection.id === connectionId,
        )?.connection;
        return connection && source ? [{ connection, itemId, fieldId, source }] : [];
      });
      let shape: ValueShape | undefined;
      if (
        scope.complete &&
        offer.shapeable &&
        reads.length === offer.members.length &&
        reads.length <= budget
      ) {
        budget -= reads.length;
        // eslint-disable-next-line no-await-in-loop
        shape = await sharedShape(pageOrigin, scope, reads);
      }
      slots.push(shape ? { ...offer.slot, valueShape: shape } : offer.slot);
    }
    return slots;
  }
  /**
   * Whether a pause of the page's site started while the page was made ready to send for
   * generation (ADR 0062): it is then not sent, and the document is asked to announce
   * again, so it is refused as paused.
   */
  async function pausedMeanwhile(live: LiveDocument, page?: "entry" | "other"): Promise<boolean> {
    if ((await pauseOf(live)) === undefined) return false;
    skipGeneration(live, "paused", page);
    void browser.tabs
      .sendMessage(
        live.document.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: live.document.frameId, documentId: live.document.documentId },
      )
      .catch(() => undefined);
    return true;
  }
  /**
   * The login account's slots for the judge (owner 2026-10-23: the same information goes to
   * every model call unless there is a sound reason), built as a generation request's are
   * but from the login's own item only: the built-in fields it can fill, one slot per
   * custom field it allows by name, the username's shape and the Text fields' shapes (ADR
   * 0010, ADR 0027). Never a value, an item name or a binding. `offers` names each custom
   * slot's field. None while the item cannot be read or may not be used. On the `passkey`
   * route, which reads no vault value (ADR 0027), the slots carry no shapes (`route`).
   * `known` gives the username's shape from a read the caller already made.
   */
  async function judgeSlots(
    pageOrigin: string,
    login: Pick<LoginAccount, "connectionId" | "itemId">,
    route: LoginRoute | undefined,
    known?: { usernameShape: ValueShape | undefined },
  ): Promise<{ slots: SemanticSlot[]; offers: CustomFieldOffer[] }> {
    const none = { slots: [], offers: [] };
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return none;
    const policy = snapshot.snapshot.settings;
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === login.connectionId,
    );
    const item = connection?.items.find((entry) => entry.id === login.itemId);
    const eligibility =
      connection && item
        ? getItemEligibility(policy, snapshot.catalog, connection.id, item.id)
        : undefined;
    if (!connection || !item || !eligibility?.eligible) return none;
    const scope: GenerationScope = {
      slots: generationSlots
        .filter(({ fieldId }) =>
          offersGenerationField(
            policy,
            snapshot.catalog,
            { connectionId: connection.id, item },
            fieldId,
          ),
        )
        .map(({ slot }) => slot),
      offers: customFieldOffers([
        { connectionId: connection.id, item, allowedFieldIds: eligibility.fieldIds },
      ]),
      items: [{ connection, item }],
      settings: policy,
      catalog: snapshot.catalog,
      complete: true,
    };
    const plain = () => scope.offers.map((offer) => offer.slot);
    if (route === "passkey") return { slots: [...scope.slots, ...plain()], offers: scope.offers };
    let shape = known?.usernameShape;
    if (!known) {
      const usernames = await readUsernames(pageOrigin, usernameReads(scope)).catch(
        () => undefined,
      );
      shape = usernames && usernameShape(scope, usernames);
      usernames?.fill("");
    }
    const custom = await customSlots(pageOrigin, scope).catch(plain);
    return {
      slots: [
        ...scope.slots.map((slot) =>
          slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
        ),
        ...custom,
      ],
      offers: scope.offers,
    };
  }
  /** Logs once per document and reason why it was not sent for generation. */
  function skipGeneration(
    live: LiveDocument,
    reason: string,
    page?: "entry" | "other" | "repair",
    /** A code that tells more, such as why a vault could not tell (ADR 0019). */
    detail?: string,
  ): void {
    if (live.generationSkip === reason) return;
    live.generationSkip = reason;
    report(live.document, {
      type: "generation",
      tabId: live.document.tabId,
      origin: live.document.origin,
      outcome: "skipped",
      reason,
      ...(page ? { page } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  /** Whether a login of the recipe runs, or is watched, in any tab (ADR 0058 A). */
  function recipeInUse(recipeId: string): boolean {
    return [...persisted.values(), ...[...attempts.values()].map((run) => run.metadata)].some(
      (metadata) =>
        metadata.recipeId === recipeId && (!terminal(metadata) || metadata.watch !== undefined),
    );
  }
  /**
   * Sends the start page of a new login's recipe the chosen item cannot run for repair (ADR
   * 0058 A, amended by ADR 0041), at most once per recipe and missing route in 3 days on
   * this device. The
   * service's recipes are pulled first: a newer revision, as after another device's repair,
   * is tried before any model call, and the page announces again for it. A repair that adds
   * the route the item needs answers a recipe, and the page announces again and starts it;
   * anything else refuses the page with the plan's own reason.
   */
  async function repairUnfit(
    live: LiveDocument,
    recipe: LoginRecipe,
    refusal: { reason: string; detail?: string; route: LoginRoute },
  ): Promise<void> {
    const key = frameKey(live.document);
    if (generation?.pullRecipes) {
      await generation.pullRecipes().catch(() => undefined);
      if (documents.get(key) !== live) return;
      const latest = await Promise.resolve(
        recipes.recipe(live.document.origin, live.path, recipe.id),
      ).catch(() => undefined);
      if (documents.get(key) !== live) return;
      if (latest && latest.revision > recipe.revision) {
        report(live.document, {
          type: "unfit",
          tabId: live.document.tabId,
          origin: live.document.origin,
          recipeId: recipe.id,
          recipeRevision: recipe.revision,
          route: refusal.route,
          outcome: "newer",
          detail: refusal.detail ?? refusal.reason,
        });
        await browser.tabs
          .sendMessage(
            live.document.tabId,
            { version: 1, type: "login.reconnect" },
            { frameId: live.document.frameId, documentId: live.document.documentId },
          )
          .catch(() => undefined);
        return;
      }
    }
    // A passkey-only recipe's page (ADR 0053) is sent only as a sign-in form it shows by
    // now: without a sign-in or identifier input, as with the button alone or beside an
    // entry or a list, it gives the missing route nothing to send, so it is refused at
    // once, after one read, with no claim (owner, 2026-10-25).
    const formShows =
      recipe.passkeyOnly &&
      v.safeParse(
        entryCheckResultSchema,
        await send(live, { type: "login.entry.check", starts: [], timeoutMs: 0 }).catch(
          () => undefined,
        ),
      );
    if (documents.get(key) !== live) return;
    const claim: RecipeRepairClaim =
      formShows && !(formShows.success && formShows.output.signIn)
        ? { outcome: "not-due", reason: "no-form" }
        : await Promise.resolve()
            .then(() => generation!.claimRepair!(recipe.id, refusal.route))
            .catch((): RecipeRepairClaim => ({ outcome: "not-sent", reason: "error" }));
    report(live.document, {
      type: "unfit",
      tabId: live.document.tabId,
      origin: live.document.origin,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      route: refusal.route,
      outcome: claim.outcome,
      ...("reason" in claim && claim.reason ? { reason: claim.reason } : {}),
      detail: refusal.detail ?? refusal.reason,
    });
    let answer: GenerationOutcome | EntryGenerationOutcome | undefined;
    if (claim.outcome === "claimed") {
      answer = documents.get(key) === live ? await sendRepair(live, recipe) : undefined;
      // Only a request that reached the model keeps its claim. A recipe more than one
      // revision on was answered without a call, as the cache was behind: it is tried as it
      // is, and repaired in turn if it still lacks the route.
      if (
        !answer ||
        answer.outcome === "skipped" ||
        ("retry" in answer && answer.retry) ||
        (answer.outcome === "recipe" && answer.recipe.revision > recipe.revision + 1)
      )
        await claim.release().catch(() => undefined);
    }
    // A recipe answered has asked the page to announce again (`generateFor`).
    if (documents.get(key) !== live || answer?.outcome === "recipe") return;
    note(live.document, live.url, refusal.reason, refusal.detail);
    live.state = "denied";
    live.reason = refusal.reason;
    await publish(live);
  }
  /**
   * Sends this page's observation for generation. A returned recipe is in the recipe
   * cache by then; the document announces again and starts it once its first step is
   * ready (ADR 0018).
   */
  async function generateFor(
    live: LiveDocument,
    scope: GenerationScope,
    /** For a list of accounts (ADR 0028): the shown texts to hide as `[account]`. */
    list?: { names: string[] },
    /**
     * A chooser without an `other` branch whose path shows a form instead of its list: the
     * page is sent as that branch's first page (ADR 0028).
     */
    otherless?: LoginChooserRecipe,
    passkeyOnly = false,
    /**
     * For a stale recipe's page (ADR 0041): the revision it repairs, for a later
     * step's page the layout and the step that did not show, and what to call with the
     * answer once one came.
     */
    repair?: {
      recipeId: string;
      revision: number;
      later?: { layout: string; step: number };
      done(outcome: GenerationOutcome): void;
    },
  ): Promise<void> {
    if (!generation) return;
    // A chooser's `other` branch is named by its layout (ADR 0060); only the probe build's
    // choosers have none, and their pages are never offered.
    if (otherless && otherless.layout === undefined) return;
    const base = otherless && { recipeId: otherless.id, revision: otherless.revision };
    const otherBranch = otherless?.layout && recipeBranch(otherless.layout, "other");
    // The page kind a skipped page is logged with.
    const skipPage = otherless ? ("other" as const) : repair && ("repair" as const);
    const key = frameKey(live.document);
    let sent = false;
    try {
      let observation: LoginObservation | undefined;
      // A page that renders its form in steps or fades it in may offer itself before the
      // form is whole or opaque, so a page that cannot be described yet is read again
      // (Vpass, 2026-10-12; Microsoft Entra, 2026-10-17).
      for (let read = 1; ; read += 1) {
        const extracted = v.safeParse(
          extractResultSchema,
          // eslint-disable-next-line no-await-in-loop
          await send(
            live,
            list
              ? {
                  type: "login.extract",
                  page: "accounts",
                  ...(list.names.length ? { names: list.names } : {}),
                }
              : { type: "login.extract", page: passkeyOnly ? "passkey" : "login" },
          ),
        );
        if (documents.get(key) !== live) return;
        // The content script's refusal, such as `no-locator` or `extract-error`;
        // `extract-failed` for an answer that fails its check or never came.
        let unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "extract-failed";
        // Why a described page is not sent, for the log (ADR 0019).
        let detail: string | undefined =
          extracted.success && !extracted.output.ok && extracted.output.detail
            ? logCode(extracted.output.detail)
            : undefined;
        if (extracted.success && extracted.output.ok) {
          // An incomplete observation is not sent (ADR 0016). A list is sent as one, and
          // only a page announced as one is.
          const accepted = acceptedObservation(extracted.output, {
            origin: live.document.origin,
            path: live.path,
            list: list !== undefined,
          });
          if ("observation" in accepted) {
            observation = accepted.observation;
            break;
          }
          unsent = "incomplete-observation";
          detail = accepted.detail;
        }
        // A page offered as a list of accounts or a passkey button before its form rendered,
        // as x.com's sign-in while it loads (2026-10-23), may show a sign-in form instead by
        // now: it is sent as a sign-in page, only when it shows an input the document would
        // have offered as one (ADR 0016), never for a search or newsletter field alone.
        const shows =
          unsent === "no-candidates" && (list || passkeyOnly)
            ? v.safeParse(
                entryCheckResultSchema,
                // eslint-disable-next-line no-await-in-loop
                await send(live, { type: "login.entry.check", starts: [], timeoutMs: 0 }).catch(
                  () => undefined,
                ),
              )
            : undefined;
        if (documents.get(key) !== live) return;
        if (shows?.success && shows.output.signIn) {
          const signIn = v.safeParse(
            extractResultSchema,
            // eslint-disable-next-line no-await-in-loop
            await send(live, { type: "login.extract", page: "login" }),
          );
          if (documents.get(key) !== live) return;
          const accepted =
            signIn.success && signIn.output.ok
              ? acceptedObservation(signIn.output, {
                  origin: live.document.origin,
                  path: live.path,
                  list: false,
                })
              : undefined;
          if (accepted && "observation" in accepted) {
            observation = accepted.observation;
            list = undefined;
            passkeyOnly = false;
            break;
          }
        }
        if (unsent === "cancelled" || read >= EXTRACT_READS) {
          skipGeneration(live, unsent, skipPage, detail);
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, EXTRACT_RETRY_MS));
        if (documents.get(key) !== live) return;
      }
      const page = list
        ? ({ page: "accounts" } as const)
        : base
          ? ({ page: "other", recipeId: base.recipeId, baseRevision: base.revision } as const)
          : repair
            ? ({
                page: "repair",
                recipeId: repair.recipeId,
                baseRevision: repair.revision,
              } as const)
            : {};
      // The `other` branch's first page asks for the account. A form without such a field,
      // as the password form after the person's own click on a listed profile, belongs to
      // the account branch and is never stored as `other` (ADR 0028).
      if (otherless && !asksAccount(observation)) {
        skipGeneration(live, "no-account-field", "other");
        return;
      }
      const usernames = await readUsernames(live.document.origin, usernameReads(scope));
      const shape = usernames && usernameShape(scope, usernames);
      // A recipe's first page carries whether it shows the person signed in, read before
      // the usernames are dropped; a list, a chooser's branch and a later step's repair carry
      // none (ADR 0035).
      const signedIn =
        list || base || repair?.later || !usernames
          ? undefined
          : await signedInHint(live, usernames);
      // The account's own usernames never reach the service.
      const hidden = hideUsernames(observation, usernames, live);
      if (documents.get(key) !== live) return;
      if ("reason" in hidden) {
        skipGeneration(live, hidden.reason, skipPage);
        return;
      }
      // A passkey-only page fills nothing, and a list of accounts is sent without slots or
      // value shapes: no field of the vault helps tell whether it leads on to a sign-in, and
      // its branches' pages offer them (ADR 0028, owner 2026-10-23 11:48 UTC). So no custom
      // field is read for either.
      const slotless = passkeyOnly || list !== undefined;
      const custom = slotless ? [] : await customSlots(live.document.origin, scope);
      if (documents.get(key) !== live) return;
      if (await pausedMeanwhile(live, otherless ? "other" : undefined)) return;
      const spin = spinning(live.document.tabId);
      const asked = Date.now();
      const result = await generation
        .generate(
          {
            version: 1,
            observation: hidden.observation,
            ...(passkeyOnly ? { passkeyOnly: true } : {}),
            ...(signedIn === undefined ? {} : { signedIn }),
            slots: slotless
              ? []
              : [
                  ...scope.slots.map((slot) =>
                    slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
                  ),
                  ...custom,
                ],
            ...(base && otherBranch ? { base, branch: otherBranch } : {}),
            ...(repair
              ? {
                  repair: {
                    recipeId: repair.recipeId,
                    revision: repair.revision,
                    ...repair.later,
                  },
                }
              : {}),
          },
          spin.sent(() =>
            report(live.document, {
              type: "generation",
              tabId: live.document.tabId,
              origin: live.document.origin,
              outcome: "sent",
              ...page,
              ...(signedIn === undefined ? {} : { signedIn }),
            }),
          ),
        )
        .finally(spin.stop)
        .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error" }));
      // A page not sent waited for no service.
      if (result.outcome !== "skipped") spendBefore(live, Date.now() - asked, result.timing);
      sent = true;
      report(live.document, {
        type: "generation",
        tabId: live.document.tabId,
        origin: live.document.origin,
        ...outcomeFields(result),
        ...page,
        ...(signedIn === undefined ? {} : { signedIn }),
      });
      repair?.done(result);
      if (result.outcome !== "recipe") return;
      // Every tab's page still tracked on this origin and path that holds no login announces
      // again and starts the recipe: this document, and one refused for want of a recipe
      // while the request was in flight, such as a page that replaced this one or the same
      // page in another tab.
      const pages = [...documents.values()].filter((other) => {
        const running = tabAttempt(other.document.tabId);
        return (
          other.document.frameId === 0 &&
          other.document.origin === live.document.origin &&
          other.path === live.path &&
          attempts.get(other.document.tabId)?.live !== other &&
          !(running && !terminal(running))
        );
      });
      await Promise.all(
        pages.map(async (other) => {
          try {
            await browser.tabs.sendMessage(
              other.document.tabId,
              { version: 1, type: "login.reconnect" },
              { documentId: other.document.documentId, frameId: other.document.frameId },
            );
          } catch {
            // The page starts nothing until it announces again (ADR 0019). A tab that no
            // longer shows it has moved on, which is not worth more than a debug line.
            if (documents.get(frameKey(other.document)) !== other) return;
            const tab = await browser.tabs.get(other.document.tabId).catch(() => undefined);
            const url = tab?.url ? new URL(tab.url) : undefined;
            const shown =
              url?.origin === other.document.origin && observedPath(url.pathname) === other.path;
            note(other.document, other.url, "reconnect-failed", undefined, !shown);
          }
        }),
      );
    } catch (error) {
      // The document went away or did not answer (`unreachable`, with how), or reading the
      // vault threw; nothing was started. Only a page still tracked is worth the reason
      // (ADR 0019).
      if (!sent && documents.get(key) === live)
        if (error instanceof DocumentGone)
          skipGeneration(live, "unreachable", skipPage, error.reason);
        else skipGeneration(live, "exception", skipPage);
    }
  }
  /**
   * Sends a generated recipe's start page to be repaired once it showed a sign-in input for
   * the step wait without a ready first step and the miss counts as stale (ADR 0041,
   * proposed): only the tab's own page on the recipe's start path, with a vault item that
   * matches it as for a first page, once per document and recipe revision. The service adds
   * a layout for the page beside the recipe's others, and the page announces again and
   * starts it, as after a first page.
   */
  async function repairStale(
    live: LiveDocument,
    recipe: LoginRecipe,
    miss: StartMiss | undefined,
    /** The page lists accounts by email instead of asking for a sign-in (ADR 0041 section 6). */
    accounts?: true,
  ): Promise<void> {
    if (!repairs || !generation || live.document.frameId !== 0 || live.topUrl) return;
    if (!recipe.id.startsWith("gen-")) return;
    const key = frameKey(live.document);
    // Every layout's first steps on the path (ADR 0060): a page that shows one layout's
    // elements, only not usable yet, is no stale page.
    const layouts = await Promise.resolve(recipes.layouts?.(live.document.origin, live.path)).catch(
      () => undefined,
    );
    if (documents.get(key) !== live) return;
    const firstSteps = (layouts?.length ? layouts.map((entry) => entry.recipe) : [recipe])
      .flatMap((layout) => recipeStartSteps(layout))
      .filter((step) => step.path === live.path);
    if (!firstSteps.length) return;
    const log = repairLog(live, recipe);
    const verdict = classifyStartMiss(firstSteps, miss);
    if (verdict !== "stale") {
      log("skipped", verdict);
      return;
    }
    // A page that shows the account is signed in is no stale start page, though it may hold
    // an email input, as a profile form: the tab's next page after a submitted password
    // form, or one where a signed-in marker one of the recipe's layouts learned shows.
    if (afterSignIn.get(live.document.tabId) === live.document.documentId) {
      log("skipped", "after-sign-in");
      return;
    }
    if (await showsAnyMarker(live, recipe)) {
      if (documents.get(key) === live) log("skipped", "signed-in");
      return;
    }
    if (documents.get(key) !== live) return;
    await sendRepair(live, recipe, accounts ? { kind: "list" } : {});
  }
  /**
   * Sends the page where a generated recipe's later step did not show for repair (ADR 0041
   * section 4, proposed): a top-frame `password` login of the layout's own steps, with no
   * other variant or handler, whose `advance` reached the step's path, where the step's
   * elements never showed.
   */
  async function repairLaterStep(run: Execution, step: number): Promise<void> {
    const { live, recipe, metadata } = run;
    const before = recipe.steps[step - 1];
    if (
      !repairs ||
      !generation ||
      live.document.frameId !== 0 ||
      live.topUrl ||
      !recipe.id.startsWith("gen-") ||
      recipe.layout === undefined ||
      run.chooser ||
      metadata.route !== "password" ||
      (metadata.variant ?? 0) !== 0 ||
      metadata.handlers.length ||
      recipe.alternatives ||
      recipe.passkeyOnly ||
      !before ||
      !recipe.steps[step] ||
      loginStepEffect(before) !== "advance" ||
      documents.get(frameKey(live.document)) !== live
    )
      return;
    await sendRepair(live, recipe, { later: { layout: recipe.layout, step } });
  }
  /**
   * Sends a generated chooser's list for repair (ADR 0041 section 6, owner 2026-10-23 13:03
   * UTC) when the list of accounts shows but a button the chooser names does not: only the
   * tab's own page, once per document and chooser revision, as a start page's.
   */
  async function repairChooser(live: LiveDocument, chooser: LoginChooserRecipe): Promise<void> {
    if (!repairs || !generation || live.document.frameId !== 0 || live.topUrl) return;
    if (!chooser.id.startsWith("gen-") || documents.get(frameKey(live.document)) !== live) return;
    await sendRepair(live, chooser, { kind: "list", during: true });
  }
  /**
   * Sends a generated entry recipe's page for repair (ADR 0041 section 6) when its link no
   * longer shows on a page the site sent the visitor to before signing in (`namesReturnPath`,
   * which the press checked first): as a form or a list of accounts when the page shows one
   * now, otherwise as an entry page. A load answered outside 2xx is not sent.
   */
  async function repairEntry(
    live: LiveDocument,
    recipe: LoginEntryRecipe,
    inspected: { shows?: "sign-in" | "accounts" | undefined; status?: number | undefined },
  ): Promise<void> {
    if (!repairs || !generation || live.document.frameId !== 0 || live.topUrl) return;
    if (!recipe.id.startsWith("gen-") || documents.get(frameKey(live.document)) !== live) return;
    const { shows, status } = inspected;
    if (status !== undefined && (status < 200 || status > 299)) {
      repairLog(live, recipe)("skipped", "status");
      return;
    }
    await sendRepair(live, recipe, {
      kind: shows === "sign-in" ? "form" : shows === "accounts" ? "list" : "entry",
    });
  }
  /** Logs whether a page of the recipe was sent for repair (`recipe.repair`, ADR 0041). */
  function repairLog(live: LiveDocument, recipe: { id: string; revision: number }) {
    return (outcome: "due" | "skipped", reason?: string) =>
      report(live.document, {
        type: "repair",
        tabId: live.document.tabId,
        origin: live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        outcome,
        ...(reason ? { reason } : {}),
      });
  }
  /**
   * Sends a stale page of a generated recipe for repair (ADR 0041), once per
   * document, unless the service already answered a repair of the recipe today: the start
   * page, or with `later` the page where a layout's later step did not show. Resolves to the
   * service's answer, or `undefined` when nothing was sent.
   */
  async function sendRepair(
    live: LiveDocument,
    recipe: { id: string; revision: number },
    page: {
      later?: { layout: string; step: number };
      /**
       * What the page is now (ADR 0041 section 6): a form (the default), a list of accounts
       * by email (ADR 0028) or a page with neither, sent as a sign-in entry (ADR 0031).
       */
      kind?: "form" | "list" | "entry";
      /** Sent from a login that keeps running, as on a chooser's list: its status stays. */
      during?: boolean;
    } = {},
  ): Promise<GenerationOutcome | EntryGenerationOutcome | undefined> {
    if (!repairs) return undefined;
    const { later, kind = "form", during = false } = page;
    const key = frameKey(live.document);
    const log = repairLog(live, recipe);
    const claim = await repairs.due({
      recipeId: recipe.id,
      revision: recipe.revision,
      documentId: live.document.documentId,
    });
    if (documents.get(key) !== live) return undefined;
    if (claim !== "due") {
      log("skipped", claim);
      return undefined;
    }
    // An entry page offers no slots, so only the matching items are read for it, for the
    // usernames it hides.
    let missed: GenerationMiss = "vault-unavailable";
    const scope =
      kind === "entry"
        ? undefined
        : await generationSlotsFor(live, (reason) => {
            missed = reason;
          }).catch(() => undefined);
    const matched = kind === "entry" ? await vaultMatches(live).catch(() => undefined) : scope;
    if (documents.get(key) !== live) return undefined;
    if (!matched) {
      log("skipped", missed);
      return undefined;
    }
    // A start page whose form showed late may have started the recipe's login meanwhile: no
    // stale page.
    const running = tabAttempt(live.document.tabId);
    if (!later && !during && running?.recipeId === recipe.id && !terminal(running)) {
      log("skipped", "running");
      return undefined;
    }
    log("due");
    // A later step's page keeps the stopped login's status, and a running login its own.
    if (!later && !during) {
      live.state = "generating";
      delete live.reason;
      await publish(live);
    }
    let answer: GenerationOutcome | EntryGenerationOutcome | undefined;
    const repair = {
      recipeId: recipe.id,
      revision: recipe.revision,
      ...(later ? { later } : {}),
      // An answer without a new revision holds the recipe until the next UTC day: the
      // service spent this device's repair of the day on it, or refused for that limit. That
      // includes the current recipe answered back, as when the answer equals a layout the
      // page still misses. Another request in flight (`busy`), a page not sent, or one left
      // free to send again does not.
      done: (outcome: GenerationOutcome | EntryGenerationOutcome) => {
        const held =
          outcome.outcome === "unavailable"
            ? outcome.reason !== "busy"
            : outcome.outcome === "recipe"
              ? outcome.recipe.revision <= recipe.revision
              : outcome.outcome !== "skipped" && !("retry" in outcome && outcome.retry);
        if (held) void repairs.hold(recipe.id);
        answer = outcome;
      },
    };
    if (kind === "entry") await generateEntryFor(live, matched, repair);
    else
      await generateFor(
        live,
        scope!,
        kind === "list" ? { names: [] } : undefined,
        undefined,
        false,
        repair,
      );
    return answer;
  }
  /**
   * After a refusal because no vault item matches, a vault check may bring the item from
   * another device. Once a check applied a new snapshot in time, only the refused document
   * is asked to announce again, and only while it is still that refused document.
   */
  function retryAfterSync(live: LiveDocument, reason: string): void {
    // A document replaced while the refusal was published could never be reconnected.
    if (documents.get(frameKey(live.document)) !== live) return;
    let synced: Promise<boolean> | undefined;
    try {
      synced = options.vault?.checkAfterMiss?.();
    } catch {
      return;
    }
    void synced
      ?.then(async (applied) => {
        if (
          !applied ||
          documents.get(frameKey(live.document)) !== live ||
          live.state !== "denied" ||
          live.reason !== reason
        )
          return undefined;
        await browser.tabs.sendMessage(
          live.document.tabId,
          { version: 1, type: "login.reconnect" },
          { frameId: live.document.frameId, documentId: live.document.documentId },
        );
        return undefined;
      })
      .catch(() => undefined);
  }
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
    if (!repeat && !unrelated) void quietly(saveSession);
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
    const running = frameId === 0 ? tabAttempt(tabId) : undefined;
    if (running && !terminal(running)) return true;
    if (probeMode && documentOrigin === origin) return true;
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
      // A page that is not HTTP(S) never runs the content script.
      if (refusal === "admitted" || refusal === "not-web") return;
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
    /** A recipe generated as `confirm` or `unclear` starts here: its first step (ADR 0035). */
    confirm?: LoginReadiness;
    /** A frame asked to report a sign-in input or a secret answer (ADR 0035). */
    frame?: true;
  };
  type Announced = { path: string } | undefined;
  type Unoffered = { path: string; why: (typeof unofferedReasons)[number] } | undefined;
  /**
   * A `shown` report: a sign-in input shown without a ready first step, with what the first
   * steps missed (ADR 0041), or `amount` on a page Pateat does not fill (ADR 0035).
   */
  type Shown = {
    path: string;
    amount?: boolean | undefined;
    miss?: StartMiss | undefined;
    later?: ShownLater | undefined;
    accounts?: true | undefined;
  };
  async function ready(
    sender: Sender,
    token: string,
    start?: { path: string },
    signIn?: { path: string; identifier?: true | undefined; passkey?: true | undefined },
    shown?: Shown,
    list?: ListOffer,
    entryHello?: Announced,
    unoffered?: Unoffered,
    switchedInPlace?: true,
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
        // A site count's job already sent delays the page; the count stops before its next.
        await counting?.catch(() => undefined);
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
          switchedInPlace,
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
    signIn?: { path: string; identifier?: true | undefined; passkey?: true | undefined },
    shown?: Shown,
    list?: ListOffer,
    entryHello?: Announced,
    unoffered?: Unoffered,
    switchedInPlace?: true,
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
      switchedInPlace,
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
          switchedInPlace,
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
    signIn?: { path: string; identifier?: true | undefined; passkey?: true | undefined },
    shown?: Shown,
    list?: ListOffer,
    entryHello?: Announced,
    unoffered?: Unoffered,
    switchedInPlace?: true,
  ): Promise<Readiness> {
    await loaded;
    await sessionLoaded;
    const document = await identify(sender);
    if (!document || !sender.url) {
      if (sender.frameId === 0 && sender.tab?.id !== undefined) {
        // A page Pateat does not fill was left for a page it does not read, which is also
        // the tab's previous page for the next one it reads (ADR 0035).
        const visit = confirmVisits.get(sender.tab.id);
        if (visit && visit.document.documentId !== sender.documentId) leaveConfirm(visit);
        const top = documents.get(frameKey({ tabId: sender.tab.id, frameId: 0 }));
        if (top && top.document.documentId !== sender.documentId) top.leftUnread = true;
      }
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
      clearChoice(document.tabId);
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
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    // A tab runs one attempt. Another frame of the tab, such as an embedded widget or the
    // page around a framed login, never takes it over or disturbs it. Only a new page in
    // the tab (another top document) ends an attempt held by a frame of the old page.
    let owner = tabAttempt(document.tabId);
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
      owner = tabAttempt(document.tabId);
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
            await keep(ended);
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
    // document now watches for its first step again (ADR 0062), the login is watched and
    // its first step shows in the document (ADR 0027), or the login switched accounts and
    // the document, changed in place, announces itself as a new page (ADR 0078).
    const carried = attempts.get(document.tabId);
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
      note(document, url, "duplicate-document");
      return { ok: false, reason: "duplicate-document" };
    }
    if (oldLive && !sameDocument)
      await send(oldLive, { type: "login.cancel" }).catch(() => undefined);
    const path = observedPath(new URL(url).pathname);
    const previousUrl = previousPage(document, oldLive, sameDocument, path);
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
    if (oldLive && !sameDocument) dropReprompt(oldLive.document.tabId, oldLive.document.documentId);
    documents.set(key, live);
    // The tab's next page after a page Pateat does not fill (ADR 0035).
    const earlier = confirmVisits.get(document.tabId);
    if (
      earlier &&
      document.frameId === 0 &&
      (earlier.document.documentId !== document.documentId || earlier.path !== path)
    )
      leaveConfirm(earlier, live);
    // Automatic login of the page's site is paused (ADR 0062): its own site's or, for a
    // frame, also its tab's. The tab's page shows the pause on the badge.
    const pauseState = await pauseOf(live);
    const paused = pauseState !== undefined;
    if (document.frameId === 0) badge.paused?.(document.tabId, pauseState);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
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
      if (detail === undefined) delete live.refusal;
      else live.refusal = detail;
      await publish(live);
      return { ok: false, reason };
    };
    // A sign-in input shows on this path, but the page only watches: logged once per
    // document and path, so a login that silently does not start can be told apart.
    const notStarted = (detail: string, visit?: ConfirmVisit) => {
      if (shown?.path !== live.path || live.notStarted === detail) return;
      live.notStarted = detail;
      const refused = {
        type: "refused" as const,
        tabId: document.tabId,
        origin: document.origin,
        reason: "not-started",
        detail,
        ...(document.frameId === 0 ? {} : { frame: true as const }),
      };
      if (!visit) {
        const later = shown?.later;
        report(document, {
          ...refused,
          ...(detail === "first-step-missing" && recipe
            ? { recipeId: recipe.id, recipeRevision: recipe.revision }
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
      const amount = shown?.amount;
      visit.logged = confirmSigns(live).then((signs) => {
        report(document, {
          ...refused,
          recipeId: visit.recipe.id,
          recipeRevision: visit.recipe.revision,
          pageKind: visit.recipe.pageKind,
          ...(amount === undefined ? {} : { amount }),
          ...signs,
          url: live.url,
        });
        // Read as the `signedIn` hint false: the page was read and neither shows, E2 also
        // when it was not read.
        return signs.e1 === false && signs.e2 !== true;
      });
      void visit.logged.catch(() => undefined);
    };
    // The page after a sign-in entry press is checked before anything else runs on it, and
    // one that blocked the entry is neither sent for generation nor logged in to (ADR 0031).
    const refusedKey = documentKey(document);
    if (!entryRefused.has(refusedKey)) {
      await checkAfterPress(live);
      if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    }
    if (entryRefused.has(refusedKey)) return refuse("entry-blocked");
    // A report sent only for the log does not log the tab's hold again. A passkey page
    // (ADR 0053) is answered as the announcement it would be without its button: its list,
    // its entry, or, with neither, the log-only report of a page that offered nothing.
    const quiet = signIn?.passkey ? list || !entryHello : shown || list || unoffered;
    if (busy)
      return quiet && !start && (!signIn || signIn.passkey)
        ? { ok: false, reason: "tab-busy" }
        : refuse("tab-busy");
    if (!storageHealthy)
      return refuse(
        "storage-unavailable",
        undefined,
        !(await loginRelated(document.tabId, document.frameId, document.origin)),
      );
    const holder = tabAttempt(document.tabId);
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
      noteSignedIn(before, ended, moved.origin);
      countRelogin(before, ended, incognito === true);
      if (signedInNow(before, ended)) void endPickedPause(ended, run?.live);
      if (run) run.metadata = ended;
      reportAttempt(ended, run?.recipe);
      try {
        await keep(ended);
      } catch {
        return refuse("storage-unavailable");
      }
      if (ended.state === "authenticated" && run?.choice) await remember(run);
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
          passkeyMoveFits(holder, document.tabId, siteOrigin) ||
          passwordMoveFits(holder, document.tabId, siteOrigin) ||
          passkeyPages.get(document.tabId)?.attemptId === holder.id
        )
          ending = false;
      } else {
        const check = passkeyMoveFits(holder, document.tabId, siteOrigin)
          ? signedInByPasskey(holder, live)
          : signedInByPassword(holder, live);
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
        const latest = attempts.get(document.tabId)?.metadata ?? tabAttempt(document.tabId);
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
        passkeyPageFits(holder, document, siteOrigin) &&
        (passkeyPages.get(document.tabId)?.document.documentId !== document.documentId ||
          (await stillAsking(live)));
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
        holdForPasskey(document.tabId);
        reportMove(holder, "passkey-request", true);
        return { ok: false, reason: "stale-document" };
      }
      const run = attempts.get(document.tabId);
      const latest = run?.metadata ?? tabAttempt(document.tabId);
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
      const check = signedInByPasskey(holder, live);
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
      const latest = run?.metadata ?? tabAttempt(document.tabId);
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
    let recorded = recordFor(document.tabId, document.origin);
    const askKey = recordKey(document.tabId, document.origin);
    // A fill-only login is forgotten when it ends; one a stopped worker left ended is too.
    if (recorded?.fillOnly && terminal(recorded)) {
      try {
        await forget(askKey);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = undefined;
    }
    /**
     * Releases a tab's finished login of this origin once its first step shows again (ADR
     * 0021 D, ADR 0062): the page then logs in as on any visit. After the site rejected that
     * login, the tab and the origin's other tabs ask for an account instead, and the page
     * that showed the rejection is never filled again. Returns a refusal when it could not,
     * else undefined.
     */
    const releaseFinished = async (
      released: LoginAttemptMetadata,
    ): Promise<Readiness | undefined> => {
      const { tabId } = released.document;
      const releasedKey = recordKey(tabId, document.origin);
      const rejected = released.outcome === "credential-rejected";
      if (attempts.get(tabId)?.metadata.id === released.id) attempts.delete(tabId);
      const unpicked = picked.get(tabId)?.attemptId === released.id && picked.delete(tabId);
      // The page that showed the rejection is never filled with an account again: the site
      // just refused what was filled there.
      const rejectedPage = documentKey(released.document);
      const asked = !rejected || rejectedAsks.has(releasedKey);
      const unfilled = rejected && !askFills.has(rejectedPage);
      // The tab must keep asking after a restart, so its ask is stored first.
      if (!asked || unfilled) {
        rejectedAsks.add(releasedKey);
        if (unfilled) addAskFill(rejectedPage);
        try {
          await saveSession();
        } catch {
          if (!asked) rejectedAsks.delete(releasedKey);
          if (unfilled) askFills.delete(rejectedPage);
          return refuse("storage-unavailable");
        }
      } else if (unpicked) void quietly(saveSession);
      try {
        await forget(releasedKey);
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
     * as after a code or an approval expired (ADR 0027). Only the watched login's tab asks
     * and fills, as after a stopped login (owner, 2026-10-13). Only its own tab's page ends
     * it: until the watch ends, the site's other tabs that share its cookies wait (owner,
     * 2026-10-23). Returns a refusal when it could not, else undefined.
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
        await saveSession();
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
        await forget(watchedKey);
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
      // It ended when the watch ran out, which may be long before this page showed; the
      // time between counts for nothing (ADR 0019).
      const endedAt = Math.min(Date.now(), (recorded.watch?.since ?? 0) + WATCH_MS);
      const ended = transitionLoginAttempt(
        own?.metadata ?? recorded,
        { type: "WATCH_ENDED" },
        endedAt,
      );
      if (own) own.metadata = ended;
      reportAttempt(ended, own?.recipe, undefined, { endedAt });
      try {
        await keep(ended, false);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = ended;
    }
    // While a login is watched, its recipe's first step showing in a new page of the tab
    // means the person is back at the start, as when a code or an approval expired: the
    // login never signed in. It ends, and only this tab asks and fills without pressing
    // anything (ADR 0027). The page the watch began in never ends it.
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
    // A paused site's automatic login that has not ended stops on its next page before any
    // step, as when its pause started (ADR 0062); one a popup pick started goes on.
    if (
      paused &&
      recorded &&
      !terminal(recorded) &&
      recorded.watch === undefined &&
      picked.get(document.tabId)?.attemptId !== recorded.id
    ) {
      const run = attempts.get(document.tabId);
      const own = run?.metadata.id === recorded.id ? run : undefined;
      const ended = transitionLoginAttempt(own?.metadata ?? recoverLoginAttempt(recorded), {
        type: "POLICY_CHANGED",
      });
      if (own) attempts.delete(document.tabId);
      reportAttempt(ended, own?.recipe, { cause: "paused" });
      try {
        await forget(recordKey(document.tabId, recorded.account.origin));
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
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
      // A page generated as a verification while signed in is no logout either, even when
      // it announces a start from starts read before its recipe was generated again (ADR
      // 0035): the service keeps one recipe per path, so no sign-in recipe starts there.
      const confirm =
        rejectedHere || live.topUrl ? undefined : await confirmRecipeOn(document.origin, live.path);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if ((start?.path !== live.path || confirm) && !rejectedHere) {
        const starts = await startsFor(document.origin);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        // Not a recipe's first step on its path, so the login stays (ADR 0021 D).
        const visit = confirm && confirmPage(live, confirm);
        if (visit) notStarted("confirm-unsupported", visit);
        else notStarted("logged-in");
        return {
          ok: false,
          reason: "logged-in",
          starts,
          ...(visit ? { confirm: visit.first } : {}),
        };
      }
      // It shows again after a finished login, as after a logout. Only this tab's record
      // for this origin is released, and the page logs in again (ADR 0062).
      const refused = await releaseFinished(recorded);
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
        void quietly(saveSession);
      }
      try {
        await forget(askKey);
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
      // never submits again. Its form showing again on one of them asks for an account, in
      // this tab only, and fills without pressing anything (ADR 0021 D, owner's choice
      // 2026-10-12); until then the page watches for it.
      const confirm = live.topUrl ? undefined : await confirmRecipeOn(document.origin, live.path);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (start?.path !== live.path || confirm) {
        const starts = await startsFor(document.origin);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        const visit = confirm && confirmPage(live, confirm);
        if (visit) notStarted("confirm-unsupported", visit);
        else notStarted("stopped-login");
        return {
          ok: false,
          reason: "login-stopped",
          starts,
          ...(visit ? { confirm: visit.first } : {}),
        };
      }
      const released = recorded;
      if (attempts.get(document.tabId)?.metadata.id === released.id)
        attempts.delete(document.tabId);
      if (picked.get(document.tabId)?.attemptId === released.id) picked.delete(document.tabId);
      stoppedAsks.add(askKey);
      try {
        await saveSession();
      } catch {
        stoppedAsks.delete(askKey);
        return refuse("storage-unavailable");
      }
      try {
        await forget(askKey);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = undefined;
    }
    // The tab asks for an account after the site rejected its login or another tab's login
    // of the origin, which shares its session, or after its own login stopped (ADR 0021 D);
    // it may fill the page once then, pressing nothing (below).
    let ask = recorded ? undefined : askFor(document.tabId, document.origin);
    // A tab runs one attempt at a time; another one still running holds it.
    const running = tabAttempt(document.tabId);
    if (running && !terminal(running) && running.id !== recorded?.id) return refuse("tab-busy");
    // After an account switch, the tab's next document of that origin starts a new
    // attempt, which may use another recipe. It carries the switch, so it never clicks
    // another one.
    const switched = recorded?.state === "blocked" && recorded.outcome === "account-switched";
    const previous = switched ? undefined : recorded;
    // Look up the recipe first: a page without one never opens the policy catalog or vault.
    let recipe =
      probeMode && document.origin === origin
        ? previous
          ? probeRecipe(origin, `/${previous.recipeId.replace(/^demo-/, "")}`)
          : probeRecipe(origin, live.path)
        : await recipes.recipe(document.origin, live.path, previous?.recipeId, previous?.layout);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A new login on a recipe with several layouts (ADR 0060) takes the one whose start
    // page elements show most, then one of the page's language, then the newest; the
    // others follow in that order, and the first whose plan passes for the account runs.
    // A resumed login keeps its own layout.
    let layoutChoices: LayoutChoice[] = [];
    let layoutCount = 1;
    if (
      recipe &&
      !previous &&
      start?.path === live.path &&
      !(probeMode && document.origin === origin) &&
      recipes.layouts
    ) {
      const candidates = await recipes.layouts(document.origin, live.path).catch(() => []);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (candidates.length > 1) {
        layoutCount = candidates.length;
        const ranked = await rankedLayouts(
          live,
          candidates,
          layoutStartTargets,
          layoutFirstSteps,
          "login",
        );
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        layoutChoices = ranked.map(({ recipe: layout }) => ({ recipe: layout }));
        recipe = layoutChoices[0]?.recipe ?? recipe;
      }
    }
    // A chooser recipe (ADR 0028): a new login on its list runs the route of its account
    // entry until it decides what to click, and a resumed one the route of its click.
    let chooser: LoginChooserRecipe | undefined;
    if (!recipe && !(probeMode && document.origin === origin) && (!previous || previous.chooser)) {
      chooser = await Promise.resolve(
        recipes.chooser?.(document.origin, live.path, previous?.recipeId, previous?.layout),
      ).catch(() => undefined);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // A new login on a chooser with several layouts takes the one whose list buttons
      // show most, then one of the page's language, then the newest (ADR 0060). Which
      // account the list holds is decided only once the layout is, so the account's plan
      // does not choose here.
      if (chooser && !previous && start?.path === live.path && recipes.choosers) {
        const candidates = await recipes.choosers(document.origin, live.path).catch(() => []);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if (candidates.length > 1) {
          layoutCount = candidates.length;
          // The list's buttons are its first step: a layout whose buttons all show fits.
          const buttons = (candidate: LoginChooserRecipe) => listReadiness(candidate).targets;
          const ranked = await rankedLayouts(
            live,
            candidates,
            buttons,
            (candidate) => [buttons(candidate)],
            "accounts",
          );
          if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
          chooser = ranked[0]?.recipe ?? chooser;
        }
      }
      if (chooser) recipe = chooserRoute(chooser, previous?.chooser?.click ?? "entry");
    }
    // The chooser's path shows its `other` branch's form instead of the list, as after the
    // person pressed the button for another account there: a new login starts on that
    // branch and clicks nothing on the list (ADR 0028). While the list shows, it goes first.
    let shownOther = false;
    const shownRoute = chooser && chooserRoute(chooser, "other-shown");
    const shownStart = shownRoute && loginReadiness(shownRoute.steps[0]!);
    if (chooser && shownStart?.targets.length && !previous && start?.path === live.path) {
      const shows =
        (await showsNow(live, shownStart)) && !(await showsNow(live, listReadiness(chooser)));
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (shows) {
        recipe = shownRoute;
        shownOther = true;
      }
    }
    // A page that shows a later `fill` step of a recipe and none of the recipe's first
    // steps, as a password page shown again after a logout for an account the site
    // remembers, starts a new login at that step (ADR 0049, owner 2026-10-18). A first step
    // that shows goes first, another recipe's too; a chooser's branches never start there.
    let later: LaterStart | undefined;
    if (
      !previous &&
      !chooser &&
      start?.path === live.path &&
      !(probeMode && document.origin === origin) &&
      recipes.later
    ) {
      const candidates = await recipes.later(document.origin, live.path).catch(() => []);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (candidates.length) {
        // The start page's passkey button may stay beside a later step, as on a page that
        // shows it at each stage: only a `password` variant's first step goes first, and the
        // button is offered to the account as on the first page (ADR 0027).
        let firstShows = false;
        // Any layout the start page ranked best counts (ADR 0060), not only the first.
        const layoutsHere = [
          ...(recipe ? [recipe] : []),
          ...layoutChoices.slice(1).map((choice) => choice.recipe),
        ];
        /* eslint-disable no-await-in-loop */
        for (const variant of layoutsHere.flatMap((layout) => passwordVariants(layout))) {
          firstShows = await showsNow(live, loginReadiness(variant.steps[0]!));
          if (firstShows) break;
        }
        const showing: {
          recipe: LoginRecipe;
          variants: Map<number, number[]>;
          partial: Set<string>;
        }[] = [];
        if (!firstShows)
          for (const candidate of candidates) {
            // A page that shows one of the recipe's signed-in markers, those of any of its
            // layouts (ADR 0060), is signed in, as a single-page app asking for the password
            // again before a sensitive action: no login starts there.
            if (await showsAnyMarker(live, candidate)) continue;
            const variants = new Map<number, number[]>();
            // A step that shows whole goes before the same step with its password alone.
            const whole = new Set<string>();
            const partial = new Set<string>();
            for (const entry of laterStartSteps(candidate)) {
              const { variant, index, step, partial: part } = entry;
              const at = `${variant}:${index}`;
              if (step.path !== live.path || whole.has(at)) continue;
              if (await showsNow(live, laterReadiness(entry))) {
                if (part) partial.add(at);
                else whole.add(at);
                const indices = variants.get(variant) ?? [];
                if (!indices.includes(index)) variants.set(variant, [...indices, index]);
              }
            }
            if (variants.size) showing.push({ recipe: candidate, variants, partial });
          }
        /* eslint-enable no-await-in-loop */
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        const buttonShows = async (button: LoginRecipe | undefined) =>
          button?.passkey !== undefined &&
          button.passkey.path === live.path &&
          (await showsNow(live, loginReadiness(routeSteps(button, { route: "passkey" })[0]!)));
        // Two recipes whose later steps show start neither, as two first steps do (ADR 0013).
        // Layouts of one recipe are told apart as at its start page (ADR 0060): by how many
        // of their later steps show, the page's language and age, then the account's plan.
        const shownRecipes = new Set(showing.map((entry) => entry.recipe.id));
        if (shownRecipes.size === 1) {
          let ranked = showing;
          if (showing.length > 1) {
            // Each layout's language and creation time, from the recipe's layouts.
            const group = await Promise.resolve(
              recipes.layouts?.(document.origin, showing[0]!.recipe.steps[0]!.path),
            ).catch(() => undefined);
            const metaOf = (entry: LoginRecipe) =>
              group?.find((candidate) => candidate.recipe.layout === entry.layout);
            const laterCandidates = showing.map((entry) => {
              const meta = metaOf(entry.recipe);
              return {
                recipe: entry,
                ...(meta?.language ? { language: meta.language } : {}),
                createdAt: meta?.createdAt ?? 0,
              };
            });
            // Each shows later steps, whole or with their password alone, so only how many
            // show tells them apart.
            const laterShown = showing.map((entry) => ({
              starts: true,
              missing: 0,
              shown: [...entry.variants.values()].reduce((sum, steps) => sum + steps.length, 0),
            }));
            let order = rankLayouts(laterCandidates, laterShown);
            if (languageDecides(order))
              order = rankLayouts(
                laterCandidates,
                laterShown,
                await observedLanguage(live, "login"),
              );
            ranked = order.map(({ recipe: entry }) => entry);
          }
          layoutCount = Math.max(layoutCount, showing.length);
          const choices: LayoutChoice[] = await Promise.all(
            ranked.map(async (entry) => ({
              recipe: entry.recipe,
              later: {
                variants: entry.variants,
                partial: entry.partial,
                button: await buttonShows(entry.recipe),
              },
            })),
          );
          layoutChoices = choices.length > 1 ? choices : [];
          recipe = choices[0]!.recipe;
          later = choices[0]!.later;
        } else if (showing.length > 1) recipe = undefined;
        else if (!firstShows && !(await buttonShows(recipe)))
          // No step that may start a login shows, as when the one that announced the page
          // went, or it shows beside a signed-in marker: the document tries again, up to
          // its limit (START_TRIES).
          return { ok: false, reason: "stale-document" };
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      }
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
      const starts = await startsFor(document.origin);
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
        void pressEntry(live, entryRecipe).catch(() => refuseEntry(live, entryRecipe, "exception"));
        return { ok: false, reason: "entry", starts };
      }
      // A recipe generated as `confirm` or `unclear` starts on this path: a verification
      // while signed in, which Pateat does not fill yet. The page is neither logged in to
      // nor sent for generation again, and the page only watches (ADR 0035).
      const confirm =
        recipe || document.frameId !== 0 || live.topUrl
          ? undefined
          : await confirmRecipeOn(document.origin, live.path);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (confirm) {
        const visit = confirmPage(live, confirm);
        notStarted("confirm-unsupported", visit);
        live.state = "watching";
        delete live.reason;
        await publish(live);
        return { ok: false, reason: "recipe-not-found", starts, confirm: visit.first };
      }
      // The chooser's path shows a sign-in form instead of its list, and the chooser has no
      // `other` branch yet, as after the person pressed its button for another account: the
      // page is sent as that branch's first page, as after Pateat's own click, and once
      // stored the form starts as `other-shown` (ADR 0028, owner 2026-10-17).
      const otherless =
        chooser?.chooser.other && !chooser.chooser.afterOther && !previous ? chooser : undefined;
      const otherOffer = otherless && (await offersOther(live, otherless));
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // A passkey page carries the list and entry it would be announced with otherwise
      // (ADR 0053); only a plain sign-in page counts as such below.
      const plain = signIn?.passkey ? undefined : signIn;
      const otherShown = otherless && plain?.path === live.path ? otherless : undefined;
      // Logged only for a shown form: the list may still show on this path.
      if (
        otherShown &&
        (otherOffer === "sending" || otherOffer === "sent" || otherOffer === "not-connected")
      )
        skipGeneration(live, otherOffer, "other");
      if (otherShown && otherOffer === true) {
        // Nor is the page right after a sign-in, nor one of a paused site (ADR 0062).
        if (paused) skipGeneration(live, "paused", "other");
        else if (afterSignIn.get(document.tabId) === document.documentId)
          skipGeneration(live, "after-sign-in", "other");
        // Nor a page whose list shows meanwhile: the login clicks there (ADR 0028).
        else if (await showsNow(live, listReadiness(otherShown))) {
          if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
          skipGeneration(live, "list-shown", "other");
        } else {
          let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
          const scope = await generationSlotsFor(live, (...reason) => {
            missed = reason;
          }).catch(() => undefined);
          if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
          if (scope) {
            live.state = "generating";
            delete live.reason;
            await publish(live);
            void generateFor(live, scope, undefined, otherShown);
            return { ok: false, reason: "generating" };
          }
          skipGeneration(live, missed[0], "other", missed[1]);
        }
      }
      const availability = recipe ? undefined : await offersGeneration(live);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      let offer = availability === true;
      // A paused site sends no page for generation (ADR 0062).
      if (offer && paused) {
        skipGeneration(live, "paused");
        offer = false;
      }
      // Only a page that was sent is held, so the log says why it is not sent again.
      if (availability === "sending" || availability === "sent") skipGeneration(live, availability);
      // Without the service no page is sent; logged at debug level, as every page is.
      if (availability === "not-connected") skipGeneration(live, availability);
      const shownList = !plain && list?.path === live.path ? list : undefined;
      const listing = shownList && (shownList.names || !shownList.missed) ? shownList : undefined;
      // A page whose URL names another path of its site may be sent as a sign-in entry
      // once no sign-in input showed (ADR 0031); a list of accounts goes first.
      const entryPage =
        offer &&
        (namesReturnPath(new URL(live.url), sameSiteAs(live.url)) || (await switchingTab(live)))
          ? true
          : undefined;
      const entryOffer = !plain && entryHello?.path === live.path;
      // A page with a passkey button is sent as a passkey-only page when a matching item
      // holds a discoverable passkey; otherwise the list or entry it also shows is handled
      // below as on a page without the button, logged as such (ADR 0053, owner 2026-10-19
      // 22:44 UTC). With a list or an entry to use instead, every matching item must hold
      // one: the recipe is shared, and an item without a passkey could not run it.
      if (offer && signIn?.passkey && signIn.path === live.path) {
        const fallback = listing !== undefined || entryOffer;
        // Nor is the page right after a sign-in sent as a passkey-only page.
        if (afterSignIn.get(document.tabId) === document.documentId) {
          if (!fallback) {
            skipGeneration(live, "after-sign-in");
            offer = false;
          }
        } else {
          let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
          const scope = await generationSlotsFor(
            live,
            (...reason) => {
              missed = reason;
            },
            fallback ? "every" : "some",
          ).catch(() => undefined);
          if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
          if (scope) {
            live.state = "generating";
            delete live.reason;
            await publish(live);
            void generateFor(live, scope, undefined, undefined, true);
            return { ok: false, reason: "generating" };
          }
          if (!fallback) {
            skipGeneration(live, missed[0], undefined, missed[1]);
            offer = false;
          }
        }
      }
      // A shown email address that is no list entry is logged only (ADR 0028).
      if (offer && shownList?.missed)
        skipGeneration(live, "not-a-list", undefined, shownList.missed);
      // A list announced only for the log is never sent, but may hold the site's entry.
      if (shownList && !listing && !entryOffer) offer = false;
      // The page right after a sign-in is never sent as a list of accounts (ADR 0028) or as
      // a sign-in entry.
      if (offer && listing && afterSignIn.get(document.tabId) === document.documentId) {
        // Logged for a list with an email, one with a control for another account, or an
        // offered entry only: short texts alone are ordinary browsing.
        if (!listing.names || listing.other || entryOffer) skipGeneration(live, "after-sign-in");
        offer = false;
      }
      // Nor while another tab's login of the origin authenticated within the hour, as on a
      // signed-in dashboard listing the site's accounts by email opened in a new tab, unless
      // the tab asks for an account (ADR 0028, owner 2026-10-17).
      if (offer && listing && !ask && signedInElsewhere(document.tabId, document.origin)) {
        if (!listing.names || listing.other || entryOffer)
          skipGeneration(live, "signed-in-elsewhere");
        offer = false;
      }
      // Nor as a page that asks for an identifier alone (ADR 0016), such as a profile page
      // with an email field.
      if (offer && signIn?.identifier && afterSignIn.get(document.tabId) === document.documentId) {
        skipGeneration(live, "after-sign-in");
        offer = false;
      }
      if (offer && (plain?.path === live.path || listing)) {
        let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
        const scope = await generationSlotsFor(live, (...reason) => {
          missed = reason;
        }).catch(() => undefined);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        // Without an email listed, a shown text must name a matching item's username. A
        // list on a page whose path holds one is not sent: the page would be refused as
        // `username-shown` once read (owner 2026-10-12 19:45 UTC).
        const listed =
          scope && listing
            ? await listedNames(live.document.origin, scope, listing.names ?? [], rawPath(live))
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
          void generateFor(live, scope, listing ? { names: otherOnly ?? names ?? [] } : undefined);
          return { ok: false, reason: "generating" };
        }
        // No vault item matches this page, the vault could not tell, or no shown text names
        // an item's username, so it is not sent. A page offered only by its short texts is
        // mostly ordinary browsing, so that is logged at debug level (ADR 0019): most pages
        // show a short text beside a button. Such a page may still hold the site's sign-in
        // entry.
        if (listed?.inPath)
          skipGeneration(live, "no-listed-account", undefined, "username-in-path");
        else if (unmatched)
          skipGeneration(live, "no-listed-account", undefined, "no-email-username");
        else if (!listing?.names) skipGeneration(live, missed[0], undefined, missed[1]);
        else
          skipGeneration(
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
        const offered = entryPage ? await entryOfferRefusal(live) : { refusal: "no-return-target" };
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if ("matched" in offered) {
          live.state = "generating";
          delete live.reason;
          await publish(live);
          void generateEntryFor(live, offered.matched);
          return { ok: false, reason: "generating" };
        }
        skipGeneration(live, offered.refusal, "entry");
        offer = false;
      }
      // A page offered for generation that showed nothing to send by the end of the step
      // wait is logged with why; mostly ordinary browsing, so at debug level (ADR 0019).
      // The tab's next document after a submitted password form is known only here. A page
      // that looks like a verification but is never sent, a secret answer of `type="text"` or
      // a frame, is counted by reason at info level when a vault item matches it, as it
      // would for a page that is sent (ADR 0035).
      // A secret answer on the tab's next document after a password submit is part of that
      // sign-in, so it is not counted.
      const framed = availability === "frame";
      const afterSubmit = afterSignIn.get(document.tabId) === document.documentId;
      const unsendable =
        unoffered?.path === live.path &&
        ((offer && unoffered.why === "text-answer" && !afterSubmit) ||
          (framed && unoffered.why === "frame"))
          ? unoffered.why
          : undefined;
      let counted = false;
      if (unsendable) {
        counted = (await generationSlotsFor(live).catch(() => undefined)) !== undefined;
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if (counted) skipGeneration(live, unsendable);
      }
      if (
        !counted &&
        offer &&
        unoffered?.path === live.path &&
        !signIn &&
        !shownList &&
        !entryOffer
      )
        skipGeneration(
          live,
          "nothing-offered",
          undefined,
          (unoffered.why === "no-list" || unoffered.why === "text-answer") && afterSubmit
            ? "after-sign-in"
            : unoffered.why,
        );
      // No recipe of the origin and no login in the tab: ordinary browsing (ADR 0019).
      if (!recipe && !starts.length && !offer) {
        const refused = await refuse("recipe-not-found", undefined, true);
        return framed ? { ...refused, frame: true as const } : refused;
      }
      // Only an origin with a recipe: elsewhere every sign-in page would be logged.
      if (starts.length) notStarted(recipe ? "first-step-missing" : "no-recipe-on-path");
      // A generated recipe's own start page that misses its first steps may be stale
      // (ADR 0041).
      if (
        recipe &&
        !chooser &&
        !later &&
        !(probeMode && live.document.origin === origin) &&
        shown?.path === live.path
      )
        void repairStale(live, recipe, shown.miss, shown.accounts).catch(() => undefined);
      live.state = "watching";
      delete live.reason;
      await publish(live);
      return {
        ok: false,
        reason: recipe ? "form-not-ready" : "recipe-not-found",
        starts,
        ...(offer || (otherOffer === true && !paused) ? { generate: true as const } : {}),
        ...(offer && entryPage ? { entry: true as const } : {}),
        ...(framed ? { frame: true as const } : {}),
      };
    }
    // A resumed attempt keeps its own recipe revision; a replaced or different recipe never
    // takes it over. A newer revision that only adds handlers or markers is taken over
    // when this worker still holds the recorded one to compare (ADR 0027); after a restart
    // only the recorded revision resumes.
    let revised = false;
    let replaced = false;
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
      else {
        recipe = undefined;
        replaced = true;
      }
    }
    if (
      !recipe ||
      recipe.origin !== document.origin ||
      (previous && previous.recipeId !== recipe.id)
    ) {
      // A resumed login its recipe no longer runs ends here: a revision replaced its own, or
      // after a restart is one this worker cannot compare, or the recipe or its layout was
      // withdrawn. Left running, every later page of the tab would resume it and be refused,
      // the recipe's first step included, until the tab closed. It moves to this page and
      // stops as under other settings, so it never submits again; the rules for a stopped
      // login apply from the tab's next page on (ADR 0021 D, ADR 0022). A lookup that could
      // not read the recipes leaves it to resume (owner, 2026-10-23).
      const ends =
        previous &&
        !(probeMode && document.origin === origin) &&
        (replaced ||
          // A chooser login's chooser no longer has the route of its click: a revision
          // dropped it, as the one the login ran had it.
          (previous.chooser !== undefined && chooser !== undefined && !recipe) ||
          (!recipe &&
            (await recipes
              .withdrawn?.(document.origin, previous.recipeId, previous.layout)
              .catch(() => false))));
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      const latest = ends ? recordFor(document.tabId, document.origin) : undefined;
      if (latest && latest.id === previous?.id && !terminal(latest)) {
        const run = attempts.get(document.tabId);
        const own = run?.metadata.id === latest.id ? run : undefined;
        let ended = transitionLoginAttempt(own?.metadata ?? recoverLoginAttempt(latest), {
          type: "NAVIGATED",
          document,
        });
        if (!terminal(ended)) ended = transitionLoginAttempt(ended, { type: "POLICY_CHANGED" });
        if (own) own.metadata = ended;
        continuations.delete(ended.id);
        reportAttempt(ended, own?.recipe, { cause: "recipe-changed" });
        try {
          await keep(ended);
        } catch {
          return refuse("storage-unavailable");
        }
        // A conditional request of the page waits for how this login ends (ADR 0034).
        reviewRequests();
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      }
      return refuse("recipe-not-found");
    }
    const savedBefore = remembered;
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
          : new URL(tab.url).origin !== document.origin ||
            observedPath(new URL(tab.url).pathname) !== live.path)
      )
        return refuse("stale-document");
    } catch {
      return refuse("closed-tab");
    }
    // Two automatic logins of the site that ended `authenticated` within 10 minutes, in
    // any tab of this normal or incognito session, keep a third from starting: the tab asks
    // instead, so a site that logs out again at once is not logged in over and over. A pick
    // in the popup still logs in, and is not counted (ADR 0062).
    if (!ask && !previous && !switched && reloginLimited(document.origin, incognito === true))
      ask = "relogin-limit";
    // A pick that did not make its account the default makes the site ask every time until
    // the browser closes or a default is saved for it (ADR 0063).
    const everyTime =
      !previous &&
      !switched &&
      (await asksEveryTime(document.origin, incognito === true, snapshot));
    if (!ask && everyTime) ask = "one-time-pick";
    if (ask && heldElsewhere(document.tabId, document.origin)) {
      showHeld(document.tabId);
      return refuse("origin-busy");
    }
    const asking = ask === "relogin-limit" ? ask : ask ? "account-asked" : undefined;
    // A new login reads its item's facts once and chooses its route from them (ADR 0027);
    // a resumed one keeps those in its record, so a sync cannot change its route.
    // While the tab asks after a rejection, a stopped login or an abandoned watch, a
    // document is filled once on each path with the single account to use, without
    // pressing anything (ADR 0021 D); the passkey route has nothing to fill, and the relogin
    // limit fills nothing (ADR 0062). A single-page app that shows its next step in place,
    // as a password page after its email page, gets that step filled as a new document
    // would (ADR 0049). A page the site rejected a login on is never filled again, on any
    // path. A site that asks every time after a one-time pick fills nothing, also while
    // the tab asks for another reason (ADR 0063).
    const filledKey = `${documentKey(document)} ${live.path}`;
    const fill =
      asking === "account-asked" &&
      !everyTime &&
      !previous &&
      !switched &&
      !askFills.has(documentKey(document)) &&
      !askFills.has(filledKey);
    // A new login answers the page's own passkey request when its item holds a passkey
    // (ADR 0034), as one picked in the popup and one on a chooser's list do, instead of
    // clicking there; a login that only fills keeps its form.
    const pageRequest = !previous && document.frameId === 0 && parkedFor(document) !== undefined;
    // A paused site starts no login by itself; a resumed one goes on (ADR 0062).
    const pausedStart = paused && !previous;
    const planOf = async (
      route: LoginRecipe,
      from: typeof later,
    ): Promise<Awaited<ReturnType<typeof planFor>> | undefined> => {
      let planned = await planFor(snapshot, live, route, {
        ...(asking ? { asking } : {}),
        ...(fill ? { fill } : {}),
        ...(pausedStart ? { paused: true } : {}),
        ...(previous ? { route: attemptRouteChoice(previous) } : {}),
        ...(pageRequest ? { pageRequest } : {}),
        ...(from && !from.button ? { later: true } : {}),
      });
      if (documents.get(key) !== live) return undefined;
      if (planned.ok && "fillOnly" in planned && planned.route.route !== "password") {
        planned = await planFor(snapshot, live, route, {
          ...(asking ? { asking } : {}),
          ...(pausedStart ? { paused: true } : {}),
          ...(from && !from.button ? { later: true } : {}),
        });
        if (documents.get(key) !== live) return undefined;
      }
      return planned;
    };
    let plan = await planOf(recipe, later);
    if (!plan) return { ok: false, reason: "stale-document" };
    // Another layout of the recipe, next in order, runs when the account's plan passes on
    // it and not on the first (ADR 0060); when none passes, the first one's refusal stands.
    /* eslint-disable no-await-in-loop */
    for (const choice of layoutChoices.slice(1)) {
      if (plan.ok) break;
      const next = await planOf(choice.recipe, choice.later);
      if (!next) return { ok: false, reason: "stale-document" };
      if (next.ok) {
        plan = next;
        recipe = choice.recipe;
        later = choice.later;
      }
    }
    /* eslint-enable no-await-in-loop */
    // A passkey-only item on a list whose account branch cannot take the stop (ADR 0036,
    // owner 2026-10-13 06:32 UTC: the account's row, else "another account") still reads
    // the list first, planned on the click alone: it goes on only through `other`, and is
    // refused with the account branch's reason, pressing nothing, when its row fits.
    let deferred: { route: LoginRecipe; detail?: string } | undefined;
    if (!plan.ok && plan.reason === "no-route" && !previous && chooser && !shownOther) {
      const { afterAccount: _afterAccount, ...lists } = chooser.chooser;
      const bare = chooserRoute({ ...chooser, chooser: lists }, "entry");
      const alone =
        bare &&
        (await planFor(snapshot, live, bare, {
          ...(asking ? { asking } : {}),
          ...(fill ? { fill } : {}),
          ...(pageRequest ? { pageRequest } : {}),
          ...(pausedStart ? { paused: true } : {}),
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
    // A generated recipe the chosen item cannot run, where it holds what a route the recipe
    // lacks needs, has its start page sent for repair in this visit (ADR 0058 A, amended by
    // ADR 0041): only for a new login of the tab's own page that starts at the recipe's first
    // step, neither while the tab asks nor after an account switch, nor on a chooser's
    // list, and while no login of the recipe runs or is watched in any tab. Until the answer
    // the page waits as for a generation; a page the repair did not answer with a recipe is
    // refused as it would have been.
    const unfit =
      !plan.ok && "unfit" in plan && (plan.unfit === "passkey" || plan.unfit === "password")
        ? plan.unfit
        : undefined;
    if (
      !plan.ok &&
      unfit &&
      !previous &&
      !switched &&
      !ask &&
      !chooser &&
      !shownOther &&
      !deferred &&
      !later &&
      !pausedStart &&
      document.frameId === 0 &&
      !live.topUrl &&
      !(probeMode && document.origin === origin) &&
      isGeneratedRecipeId(recipe.id) &&
      generation?.claimRepair &&
      repairs &&
      !recipeInUse(recipe.id)
    ) {
      // A pause that started meanwhile admits the document again (ADR 0062).
      if ((await pauseOf(live)) !== undefined) return { ok: false, reason: CHOICE_SAVED };
      live.state = "generating";
      delete live.reason;
      await publish(live);
      void repairUnfit(live, recipe, {
        reason: plan.reason,
        ...("detail" in plan && typeof plan.detail === "string" ? { detail: plan.detail } : {}),
        route: unfit,
      }).catch(() => undefined);
      return { ok: false, reason: "generating" };
    }
    if (!plan.ok) {
      // An account the page's value picked for a login that did not start is dropped, so
      // a default saved or a logout later decides this document again.
      const site = picked.get(document.tabId);
      if (site?.site && site.attemptId === undefined && site.documentId === document.documentId) {
        picked.delete(document.tabId);
        void quietly(saveSession);
      }
      // Only a fresh start can be restarted with a picked account (ADR 0021). The page
      // after an account switch belongs to that login, so it offers none.
      if (!previous && !switched && "candidates" in plan && plan.candidates) {
        const asked = "ask" in plan && plan.ask === true ? ask : undefined;
        const pausedChoice = "paused" in plan && plan.paused === true;
        offerChoice(document, plan.candidates, asked, pausedChoice);
        // Outside an ask, the page's own conditional request may wait for the pick, on a
        // recipe without a passkey button (ADR 0034); a paused site hands it on (ADR 0062).
        noteChoice(
          document,
          plan.candidates,
          !asked && !pausedChoice && document.frameId === 0 && passkeyAnswersRequest(recipe),
        );
      }
      const refused = await refuse(
        plan.reason,
        "detail" in plan && typeof plan.detail === "string"
          ? plan.detail
          : plan.reason === "account-asked"
            ? // Why the tab asks: its own rejection or stopped login, or another tab's
              // rejection (ADR 0021 D).
              ask
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
        retryAfterSync(live, plan.reason);
      return refused;
    }
    if (heldElsewhere(document.tabId, document.origin)) {
      showHeld(document.tabId);
      return refuse("origin-busy");
    }
    // A new login on a chooser's list decides what it clicks there for its account (ADR
    // 0028), and takes the route that click leads to. A fill-only login presses nothing.
    let click: ChooserClick | "none" | undefined = shownOther ? "other-shown" : undefined;
    let listMiss: ListMiss | undefined;
    if (!previous && chooser && !shownOther && !("fillOnly" in plan)) {
      const chosen = await listClick(snapshot, live, chooser, plan.account);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // Without the account's username nothing on the list can be compared with it.
      if (chosen === "unreadable") return refuse("field-unavailable", "list-username");
      // The page no longer shows the list, or could not be asked: it announces again.
      if (!chosen) return { ok: false, reason: "stale-document" };
      if (typeof chosen === "string") click = chosen;
      else {
        click = "none";
        listMiss = chosen;
        // A button the chooser names that the list no longer shows, as on a list redesigned
        // or in another language, sends the list for repair while this login goes on
        // (ADR 0041 section 6).
        if (chosen.other === "missing" || chosen.continue === "missing")
          void repairChooser(live, chooser).catch(() => undefined);
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
          const replanned = await planFor(snapshot, live, route, {
            ...(asking ? { asking } : {}),
            ...(pageRequest ? { pageRequest } : {}),
            ...(pausedStart ? { paused: true } : {}),
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
    // The vault account whose master password this new login was started with, if any.
    let typedFor: string | undefined;
    if (!previous) {
      // The lookup answered from the cache while the sync it started may be revoking the
      // recipe, as one removed on the dashboard minutes ago: that sync ends first, and a
      // recipe or layout it removed never starts.
      if (
        !(probeMode && document.origin === origin) &&
        (await recipes.withdrawn?.(document.origin, recipe.id, recipe.layout).catch(() => false))
      ) {
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        return refuse("recipe-not-found", "withdrawn");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // Another login's account choice, being saved now or saved since this snapshot was read,
      // bumps the revision this new login would be checked against: it is admitted again.
      await choicesSaved();
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (savingChoices.size || remembered !== savedBefore)
        return { ok: false, reason: CHOICE_SAVED };
      if (heldElsewhere(document.tabId, document.origin)) {
        showHeld(document.tabId);
        return refuse("origin-busy");
      }
      // An item with Bitwarden's re-prompt starts a login on a site that honours it only
      // after its master password was typed for this document; until then the page is
      // neither filled nor pressed, and the chooser window asks (owner, 2026-10-23 12:46 UTC).
      // Its username may already have been read to match the page's accounts, as Bitwarden
      // shows usernames without asking.
      // The started login goes on across its pages, and answers the site's passkey request
      // with that item (ADR 0027), without asking again.
      const connection = snapshot.catalog.connections.find(
        (entry) => entry.id === plan.account.connectionId,
      );
      const item = connection?.items.find((entry) => entry.id === plan.account.itemId);
      if (connection && itemAsksForMasterPassword(snapshot.snapshot.settings, item, live.url)) {
        const grantKey = `${document.tabId} ${document.documentId}`;
        const grant = repromptGrants.get(grantKey);
        if (
          grant?.connectionId === plan.account.connectionId &&
          grant.itemId === plan.account.itemId &&
          Date.now() - grant.at <= REPROMPT_GRANT_MS
        ) {
          repromptGrants.delete(grantKey);
          typedFor = grant.connectionId;
          if (document.frameId === 0) repromptWaiting.delete(document.tabId);
        } else {
          const awaiting = {
            document,
            account: {
              origin: document.origin,
              connectionId: plan.account.connectionId,
              itemId: plan.account.itemId,
            },
            ...(picked.get(document.tabId)?.documentId === document.documentId
              ? { pick: { ...picked.get(document.tabId)! } }
              : {}),
          };
          if (document.frameId === 0) repromptWaiting.set(document.tabId, awaiting);
          void askMasterPassword(awaiting, connection, item!);
          return refuse("master-password-reprompt");
        }
      }
    }
    // A pause that started while this announcement was handled stops what it would start
    // or go on with by itself: the document is admitted again and refused as paused. A
    // login a popup pick started goes on (ADR 0062).
    const picking = previous
      ? picked.get(document.tabId)?.attemptId === previous.id
      : "chosen" in plan && (plan.chosen?.source === "pick" || plan.chosen?.source === "switch");
    if (!paused && !picking && (await pauseOf(live)) !== undefined) {
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      return { ok: false, reason: CHOICE_SAVED };
    }
    if (!previous && persisted.size >= 100) return refuse("attempt-limit");
    // Another document of the tab, such as a frame, may have started an attempt while this
    // one was checked, and the tab runs one attempt at a time. Nothing below awaits until
    // the attempt is registered.
    const latest = tabAttempt(document.tabId);
    if (
      recordFor(document.tabId, document.origin)?.id !== recorded?.id ||
      (latest && !terminal(latest) && latest.id !== recorded?.id)
    )
      return refuse("tab-busy");
    // A passkey Pateat returned to the tab's page, outside a login of it, signed that page
    // in: the site moves on by itself, so no login runs there by itself, as one would fill
    // and submit the password over the passkey's sign-in, also from a later step such as a
    // password page shown alone. Read here, after the admission's last wait, so an answer
    // returned while it waited counts too. A pick in the popup or an account switch still
    // logs in, and the page announces again when the answer's window ends, so a step the
    // site shows after the passkey, such as a one-time code, is filled then.
    if (!previous && !picking) {
      const answer = passkeyAnswers.get(`${document.tabId} ${siteOrigin}`);
      const top =
        document.frameId === 0
          ? document.documentId
          : documents.get(frameKey({ tabId: document.tabId, frameId: 0 }))?.document.documentId;
      if (
        answer?.signedIn !== undefined &&
        answer.signedIn === top &&
        Date.now() - answer.at < PASSKEY_SIGN_IN_MS
      ) {
        const refused = await refuse(PASSKEY_SIGNED_IN);
        retryAfterPasskey(live, answer.at);
        return refused;
      }
    }
    let metadata: LoginAttemptMetadata;
    let resumedPolicy: PolicyChange | undefined;
    if (previous) {
      let resumed = recoverLoginAttempt(previous);
      // The page left the document a TOTP code was filled into before its click,
      // as a code input that submits on its last digit does: the page submitted the code
      // itself, and it is never filled again (ADR 0027).
      // So did a software keyboard's page once a key was pressed (ADR 0067).
      if (
        previous.document.documentId !== document.documentId &&
        codeAwaitsClick(recipe, resumed, keypadPresses.get(resumed.id))
      )
        resumed = transitionLoginAttempt(resumed, autoSubmitted(recipe, resumed));
      metadata = transitionLoginAttempt(resumed, {
        type: "NAVIGATED",
        document,
      });
      // A new page ends a wait for the person's click, as their press led to it, and the
      // login waits for the site until it read that page (ADR 0019).
      if (!metadata.watch) metadata = followPage(personAnswered(metadata));
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
      // An account whose route is the passkey button that shows beside the later step
      // presses it, as on the first page (ADR 0027).
      if (later?.button && plan.route.route === "passkey") later = undefined;
      // A login that starts at a later step takes the first one that shows in the variant
      // its account fits, or a passkey answer that falls back to that variant (ADR 0049); an
      // item without a password goes no further than the step before its password.
      const startVariant =
        plan.route.route === "password"
          ? plan.route.variant
          : "fallback" in plan && typeof plan.fallback === "number"
            ? plan.fallback
            : undefined;
      const startAt =
        later && startVariant !== undefined ? later.variants.get(startVariant)?.[0] : undefined;
      if (later && startAt === undefined) return refuse("no-route", "later-variant");
      if (later && "stopAt" in plan && typeof plan.stopAt === "number" && plan.stopAt <= startAt!)
        return refuse("no-route", "password-empty:later-start");
      const timing = startTiming(live, plan.account);
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
          ...(startAt === undefined ? {} : { startAt }),
          ...(startAt !== undefined && later?.partial.has(`${startVariant}:${startAt}`)
            ? { startPartial: true }
            : {}),
          timing,
        }),
        { type: "RESOLVE" },
      );
      begunIn.delete(metadata.id);
      begunIn.set(metadata.id, document.documentId);
      for (const old of begunIn.keys()) {
        if (begunIn.size <= 256) break;
        begunIn.delete(old);
      }
      if (typedFor !== undefined) holdPassword(metadata.id, typedFor);
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
      ...(ask && "asked" in plan ? { asked: { candidates: plan.asked, ask } } : {}),
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
    if (
      before?.siblingsInPlace &&
      before.metadata.id === metadata.id &&
      before.siblingsInPlace.operationId === metadata.operationId
    )
      run.siblingsInPlace = before.siblingsInPlace;
    attempts.set(document.tabId, run);
    reviewRequests();
    if (!previous)
      report(document, {
        type: "start",
        tabId: document.tabId,
        origin: document.origin,
        recipeId: metadata.recipeId,
        recipeRevision: metadata.recipeRevision,
        ...(metadata.layout === undefined ? {} : { layout: metadata.layout }),
        ...(layoutCount > 1 ? { layouts: layoutCount } : {}),
        route: metadata.route,
        ...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
        ...("chosen" in plan && plan.chosen
          ? {
              account: plan.chosen.source,
              ...(plan.chosen.candidates === undefined
                ? {}
                : { candidates: plan.chosen.candidates }),
              ...(plan.chosen.source === "match" || plan.chosen.source === "site-value"
                ? { itemId: metadata.account.itemId }
                : {}),
            }
          : {}),
        ...(metadata.fillOnly ? { fillOnly: true as const } : {}),
        ...(metadata.startStep === undefined ? {} : { startStep: metadata.startStep }),
        ...(metadata.startPartial ? { startPartial: true as const } : {}),
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
    // The choice, pick and ask markers form one session update. Snapshot only once they
    // all name the started login, rather than relying on a deferred save callback.
    let sessionChanged = false;
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
      sessionChanged = true;
    }
    // The login an account switch's pick started ends that pick and the switch (ADR 0063).
    if (!previous && "chosen" in plan && plan.chosen?.source === "switch") {
      switchStates.delete(document.tabId);
      void accountPicks.endSwitch(document.tabId);
    }
    // A login started while the tab asks, as by a pick, ends the tab's asking for this
    // origin, and that of the origin's other tabs it began; filling the page only does not,
    // and the document is not filled again on this path.
    if (metadata.fillOnly) {
      addAskFill(filledKey);
      sessionChanged = true;
    } else if (!previous) {
      const rejected = rejectedAsks.delete(askKey);
      if (stoppedAsks.delete(askKey) || rejected) sessionChanged = true;
    }
    // clearChoice saves the completed update before notifying a badge that may reenter.
    if (!pending.has(document.tabId) && sessionChanged) void quietly(saveSession);
    clearChoice(document.tabId);
    // A hold's tooltip no longer applies once the tab logs in.
    badge.note(document.tabId, undefined);
    await save(run);
    await publish(live, metadata);
    void drive(run);
    // A page of a watched login watches for the recipe's first step, which ends the
    // login (ADR 0027).
    if (metadata.watch && document.documentId !== metadata.watch.documentId) {
      const starts = await startsFor(document.origin);
      if (documents.get(key) === live) return { ok: true, starts };
    }
    return { ok: true };
  }
  /** Whether the tab holds an attempt record for an origin of `site`, ended or not. */
  function siteRecorded(tabId: number, site: string): boolean {
    const run = attempts.get(tabId);
    return (
      (run !== undefined && siteOf(run.metadata.account.origin) === site) ||
      persisted
        .values()
        .some((entry) => entry.document.tabId === tabId && siteOf(entry.account.origin) === site)
    );
  }
  /** Whether another tab's login of an origin of `site`, or its switch, holds it (ADR 0022). */
  function siteHeldElsewhere(tabId: number, site: string): boolean {
    const now = Date.now();
    return (
      switchingElsewhere(tabId, site) ||
      persisted
        .values()
        .some(
          (entry) =>
            entry.document.tabId !== tabId &&
            siteOf(entry.account.origin) === site &&
            sharesCookies(entry.document.tabId, tabId) &&
            holdsOthers(entry, now),
        )
    );
  }
  /** The blocks stored on this device; a read that fails is not kept, so it is read again. */
  let entryBlocks: Promise<EntryBlock[] | undefined> | undefined;
  function readEntryBlocks(): Promise<EntryBlock[] | undefined> {
    const read: Promise<EntryBlock[] | undefined> = entryBlockRecords.read().then(
      (stored) => {
        const parsed = v.safeParse(v.array(entryBlockSchema), stored ?? []);
        return parsed.success ? parsed.output : [];
      },
      () => {
        if (entryBlocks === read) entryBlocks = undefined;
        return undefined;
      },
    );
    entryBlocks ??= read;
    return entryBlocks;
  }
  /**
   * Blocks an entry recipe revision on this device, and whether the block was stored. A
   * read of the stored blocks that failed writes nothing, so other recipes' blocks are
   * never lost; that block, like one whose write failed, holds in this worker only.
   */
  async function blockEntry(press: EntryPress, reason: EntryBlockReason): Promise<boolean> {
    const block: EntryBlock = {
      recipeId: press.recipeId,
      revision: press.revision,
      reason,
      blockedAt: isoTime(Date.now()),
    };
    const stored = await readEntryBlocks();
    if (!stored) {
      unsavedBlocks.push(block);
      return false;
    }
    const next = [
      // A block of an older revision of the same recipe no longer applies.
      ...stored.filter((entry) => entry.recipeId !== press.recipeId),
      block,
    ].slice(-MAX_ENTRY_BLOCKS);
    entryBlocks = Promise.resolve(next);
    try {
      await entryBlockRecords.write(next);
      return true;
    } catch {
      unsavedBlocks.push(block);
      return false;
    }
  }
  /** Logs one sign-in entry decision (ADR 0031). */
  function reportEntry(
    tabId: number,
    recipe: { origin: string; id?: string; recipeId?: string; revision: number },
    outcome: "pressed" | "refused" | "blocked",
    reason?: string,
    extra: { detail?: string; repeat?: true } = {},
  ): void {
    report(
      { frameId: 0 },
      {
        type: "entry",
        tabId,
        origin: recipe.origin,
        recipeId: recipe.id ?? recipe.recipeId ?? "",
        recipeRevision: recipe.revision,
        outcome,
        ...(reason ? { reason } : {}),
        ...extra,
      },
    );
  }
  /**
   * Ends the check of the page after an entry press: it passed, or the recipe revision is
   * blocked on this device and a warning logged (ADR 0031). Each press is settled once.
   * `refused` is the page that blocked it, which is then refused for as long as this
   * worker runs; a page that only came too late is not.
   */
  async function settleEntry(
    press: EntryPress,
    verdict: EntryBlockReason | "passed",
    refused?: LoginDocument,
  ): Promise<void> {
    clearTimeout(entryTimers.get(press.tabId));
    entryTimers.delete(press.tabId);
    const latest = entryPresses.get(press.tabId);
    if (latest?.pressedAt !== press.pressedAt || latest.checked) return;
    entryPresses.set(press.tabId, { ...latest, checked: true });
    // Recorded before anything is awaited, so no announcement of the page slips past it.
    if (verdict !== "passed" && refused) {
      entryRefused.add(documentKey(refused));
      for (const old of entryRefused) {
        if (entryRefused.size <= 256) break;
        entryRefused.delete(old);
      }
    }
    await quietly(saveSession);
    if (verdict === "passed") return;
    const stored = await blockEntry(press, verdict).catch(() => false);
    reportEntry(
      press.tabId,
      press,
      "blocked",
      verdict,
      stored ? {} : { detail: "storage-unavailable" },
    );
  }
  /** Whether the check of a page after the tab's entry press is running. */
  const entryChecked = (tabId: number) =>
    entryChecks.keys().some((key) => key.startsWith(`${tabId} `));
  /**
   * Checks an entry press whose next page did not announce in time (ADR 0031). A tab now on
   * another site's web page blocks it as `left-site`; one still on the pressed URL, or with
   * no page announced once more the step wait after a same-site move, as `no-sign-in`.
   * While a page's check runs, that check settles the press, or arms this again.
   */
  async function lateEntry(press: EntryPress, extended: boolean): Promise<void> {
    entryTimers.delete(press.tabId);
    const latest = entryPresses.get(press.tabId);
    if (latest?.pressedAt !== press.pressedAt || latest.checked || entryChecked(press.tabId))
      return;
    let url: string | undefined;
    try {
      url = (await browser.tabs.get(press.tabId)).url;
    } catch {
      // The tab closed; its press goes with it.
      return;
    }
    // A tab with no URL yet, or one that does not parse, shows nothing to judge.
    const parsed = url ? (URL.parse(url) ?? undefined) : undefined;
    const web = parsed !== undefined && /^https?:$/u.test(parsed.protocol);
    if (web && siteOf(parsed!) !== siteOf(press.origin)) return settleEntry(press, "left-site");
    // A page of the site that has not announced yet, as one still loading, and a tab
    // without a URL to read get their own wait.
    if (!extended && (parsed === undefined || (web && url !== press.url))) {
      entryTimers.set(
        press.tabId,
        setTimeout(() => void lateEntry(press, true).catch(() => undefined), LOGIN_STEP_WAIT_MS),
      );
      return;
    }
    return settleEntry(press, "no-sign-in");
  }
  function armEntryTimer(press: EntryPress): void {
    clearTimeout(entryTimers.get(press.tabId));
    const due = isoTimeMs(press.pressedAt) + ENTRY_NEXT_PAGE_MS - Date.now();
    entryTimers.set(
      press.tabId,
      setTimeout(() => void lateEntry(press, false).catch(() => undefined), Math.max(0, due)),
    );
  }
  /**
   * When `live` is the page after the tab's unchecked entry press (a new top document, or
   * the pressed document at another URL), checks it (ADR 0031): it must be on the entry
   * page's site (else `left-site`) and, within the step wait, show a sign-in input, an
   * input that asks for an account identifier alone (ADR 0016) or a ready first step of a
   * cached recipe (else `no-sign-in`), and no sign-up form (else
   * `sign-up`). A page that blocks the press is refused (`entryRefused`). A page announced
   * later than the press's wait plus the step wait settles the press as `no-sign-in` but
   * is not refused itself, on any site. A page that could not be asked leaves the press to a later
   * page of the tab or to its timer, armed again, so every press is settled.
   */
  async function checkAfterPress(live: LiveDocument): Promise<void> {
    const { tabId, documentId, frameId, origin: pageOrigin } = live.document;
    const press = entryPresses.get(tabId);
    if (frameId !== 0 || live.topUrl !== undefined || !press || press.checked) return;
    if (documentId === press.documentId && live.url === press.url) return;
    const key = documentKey(live.document);
    const running = entryChecks.get(key);
    if (running) return running;
    const check = (async (): Promise<void> => {
      // A page after the window settles the press but is never refused, on any site.
      if (Date.now() - isoTimeMs(press.pressedAt) > ENTRY_NEXT_PAGE_MS + LOGIN_STEP_WAIT_MS)
        return settleEntry(press, "no-sign-in");
      if (siteOf(pageOrigin) !== siteOf(press.origin))
        return settleEntry(press, "left-site", live.document);
      const starts = await startsFor(pageOrigin);
      let answer: unknown;
      try {
        answer = await send(live, {
          type: "login.entry.check",
          starts,
          timeoutMs: LOGIN_STEP_WAIT_MS,
        });
      } catch {
        return;
      }
      const parsed = v.safeParse(entryCheckResultSchema, answer);
      if (!parsed.success) return;
      if (parsed.output.signUp) return settleEntry(press, "sign-up", live.document);
      return parsed.output.signIn || parsed.output.start
        ? settleEntry(press, "passed")
        : settleEntry(press, "no-sign-in", live.document);
    })();
    entryChecks.set(key, check);
    try {
      await check;
    } finally {
      if (entryChecks.get(key) === check) entryChecks.delete(key);
      // A check that settled nothing, or that ran while the timer came due, leaves the
      // press to the timer again.
      const latest = entryPresses.get(tabId);
      if (
        latest?.pressedAt === press.pressedAt &&
        !latest.checked &&
        !entryTimers.has(tabId) &&
        !entryChecked(tabId)
      )
        armEntryTimer(latest);
    }
  }
  /**
   * The hosts among those the page's URL and links name that are on its site, by
   * registrable domain; the content script counts every other host as another site's.
   */
  async function hostsOnSite(live: LiveDocument): Promise<string[] | undefined> {
    const parsed = v.safeParse(
      entryHostsResultSchema,
      await send(live, { type: "login.entry.hosts" }).catch(() => undefined),
    );
    if (!parsed.success) return undefined;
    const onSite = sameSiteAs(live.url);
    return parsed.output.hosts.filter((host) => {
      const url = URL.parse(`https://${host}`);
      return url !== null && onSite(url);
    });
  }
  /**
   * The vault items whose URI matches the page, which needs an unlocked vault, with the
   * settings they were matched under; no field is read. `undefined` without a vault, or
   * when the settings could not be read.
   */
  async function vaultMatches(live: LiveDocument): Promise<VaultMatch | undefined> {
    if (!uris) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return undefined;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url: live.url,
      match: uris,
    });
    return {
      items: scope.ok ? catalogItems(snapshot.catalog, scope.candidates) : [],
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
    };
  }
  /**
   * Why the page may not be sent as a site's sign-in entry beyond ADR 0016's conditions
   * (ADR 0031), cheapest first: its URL no longer names another path of its site; it is the
   * next page after a manual sign-in; the tab holds an attempt record for its site; or no
   * vault item matches. Otherwise the matching items, whose usernames are hidden from the
   * page sent.
   */
  async function entryOfferRefusal(
    live: LiveDocument,
  ): Promise<{ refusal: string } | { matched: VaultMatch }> {
    const site = siteOf(live.document.origin);
    if (site === undefined) return { refusal: "no-return-target" };
    // An account switch's tab goes to the site's login page on purpose (ADR 0063).
    const switching = await switchingTab(live);
    if (!switching && !namesReturnPath(new URL(live.url), sameSiteAs(live.url)))
      return { refusal: "no-return-target" };
    // The page right after a sign-in (ADR 0028); the document skips its own next path.
    if (afterSignIn.get(live.document.tabId) === live.document.documentId)
      return { refusal: "after-sign-in" };
    if (!switching && siteRecorded(live.document.tabId, site)) return { refusal: "site-record" };
    const matched = await vaultMatches(live).catch(() => undefined);
    return matched?.items.length ? { matched } : { refusal: "no-vault-match" };
  }
  /** Whether the document's tab has an account switch's pick for its site (ADR 0063). */
  async function switchingTab(live: LiveDocument): Promise<boolean> {
    const pick = await accountPicks
      .switchFor(live.document.tabId, siteOf(live.document.origin), live.incognito === true)
      .catch(() => undefined);
    return pick !== undefined;
  }
  /**
   * Whether the site of `pageOrigin` asks every time (ADR 0063): an account was picked there
   * in this browser session without making it the default, and its saved defaults are still
   * those of then. A settings read that fails counts as not asking.
   */
  async function asksEveryTime(
    pageOrigin: string,
    incognito: boolean,
    snapshot?: Extract<SettingsResponse, { ok: true }>,
    siteDefaults?: LocalSettings["siteDefaults"],
  ): Promise<boolean> {
    const site = siteOf(pageOrigin);
    if (site === undefined) return false;
    let defaults = siteDefaults;
    if (!defaults) {
      const read =
        snapshot ??
        (await settings.handle({ version: 1, type: "settings.get" }).catch(() => undefined));
      if (!read?.ok) return false;
      defaults = read.snapshot.settings.siteDefaults;
    }
    return accountPicks
      .asksEveryTime(site, incognito, siteDefaultsMark(defaults, site, siteOf))
      .catch(() => false);
  }
  /**
   * Sends the page as a site's sign-in entry (ADR 0031): its buttons and links, with the
   * usernames of the items that matched it hidden as on every page sent, and without slots
   * (owner 2026-10-23 11:48 UTC). A returned entry recipe is in the recipe cache by then;
   * the document announces again and its entry is pressed.
   */
  async function generateEntryFor(
    live: LiveDocument,
    matched: VaultMatch,
    /** For an entry recipe whose link no longer shows (ADR 0041): as for `generateFor`. */
    repair?: { recipeId: string; revision: number; done(outcome: EntryGenerationOutcome): void },
  ): Promise<void> {
    if (!generation) return;
    const key = frameKey(live.document);
    let sent = false;
    try {
      const onSite = await hostsOnSite(live);
      if (documents.get(key) !== live) return;
      if (!onSite) {
        skipGeneration(live, "extract-failed", "entry");
        return;
      }
      const extracted = v.safeParse(
        extractResultSchema,
        await send(live, { type: "login.extract", page: "entry", onSite }),
      );
      if (documents.get(key) !== live) return;
      if (!extracted.success || !extracted.output.ok) {
        skipGeneration(
          live,
          extracted.success && !extracted.output.ok ? extracted.output.reason : "extract-failed",
          "entry",
        );
        return;
      }
      const accepted = acceptedObservation(extracted.output, {
        origin: live.document.origin,
        path: live.path,
      });
      // `not-entry` for a description with fields or accounts, which is no entry page.
      if ("detail" in accepted || !isEntryObservation(accepted.observation)) {
        const detail = "detail" in accepted ? accepted.detail : "not-entry";
        skipGeneration(live, "incomplete-observation", "entry", detail);
        return;
      }
      // Only a link is ever pressed, so a page without one is not worth a model call.
      const linked = (shown: LoginObservation) =>
        shown.candidates.some((candidate) => candidate.role === "link");
      if (!linked(accepted.observation)) {
        skipGeneration(live, "no-entry-link", "entry");
        return;
      }
      // The matching items' usernames never reach the service, as on every page sent: a
      // signed-out page may still greet a remembered account (owner 2026-10-23 11:48 UTC).
      const usernames = await readUsernames(live.document.origin, usernameReads(matched));
      const hidden = hideUsernames(accepted.observation, usernames, live);
      if (documents.get(key) !== live) return;
      if ("reason" in hidden) {
        skipGeneration(live, hidden.reason, "entry");
        return;
      }
      const { observation } = hidden;
      // A link whose locator holds a username is left out of the page.
      if (!linked(observation)) {
        skipGeneration(live, "no-entry-link", "entry");
        return;
      }
      if (await pausedMeanwhile(live, "entry")) return;
      const spin = spinning(live.document.tabId);
      const asked = Date.now();
      const result = await generation
        .generateEntry(
          {
            version: 1,
            observation,
            ...(repair ? { repair: { recipeId: repair.recipeId, revision: repair.revision } } : {}),
          },
          spin.sent(() =>
            report(live.document, {
              type: "generation",
              tabId: live.document.tabId,
              origin: live.document.origin,
              outcome: "sent",
              page: "entry",
            }),
          ),
        )
        .finally(spin.stop)
        .catch((): EntryGenerationOutcome => ({ outcome: "failed", reason: "error" }));
      if (result.outcome !== "skipped") spendBefore(live, Date.now() - asked, result.timing);
      sent = true;
      report(live.document, {
        type: "generation",
        tabId: live.document.tabId,
        origin: live.document.origin,
        ...outcomeFields(result),
        page: "entry",
      });
      repair?.done(result);
      if (result.outcome !== "recipe" || documents.get(key) !== live) return;
      await browser.tabs.sendMessage(
        live.document.tabId,
        { version: 1, type: "login.reconnect" },
        { documentId: live.document.documentId, frameId: live.document.frameId },
      );
    } catch (error) {
      if (!sent && documents.get(key) === live)
        if (error instanceof DocumentGone)
          skipGeneration(live, "unreachable", "entry", error.reason);
        else skipGeneration(live, "exception", "entry");
    }
  }
  /**
   * Logs why the document's sign-in entry was not pressed; a reason the document already
   * logged is marked as a repeat, which the log keeps at debug (ADR 0019).
   */
  function refuseEntry(live: LiveDocument, recipe: LoginEntryRecipe, reason: string): void {
    const repeat = live.entryRefusals?.includes(reason) === true;
    if (!repeat) live.entryRefusals = [...(live.entryRefusals ?? []), reason];
    reportEntry(live.document.tabId, recipe, "refused", reason, repeat ? { repeat } : {});
  }
  /**
   * Why the entry may not be pressed now, from what the worker knows (ADR 0031), cheapest
   * first; checked again after the page was inspected.
   */
  async function entryPressRefusal(
    live: LiveDocument,
    recipe: LoginEntryRecipe,
    url: string,
  ): Promise<string | undefined> {
    const { tabId, frameId, origin: pageOrigin } = live.document;
    if (frameId !== 0 || live.topUrl !== undefined) return "frame";
    const blocks = await readEntryBlocks();
    if (!blocks) return "storage-unavailable";
    if (
      [...blocks, ...unsavedBlocks].some(
        (entry) => entry.recipeId === recipe.id && entry.revision === recipe.revision,
      )
    )
      return "blocked";
    if (observedPath(new URL(url).pathname) !== recipe.entry.path) return "page-changed";
    const cached = (await recipes.entries(pageOrigin).catch(() => [])).find(
      (entry) => entry.id === recipe.id,
    );
    if (
      !cached ||
      cached.revision !== recipe.revision ||
      JSON.stringify(cached.entry) !== JSON.stringify(recipe.entry)
    )
      return "recipe-changed";
    // An account switch's tab goes to the site's login page on purpose (ADR 0063).
    const switching = await switchingTab(live);
    // A manual logout that lands on the bare top page is never undone.
    if (!switching && !namesReturnPath(new URL(url), sameSiteAs(url))) return "no-return-target";
    const site = siteOf(pageOrigin);
    if (site === undefined) return "no-site";
    if (!switching && siteRecorded(tabId, site)) return "site-record";
    if (siteHeldElsewhere(tabId, site)) return "site-held";
    // Pateat presses nothing by itself on a paused site (ADR 0062).
    if ((await pauseOf({ ...live, url })) !== undefined) return "paused";
    const last = entryPresses.get(tabId);
    if (last && Date.now() - isoTimeMs(last.pressedAt) < ENTRY_PRESS_MS) return "press-limit";
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return "settings-unavailable";
    const matched = await vaultMatches({ ...live, url }).catch(() => undefined);
    if (!matched?.items.length) return "no-vault-match";
    return undefined;
  }
  /**
   * Presses the page's sign-in entry (ADR 0031) after every check before the press: the
   * worker's, then the link's on the page (one shown `<a href>` link with rendered text,
   * opening in the same tab without downloading, whose `href` is `https:` on the site,
   * leads to another page than this one, has no query key or value leading to another
   * site and is on a site that is not excluded), then the worker's again. The press is
   * stored before the click; it starts no login and holds nothing. Only a press the page
   * answers it clicked is taken as one and has its next page checked.
   */
  async function pressEntry(live: LiveDocument, recipe: LoginEntryRecipe): Promise<void> {
    const { tabId, documentId } = live.document;
    const running = pressing.get(tabId);
    // The same document announcing again leaves its press to the check already running.
    if (running === documentId) return;
    if (running !== undefined) return refuseEntry(live, recipe, "in-progress");
    pressing.set(tabId, documentId);
    const key = frameKey(live.document);
    // The same document announcing again keeps the press going.
    const shown = () => documents.get(key)?.document.documentId === live.document.documentId;
    try {
      const pageUrl = async () => {
        const tab = await browser.tabs.get(tabId);
        return tab.url && new URL(tab.url).origin === live.document.origin ? tab.url : undefined;
      };
      let before: string | undefined;
      try {
        before = await pageUrl();
      } catch {
        if (shown()) refuseEntry(live, recipe, "tab-unavailable");
        return;
      }
      if (!shown()) return;
      // The tab moved to another origin since the document announced.
      if (!before) return refuseEntry(live, recipe, "page-changed");
      const early = await entryPressRefusal(live, recipe, before);
      if (early) return refuseEntry(live, recipe, early);
      const inspected = v.safeParse(
        entryInspectResultSchema,
        await send(live, {
          type: "login.entry.inspect",
          target: recipe.entry.target,
          timeoutMs: LOGIN_STEP_WAIT_MS,
        }).catch(() => undefined),
      );
      if (!shown()) return;
      if (!inspected.success) return refuseEntry(live, recipe, "no-answer");
      const { state, refusal, href, url } = inspected.output;
      if (state === "missing")
        void repairEntry(live, recipe, inspected.output).catch(() => undefined);
      if (state !== "unique") return refuseEntry(live, recipe, `target-${state}`);
      if (refusal) return refuseEntry(live, recipe, refusal);
      if (!href) return refuseEntry(live, recipe, "not-link");
      const destination = URL.parse(href);
      if (!destination) return refuseEntry(live, recipe, "link-off-site");
      const linkCheck = linkRefusal(destination, sameSiteAs(url), new URL(url));
      if (linkCheck) return refuseEntry(live, recipe, linkCheck);
      // The page's own URL, as the content script reads it, must still name the path too.
      if (new URL(url).origin !== live.document.origin)
        return refuseEntry(live, recipe, "page-changed");
      const late = await entryPressRefusal(live, recipe, url);
      if (late) return refuseEntry(live, recipe, late);
      const snapshot = await settings
        .handle({ version: 1, type: "settings.get" })
        .catch(() => undefined);
      if (!snapshot?.ok) return refuseEntry(live, recipe, "settings-unavailable");
      if (isSiteExcluded(snapshot.snapshot.settings, destination.href))
        return refuseEntry(live, recipe, "destination-excluded");
      if (!isSiteAllowed(snapshot.snapshot.settings, destination.href))
        return refuseEntry(live, recipe, "destination-not-allowed");
      if (!shown()) return;
      const press: EntryPress = {
        tabId,
        origin: live.document.origin,
        recipeId: recipe.id,
        revision: recipe.revision,
        pressedAt: isoTime(Date.now()),
        documentId: live.document.documentId,
        url,
        timing: { ...live.timing },
      };
      // Stored first, so a restarted worker still counts the press and checks its next page.
      const previous = entryPresses.get(tabId);
      entryPresses.set(tabId, press);
      try {
        await saveSession();
      } catch {
        if (previous) entryPresses.set(tabId, previous);
        else entryPresses.delete(tabId);
        return refuseEntry(live, recipe, "storage-unavailable");
      }
      const pressed = v.safeParse(
        entryPressResultSchema,
        await send(live, {
          type: "login.entry.press",
          target: recipe.entry.target,
          href,
          url,
        }).catch(() => undefined),
      );
      if (pressed.success && !pressed.output.ok) {
        // Nothing was clicked, so the press does not count.
        if (entryPresses.get(tabId) === press) {
          if (previous) entryPresses.set(tabId, previous);
          else entryPresses.delete(tabId);
          await quietly(saveSession);
        }
        return refuseEntry(live, recipe, pressed.output.reason ?? "target-changed");
      }
      if (!pressed.success) {
        // No answer says the link was clicked, so the press is not taken as one: its next
        // page is not checked. It still counts against the tab's limit, so a page that
        // never answers is not pressed again and again.
        if (entryPresses.get(tabId) === press) {
          entryPresses.set(tabId, { ...press, checked: true });
          await quietly(saveSession);
        }
        return refuseEntry(live, recipe, "unconfirmed");
      }
      reportEntry(tabId, recipe, "pressed");
      armEntryTimer(press);
    } finally {
      if (pressing.get(tabId) === documentId) pressing.delete(tabId);
    }
  }
  async function handle(message: unknown, sender: Sender): Promise<unknown> {
    // Probe controls are compiled into every build but answer only in the probe build.
    if (probeMode && trusted(sender)) {
      const control = v.safeParse(probeControlSchema, message);
      if (control.success) {
        if (control.output.action === "release") {
          if (!releaseCheckpoint) return { ok: false, reason: "checkpoint-not-paused" };
          releaseCheckpoint();
          return { ok: true };
        }
        if (armed || checkpoint) return { ok: false, reason: "checkpoint-busy" };
        armed = control.output.checkpoint;
        armTimer = setTimeout(() => {
          armed = undefined;
        }, 30000);
        return { ok: true };
      }
      const config = v.safeParse(configureSchema, message);
      if (config.success) {
        await loaded;
        if (persisted.size) return { ok: false, reason: "attempts-exist" };
        origin = config.output.origin;
        account = config.output.account ?? DEMO_PROBE_ACCOUNT;
        probePasskey = config.output.passkey;
        probeTotp = config.output.totp === true;
        probeStepWaitMs = config.output.stepWaitMs;
        await probeConfig.write({
          origin,
          ...(config.output.account ? { account } : {}),
          ...(probePasskey ? { passkey: probePasskey } : {}),
          ...(probeTotp ? { totp: true } : {}),
          ...(probeStepWaitMs === undefined ? {} : { stepWaitMs: probeStepWaitMs }),
        });
        return { ok: true };
      }
      if (v.safeParse(statusSchema, message).success) {
        await loaded;
        return {
          version: 1,
          ok: true,
          ...(checkpoint ? { checkpoint } : {}),
          attempts: [...persisted.values()],
          // Tabs that ask because the site rejected their login (ADR 0021 D).
          asks: [...rejectedAsks].map(() => "rejected"),
          documents: [...documents.values()].map((live) => ({
            ...live.document,
            ...(live.state ? { state: live.state } : {}),
            ...(live.reason ? { reason: live.reason } : {}),
            ...(live.observations ? { observations: live.observations } : {}),
          })),
        };
      }
      const cancel = v.safeParse(cancelSchema, message);
      if (cancel.success) {
        const run = attempts.get(cancel.output.tabId);
        if (!run) return { ok: false, reason: "attempt-not-found" };
        await change(run, { type: "CANCEL" });
        await send(run.live, { type: "login.cancel" }).catch(() => undefined);
        return { ok: true };
      }
      return undefined;
    }
    if (fromPopup(sender)) {
      const ask = v.safeParse(choiceRequestSchema, message);
      if (ask.success) return popupChoice(ask.output.tabId);
      const pausing = v.safeParse(pauseRequestSchema, message);
      if (pausing.success)
        return pauseFor(
          pausing.output.tabId,
          pausing.output.paused ? pausing.output.length : undefined,
        );
      const pauseState = v.safeParse(pauseStateRequestSchema, message);
      if (pauseState.success) return pauseStateFor(pauseState.output.tabId);
      const asked = v.safeParse(statusRequestSchema, message);
      if (asked.success) return popupStatus(asked.output.tabId);
      const pick = v.safeParse(pickRequestSchema, message);
      if (pick.success) return pickFor(pick.output);
      const switched = v.safeParse(switchRequestSchema, message);
      if (switched.success) return switchFor(switched.output);
      const detail = v.safeParse(detailRequestSchema, message);
      if (detail.success) return popupDetail(detail.output.tabId);
      const fill = v.safeParse(detailFillRequestSchema, message);
      if (fill.success) return popupDetailFill(fill.output);
      const remove = v.safeParse(detailRemoveRequestSchema, message);
      if (remove.success) return popupDetailRemove(remove.output.tabId, remove.output.detail);
      const reprompt = v.safeParse(repromptRequestSchema, message);
      if (reprompt.success) return repromptFor(reprompt.output.tabId);
      return undefined;
    }
    if (v.safeParse(personSubmittedSchema, message).success) {
      // Recorded at once, before the tab's next page announces: the page's own document,
      // as the browser names it, of a page Pateat does not fill (ADR 0035).
      const visit = sender.tab?.id === undefined ? undefined : confirmVisits.get(sender.tab.id);
      if (
        visit &&
        sender.id === browser.runtime.id &&
        sender.frameId === 0 &&
        sender.documentId === visit.document.documentId
      )
        visit.submitted = true;
      return undefined;
    }
    if (v.safeParse(submittedSchema, message).success) {
      const document = await identify(sender);
      // A sign-in in a frame counts for the tab's page, whose next page is skipped.
      const page =
        document && document.frameId !== 0
          ? documents.get(frameKey({ tabId: document.tabId, frameId: 0 }))?.document
          : document;
      if (page)
        passwordSubmits.set(page.tabId, {
          origin: page.origin,
          documentId: page.documentId,
          at: Date.now(),
        });
      return undefined;
    }
    const hello = v.safeParse(helloSchema, message);
    if (hello.success) {
      options.vault?.refreshIfStale();
      const answer = ready(
        sender,
        hello.output.token,
        hello.output.start,
        hello.output.signIn,
        hello.output.shown,
        hello.output.list,
        hello.output.entry,
        hello.output.unoffered,
        hello.output.switched,
      );
      const tabId = sender.tab?.id;
      const { announced } = options;
      if (announced && sender.frameId === 0 && tabId !== undefined && sender.url) {
        const { url } = sender;
        void answer.finally(() => announced(tabId, url)).catch(() => undefined);
      }
      return answer;
    }
    const destinationCheck = v.safeParse(destinationCheckSchema, message);
    if (destinationCheck.success) {
      const found = await operationRun(destinationCheck.output, sender);
      const destination = URL.parse(destinationCheck.output.destination);
      if (
        !found ||
        !destination ||
        !validateLoginOperation(
          found.operation,
          found.run.metadata,
          found.document,
          found.run.metadata.policyRevision,
        )
      )
        return { ok: false, reason: "not-authorized" };
      const reason = await destinationRefusal(found.run, destination);
      return reason ? { ok: false, reason } : { ok: true };
    }
    // Keys are pressed only while the keypad fill is the attempt's own and authorized, and
    // from then on a replaced page may be its own submission (ADR 0067).
    const keypadPress = v.safeParse(keypadPressSchema, message);
    if (keypadPress.success) {
      const found = await operationRun(keypadPress.output, sender);
      if (
        !found ||
        !keypadStep(found.operation.step) ||
        !validateLoginOperation(
          found.operation,
          found.run.metadata,
          found.document,
          found.run.metadata.policyRevision,
        )
      )
        return false;
      keypadPresses.set(found.run.metadata.id, {
        operationId: found.operation.operationId,
        stepIndex: found.operation.stepIndex,
      });
      return true;
    }
    const authorization = v.safeParse(authorizeSchema, message);
    if (!authorization.success) return undefined;
    const found = await operationRun(authorization.output, sender);
    if (!found) return false;
    return validateLoginOperation(
      found.operation,
      found.run.metadata,
      found.document,
      found.run.metadata.policyRevision,
    );
  }
  /**
   * The attempt whose current operation the sender's document asks about, while that
   * document still holds it and the settings still allow it; a frame's attempt holds only
   * while the tab still shows the page it matched.
   */
  async function operationRun(
    request: { token: string; attemptId: string; operationId: string },
    sender: Sender,
  ): Promise<
    | { run: Execution; operation: NonNullable<Execution["operation"]>; document: LoginDocument }
    | undefined
  > {
    const document = await identify(sender);
    if (!document) return undefined;
    const run = attempts.get(document.tabId);
    const operation = run?.operation;
    if (
      !run ||
      !operation ||
      !current(run) ||
      run.live.token !== request.token ||
      run.metadata.id !== request.attemptId ||
      operation.operationId !== request.operationId ||
      !sameLoginDocument(run.live.document, document) ||
      (run.live.topUrl !== undefined &&
        (!sender.tab?.url || new URL(sender.tab.url).origin !== new URL(run.live.topUrl).origin))
    )
      return undefined;
    if (!(await allowed(run))) return undefined;
    return { run, operation, document };
  }
  /**
   * Settings were synced from the service or saved locally: stops every running login but
   * a watched one, which only reads, so it is checked against the new settings instead and
   * stops only when they no longer plan its account (ADR 0027).
   */
  function settingsChanged(source: "synced" | "saved"): void {
    const stopped = new Set<number>();
    for (const run of attempts.values()) {
      if (terminal(run.metadata)) continue;
      if (run.metadata.watch !== undefined) {
        void allowed(run).catch(() => undefined);
        continue;
      }
      stopped.add(run.live.document.tabId);
      // Stop in-flight DOM waits promptly; the journal write may be slower.
      void send(run.live, { type: "login.cancel" }).catch(() => undefined);
      void change(
        run,
        { type: "POLICY_CHANGED" },
        { cause: source === "synced" ? "settings-synced" : "settings-saved" },
      ).catch(() => undefined);
    }
    // A site default saved for a page's origin ends its popup choice (ADR 0034).
    void choiceDefaults();
    void rulesChanged(stopped).catch(() => undefined);
  }
  /**
   * The pausing settings last applied (ADR 0062): the exclusion rules and automatic login
   * in private windows, so a settings change can tell what moved.
   */
  let appliedPolicy: PausingSettings | undefined;
  const policyRead = (async () => {
    appliedPolicy ??= await pausingSettings();
  })();
  /**
   * Applies changed pausing settings, exclusion rules or automatic login in private
   * windows, as the popup's pause and resume apply a pause (ADR 0062): every tab's badge
   * shows its page's pause, waiting conditional passkey requests of a page the settings now
   * pause go to the browser, and the tabs of a login that the settings change stopped on
   * such a page announce again, so they ask as paused pages. A page refused as paused, or a
   * choice offered because of a pause, that only the old settings paused announces again,
   * so it logs in at once; one a running pause still covers stays.
   */
  async function rulesChanged(stopped: ReadonlySet<number>): Promise<void> {
    await sessionLoaded;
    await policyRead;
    const after = await pausingSettings();
    if (!after) return;
    const before = appliedPolicy;
    appliedPolicy = after;
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(after)) return;
    const was = (page: {
      url: string;
      topUrl?: string | undefined;
      incognito?: boolean | undefined;
    }) => settingsPause(before, page) !== undefined;
    const tabs = await browser.tabs.query({}).catch(() => []);
    await Promise.all(tabs.map((tab) => showTabPause(tab).catch(() => undefined)));
    const incognitoOf = new Map(tabs.map((tab) => [tab.id, tab.incognito]));
    const announce = new Set<number>();
    for (const parked of [...parkedRequests])
      if (
        settingsPause(after, {
          url: parked.origin,
          incognito: parked.incognito ?? incognitoOf.get(parked.tabId),
        })
      )
        parked.settle({ kind: "delegate", reason: "paused" });
    reviewRequests();
    for (const live of documents.values()) {
      // eslint-disable-next-line no-await-in-loop
      const now = await pauseOf(live);
      if (now && stopped.has(live.document.tabId)) announce.add(live.document.tabId);
      else if (!now && live.reason === "paused" && was(live)) announce.add(live.document.tabId);
    }
    for (const [tabId, waiting] of [...pending]) {
      if (!waiting.paused) continue;
      const live = documents.get(frameKey(waiting.document));
      const page = live ?? { url: waiting.document.origin, incognito: incognitoOf.get(tabId) };
      // eslint-disable-next-line no-await-in-loop
      if (!(await pauseOf(page)) && was(page) && pending.get(tabId) === waiting) {
        clearChoice(tabId);
        announce.add(tabId);
      }
    }
    for (const id of announce)
      void browser.tabs
        .sendMessage(id, { version: 1, type: "login.reconnect" })
        .catch(() => undefined);
  }
  /**
   * Ends each popup choice whose origin has a site default by now, so the page's own
   * conditional request no longer waits for a pick (ADR 0034): after settings are saved or
   * synced, after a pick saves its account, and before a choice is checked.
   */
  async function choiceDefaults(): Promise<void> {
    if (!choicePasskeys.size) return;
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return;
    let ended = false;
    for (const [tabId, entry] of choicePasskeys) {
      const waiting = pending.get(tabId);
      if (
        waiting &&
        !entry.defaulted &&
        entry.key === choiceKey(waiting) &&
        snapshot.snapshot.settings.siteDefaults.some(
          (saved) => saved.origin === waiting.document.origin,
        )
      ) {
        entry.defaulted = true;
        ended = true;
      }
    }
    if (ended) reviewRequests();
  }
  browser.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
  /**
   * The last incognito window closed: the browser dropped that session, so what Pateat kept
   * for it ends too (ADR 0062, ADR 0063): its pauses, its sites that ask every time, its
   * switch picks and its relogin counts. A later incognito window starts afresh.
   */
  async function incognitoClosed(): Promise<void> {
    const windows = await browser.windows.getAll().catch(() => undefined);
    if (!windows || windows.some((window) => window.incognito)) return;
    await sessionLoaded;
    let changed = false;
    for (const [key, entry] of relogins)
      if (entry.incognito) {
        relogins.delete(key);
        changed = true;
      }
    if (changed) void quietly(saveSession);
    await Promise.all([
      pauses.clearIncognito().catch(() => undefined),
      accountPicks.forgetIncognito().catch(() => undefined),
    ]);
  }
  browser.windows?.onRemoved?.addListener(() => void incognitoClosed());
  // Chrome gives a tab a new ID when it discards it to save memory. It is the same tab to
  // the user: what the tab did moves to the new ID, and the gone page is forgotten as on
  // a close (ADR 0021). The event may be what starts the worker.
  browser.tabs.onReplaced.addListener((added, removed) => {
    if (added === removed) return;
    replacedTabs.add(removed);
    // An account switch's pick and state go with the tab, as to a prerendered sign-in page
    // (ADR 0063); moved before `forgetTab` below ends the gone tab's.
    void accountPicks.moveSwitch(removed, added).catch(() => undefined);
    const switching = switchStates.get(removed);
    if (switching) switchStates.set(added, switching);
    // A switch still logging out goes on in the new tab.
    const driven = switchTabs.get(removed);
    if (driven) {
      driven.id = added;
      switchTabs.delete(removed);
      switchTabs.set(added, driven);
    }
    if (switchesRunning.delete(removed)) switchesRunning.add(added);
    const incognito = incognitoTabs.get(removed);
    if (incognito !== undefined && !incognitoTabs.has(added)) incognitoTabs.set(added, incognito);
    const moved = (key: string) =>
      key.startsWith(`${removed} `) ? `${added}${key.slice(String(removed).length)}` : key;
    void sessionLoaded.then(async () => {
      let changed = false;
      for (const keys of [stoppedAsks, rejectedAsks])
        for (const key of [...keys])
          if (moved(key) !== key) {
            keys.delete(key);
            keys.add(moved(key));
            changed = true;
          }
      const press = entryPresses.get(removed);
      if (press) {
        const kept = { ...press, tabId: added };
        entryPresses.delete(removed);
        entryPresses.set(added, kept);
        if (!kept.checked) armEntryTimer(kept);
        changed = true;
      }
      // A pick that started its login stays with that login; one for the gone page does not.
      const pick = picked.get(removed);
      if (pick?.attemptId !== undefined) {
        picked.delete(removed);
        picked.set(added, { ...pick, tabId: added });
        changed = true;
      }
      if (changed) await quietly(saveSession);
      return undefined;
    });
    storageQueue = storageQueue
      .then(async () => {
        await loaded;
        let changed = false;
        for (const [key, metadata] of [...persisted])
          if (metadata.document.tabId === removed) {
            persisted.delete(key);
            persisted.set(recordKey(added, metadata.account.origin), {
              ...metadata,
              document: { ...metadata.document, tabId: added },
            });
            changed = true;
          }
        replacedTabs.delete(removed);
        if (changed) await attemptRecords.write([...persisted.values()]);
        return undefined;
      })
      .catch(() => {
        storageHealthy = false;
      });
    // The discarded page was not left: it loads again in the new tab and is logged there.
    confirmVisits.delete(removed);
    forgetTab(removed);
  });
  /** Forgets a closed tab, or the gone page of a replaced one. */
  function forgetTab(tabId: number): void {
    switchStates.delete(tabId);
    void accountPicks.endSwitch(tabId);
    const visit = confirmVisits.get(tabId);
    if (visit) leaveConfirm(visit);
    dropReprompt(tabId);
    passwordSubmits.delete(tabId);
    passwordFills.delete(tabId);
    afterSignIn.delete(tabId);
    for (const key of hellos.keys()) if (key.startsWith(`${tabId}:`)) hellos.delete(key);
    for (const [key, live] of documents) if (live.document.tabId === tabId) documents.delete(key);
    const closed = attempts.get(tabId);
    if (closed) continuations.delete(closed.metadata.id);
    attempts.delete(tabId);
    effects.delete(tabId);
    passkeyPages.delete(tabId);
    signInUrls.delete(tabId);
    choicePasskeys.delete(tabId);
    popupAnswers.delete(tabId);
    clearTimeout(entryTimers.get(tabId));
    entryTimers.delete(tabId);
    for (const key of entryRefused) if (key.startsWith(`${tabId} `)) entryRefused.delete(key);
    for (const map of [passkeyRequests, passkeyAnswers])
      for (const key of map.keys()) if (key.startsWith(`${tabId} `)) map.delete(key);
    void sessionLoaded.then(async () => {
      let changed = pending.delete(tabId);
      if (picked.delete(tabId)) changed = true;
      if (detailOffers.delete(tabId)) changed = true;
      if (pendingDetails.delete(tabId)) changed = true;
      // Each origin the tab asked for, logged once its asking ends, since the origin's other
      // tabs stop asking with it after a rejection and log in again (ADR 0021 D).
      const ended = new Map<string, "rejected" | "stopped-login">();
      for (const { origin: asked } of scopes(rejectedAsks).filter((entry) => entry.tabId === tabId))
        ended.set(asked, "rejected");
      for (const { origin: asked } of scopes(stoppedAsks).filter((entry) => entry.tabId === tabId))
        if (!ended.has(asked)) ended.set(asked, "stopped-login");
      for (const keys of [stoppedAsks, rejectedAsks])
        for (const key of keys)
          if (key.startsWith(`${tabId} `)) changed = keys.delete(key) || changed;
      for (const [asked, ask] of ended)
        report(
          { frameId: 0 },
          {
            type: "ask-ended",
            tabId,
            origin: asked,
            ask,
            cause: "tab-closed",
            ...(rejectedElsewhere(tabId, asked) ? { elsewhere: true as const } : {}),
          },
        );
      for (const key of askFills)
        if (key.startsWith(`${tabId} `)) changed = askFills.delete(key) || changed;
      if (entryPresses.delete(tabId)) changed = true;
      // A site's re-logins count until all of its tabs closed (ADR 0062).
      if (relogins.size && (await forgetClosedSites())) changed = true;
      for (const key of noted.keys())
        if (key.startsWith(`${tabId} `)) changed = noted.delete(key) || changed;
      // Kept until here, so `elsewhere` above compares the closed tab's window.
      incognitoTabs.delete(tabId);
      if (changed) await quietly(saveSession);
      return undefined;
    });
    storageQueue = storageQueue
      .then(async () => {
        await loaded;
        for (const [key, metadata] of persisted)
          if (metadata.document.tabId === tabId) persisted.delete(key);
        await attemptRecords.write([...persisted.values()]);
        return undefined;
      })
      .catch(() => {
        storageHealthy = false;
      });
  }
  // Pauses outlive a worker restart, and so does `II` on the badge of each tab of a paused
  // site, until its pause ends (ADR 0062).
  void browser.tabs
    .query({})
    .then((tabs) => Promise.all(tabs.map(showTabPause)))
    .catch(() => undefined);
  // A worker restart does not reinstall content scripts. Rebind browser-provided
  // document identity before reconciling, without restoring pending side effects.
  void loaded
    .then(async () => {
      if (!storageHealthy) return undefined;
      const patterns = [
        ...(probeMode ? [`${origin}/*`] : []),
        ...(sites ? (await sites.origins()).map((entry) => `${entry}/*`) : []),
        // An automatically chosen account has no saved default until it authenticates.
        ...persisted.values().map((entry) => `${entry.account.origin}/*`),
      ];
      const tabs = patterns.length ? await browser.tabs.query({ url: patterns }) : [];
      // A frame's attempt lives in a tab whose own URL may be on another origin.
      const tabIds = new Set([
        ...tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        ...persisted.values().map((entry) => entry.document.tabId),
      ]);
      for (const tabId of tabIds)
        void browser.tabs
          // Every frame announces again; a frame inside the page may hold the attempt.
          .sendMessage(tabId, { version: 1, type: "login.reconnect" })
          .catch(() => undefined);
      await sessionLoaded;
      for (const waiting of pending.values())
        if (!tabIds.has(waiting.document.tabId)) void revive(waiting);
      return undefined;
    })
    .catch(() => undefined);
  /**
   * Whether a login is in progress; a policy write now would stop it. An attempt between
   * pages has no current document, so its saved state counts too, once it is loaded;
   * a settled one counts only as `inProgress` says.
   */
  async function active(): Promise<boolean> {
    await loaded;
    return (
      attempts.values().some(inProgress) ||
      persisted.values().some((metadata) => !terminal(metadata) && !idle(metadata))
    );
  }
  /**
   * The vault item of the login a tab is running on an origin. The passkey bridge answers
   * that login's requests with this item only (ADR 0027). A login runs while its record,
   * in memory or read back from storage after a worker restart, is neither authenticated
   * nor blocked, its result has not settled as unknown since it last moved on, and it is
   * not watched (ADR 0027).
   */
  async function loginAccount(
    tabId: number,
    siteOrigin: string,
  ): Promise<{ connectionId: string; itemId: string } | undefined> {
    await loaded;
    const metadata = recordFor(tabId, siteOrigin);
    return metadata && !terminal(metadata) && !idle(metadata)
      ? { connectionId: metadata.account.connectionId, itemId: metadata.account.itemId }
      : undefined;
  }
  /**
   * Whether a passkey request naming its credentials in this tab is a re-verification while
   * signed in (ADR 0035): the tab's Pateat login of the origin signed in, and its first step
   * did not show again since, which forgets the record as a logout (ADR 0062). A login made
   * in another tab or before a browser restart is not known here.
   */
  async function passkeyReverification(tabId: number, siteOrigin: string): Promise<boolean> {
    await loaded;
    const metadata = recordFor(tabId, siteOrigin);
    return metadata?.state === "authenticated" && !metadata.fillOnly;
  }
  /** The passkey bridge saw a request of this tab's top document (ADR 0029: S5). */
  function passkeyRequested(tabId: number, siteOrigin: string): void {
    passkeyRequests.set(`${tabId} ${siteOrigin}`, Date.now());
  }
  /**
   * The passkey bridge returned an assertion for `rpId`, signed with `item`, to a page of
   * this tab (ADR 0022).
   */
  function passkeyAnswered(
    tabId: number,
    siteOrigin: string,
    rpId: string,
    item?: { connectionId: string; itemId: string },
    facts?: { silent?: true; incognito: boolean; documentId?: string },
  ): void {
    // A sign-in Pateat answered by itself outside a login counts as a relogin, so a page
    // that asks for a passkey on load after each logout cannot loop (ADR 0062).
    if (facts?.silent) void sessionLoaded.then(() => countSignIn(siteOrigin, facts.incognito));
    // A running login's answer is that login's step, which it follows itself (ADR 0034).
    const running = recordFor(tabId, siteOrigin);
    const outside = !running || terminal(running) || idle(running);
    passkeyAnswers.set(`${tabId} ${siteOrigin}`, {
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
  function retryAfterPasskey(live: LiveDocument, answeredAt: number): void {
    setTimeout(
      () => {
        if (
          documents.get(frameKey(live.document)) !== live ||
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
  async function signedInByPasskey(
    record: LoginAttemptMetadata,
    live: LiveDocument,
  ): Promise<boolean> {
    delete live.moveMiss;
    const answer = passkeyMoveFits(record, live.document.tabId, live.document.origin);
    if (!answer || live.document.frameId !== 0 || live.topUrl !== undefined) {
      live.moveMiss = "no-factor";
      return false;
    }
    return quietMove(live, answer.at);
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
  async function signedInByPassword(
    record: LoginAttemptMetadata,
    live: LiveDocument,
  ): Promise<boolean> {
    delete live.moveMiss;
    if (live.document.frameId !== 0 || live.topUrl !== undefined) {
      live.moveMiss = "no-factor";
      return false;
    }
    const stillLive = () => documents.get(frameKey(live.document)) === live;
    // The same document announcing again while its page is judged waits for that verdict.
    const judging = moveJudgements.get(record.id);
    if (judging?.documentId === live.document.documentId)
      return (await judging.verdict) && stillLive();
    const effect = passwordMoveFits(record, live.document.tabId, live.document.origin);
    if (!effect) {
      live.moveMiss = "no-factor";
      return false;
    }
    const username = await moveUsername(record);
    if (!stillLive()) return false;
    if (!username) {
      live.moveMiss = "no-username";
      return false;
    }
    // A login that stops before its item's missing password is not signed in by the
    // username in the header or navigation (ADR 0036): a quiet page is judged.
    const reading =
      record.stopAt === undefined
        ? await quietMove(live, effect.at, username, true)
        : (await quietMove(live, effect.at)) && ("unproven" as const);
    if (reading !== "unproven" || !stillLive()) return reading === "signed-in";
    const verdict = judgeMove(record, live, username, effect.at);
    moveJudgements.set(record.id, { documentId: live.document.documentId, verdict });
    try {
      return (await verdict) && stillLive();
    } finally {
      if (moveJudgements.get(record.id)?.verdict === verdict) moveJudgements.delete(record.id);
    }
  }
  /**
   * The recipe revision a login on another page of its tab ran, from its execution or the
   * recipe cache: for a chooser login (ADR 0028), the route of its click. `undefined` when
   * that revision is no longer at hand.
   */
  async function attemptRecipe(record: LoginAttemptMetadata): Promise<LoginRecipe | undefined> {
    const run = attempts.get(record.document.tabId);
    if (run?.metadata.id === record.id && run.recipe.revision === record.recipeRevision)
      return run.recipe;
    const { origin: loginOrigin } = record.account;
    const click = record.chooser?.click;
    const found = click
      ? await recipes.chooser?.(loginOrigin, "/", record.recipeId, record.layout)
      : await recipes.recipe(loginOrigin, "/", record.recipeId, record.layout);
    const route =
      found && (click && !isLoginRouteRecipe(found) ? chooserRoute(found, click) : found);
    return route && isLoginRouteRecipe(route) && route.revision === record.recipeRevision
      ? route
      : undefined;
  }
  /**
   * For a `password` login whose tab moved to `live`, a quiet page of another origin
   * (`passwordMoveFits`) that does not show the account's username (ADR 0022): whether a
   * signed-in marker learned on that origin shows, or else the judge of ADR 0029, asked
   * once, answers `signed-in` for the page or found it signed in before, or answers
   * `optional` (ADR 0065) for a page described without leaving a disabled field out, once
   * the attempt submitted the password or a TOTP code and without a stop (ADR 0036). A
   * judge that cannot decide, a page that cannot be described or sent, and any other
   * verdict end the login `left-origin` (a watched one where it stopped), each logged.
   * Once the answer is back, the page must still be loaded and show no password field,
   * code input or CAPTCHA, with no passkey request since `since`, the step the move
   * follows. `username` is the login's own, hidden from the page as for any judged page.
   */
  async function judgeMove(
    record: LoginAttemptMetadata,
    live: LiveDocument,
    username: string,
    since: number,
  ): Promise<boolean> {
    const { document } = live;
    const recipe = await attemptRecipe(record);
    let disabledLeftOut = false;
    let inputLeftOut = false;
    // The answer's timing, once it came (ADR 0019).
    let timed: { timing?: ServiceTiming } = {};
    const reportJudge = (
      verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
      reason?: string,
    ) =>
      report(document, {
        type: "judge",
        tabId: document.tabId,
        origin: document.origin,
        recipeId: record.recipeId,
        recipeRevision: record.recipeRevision,
        route: record.route,
        verdict,
        ...(reason ? { reason } : {}),
        moved: true,
        ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
        ...timed,
      });
    const stale = () =>
      documents.get(frameKey(document))?.document.documentId !== document.documentId;
    if (!recipe) {
      reportJudge("not-sent", "recipe-unavailable");
      return false;
    }
    // A marker learned on this origin proves the sign-in, as on the recipe's own origin.
    const proof = markerProof(recipe, document.origin);
    if (proof.targets.length > 0) {
      let observed: v.InferOutput<typeof observationSchema> | undefined;
      try {
        const parsed = v.safeParse(
          observationSchema,
          await send(live, {
            type: "login.observe",
            path: live.path,
            targets: proof.targets,
            require: proof.shown,
            links: proof.links,
            hidden: proof.hidden,
          }),
        );
        observed = parsed.success ? parsed.output : undefined;
      } catch {
        observed = undefined;
      }
      if (stale()) return false;
      if (observed && proof.proves(observed.targets)) return true;
      if (
        observed?.targets.some(
          (state, index) => proof.links[index] && (state === "unique" || state === "ambiguous"),
        )
      ) {
        // A marker shows, but does not prove the sign-in: the service would not judge it.
        reportJudge("not-sent", "marker-shown");
        return false;
      }
    }
    if (!generation) {
      reportJudge("not-sent", "no-service");
      return false;
    }
    let observation: LoginObservation | undefined;
    let unsent = "unreachable";
    try {
      const extracted = v.safeParse(
        extractResultSchema,
        await send(live, { type: "login.extract", page: "signed-in" }),
      );
      const parsed =
        extracted.success && extracted.output.ok
          ? v.safeParse(loginObservationSchema, extracted.output.observation)
          : undefined;
      if (!extracted.success || !parsed?.success)
        unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "invalid-page";
      else if (!parsed.output.complete)
        unsent = (extracted.output.ok && extracted.output.gap) || "incomplete";
      // The page may have changed its own URL since it announced (history.pushState), as a
      // signed-in single-page app does while it loads; no recipe path applies on this
      // origin, so the page is judged at the path it shows now.
      else if (parsed.output.origin !== document.origin) unsent = "page-changed";
      else {
        observation = parsed.output;
        disabledLeftOut = extracted.output.ok && extracted.output.disabledLeftOut === true;
        inputLeftOut = extracted.output.ok && extracted.output.inputLeftOut === true;
      }
    } catch {
      // The page could not be asked: `unreachable`.
    }
    if (stale()) return false;
    if (!observation) {
      reportJudge("not-sent", unsent);
      return false;
    }
    // The login's own username's shape, for the judge's slots, from the value already read.
    const shape = usernameShape({ complete: true }, username ? [username] : []);
    // The usernames of the items that match the page are hidden too, as for any judged page.
    const scope = await generationSlotsFor(live).catch(() => undefined);
    const others = await readUsernames(
      document.origin,
      scope
        ? usernameReads(scope).filter(
            ({ connection, itemId }) =>
              connection.id !== record.account.connectionId || itemId !== record.account.itemId,
          )
        : [],
    );
    const hidden = hideUsernames(observation, others && [username, ...others], live);
    if (stale()) return false;
    if ("reason" in hidden) {
      reportJudge("not-sent", hidden.reason);
      return false;
    }
    // The account's slots go with the page, as for every judged page (owner 2026-10-23).
    const judged = await judgeSlots(document.origin, record.account, record.route, {
      usernameShape: shape,
    });
    if (stale()) return false;
    const spin = spinning(document.tabId);
    const asked = Date.now();
    const { verdict, reason, timing } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        "password",
        hidden.observation,
        spin.sent(() => reportJudge("sent")),
        // A description that left out a disabled field says so (ADR 0029); only `signed-in`
        // completes a moved login then.
        branchOf(record),
        disabledLeftOut ? true : undefined,
        undefined,
        judged.slots,
      )
      .finally(spin.stop);
    spend(record.id, Date.now() - asked, timing);
    if (timing) timed = { timing };
    reportJudge(verdict, reason);
    // `optional` (ADR 0065) completes it only on a full description with no radio button,
    // select or text area left out, once the attempt submitted the item's password or a
    // TOTP code (a move within the site may follow an identifier's Next), and not for a
    // login stopped before its missing password, which only `signed-in` proves (ADR 0036).
    const fill = passwordFills.get(document.tabId);
    const effect = effects.get(document.tabId);
    const sent =
      (fill?.attemptId === record.id && fill.submitted) ||
      (effect?.attemptId === record.id && effect.code !== undefined);
    const optional = verdict === "optional";
    if (
      verdict !== "signed-in" &&
      !(verdict === "unclear" && reason === "judged-signed-in") &&
      !(optional && !disabledLeftOut && !inputLeftOut && record.stopAt === undefined && sent)
    )
      return false;
    // An optional page must still be on the path it was judged on.
    if (optional) {
      let at: unknown;
      try {
        at = await send(live, { type: "login.observe", path: live.path, targets: [] });
      } catch {
        return false;
      }
      const shown = v.safeParse(observationSchema, at);
      if (stale() || !shown.success || observedPath(shown.output.path) !== observation.path)
        return false;
    }
    // The answer can take a while: the page must still be loaded and show no sign-in step.
    let again: unknown;
    try {
      again = await send(live, { type: "login.state" });
    } catch {
      return false;
    }
    const parsed = v.safeParse(stateResultSchema, again);
    if (stale() || !parsed.success || !parsed.output.ok || !parsed.output.loaded) return false;
    const { signs } = parsed.output;
    const requested = passkeyRequests.get(`${document.tabId} ${document.origin}`);
    return !signs.password && !signs.code && !signs.captcha && (requested ?? 0) < since;
  }
  /**
   * Whether `live`, the new top page of a move to another origin (ADR 0022), once loaded
   * and read again a second later, shows no password field, code input or CAPTCHA and has
   * not asked for a passkey since `since`, the page signs of ADR 0029. With `username`, it
   * must also show the account's username in its header or navigation (E2) in both
   * readings; the username goes to the page's content script for that comparison only, as
   * for E2 after an effect step. A page still loading, or not showing the username yet, is
   * read again, a second apart. Only reads.
   */
  async function quietMove(live: LiveDocument, since: number, username?: string): Promise<boolean>;
  /**
   * As above, with `split` telling apart, as `unproven`, a page that showed no such sign
   * in its last two loaded readings but never the username in two.
   */
  async function quietMove(
    live: LiveDocument,
    since: number,
    username: string,
    split: true,
  ): Promise<"signed-in" | "unproven" | false>;
  async function quietMove(
    live: LiveDocument,
    since: number,
    username?: string,
    split = false,
  ): Promise<boolean | "signed-in" | "unproven"> {
    const { tabId, origin: pageOrigin } = live.document;
    let quiet = 0;
    let calm = 0;
    // Each reading depends on the time passed since the last, so they run one after another.
    /* eslint-disable no-await-in-loop */
    for (let reading = 0; reading < SITE_MOVE_READINGS && quiet < 2; reading++) {
      if (reading > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
      if (documents.get(frameKey(live.document)) !== live) return false;
      let response: unknown;
      try {
        response = await send(live, {
          type: "login.state",
          ...(username ? { account: { username } } : {}),
        });
      } catch {
        live.moveMiss = "page-gone";
        return false;
      }
      const parsed = v.safeParse(stateResultSchema, response);
      if (!parsed.success || !parsed.output.ok) {
        live.moveMiss = "unreadable";
        return false;
      }
      const { signs } = parsed.output;
      const requested = passkeyRequests.get(`${tabId} ${pageOrigin}`);
      if (signs.password || signs.code || signs.captcha) {
        live.moveMiss = "sign-in-shown";
        return false;
      }
      if ((requested ?? 0) >= since) {
        live.moveMiss = "passkey-request";
        return false;
      }
      // A page that renders its header late, as a single-page site does, is read again.
      quiet = parsed.output.loaded && (!username || signs.username === true) ? quiet + 1 : 0;
      calm = parsed.output.loaded ? calm + 1 : 0;
    }
    /* eslint-enable no-await-in-loop */
    if (quiet >= 2) return split ? "signed-in" : true;
    if (split && calm >= 2) return "unproven";
    live.moveMiss = "not-quiet";
    return false;
  }
  /**
   * The passkey answer that lets a top-level attempt's tab moving to `siteOrigin` complete
   * (ADR 0022), if any: given after the attempt's last effect step and at most
   * `SITE_MOVE_MS` ago, for an RP ID that `siteOrigin`'s host is or is under, on HTTPS or
   * `http://localhost` (ADR 0050). It was
   * given to the attempt's page, or to the page of another origin of the site the tab moved
   * to and that asked for it (`passkeyPages`), there signed with the attempt's own item;
   * once such a page asked, only an answer given since counts.
   */
  function passkeyMoveFits(
    record: LoginAttemptMetadata,
    tabId: number,
    siteOrigin: string,
  ): { at: number; rpId: string } | undefined {
    const effect = effects.get(tabId);
    if (effect?.attemptId !== record.id) return undefined;
    const kept = passkeyPages.get(tabId);
    const page = kept?.attemptId === record.id ? kept : undefined;
    const moved = page && passkeyAnswers.get(`${tabId} ${page.document.origin}`);
    const { hostname } = new URL(siteOrigin);
    const fits = (answer: { at: number; rpId: string } | undefined) =>
      answer !== undefined &&
      answer.at >= (page?.requestedAt ?? effect.at) &&
      Date.now() - answer.at <= SITE_MOVE_MS &&
      passkeyOrigin(siteOrigin) &&
      (hostname === answer.rpId || hostname.endsWith(`.${answer.rpId}`));
    return [
      passkeyAnswers.get(`${tabId} ${record.document.origin}`),
      moved?.item?.connectionId === record.account.connectionId &&
      moved.item.itemId === record.account.itemId
        ? moved
        : undefined,
    ]
      .filter(fits)
      .sort((a, b) => b!.at - a!.at)[0];
  }
  /**
   * Whether `document`, the new top page of a top-level attempt's tab on `siteOrigin`, may
   * hold the attempt while it answers a passkey (ADR 0022). The page already holding it
   * may, within `SITE_MOVE_MS` of its request, or of an answer given there since (its
   * signs are read by `stillAsking`). Another page may while none was answered since the
   * last such page asked: an HTTPS origin of the attempt's registrable domain whose page
   * asked for a passkey after the attempt's last effect step, at most `SITE_MOVE_MS` after
   * it, and after the request of the page that held it before.
   */
  function passkeyPageFits(
    record: LoginAttemptMetadata,
    document: LoginDocument,
    siteOrigin: string,
  ): boolean {
    const { tabId } = document;
    const effect = effects.get(tabId);
    const kept = passkeyPages.get(tabId);
    const page = kept?.attemptId === record.id ? kept : undefined;
    const answer = page && passkeyAnswers.get(`${tabId} ${page.document.origin}`);
    const answered = page !== undefined && answer !== undefined && answer.at >= page.requestedAt;
    if (page?.document.documentId === document.documentId)
      return Date.now() - (answered ? answer!.at : page.requestedAt) <= SITE_MOVE_MS;
    const requested = passkeyRequests.get(`${tabId} ${siteOrigin}`);
    return (
      record.document.frameId === 0 &&
      effect?.attemptId === record.id &&
      !answered &&
      requested !== undefined &&
      requested >= effect.at &&
      requested - effect.at <= SITE_MOVE_MS &&
      (page === undefined || requested > page.requestedAt) &&
      loginMoveFits(record.document.origin, siteOrigin, false)
    );
  }
  /**
   * Whether the page holding a moved attempt while it answers a passkey, announcing again,
   * still shows no password field, code input or CAPTCHA (ADR 0022), as when the person
   * dismissed the passkey prompt and the page offers its sign-in form instead. Only reads.
   */
  async function stillAsking(live: LiveDocument): Promise<boolean> {
    try {
      const parsed = v.safeParse(stateResultSchema, await send(live, { type: "login.state" }));
      if (!parsed.success || !parsed.output.ok) return false;
      const { signs } = parsed.output;
      return !signs.password && !signs.code && !signs.captcha;
    } catch {
      return false;
    }
  }
  /**
   * Ends a moved attempt still held by a page that asked for a passkey once no next page
   * can complete it any more (ADR 0022), as when that page stays open: `left-origin`, on
   * that page, without resubmitting. Kept in memory only, as the hold is.
   */
  function holdForPasskey(tabId: number): void {
    const held = passkeyPages.get(tabId);
    if (!held) return;
    setTimeout(
      () => {
        if (passkeyPages.get(tabId) !== held) return;
        // A check of the tab's next page decides instead.
        if (siteMoves.has(tabId)) {
          holdForPasskey(tabId);
          return;
        }
        passkeyPages.delete(tabId);
        const run = attempts.get(tabId);
        const latest = run?.metadata ?? tabAttempt(tabId);
        if (latest?.id !== held.attemptId || terminal(latest)) return;
        const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(latest), {
          type: "NAVIGATED",
          document: held.document,
        });
        if (run) run.metadata = ended;
        reportAttempt(ended, run?.recipe);
        void keep(ended).catch(() => undefined);
      },
      2 * SITE_MOVE_MS + SIGN_IN_RECHECK_MS,
    );
  }

  /**
   * The time of the step that lets a top-level `password` attempt's tab moving to
   * `siteOrigin` complete on the account's username (ADR 0022), if any: the attempt's last
   * effect step, not one that asks for a passkey, delivered at most `SITE_MOVE_MS` ago,
   * with `siteOrigin` an HTTPS origin of the attempt's registrable domain; or, for an HTTPS
   * origin of any site, its second factor at most `SITE_MOVE_MS` ago: a TOTP code it
   * submitted (owner's choice on 2026-10-13, 01:59 UTC), or a passkey answered for its page
   * after its last effect step, once a submitting step followed its fill of the item's
   * password (03:13 UTC). A passkey answer for the new page's host decides the move instead
   * (`passkeyMoveFits`), and so does it alone once a page of the site the tab moved to asked
   * for a passkey (`passkeyPages`).
   */
  function passwordMoveFits(
    record: LoginAttemptMetadata,
    tabId: number,
    siteOrigin: string,
  ): { at: number } | undefined {
    const effect = effects.get(tabId);
    if (
      record.route !== "password" ||
      record.document.frameId !== 0 ||
      effect?.attemptId !== record.id ||
      passkeyMoveFits(record, tabId, siteOrigin) ||
      // After a page of the site asked for a passkey, only an answer there decides.
      passkeyPages.get(tabId)?.attemptId === record.id
    )
      return undefined;
    const now = Date.now();
    if (
      !effect.passkey &&
      now - effect.at <= SITE_MOVE_MS &&
      loginMoveFits(record.document.origin, siteOrigin, false)
    )
      return effect;
    const answer = passkeyAnswers.get(`${tabId} ${record.document.origin}`);
    const factors = [
      ...(effect.code === undefined ? [] : [effect.code]),
      ...(answer &&
      answer.at >= effect.at &&
      passwordFills.get(tabId)?.attemptId === record.id &&
      passwordFills.get(tabId)?.submitted
        ? [answer.at]
        : []),
    ];
    const factor = factors.length > 0 ? Math.max(...factors) : undefined;
    return factor !== undefined &&
      now - factor <= SITE_MOVE_MS &&
      loginMoveFits(record.document.origin, siteOrigin, true)
      ? { at: factor }
      : undefined;
  }
  /**
   * The username of a login's own account, for the E2 comparison on the page its tab moved
   * to (ADR 0022), read with the settings the login was authorized with. `undefined` when
   * the settings changed since, or the item has no username or it cannot be read.
   */
  async function moveUsername(record: LoginAttemptMetadata): Promise<string | undefined> {
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok || snapshot.snapshot.revision !== record.policyRevision) return undefined;
    const { connectionId, itemId } = record.account;
    const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
    const fieldId = connection && loginUsernameFieldId(connection, itemId);
    if (!connection || !fieldId) return undefined;
    try {
      return (await fields({ account: record.account, connection, fieldId })) || undefined;
    } catch {
      return undefined;
    }
  }
  /** The newest conditional request of a top document still waiting (ADR 0034). */
  function parkedFor(document: { tabId: number; documentId: string }): ParkedRequest | undefined {
    let found: ParkedRequest | undefined;
    for (const parked of parkedRequests)
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
  async function conditionalRequest(input: {
    tabId: number;
    origin: string;
    documentId: string;
    signal: AbortSignal;
    /** Whether the tab is incognito, as the request's sender says (ADR 0062). */
    incognito?: boolean;
  }): Promise<ConditionalDecision> {
    await loaded;
    await sessionLoaded;
    // A paused site's own request goes to the browser at once (ADR 0062).
    const incognito =
      input.incognito ?? (await browser.tabs.get(input.tabId).catch(() => undefined))?.incognito;
    const pausedPage = async () => (await pauseOf({ url: input.origin, incognito })) !== undefined;
    if (await pausedPage()) return { kind: "delegate", reason: "paused" };
    const run = attempts.get(input.tabId);
    // A site that asks every time logs in only by a pick, whose own login answers the
    // request of its document; any other goes to the browser (ADR 0063).
    if (
      run?.live.document.documentId !== input.documentId &&
      (await asksEveryTime(input.origin, incognito === true))
    )
      return { kind: "delegate", reason: "one-time-pick" };
    if (run?.live.document.documentId !== input.documentId) {
      const starts = await startsFor(input.origin).catch(() => []);
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
          if (!parkedRequests.delete(parked)) return false;
          input.signal.removeEventListener("abort", onAbort);
          resolve(decision);
          return true;
        },
      };
      parkedRequests.add(parked);
      input.signal.addEventListener("abort", onAbort, { once: true });
      reviewRequests();
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
  function askedFor(parked: ParkedRequest): boolean {
    const waiting = pending.get(parked.tabId);
    const pick = picked.get(parked.tabId);
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
  function stillAsks(tabId: number, siteOrigin: string): boolean {
    return !recordFor(tabId, siteOrigin) && askFor(tabId, siteOrigin) !== undefined;
  }
  /**
   * Records the popup choice a refused top document was offered, and whether the page's own
   * conditional request may wait for its pick: only outside an ask, on a recipe without a
   * passkey button (ADR 0034). The same choice offered again keeps its check.
   */
  function noteChoice(
    document: LoginDocument,
    candidates: PendingChoice["candidates"],
    applies: boolean,
  ): void {
    if (!applies) {
      choicePasskeys.delete(document.tabId);
      return;
    }
    const key = choiceKey({ document, candidates });
    const known = choicePasskeys.get(document.tabId);
    // The same choice offered again keeps a passkey found or a check running; one that found
    // none, as with a locked vault, or that a default ended, is checked again.
    if (known?.key !== key || known.defaulted || (!known.checking && known.holds !== true))
      choicePasskeys.set(document.tabId, { key, documentId: document.documentId });
    // A request already waiting has its choice checked at once.
    if (parkedFor(document)) reviewRequests();
  }
  /**
   * Looks up once whether an item of a popup choice holds a discoverable, usable passkey
   * (ADR 0034), holding vault replacement off meanwhile. A locked vault, a search that
   * could not finish or a failed lookup count as none.
   */
  function checkChoice(entry: ChoicePasskeys, waiting: PendingChoice): void {
    if (entry.checking || entry.holds !== undefined) return;
    const lookup = options.passkeyItems;
    if (!lookup) {
      entry.holds = false;
      return;
    }
    entry.checking = true;
    void (async () => {
      // A default saved before the choice was noted ends it too.
      await choiceDefaults();
      let held: readonly PasskeyItem[] = [];
      const leave = await options.vault?.enter(false).catch(() => undefined);
      try {
        held = await lookup(waiting.document.origin);
      } catch {
        held = [];
      } finally {
        leave?.();
      }
      entry.holds = waiting.candidates.some((candidate) =>
        held.some(
          (item) =>
            item.connectionId === candidate.connectionId && item.itemId === candidate.itemId,
        ),
      );
      delete entry.checking;
      reviewRequests();
    })();
  }
  /**
   * Whether the request's document waits for a pick in a popup choice outside an ask
   * (ADR 0034): `waits` while that choice is offered and one of its items holds a
   * discoverable passkey, or while its pick has not started a login yet; `checking` while
   * the choice's items are looked up, which starts the lookup once per choice.
   */
  function choiceWaits(parked: ParkedRequest): "waits" | "checking" | "none" {
    const waiting = pending.get(parked.tabId);
    const entry = choicePasskeys.get(parked.tabId);
    // As the popup sees it: a document that announced again and started a login, or
    // another document of the frame, no longer offers it.
    const live = waiting && documents.get(frameKey(waiting.document));
    if (
      waiting &&
      entry &&
      !waiting.ask &&
      !entry.defaulted &&
      waiting.document.frameId === 0 &&
      waiting.document.documentId === parked.documentId &&
      waiting.document.origin === parked.origin &&
      entry.key === choiceKey(waiting) &&
      (!live || sameLoginDocument(live.document, waiting.document)) &&
      recordFor(parked.tabId, parked.origin) === undefined
    ) {
      checkChoice(entry, waiting);
      if (entry.holds === undefined) return "checking";
      if (entry.holds) return "waits";
    }
    // The pick clears the choice; until its login starts, the request waits for it too.
    const pick = picked.get(parked.tabId);
    if (
      pick === undefined ||
      pick.attemptId !== undefined ||
      pick.origin !== parked.origin ||
      pick.documentId !== parked.documentId
    )
      return "none";
    if (parked.picking) return "waits";
    // Picked while its choice was still being checked.
    if (entry?.documentId !== parked.documentId || entry.defaulted) return "none";
    if (entry.checking) return "checking";
    return entry.holds ? "waits" : "none";
  }
  /**
   * Decides every waiting conditional request whose login ended or never started, and
   * checks again each second while one waits (ADR 0034). The `passkey` route answers its
   * own page's request itself. A request whose document the tab asks for an account (ADR
   * 0021 D, ADR 0062), or fills only, waits for the login the pick starts; so does one whose
   * document is offered a popup choice in which an item holds a passkey, for up to four
   * minutes.
   */
  function reviewRequests(): void {
    const now = Date.now();
    for (const parked of [...parkedRequests]) {
      const run = attempts.get(parked.tabId);
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
      const offered = !running && askedFor(parked);
      if (offered) delete parked.dropped;
      if (running ? own.fillOnly : offered) parked.asked = true;
      // A choice still offered decides alone: another tab's login can end the rejection this
      // tab asks for, while its choice stays. A dropped pick leaves it a moment to be
      // offered again. A login that only fills while the tab asks waits as the ask does.
      const asks = running
        ? own.fillOnly === true
        : offered ||
          (parked.asked === true &&
            stillAsks(parked.tabId, parked.origin) &&
            (parked.dropped === undefined || now - parked.dropped < REQUEST_START_WAIT_MS));
      // A popup choice outside an ask keeps the request while it offers an item with a
      // passkey, or while that is being checked. Once the choice goes, the request waits a
      // moment for it to be offered again. A login of its document, once seen, decides.
      const free = !parked.during && !asks;
      const choice = free ? choiceWaits(parked) : "none";
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
        // not decide it.
        if (now - parked.since >= REQUEST_START_WAIT_MS)
          parked.settle({ kind: "delegate", reason: own ? "login-ended" : "no-login" });
      } else if (own.state === "authenticated") parked.settle({ kind: "withhold" });
      else if (ended) parked.settle({ kind: "delegate", reason: "login-ended" });
      else if (now - parked.since >= REQUEST_PARK_MS) parked.settle({ kind: "withhold" });
    }
    if (parkedRequests.size && reviewTimer === undefined)
      reviewTimer = setInterval(reviewRequests, 1000);
    else if (!parkedRequests.size && reviewTimer !== undefined) {
      clearInterval(reviewTimer);
      reviewTimer = undefined;
    }
  }
  /**
   * Whether a login takes the `passkey` route because its page asked for a passkey by
   * itself (ADR 0034): only before anything was submitted, so a chooser login only before
   * its click on the list, on a recipe without a passkey
   * button, for an item that held a discoverable passkey when the login started. Fields
   * already filled stay as they are.
   */
  async function switchToPasskey(run: Execution): Promise<boolean> {
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
      !parkedFor(run.live.document)
    )
      return false;
    await change(
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
    return current(run) && run.metadata.route === "passkey";
  }
  /**
   * The `passkey` route's one step on a recipe without a passkey button (ADR 0034): the
   * page's own conditional request is answered with the login's item. The answer counts as
   * a submission, recorded before it goes out. Without a request, or when the item cannot
   * answer it, the login falls back to its password variant.
   */
  async function answerRequest(run: Execution): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    let parked = parkedFor(run.live.document);
    // A page may cancel its request and ask again, as when its form renders once more.
    for (const until = Date.now() + REQUEST_WAIT_MS; !parked && Date.now() < until;) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
      if (!current(run) || run.metadata.state !== "ready") return;
      parked = parkedFor(run.live.document);
    }
    if (!parked) {
      await fallBack(run, "request-missing");
      return;
    }
    if (!(await allowed(run))) return;
    const operation = nextLoginOperation(run.metadata, run.recipe, run.live.document, newId());
    if (!operation) {
      await change(
        run,
        { type: "FAILED", reason: "structural-mismatch" },
        undefined,
        "no-operation",
      );
      return;
    }
    run.operation = operation;
    run.delivered = false;
    await change(run, {
      type: "PREPARE",
      operationId: operation.operationId,
      kind: "click",
      effect: "submit",
    });
    await change(run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
    if (!current(run) || run.metadata.state !== "submit-intent") return;
    const authorized = await allowed(run);
    if (!authorized) return;
    if (
      !validateLoginOperation(
        operation,
        run.metadata,
        run.live.document,
        run.metadata.policyRevision,
      )
    ) {
      await change(run, { type: "FAILED", reason: "timeout" }, undefined, "operation-invalid");
      return;
    }
    const { tabId } = run.live.document;
    run.delivered = true;
    const deliveredAt = Date.now();
    effects.set(tabId, {
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
    if (!current(run) || run.metadata.state !== "submit-intent") return;
    if (signed) {
      run.answeredAt = Date.now();
      await change(run, { type: "SUBMITTED", operationId: operation.operationId });
      // A WebAuthn exchange is observed with the usual budget, held while the form shows.
      await reconcileBounded(run);
      return;
    }
    run.passkeyFailed = true;
    await change(
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
    await fallBack(run, gone ? "request-missing" : "answer-failed");
  }
  /**
   * When the passkey bridge last returned an assertion to the login's page since its last
   * effect step (ADR 0027), if it did: a request that showed a prompt, answered with the
   * login's item.
   */
  function bridgeAnswer(run: Execution): number | undefined {
    const { tabId, origin: pageOrigin } = run.live.document;
    const answer = passkeyAnswers.get(`${tabId} ${pageOrigin}`);
    const effect = effects.get(tabId);
    return answer && effect?.attemptId === run.metadata.id && answer.at >= effect.at
      ? answer.at
      : undefined;
  }
  /**
   * A login of an item without a password at its stop (ADR 0036) fills nothing there. It
   * waits up to `REQUEST_WAIT_MS` for its document's conditional passkey request, counting
   * one that was already waiting, and answers it with its item; a request the bridge
   * already answered since its last effect step counts the same. The answer is a
   * submission, recorded before a waiting request is answered, and the page is then
   * observed as after a click, held while the sign-in form still shows for up to
   * `REQUEST_HOLD_MS`. A stop just past the plan's last step has no form of its own: its
   * page is held while it stays on the path the answer was given on. Without a request the
   * login ends `challenge`, watched, as `password-empty`.
   */
  async function stopBeforePassword(run: Execution): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const stopped = () => current(run) && run.metadata.state === "ready" && atStop(run.metadata);
    if (!(await allowed(run)) || !stopped()) return;
    let parked = parkedFor(run.live.document);
    let bridged = bridgeAnswer(run);
    for (
      const until = Date.now() + REQUEST_WAIT_MS;
      !parked && bridged === undefined && Date.now() < until;
    ) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
      if (!stopped()) return;
      parked = parkedFor(run.live.document);
      bridged = bridgeAnswer(run);
    }
    if (!(await allowed(run)) || !stopped()) return;
    // A continuation the stop could not be moved into names why (ADR 0036).
    const end = (cause?: StopCause) =>
      change(
        run,
        { type: "OBSERVED", result: "challenge", document: run.live.document },
        undefined,
        cause,
        undefined,
        run.stopMiss ? `password-empty:${run.stopMiss}` : "password-empty",
      );
    if (!parked && bridged === undefined) {
      // A passkey button beside the stop's password field is pressed instead (owner,
      // 2026-10-13 05:39 UTC); its request is then answered here as any.
      if (await pressAtStop(run, stopped, () => end())) return;
      if (stopped()) await end();
      return;
    }
    // A stop just past the plan's last step holds the page on the path it answers on.
    const page = stopsPastPlan(run.metadata) ? await observe(run, [], []) : undefined;
    if (!stopped()) return;
    if (page) run.answeredPath = page.path;
    else delete run.answeredPath;
    const operationId = newId();
    await change(run, { type: "STOP_ANSWERED", operationId });
    const answering = () =>
      current(run) &&
      run.metadata.state === "reconciling" &&
      run.metadata.operationId === operationId;
    if (!answering()) {
      // An answer the attempt refuses, such as one past its submissions, ends the login.
      if (stopped()) await end();
      return;
    }
    const { tabId } = run.live.document;
    if (bridged !== undefined) {
      // The step that asked for a passkey is the answer's, so S5 skips its answered request
      // and a move to the passkey's site completes (ADR 0029, ADR 0022).
      effects.set(tabId, {
        attemptId: run.metadata.id,
        at: bridged,
        document: run.live.document,
        submits: false,
        passkey: true,
        request: true,
        requestAt: bridged,
      });
      run.answeredAt = bridged;
    } else if (parked) {
      const deliveredAt = Date.now();
      effects.set(tabId, {
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
      // The bridge says whether the assertion went back; a request that went away
      // meanwhile was never answered.
      let gone = false;
      const signed = await new Promise<boolean>((resolve) => {
        gone = !target.settle({ kind: "answer", item, answered: resolve });
        if (gone) resolve(false);
      });
      if (!answering()) return;
      if (!signed) {
        await end(gone ? undefined : "answer-failed");
        return;
      }
      run.answeredAt = Date.now();
    }
    await reconcileBounded(run);
  }
  /**
   * At a login's stop with no passkey request in time (ADR 0036, owner 2026-10-13 05:39
   * UTC): enters a `passkey` handler of the recipe shown on the page, before the stop step,
   * so its button is pressed and the request that follows is answered with the item. With
   * none, a page that still shows the stop step's password field on its path, where the
   * recipe has no `passkey` handler yet, is sent once to be judged for such a button
   * (`judgeStop`). Returns whether the caller leaves the
   * login as it is: moved on, ended, or no longer this run's.
   */
  async function pressAtStop(
    run: Execution,
    stopped: () => boolean,
    end: () => Promise<void>,
  ): Promise<boolean> {
    const step = (attemptPlan(run.recipe, run.metadata) ?? [])[run.metadata.stopAt!]?.step;
    const stopFields = step ? stepTargets(step) : [];
    const page = await observe(
      run,
      stopFields,
      stopFields.map(() => "shown" as const),
    );
    if (!current(run)) return true;
    if (!page || !stopped()) return false;
    if (await enterHandler(run, page.path, { end })) return true;
    if (!current(run)) return true;
    // A path that has a `passkey` handler already gets no other: the service would refuse
    // it as a duplicate, so the page is not judged for one.
    if (
      !stopped() ||
      !step ||
      page.path !== step.path ||
      !page.targets.some((state) => state === "unique") ||
      (run.recipe.handlers ?? []).some(
        (handler) => handler.kind === "passkey" && handler.path === page.path,
      )
    )
      return false;
    return judgeStop(run, page.path, stopped, end);
  }
  /**
   * Sends the page at a login's stop, which still shows the stop step's password field, to be
   * judged once per attempt (`STOP_JUDGING`, recorded before the request), within the
   * judge's limits on the service (ADR 0036, owner 2026-10-13 05:39 UTC). The service keeps
   * only a `passkey` handler from it; the login takes the revision over and enters it
   * before the stop. Any other answer leaves the login to end at its stop. Returns whether
   * the caller leaves the login as it is.
   */
  async function judgeStop(
    run: Execution,
    path: string,
    stopped: () => boolean,
    end: () => Promise<void>,
  ): Promise<boolean> {
    if (!generation) return false;
    const notSent = (reason: string) => {
      report(run.live.document, {
        type: "judge",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: run.recipe.id,
        recipeRevision: run.recipe.revision,
        route: run.metadata.route,
        verdict: "not-sent",
        reason,
        stop: "password",
      });
      return false;
    };
    // The service judges no stop's page of a chooser (ADR 0028), so a chooser login's stop
    // presses only a handler its branch already holds (ADR 0036, account lists).
    if (run.metadata.chooser) return notSent("chooser");
    const judging: LoginAttemptEvent = { type: "STOP_JUDGING" };
    if (run.metadata.stopJudged) return notSent("stop-judged");
    if (transitionLoginAttempt(run.metadata, judging).stopJudged !== true) return false;
    const described = await describeForJudge(run, path);
    if (!described) return true;
    if ("unsent" in described) return notSent(described.unsent);
    if (!stopped()) return false;
    const { observation, disabledLeftOut, usernameShape: shape } = described;
    await change(run, judging);
    if (!current(run)) return true;
    if (!stopped() || run.metadata.stopJudged !== true) return false;
    // The account's slots go with the page, as for every judged page (owner 2026-10-23).
    const judged = await judgeSlots(
      run.live.document.origin,
      run.metadata.account,
      run.metadata.route,
      { usernameShape: shape },
    );
    if (!current(run)) return true;
    if (!stopped()) return false;
    const { recipe } = run;
    // The answer's timing, once it came (ADR 0019).
    let timed: { timing?: ServiceTiming } = {};
    const reportJudge = (
      verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
      detail: { reason?: string; takenOver?: boolean } = {},
    ) =>
      report(run.live.document, {
        type: "judge",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        route: "password",
        verdict,
        ...detail,
        ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
        stop: "password",
        ...timed,
      });
    const spin = spinning(run.live.document.tabId);
    const asked = Date.now();
    const {
      verdict,
      reason,
      recipe: added,
      timing,
    } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        "password",
        observation,
        spin.sent(() => reportJudge("sent")),
        branchOf(run.metadata),
        disabledLeftOut ? true : undefined,
        true,
        judged.slots,
      )
      .finally(spin.stop);
    spend(run.metadata.id, Date.now() - asked, timing);
    if (timing) timed = { timing };
    let reported = false;
    // Only a `passkey` handler is entered from the answer, at the stop.
    const movedOn =
      verdict === "challenge" &&
      added !== undefined &&
      stopped() &&
      (await takeOver(
        run,
        added,
        path,
        () => {
          reported = true;
          reportJudge(verdict, { takenOver: true });
        },
        { end },
      ));
    if (!reported)
      reportJudge(verdict, {
        ...(reason ? { reason } : {}),
        ...(added ? { takenOver: false } : {}),
      });
    return movedOn || !current(run);
  }
  /**
   * The `passkey` route that answers its page's own request goes back to the password
   * variant the login recorded (ADR 0034), or ends `challenge` without one or with a stop
   * before the item's missing password (ADR 0036). It never answers again.
   */
  async function fallBack(
    run: Execution,
    cause: Exclude<RouteChange, "page-request">,
  ): Promise<void> {
    if (!current(run) || terminal(run.metadata)) return;
    run.passkeyFailed = true;
    const { variant } = run.metadata;
    const steps =
      variant === undefined ? 0 : routeSteps(run.recipe, { route: "password", variant }).length;
    // A login whose item lacks a password never goes back to its variant's stop (ADR 0036).
    if (variant === undefined || !steps || run.metadata.stopAt !== undefined) {
      await change(run, { type: "OBSERVED", result: "challenge", document: run.live.document });
      return;
    }
    await change(run, { type: "ROUTE", route: "password", steps }, undefined, undefined, cause);
    if (!current(run) || run.metadata.route !== "password") return;
    // The account choice saved after the sign-in names the password variant's binding, also
    // when only that binding is unsaved or widened (ADR 0027, amended 2026-10-19), as for a
    // saved default whose passkey plan saved nothing. A pick for this login only stays
    // unsaved, since the plan still sees the pick.
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!current(run) || !snapshot.ok) return;
    const plan = await planFor(snapshot, run.live, run.recipe, {
      route: { route: "password", variant },
    });
    if (
      current(run) &&
      plan.ok &&
      plan.choice &&
      plan.account.connectionId === run.metadata.account.connectionId &&
      plan.account.itemId === run.metadata.account.itemId
    )
      run.choice = plan.choice;
  }
  /**
   * The site count's way to the vault (ADR 0021): the same vault-replacement hold an
   * admission takes, and each crypto job run only while no login runs and no page is being
   * admitted, checked again before each job.
   */
  const siteCount = {
    hold: async (): Promise<() => void> => (await options.vault?.enter(false)) ?? (() => undefined),
    async step<T>(job: () => Promise<T>): Promise<{ value: T } | undefined> {
      if (admitting.size > 0 || (await active()) || admitting.size > 0) return undefined;
      const run = job();
      counting = run;
      try {
        return { value: await run };
      } finally {
        if (counting === run) counting = undefined;
      }
    },
  };
  return {
    handle,
    settingsChanged,
    siteCount,
    /** A site default was saved outside the settings page, as by the passkey chooser. */
    siteDefaultSaved: () => void choiceDefaults(),
    active,
    loginAccount,
    passkeyReverification,
    passkeyRequested,
    passkeyAnswered,
    conditionalRequest,
    /**
     * Whether a passkey request of the origin treats the saved default as unset (ADR 0063):
     * `paused` while automatic login of its site is paused in the window kind of its tab
     * (ADR 0062), else true when Pateat logged in to its site twice in 10 minutes (the
     * relogin guard) or its site asks every time after a pick that did not make its account
     * the default. Automatic login being off in private windows does not count: the person's
     * own request there is answered as in any window (ADR 0062 E).
     */
    defaultUnset: async (
      pageOrigin: string,
      incognito: boolean,
      /**
       * The settings as the caller already read them, such as the passkey runtime's copy
       * read ahead of requests, so the request need not wait for the settings store.
       */
      readAhead?: Pick<
        LocalSettings,
        | "excludedSites"
        | "allowedSites"
        | "allowedSitesEnabled"
        | "loginInPrivateWindows"
        | "siteDefaults"
      >,
    ): Promise<boolean | "paused"> => {
      // Read at once, so a passkey request waits for the slowest read only.
      const [pausedBy, limited, asking] = await Promise.all([
        pauseOf(
          { url: pageOrigin, incognito },
          {
            private: false,
            ...(readAhead
              ? {
                  policy: {
                    excludedSites: readAhead.excludedSites,
                    ...allowlistOf(readAhead),
                    ...(readAhead.loginInPrivateWindows ? { loginInPrivateWindows: true } : {}),
                  },
                }
              : {}),
          },
        ),
        sessionLoaded.then(() => reloginLimited(pageOrigin, incognito)),
        asksEveryTime(pageOrigin, incognito, undefined, readAhead?.siteDefaults),
      ]);
      if (pausedBy !== undefined) return "paused";
      return limited || asking;
    },
    /** A tab's page changed: a page of a paused site shows `II` on its badge (ADR 0062). */
    tabLoaded: (tab: Browser.tabs.Tab) => showTabPause(tab).catch(() => undefined),
  };
}
