import * as v from "valibot";
import {
  MAX_REQUEST_CHARACTERS,
  PAGE_CHANNEL,
  RELAY_HEARTBEAT_MS,
  createResultSchema,
  pageRequestSchema,
  runtimeResultSchema,
  type CreateResult,
  type PageResult,
  type RuntimeResult,
} from "./wire";

type Send = (message: unknown) => Promise<unknown>;

/**
 * Native admission checks the isolated world can observe without trusting page globals: a
 * top-level secure document that allows `feature`, the permissions policy of `get` or `create`.
 */
function documentAdmits(
  feature: "publickey-credentials-get" | "publickey-credentials-create",
): boolean {
  if (window.top !== window || !window.isSecureContext) return false;
  const policy = (
    document as Document & {
      featurePolicy?: { allowsFeature(feature: string): boolean };
    }
  ).featurePolicy;
  // Without a readable policy the native request might be denied; never claim it.
  return policy?.allowsFeature(feature) === true;
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
  // Cleanup snapshots the keys because cancel and settle delete entries from this map.
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
  const reply = (id: string, result: RuntimeResult | CreateResult) => {
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
    const create = message.type === "create";
    if (!documentAdmits(create ? "publickey-credentials-create" : "publickey-credentials-get")) {
      reply(message.id, { kind: "delegate", reason: "document-not-admitted" });
      return;
    }
    if (!heartbeats.has(message.id))
      heartbeats.set(
        message.id,
        setInterval(() => {
          // An orphaned relay stops vouching, so the page falls back within its backstop.
          if (alive()) acknowledge(message.id);
          else settle(message.id);
        }, RELAY_HEARTBEAT_MS),
      );
    if (create) {
      // The background only checks it; anything but its decline hands it on (ADR 0007).
      void relay({
        version: 1,
        type: "passkey.create",
        operationId: message.id,
        request: message.request,
      }).then(
        (response) => {
          const result = v.safeParse(createResultSchema, response);
          return reply(
            message.id,
            result.success ? result.output : { kind: "delegate", reason: "invalid-response" },
          );
        },
        () => reply(message.id, { kind: "delegate", reason: "runtime-unavailable" }),
      );
      return;
    }
    const userActivation = navigator.userActivation?.isActive === true;
    // A hidden or background document never gets a window, as Chrome's own UI needs focus.
    const focused = document.visibilityState === "visible" && document.hasFocus();
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
