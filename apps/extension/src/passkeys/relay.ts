import * as v from "valibot";
import {
  MAX_ACCOUNT_CHARACTERS,
  MAX_PATH_CHARACTERS,
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
 *
 * `readAccount` reads the address the page shows as its account (ADR 0028 amendment of
 * 2026-11-17). It is read for a request the person's click made that waits for no autofill
 * choice, as it comes and without waiting, until it finds one; that one goes with its
 * request, and no later request of the document carries one, so it is compared at most once
 * a document.
 */
export function installPasskeyRelay(
  send: Send,
  alive: () => boolean = () => true,
  readAccount?: () => string | undefined,
): () => void {
  let accountSent = false;
  // A synchronous throw, such as from an invalidated extension context, still settles.
  const relay = (message: unknown) => Promise.try(() => send(message));
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
    // A path the background could not take is left out; it then reads the tab's.
    const { path } = message;
    const relayed = typeof path === "string" && path.length <= MAX_PATH_CHARACTERS ? { path } : {};
    const mediation = (message.request as { mediation?: unknown } | null)?.mediation;
    let account: string | undefined;
    if (readAccount && !accountSent && userActivation && mediation !== "conditional") {
      try {
        account = readAccount();
      } catch {
        account = undefined;
      }
      if (
        typeof account === "string" &&
        account.length >= 3 &&
        account.length <= MAX_ACCOUNT_CHARACTERS
      )
        accountSent = true;
      else account = undefined;
    }
    void relay({
      version: 1,
      type: "passkey.get",
      operationId: message.id,
      request: message.request,
      userActivation,
      focused,
      ...relayed,
      ...(account === undefined ? {} : { account }),
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
  const controller = new AbortController();
  const { signal } = controller;
  window.addEventListener("message", listener, { signal });
  window.addEventListener("pagehide", leave, { signal });
  return () => {
    controller.abort();
    for (const id of [...heartbeats.keys()]) settle(id);
  };
}
