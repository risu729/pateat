import * as v from "valibot";
import { createPasskeyAssertion } from "./assertion";
import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "./policy";
import { admitGetRequest } from "./request";
import { selectPasskey, type PasskeyCandidate } from "./select";
import { RUNTIME_TIMEOUT_MS, runtimeMessageSchema, type RuntimeResult } from "./wire";

type Sender = {
  id?: string | undefined;
  tab?: { id?: number | undefined } | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
  origin?: string | undefined;
  url?: string | undefined;
};

/** Account-bound credential source. It owns site policy and keeps private keys out of this layer. */
export interface PasskeySource<TCandidate extends PasskeyCandidate = PasskeyCandidate> {
  /** Candidates for the account configured for exactly this origin, or none if not permitted. */
  candidates(origin: string, signal: AbortSignal): Promise<readonly TCandidate[] | undefined>;
  sign(
    candidate: TCandidate,
    authenticatorData: Uint8Array<ArrayBuffer>,
    clientDataHash: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

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
    documentId: string,
  ): Promise<RuntimeResult> {
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
    const controller = new AbortController();
    operations.set(message.operationId, { documentId, controller });
    const timer = setTimeout(
      () => controller.abort(new DOMException("Passkey bridge timed out", "TimeoutError")),
      options.timeoutMs?.() ?? RUNTIME_TIMEOUT_MS,
    );
    try {
      const signal = controller.signal;
      const candidates = await abortable(source.candidates(origin, signal), signal);
      if (!candidates) return { kind: "delegate", reason: "not-configured" };
      const selection = selectPasskey(admission.request, candidates);
      if (selection.kind === "delegate") return selection;
      const assertion = await abortable(
        createPasskeyAssertion(admission.request, selection.credential, (data, hash) =>
          source.sign(selection.credential, data, hash, signal),
        ),
        signal,
      );
      return signal.aborted ? { kind: "cancelled" } : { kind: "assertion", assertion };
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
      return get(command, origin, sender.documentId!);
    },
  };
}
