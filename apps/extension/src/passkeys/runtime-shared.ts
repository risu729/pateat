import { senderDocumentOrigin } from "../messaging/sender";

import { type PasskeyPolicy } from "./policy";

import { type RelatedOrigins } from "./related-origins";
import { type PasskeyCandidate, type PasskeyCandidates, type PasskeyDisplay } from "./select";
import { CHOOSER_MAX_WAIT_MS, CHOOSER_MIN_WAIT_MS, type RuntimeResult } from "./wire";

/** The browser-supplied sender of a bridge message. */
export type Sender = {
  id?: string | undefined;
  tab?: { id?: number | undefined; incognito?: boolean | undefined } | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
  documentLifecycle?: string | undefined;
  origin?: string | undefined;
  url?: string | undefined;
};

/** One vault item, by its local connection. */
export type PasskeyItem = { readonly connectionId: string; readonly itemId: string };

/** Account-bound credential source. It owns site policy and keeps private keys out of this layer. */
export interface PasskeySource<TCandidate extends PasskeyCandidate = PasskeyCandidate> {
  /**
   * Stored passkeys with this RP ID that may answer this origin, or none if not permitted;
   * with `only`, just that item's.
   */
  candidates(
    origin: string,
    rpId: string,
    signal: AbortSignal,
    only?: PasskeyItem,
  ): Promise<PasskeyCandidates<TCandidate> | undefined>;
  /**
   * The RP IDs of the item's stored passkeys, each once, for a related origins check (ADR
   * 0084); undefined when they cannot be read, as in a locked vault.
   */
  rpIds?(item: PasskeyItem): Promise<readonly string[] | undefined>;
  sign(
    candidate: TCandidate,
    authenticatorData: Uint8Array<ArrayBuffer>,
    clientDataHash: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  /**
   * Whether a master password is right for the candidate's account, before a `reprompt`
   * candidate signs; throws when the vault cannot tell. Without it such a candidate never signs.
   */
  verifyMasterPassword?(candidate: TCandidate, password: string): Promise<boolean>;
}

/** What the user did in the chooser window, by position in the offered list. */
export type PasskeyChoice =
  | { readonly kind: "chosen"; readonly index: number; readonly makeDefault: boolean }
  /**
   * "Use the browser": "Just once" (`browser`) or "Always for this site" (`browser-site`);
   * or the window was closed, or it could not be shown.
   */
  | { readonly kind: "browser" | "browser-site" | "closed" | "unavailable" };

/** What a request did besides its answer, told once it was handed back. */
export type After<TCandidate> = {
  /** The passkey chosen in the window, to save as the site default. */
  remember?: TCandidate;
  /** The passkey that signed the assertion. */
  signed?: TCandidate;
  /** Signed with no login of the tab and no choice in the window. */
  silent?: true;
  /** "Always for this site" was chosen: the hostname joins the browser's sites (ADR 0007). */
  browserSite?: true;
};

/** Opens Pateat's chooser window for one request (ADR 0021) and settles when it is answered. */
export interface PasskeyChooser {
  choose(input: {
    readonly tabId: number;
    readonly origin: string;
    readonly rpId: string;
    /**
     * The site default, if offered, comes first and is `preferred`. A `reprompt` entry is
     * chosen only after `verify` accepts the master password typed for it.
     */
    readonly entries: readonly (PasskeyDisplay & {
      readonly preferred?: boolean;
      readonly reprompt?: boolean;
    })[];
    /** Whether a master password typed for the entry at `index` is right; throws if unknown. */
    readonly verify?: (index: number, password: string) => Promise<boolean>;
    /** The window asks the master password for a password login's one entry (ADR 0021). */
    readonly purpose?: "login";
    /** The origin has a site default; making another passkey default replaces it. */
    readonly replacesDefault: boolean;
    /**
     * Automatic login of the site is paused (ADR 0062): the window opens for any match, no
     * entry is the default, and a choice stays for this sign-in unless the person ticks the box.
     */
    readonly paused?: boolean;
    /** Aborted when the request ends any other way; the window then closes. */
    readonly signal: AbortSignal;
  }): Promise<PasskeyChoice>;
}

/**
 * How long the chooser may keep a request open, from when the background received it: the
 * caller's `timeout`, raised to `CHOOSER_MIN_WAIT_MS`, and never past `CHOOSER_MAX_WAIT_MS`.
 */
export function chooserWaitMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return CHOOSER_MAX_WAIT_MS;
  return Math.min(Math.max(timeoutMs, CHOOSER_MIN_WAIT_MS), CHOOSER_MAX_WAIT_MS);
}

/**
 * Value-free account of one bridged request, for the extension's own console only: the outcome or
 * delegate reason, and how many stored passkeys the vault returned, the request accepted and the
 * site default named. Credential IDs, user handles and item IDs are never included.
 */
export interface PasskeyRequestReport {
  /** The requesting tab, which paces how many reports one page can cause. */
  readonly tabId: number;
  readonly origin: string;
  readonly outcome: RuntimeResult["kind"];
  readonly reason?: string;
  readonly rpId?: string;
  readonly allowCredentials?: number;
  readonly stored?: number;
  readonly accepted?: number;
  readonly siteDefault?: number;
  readonly siteDefaultAccepted?: number;
  readonly siteDefaultItem?: PasskeyCandidates["siteDefault"];
  readonly complete?: boolean;
  /**
   * How the chooser window ended, when one was opened: a choice, or the request's wait running
   * out (`timeout`) or the request being cancelled (`cancelled`) while it was open.
   */
  readonly chooser?: PasskeyChoice["kind"] | "timeout" | "cancelled";
  /** The site treated its saved default as unset, so the chooser asked (ADR 0063). */
  readonly defaultUnset?: boolean;
  /** The request's mediation, when it names one (ADR 0034). */
  readonly mediation?: "optional" | "conditional" | "required" | "silent" | "immediate" | "other";
  readonly uiMode?: "immediate";
  /**
   * Why the login's item could not answer a conditional request the login gave it, which
   * then waited for that login again (ADR 0034).
   */
  readonly answerFailed?: string;
  /**
   * A delegated request came while a login of the tab and origin had not ended, so another
   * provider, such as the Bitwarden extension, may have shown its prompt during that login.
   */
  readonly duringLogin?: boolean;
  /**
   * Automatic login of the page's site was paused (ADR 0062), so the request was answered only
   * through the chooser window, or handed on when it could not open.
   */
  readonly paused?: boolean;
  /**
   * Why a request was `cancelled` (the page cancelled it, or settings changed) or which step
   * threw for an `assertion-failed` delegation (ADR 0019).
   */
  readonly cause?: PasskeyStopCause;
  /**
   * For an `invalid-request` delegation, the request member that broke its bounds and that
   * member's size, never its value.
   */
  readonly invalid?: string;
  readonly invalidLength?: number;
}
/**
 * Who cancelled a request (`page-cancelled`, `settings-changed`), or the step that threw:
 * the check for a site whose requests go to the browser, the wait for a login's decision on
 * a conditional request, the login's account lookup, the passkey lookup, the chooser
 * window, or signing.
 */
export type PasskeyStopCause =
  | "page-cancelled"
  | "settings-changed"
  | "browser-site-lookup"
  | "login-wait"
  | "account-lookup"
  | "passkey-lookup"
  | "chooser"
  | "signing";
export type ReportDetail = {
  -readonly [
    K in Exclude<keyof PasskeyRequestReport, "tabId" | "origin" | "outcome" | "reason">
  ]?: PasskeyRequestReport[K];
};

const MEDIATIONS = ["optional", "conditional", "required", "silent", "immediate"] as const;
/** A request's mediation for its report, never the page's own text; none when it names none. */
export function mediationOf(request: unknown): PasskeyRequestReport["mediation"] {
  if (typeof request !== "object" || request === null || !("mediation" in request))
    return undefined;
  const { mediation } = request;
  if (mediation === undefined) return undefined;
  return MEDIATIONS.find((entry) => entry === mediation) ?? "other";
}

/**
 * What the login runtime decides for a `conditional` request (ADR 0034): answer it with the
 * item of the login of its page, which is told whether the answer went back; hand it on,
 * with why; or withhold it after that login signed in.
 */
export type ConditionalDecision =
  | {
      readonly kind: "answer";
      readonly item: PasskeyItem;
      readonly answered: (signed: boolean) => void;
    }
  | { readonly kind: "delegate"; readonly reason: string }
  | { readonly kind: "withhold" };

export const MAX_OPERATIONS = 32;
/** One document cannot exhaust the shared operation budget. */
export const MAX_DOCUMENT_OPERATIONS = 4;

/**
 * The origin of a bridge message's top document, from the browser-supplied sender only:
 * frame 0 of a tab, with a document ID, whose URL has that origin.
 */
export function senderOrigin(sender: Sender, extensionId: string): string | undefined {
  if (
    sender.id !== extensionId ||
    sender.tab?.id === undefined ||
    sender.frameId !== 0 ||
    typeof sender.documentId !== "string"
  )
    return undefined;
  return senderDocumentOrigin(sender);
}

/** Thrown once the list shows the request's hostname as one whose requests go to the browser. */
export class ListedSite extends Error {}

/** Settles with `pending`, or rejects with the signal's reason once it aborts. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export type PasskeyRuntimeOptions<TCandidate extends PasskeyCandidate> = {
  extensionId: string;
  timeoutMs?: () => number;
  /**
   * Per-origin presence and verification policy; the initial policy when absent. Read
   * for each request, so a changed setting applies to the next one.
   */
  policy?: (origin: string) => PasskeyPolicy | Promise<PasskeyPolicy>;
  /** Receives a value-free report of each finished request. */
  report?: (report: PasskeyRequestReport) => void;
  /**
   * Asks the user when several passkeys match and no site default is among them, or for any
   * match on a paused site (ADR 0062).
   */
  chooser?: PasskeyChooser;
  /**
   * Whether the origin's hostname is one whose passkey requests go to the browser, added by
   * the chooser's "Always for this site" (ADR 0007). Such a request is handed on whatever
   * its mediation. The list is read alongside the first lookups, so the request's deadline
   * runs as it would without it, and is awaited before any signing, chooser or login wait.
   */
  browserSite?: (origin: string) => Promise<boolean> | boolean;
  /**
   * Adds the origin's hostname to those sites when the person chose "Always for this site".
   * Called only after the request was handed on, because a settings save cancels pending
   * passkey requests.
   */
  addBrowserSite?: (origin: string) => Promise<void>;
  /**
   * Saves a passkey chosen in the window as the origin's site default. Called only after the
   * assertion was handed back, because a settings save cancels pending passkey requests.
   */
  remember?: (origin: string, candidate: TCandidate) => Promise<void>;
  /**
   * The vault item of a login that has not ended in this tab and origin (ADR 0027). Its
   * request is answered with that item only, never the site default or the chooser.
   */
  loginAccount?: (
    tabId: number,
    origin: string,
  ) => Promise<PasskeyItem | undefined> | PasskeyItem | undefined;
  /**
   * Told of each request of a top document that does not wait for an autofill choice
   * (conditional mediation), so a login can tell that the page asked for a passkey after
   * its submission (ADR 0029: S5). Never changes the answer.
   */
  requested?: (tabId: number, origin: string) => void;
  /**
   * Told of each assertion returned to a page, with the RP ID it was made for and the
   * passkey that signed it, so a login that then moves to that site's other origin can
   * complete (ADR 0022). Never changes the answer.
   */
  answered?: (
    tabId: number,
    origin: string,
    rpId: string,
    signed: TCandidate,
    /**
     * `silent` when Pateat signed by itself, with no login of the tab and no choice in the
     * chooser window, which the relogin guard counts (ADR 0062); the tab's window kind; the
     * top document the assertion went to.
     */
    facts?: { silent?: true; incognito: boolean; documentId: string },
  ) => void;
  /**
   * Whether a request of the origin treats the site's saved default as unset: the person's
   * own request, of no running login, then opens the chooser with every passkey that fits
   * and none preselected, also for one passkey (ADR 0063: a site that asks every time after
   * a pick that did not make its account the default). `paused` does the same for a site
   * whose automatic login is paused (ADR 0062): the window says so, and where it cannot open
   * the request is handed on as `paused`. A conditional request never gets here without a
   * login, so it is handed on as before. A value that cannot be read counts as false.
   */
  defaultUnset?: (
    origin: string,
    incognito: boolean,
  ) => Promise<boolean | "paused"> | boolean | "paused";
  /**
   * Whether the tab's Pateat login of the origin signed in and no logout was detected
   * since. A request there that names its credentials is a re-verification while signed
   * in, a `confirm` page, on which Pateat never presses; it is handed on (ADR 0035).
   */
  reverification?: (tabId: number, origin: string, rpId: string) => Promise<boolean>;
  /**
   * Decides a `conditional` request of a top document through the login of its page
   * (ADR 0034). Without it, conditional requests are handed on (ADR 0007).
   */
  conditional?: (input: {
    tabId: number;
    origin: string;
    documentId: string;
    signal: AbortSignal;
    /** Whether the page's tab is incognito, as its sender says; it keeps its own pauses. */
    incognito: boolean;
  }) => Promise<ConditionalDecision>;
  /**
   * Reads whether an RP lists the page's origin, for a request whose RP ID belongs to
   * another site (WebAuthn related origins, ADR 0084). Without it such a request is handed
   * on, as before.
   */
  relatedOrigins?: RelatedOrigins;
  /**
   * Holds vault replacement off while the vault is read and signed with for a request,
   * until the returned function is called (ADR 0025).
   */
  hold?: () => Promise<() => void>;
};

export type Operation = {
  documentId: string;
  controller: AbortController;
  /** The chooser window opened for it, so a person decides or has decided. */
  asked: boolean;
  /** The window is open, waiting for that person. */
  choosing: boolean;
  /** Who cancelled the operation, for its report. */
  cancelledBy?: "page-cancelled" | "settings-changed";
  /** A conditional request waiting for a login's decision, which reads no settings yet. */
  parked: boolean;
};
