import * as v from "valibot";
import {
  MAX_REQUEST_CHARACTERS,
  PAGE_CHANNEL,
  pageRequestSchema,
  runtimeResultSchema,
  type RuntimeResult,
} from "./wire";

type Send = (message: unknown) => Promise<unknown>;

/** Native admission checks the isolated world can observe without trusting page globals. */
function documentAdmits(): boolean {
  if (window.top !== window || !window.isSecureContext) return false;
  const policy = (
    document as Document & {
      featurePolicy?: { allowsFeature(feature: string): boolean };
    }
  ).featurePolicy;
  // Without a readable policy the native request might be denied; never claim it.
  return policy?.allowsFeature("publickey-credentials-get") === true;
}

function withinBound(request: unknown): boolean {
  try {
    return (JSON.stringify(request)?.length ?? Infinity) <= MAX_REQUEST_CHARACTERS;
  } catch {
    return false;
  }
}

/**
 * Isolated-world relay. The background derives origin and document from the browser-supplied
 * sender; this world contributes only checks the page cannot forge, including user activation.
 */
export function installPasskeyRelay(send: Send): () => void {
  // A synchronous throw, such as from an invalidated extension context, still settles.
  const relay = (message: unknown) => Promise.resolve().then(() => send(message));
  const reply = (id: string, result: RuntimeResult) =>
    window.postMessage({ channel: PAGE_CHANNEL, type: "result", id, result }, location.origin);
  const listener = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const parsed = v.safeParse(pageRequestSchema, event.data);
    if (!parsed.success) return;
    const message = parsed.output;
    if (message.type === "cancel") {
      void relay({ version: 1, type: "passkey.cancel", operationId: message.id }).catch(() => {});
      return;
    }
    window.postMessage({ channel: PAGE_CHANNEL, type: "ack", id: message.id }, location.origin);
    if (!withinBound(message.request)) {
      reply(message.id, { kind: "delegate", reason: "invalid-request" });
      return;
    }
    if (!documentAdmits()) {
      reply(message.id, { kind: "delegate", reason: "document-not-admitted" });
      return;
    }
    const userActivation = navigator.userActivation?.isActive === true;
    void relay({
      version: 1,
      type: "passkey.get",
      operationId: message.id,
      request: message.request,
      userActivation,
    }).then(
      (response) => {
        const result = v.safeParse(runtimeResultSchema, response);
        return reply(
          message.id,
          result.success ? result.output : { kind: "delegate", reason: "invalid-response" },
        );
      },
      () => reply(message.id, { kind: "delegate", reason: "runtime-unavailable" }),
    );
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
