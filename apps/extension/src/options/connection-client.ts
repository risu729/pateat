import type { BitwardenProfile } from "@pateat/bitwarden";
import * as v from "valibot";
import { providerPermissionOrigins } from "../connections/permissions";
import { SETUP_PORT, parseSetupReply, setupRequestSchema } from "../connections/wire";
import type { SetupBegin, SetupContinuation, SetupReply } from "../connections/types";

export interface ConnectionClient {
  /** Call synchronously from a human gesture, before any async work. */
  requestProviderPermission(environment: BitwardenProfile["environment"]): Promise<boolean>;
  list(): Promise<SetupReply>;
  begin(input: SetupBegin): Promise<SetupReply>;
  continue(input: SetupContinuation): Promise<SetupReply>;
  cancel(flowId: string): Promise<SetupReply>;
  sync(connectionId: string): Promise<SetupReply>;
  disableAutoUnlock(connectionId: string): Promise<SetupReply>;
  review(
    input: Extract<v.InferInput<typeof setupRequestSchema>, { type: "connection.review" }>["input"],
  ): Promise<SetupReply>;
  /** Disconnect also cancels pending work, including a begin without a flow ID. */
  close(): void;
}
interface SetupPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
type SetupRequest = v.InferInput<typeof setupRequestSchema>;
type RequestInput = SetupRequest extends infer R
  ? R extends SetupRequest
    ? Omit<R, "requestId">
    : never
  : never;
const envelopeSchema = v.strictObject({
  requestId: v.pipe(v.string(), v.uuid()),
  result: v.unknown(),
});

/** Credentials travel only through this private Port, never a query or mutation cache. */
export function createConnectionClient(api: {
  connect(name: string): SetupPort;
  requestPermission(origins: string[]): Promise<boolean>;
}): ConnectionClient {
  let port: SetupPort | undefined;
  const pending = new Map<
    string,
    { resolve(result: SetupReply): void; reject(): void; timer: ReturnType<typeof setTimeout> }
  >();
  function close() {
    const previous = port;
    port = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject();
    }
    pending.clear();
    previous?.disconnect();
  }
  function channel() {
    if (port) return port;
    const next = api.connect(SETUP_PORT);
    port = next;
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = undefined;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject();
      }
      pending.clear();
    });
    next.onMessage.addListener((message) => {
      if (port !== next) return;
      const envelope = v.safeParse(envelopeSchema, message);
      if (!envelope.success) {
        close();
        return;
      }
      const request = pending.get(envelope.output.requestId);
      if (!request) return;
      try {
        const reply = parseSetupReply(envelope.output.result);
        pending.delete(envelope.output.requestId);
        clearTimeout(request.timer);
        request.resolve(reply);
      } catch {
        close();
      }
    });
    return next;
  }
  function send(input: RequestInput): Promise<SetupReply> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const fail = () => reject(new Error("Connection operation could not be confirmed."));
      const timer = setTimeout(close, 120_000);
      pending.set(requestId, { resolve, reject: fail, timer });
      try {
        channel().postMessage({ requestId, ...input });
      } catch {
        close();
      }
    });
  }
  return {
    requestProviderPermission(environment) {
      const origins = providerPermissionOrigins(environment);
      return origins.ok ? api.requestPermission(origins.data) : Promise.resolve(false);
    },
    list: () => send({ type: "connection.status" }),
    begin: (input) => send({ type: "connection.begin", input }),
    continue: (input) => send({ type: "connection.continue", input }),
    cancel: (flowId) => send({ type: "connection.cancel", flowId }),
    sync: (connectionId) => send({ type: "connection.sync", connectionId }),
    disableAutoUnlock: (connectionId) => send({ type: "connection.disable", connectionId }),
    review: (input) => send({ type: "connection.review", input }),
    close,
  };
}
