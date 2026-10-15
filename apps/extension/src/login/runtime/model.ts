import * as v from "valibot";
import {
  attemptPlan,
  loginDocumentSchema,
  loginStepEffect,
  sameLoginTarget,
  saveLoginChoice,
  type LoginChoiceAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginHandler,
  type LoginOperation,
  type LoginChooserRecipe,
  type LoginRecipe,
  type PasswordStopMiss,
  type LoginStep,
  type SavedLoginBinding,
  type SemanticSlot,
  type SettingsResponse,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import type { Browser } from "wxt/browser";
import { domainKey } from "@pateat/bitwarden";
import { loginReadiness, type LoginReadiness, type TargetState } from "../wire";
import { logoutReasonSchema, type LogoutReason } from "../choice-wire";
import type { CustomFieldOffer } from "../generation-slots";
import type { EntryMiss, OtherMiss } from "../../page/account-list";
import type { SignInDecision, SignInSigns } from "../sign-in-state";
import type { OnSite } from "../entry";
import type { ConditionalDecision } from "../../passkeys/runtime";
import { newId } from "@pateat/contracts/ids";
import { isoTimeSchema } from "../../time";
import { codeStep } from "./recipes";
import type { AccountSource } from "./reports";

export const STORAGE_KEY = "pateat.login-attempts.v4";
/** Accounts picked in the toolbar popup, per tab; session storage survives a worker restart. */
export const PICKS_KEY = "session:pateat.login-picks.v1";
export const CHOICES_KEY = "session:pateat.login-choices.v1";
export const LOGOUTS_KEY = "session:pateat.login-logouts.v1";
/** Documents filled once after a logout, as `${tabId} ${documentId}` (ADR 0021 D). */
export const LOGOUT_FILLS_KEY = "session:pateat.login-logout-fills.v1";
/**
 * Tabs whose login of an origin stopped after a submission and whose login form then
 * showed again on a later page; they ask like a logout, in that tab only (ADR 0021 D).
 */
export const STOPPED_ASKS_KEY = "session:pateat.login-stopped-asks.v1";
/**
 * Tabs that ask like a logout because the site rejected their login of an origin; the
 * asking is the same, only its wording names the rejection (ADR 0021 D).
 */
export const REJECTED_ASKS_KEY = "session:pateat.login-rejected-asks.v1";
/**
 * Refusal reasons already logged, by tab, document and path, so a page that announces
 * again after a worker restart does not log the same reason as news (ADR 0019).
 */
export const NOTED_KEY = "session:pateat.login-noted.v1";
export const CONFIG_KEY = "pateat.login-probe-origin.v1";
/**
 * How long another tab's login that has not succeeded holds its origin after its record
 * last changed (ADR 0022, owner's choice on 2026-10-12).
 */
const HOLD_MS = 5 * 60_000;
/**
 * How often a login page offered for generation is read before it counts as one that
 * cannot be described, and how long apart: a form rendered in steps settles meanwhile.
 */
export const EXTRACT_READS = 3;
export const EXTRACT_RETRY_MS = 1000;
/** How soon after a password submission the tab's next page counts as right after it (ADR 0028). */
export const AFTER_SIGN_IN_MS = 60_000;
/**
 * How long after evidence of a sign-in the page is read again before the login completes
 * on it (ADR 0029), so a page that is still redirecting or about to ask for a second
 * factor does not settle the login, and how many times it is read again at most while
 * the document is still loading.
 */
export const SIGN_IN_RECHECK_MS = 1000;
export const SIGN_IN_RECHECKS = 10;
/**
 * How soon after a passkey answer, or after a password login's last effect step, a move to
 * another origin of that site may complete (ADR 0022), and a new document may be the site's
 * answer to the step, read for a sign-in form shown again (ADR 0029).
 */
export const SITE_MOVE_MS = 30_000;
/** Readings of that move's new page, a second apart, before it must have loaded quietly. */
export const SITE_MOVE_READINGS = 5;
/**
 * How long a login stays watched after its result stopped at `challenge` or settled as
 * unknown (ADR 0027, owner's choice on 2026-10-12), and how long each new page of its tab
 * is checked for a signed-in marker before its sign-in state is read, as after a click.
 */
const WATCH_MS = 10 * 60_000;
export const WATCH_SETTLE_MS = 3000;
/**
 * The sign-in state of ADR 0029 for a page no check explained, and whether a later reading
 * in the fully loaded document agreed, which every outcome but logging needs. `reshown`:
 * read on the sign-in form shown again in the first new document after the submission.
 */
export type SignInReading = {
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
export const formAgain = (signs: SignInSigns) =>
  signs.reshown === true &&
  signs.s2 &&
  !signs.s3 &&
  !signs.s4 &&
  !signs.s5 &&
  !signs.e1 &&
  !signs.e2 &&
  !signs.e3;
/** Sign-in entry presses per tab, until the tab closes (ADR 0031). */
export const ENTRY_PRESSES_KEY = "session:pateat.login-entry-presses.v1";
/** Entry recipe revisions blocked on this device after a press that led nowhere (ADR 0031). */
export const ENTRY_BLOCKS_KEY = "pateat.login-entry-blocks.v1";
/** A tab presses a sign-in entry at most once in this time (ADR 0031). */
export const ENTRY_PRESS_MS = 10 * 60_000;
/** How soon after a press the next page must show: a new document or a URL change. */
export const ENTRY_NEXT_PAGE_MS = 10_000;
/** Blocks kept at most; the oldest go first. */
export const MAX_ENTRY_BLOCKS = 100;
const tabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const revisionSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
/**
 * A sign-in entry press (ADR 0031), kept in session storage until its tab closes so the
 * one-press-per-10-minutes limit and the check of the next page survive a worker restart.
 * `documentId` and `url` are the pressed page's, so the same page announcing again is not
 * taken as the next one; `checked` once the next page passed or the recipe was blocked.
 */
export const entryPressSchema = v.strictObject({
  tabId: tabIdSchema,
  origin: v.string(),
  recipeId: v.string(),
  revision: revisionSchema,
  pressedAt: isoTimeSchema,
  documentId: v.string(),
  url: v.string(),
  checked: v.optional(v.literal(true)),
});
export type EntryPress = v.InferOutput<typeof entryPressSchema>;
/** Why the page after an entry press blocked its recipe revision (ADR 0031). */
export type EntryBlockReason = "left-site" | "no-sign-in" | "sign-up";
/**
 * An entry recipe revision blocked on this device, until the recipe sync brings a newer
 * revision or removes it (ADR 0031). Revisions only grow, also for a recipe generated
 * again after a revocation, so a block never applies to a later revision.
 */
export const entryBlockSchema = v.strictObject({
  recipeId: v.string(),
  revision: revisionSchema,
  reason: v.picklist(["left-site", "no-sign-in", "sign-up"]),
  blockedAt: isoTimeSchema,
});
export type EntryBlock = v.InferOutput<typeof entryBlockSchema>;
/** The registrable domain of an origin or URL, as Bitwarden's Domain match compares it. */
export function siteOf(value: string | URL): string | undefined {
  try {
    return domainKey(typeof value === "string" ? new URL(value) : value);
  } catch {
    return undefined;
  }
}
/** Whether a URL is on the site of `page` (its registrable domain). */
export const sameSiteAs =
  (page: string): OnSite =>
  (url) => {
    const site = siteOf(page);
    return site !== undefined && siteOf(url) === site;
  };
/**
 * How long a page's own conditional passkey request waits for a login of its document to
 * start before it is handed on (ADR 0034).
 */
export const REQUEST_START_WAIT_MS = 3000;
/**
 * Longest a conditional request waits for its login to end, or for a pick after a logout;
 * it is then withheld, so a login that runs that long never meets another provider's prompt
 * (ADR 0034). One that waits this long for a pick in an ordinary popup choice is handed on.
 */
export const REQUEST_PARK_MS = 4 * 60_000;
/**
 * How long the `passkey` route waits for its page's own request before it falls back, and
 * a login of an item without a password waits at its stop (ADR 0036).
 */
export const REQUEST_WAIT_MS = 3000;
/**
 * How long the start page's sign-in form may still show in the document after the
 * `passkey` route answered its request, before the login falls back (ADR 0034), and the
 * form after an answer at a login's stop, before it ends (ADR 0036).
 */
export const REQUEST_HOLD_MS = 15_000;
export type Sender = Browser.runtime.MessageSender;
export type SettingsRuntime = {
  handle(value: unknown): Promise<SettingsResponse>;
  /** Trusted background mutation; saves an automatic account choice after `authenticated`. */
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
export type UnsavedChoice = {
  binding: SavedLoginBinding | LoginChoiceAccount;
  connectionId: string;
  replace?: boolean;
};
/**
 * Settings with the choice added where missing, or replacing the site default for an
 * account picked to become it; the same object when nothing changes.
 */
export const withChoice = (value: SettingsSnapshot["settings"], choice: UnsavedChoice) =>
  saveLoginChoice(value, choice.binding, { replace: choice.replace === true });
export type LiveDocument = {
  document: LoginDocument;
  token: string;
  /**
   * The document's browser-provided URL: the tab's committed URL for a same-origin top
   * document (it follows history.pushState), else `sender.url`. Provider URI rules match it.
   */
  url: string;
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
export type MoveMiss =
  | "no-factor"
  | "no-username"
  | "page-gone"
  | "unreadable"
  | "sign-in-shown"
  | "passkey-request"
  | "not-quiet";
/** Why a page offered for generation is not sent, for the log (ADR 0019). */
export type GenerationMiss = "no-vault-match" | "vault-unavailable" | "connection-disabled";
/**
 * The popup's codes within its 200 characters: a page's own refusal reason is any text the
 * content script sent.
 */
export const clipCodes = <T extends Record<string, string | undefined>>(fields: T): T =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, value?.slice(0, 200)]),
  ) as T;
/** A provider's or vault's reason as a log code, within the log's 64 characters. */
export const logCode = (reason: string) =>
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
export type ListOffer = {
  path: string;
  names?: string[] | undefined;
  other?: true | undefined;
  otherMiss?: OtherMiss | undefined;
  missed?: EntryMiss | undefined;
};
/** Whether a record holds its origin against other tabs at `now` (ADR 0022). */
export const holdsSite = (entry: LoginAttemptMetadata, now: number) =>
  entry.state !== "authenticated" &&
  // A fill-only login never submits (ADR 0021 D).
  !entry.fillOnly &&
  !(entry.state === "blocked" && entry.outcome === "interrupted" && !entry.submissions) &&
  !stoppedByPateat(entry) &&
  // A clock set back ends the hold rather than prolonging it.
  now - (entry.changedAt ?? 0) >= 0 &&
  now - (entry.changedAt ?? 0) < HOLD_MS;
/** Documents are tracked per frame; a tab still runs at most one attempt. */
export const frameKey = (document: { tabId: number; frameId: number }) =>
  `${document.tabId}:${document.frameId}`;
/**
 * Attempt records are kept per tab and origin: each origin a tab shows keeps its own
 * record until the tab closes, while the tab still runs one attempt at a time.
 */
export const recordKey = (tabId: number, origin: string) => `${tabId} ${origin}`;
/** A document's key in the entry press's sets and maps (ADR 0031). */
export const documentKey = (page: { tabId: number; documentId: string }) =>
  `${page.tabId} ${page.documentId}`;
/**
 * An account the user picked in the toolbar popup (ADR 0021). It is used instead of the
 * saved default by the refused document it restarted and then by the attempt that
 * document started, on that login's later pages too. It is saved as the default after
 * `authenticated` only with `makeDefault`.
 */
export const pickedAccountSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
  documentId: v.string(),
  /** Set once the picked login starts; until then the pick applies to `documentId` only. */
  attemptId: v.optional(v.string()),
  connectionId: v.string(),
  itemId: v.string(),
  makeDefault: v.boolean(),
});
export type PickedAccount = v.InferOutput<typeof pickedAccountSchema>;
/**
 * A document refused because several accounts match it, or because its tab logged out
 * of the site (`logout`, ADR 0021 D); the popup offers these candidates.
 */
export const pendingChoiceSchema = v.strictObject({
  document: loginDocumentSchema,
  candidates: v.array(v.strictObject({ connectionId: v.string(), itemId: v.string() })),
  logout: v.optional(logoutReasonSchema),
});
/** A tab and origin that logged out after a Pateat login; it asks until a pick logs in. */
export const logoutSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
});
/**
 * A login that ended with a result, or that ended when the tab left its origin (ADR 0022);
 * its first step showing again in the tab's page means a logout (ADR 0021 D). A switch,
 * a stop, or a result still being reconciled does not.
 */
export const finishedLogin = (metadata: LoginAttemptMetadata) =>
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
export const stoppedByPateat = (metadata: LoginAttemptMetadata) =>
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
export type PendingChoice = v.InferOutput<typeof pendingChoiceSchema>;
export type Execution = {
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
  /** Saved only once this attempt reaches `authenticated`. */
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
export type ParkedRequest = {
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
export type ChoicePasskeys = {
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
export const choiceKey = (choice: {
  document: { documentId: string; origin: string };
  candidates: readonly { connectionId: string; itemId: string }[];
}) =>
  JSON.stringify([
    choice.document.documentId,
    choice.document.origin,
    choice.candidates.map((entry) => `${entry.connectionId} ${entry.itemId}`).sort(),
  ]);
/** An in-memory catalog copy in which one item covers `origin`; never persisted. */
export function withItemOrigin(
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
export const CHOICE_SAVED = "choice-saved";
export const terminal = (metadata: LoginAttemptMetadata) =>
  ["authenticated", "blocked"].includes(metadata.state);
/**
 * A login with no step left to run: its result settled as unknown, or it is watched after a
 * `challenge` (ADR 0027). Its later pages are checked, but it is not a login in progress.
 */
export const idle = (metadata: LoginAttemptMetadata) =>
  metadata.settled === true || metadata.state === "watching";
/**
 * Whether a login of an item without a password stands at its stop with nothing in flight
 * (ADR 0036): the step there fills the password, so it never runs, or the stop lies just
 * past the plan's last step and no step is there.
 */
export const atStop = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" &&
  metadata.stopAt !== undefined &&
  metadata.stepIndex === metadata.stopAt &&
  metadata.operationId === undefined;
/** Whether such a login answered a passkey request at its stop (`STOP_ANSWERED`). */
export const answeredAtStop = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" &&
  metadata.stopAt !== undefined &&
  metadata.stepIndex === metadata.stopAt &&
  metadata.operationId !== undefined;
/** Whether the plan step at `index` lies past such a login's stop. */
export const pastStop = (metadata: LoginAttemptMetadata, index: number) =>
  metadata.route === "password" && metadata.stopAt !== undefined && index > metadata.stopAt;
/**
 * Whether such a login's stop lies just past its plan's last step (ADR 0036): its route
 * fills no password and ends with an `advance`, as a recipe whose page after the identifier
 * is not generated yet. The page that advance leads to is the stop's.
 */
export const stopsPastPlan = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" && metadata.stopAt === metadata.stepCount;
/** Whether the step in flight is the final `advance` that leads to such a stop. */
export const advancingToStop = (metadata: LoginAttemptMetadata) =>
  stopsPastPlan(metadata) &&
  metadata.operationId !== undefined &&
  metadata.operationEffect === "advance" &&
  metadata.stepIndex + 1 === metadata.stopAt;
/** Whether a login's watch is over at `now`; a clock set back ends it too (ADR 0027). */
export const watchOver = (metadata: LoginAttemptMetadata, now: number) =>
  metadata.watch !== undefined &&
  (now - metadata.watch.since >= WATCH_MS || now < metadata.watch.since);
/**
 * Whether a TOTP code's fill (see `codeStep`) went in, or may have, and its click has not
 * run (ADR 0027): a page that moved on meanwhile submitted the code by itself.
 */
export const codeAwaitsClick = (recipe: LoginRecipe, metadata: LoginAttemptMetadata) =>
  metadata.operationId === undefined
    ? codeStep(recipe, metadata, metadata.stepIndex) === "click"
    : metadata.operationKind === "fill" &&
      metadata.operationEffect === "prepare" &&
      metadata.mutationIntent === true &&
      codeStep(recipe, metadata, metadata.stepIndex) === "fill";
/** The event for a code the page submitted by itself, marking a route step's code. */
export const autoSubmitted = (recipe: LoginRecipe, metadata: LoginAttemptMetadata) => ({
  type: "AUTO_SUBMITTED" as const,
  operationId: newId(),
  ...(attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.handler === undefined
    ? { routeStep: true as const }
    : {}),
});
/** The step may have submitted or moved the page, so its result can show a handler. */
export const effectful = (metadata: LoginAttemptMetadata) =>
  metadata.operationKind === "click" ||
  metadata.operationEffect === "advance" ||
  metadata.operationEffect === "submit";
export const stepTargets = (step: LoginStep) =>
  step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target];
/**
 * The recipe's signed-in markers as elements to observe (ADR 0029): each marker, which may
 * be a link located by its text (ADR 0018), then the elements it needs missing. `proves`
 * reads their states from `offset`: whether one marker shows once, visible, while each
 * element it needs missing is missing even hidden, on any path. Only the markers learned
 * on `pageOrigin` count: the recipe's own origin by default, or another origin that a
 * login's tab moved to (ADR 0022).
 */
export function markerProof(recipe: LoginRecipe, pageOrigin = recipe.origin) {
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
 * (ADR 0013): the next step's elements, as that step waits for them. Undefined when no
 * element could confirm it: a next step that needs none, one that shares an element with
 * the advance, or a handler's step, which keeps its own rules (ADR 0027).
 */
export function inPlaceNext(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): LoginReadiness | undefined {
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
  return readiness;
}
export const probeMode = import.meta.env.MODE === "probe";
/** The order in which handlers shown together are tried: a passkey types nothing. */
export const handlerOrder = { passkey: 0, totp: 1 } as const satisfies Record<
  LoginHandler["kind"],
  number
>;

/**
 * How long the page after a recipe's final `advance` step must keep showing a sign-in input,
 * on one path, before it is sent to continue the recipe (ADR 0018).
 */
export const CONTINUATION_STABLE_MS = 1000;
/**
 * How long a later document of the login waits for the continuation its earlier document
 * asked for (ADR 0018); the request itself gives up after 90 seconds.
 */
export const CONTINUATION_WAIT_MS = 100_000;

/** Custom-field values read for their shapes per generation request (ADR 0027). */
export const MAX_CUSTOM_SHAPE_READS = 32;

/** What a page without a recipe is sent with: its slots and the items that matched it. */
export type GenerationScope = {
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
 * A message to a login document that went unanswered, mostly because the document is gone:
 * a submit or a redirect replaced it, or its tab closed. Its replacement resumes the login.
 * `reason` keeps what the browser said: no listener was left, or the page went into the
 * back/forward cache (`no-receiver`), the listener did not answer, as when the document
 * unloads while it handles the message or a content script fault leaves it unanswered
 * (`port-closed`), or anything else (`send-failed`).
 */
export class DocumentGone extends Error {
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
export function choiceBadge(
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
export type Choice = {
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
