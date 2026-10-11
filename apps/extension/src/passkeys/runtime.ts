import * as v from "valibot";
import { createPasskeyAssertion } from "./assertion";
import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "./policy";
import { admitGetRequest } from "./request";
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

type Sender = {
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
  /** How the chooser window ended, when one was opened. */
  readonly chooser?: PasskeyChoice["kind"];
  /** Pateat signed for this RP ID in this tab before, so the request asks again. */
  readonly signedBefore?: boolean;
}
type ReportDetail = {
  -readonly [
    K in Exclude<keyof PasskeyRequestReport, "tabId" | "origin" | "outcome" | "reason">
  ]?: PasskeyRequestReport[K];
};

const MAX_OPERATIONS = 32;
/** One document cannot exhaust the shared operation budget. */
const MAX_DOCUMENT_OPERATIONS = 4;

function senderOrigin(sender: Sender, extensionId: string): string | undefined {
  if (
    sender.id !== extensionId ||
    sender.tab?.id === undefined ||
    sender.frameId !== 0 ||
    typeof sender.documentId !== "string" ||
    typeof sender.origin !== "string" ||
    typeof sender.url !== "string"
  )
    return undefined;
  try {
    return new URL(sender.url).origin === sender.origin ? sender.origin : undefined;
  } catch {
    return undefined;
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Background coordinator for bridged `get()` requests. Every non-assertion outcome delegates. */
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
    /** Where Pateat signed before; a username-less request there asks again (ADR 0021 D). */
    signedTabs?: SignedTabs;
  },
) {
  const operations = new Map<string, { documentId: string; controller: AbortController }>();
  const cancelAll = () => {
    for (const operation of operations.values()) operation.controller.abort();
    operations.clear();
  };

  async function get(
    message: { operationId: string; request: unknown; userActivation: boolean; focused: boolean },
    origin: string,
    context: { documentId: string; tabId: number; incognito: boolean; active: boolean },
    detail: ReportDetail,
    after: { remember?: TCandidate },
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
    });
    if (admission.kind === "delegate") return admission;
    detail.rpId = admission.request.rpId;
    detail.allowCredentials = admission.request.allowCredentialIds.length;
    const controller = new AbortController();
    operations.set(message.operationId, { documentId, controller });
    const received = Date.now();
    const expire = () =>
      controller.abort(new DOMException("Passkey bridge timed out", "TimeoutError"));
    let timer = setTimeout(expire, options.timeoutMs?.() ?? RUNTIME_TIMEOUT_MS);
    try {
      const signal = controller.signal;
      // A failed lookup fails closed: the catch below delegates.
      const login = await options.loginAccount?.(context.tabId, origin);
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
      // ADR 0021 D: a username-less request in a tab Pateat already signed in from may follow
      // a logout, so it asks even for one match or a site default. Named credentials, as in a
      // re-authentication, still sign silently. A running login never asks (ADR 0027).
      const again =
        !login &&
        options.chooser !== undefined &&
        admission.request.allowCredentialIds.length === 0 &&
        (await abortable(
          options.signedTabs?.has(context.tabId, admission.request.rpId) ?? Promise.resolve(false),
          signal,
        ));
      if (again) detail.signedBefore = true;
      let credential: TCandidate;
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
            signal,
          }),
          signal,
        );
        detail.chooser = choice.kind;
        if (choice.kind !== "chosen") return { kind: "delegate", reason: `chooser-${choice.kind}` };
        const chosen = offered[choice.index];
        if (!chosen) return { kind: "delegate", reason: "chooser-invalid" };
        credential = chosen;
        // The site default is saved already.
        makeDefault = choice.makeDefault && chosen.preferred !== true;
        // Signing gets its own budget, so a choice made near the deadline still answers.
        clearTimeout(timer);
        timer = setTimeout(expire, options.timeoutMs?.() ?? RUNTIME_TIMEOUT_MS);
      }
      const assertion = await abortable(
        createPasskeyAssertion(admission.request, credential, (data, hash) =>
          source.sign(credential, data, hash, signal),
        ),
        signal,
      );
      if (signal.aborted) return { kind: "cancelled" };
      if (makeDefault) after.remember = credential;
      return { kind: "assertion", assertion };
    } catch {
      const reason = controller.signal.reason as unknown;
      if (reason instanceof DOMException && reason.name === "TimeoutError")
        return { kind: "delegate", reason: "timeout" };
      return controller.signal.aborted
        ? { kind: "cancelled" }
        : { kind: "delegate", reason: "assertion-failed" };
    } finally {
      clearTimeout(timer);
      operations.delete(message.operationId);
    }
  }

  return {
    /** Policy, lock or connection changes invalidate every in-flight operation. */
    cancelAll,
    async handle(message: unknown, sender: Sender): Promise<RuntimeResult | { ok: boolean }> {
      const parsed = v.safeParse(runtimeMessageSchema, message);
      const origin = senderOrigin(sender, options.extensionId);
      if (!parsed.success || !origin) return { kind: "delegate", reason: "invalid-sender" };
      const command = parsed.output;
      if (command.type === "passkey.cancel") {
        const operation = operations.get(command.operationId);
        if (!operation || operation.documentId !== sender.documentId) return { ok: false };
        operation.controller.abort();
        return { ok: true };
      }
      const detail: ReportDetail = {};
      const after: { remember?: TCandidate } = {};
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
      if (result.kind === "assertion" && detail.rpId !== undefined && options.signedTabs) {
        const signedTabs = options.signedTabs;
        const rpId = detail.rpId;
        // Recorded as the assertion goes back; a later username-less request then asks again.
        void signedTabs.add(sender.tab!.id!, rpId).catch(() => undefined);
      }
      const remembered = after.remember;
      if (remembered && options.remember) {
        const remember = options.remember;
        // After the reply is on its way: saving settings cancels pending passkey requests.
        setTimeout(() => void remember(origin, remembered).catch(() => undefined), 0);
      }
      try {
        options.report?.({
          ...detail,
          // senderOrigin() accepted only a sender with a tab.
          tabId: sender.tab!.id!,
          origin,
          outcome: result.kind,
          ...(result.kind === "delegate" ? { reason: result.reason } : {}),
        });
      } catch {
        // A report must never change the answer.
      }
      return result;
    },
  };
}
