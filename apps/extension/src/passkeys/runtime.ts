import * as v from "valibot";

import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "./policy";
import { admitGetRequest, describeInvalidRequest } from "./request";
import { needsRelatedOrigins } from "./related-origins";
import { type PasskeyCandidate } from "./select";
import { RUNTIME_TIMEOUT_MS, runtimeMessageSchema, type RuntimeResult } from "./wire";

import { createPasskeyAnswer } from "./runtime-answer";
import {
  type Sender,
  type PasskeySource,
  type After,
  type PasskeyStopCause,
  type ReportDetail,
  mediationOf,
  MAX_OPERATIONS,
  MAX_DOCUMENT_OPERATIONS,
  senderOrigin,
  ListedSite,
  abortable,
  type PasskeyRuntimeOptions,
  type Operation,
} from "./runtime-shared";
export {
  type Sender,
  type PasskeyItem,
  type PasskeySource,
  type PasskeyChoice,
  type PasskeyChooser,
  chooserWaitMs,
  type PasskeyRequestReport,
  type PasskeyStopCause,
  type ConditionalDecision,
  senderOrigin,
  abortable,
} from "./runtime-shared";
/**
 * Background coordinator for bridged `get()` requests. Every outcome but an assertion delegates,
 * except a chooser window left unanswered until the request's wait ran out, which fails, and a
 * conditional request withheld after a login of its page signed in (ADR 0034). A request of a
 * hostname whose requests go to the browser is handed on, and nothing is signed, chosen or
 * waited for by a login before the list is known (ADR 0007).
 */
export function createPasskeyRuntime<TCandidate extends PasskeyCandidate>(
  source: PasskeySource<TCandidate>,
  options: PasskeyRuntimeOptions<TCandidate>,
) {
  const operations = new Map<string, Operation>();
  /**
   * Requests still reading the device's policy, before they become operations: a page's
   * cancel that arrives meanwhile is kept here, so it is not lost.
   */
  const reading = new Map<string, { documentId: string; cancelled: boolean; related?: true }>();
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

  /**
   * At most one RP list is read for a document at a time, and at most
   * `MAX_DOCUMENT_OPERATIONS` across documents (ADR 0084), so a page cannot keep the worker
   * fetching.
   */
  const relatedReadAllowed = (documentId: string) => {
    const related = [...reading.values()].filter((entry) => entry.related);
    return (
      related.length < MAX_DOCUMENT_OPERATIONS &&
      !related.some((entry) => entry.documentId === documentId)
    );
  };
  /**
   * Whether a request naming `rpId`, an RP ID of another site, may be answered as one of
   * that RP ID (ADR 0084): only a request that admission refuses for that RP ID alone, on a
   * page whose passkeys are not left to the browser, while the vault holds a passkey with
   * that RP ID, and then only when the RP's list names the page. The page therefore never
   * picks a host to fetch from that the vault does not already name.
   */
  const relatedRpIdFor = async (
    origin: string,
    rpId: string,
    message: { request: unknown; userActivation: boolean },
    policy: PasskeyPolicy,
  ) => {
    const plain = admitGetRequest({
      origin,
      request: message.request,
      userActivation: message.userActivation,
      policy,
      conditional: options.conditional !== undefined,
    });
    if (plain.kind !== "delegate" || plain.reason !== "rp-id-mismatch") return false;
    try {
      if (options.browserSite && (await options.browserSite(origin))) return false;
      // Never aborted: the vault source does not cancel host queries.
      const held = await source.candidates(origin, rpId, new AbortController().signal);
      if (!held?.candidates.some((candidate) => candidate.rpId === rpId)) return false;
      return await options.relatedOrigins!.allows(origin, rpId);
    } catch {
      return false;
    }
  };

  async function get(
    message: { operationId: string; request: unknown; userActivation: boolean; focused: boolean },
    origin: string,
    context: { documentId: string; tabId: number; incognito: boolean; active: boolean },
    detail: ReportDetail,
    after: After<TCandidate>,
  ): Promise<RuntimeResult> {
    const { documentId } = context;
    if (operations.has(message.operationId) || reading.has(message.operationId))
      return { kind: "delegate", reason: "busy" };
    // Read before the limits below, so no wait falls between counting and adding.
    const pending: { documentId: string; cancelled: boolean; related?: true } = {
      documentId,
      cancelled: false,
    };
    reading.set(message.operationId, pending);
    let policy: PasskeyPolicy;
    let relatedRpId: string | undefined;
    try {
      policy = (await options.policy?.(origin)) ?? INITIAL_PASSKEY_POLICY;
      const requested = (message.request as { rpId?: unknown } | null)?.rpId;
      if (
        options.relatedOrigins &&
        typeof requested === "string" &&
        needsRelatedOrigins(origin, requested) &&
        relatedReadAllowed(documentId)
      ) {
        pending.related = true;
        relatedRpId = (await relatedRpIdFor(origin, requested, message, policy))
          ? requested
          : undefined;
      }
    } finally {
      reading.delete(message.operationId);
    }
    if (pending.cancelled) {
      detail.cause = "page-cancelled";
      return { kind: "cancelled" };
    }
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
      policy,
      conditional: options.conditional !== undefined,
      ...(relatedRpId === undefined ? {} : { relatedRpId }),
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
    const immediate = admission.request.immediate === true;
    // Chrome rejects Immediate UI in incognito, so Pateat does not answer there (ADR 0052).
    if (immediate && context.incognito) return { kind: "delegate", reason: "immediate-incognito" };
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
    let step: PasskeyStopCause = "account-lookup";
    // "Always for this site": Pateat answers nothing there, not even through a login. Read
    // alongside the lookups, so the deadline runs as without it; a failed read hands on.
    const listed = options.browserSite
      ? Promise.try(() => options.browserSite!(origin))
      : Promise.resolve(false);
    // Awaited by `unlisted`; a rejection is never left unhandled.
    listed.catch(() => undefined);
    /**
     * Throws ListedSite on a listed hostname; called before anything answers the request.
     * Asks again at each call, so a hostname chosen "Always" while the request waited, as a
     * parked conditional one does, holds for it too.
     */
    const unlisted = async (signal: AbortSignal) => {
      const current = step;
      step = "browser-site-lookup";
      if (await abortable(listed, signal)) throw new ListedSite();
      if (
        options.browserSite &&
        (await abortable(
          Promise.try(() => options.browserSite!(origin)),
          signal,
        ))
      )
        throw new ListedSite();
      step = current;
    };
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
    const answer = createPasskeyAnswer({
      source, options, request: admission.request, origin, context, message, operation,
      detail, after, received, unlisted,
      setStep: (next) => { step = next; },
      resetTimer: (remaining) => {
        clearTimeout(timer);
        timer = setTimeout(expire, remaining);
      },
    });
    // Told whether the answer of a login's conditional request went back (ADR 0034).
    let answered: ((signed: boolean) => void) | undefined;
    // A conditional request waits for the login of its page, if one starts or runs, which
    // answers it with its own item, hands it on or withholds it (ADR 0034).
    const waitForLogin = async (signal: AbortSignal): Promise<RuntimeResult> => {
      await unlisted(signal);
      step = "login-wait";
      operation.parked = true;
      const decision = await abortable(
        Promise.try(() =>
          options.conditional!({
            tabId: context.tabId,
            origin,
            documentId,
            signal,
            incognito: context.incognito,
          }),
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
        if (signal.aborted || error instanceof ListedSite) throw error;
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
    /** Finds the answer: a re-verification, a login's wait, or the vault's passkeys. */
    const lookUp = async (signal: AbortSignal): Promise<RuntimeResult> => {
      step = conditional ? "login-wait" : "account-lookup";
      // A re-verification after Pateat's login in the tab: answering it completes the
      // verification as a press would, so it goes to the browser or Bitwarden, as
      // `confirm-fill` under the default setting for `confirm` pages (ADR 0035). A
      // conditional request belongs to a sign-in field and is left to its login (ADR 0034).
      if (
        !conditional &&
        admission.request.allowCredentialIds.length > 0 &&
        options.reverification &&
        (await abortable(
          options.reverification(context.tabId, origin, admission.request.rpId),
          signal,
        ))
      )
        return { kind: "delegate", reason: "confirm-fill" };
      if (conditional) return await waitForLogin(signal);
      await hold(signal);
      // A failed lookup fails closed: the catch below delegates.
      const login = await options.loginAccount?.(context.tabId, origin);
      return await answer(login, signal);
    };
    try {
      const signal = controller.signal;
      const result = await lookUp(signal);
      // Whatever the lookup decided, a listed hostname's request is handed on as such.
      await unlisted(signal);
      return result;
    } catch (error) {
      answered?.(false);
      if (error instanceof ListedSite) return { kind: "delegate", reason: "browser-site" };
      // A lookup that failed on a listed hostname is handed on as such too.
      if (
        !controller.signal.aborted &&
        (await abortable(listed, controller.signal).catch(() => false))
      )
        return { kind: "delegate", reason: "browser-site" };
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
        const early = reading.get(command.operationId);
        if (!operation && early && early.documentId === sender.documentId) {
          early.cancelled = true;
          return { ok: true };
        }
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
      const after: After<TCandidate> = {};
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
          options.answered?.(sender.tab!.id!, origin, detail.rpId, after.signed, {
            ...(after.silent ? { silent: true } : {}),
            incognito: sender.tab?.incognito === true,
            // senderOrigin() accepted only a top document with an ID.
            documentId: sender.documentId!,
          });
        } catch {
          // Never changes the answer.
        }
      const remembered = after.remember;
      const mediation = mediationOf(request);
      if (mediation) detail.mediation = mediation;
      if (typeof request === "object" && request !== null && "uiMode" in request)
        if (request.uiMode === "immediate") detail.uiMode = "immediate";
      if (remembered && options.remember) {
        const remember = options.remember;
        // After the reply is on its way: saving settings cancels pending passkey requests.
        setTimeout(() => void remember(origin, remembered).catch(() => undefined), 0);
      }
      if (after.browserSite && options.addBrowserSite) {
        const add = options.addBrowserSite;
        setTimeout(() => void add(origin).catch(() => undefined), 0);
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
