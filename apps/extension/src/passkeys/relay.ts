import * as v from "valibot";
import {
  MAX_REQUEST_CHARACTERS,
  PAGE_CHANNEL,
  RELAY_HEARTBEAT_MS,
  pageRequestSchema,
  runtimeResultSchema,
  type PageResult,
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
 *
 * While the background works on a request, the relay repeats its acknowledgement so the page's
 * backstop keeps waiting, for as long as `alive` reports a usable extension context. Leaving the
 * page cancels every pending request, which closes a chooser window opened for it.
 */
export function installPasskeyRelay(send: Send, alive: () => boolean = () => true): () => void {
  // A synchronous throw, such as from an invalidated extension context, still settles.
  const relay = (message: unknown) => Promise.resolve().then(() => send(message));
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  const acknowledge = (id: string) =>
    window.postMessage({ channel: PAGE_CHANNEL, type: "ack", id }, location.origin);
  const settle = (id: string) => {
    clearInterval(heartbeats.get(id));
    heartbeats.delete(id);
  };
  const cancel = (id: string) => {
    settle(id);
    void relay({ version: 1, type: "passkey.cancel", operationId: id }).catch(() => {});
  };
  const reply = (id: string, result: RuntimeResult) => {
    settle(id);
    const outcome: PageResult = result.kind === "delegate" ? { kind: "delegate" } : result;
    window.postMessage(
      { channel: PAGE_CHANNEL, type: "result", id, result: outcome },
      location.origin,
    );
  };
  const listener = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const parsed = v.safeParse(pageRequestSchema, event.data);
    if (!parsed.success) return;
    const message = parsed.output;
    if (message.type === "cancel") {
      cancel(message.id);
      return;
    }
    acknowledge(message.id);
    if (!withinBound(message.request)) {
      reply(message.id, { kind: "delegate", reason: "invalid-request" });
      return;
    }
    if (!documentAdmits()) {
      reply(message.id, { kind: "delegate", reason: "document-not-admitted" });
      return;
    }
    const userActivation = navigator.userActivation?.isActive === true;
    // A hidden or background document never gets a window, as Chrome's own UI needs focus.
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (!heartbeats.has(message.id))
      heartbeats.set(
        message.id,
        setInterval(() => {
          // An orphaned relay stops vouching, so the page falls back within its backstop.
          if (alive()) acknowledge(message.id);
          else settle(message.id);
        }, RELAY_HEARTBEAT_MS),
      );
    void relay({
      version: 1,
      type: "passkey.get",
      operationId: message.id,
      request: message.request,
      userActivation,
      focused,
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
  const leave = () => {
    for (const id of [...heartbeats.keys()]) cancel(id);
  };
  window.addEventListener("message", listener);
  window.addEventListener("pagehide", leave);
  return () => {
    window.removeEventListener("message", listener);
    window.removeEventListener("pagehide", leave);
    for (const id of [...heartbeats.keys()]) settle(id);
  };
}
