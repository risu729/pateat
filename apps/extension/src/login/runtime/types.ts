import {
  type DetailLink,
  type LoginFieldTarget,
  type LoginDetail,
  type LoginChoiceAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginOperation,
  type LoginChooserRecipe,
  type LoginRecipe,
  type PasswordStopMiss,
  type SavedLoginBinding,
  type SemanticSlot,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { type Browser } from "wxt/browser";
import { type LoginReadiness, type TargetState } from "../wire";
import { type AskReason } from "../choice-wire";
import { type CustomFieldOffer } from "../generation-slots";
import { type EntryMiss, type OtherMiss } from "../../page/account-list";
import { type SignInDecision } from "../sign-in-state";
import type { ConditionalDecision } from "../../passkeys/runtime";
import { type MoveMiss } from "./report";
import { type PairedQuestion, type PendingChoice } from "./session-schemas";

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
  /**
   * The page shows a password input (S2) and no CAPTCHA (S4): after an `advance` whose next
   * step never showed, the page a repair continues (ADR 0041 section 4).
   */
  asksPassword?: true;
};

/** Why the page after an entry press blocked its recipe revision (ADR 0031). */
export type EntryBlockReason = "left-site" | "no-sign-in" | "sign-up";

export type Sender = Browser.runtime.MessageSender;

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
 * A document's time before its login's attempt exists (ADR 0019): `AttemptTiming` without
 * a running wait or a wait for the site.
 */
export type StartTiming = { since: number; serviceMs: number; networkMs: number; personMs: number };

export type LiveDocument = {
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
  /**
   * The document's path after a same-document URL change it reported since it announced
   * (`login.document.moved`), as the tab's URL shows it (ADR 0027 amendment of 2026-10-25).
   */
  route?: string;
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
   * A new login of this top document was refused, or waits for a repair, because its recipe
   * lacks the `passkey` route while its item holds a discoverable passkey: the page's own
   * conditional request, when it comes, waits for that repair and then has the document
   * announce again, so the login answers it (ADR 0034 amendment of 2026-10-25).
   */
  awaitsPageRequest?: true;
  /** That document's repair runs (ADR 0058 A). */
  repairing?: true;
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
export type ConfirmVisit = {
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

/** Why a page offered for generation is not sent, for the log (ADR 0019). */
export type GenerationMiss = "no-vault-match" | "vault-unavailable" | "connection-disabled";

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

/** A saved link's field that a login reads only after the master password (ADR 0061). */
export type DetailWait = {
  detail: LoginDetail;
  itemId: string;
  fieldId: string;
  /** The waiting field's inputs, so its fill goes to that field and no other. */
  targets: LoginFieldTarget[];
};

export type DetailSourceField = DetailLink["source"]["field"];

export type Execution = {
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
   * The path the login's document showed when it was last observed, which a watch that
   * begins there keeps (ADR 0027 amendment of 2026-10-25).
   */
  readPath?: { documentId: string; path: string };
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
export type ParkedRequest = {
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
  /**
   * When its document last waited for a repair or was asked to announce again for it, from
   * which a login of the document may still take `REQUEST_START_WAIT_MS` to start.
   */
  restarted?: number;
  settle(decision: ConditionalDecision): boolean;
};

/**
 * A popup choice offered to a tab's top document outside an ask, on a recipe without a
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
export type LaterStart = { variants: Map<number, number[]>; partial: Set<string>; button: boolean };

export type LayoutChoice = {
  recipe: LoginRecipe;
  later?: LaterStart | undefined;
};

/**
 * A keypad fill whose page told of its first key press (ADR 0067): its operation and plan
 * step, and whether it went in.
 */
export interface KeypadPress {
  operationId: string;
  stepIndex: number;
  filled?: true;
}

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
  catalog: VaultCatalog;
  /** Every enabled connection answered and every item's URI rules were evaluated. */
  complete: boolean;
};

/** The items that matched a page and the settings they were matched under. */
export type VaultMatch = Pick<GenerationScope, "items" | "settings" | "catalog">;
