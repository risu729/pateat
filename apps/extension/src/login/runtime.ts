import * as v from "valibot";
import {
  attemptPlan,
  attemptRouteChoice,
  attemptUsesCode,
  builtInLoginSlots,
  chooseLoginRoute,
  continuesRecipe,
  createAttemptMetadata,
  defaultLoginBinding,
  effectfulStep,
  extendsRecipe,
  findLoginBinding,
  getItemEligibility,
  handlerFact,
  handlerSlots,
  handlerSteps,
  handlerTargets,
  isSiteExcluded,
  loginFieldFacts,
  loginFieldSource,
  pagesLeft,
  loginDocumentSchema,
  loginDisplayNames,
  loginObservationSchema,
  isEntryObservation,
  nextLoginOperation,
  loginStepEffect,
  parseAttemptMetadata,
  passkeyAnswersRequest,
  passwordStopOrMiss,
  passwordVariants,
  recipeHasRoute,
  recipeStartSteps,
  recoverLoginAttempt,
  resolveBindingFields,
  resolveLoginPlan,
  routeFillTargets,
  routeSignInPaths,
  routeSignInTargets,
  routeSlots,
  routeSteps,
  sameLoginDocument,
  sameLoginTarget,
  saveLoginChoice,
  siteDefaultConnection,
  templateLoginBinding,
  TOTP_HANDLER_SLOT,
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
  chooserClickBranch,
  chooserRoute,
  type ChooserBranch,
  type ChooserClick,
  type ListClick,
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
  type RecipeGenerationRequest,
  type SavedLoginBinding,
  type SemanticSlot,
  type SettingsResponse,
  type SettingsSnapshot,
  type ValueShape,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { browser, type Browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { trustedRecord } from "../storage";
import { createLoginBadge, memoryBadgeStorage, setActionBadge, type LoginBadge } from "./badge";
import { domainKey } from "@pateat/bitwarden";
import {
  authorizeSchema,
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
  logoutClickedSchema,
  chooseResultSchema,
  type ListMissReport as ListMiss,
  probeControlSchema,
  loginReadiness,
  HELD_CLICK_WAIT_MS,
  LOGIN_STEP_WAIT_MS,
  START_TRIES,
  START_TRY_WINDOW_MS,
  type ExecutionDetail,
  type InPlaceNext,
  type LoginReadiness,
  type TargetRequirement,
  type TargetState,
  type LoginSecretKind,
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
import { findLiveSiteCandidates, type LiveUriMatcher } from "../vault/site-candidates";
import {
  choiceRequestSchema,
  logoutReasonSchema,
  pickRequestSchema,
  statusRequestSchema,
  type ChoiceResponse,
  type LogoutReason,
  type PickResponse,
  type StatusResponse,
} from "./choice-wire";
import { customFieldOffers, type CustomFieldOffer } from "./generation-slots";
import { emailUsername, namesUsername, type EntryMiss, type OtherMiss } from "../page/account-list";
import { observedPath } from "../observation/path";
import { senderDocumentOrigin } from "../messaging/sender";
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
import type { LoginSites } from "./sites";
import { linkRefusal, namesReturnPath, type OnSite } from "./entry";
import type { ConditionalDecision, PasskeyItem } from "../passkeys/runtime";
import { passkeyScriptsRun } from "../passkeys/rp-id";
import {
  loginFillsUsername,
  loginSecretKind,
  loginUsernameFieldId,
  type LoginFieldSource,
} from "./vault";
import { newId } from "@pateat/contracts/ids";
import { loginMoveFits } from "@pateat/contracts/site";
import { isoTime, isoTimeMs, isoTimeSchema } from "../time";

const STORAGE_KEY = "pateat.login-attempts.v4";
/** Accounts picked in the toolbar popup, per tab; session storage survives a worker restart. */
const PICKS_KEY = "session:pateat.login-picks.v1";
const CHOICES_KEY = "session:pateat.login-choices.v1";
const LOGOUTS_KEY = "session:pateat.login-logouts.v1";
/** Documents filled once after a logout, as `${tabId} ${documentId}` (ADR 0021 D). */
const LOGOUT_FILLS_KEY = "session:pateat.login-logout-fills.v1";
/**
 * Tabs whose login of an origin stopped after a submission and whose login form then
 * showed again on a later page; they ask like a logout, in that tab only (ADR 0021 D).
 */
const STOPPED_ASKS_KEY = "session:pateat.login-stopped-asks.v1";
/**
 * Tabs that ask like a logout because the site rejected their login of an origin; the
 * asking is the same, only its wording names the rejection (ADR 0021 D).
 */
const REJECTED_ASKS_KEY = "session:pateat.login-rejected-asks.v1";
/**
 * Refusal reasons already logged, by tab, document and path, so a page that announces
 * again after a worker restart does not log the same reason as news (ADR 0019).
 */
const NOTED_KEY = "session:pateat.login-noted.v1";
/**
 * Logout clicks per tab and site whose first step has not shown yet (ADR 0021 D, owner
 * 2026-10-16): when it does, the tab asks as after its own login.
 */
const LOGOUT_CLICKS_KEY = "session:pateat.login-logout-clicks.v1";
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
/** Readings of that move's new page, a second apart, before it must have loaded quietly. */
const SITE_MOVE_READINGS = 5;
/**
 * How long a login stays watched after its result stopped at `challenge` or settled as
 * unknown (ADR 0027, owner's choice on 2026-10-12), and how long each new page of its tab
 * is checked for a signed-in marker before its sign-in state is read, as after a click.
 */
const WATCH_MS = 10 * 60_000;
/** How long a logout click waits for the site's first step in its tab, as a watch does. */
const LOGOUT_CLICK_MS = WATCH_MS;
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
});
type EntryPress = v.InferOutput<typeof entryPressSchema>;
/**
 * A control that logs out, clicked in a tab on a registrable site (ADR 0021 D); `used`
 * once the site's first step showed and the tab took it as its logout.
 */
const logoutClickSchema = v.strictObject({
  tabId: tabIdSchema,
  site: v.string(),
  clickedAt: isoTimeSchema,
  used: v.optional(v.literal(true)),
});
type LogoutClick = v.InferOutput<typeof logoutClickSchema>;
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
/** Whether a URL is on the site of `page` (its registrable domain). */
const sameSiteAs =
  (page: string): OnSite =>
  (url) => {
    const site = siteOf(page);
    return site !== undefined && siteOf(url) === site;
  };
/**
 * How long a page's own conditional passkey request waits for a login of its document to
 * start before it is handed on (ADR 0034).
 */
const REQUEST_START_WAIT_MS = 3000;
/**
 * Longest a conditional request waits for its login to end, or for a pick after a logout;
 * it is then withheld, so a login that runs that long never meets another provider's prompt
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
  state?: string;
  reason?: string;
  /** A provider URI match for this document only, valid while its snapshot is unchanged. */
  uriMatch?: { connectionId: string; itemId: string; snapshotId: string };
  /** A single-match account choice, valid while every connection's snapshot is unchanged. */
  autoChoice?: { snapshots: string; connectionId: string; itemId: string };
  /** A provider URI match for `topUrl`, valid while its snapshot is unchanged. */
  topMatch?: { connectionId: string; itemId: string; snapshotId: string };
  /** Why generation last skipped this document, so each reason is logged once. */
  generationSkip?: string;
  /** Why this document's sign-in input last did not start a login, logged once. */
  notStarted?: string;
  /**
   * When this worker first saw the document. Only a page first seen after another tab's
   * login began to be watched ends that login (ADR 0027).
   */
  seenAt: number;
  /** Why this document's sign-in entry was not pressed, each reason logged once at info. */
  entryRefusals?: string[];
  /**
   * Why the last check of this page, the new top page of a login's move to another origin
   * (ADR 0022), did not find the sign-in complete, for the log.
   */
  moveMiss?: MoveMiss;
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
  !(entry.state === "blocked" && entry.outcome === "interrupted" && !entry.submissions) &&
  !stoppedByPateat(entry) &&
  // A clock set back ends the hold rather than prolonging it.
  now - (entry.changedAt ?? 0) >= 0 &&
  now - (entry.changedAt ?? 0) < HOLD_MS;
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
});
type PickedAccount = v.InferOutput<typeof pickedAccountSchema>;
/**
 * A document refused because several accounts match it, or because its tab logged out
 * of the site (`logout`, ADR 0021 D); the popup offers these candidates.
 */
const pendingChoiceSchema = v.strictObject({
  document: loginDocumentSchema,
  candidates: v.array(v.strictObject({ connectionId: v.string(), itemId: v.string() })),
  logout: v.optional(logoutReasonSchema),
});
/** A tab and origin that logged out after a Pateat login; it asks until a pick logs in. */
const logoutSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
});
/**
 * A login that ended with a result, or that ended when the tab left its origin (ADR 0022);
 * its first step showing again in the tab's page means a logout (ADR 0021 D). A switch,
 * a stop, or a result still being reconciled does not.
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
  /** A chooser login's recipe (ADR 0028), whose list its first step clicks on. */
  chooser?: LoginChooserRecipe;
  /** A fill-only login's accounts, offered once it ends (ADR 0021 D). */
  asked?: PendingChoice["candidates"];
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
  since: number;
  /** The login of its document was seen running, so its end decides the request. */
  during?: true;
  /**
   * Its document was asked for an account after a logout (ADR 0021 D), so it waits for
   * the pick while the tab asks.
   */
  asked?: true;
  /**
   * Its document was offered a popup choice outside a logout in which an item holds a
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
 * A popup choice offered to a tab's top document outside a logout, on a recipe without a
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
export type LoginRecipeStart = { path: string; steps: LoginStep[]; list?: LoginTarget[] };
/**
 * Cached recipes. Account bindings come from synced settings (`settings.bindings`,
 * ADR 0013); neither carries values.
 */
export interface LoginRecipes {
  /** The recipe for a document, or an attempt's own recipe by ID after navigation. */
  recipe(origin: string, path: string, recipeId?: string): Promise<LoginRecipe | undefined>;
  /** Where every recipe for the origin starts; a document watches for its first steps. */
  starts(origin: string): Promise<LoginRecipeStart[]>;
  /**
   * The chooser recipe (ADR 0028) whose list shows on the path, or a chooser login's own
   * recipe by ID after navigation.
   */
  chooser?(
    origin: string,
    path: string,
    recipeId?: string,
  ): Promise<LoginChooserRecipe | undefined>;
  /** The origin's entry recipes (ADR 0031): a start path and the link pressed there. */
  entries(origin: string): Promise<LoginEntryRecipe[]>;
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
    };

/** What came of a page sent as a site's sign-in entry (ADR 0031): its entry recipe, or not. */
export type EntryGenerationOutcome =
  | { outcome: "recipe"; recipe: LoginEntryRecipe }
  | Exclude<GenerationOutcome, { outcome: "recipe" }>;

/** An outcome's fields for the local log: never the recipe itself or `retry`. */
function outcomeFields(answer: GenerationOutcome | EntryGenerationOutcome) {
  if (answer.outcome === "recipe") return { outcome: answer.outcome };
  if (!("check" in answer)) return { outcome: answer.outcome, reason: answer.reason };
  const { outcome, reason, check, detail, path } = answer;
  return {
    outcome,
    reason,
    check,
    ...(detail === undefined ? {} : { detail }),
    ...(path === undefined ? {} : { path }),
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
   * page of that chooser branch (ADR 0028).
   */
  available(
    origin: string,
    path: string,
    base?: RecipeGenerationRequest["base"],
    branch?: ChooserBranch,
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
    /** For a chooser login (ADR 0028): the branch whose route is judged. */
    branch?: ChooserBranch,
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
  ): Promise<{
    /**
     * `retry` for a temporary refusal before any model call, which gives the page back:
     * no paired service, a rejected device, an unreachable or busy service, the service's
     * own request limit, or a request that failed before the model. `unclear` covers
     * every other answer, including permanent refusals and failed model calls.
     */
    verdict: "signed-in" | "rejected" | "challenge" | "unclear" | "retry";
    /** For `retry` and `unclear`: the refusal or failure code, for the local log. */
    reason?: string;
    /** A chooser login's is the whole chooser (ADR 0028). */
    recipe?: LoginRecipe | LoginChooserRecipe;
  }>;
}

/**
 * Slot meanings sent for generation, each read from the vault item's built-in field of
 * the same name by `defaultLoginBinding`.
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
  entry: { connectionId: string; item: VaultItemMetadata },
  fieldId: string,
): boolean {
  const field = entry.item.fields.find((candidate) => candidate.id === fieldId);
  if (!field) return false;
  if (fieldId !== "login.password") return true;
  return (
    field.empty !== true &&
    !settings.connections.some(
      (connection) =>
        connection.connectionId === entry.connectionId &&
        connection.excludedFields.some(
          (ref) => ref.itemId === entry.item.id && ref.fieldId === fieldId,
        ),
    )
  );
}
/**
 * The field a `totp` handler fills for the login's item (ADR 0027): its built-in TOTP
 * field, or the synthetic probe item's `totp` field. Undefined when the item has none, or
 * when the item's saved binding for the recipe names another field for `totp`: Pateat
 * cannot make a code from a custom field yet, so it never types such a field's raw value,
 * which could be a TOTP seed.
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
    userId: connection.userId,
    itemId,
  });
  if (saved?.slots.some((entry) => entry.slot === TOTP_HANDLER_SLOT && entry.field !== "totp"))
    return undefined;
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
 * counts only when that click, a submit, follows it.
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
 * Whether a TOTP code's fill (see `codeStep`) went in, or may have, and its click has not
 * run (ADR 0027): a page that moved on meanwhile submitted the code by itself.
 */
const codeAwaitsClick = (recipe: LoginRecipe, metadata: LoginAttemptMetadata) =>
  metadata.operationId === undefined
    ? codeStep(recipe, metadata, metadata.stepIndex) === "click"
    : metadata.operationKind === "fill" &&
      metadata.operationEffect === "prepare" &&
      metadata.mutationIntent === true &&
      codeStep(recipe, metadata, metadata.stepIndex) === "fill";
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
 * The recipe's signed-in markers as elements to observe (ADR 0029): each marker, which may
 * be a link located by its text (ADR 0018), then the elements it needs missing. `proves`
 * reads their states from `offset`: whether one marker shows once, visible, while each
 * element it needs missing is missing even hidden, on any path. Only the markers learned
 * on `pageOrigin` count: the recipe's own origin by default, or another origin that a
 * login's tab moved to (ADR 0022).
 */
function markerProof(recipe: LoginRecipe, pageOrigin = recipe.origin) {
  const markers = (recipe.completion ?? []).filter(
    (marker) => (marker.origin ?? recipe.origin) === pageOrigin,
  );
  return {
    targets: markers.flatMap((marker) => [marker.target, ...(marker.absent ?? [])]),
    links: markers.flatMap((marker) => [true, ...(marker.absent ?? []).map(() => false)]),
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
 * step, which keeps its own rules (ADR 0027).
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
    done.handler !== undefined ||
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
/** The order in which handlers shown together are tried: a passkey types nothing. */
const handlerOrder = { passkey: 0, totp: 1 } as const satisfies Record<
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
  /** Every enabled connection answered and every item's URI rules were evaluated. */
  complete: boolean;
};

/**
 * Coordinator is packaged production code. Production admits only `sites` documents and
 * uses `recipes`; the loopback probe adapter and its controls exist only in the probe build.
 * Account metadata comes from each live settings read; values come from `fields` per fill.
 */
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
       * it ends `account-not-listed`; `other-shown` when its path showed the `other`
       * branch's form instead, so it clicked nothing there.
       */
      click?: ChooserClick | "none";
      /** With `none`: what the list showed, without any name or address. */
      listMiss?: ListMiss;
    }
  | {
      /**
       * The recipe's first step showed again after a finished login, or after a control
       * that logs out was clicked in the tab (ADR 0021 D).
       */
      type: "logout";
      tabId: number;
      origin: string;
      /** The recipe the finished login ran; none after a click. */
      recipeId?: string;
      /** The recipe revision the login runs. */
      recipeRevision?: number;
      /** The site rejected the login; its page showing that asks at once. */
      rejected?: true;
      /** A control that logs out was clicked in the tab, with no login of its own. */
      clicked?: true;
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
       * site's sign-in entry (ADR 0031), `other` for a form shown on a chooser's path sent
       * as its `other` branch's first page (ADR 0028).
       */
      page?: "accounts" | "entry" | "other";
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

/** The badge and tooltip of a tab whose login waits for an account choice (ADR 0021). */
function choiceBadge(
  candidates: readonly unknown[],
  logout: LogoutReason | undefined,
): { count: number; title: string } {
  return {
    count: candidates.length,
    title: logout
      ? {
          "this-tab":
            "Pateat: you logged out of this site in this tab. Click to choose an account.",
          rejected:
            "Pateat: the site did not accept the last login in this tab. Click to choose an account.",
          "stopped-login":
            "Pateat: the last login on this site stopped in this tab. Click to choose an account.",
          "other-tab":
            "Pateat: you logged out of this site in another tab. Click to choose an account.",
        }[logout]
      : `Pateat: ${candidates.length} accounts match this page. Click to choose one.`,
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
    /** Receives each attempt state change, refusal and generation result. */
    report?: (report: LoginReport) => void;
    /**
     * The toolbar badge (ADR 0038): the account choice a tab waits on, a tooltip, and a
     * spin while a model request for its page is in flight, from the request's `sent` until
     * it returns; and the tab's last login and model request it read from the reports, for
     * the popup's page section. Without one the runtime writes `chrome.action` itself and
     * keeps nothing across worker restarts.
     */
    badge?: Pick<LoginBadge, "choice" | "note" | "spin" | "status" | "asking">;
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
  },
) {
  const { fields, sites, recipes = noLoginRecipes, uris, generation } = options;
  const badge =
    options.badge ?? createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() });
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
    } = {},
  ) => {
    const { stop, ...marks } = flags;
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
      ...(metadata.fillOnly ? { reason: "fill-only" } : {}),
      ...(metadata.stopAt === undefined ? {} : { stop: "password" as const }),
      ...(policy && metadata.outcome === "policy-changed" ? policy : {}),
      ...(stop ? { cause: stop } : {}),
      ...marks,
    });
  };
  let origin = DEFAULT_PROBE_ORIGIN;
  let account: ProbeAccount = DEMO_PROBE_ACCOUNT;
  let probePasskey: "discoverable" | "second-factor" | undefined;
  let probeTotp = false;
  const documents = new Map<string, LiveDocument>();
  const attempts = new Map<number, Execution>();
  // ADR 0029's sign-in state reads these, kept in memory only and never stored.
  /**
   * By tab: when the attempt last delivered an effect step, the document it ran in, whether
   * the step submits (`submit`), whether it asks for a passkey itself (the `passkey` route,
   * or a `passkey` handler's click), so S5 skips it, and the first other top document of the
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
   * By tab and origin: the last assertion the passkey bridge returned, its RP ID and the
   * vault item it was signed with.
   */
  const passkeyAnswers = new Map<
    string,
    { at: number; rpId: string; item?: { connectionId: string; itemId: string } }
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
  /** By tab: its popup choice outside a logout and whether it offers a passkey (ADR 0034). */
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
  const pending = new Map<number, PendingChoice>();
  /** By `recordKey`: tabs that logged out of an origin and have not picked an account yet. */
  const logouts = new Set<string>();
  /** Reasons already logged, by tab, document and path; stored like the logout fills. */
  const noted = new Map<string, Set<string>>();
  /** By `recordKey`: tabs that ask after their own login stopped once it submitted. */
  const stoppedAsks = new Set<string>();
  /** By `recordKey`: the `logouts` that the site's rejection of the tab's login began. */
  const rejectedAsks = new Set<string>();
  /**
   * Documents filled once after a logout, so neither a re-announcement nor a restarted
   * worker fills over what the user typed (ADR 0021 D). The oldest go first.
   */
  const logoutFills = new Set<string>();
  /** By tab: its sign-in entry press, kept until the tab closes (ADR 0031). */
  const entryPresses = new Map<number, EntryPress>();
  /**
   * By `${tabId} ${site}`: logout clicks whose first step has not shown yet (ADR 0021 D),
   * the oldest first.
   */
  const logoutClicks = new Map<string, LogoutClick>();
  /** Logout clicks being recorded; a page announcing meanwhile waits for them. */
  const clicksNoting = new Set<Promise<void>>();
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
  /** Account choices being saved; each bumps the policy revision (ADR 0022). */
  const savingChoices = new Set<Promise<void>>();
  /** Counts account choices saved or attempted, so a new login sees a bump it missed. */
  let remembered = 0;
  // Toolbar and session storage failures only lose the badge or a pick; never a login.
  const quietly = (work: () => Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then(
        () => undefined,
        () => undefined,
      );
  // Picks and waiting choices outlive a worker restart, as the tab's badge does. Every
  // change to them happens after this load.
  const sessionLoaded = quietly(async () => {
    const items = await storage.getItems([
      PICKS_KEY,
      CHOICES_KEY,
      LOGOUTS_KEY,
      LOGOUT_FILLS_KEY,
      STOPPED_ASKS_KEY,
      REJECTED_ASKS_KEY,
      ENTRY_PRESSES_KEY,
      NOTED_KEY,
      LOGOUT_CLICKS_KEY,
    ]);
    const stored = Object.fromEntries(items.map(({ key, value }) => [key, value]));
    const picks = v.safeParse(v.array(pickedAccountSchema), stored[PICKS_KEY] ?? []);
    if (picks.success) for (const entry of picks.output) picked.set(entry.tabId, entry);
    const choices = v.safeParse(v.array(pendingChoiceSchema), stored[CHOICES_KEY] ?? []);
    if (choices.success)
      for (const entry of choices.output) {
        pending.set(entry.document.tabId, entry);
        // Chrome kept the tab's badge; the badge learns the choice it shows again.
        badge.choice(entry.document.tabId, choiceBadge(entry.candidates, entry.logout));
      }
    const left = v.safeParse(v.array(logoutSchema), stored[LOGOUTS_KEY] ?? []);
    if (left.success)
      for (const entry of left.output) logouts.add(recordKey(entry.tabId, entry.origin));
    const stopped = v.safeParse(v.array(logoutSchema), stored[STOPPED_ASKS_KEY] ?? []);
    if (stopped.success)
      for (const entry of stopped.output) stoppedAsks.add(recordKey(entry.tabId, entry.origin));
    const rejected = v.safeParse(v.array(logoutSchema), stored[REJECTED_ASKS_KEY] ?? []);
    if (rejected.success)
      for (const entry of rejected.output) rejectedAsks.add(recordKey(entry.tabId, entry.origin));
    const filled = v.safeParse(
      v.pipe(v.array(v.string()), v.maxLength(256)),
      stored[LOGOUT_FILLS_KEY] ?? [],
    );
    if (filled.success) for (const entry of filled.output) logoutFills.add(entry);
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
    const clicks = v.safeParse(
      v.pipe(v.array(logoutClickSchema), v.maxLength(256)),
      stored[LOGOUT_CLICKS_KEY] ?? [],
    );
    if (clicks.success)
      for (const entry of clicks.output) logoutClicks.set(`${entry.tabId} ${entry.site}`, entry);
  });
  const scopes = (keys: Set<string>) =>
    [...keys].map((key) => {
      const at = key.indexOf(" ");
      return { tabId: Number(key.slice(0, at)), origin: key.slice(at + 1) };
    });
  async function saveSession(): Promise<void> {
    await storage.setItems([
      { key: PICKS_KEY, value: [...picked.values()] },
      { key: CHOICES_KEY, value: [...pending.values()] },
      { key: LOGOUTS_KEY, value: scopes(logouts) },
      { key: LOGOUT_FILLS_KEY, value: [...logoutFills] },
      { key: STOPPED_ASKS_KEY, value: scopes(stoppedAsks) },
      { key: REJECTED_ASKS_KEY, value: scopes(rejectedAsks) },
      { key: ENTRY_PRESSES_KEY, value: [...entryPresses.values()] },
      { key: NOTED_KEY, value: [...noted].map(([page, ids]) => [page, [...ids]]) },
      { key: LOGOUT_CLICKS_KEY, value: [...logoutClicks.values()] },
    ]);
  }
  /**
   * Why a tab asks after a logout, for the log: which tab logged out, or `rejected` when
   * the site rejected this tab's login (ADR 0021 D).
   */
  function logoutDetail(key: string): LogoutReason {
    if (logouts.has(key)) return rejectedAsks.has(key) ? "rejected" : "this-tab";
    return stoppedAsks.has(key) ? "stopped-login" : "other-tab";
  }
  /** Badges the tab and records the refused document for the popup (ADR 0021). */
  function offerChoice(
    document: LoginDocument,
    candidates: PendingChoice["candidates"],
    logout?: LogoutReason,
  ): void {
    pending.set(document.tabId, { document, candidates, ...(logout ? { logout } : {}) });
    void quietly(saveSession);
    badge.choice(document.tabId, choiceBadge(candidates, logout));
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
  /** The latest announcement of each frame while it is admitted, by the same key. */
  const admitting = new Map<string, Promise<unknown>>();
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
    sender.url === browser.runtime.getURL("/options.html") &&
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
    return persisted
      .values()
      .some(
        (entry) =>
          entry.account.origin === siteOrigin &&
          entry.document.tabId !== tabId &&
          holdsSite(entry, now),
      );
  }
  /**
   * Whether another tab's login of the origin authenticated within the last hour. A list of
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
        entry.state === "authenticated" &&
        // A clock set back ends the skip rather than prolonging it.
        age >= 0 &&
        age < SIGNED_IN_ELSEWHERE_MS
      );
    });
  }
  /** Whether another tab asks for an account after a logout of the origin (ADR 0021 D). */
  function askedElsewhere(tabId: number, siteOrigin: string): boolean {
    return [...logouts].some(
      (key) => key !== recordKey(tabId, siteOrigin) && key.endsWith(` ${siteOrigin}`),
    );
  }
  /** Whether another tab still asks after the site rejected its login (ADR 0021). */
  function rejectedElsewhere(tabId: number, siteOrigin: string): boolean {
    return [...rejectedAsks].some(
      (key) =>
        key !== recordKey(tabId, siteOrigin) && key.endsWith(` ${siteOrigin}`) && logouts.has(key),
    );
  }
  /** Tells the tab why it does not log in while another tab's login holds the site. */
  function showHeld(tabId: number): void {
    badge.note(
      tabId,
      "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait 5 minutes and reload this page, to log in here.",
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
    sender.id === browser.runtime.id && sender.url === browser.runtime.getURL("/popup.html");
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
    const held = heldElsewhere(tabId, waiting.document.origin) ? { held: true as const } : {};
    if (waiting.logout)
      return {
        ok: true,
        origin: waiting.document.origin,
        documentId: waiting.document.documentId,
        candidates: waiting.candidates,
        logout: waiting.logout,
        ...held,
        ...(waiting.logout !== "rejected" && rejectedElsewhere(tabId, waiting.document.origin)
          ? { rejectedElsewhere: true as const }
          : {}),
      };
    // A default saved since the refusal decides the page's next login instead.
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (pending.get(tabId) !== waiting) return { ok: false, reason: "no-choice" };
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
            ...(answer.logout ? { logout: answer.logout } : {}),
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
    const url = (await browser.tabs.get(tabId).catch(() => undefined))?.url ?? live?.url;
    const page = url ? (URL.parse(url) ?? undefined) : undefined;
    // The popup shows its page section only on HTTP(S) pages.
    if (page?.protocol !== "https:" && page?.protocol !== "http:")
      return { ok: false, reason: "no-page" };
    const pageOrigin = page.origin;
    const path = observedPath(page.pathname);
    const [starts, entries] = await Promise.all([
      recipes.starts(pageOrigin).catch(() => []),
      recipes.entries(pageOrigin).catch(() => []),
    ]);
    const paths = [
      ...starts.map((start) => start.path),
      ...entries.map((entry) => entry.entry.path),
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
              ...(settled ? { settled: true as const } : {}),
            },
          }
        : {}),
      ...(known?.refused ? { refused: clipCodes(known.refused) } : {}),
      ...(known?.generation ? { generation: clipCodes(known.generation) } : {}),
    };
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
      offerChoice(waiting.document, waiting.candidates, waiting.logout);
      return { ok: false, reason: "origin-busy" };
    }
    return { ok: false, reason: "not-started" };
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
    // `documentId`), a page sent to be judged or newer settings a watch took over keep the
    // time, so a tab left browsing the site after a login that did not succeed stops
    // holding it.
    const progress = (record: LoginAttemptMetadata) =>
      JSON.stringify({
        ...record,
        document: { ...record.document, documentId: undefined },
        judged: undefined,
        watch: undefined,
        policyRevision: undefined,
        changedAt: undefined,
      });
    const unchanged =
      previous?.changedAt !== undefined && (!progressed || progress(previous) === progress(next));
    // Re-inserted, so the last record of a tab is the one it wrote last.
    persisted.delete(key);
    persisted.set(key, { ...next, changedAt: unchanged ? previous.changedAt : Date.now() });
    await write();
  }
  /** Releases one tab's record for one origin after a logout (ADR 0021 D). */
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
  /**
   * Tells `options.signedIn` of an attempt that has just reached signed in: its origin, the
   * top page's origin for a frame's login, and the page it ended on.
   */
  const noteSignedIn = (
    previous: LoginAttemptMetadata,
    next: LoginAttemptMetadata,
    pageOrigin?: string,
  ) => {
    if (next.state !== "authenticated" || next.unconfirmed || previous.state === "authenticated")
      return;
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
    // Settling as unknown keeps the state, but it is how a login ends without a result.
    const settled = run.metadata.settled === true && previous.settled !== true ? true : undefined;
    // An ended login no longer waits for a continuation it asked for (ADR 0018).
    if (terminal(run.metadata) || idle(run.metadata)) continuations.delete(run.metadata.id);
    if (
      run.metadata.state !== previous.state ||
      settled ||
      (routeChange && run.metadata.route !== previous.route)
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
  }
  /**
   * Ends a fill-only login before its first step with an effect and forgets its record, so
   * it neither holds the site nor counts as a login of the tab. The document announces again
   * on this status and asks for an account, as after a logout (ADR 0021 D).
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
    // The page then waits for a pick, as after a logout; its own announcement after this
    // status carries no start, so the choice is offered and the asking logged here.
    if (run.asked?.length) {
      offerChoice(document, run.asked, logoutDetail(recordKey(document.tabId, document.origin)));
      run.live.state = "denied";
      run.live.reason = "logged-out";
      report(document, {
        type: "refused",
        tabId: document.tabId,
        origin: document.origin,
        reason: "logged-out",
        detail: logoutDetail(key),
        ...(document.frameId === 0 ? {} : { frame: true as const }),
      });
    }
    await publish(run.live, run.metadata);
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
    // Saving bumps the revision every attempt checks; never stop another login with it.
    if (attempts.values().some((other) => other !== run && inProgress(other))) {
      outcome("login-in-progress");
      return;
    }
    // A login another tab is admitting waits for this save, which no in-progress check above
    // can see yet (see `admit`).
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
        .update(run.metadata.policyRevision, (snapshot) => ({
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
    /** After a logout: fill the page without any step with an effect (ADR 0021 D). */
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
    logout?: true;
    noUriMatch?: true;
  };
  /**
   * The account for this document. A saved site default wins. Without one, a single
   * eligible provider URI match across all enabled connections is used for this attempt
   * only (ADR 0013); none, several, or any connection or item that could not be evaluated
   * refuses rather than guessing.
   */
  async function choose(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    asking = false,
    fill = false,
  ): Promise<Choice | Refusal> {
    // An account picked in the popup wins for the document it restarted and the attempt that
    // document started; its item must still match the page and pass every check below.
    await sessionLoaded;
    const pick = picked.get(live.document.tabId);
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
        source: "pick",
        pick,
      };
    const saved = snapshot.snapshot.settings.siteDefaults.find(
      (entry) => entry.origin === live.document.origin,
    );
    if (asking) {
      // After a logout the tab asks, with the saved default first (ADR 0021 D).
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
      // without any click or submitting fill; the tab still asks (ADR 0021 D).
      // A saved default that cannot be used fills nothing, as it would refuse a login.
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
      return { reason: "logged-out", candidates: listed.slice(0, 100), logout: true };
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
   * Origin scope for the chosen account of this document. A live provider URI match for
   * the document's own URL satisfies the item origin check for that document only; it is
   * never saved as `allowedOrigins`. Only the chosen account's connection is asked, and a
   * match is reused while that connection's snapshot is unchanged.
   */
  async function liveScope(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    selected: { connectionId: string; itemId: string },
  ): Promise<{ catalog: VaultCatalog } | { reason: "vault-unavailable" | "item-uri-unevaluated" }> {
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
        catalog: { connections: [connection] },
        url: live.url,
        match: uris,
      });
      if (!scope.ok) return { catalog };
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
    const top = new URL(live.topUrl).origin;
    if (isSiteExcluded(snapshot.snapshot.settings, top)) return { reason: "site-excluded" };
    const item = granted.connections
      .find((entry) => entry.id === selected.connectionId)
      ?.items.find((entry) => entry.id === selected.itemId);
    if (item?.allowedOrigins.includes(top)) return undefined;
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === selected.connectionId,
    );
    if (!uris || !connection?.snapshotId || connection.provider !== "bitwarden")
      return { reason: "frame-top-mismatch" };
    const cached = live.topMatch;
    if (
      cached?.connectionId === selected.connectionId &&
      cached.itemId === selected.itemId &&
      cached.snapshotId === connection.snapshotId
    )
      return undefined;
    delete live.topMatch;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: { connections: [connection] },
      url: live.topUrl,
      match: uris,
    });
    if (!scope.ok) return { reason: scope.reason };
    if (
      scope.candidates.some(
        (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
      )
    ) {
      live.topMatch = {
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        snapshotId: connection.snapshotId,
      };
      return undefined;
    }
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.some((entry) => entry.itemId === selected.itemId))
      return { reason: "item-uri-unevaluated" };
    return { reason: "frame-top-mismatch" };
  }
  /**
   * The chosen item's binding for one route's `slots` (ADR 0027): the synced binding, else
   * the automatic one for built-in slots, else one built from a template: another item's
   * saved binding of the recipe, then the slot map of a recipe generated from this device.
   * A synced binding is never bypassed: it must hold every one of `slots` itself, and its
   * entries for other slots are ignored. It is mapped to this device's field IDs by the
   * catalog's raw field names.
   */
  async function bindingFor(
    catalog: VaultCatalog,
    settingsValue: SettingsSnapshot["settings"],
    recipe: LoginRecipe,
    choice: Choice,
    documentOrigin: string,
    slots: readonly string[],
    slotMap: () => Promise<LoginBindingTemplate | undefined>,
  ): Promise<
    | { ok: true; binding: LoginAccountBinding; synced: SavedLoginBinding; saved: boolean }
    | { ok: false; reason: string }
  > {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return { ok: false, reason: "vault-unavailable" };
    const owner = { provider: connection.provider, userId: connection.userId, itemId: item.id };
    const named = { ...owner, itemName: item.label, accountName: connection.label };
    const fieldNames = item.fields.map((field) => ({ id: field.id, name: field.name }));
    const saved = findLoginBinding(settingsValue.bindings, recipe, owner);
    let binding = saved ?? defaultLoginBinding(slots, recipe, named);
    if (!binding) {
      // Sibling bindings were proven by an authenticated login, so they go first.
      const templates: LoginBindingTemplate[] = settingsValue.bindings
        .filter((entry) => entry.recipeId === recipe.id && entry.origin === recipe.origin)
        .map((entry) => entry.slots);
      const generated = await slotMap();
      if (generated) templates.push(generated);
      const built = templateLoginBinding(slots, recipe, named, templates, fieldNames);
      if (!built.ok) return { ok: false, reason: built.reason };
      binding = built.binding;
    }
    const resolved = resolveBindingFields(binding, slots, fieldNames);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return {
      ok: true,
      binding: {
        origin: documentOrigin,
        connectionId: connection.id,
        itemId: item.id,
        slots: resolved.slots,
      },
      // A default saved from a stored binding is named after this device's connection
      // too; the stored binding itself is never rewritten.
      synced: saved ? { ...saved, accountName: connection.label } : binding,
      saved: saved !== undefined,
    };
  }
  /**
   * The item's facts for a new login (ADR 0027): its password and TOTP fields from the
   * catalog's value-free flags and the account's allowed fields, and its passkeys from one
   * vault search. Read once per login; never sent anywhere.
   */
  async function itemFacts(
    connection: VaultConnectionMetadata,
    owner: { origin: string; connectionId: string; itemId: string; fieldIds: string[] },
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
      asking?: boolean;
      /** While asking after a logout, the single account to use may fill the page. */
      fill?: boolean;
      route?: LoginRouteChoice;
      /** Slots of the handlers a running login entered; `totp` reads the built-in field. */
      handlerSlots?: readonly string[];
      /** The document asked for a passkey by itself, with conditional mediation (ADR 0034). */
      pageRequest?: boolean;
    } = {},
  ) {
    let catalog: VaultCatalog;
    let chosen: Choice | undefined;
    let savedDefault = false;
    if (probeMode && recipe.origin === origin) {
      // A page already filled after a logout asks, as `choose` answers it (ADR 0021 D); a
      // page to fill after a logout still logs in fully here, without production's fill-only.
      if (request.asking && !request.fill)
        return { ok: false as const, reason: "logged-out" as const, logout: true as const };
      catalog = grantProbeOrigin(snapshot.catalog, origin, account);
      const top = await topScope(snapshot, live, account, catalog);
      if (top) return { ok: false as const, reason: top.reason };
    } else {
      const found = await choose(snapshot, live, request.asking === true, request.fill === true);
      if ("reason" in found)
        return {
          ok: false as const,
          reason: found.reason,
          ...(found.candidates ? { candidates: found.candidates } : {}),
          ...(found.logout ? { logout: true as const } : {}),
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
    /** The plan for one route, or why it does not resolve. */
    const resolveRoute = async (route: LoginRouteChoice) => {
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
            userId: named.userId,
            itemId: named.itemId,
            itemName: named.itemName,
            ...(named.accountName ? { accountName: named.accountName } : {}),
          });
        }
        // A pick made for this login only is never saved.
        if (unsaved && (!chosen.pick || chosen.pick.makeDefault))
          choice = {
            binding: named,
            connectionId: chosen.connectionId,
            // An account found to become the default replaces another saved one.
            ...(chosen.pick?.makeDefault ? { replace: true } : {}),
          };
      }
      // An entered `totp` handler reads the item's built-in TOTP field (ADR 0027), for this
      // login only: the binding saved after it authenticates covers the route's slots.
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
    const factsOf = (resolved: Extract<Awaited<ReturnType<typeof resolveRoute>>, { ok: true }>) =>
      itemFacts(resolved.connection, { ...resolved.account, origin: live.document.origin });
    const pageRequest =
      request.pageRequest === true && !chosen?.fillOnly && passkeyAnswersRequest(recipe);
    // Only a page the passkey scripts run on can answer a passkey request (ADR 0050).
    if (
      passkeyScriptsRun(live.document.origin, probeMode) &&
      (recipeHasRoute(recipe, "passkey") || pageRequest)
    ) {
      const resolved = await resolveRoute({ route: "passkey" });
      if (resolved.ok) {
        facts = await factsOf(resolved);
        // No binding matters on this route, so a password variant that does not fit never
        // refuses such a login.
        if (chooseLoginRoute(recipe, facts, [], pageRequest)?.route === "passkey") {
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
    return passwordPlan();
    /** The first password variant that fits, or why none does. */
    async function passwordPlan() {
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
        return passwordField && ("stop" in result || result.miss === "no-password-step")
          ? { miss: "password-field" as const }
          : result;
      };
      // Variants are tried in recipe order and the first that fits stops the search, so the
      // facts and the generated map are read once.
      /* eslint-disable no-await-in-loop */
      for (const [index, route] of routes.entries()) {
        const resolved = await resolveRoute(route);
        if (!resolved.ok) {
          if (!variantRefusals.has(resolved.reason)) return resolved;
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
        const taken = chooseLoginRoute(recipe, known, fits);
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
      return routes.length === 1
        ? { ok: false as const, reason: first, ...(detail && detail !== first ? { detail } : {}) }
        : { ok: false as const, reason: "no-route" as const, ...(detail ? { detail } : {}) };
    }
  }
  type Authorized = {
    connection: VaultConnectionMetadata;
    binding: LoginAccountBinding;
    /** The account's allowed field IDs and the synced bindings it was authorized with. */
    fieldIds: string[];
    bindings: SavedLoginBinding[];
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
    };
  }
  async function observe(
    run: Execution,
    targets: LoginMarkerTarget[],
    require?: TargetRequirement[],
    links?: boolean[],
    signIn = false,
  ) {
    // Exclusion/default/policy checks precede even metadata observation.
    if (!(await allowed(run))) return undefined;
    const response = await send(run.live, {
      type: "login.observe",
      path: run.live.path,
      targets,
      ...(require ? { require } : {}),
      ...(links ? { links } : {}),
      ...(signIn ? { signIn: true } : {}),
    });
    if (!current(run)) return undefined;
    const parsed = v.safeParse(observationSchema, response);
    return parsed.success ? parsed.output : undefined;
  }
  /**
   * Asks the document to wait for a step's elements. A document that went away or was
   * cancelled leaves the attempt as it is; its replacement document resumes it.
   */
  async function waitFor(
    run: Execution,
    readiness: LoginReadiness,
    timeoutMs = LOGIN_STEP_WAIT_MS,
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
      proof.links.length > 0 ? proof.links : undefined,
    );
    if (!observed) return undefined;
    // Without a marker only the sign-in state below proves a sign-in.
    if (proof.proves(observed.targets)) {
      await change(run, { type: "OBSERVED", result: "authenticated", document: run.live.document });
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
      // After answering the page's own request, the start page's sign-in form still
      // showing on its path means the site has not signed in: it may still be exchanging
      // the assertion in this document for a while, then the login falls back to its
      // password variant (ADR 0034).
      if (inFlight && routeClick && passkeyAnswersRequest(run.recipe)) {
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
      } else if (inFlight && (run.heldClick === run.metadata.stepIndex || routeClick)) {
        const clicked = await observe(run, stepTargets(inFlight.step));
        if (!clicked) return undefined;
        if (clicked.targets.some((state) => state !== "missing")) {
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
      if (await enterHandler(run, observed.path)) return undefined;
      // The page after the final advance before a stop just past the plan's last step that
      // asks for a passkey takes the login to that stop at once (ADR 0036).
      if (advancingToStop(run.metadata) && asksPasskey(run) && (await toStop(run)))
        return undefined;
      continued = await continueOn(run);
      if (continued === "moved") return undefined;
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
    const state = effectful(run.metadata) ? await signInState(run) : undefined;
    if (!current(run) || terminal(run.metadata)) return undefined;
    // Evidence of a sign-in completes the login without a model call, and a failure shown
    // next to the sign-in fields rejects it (ADR 0029).
    if (state?.confirmed && (state.decision === "signed-in" || state.decision === "rejected")) {
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
    await change(
      run,
      { type: "OBSERVED", result, document: run.live.document },
      undefined,
      result === "unknown" && (state?.decision === "unknown" || state?.decision === "rejected")
        ? "sign-in-shown"
        : undefined,
    );
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
   * after a logout: the tab asks for an account instead of watching, and the page that
   * showed the form is never filled again (ADR 0021 D, amended 2026-10-13). Nothing is
   * submitted again by itself. Its page is asked to announce again, so it asks once a
   * recipe's first step is ready there, or may be sent for a recipe like any sign-in page.
   */
  async function askAgain(run: Execution): Promise<void> {
    if (!current(run) || run.live.document.frameId !== 0) return;
    const { metadata } = run;
    const { document } = run.live;
    const { tabId } = document;
    const key = recordKey(tabId, document.origin);
    if (persisted.get(key)?.id !== metadata.id) return;
    const page = `${tabId} ${document.documentId}`;
    const asked = { logout: logouts.has(key), rejected: rejectedAsks.has(key) };
    const unfilled = !logoutFills.has(page);
    logouts.add(key);
    rejectedAsks.add(key);
    if (unfilled) {
      logoutFills.add(page);
      for (const old of logoutFills) {
        if (logoutFills.size <= 256) break;
        logoutFills.delete(old);
      }
    }
    try {
      await saveSession();
    } catch {
      // The login stays watched, as before.
      if (!asked.logout) logouts.delete(key);
      if (!asked.rejected) rejectedAsks.delete(key);
      if (unfilled) logoutFills.delete(page);
      return;
    }
    if (!current(run) || persisted.get(key)?.id !== metadata.id) {
      // The page went meanwhile: the login stays as it was, and so does the tab.
      if (!asked.logout) logouts.delete(key);
      if (!asked.rejected) rejectedAsks.delete(key);
      if (unfilled) logoutFills.delete(page);
      await quietly(saveSession);
      return;
    }
    attempts.delete(tabId);
    if (picked.get(tabId)?.attemptId === metadata.id) {
      picked.delete(tabId);
      void quietly(saveSession);
    }
    report(document, {
      type: "logout",
      tabId,
      origin: document.origin,
      recipeId: metadata.recipeId,
      recipeRevision: metadata.recipeRevision,
      rejected: true,
    });
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
   * reading, a second apart, agrees in the fully loaded document. On the passkey route,
   * where anything the route's checks do not prove ends `challenge`, the reading is not
   * read again and never confirmed, so it is logged only. A login in a frame is not read,
   * as the ADR reads the top document.
   */
  async function signInState(run: Execution): Promise<SignInReading | undefined> {
    let reading = await readSignInState(run);
    let confirmed = false;
    // A decision counts once a later reading agrees in a fully loaded document, so a page
    // that is still redirecting or about to ask for a second factor is not settled; a
    // document still loading is read again, a second apart, up to `SIGN_IN_RECHECKS` times.
    // `unknown` changes nothing and is not read again, unless it is the sign-in form shown
    // again with nothing else, on which the tab asks again (ADR 0021 D). Each reading
    // depends on the time passed since the last, so they run one after another.
    /* eslint-disable no-await-in-loop */
    if (run.metadata.route !== "passkey")
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
    });
    return {
      decision: reading.decision,
      confirmed,
      ...(reading.signs.reshown ? { reshown: true as const } : {}),
      ...(formAgain(reading.signs) ? { formAgain: true as const } : {}),
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
  async function readSignInState(run: Execution): Promise<
    | {
        signs: SignInSigns;
        decision: SignInDecision;
        loaded: boolean;
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
        ? await observe(run, proof.targets, proof.shown, proof.links)
        : undefined;
    if (proof.targets.length > 0 && !marked) return undefined;
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
    const signInUrl = signInUrls.get(tabId);
    const signs: SignInSigns = {
      s1,
      s2: page.password,
      s3: page.code,
      s4: page.captcha,
      s5:
        effect?.attemptId === metadata.id &&
        !effect.passkey &&
        requested !== undefined &&
        requested >= effect.at,
      // A failure counts only next to the sign-in fields.
      f1: s1 && page.invalid,
      f2: s1 && page.alert,
      e1: marked !== undefined && proof.proves(marked.targets),
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
    return { signs, decision: decideSignInState(signs), loaded: parsed.output.loaded, misses };
  }
  /**
   * Enters a handler of the recipe on this path all of whose elements show (ADR 0027).
   * Several shown: the first not yet entered whose fact the item has, a `passkey` handler
   * before a `totp` handler, as the routes put the passkey first and it types nothing. A
   * `totp` handler is never entered by a login that already types a code, and needs the
   * item's built-in TOTP field. Returns whether the attempt moved on: to the handler's
   * steps, or to `challenge` when no shown handler qualifies or the attempt's budget has
   * no room for it. At a login's stop before its item's missing password (`stop`, ADR
   * 0036), only a `passkey` handler is entered, before the stop step, and the login ends
   * there with `stop.end` instead.
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
    // whenever its elements are there, hidden or disabled, so it never runs twice.
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
    const passwordAhead =
      typesPassword &&
      (attemptPlan(run.recipe, run.metadata) ?? []).some(
        (entry, index) =>
          index >= unrun &&
          entry.handler === undefined &&
          entry.step.kind === "fill" &&
          entry.step.path === path &&
          entry.step.fields.some((field) => field.slot === "password"),
      );
    const entries = (run.recipe.handlers ?? []).flatMap((handler, index) => {
      if (
        handler.path !== path ||
        (stop && handler.kind !== "passkey") ||
        (passwordAhead && handler.kind === "passkey")
      )
        return [];
      const ran = run.metadata.handlers.some((entered) => entered.index === index);
      const sameForm =
        !ran &&
        ((handler.kind === "totp" &&
          routeClicks.some((target) => sameLoginTarget(target, handler.target))) ||
          (handler.kind === "passkey" && typesPassword));
      const targets = handlerTargets(handler);
      return [
        {
          handler,
          index,
          targets: [...targets, ...(sameForm ? routeFields : [])],
          require: [
            ...(ran
              ? targets.map(() => "present" as const)
              : handler.kind === "totp"
                ? (["writable", "shown"] as const)
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
    const shown = observable
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
    const refusal = (entry: (typeof entries)[number]) =>
      run.metadata.handlers.some((entered) => entered.index === entry.index)
        ? ("shown-again" as const)
        : !run.metadata.facts[handlerFact[entry.handler.kind]]
          ? ("missing-fact" as const)
          : entry.handler.kind === "totp" && attemptUsesCode(run.recipe, run.metadata)
            ? ("code-used" as const)
            : undefined;
    const fresh = shown.find((entry) => refusal(entry) === undefined);
    if (!fresh) {
      reportHandler(shown[0]!, refusal(shown[0]!)!);
      await challenge();
      return true;
    }
    if (fresh.handler.kind === "totp") {
      // The code comes from the item's built-in TOTP field, which the account must allow.
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
    const steps = handlerSteps(fresh.handler);
    const event: LoginAttemptEvent = {
      type: "HANDLER",
      handler: fresh.index,
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
      ["present", ...proof.shown, ...(rejection ? ["present" as const] : [])],
      proof.links.length > 0 ? [false, ...proof.links] : undefined,
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
   * the page's URL. `undefined` when one cannot be read.
   */
  async function judgedUsernames(run: Execution): Promise<string[] | undefined> {
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
        ...usernameReads({ items: [{ connection, item }], settings: snapshot.snapshot.settings }),
      ];
    }
    return readUsernames(run.live.document.origin, reads);
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
    { observation: LoginObservation; disabledLeftOut: boolean } | { unsent: string } | undefined
  > {
    let observation: LoginObservation | undefined;
    let unsent = "unreachable";
    let disabledLeftOut = false;
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
      }
    } catch {
      // The page could not be asked: `unreachable`.
    }
    if (!current(run)) return undefined;
    if (!observation) return { unsent };
    // A judged page can show the identifier just entered: the usernames of the items that
    // match it, and the login's own, are hidden first.
    const usernames = await judgedUsernames(run).catch(() => undefined);
    const hidden = hideUsernames(observation, usernames, run.live);
    if (!current(run)) return undefined;
    if ("reason" in hidden) return { unsent: hidden.reason };
    return { observation: hidden.observation, disabledLeftOut };
  }
  async function learn(run: Execution, reading?: SignInReading): Promise<boolean> {
    const { recipe, metadata } = run;
    const { operationId } = metadata;
    if (!generation || !effectful(metadata) || !operationId) return false;
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
      marker.length > 0 ? [...fills.map(() => false), ...marker.map(() => true)] : undefined,
    );
    if (!remaining) {
      // A superseded run or a refused one (logged with its own cause) says nothing here.
      if (current(run) && !terminal(run.metadata)) notSent("unreachable");
      return false;
    }
    // A route's sign-in field shows on another path too (S1): such a page is never complete
    // (ADR 0029), and the description may leave the field out when no locator names it.
    if (
      reading?.decision === "unknown" ||
      reading?.decision === "rejected" ||
      (paths.includes(remaining.path) &&
        remaining.targets
          .slice(0, fills.length)
          .some((state) => state !== "missing" && state !== "unusable"))
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
    if ("unsent" in described) return notSent(described.unsent);
    const { observation, disabledLeftOut } = described;
    const left = pagesLeft(run.metadata, operationId);
    await change(run, { type: "JUDGING", operationId });
    if (!current(run)) return true;
    if (pagesLeft(run.metadata, operationId) !== left - 1) return false;
    const watchedPage = run.metadata.watch !== undefined;
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
      });
    // A chooser login's branch, and whether the description left a disabled field out
    // (ADR 0029); each is passed only when there is one.
    const branch = metadata.chooser ? chooserClickBranch(metadata.chooser.click) : undefined;
    const judgedTail: [(ChooserBranch | undefined)?, true?] = disabledLeftOut
      ? [branch, true]
      : branch
        ? [branch]
        : [];
    const spin = spinning(run.live.document.tabId);
    const {
      verdict,
      reason,
      recipe: added,
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
        ...judgedTail,
      )
      .finally(spin.stop);
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
    // person, as does a page judged `challenge` before (ADR 0029).
    const candidate = undecidedCandidate({
      verdict,
      reason,
      reading,
      watched: run.metadata.watch !== undefined,
      route: run.metadata.route,
      stopAt: run.metadata.stopAt,
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
    });
    // The page after the final advance before a stop just past the plan's last step, not
    // found signed in or rejected and with no handler taken over, takes the login to its
    // stop, where the page's passkey request is answered (ADR 0036).
    if (result === "challenge" && (await toStop(run))) return true;
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
    if (!run.metadata.chooser) return recipes.recipe(pageOrigin, path, run.recipe.id);
    return routeOf(run, await recipes.chooser?.(pageOrigin, path, run.recipe.id));
  }
  /**
   * Whether the attempt's in-flight step is the final `advance` step of a recipe that can be
   * continued on the page it leads to (ADR 0018): a `password` route login on the recipe's
   * own steps (variant 0), in the tab's own page, with recipe generation configured, whose
   * recipe has no completion and no alternatives. A login of an item without a password
   * asks only when its stop lies just past that advance (ADR 0036).
   */
  function continuable(run: Execution): boolean {
    const { metadata, recipe } = run;
    if (
      !generation ||
      !uris ||
      (probeMode && metadata.account.origin === origin) ||
      // A fill-only login after a logout ends before any advance (ADR 0021 D).
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
      inFlight.handler === undefined &&
      loginStepEffect(inFlight.step) === "advance"
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
      undefined,
      true,
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
    // The fields the recipe already filled on this path may show again, read-only.
    const known = recipe.steps
      .filter((step) => step.path === observed.path)
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
      if (extracted.success && !extracted.output.ok) missing = extracted.output.reason;
      else if (extracted.success && extracted.output.ok) {
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
          // A chooser login's page is its branch's next page (ADR 0028).
          ...(metadata.chooser ? { branch: chooserClickBranch(metadata.chooser.click) } : {}),
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
      .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error", retry: true }));
    // Kept in memory for a later document of this login, which the form may post to
    // before the answer arrives.
    const request = { operationId, answer: asked };
    continuations.set(metadata.id, request);
    const answer = await asked;
    const reportGeneration = (takenOver?: boolean) =>
      report(run.live.document, {
        type: "generation",
        tabId: run.live.document.tabId,
        origin: pageOrigin,
        ...outcomeFields(answer),
        recipeId: recipe.id,
        baseRevision: recipe.revision,
        ...(takenOver === undefined ? {} : { takenOver }),
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
    try {
      taken = await continueWith(run, answer.recipe, () => {
        reported = true;
        reportGeneration(true);
      });
    } finally {
      // Not taken over, or the `CONTINUED` write failed.
      if (!reported) reportGeneration(false);
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
        !scope.settings.connections.some(
          (entry) =>
            entry.connectionId === connection.id &&
            entry.excludedFields.some(
              (ref) => ref.itemId === item.id && ref.fieldId === "login.password",
            ),
        ),
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
   * save after `authenticated` is derived again, so it covers the new slots too. Returns
   * whether the attempt moved on.
   */
  async function continueWith(
    run: Execution,
    next: LoginRecipe | LoginChooserRecipe,
    taking?: () => void,
  ): Promise<boolean> {
    const route = attemptRouteChoice(run.metadata);
    const answered = next;
    const converted = routeOf(run, next);
    if (
      !current(run) ||
      !converted ||
      route.route !== "password" ||
      converted.id !== run.recipe.id ||
      !continuesRecipe(run.recipe, converted)
    )
      return false;
    next = converted;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!current(run) || !snapshot.ok || snapshot.snapshot.revision !== run.metadata.policyRevision)
      return false;
    const plan = await planFor(snapshot, run.live, next, {
      route,
      handlerSlots: handlerSlots(next, run.metadata),
    });
    if (
      !current(run) ||
      !plan.ok ||
      plan.account.connectionId !== run.metadata.account.connectionId ||
      plan.account.itemId !== run.metadata.account.itemId
    )
      return false;
    const added = routeSteps(next, route).slice(routeSteps(run.recipe, route).length);
    // A login whose stop lay just past its plan moves it to the continued step that fills a
    // password, or past them again; one the continuation cannot stop in is not taken over.
    const stopAt =
      run.metadata.stopAt === undefined ? undefined : continuedStop(run, next, route, plan);
    if (typeof stopAt === "string") {
      run.stopMiss = stopAt;
      return false;
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
      if (transitionLoginAttempt(run.metadata, event).state !== "ready") return false;
    } catch {
      // More steps or effects than one page may add.
      return false;
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
    let until =
      Date.now() + (run.metadata.operationEffect === "advance" ? LOGIN_STEP_WAIT_MS : 3000);
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
        const observed = await observe(run, proof.targets, proof.shown, proof.links);
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
    // completes a watched login.
    if (state?.decision === "judge") await learn(run);
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
      // A fill-only login stops before anything that may advance or submit (ADR 0021 D).
      if (run.metadata.fillOnly && (!upcoming || effectfulStep(upcoming))) {
        await endFillOnly(run);
        return;
      }
      if (upcoming?.kind === "fill" || upcoming?.kind === "click") {
        // A code input may submit by itself once the code is in, as one that submits on
        // its last digit does; its click then has nothing left to do (ADR 0027).
        const afterCode =
          upcoming.kind === "click" &&
          codeStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
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
      delete run.inPlace;
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
      const values: { slot: string; value: string; secret?: LoginSecretKind }[] = [];
      let expected: { username: string } | undefined;
      let list: ({ username: string; others: string[] } & Record<string, unknown>) | undefined;
      let response: unknown;
      try {
        if (operation.step.kind === "fill") {
          for (const field of operation.step.fields) {
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
            let value: string | undefined;
            try {
              value = await fields({
                account: run.metadata.account,
                connection: authorized.connection,
                fieldId: reference.fieldId,
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
            // A `totp` handler's code fills only a code input, whatever field it reads.
            const secret: LoginSecretKind | undefined =
              codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
              attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler !== undefined
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
          after?.kind === "click"
            ? after.target
            : undefined;
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
          const handler = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
          const at = Date.now();
          effects.set(tabId, {
            attemptId: run.metadata.id,
            at,
            document: run.live.document,
            submits: loginStepEffect(operation.step) === "submit",
            passkey:
              run.metadata.route === "passkey" ||
              (handler !== undefined && run.recipe.handlers?.[handler]?.kind === "passkey"),
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
          // A fill-only login after a logout never clicks, not even a switch (ADR 0021 D).
          ...(expected &&
          run.recipe.accountSwitch &&
          !run.metadata.accountSwitched &&
          !run.metadata.fillOnly
            ? { accountSwitch: run.recipe.accountSwitch }
            : {}),
          // A `totp` handler's code fill watches for the page submitting the code itself.
          ...(codeSubmit ? { code: { submit: codeSubmit } } : {}),
          // An advance whose next step is on its path has the document measure that step
          // just before its effect, in the same task (ADR 0013).
          ...(inPlace ? { next: inPlace } : {}),
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
      if (
        matchedResult &&
        !result.output.ok &&
        result.output.reason === "wrong-account" &&
        result.output.mutation === "none"
      ) {
        const switched =
          result.output.switchable === true &&
          run.recipe.accountSwitch !== undefined &&
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
      // The page would not accept the values; the same values would fail again.
      if (
        matchedResult &&
        !result.output.ok &&
        operation.step.kind === "fill" &&
        ((result.output.reason === "value-mismatch" && result.output.mutation === "none") ||
          (result.output.reason === "fill-rejected" && operation.step.effect === "prepare"))
      ) {
        await change(run, {
          type: "VALUE_REJECTED",
          operationId: operation.operationId,
          document: run.live.document,
          stage: result.output.reason === "value-mismatch" ? "before-fill" : "after-fill",
        });
        return;
      }
      // The code page showed that it submits the code by itself, or replaced its form
      // once the code was in.
      if (
        matchedResult &&
        !result.output.ok &&
        (result.output.reason === "submitted" || result.output.reason === "structural-mismatch") &&
        result.output.mutation === "possible" &&
        codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
        (await codeSubmitted(run))
      )
        continue;
      if (leftToPerson) {
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
    const unique = new Map(readiness.map((entry) => [JSON.stringify(entry), entry]));
    return [...unique.values()].slice(0, 32);
  }
  /**
   * Whether this document may be sent for generation once it shows a sign-in input: a
   * top-level page on whose path no cached recipe of its origin starts (several starting
   * there count too), and whose path was not sent within the retry window (ADR 0016). An
   * entry recipe's path counts as a start (ADR 0031); it is added here only, since
   * `startsFor` leaves out a path several starts share.
   */
  async function offersGeneration(live: LiveDocument): Promise<true | GenerationHold | undefined> {
    if (!generation || !uris || live.document.frameId !== 0 || live.topUrl) return undefined;
    if (probeMode && live.document.origin === origin) return undefined;
    const starts = await recipes.starts(live.document.origin).catch(() => undefined);
    if (starts === undefined || starts.some((start) => start.path === live.path)) return undefined;
    const entries = await recipes.entries(live.document.origin).catch(() => undefined);
    if (entries === undefined || entries.some((entry) => entry.entry.path === live.path))
      return undefined;
    return generation.available(live.document.origin, live.path).catch(() => undefined);
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
        "other",
      )
      .catch(() => undefined);
  }
  /**
   * The slots to generate for when a vault item's URI matches the page, with the
   * matching items. No field value is read here. Without them, `miss` hears why, for the
   * log: `no-vault-match` when no item fits, or why the vault could not tell.
   */
  async function generationSlotsFor(
    live: LiveDocument,
    miss: (reason: GenerationMiss, detail?: string) => void = () => undefined,
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
    const items = scope.candidates.flatMap((candidate) => {
      const connection = snapshot.catalog.connections.find(
        (entry) => entry.id === candidate.connectionId,
      );
      const item = connection?.items.find((entry) => entry.id === candidate.itemId);
      return connection && item ? [{ connection, item }] : [];
    });
    // Only slots a matching item can fill; built-in fields keep these IDs on every device.
    const slots = generationSlots.filter(({ fieldId }) =>
      items.some(({ connection, item }) =>
        offersGenerationField(
          snapshot.snapshot.settings,
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
    if (!slots.length && !offers.length) {
      const enabled = snapshot.catalog.connections.some(
        (connection) =>
          snapshot.snapshot.settings.connections.find(
            (entry) => entry.connectionId === connection.id,
          )?.enabled,
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
    return {
      slots: slots.map(({ slot }) => slot),
      offers,
      items,
      settings: snapshot.snapshot.settings,
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
  function usernameReads(scope: Pick<GenerationScope, "items" | "settings">) {
    return scope.items.flatMap(({ connection, item }) => {
      const excluded = scope.settings.connections
        .find((entry) => entry.connectionId === connection.id)
        ?.excludedFields.some(
          (field) => field.itemId === item.id && field.fieldId === "login.username",
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
        settingsValue.connections
          .find((entry) => entry.connectionId === connectionId)
          ?.excludedFields.some((field) => field.itemId === itemId && field.fieldId === fieldId)
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
  /** Logs once per document and reason why it was not sent for generation. */
  function skipGeneration(
    live: LiveDocument,
    reason: string,
    page?: "entry" | "other",
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
  ): Promise<void> {
    if (!generation) return;
    const base = otherless && { recipeId: otherless.id, revision: otherless.revision };
    const page = list
      ? ({ page: "accounts" } as const)
      : base
        ? ({ page: "other", recipeId: base.recipeId, baseRevision: base.revision } as const)
        : {};
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
              : { type: "login.extract", page: "login" },
          ),
        );
        if (documents.get(key) !== live) return;
        // The content script's refusal, such as `no-locator` or `extract-error`;
        // `extract-failed` for an answer that fails its check or never came.
        let unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "extract-failed";
        // Why a described page is not sent, for the log (ADR 0019).
        let detail: string | undefined;
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
        if (unsent === "cancelled" || read >= EXTRACT_READS) {
          skipGeneration(live, unsent, otherless && "other", detail);
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, EXTRACT_RETRY_MS));
        if (documents.get(key) !== live) return;
      }
      // The `other` branch's first page asks for the account. A form without such a field,
      // as the password form after the person's own click on a listed profile, belongs to
      // the account branch and is never stored as `other` (ADR 0028).
      if (otherless && !asksAccount(observation)) {
        skipGeneration(live, "no-account-field", "other");
        return;
      }
      const usernames = await readUsernames(live.document.origin, usernameReads(scope));
      const shape = usernames && usernameShape(scope, usernames);
      // The account's own usernames never reach the service.
      const hidden = hideUsernames(observation, usernames, live);
      if (documents.get(key) !== live) return;
      if ("reason" in hidden) {
        skipGeneration(live, hidden.reason, otherless && "other");
        return;
      }
      const custom = await customSlots(live.document.origin, scope);
      if (documents.get(key) !== live) return;
      const spin = spinning(live.document.tabId);
      const result = await generation
        .generate(
          {
            version: 1,
            observation: hidden.observation,
            slots: [
              ...scope.slots.map((slot) =>
                slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
              ),
              ...custom,
            ],
            ...(base ? { base, branch: "other" as const } : {}),
          },
          spin.sent(() =>
            report(live.document, {
              type: "generation",
              tabId: live.document.tabId,
              origin: live.document.origin,
              outcome: "sent",
              ...page,
            }),
          ),
        )
        .finally(spin.stop)
        .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error" }));
      sent = true;
      report(live.document, {
        type: "generation",
        tabId: live.document.tabId,
        origin: live.document.origin,
        ...outcomeFields(result),
        ...page,
      });
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
          skipGeneration(live, "unreachable", otherless && "other", error.reason);
        else skipGeneration(live, "exception", otherless && "other");
    }
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
    await loaded;
    await sessionLoaded;
    // A logout clicked on the tab's previous page is recorded before this page is read.
    await Promise.all(clicksNoting);
    const document = await identify(sender);
    if (!document || !sender.url) {
      await noteUnadmitted(sender);
      return { ok: false, reason: "unauthorized-document" };
    }
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    const key = frameKey(document);
    // A logout click waits for its site's first step only while the tab stays on that site.
    if (document.frameId === 0) leaveClicks(document.tabId, siteOf(document.origin));
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
      await checkAfterPress(live);
      if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    }
    if (entryRefused.has(refusedKey)) return refuse("entry-blocked");
    // A report sent only for the log does not log the tab's hold again.
    if (busy)
      return (shown || list || unoffered) && !start && !signIn
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
    const logoutKey = recordKey(document.tabId, document.origin);
    // A fill-only login is forgotten when it ends; one a stopped worker left ended is too.
    if (recorded?.fillOnly && terminal(recorded)) {
      try {
        await forget(logoutKey);
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
        await saveSession();
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
      const ended = transitionLoginAttempt(own?.metadata ?? recorded, { type: "WATCH_ENDED" });
      if (own) own.metadata = ended;
      reportAttempt(ended, own?.recipe);
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
        const starts = await startsFor(document.origin);
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
        void quietly(saveSession);
      }
      try {
        await forget(logoutKey);
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
        const starts = await startsFor(document.origin);
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
        await saveSession();
      } catch {
        stoppedAsks.delete(logoutKey);
        return refuse("storage-unavailable");
      }
      try {
        await forget(logoutKey);
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
    // A control that logs out was clicked in this tab on this site, after a login the tab
    // does not know, such as one in another tab or before a browser restart: the recipe's
    // first step showing now is that logout, and the tab asks as after its own login
    // (ADR 0021 D, owner 2026-10-16). An expired session, where nobody clicked, still logs in.
    const clickSite = siteOf(document.origin);
    const logoutClick =
      !recorded && document.frameId === 0 && start?.path === live.path && clickSite !== undefined
        ? pendingClick(document.tabId, clickSite)
        : undefined;
    if (logoutClick) {
      const clickKey = `${logoutClick.tabId} ${logoutClick.site}`;
      const known = logouts.has(logoutKey);
      // Kept as used, so a passkey request of the site still asks while the tab asks.
      const used = { ...logoutClick, used: true as const };
      logoutClicks.set(clickKey, used);
      logouts.add(logoutKey);
      try {
        await saveSession();
      } catch {
        // A newer click recorded meanwhile stays.
        if (logoutClicks.get(clickKey) === used) logoutClicks.set(clickKey, logoutClick);
        if (!known) logouts.delete(logoutKey);
        return refuse("storage-unavailable");
      }
      if (!known)
        report(document, {
          type: "logout",
          tabId: document.tabId,
          origin: document.origin,
          clicked: true,
        });
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
    // A logout in another tab ends the shared session too, so this tab asks as well.
    const asking =
      !recorded &&
      (logouts.has(logoutKey) ||
        stoppedAsks.has(logoutKey) ||
        askedElsewhere(document.tabId, document.origin));
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
        : await recipes.recipe(document.origin, live.path, previous?.recipeId);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A chooser recipe (ADR 0028): a new login on its list runs the route of its account
    // entry until it decides what to click, and a resumed one the route of its click.
    let chooser: LoginChooserRecipe | undefined;
    if (!recipe && !(probeMode && document.origin === origin) && (!previous || previous.chooser)) {
      chooser = await Promise.resolve(
        recipes.chooser?.(document.origin, live.path, previous?.recipeId),
      ).catch(() => undefined);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
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
      // The chooser's path shows a sign-in form instead of its list, and the chooser has no
      // `other` branch yet, as after the person pressed its button for another account: the
      // page is sent as that branch's first page, as after Pateat's own click, and once
      // stored the form starts as `other-shown` (ADR 0028, owner 2026-10-17).
      const otherless =
        chooser?.chooser.other && !chooser.chooser.afterOther && !previous ? chooser : undefined;
      const otherOffer = otherless && (await offersOther(live, otherless));
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      const otherShown = otherless && signIn?.path === live.path ? otherless : undefined;
      // Logged only for a shown form: the list may still show on this path.
      if (
        otherShown &&
        (otherOffer === "sending" || otherOffer === "sent" || otherOffer === "not-connected")
      )
        skipGeneration(live, otherOffer, "other");
      if (otherShown && otherOffer === true) {
        // Nor is the page right after a sign-in.
        if (afterSignIn.get(document.tabId) === document.documentId)
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
      // Only a page that was sent is held, so the log says why it is not sent again.
      if (availability === "sending" || availability === "sent") skipGeneration(live, availability);
      // Without the service no page is sent; logged at debug level, as every page is.
      if (availability === "not-connected") skipGeneration(live, availability);
      const shownList = !signIn && list?.path === live.path ? list : undefined;
      // A shown email address that is no list entry is logged only (ADR 0028).
      if (offer && shownList?.missed)
        skipGeneration(live, "not-a-list", undefined, shownList.missed);
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
        if (!listing.names || listing.other || entryOffer) skipGeneration(live, "after-sign-in");
        offer = false;
      }
      // Nor while another tab's login of the origin authenticated within the hour, as on a
      // signed-in dashboard listing the site's accounts by email opened in a new tab, unless
      // the tab logged out or the site asks after a logout (ADR 0028, owner 2026-10-17).
      if (
        offer &&
        listing &&
        !asking &&
        signedInElsewhere(document.tabId, document.origin) &&
        !(clickSite && pendingClick(document.tabId, clickSite))
      ) {
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
      if (offer && (signIn?.path === live.path || listing)) {
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
        const refusal = entryPage ? await entryOfferRefusal(live) : "no-return-target";
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if (!refusal) {
          live.state = "generating";
          delete live.reason;
          await publish(live);
          void generateEntryFor(live);
          return { ok: false, reason: "generating" };
        }
        skipGeneration(live, refusal, "entry");
        offer = false;
      }
      // A page offered for generation that showed nothing to send by the end of the step
      // wait is logged with why; mostly ordinary browsing, so at debug level (ADR 0019).
      // The tab's next document after a submitted password form is known only here.
      if (offer && unoffered?.path === live.path && !signIn && !shownList && !entryOffer)
        skipGeneration(
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
        ...(offer || otherOffer === true ? { generate: true as const } : {}),
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
    if (asking && heldElsewhere(document.tabId, document.origin)) {
      showHeld(document.tabId);
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
    const pageRequest = !previous && document.frameId === 0 && parkedFor(document) !== undefined;
    let plan = await planFor(snapshot, live, recipe, {
      asking,
      fill,
      ...(previous ? { route: attemptRouteChoice(previous) } : {}),
      ...(pageRequest ? { pageRequest } : {}),
    });
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (plan.ok && "fillOnly" in plan && plan.route.route !== "password") {
      plan = await planFor(snapshot, live, recipe, { asking });
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
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
        offerChoice(
          document,
          plan.candidates,
          logout ? logoutDetail(recordKey(document.tabId, document.origin)) : undefined,
        );
        // Outside a logout, the page's own conditional request may wait for the pick, on a
        // recipe without a passkey button (ADR 0034).
        noteChoice(
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
              logoutDetail(logoutKey)
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
      if (savingChoices.size || remembered !== savedBefore)
        return { ok: false, reason: CHOICE_SAVED };
      if (heldElsewhere(document.tabId, document.origin)) {
        showHeld(document.tabId);
        return refuse("origin-busy");
      }
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
    reviewRequests();
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
    clearChoice(document.tabId);
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
      void quietly(saveSession);
    }
    // A login started after a logout ends the tab's asking for this origin; filling the
    // page only does not, and the document is not filled again.
    if (metadata.fillOnly) {
      logoutFills.add(filledKey);
      for (const old of logoutFills) {
        if (logoutFills.size <= 256) break;
        logoutFills.delete(old);
      }
      void quietly(saveSession);
    } else if (!previous) {
      const loggedOut = logouts.delete(logoutKey);
      rejectedAsks.delete(logoutKey);
      if (stoppedAsks.delete(logoutKey) || loggedOut) void quietly(saveSession);
    }
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
  /** Whether any tab keeps a logout state for an origin of `site` (ADR 0021 D). */
  const siteLoggedOut = (site: string) =>
    scopes(logouts).some((entry) => siteOf(entry.origin) === site);
  /** Whether another tab's login of an origin of `site` holds it (ADR 0022). */
  function siteHeldElsewhere(tabId: number, site: string): boolean {
    const now = Date.now();
    return persisted
      .values()
      .some(
        (entry) =>
          entry.document.tabId !== tabId &&
          siteOf(entry.account.origin) === site &&
          holdsSite(entry, now),
      );
  }
  /**
   * The tab's logout click on `site` while it still waits for the site's first step (ADR
   * 0021 D): for 10 minutes after the click. One older, or from a clock that went back,
   * is dropped.
   */
  function pendingClick(tabId: number, site: string): LogoutClick | undefined {
    const key = `${tabId} ${site}`;
    const click = logoutClicks.get(key);
    if (!click || click.used) return undefined;
    const age = Date.now() - isoTimeMs(click.clickedAt);
    if (age >= 0 && age < LOGOUT_CLICK_MS) return click;
    logoutClicks.delete(key);
    void quietly(saveSession);
    return undefined;
  }
  /**
   * Drops the tab's waiting logout clicks of other sites than `site`: the tab left them. A
   * used one stays with the logout state it began.
   */
  function leaveClicks(tabId: number, site: string | undefined): void {
    let changed = false;
    for (const [key, click] of logoutClicks)
      if (click.tabId === tabId && click.site !== site && !click.used) {
        logoutClicks.delete(key);
        changed = true;
      }
    if (changed) void quietly(saveSession);
  }
  /**
   * Records a control that logs out, clicked in a document of an origin with recipes (ADR
   * 0021 D, owner 2026-10-16), for its tab and site; the 256 newest are kept.
   */
  async function noteLogoutClick(sender: Sender): Promise<void> {
    await sessionLoaded;
    const document = await identify(sender);
    const site = document && siteOf(document.origin);
    if (!document || site === undefined) return;
    const key = `${document.tabId} ${site}`;
    logoutClicks.delete(key);
    logoutClicks.set(key, { tabId: document.tabId, site, clickedAt: isoTime(Date.now()) });
    for (const oldest of logoutClicks.keys()) {
      if (logoutClicks.size <= 256) break;
      logoutClicks.delete(oldest);
    }
    await quietly(saveSession);
  }
  /**
   * Whether a username-less passkey request for `rpId` in the tab follows a logout click
   * on its site, so it asks as after Pateat signed there (ADR 0021 D): while the click
   * waits, and once used, while the tab keeps a logout state for an origin of the site.
   * A used click whose logout state ended, as when a login started, is dropped.
   */
  async function logoutClicked(tabId: number, rpId: string): Promise<boolean> {
    await sessionLoaded;
    await Promise.all(clicksNoting);
    const site = siteOf(`https://${rpId}`);
    if (site === undefined) return false;
    if (pendingClick(tabId, site)) return true;
    const key = `${tabId} ${site}`;
    if (!logoutClicks.get(key)?.used) return false;
    if (scopes(logouts).some((entry) => entry.tabId === tabId && siteOf(entry.origin) === site))
      return true;
    logoutClicks.delete(key);
    void quietly(saveSession);
    return false;
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
   * Whether a vault item's URI matches the page, which needs an unlocked vault; no field is
   * read. `undefined` when the settings could not be read.
   */
  async function vaultMatches(live: LiveDocument): Promise<boolean | undefined> {
    if (!uris) return false;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return undefined;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url: live.url,
      match: uris,
    });
    return scope.ok && scope.candidates.length > 0;
  }
  /**
   * Why the page may not be sent as a site's sign-in entry beyond ADR 0016's conditions
   * (ADR 0031), cheapest first: its URL no longer names another path of its site; it is the
   * next page after a manual sign-in; the tab holds an attempt record for its site; any tab
   * keeps a logout of the site; or no vault item matches.
   */
  async function entryOfferRefusal(live: LiveDocument): Promise<string | undefined> {
    const site = siteOf(live.document.origin);
    if (site === undefined || !namesReturnPath(new URL(live.url), sameSiteAs(live.url)))
      return "no-return-target";
    // The page right after a sign-in (ADR 0028); the document skips its own next path.
    if (afterSignIn.get(live.document.tabId) === live.document.documentId) return "after-sign-in";
    if (siteRecorded(live.document.tabId, site)) return "site-record";
    if (siteLoggedOut(site)) return "logged-out";
    const matched = await vaultMatches(live).catch(() => undefined);
    return matched ? undefined : "no-vault-match";
  }
  /**
   * Sends the page as a site's sign-in entry (ADR 0031): its buttons and links, without
   * slots. A returned entry recipe is in the recipe cache by then; the document announces
   * again and its entry is pressed.
   */
  async function generateEntryFor(live: LiveDocument): Promise<void> {
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
      const { observation } = accepted;
      // Only a link is ever pressed, so a page without one is not worth a model call.
      if (!observation.candidates.some((candidate) => candidate.role === "link")) {
        skipGeneration(live, "no-entry-link", "entry");
        return;
      }
      const spin = spinning(live.document.tabId);
      const result = await generation
        .generateEntry(
          { version: 1, observation },
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
      sent = true;
      report(live.document, {
        type: "generation",
        tabId: live.document.tabId,
        origin: live.document.origin,
        ...outcomeFields(result),
        page: "entry",
      });
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
    // A manual logout that lands on the bare top page is never undone.
    if (!namesReturnPath(new URL(url), sameSiteAs(url))) return "no-return-target";
    const site = siteOf(pageOrigin);
    if (site === undefined) return "no-site";
    if (siteRecorded(tabId, site)) return "site-record";
    if (siteHeldElsewhere(tabId, site)) return "site-held";
    if (siteLoggedOut(site)) return "logged-out";
    // The person just logged out in this tab and may want another account (ADR 0021 D).
    if (pendingClick(tabId, site)) return "logout-clicked";
    const last = entryPresses.get(tabId);
    if (last && Date.now() - isoTimeMs(last.pressedAt) < ENTRY_PRESS_MS) return "press-limit";
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return "settings-unavailable";
    if (isSiteExcluded(snapshot.snapshot.settings, url)) return "site-excluded";
    if (!(await vaultMatches({ ...live, url }).catch(() => false))) return "no-vault-match";
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
      if (!shown()) return;
      const press: EntryPress = {
        tabId,
        origin: live.document.origin,
        recipeId: recipe.id,
        revision: recipe.revision,
        pressedAt: isoTime(Date.now()),
        documentId: live.document.documentId,
        url,
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
        await probeConfig.write({
          origin,
          ...(config.output.account ? { account } : {}),
          ...(probePasskey ? { passkey: probePasskey } : {}),
          ...(probeTotp ? { totp: true } : {}),
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
          // Tabs that ask after a logout, and whether the site's rejection began it.
          asks: [...logouts].map((key) => (rejectedAsks.has(key) ? "rejected" : "logout")),
          documents: [...documents.values()].map((live) => ({
            ...live.document,
            ...(live.state ? { state: live.state } : {}),
            ...(live.reason ? { reason: live.reason } : {}),
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
      const asked = v.safeParse(statusRequestSchema, message);
      if (asked.success) return popupStatus(asked.output.tabId);
      const pick = v.safeParse(pickRequestSchema, message);
      if (pick.success) return pickFor(pick.output);
      return undefined;
    }
    if (v.safeParse(logoutClickedSchema, message).success) {
      // Registered at once, so the tab's next page, announced after it, waits for it.
      const noting = noteLogoutClick(sender).catch(() => undefined);
      clicksNoting.add(noting);
      void noting.finally(() => clicksNoting.delete(noting));
      await noting;
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
      return ready(
        sender,
        hello.output.token,
        hello.output.start,
        hello.output.signIn,
        hello.output.shown,
        hello.output.list,
        hello.output.entry,
        hello.output.unoffered,
      );
    }
    const authorization = v.safeParse(authorizeSchema, message);
    if (!authorization.success) return undefined;
    const document = await identify(sender);
    if (!document) return false;
    const run = attempts.get(document.tabId);
    if (
      !run ||
      !current(run) ||
      run.live.token !== authorization.output.token ||
      run.metadata.id !== authorization.output.attemptId ||
      run.operation?.operationId !== authorization.output.operationId ||
      !sameLoginDocument(run.live.document, document) ||
      // A frame's attempt holds only while the tab still shows the page it matched.
      (run.live.topUrl !== undefined &&
        (!sender.tab?.url || new URL(sender.tab.url).origin !== new URL(run.live.topUrl).origin))
    )
      return false;
    if (!(await allowed(run))) return false;
    return validateLoginOperation(
      run.operation,
      run.metadata,
      document,
      run.metadata.policyRevision,
    );
  }
  /**
   * Settings were synced from the service or saved locally: stops every running login but
   * a watched one, which only reads, so it is checked against the new settings instead and
   * stops only when they no longer plan its account (ADR 0027).
   */
  function settingsChanged(source: "synced" | "saved"): void {
    for (const run of attempts.values()) {
      if (terminal(run.metadata)) continue;
      if (run.metadata.watch !== undefined) {
        void allowed(run).catch(() => undefined);
        continue;
      }
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
  // Chrome gives a tab a new ID when it discards it to save memory. It is the same tab to
  // the user: what the tab did moves to the new ID, and the gone page is forgotten as on
  // a close (ADR 0021). The event may be what starts the worker.
  browser.tabs.onReplaced.addListener((added, removed) => {
    if (added === removed) return;
    replacedTabs.add(removed);
    const moved = (key: string) =>
      key.startsWith(`${removed} `) ? `${added}${key.slice(String(removed).length)}` : key;
    void sessionLoaded.then(async () => {
      let changed = false;
      for (const keys of [logouts, stoppedAsks, rejectedAsks])
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
      // In place, so the clicks keep their turn among the oldest.
      if ([...logoutClicks.values()].some((click) => click.tabId === removed)) {
        const kept = [...logoutClicks.values()].map((click) =>
          click.tabId === removed ? { ...click, tabId: added } : click,
        );
        logoutClicks.clear();
        for (const click of kept) logoutClicks.set(`${click.tabId} ${click.site}`, click);
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
    forgetTab(removed);
  });
  /** Forgets a closed tab, or the gone page of a replaced one. */
  function forgetTab(tabId: number): void {
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
      for (const keys of [logouts, stoppedAsks, rejectedAsks])
        for (const key of keys)
          if (key.startsWith(`${tabId} `)) changed = keys.delete(key) || changed;
      for (const key of logoutFills)
        if (key.startsWith(`${tabId} `)) changed = logoutFills.delete(key) || changed;
      if (entryPresses.delete(tabId)) changed = true;
      for (const [key, click] of logoutClicks)
        if (click.tabId === tabId) changed = logoutClicks.delete(key) || changed;
      for (const key of noted.keys())
        if (key.startsWith(`${tabId} `)) changed = noted.delete(key) || changed;
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
  ): void {
    passkeyAnswers.set(`${tabId} ${siteOrigin}`, {
      at: Date.now(),
      rpId,
      ...(item ? { item: { connectionId: item.connectionId, itemId: item.itemId } } : {}),
    });
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
      ? await recipes.chooser?.(loginOrigin, "/", record.recipeId)
      : await recipes.recipe(loginOrigin, "/", record.recipeId);
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
   * once, answers `signed-in` for the page or found it signed in before. A judge that
   * cannot decide, a page that cannot be described or sent, and any other verdict end the
   * login `left-origin` (a watched one where it stopped), each logged. Once the answer is
   * back, the page must still be
   * loaded and quiet, with no passkey request since `since`, the step the move follows.
   * `username` is the login's own, hidden from the page as for any judged page.
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
      }
    } catch {
      // The page could not be asked: `unreachable`.
    }
    if (stale()) return false;
    if (!observation) {
      reportJudge("not-sent", unsent);
      return false;
    }
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
    const spin = spinning(document.tabId);
    const { verdict, reason } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        "password",
        hidden.observation,
        spin.sent(() => reportJudge("sent")),
        // A description that left out a disabled field says so (ADR 0029); only `signed-in`
        // completes a moved login anyway.
        record.chooser ? chooserClickBranch(record.chooser.click) : undefined,
        ...(disabledLeftOut ? [true as const] : []),
      )
      .finally(spin.stop);
    reportJudge(verdict, reason);
    if (verdict !== "signed-in" && !(verdict === "unclear" && reason === "judged-signed-in"))
      return false;
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
   * `SITE_MOVE_MS` ago, for an RP ID that `siteOrigin`'s HTTPS host is or is under. It was
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
    const { protocol, hostname } = new URL(siteOrigin);
    const fits = (answer: { at: number; rpId: string } | undefined) =>
      answer !== undefined &&
      answer.at >= (page?.requestedAt ?? effect.at) &&
      Date.now() - answer.at <= SITE_MOVE_MS &&
      protocol === "https:" &&
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
   * account after a logout, or offers its document a popup choice in which an item holds a
   * discoverable passkey, the login the pick starts answers it. A request of an origin
   * without a recipe is handed on at once, and one whose document starts no login within
   * `REQUEST_START_WAIT_MS` then.
   */
  async function conditionalRequest(input: {
    tabId: number;
    origin: string;
    documentId: string;
    signal: AbortSignal;
  }): Promise<ConditionalDecision> {
    await loaded;
    await sessionLoaded;
    const run = attempts.get(input.tabId);
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
    });
  }
  /**
   * Whether the tab asks the request's document for an account after a logout (ADR 0021 D):
   * its choice waits in the popup, or the pick of a document asked so has not started a
   * login yet.
   */
  function askedFor(parked: ParkedRequest): boolean {
    const waiting = pending.get(parked.tabId);
    const pick = picked.get(parked.tabId);
    return (
      (waiting?.logout !== undefined &&
        waiting.document.frameId === 0 &&
        waiting.document.documentId === parked.documentId) ||
      (parked.asked === true &&
        pick !== undefined &&
        pick.attemptId === undefined &&
        pick.origin === parked.origin &&
        pick.documentId === parked.documentId)
    );
  }
  /** Whether a tab still asks for an account of the origin after a logout (ADR 0021 D). */
  function asksAfterLogout(tabId: number, siteOrigin: string): boolean {
    const key = recordKey(tabId, siteOrigin);
    return (
      !recordFor(tabId, siteOrigin) &&
      (logouts.has(key) || stoppedAsks.has(key) || askedElsewhere(tabId, siteOrigin))
    );
  }
  /**
   * Records the popup choice a refused top document was offered, and whether the page's own
   * conditional request may wait for its pick: only outside a logout, on a recipe without a
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
   * Whether the request's document waits for a pick in a popup choice outside a logout
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
      !waiting.logout &&
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
   * own page's request itself. A request whose document the tab asks for an account after
   * a logout, or fills only, waits for the login the pick starts; so does one whose
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
      // A choice still offered decides alone: another tab's login can end the logout this
      // tab asks for, while its choice stays. A dropped pick leaves it a moment to be
      // offered again.
      const asks = running
        ? own.fillOnly === true
        : offered ||
          (parked.asked === true &&
            asksAfterLogout(parked.tabId, parked.origin) &&
            (parked.dropped === undefined || now - parked.dropped < REQUEST_START_WAIT_MS));
      // A popup choice outside a logout keeps the request while it offers an item with a
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
    effects.set(tabId, {
      attemptId: run.metadata.id,
      at: Date.now(),
      document: run.live.document,
      submits: false,
      passkey: true,
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
      // The step that asked for a passkey is the answer's, so S5 skips it and a move to
      // the passkey's site completes (ADR 0029, ADR 0022).
      effects.set(tabId, {
        attemptId: run.metadata.id,
        at: bridged,
        document: run.live.document,
        submits: false,
        passkey: true,
      });
      run.answeredAt = bridged;
    } else if (parked) {
      effects.set(tabId, {
        attemptId: run.metadata.id,
        at: Date.now(),
        document: run.live.document,
        submits: false,
        passkey: true,
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
    const { observation, disabledLeftOut } = described;
    await change(run, judging);
    if (!current(run)) return true;
    if (!stopped() || run.metadata.stopJudged !== true) return false;
    const { recipe } = run;
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
      });
    const spin = spinning(run.live.document.tabId);
    const {
      verdict,
      reason,
      recipe: added,
    } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        "password",
        observation,
        spin.sent(() => reportJudge("sent")),
        undefined,
        disabledLeftOut ? true : undefined,
        true,
      )
      .finally(spin.stop);
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
    if (!current(run) || run.metadata.route !== "password" || !run.choice) return;
    // The account choice saved after the sign-in names the password variant's binding.
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
  return {
    handle,
    settingsChanged,
    /** A site default was saved outside the settings page, as by the passkey chooser. */
    siteDefaultSaved: () => void choiceDefaults(),
    active,
    loginAccount,
    passkeyRequested,
    passkeyAnswered,
    conditionalRequest,
    logoutClicked,
  };
}
