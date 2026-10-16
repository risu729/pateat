import * as v from "valibot";
import { senderDocumentOrigin } from "../messaging/sender";
import { createPasskeyAssertion } from "./assertion";
import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "./policy";
import { admitGetRequest, describeInvalidRequest } from "./request";
import {
  matchingPasskeys,
  selectPasskey,
  type PasskeyCandidate,
  type PasskeyCandidates,
  type PasskeyDisplay,
} from "./select";
import type { SignedTabs } from "./signed-tabs";
import {
  CHOOSER_MAX_WAIT_MS,
  CHOOSER_MIN_REMAINING_MS,
  CHOOSER_MIN_WAIT_MS,
  RUNTIME_TIMEOUT_MS,
  runtimeMessageSchema,
  type RuntimeResult,
} from "./wire";

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
  sign(
    candidate: TCandidate,
    authenticatorData: Uint8Array<ArrayBuffer>,
    clientDataHash: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

/** What the user did in the chooser window, by position in the offered list. */
export type PasskeyChoice =
  | { readonly kind: "chosen"; readonly index: number; readonly makeDefault: boolean }
  /** "Use the browser" was pressed, the window was closed, or it could not be shown. */
  | { readonly kind: "browser" | "closed" | "unavailable" };

/** Opens Pateat's chooser window for one request (ADR 0021) and settles when it is answered. */
export interface PasskeyChooser {
  choose(input: {
    readonly tabId: number;
    readonly origin: string;
    readonly rpId: string;
    /** The site default, if offered, comes first and is `preferred`. */
    readonly entries: readonly (PasskeyDisplay & { readonly preferred?: boolean })[];
    /** The origin has a site default; making another passkey default replaces it. */
    readonly replacesDefault: boolean;
    /** Pateat signed for this RP ID in this tab before, so this may follow a logout. */
    readonly again: boolean;
    /** With `again`: the person clicked a control that logs out on the site in this tab. */
    readonly loggedOut?: boolean;
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
  /** Pateat signed for this RP ID in this tab before, so the request asks again. */
  readonly signedBefore?: boolean;
  /** A control that logs out was clicked on the site in this tab, so the request asks. */
  readonly logoutClicked?: boolean;
  /** The request's mediation, when it names one (ADR 0034). */
  readonly mediation?: "optional" | "conditional" | "required" | "silent" | "immediate" | "other";
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
 * the wait for a login's decision on a conditional request, the login's account lookup,
 * the passkey lookup, the check for an earlier signing in the tab, the chooser window, or
 * signing.
 */
export type PasskeyStopCause =
  | "page-cancelled"
  | "settings-changed"
  | "login-wait"
  | "account-lookup"
  | "passkey-lookup"
  | "signed-before-lookup"
  | "chooser"
  | "signing";
type ReportDetail = {
  -readonly [
    K in Exclude<keyof PasskeyRequestReport, "tabId" | "origin" | "outcome" | "reason">
  ]?: PasskeyRequestReport[K];
};

const MEDIATIONS = ["optional", "conditional", "required", "silent", "immediate"] as const;
/** A request's mediation for its report, never the page's own text; none when it names none. */
function mediationOf(request: unknown): PasskeyRequestReport["mediation"] {
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

const MAX_OPERATIONS = 32;
/** One document cannot exhaust the shared operation budget. */
const MAX_DOCUMENT_OPERATIONS = 4;

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

/** Settles with `pending`, or rejects with the signal's reason once it aborts. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Background coordinator for bridged `get()` requests. Every outcome but an assertion delegates,
 * except a chooser window left unanswered until the request's wait ran out, which fails, and a
 * conditional request withheld after a login of its page signed in (ADR 0034).
 */
export function createPasskeyRuntime<TCandidate extends PasskeyCandidate>(
  source: PasskeySource<TCandidate>,
  options: {
    extensionId: string;
    timeoutMs?: () => number;
    /** Per-origin presence and verification policy; the initial policy when absent. */
    policy?: (origin: string) => PasskeyPolicy;
    /** Receives a value-free report of each finished request. */
    report?: (report: PasskeyRequestReport) => void;
    /** Asks the user when several passkeys match and no site default is among them. */
    chooser?: PasskeyChooser;
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
    answered?: (tabId: number, origin: string, rpId: string, signed: TCandidate) => void;
    /** Where Pateat signed before; a username-less request there asks again (ADR 0021 D). */
    signedTabs?: SignedTabs;
    /**
     * Whether a control that logs out was clicked on the RP ID's site in the tab, and its
     * first step has not shown since; a username-less request there asks too (ADR 0021 D).
     */
    logoutClicked?: (tabId: number, rpId: string) => Promise<boolean>;
    /**
     * Decides a `conditional` request of a top document through the login of its page
     * (ADR 0034). Without it, conditional requests are handed on (ADR 0007).
     */
    conditional?: (input: {
      tabId: number;
      origin: string;
      documentId: string;
      signal: AbortSignal;
    }) => Promise<ConditionalDecision>;
    /**
     * Holds vault replacement off while the vault is read and signed with for a request,
     * until the returned function is called (ADR 0025).
     */
    hold?: () => Promise<() => void>;
  },
) {
  type Operation = {
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
  const operations = new Map<string, Operation>();
  const settingsChanged = () => {
    for (const [id, operation] of operations) {
      // A person deciding is not interrupted; their choice is checked against the new settings.
      // A conditional request waiting for a login is not either: the login follows the
      // settings, and its answer is looked up under them (ADR 0034).
      if (operation.asked || operation.parked) continue;
      operation.cancelledBy ??= "settings-changed";
      operation.controller.abort();
      operations.delete(id);
    }
  };

  async function get(
    message: { operationId: string; request: unknown; userActivation: boolean; focused: boolean },
    origin: string,
    context: { documentId: string; tabId: number; incognito: boolean; active: boolean },
    detail: ReportDetail,
    after: { remember?: TCandidate; signed?: TCandidate },
  ): Promise<RuntimeResult> {
    const { documentId } = context;
    const documentOperations = [...operations.values()].filter(
      (operation) => operation.documentId === documentId,
    ).length;
    if (
      operations.has(message.operationId) ||
      operations.size >= MAX_OPERATIONS ||
      documentOperations >= MAX_DOCUMENT_OPERATIONS
    )
      return { kind: "delegate", reason: "busy" };
    const admission = admitGetRequest({
      origin,
      request: message.request,
      userActivation: message.userActivation,
      policy: options.policy?.(origin) ?? INITIAL_PASSKEY_POLICY,
      conditional: options.conditional !== undefined,
    });
    if (admission.kind === "delegate") {
      if (admission.reason === "invalid-request") {
        const invalid = describeInvalidRequest(message.request);
        if (invalid) {
          detail.invalid = invalid.member;
          if (invalid.length !== undefined) detail.invalidLength = invalid.length;
        }
      }
      return admission;
    }
    detail.rpId = admission.request.rpId;
    detail.allowCredentials = admission.request.allowCredentialIds.length;
    const conditional = admission.request.conditional === true;
    const controller = new AbortController();
    const operation: Operation = {
      documentId,
      controller,
      asked: false,
      choosing: false,
      parked: false,
    };
    operations.set(message.operationId, operation);
    const received = Date.now();
    const expire = () =>
      controller.abort(new DOMException("Passkey bridge timed out", "TimeoutError"));
    const budget = () => options.timeoutMs?.() ?? RUNTIME_TIMEOUT_MS;
    // A conditional request gets its budget once a login answers it (ADR 0034).
    let timer = conditional ? undefined : setTimeout(expire, budget());
    // The step running when something threw, for the report.
    let step: PasskeyStopCause = conditional ? "login-wait" : "account-lookup";
    // Vault replacement waits while the vault is read for this request, never while a
    // conditional request waits for a login (ADR 0025, ADR 0034).
    let leave: (() => void) | undefined;
    const hold = async (signal: AbortSignal) => {
      const entering = Promise.resolve(options.hold?.());
      try {
        leave = await abortable(entering, signal);
      } catch (error) {
        void entering.then((late) => late?.());
        throw error;
      }
    };
    /** Looks the request up for the login's item, or for any item, and signs (ADR 0007). */
    const answer = async (
      login: PasskeyItem | undefined,
      signal: AbortSignal,
    ): Promise<RuntimeResult> => {
      step = "passkey-lookup";
      const candidates = await abortable(
        login
          ? source.candidates(origin, admission.request.rpId, signal, login)
          : source.candidates(origin, admission.request.rpId, signal),
        signal,
      );
      if (!candidates) return { kind: "delegate", reason: "not-configured" };
      const accepted = matchingPasskeys(admission.request, candidates.candidates);
      detail.stored = candidates.candidates.length;
      detail.accepted = accepted.length;
      detail.siteDefault = candidates.candidates.filter((entry) => entry.preferred === true).length;
      detail.siteDefaultAccepted = accepted.filter((entry) => entry.preferred === true).length;
      if (candidates.siteDefault) detail.siteDefaultItem = candidates.siteDefault;
      detail.complete = candidates.complete;
      const selection = selectPasskey(admission.request, candidates);
      step = "signed-before-lookup";
      // ADR 0021 D: a username-less request in a tab Pateat already signed in from may follow
      // a logout, so it asks even for one match or a site default; so does one after a
      // control that logs out was clicked there. Named credentials, as in a
      // re-authentication, still sign silently. A running login never asks (ADR 0027).
      const usernameLess =
        !login &&
        options.chooser !== undefined &&
        admission.request.allowCredentialIds.length === 0;
      const signedBefore =
        usernameLess &&
        (await abortable(
          options.signedTabs?.has(context.tabId, admission.request.rpId) ?? Promise.resolve(false),
          signal,
        ));
      const loggedOut =
        usernameLess &&
        !signedBefore &&
        (await abortable(
          options.logoutClicked?.(context.tabId, admission.request.rpId) ?? Promise.resolve(false),
          signal,
        ));
      const again = signedBefore || loggedOut;
      if (signedBefore) detail.signedBefore = true;
      if (loggedOut) detail.logoutClicked = true;
      const signWith = (candidate: TCandidate) => {
        step = "signing";
        return abortable(
          createPasskeyAssertion(admission.request, candidate, (data, hash) =>
            source.sign(candidate, data, hash, signal),
          ),
          signal,
        );
      };
      type Signed = { credential: TCandidate; assertion: Awaited<ReturnType<typeof signWith>> };
      // Looks the chosen passkey up under the current settings and signs with it. A lookup or
      // signing that throws, as when settings change meanwhile, gets one more try.
      const signCurrent = async (
        credentialId: string,
        retry: boolean,
      ): Promise<Signed | { reason: string }> => {
        try {
          step = "passkey-lookup";
          const current = await abortable(
            source.candidates(origin, admission.request.rpId, signal),
            signal,
          );
          const same = current
            ? matchingPasskeys(admission.request, current.candidates).filter(
                (entry) => entry.credentialId === credentialId && entry.counter === 0,
              )
            : [];
          if (same.length !== 1)
            return {
              reason: current?.complete === false ? "vault-incomplete" : "settings-changed",
            };
          const candidate = same[0]!;
          return { credential: candidate, assertion: await signWith(candidate) };
        } catch (error) {
          if (signal.aborted || !retry) throw error;
          return signCurrent(credentialId, false);
        }
      };
      let credential: TCandidate;
      let assertion: Signed["assertion"] | undefined;
      let makeDefault = false;
      if (selection.kind === "credential" && !again) credential = selection.credential;
      // A login's item answers alone; otherwise the browser or Bitwarden does, so Pateat
      // never signs in as another account.
      else if (login && selection.kind === "delegate")
        return { kind: "delegate", reason: `login-item-${selection.reason}` };
      else {
        // Only passkeys Pateat can sign with are offered, the site default first. Without
        // `again`, fewer than two is not a choice.
        const offered = accepted
          .filter((entry) => entry.counter === 0)
          .sort((a, b) => Number(b.preferred === true) - Number(a.preferred === true));
        if (
          selection.kind === "delegate" &&
          (again
            ? offered.length === 0
            : selection.reason !== "ambiguous-credential" || offered.length < 2)
        )
          return selection;
        // An unsearched item might hold the passkey the person signed out to switch to.
        if (!candidates.complete) return { kind: "delegate", reason: "vault-incomplete" };
        const remaining = received + chooserWaitMs(admission.request.timeoutMs) - Date.now();
        if (
          !options.chooser ||
          // An extension window would open outside the incognito window (ADR 0021).
          context.incognito ||
          // A background tab or a prerendered page never pulls a window to the front.
          !message.focused ||
          !context.active ||
          remaining < CHOOSER_MIN_REMAINING_MS
        )
          // After a logout Pateat never signs unasked; the browser can still offer a choice.
          return {
            kind: "delegate",
            reason: again ? "chooser-unavailable" : "ambiguous-credential",
          };
        // The window waits for a person, so the lookup budget no longer applies.
        clearTimeout(timer);
        timer = setTimeout(expire, remaining);
        operation.asked = true;
        operation.choosing = true;
        step = "chooser";
        const choice = await abortable(
          options.chooser.choose({
            tabId: context.tabId,
            origin,
            rpId: admission.request.rpId,
            entries: offered.map((entry, index) => ({
              ...(entry.display ?? { item: `Passkey ${index + 1}` }),
              ...(entry.preferred === true ? { preferred: true } : {}),
            })),
            replacesDefault:
              candidates.siteDefault !== undefined && candidates.siteDefault !== "unset",
            again,
            ...(loggedOut ? { loggedOut } : {}),
            signal,
          }),
          signal,
        );
        operation.choosing = false;
        detail.chooser = choice.kind;
        if (choice.kind !== "chosen") return { kind: "delegate", reason: `chooser-${choice.kind}` };
        const chosen = offered[choice.index];
        if (!chosen) return { kind: "delegate", reason: "chooser-invalid" };
        // Signing gets its own budget, so a choice made near the deadline still answers.
        clearTimeout(timer);
        timer = setTimeout(expire, options.timeoutMs?.() ?? RUNTIME_TIMEOUT_MS);
        // Settings may have changed while the person decided, by a sync, a save or another
        // tab's login, and signing refuses a candidate from older settings. So the chosen
        // passkey is looked up again and used only if the current settings still offer it.
        const signed = await signCurrent(chosen.credentialId, true);
        if ("reason" in signed) return { kind: "delegate", reason: signed.reason };
        ({ credential, assertion } = signed);
        // The site default is saved already.
        makeDefault = choice.makeDefault && credential.preferred !== true;
      }
      assertion ??= await signWith(credential);
      if (signal.aborted) {
        if (operation.cancelledBy) detail.cause = operation.cancelledBy;
        return { kind: "cancelled" };
      }
      if (makeDefault) after.remember = credential;
      after.signed = credential;
      return { kind: "assertion", assertion };
    };
    // Told whether the answer of a login's conditional request went back (ADR 0034).
    let answered: ((signed: boolean) => void) | undefined;
    // A conditional request waits for the login of its page, if one starts or runs, which
    // answers it with its own item, hands it on or withholds it (ADR 0034).
    const waitForLogin = async (signal: AbortSignal): Promise<RuntimeResult> => {
      step = "login-wait";
      operation.parked = true;
      const decision = await abortable(
        Promise.try(() =>
          options.conditional!({ tabId: context.tabId, origin, documentId, signal }),
        ),
        signal,
      );
      operation.parked = false;
      if (decision.kind === "delegate") return { kind: "delegate", reason: decision.reason };
      if (decision.kind === "withhold") return { kind: "withheld" };
      answered = decision.answered;
      step = "passkey-lookup";
      await hold(signal);
      timer = setTimeout(expire, budget());
      let result: RuntimeResult;
      try {
        result = await answer(decision.item, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        detail.cause = step;
        result = { kind: "delegate", reason: "assertion-failed" };
      }
      const signed = result.kind === "assertion";
      answered(signed);
      answered = undefined;
      if (signed || signal.aborted) return result;
      // The login takes its password route instead; the request waits for that login
      // again, which never answers it twice.
      detail.answerFailed = result.kind === "delegate" ? result.reason : result.kind;
      clearTimeout(timer);
      timer = undefined;
      leave?.();
      leave = undefined;
      return waitForLogin(signal);
    };
    try {
      const signal = controller.signal;
      if (conditional) return await waitForLogin(signal);
      await hold(signal);
      // A failed lookup fails closed: the catch below delegates.
      return await answer(await options.loginAccount?.(context.tabId, origin), signal);
    } catch {
      answered?.(false);
      const reason = controller.signal.reason as unknown;
      const timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
      if (operation.choosing && controller.signal.aborted) {
        detail.chooser = timedOut ? "timeout" : "cancelled";
        // The person did not choose in time. As with the browser's own prompt, the request
        // fails instead of opening another prompt (ADR 0021).
        if (timedOut) return { kind: "not-allowed" };
      }
      if (timedOut) return { kind: "delegate", reason: "timeout" };
      if (controller.signal.aborted) {
        if (operation.cancelledBy) detail.cause = operation.cancelledBy;
        return { kind: "cancelled" };
      }
      detail.cause = step;
      return { kind: "delegate", reason: "assertion-failed" };
    } finally {
      clearTimeout(timer);
      leave?.();
      operations.delete(message.operationId);
    }
  }

  return {
    /**
     * Settings changed, so in-flight operations no longer follow them and are cancelled. One
     * that opened the chooser window is left to its person; the passkey chosen there is looked
     * up again under the settings current then.
     */
    settingsChanged,
    async handle(message: unknown, sender: Sender): Promise<RuntimeResult | { ok: boolean }> {
      const parsed = v.safeParse(runtimeMessageSchema, message);
      const origin = senderOrigin(sender, options.extensionId);
      if (!parsed.success || !origin) return { kind: "delegate", reason: "invalid-sender" };
      const command = parsed.output;
      if (command.type === "passkey.cancel") {
        const operation = operations.get(command.operationId);
        if (!operation || operation.documentId !== sender.documentId) return { ok: false };
        operation.cancelledBy ??= "page-cancelled";
        operation.controller.abort();
        return { ok: true };
      }
      const { request } = command;
      // Read as the request comes in, for the report only; the answer never waits for it.
      const loginAtEntry = Promise.try(() => options.loginAccount?.(sender.tab!.id!, origin)).catch(
        () => undefined,
      );
      if (
        !(typeof request === "object" && request !== null && "mediation" in request) ||
        request.mediation !== "conditional"
      )
        try {
          options.requested?.(sender.tab!.id!, origin);
        } catch {
          // Never changes the answer.
        }
      const detail: ReportDetail = {};
      const after: { remember?: TCandidate; signed?: TCandidate } = {};
      const result = await get(
        command,
        origin,
        {
          documentId: sender.documentId!,
          tabId: sender.tab!.id!,
          incognito: sender.tab?.incognito === true,
          // A prerendered or cached document never gets a window.
          active: sender.documentLifecycle === "active",
        },
        detail,
        after,
      );
      if (result.kind === "assertion" && detail.rpId !== undefined && after.signed)
        try {
          options.answered?.(sender.tab!.id!, origin, detail.rpId, after.signed);
        } catch {
          // Never changes the answer.
        }
      if (result.kind === "assertion" && detail.rpId !== undefined && options.signedTabs) {
        const signedTabs = options.signedTabs;
        const rpId = detail.rpId;
        // Recorded as the assertion goes back; a later username-less request then asks again.
        void signedTabs.add(sender.tab!.id!, rpId).catch(() => undefined);
      }
      const remembered = after.remember;
      const mediation = mediationOf(request);
      if (mediation) detail.mediation = mediation;
      if (remembered && options.remember) {
        const remember = options.remember;
        // After the reply is on its way: saving settings cancels pending passkey requests.
        setTimeout(() => void remember(origin, remembered).catch(() => undefined), 0);
      }
      const report = (login?: unknown) => {
        try {
          options.report?.({
            ...detail,
            // senderOrigin() accepted only a sender with a tab.
            tabId: sender.tab!.id!,
            origin,
            outcome: result.kind,
            ...(result.kind === "delegate" ? { reason: result.reason } : {}),
            ...(login ? { duringLogin: true } : {}),
          });
        } catch {
          // A report must never change the answer.
        }
      };
      // A delegated request is reported once the login read as it came in is known, after
      // the reply is on its way.
      if (result.kind === "delegate") void loginAtEntry.then(report);
      else report();
      return result;
    },
  };
}
