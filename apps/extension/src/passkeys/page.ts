import { fromBase64Url } from "./encoding";
import { PAGE_CHANNEL, PAGE_TIMEOUT_MS, type RuntimeResult } from "./wire";
import type { BridgedGetRequest } from "./request";
import type { PasskeyAssertion } from "./assertion";

type PageScope = Window & typeof globalThis;
const MAX_ALLOW_CREDENTIALS = 64;
const MAX_BUFFER_BYTES = 4096;
const OTHER_CREDENTIAL_TYPES = ["password", "federated", "identity", "otp", "digital"] as const;

function toBase64Url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Copy a BufferSource at call time, as the client algorithm requires. Shared buffers are refused. */
function copyBufferSource(value: unknown): Uint8Array | undefined {
  let view: Uint8Array;
  if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer)
    view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else return undefined;
  return view.byteLength <= MAX_BUFFER_BYTES ? view.slice() : undefined;
}

/** Bounded plain snapshot of supported options; anything else is left to the browser. */
export function snapshotGetOptions(options: unknown): BridgedGetRequest | undefined {
  if (options === null || typeof options !== "object") return undefined;
  const record = options as Record<string, unknown>;
  if (OTHER_CREDENTIAL_TYPES.some((key) => record[key] !== undefined)) return undefined;
  const publicKey = record["publicKey"];
  if (publicKey === null || typeof publicKey !== "object") return undefined;
  const pk = publicKey as Record<string, unknown>;
  const challenge = copyBufferSource(pk["challenge"]);
  if (!challenge) return undefined;
  const allowList = pk["allowCredentials"] ?? [];
  if (!Array.isArray(allowList) || allowList.length > MAX_ALLOW_CREDENTIALS) return undefined;
  const allowCredentials: BridgedGetRequest["allowCredentials"] = [];
  for (const entry of allowList as unknown[]) {
    if (entry === null || typeof entry !== "object") return undefined;
    const descriptor = entry as Record<string, unknown>;
    const id = copyBufferSource(descriptor["id"]);
    const transports = descriptor["transports"];
    if (!id || typeof descriptor["type"] !== "string") return undefined;
    if (
      transports !== undefined &&
      (!Array.isArray(transports) || transports.some((item) => typeof item !== "string"))
    )
      return undefined;
    allowCredentials.push({
      type: descriptor["type"],
      id: toBase64Url(id),
      ...(transports === undefined ? {} : { transports: [...(transports as string[])] }),
    });
  }
  const optional = (value: unknown) =>
    value === undefined ? undefined : typeof value === "string" ? value : null;
  const rpId = optional(pk["rpId"]);
  const userVerification = optional(pk["userVerification"]);
  const mediation = optional(record["mediation"]);
  if (rpId === null || userVerification === null || mediation === null) return undefined;
  return {
    challenge: toBase64Url(challenge),
    allowCredentials,
    ...(rpId === undefined ? {} : { rpId }),
    ...(userVerification === undefined ? {} : { userVerification }),
    ...(mediation === undefined ? {} : { mediation }),
  };
}

function decodeBuffer(value: string): ArrayBuffer {
  const decoded = fromBase64Url(value);
  if (!decoded) throw new TypeError("Invalid assertion encoding");
  return decoded.buffer as ArrayBuffer;
}

/** Plain objects with native prototypes, matching Chrome's assertion shape and toJSON output. */
function toCredential(
  assertion: PasskeyAssertion,
  credentialPrototype: object,
  responsePrototype: object,
): Credential {
  const response = {
    clientDataJSON: decodeBuffer(assertion.clientDataJSON),
    authenticatorData: decodeBuffer(assertion.authenticatorData),
    signature: decodeBuffer(assertion.signature),
    userHandle: assertion.userHandle === null ? null : decodeBuffer(assertion.userHandle),
  };
  const json = {
    id: assertion.credentialId,
    rawId: assertion.credentialId,
    response: {
      clientDataJSON: assertion.clientDataJSON,
      authenticatorData: assertion.authenticatorData,
      signature: assertion.signature,
      ...(assertion.userHandle === null ? {} : { userHandle: assertion.userHandle }),
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    type: "public-key",
  };
  const credential = {
    id: assertion.credentialId,
    rawId: decodeBuffer(assertion.credentialId),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: Object.setPrototypeOf(response, responsePrototype),
    getClientExtensionResults: () => ({}),
    toJSON: () => structuredClone(json),
  };
  return Object.setPrototypeOf(credential, credentialPrototype) as Credential;
}

/**
 * Wrap `navigator.credentials.get` in a top-level document at document start. Every request this
 * bridge does not answer with an assertion goes to the browser's original implementation with
 * the caller's original arguments.
 */
export function installPasskeyPage(scope: PageScope = window): void {
  const container = scope.navigator.credentials as CredentialsContainer | undefined;
  const credentialClass = scope.PublicKeyCredential as typeof PublicKeyCredential | undefined;
  const responseClass = scope.AuthenticatorAssertionResponse as
    | typeof AuthenticatorAssertionResponse
    | undefined;
  if (scope.top !== scope || !container || !credentialClass || !responseClass) return;
  const nativeGet: CredentialsContainer["get"] = container.get;
  const credentialPrototype = credentialClass.prototype;
  const responsePrototype = responseClass.prototype;
  const origin = scope.location.origin;
  const post = (message: unknown) => scope.postMessage(message, origin);
  const pending = new Map<string, (result: RuntimeResult | { kind: "aborted" }) => void>();

  scope.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== scope || event.origin !== origin) return;
    const data = event.data as Record<string, unknown> | null;
    if (data?.["channel"] !== PAGE_CHANNEL || data["type"] !== "result") return;
    const id = data["id"];
    const result = data["result"] as RuntimeResult | undefined;
    if (typeof id !== "string" || !result || typeof result !== "object") return;
    pending.get(id)?.(result);
  });

  async function get(
    this: unknown,
    options?: CredentialRequestOptions,
  ): Promise<Credential | null> {
    const callNative = () =>
      Reflect.apply(nativeGet, this, [options]) as Promise<Credential | null>;
    if (this !== container) return callNative();
    let request: BridgedGetRequest | undefined;
    try {
      request = snapshotGetOptions(options);
    } catch {
      request = undefined;
    }
    const signal = options?.signal;
    if (!request || signal?.aborted) return callNative();
    const id = crypto.randomUUID();
    const result = await new Promise<RuntimeResult | { kind: "aborted" }>((resolve) => {
      const finish = (outcome: RuntimeResult | { kind: "aborted" }) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (outcome.kind !== "assertion" && outcome.kind !== "delegate")
          post({ channel: PAGE_CHANNEL, type: "cancel", id });
        resolve(outcome);
      };
      const onAbort = () => finish({ kind: "aborted" });
      const timer = setTimeout(() => finish({ kind: "cancelled" }), PAGE_TIMEOUT_MS);
      pending.set(id, finish);
      signal?.addEventListener("abort", onAbort, { once: true });
      post({ channel: PAGE_CHANNEL, type: "get", id, request });
    });
    if (result.kind === "aborted") throw signal?.reason;
    if (result.kind === "assertion") {
      try {
        return toCredential(result.assertion, credentialPrototype, responsePrototype);
      } catch {
        // A malformed relay result is not a credential; let the browser answer instead.
      }
    }
    return callNative();
  }

  Object.defineProperty(container, "get", {
    value: get,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
