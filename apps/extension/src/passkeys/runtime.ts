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
import {
  CHOOSER_MAX_WAIT_MS,
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
  origin?: string | undefined;
  url?: string | undefined;
};

/** Account-bound credential source. It owns site policy and keeps private keys out of this layer. */
export interface PasskeySource<TCandidate extends PasskeyCandidate = PasskeyCandidate> {
  /** Stored passkeys with this RP ID that may answer this origin, or none if not permitted. */
  candidates(
    origin: string,
    rpId: string,
    signal: AbortSignal,
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
    readonly entries: readonly PasskeyDisplay[];
    /** A site default exists but holds none of these passkeys; making one default replaces it. */
    readonly replacesDefault: boolean;
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
  },
) {
  const operations = new Map<string, { documentId: string; controller: AbortController }>();
  const cancelAll = () => {
    for (const operation of operations.values()) operation.controller.abort();
    operations.clear();
  };

  async function get(
    message: { operationId: string; request: unknown; userActivation: boolean },
    origin: string,
    context: { documentId: string; tabId: number; incognito: boolean },
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
      const candidates = await abortable(
        source.candidates(origin, admission.request.rpId, signal),
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
      let credential: TCandidate;
      let makeDefault = false;
      if (selection.kind === "credential") credential = selection.credential;
      else {
        // Only passkeys Pateat can sign with are offered; fewer than two is not a choice.
        const offered = accepted.filter((entry) => entry.counter === 0);
        if (
          selection.reason !== "ambiguous-credential" ||
          !options.chooser ||
          // An extension window would open outside the incognito window (ADR 0021).
          context.incognito ||
          offered.length < 2
        )
          return selection;
        // The window waits for a person, so the lookup budget no longer applies.
        clearTimeout(timer);
        timer = setTimeout(
          expire,
          Math.max(0, received + chooserWaitMs(admission.request.timeoutMs) - Date.now()),
        );
        const choice = await abortable(
          options.chooser.choose({
            tabId: context.tabId,
            origin,
            rpId: admission.request.rpId,
            entries: offered.map(
              (entry, index) => entry.display ?? { item: `Passkey ${index + 1}` },
            ),
            replacesDefault:
              candidates.siteDefault !== undefined && candidates.siteDefault !== "unset",
            signal,
          }),
          signal,
        );
        detail.chooser = choice.kind;
        if (choice.kind !== "chosen") return { kind: "delegate", reason: `chooser-${choice.kind}` };
        const chosen = offered[choice.index];
        if (!chosen) return { kind: "delegate", reason: "chooser-invalid" };
        credential = chosen;
        makeDefault = choice.makeDefault;
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
        },
        detail,
        after,
      );
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
