import {
  type LoginAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
} from "@pateat/contracts";
import { sessionValue, trustedRecord } from "../../storage";
import { createLoginBadge, memoryBadgeStorage, setActionBadge } from "../badge";
import { DEFAULT_PROBE_ORIGIN, DEMO_PROBE_ACCOUNT, type ProbeAccount } from "../dummy";
import { createLoginPauses, LOGIN_PAUSES_KEY } from "../pause";
import type { PausingSettings } from "../sites";
import { createAccountPicks } from "../switch";
import { noLoginRecipes } from "./deps";
import {
  type LiveDocument,
  type Execution,
  type KeypadPress,
  type ParkedRequest,
  type ChoicePasskeys,
  type ConfirmVisit,
} from "./types";
import { type GenerationOutcome } from "./report";
import {
  type PickedAccount,
  type PendingChoice,
  type Relogins,
  type EntryPress,
  type EntryBlock,
  type DetailOffer,
  type PendingDetail,
  type RefusedDetail,
  STORAGE_KEY,
  CONFIG_KEY,
  ENTRY_BLOCKS_KEY,
} from "./session-schemas";

import type { SettingsRuntime, LoginRuntimeOptions } from "./deps";

export function createRuntimeState(settings: SettingsRuntime, options: LoginRuntimeOptions) {
  const { fields, sites, recipes = noLoginRecipes, uris, generation, repairs } = options;

  /** Account switches' and the browser session's picks (ADR 0063). */
  const accountPicks = createAccountPicks();

  const badge =
    options.badge ?? createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() });

  const pauses = options.pauses ?? createLoginPauses(sessionValue(LOGIN_PAUSES_KEY));

  let origin = DEFAULT_PROBE_ORIGIN;

  let account: ProbeAccount = DEMO_PROBE_ACCOUNT;

  let probePasskey: "discoverable" | "second-factor" | undefined = undefined;

  let probeTotp = false;

  // The probe's own step wait; undefined, as always in production, for the full one.
  let probeStepWaitMs: number | undefined = undefined;

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

  let reviewTimer: ReturnType<typeof setInterval> | undefined = undefined;

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

  /** Account choices being saved; each bumps the policy revision (ADR 0022). */
  const savingChoices = new Set<Promise<void>>();

  /** Counts account choices saved or attempted, so a new login sees a bump it missed. */
  let remembered = 0;

  // Attempts, the probe configuration and entry blocks are trusted-only device records.
  const attemptRecords = trustedRecord<LoginAttemptMetadata[]>(STORAGE_KEY);

  const probeConfig = trustedRecord<object>(CONFIG_KEY);

  const entryBlockRecords = trustedRecord<EntryBlock[]>(ENTRY_BLOCKS_KEY);

  let storageQueue: Promise<void> = Promise.resolve();

  let storageHealthy = true;

  let checkpoint: "before-delivery" | "before-ack" | undefined = undefined;

  let armed: "before-delivery" | "before-ack" | "intent-write-failure" | undefined = undefined;

  let armTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  let releaseCheckpoint: (() => void) | undefined = undefined;

  /**
   * By tab: whether it is in an incognito window, as Chrome reported it. Incognito windows
   * keep their own cookies, so a tab there never shares a site's session with a tab
   * outside them, and neither holds the other back (owner, 2026-10-23).
   */
  const incognitoTabs = new Map<number, boolean>();

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
  let counting: Promise<unknown> | undefined = undefined;

  const reviving = new Map<number, Promise<void>>();

  /** By tab: the popup's last logged answer, so an open popup asking each second logs once. */
  const popupAnswers = new Map<number, string>();

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
   * Consecutive answers that make a document try its start again, by frame and document.
   * The content script tries a start `START_TRIES` times, about half a second apart, and
   * then waits until its form goes; the worker counts the answers to log the page giving up.
   */
  const startTries = new Map<string, { count: number; at: number }>();

  /** The blocks stored on this device; a read that fails is not kept, so it is read again. */
  let entryBlocks: Promise<EntryBlock[] | undefined> | undefined = undefined;

  /**
   * The pausing settings last applied (ADR 0062): the exclusion rules and automatic login
   * in private windows, so a settings change can tell what moved.
   */
  let appliedPolicy: PausingSettings | undefined = undefined;
  return {
    settings,
    options,
    fields,
    sites,
    recipes,
    uris,
    generation,
    repairs,
    accountPicks,
    badge,
    pauses,
    documents,
    attempts,
    keypadPresses,
    begunIn,
    effects,
    passwordFills,
    signInUrls,
    passkeyRequests,
    passkeyAnswers,
    passkeyPages,
    siteMoves,
    moveJudgements,
    parkedRequests,
    choicePasskeys,
    continuations,
    persisted,
    replacedTabs,
    picked,
    switchesRunning,
    switchTabs,
    switchStates,
    repromptGrants,
    repromptTyped,
    passwordAsks,
    repromptWaiting,
    repromptAsking,
    pending,
    noted,
    stoppedAsks,
    rejectedAsks,
    askFills,
    relogins,
    entryPresses,
    pressing,
    entryChecks,
    entryTimers,
    entryRefused,
    unsavedBlocks,
    detailOffers,
    cardGuesses,
    pendingDetails,
    refusedDetails,
    savingChoices,
    attemptRecords,
    probeConfig,
    entryBlockRecords,
    incognitoTabs,
    hellos,
    passwordSubmits,
    afterSignIn,
    confirmVisits,
    admitting,
    reviving,
    popupAnswers,
    variantRefusals,
    startTries,
    vars: {
      origin,
      account,
      probePasskey,
      probeTotp,
      probeStepWaitMs,
      reviewTimer,
      remembered,
      storageQueue,
      storageHealthy,
      checkpoint,
      armed,
      armTimer,
      releaseCheckpoint,
      counting,
      entryBlocks,
      appliedPolicy,
      sessionRead: undefined!,
      sessionLoaded: undefined!,
      loaded: undefined!,
      policyRead: undefined!,
    } as {
      origin: any;
      account: ProbeAccount;
      probePasskey: "discoverable" | "second-factor" | undefined;
      probeTotp: boolean;
      probeStepWaitMs: number | undefined;
      reviewTimer: ReturnType<typeof setInterval> | undefined;
      remembered: number;
      storageQueue: Promise<void>;
      storageHealthy: boolean;
      checkpoint: "before-delivery" | "before-ack" | undefined;
      armed: "before-delivery" | "before-ack" | "intent-write-failure" | undefined;
      armTimer: ReturnType<typeof setTimeout> | undefined;
      releaseCheckpoint: (() => void) | undefined;
      counting: Promise<unknown> | undefined;
      entryBlocks: Promise<EntryBlock[] | undefined> | undefined;
      appliedPolicy: PausingSettings | undefined;
      sessionRead: Promise<void>;
      sessionLoaded: Promise<void>;
      loaded: Promise<void>;
      policyRead: Promise<void>;
    },
  };
}

export type Runtime = ReturnType<typeof createRuntimeState>;
