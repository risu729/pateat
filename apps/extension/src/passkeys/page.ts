import * as v from "valibot";
import { fromBase64Url } from "./encoding";
import {
  PAGE_CHANNEL,
  PAGE_CREATE_MAX_WAIT_MS,
  PAGE_MAX_WAIT_MS,
  PAGE_TIMEOUT_MS,
  RELAY_ACK_TIMEOUT_MS,
  pageReplySchema,
  type PageResult,
} from "./wire";
import type { BridgedCreateRequest } from "./create";
import type { BridgedGetRequest } from "./request";
import type { PasskeyAssertion } from "./assertion";

type PageScope = Window & typeof globalThis;
const MAX_ALLOW_CREDENTIALS = 64;
const NOT_ALLOWED_MESSAGE =
  "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
const MAX_BUFFER_BYTES = 4096;
// Delegations of one mediation that may be in flight before an unclaimed call skips later wrappers.
const MAX_CHAIN_DELEGATIONS = 4;
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

/** What ties a provider's fallback call to the delegated request it came from. */
interface Delegation {
  readonly options: unknown;
  readonly publicKey: unknown;
  readonly mediation: unknown;
}

/**
 * Reads the caller's options once more than `snapshotGetOptions` does; a page can observe that,
 * but a match only ever sends a call to the install-time function.
 */
function describeDelegation(options: unknown): Delegation {
  let publicKey: unknown;
  let mediation: unknown;
  try {
    if (options !== null && typeof options === "object") {
      const record = options as Record<string, unknown>;
      mediation = record["mediation"];
      const value = record["publicKey"];
      if (value !== null && typeof value === "object") publicKey = value;
    }
  } catch {
    // A throwing getter leaves only the options object to match.
  }
  return { options, publicKey, mediation };
}

/** Snapshots a list of credential descriptors, or undefined when one is malformed. */
function snapshotDescriptors(list: unknown): BridgedGetRequest["allowCredentials"] | undefined {
  if (!Array.isArray(list) || list.length > MAX_ALLOW_CREDENTIALS) return undefined;
  const descriptors: BridgedGetRequest["allowCredentials"] = [];
  for (const entry of list as unknown[]) {
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
    descriptors.push({
      type: descriptor["type"],
      id: toBase64Url(id),
      ...(transports === undefined ? {} : { transports: [...(transports as string[])] }),
    });
  }
  return descriptors;
}

/** The `publicKey` member of options naming no other credential type, or undefined. */
function publicKeyOf(
  options: unknown,
): { record: Record<string, unknown>; pk: Record<string, unknown> } | undefined {
  if (options === null || typeof options !== "object") return undefined;
  const record = options as Record<string, unknown>;
  if (OTHER_CREDENTIAL_TYPES.some((key) => record[key] !== undefined)) return undefined;
  const publicKey = record["publicKey"];
  if (publicKey === null || typeof publicKey !== "object") return undefined;
  return { record, pk: publicKey as Record<string, unknown> };
}

const optional = (value: unknown) =>
  value === undefined ? undefined : typeof value === "string" ? value : null;

/** Bounded plain snapshot of supported options; anything else is left to the browser. */
export function snapshotGetOptions(options: unknown): BridgedGetRequest | undefined {
  const members = publicKeyOf(options);
  if (!members) return undefined;
  const { record, pk } = members;
  const challenge = copyBufferSource(pk["challenge"]);
  if (!challenge) return undefined;
  const allowCredentials = snapshotDescriptors(pk["allowCredentials"] ?? []);
  if (!allowCredentials) return undefined;
  const rpId = optional(pk["rpId"]);
  const userVerification = optional(pk["userVerification"]);
  const mediation = optional(record["mediation"]);
  if (rpId === null || userVerification === null || mediation === null) return undefined;
  // Only a plain number is read; any other value is left out, which only lengthens Pateat's
  // wait up to its own limit and never changes what the browser receives.
  const rawTimeout = pk["timeout"];
  const timeout =
    typeof rawTimeout === "number" && rawTimeout >= 0 && rawTimeout <= 0xff_ff_ff_ff
      ? Math.trunc(rawTimeout)
      : undefined;
  return {
    challenge: toBase64Url(challenge),
    allowCredentials,
    ...(rpId === undefined ? {} : { rpId }),
    ...(userVerification === undefined ? {} : { userVerification }),
    ...(mediation === undefined ? {} : { mediation }),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/** The `mediation` values a credential request may name; any other is the browser's TypeError. */
const MEDIATIONS: readonly unknown[] = ["silent", "optional", "conditional", "required"];

/**
 * Bounded plain snapshot of a public-key `create` request that the background checks: one
 * with a non-empty, well-formed `excludeCredentials`, the members the browser requires (a
 * challenge, `rp` and `user` with their names, a user ID and a `pubKeyCredParams` list) and a
 * known `mediation`. Anything else is left to the browser, and its TypeError, without asking
 * the background.
 */
export function snapshotCreateOptions(options: unknown): BridgedCreateRequest | undefined {
  const members = publicKeyOf(options);
  if (!members) return undefined;
  const { record, pk } = members;
  const excludeCredentials = snapshotDescriptors(pk["excludeCredentials"]);
  if (!excludeCredentials || excludeCredentials.length === 0) return undefined;
  const rp = pk["rp"];
  const user = pk["user"];
  if (rp === null || typeof rp !== "object" || user === null || typeof user !== "object")
    return undefined;
  const rpMembers = rp as Record<string, unknown>;
  const userMembers = user as Record<string, unknown>;
  if (
    !copyBufferSource(pk["challenge"]) ||
    !copyBufferSource(userMembers["id"]) ||
    !Array.isArray(pk["pubKeyCredParams"]) ||
    typeof rpMembers["name"] !== "string" ||
    typeof userMembers["name"] !== "string" ||
    typeof userMembers["displayName"] !== "string"
  )
    return undefined;
  const rpId = optional(rpMembers["id"]);
  const mediation = optional(record["mediation"]);
  if (rpId === null || mediation === null) return undefined;
  if (mediation !== undefined && !MEDIATIONS.includes(mediation)) return undefined;
  return {
    excludeCredentials,
    ...(rpId === undefined ? {} : { rpId }),
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

type Method = (this: unknown, options?: unknown) => Promise<Credential | null>;

/**
 * Installs `name` on the container as an accessor whose getter always returns Pateat's wrapper
 * and whose setter only replaces the function it delegates to (ADR 0007, Bridge topology).
 * `answer` decides each call that is not a provider's fallback; it is called synchronously and
 * hands a call on with `delegate`, which passes the caller's original arguments.
 */
function wrapMethod(
  container: CredentialsContainer,
  name: "get" | "create",
  answer: (
    self: unknown,
    options: unknown,
    delegate: () => Promise<Credential | null>,
  ) => Promise<Credential | null>,
): void {
  const installed = container[name] as Method;
  let inner: Method = installed;
  const delegations: Delegation[] = [];
  // Depth of synchronous calls into `inner` that are still on the stack.
  let delegatingSynchronously = 0;
  // A method keeps the native function's name.
  const wrapper = {
    async [name](this: unknown, options?: unknown): Promise<Credential | null> {
      const callInstalled = () =>
        Reflect.apply(installed, this, [options]) as Promise<Credential | null>;
      if (delegatingSynchronously > 0) return callInstalled();
      const call = describeDelegation(options);
      const related = delegations.filter((entry) => entry.mediation === call.mediation);
      if (
        related.some(
          (entry) =>
            entry.options === call.options ||
            (call.publicKey !== undefined && entry.publicKey === call.publicKey),
        )
      )
        return callInstalled();
      const chainFull = related.length >= MAX_CHAIN_DELEGATIONS;
      const delegate = async () => {
        if (chainFull) return callInstalled();
        delegations.push(call);
        try {
          let result: unknown;
          delegatingSynchronously++;
          try {
            result = Reflect.apply(inner, this, [options]);
          } finally {
            delegatingSynchronously--;
          }
          return await (result as Promise<Credential | null>);
        } finally {
          delegations.splice(delegations.indexOf(call), 1);
        }
      };
      return answer(this, options, delegate);
    },
  }[name];
  Object.defineProperty(container, name, {
    get: () => wrapper,
    set(value: unknown) {
      if (typeof value === "function" && value !== wrapper) inner = value as Method;
    },
    enumerable: true,
    configurable: true,
  });
}

/**
 * Wrap `navigator.credentials.get` and `create` in a top-level document at document start.
 * Every `get` request this bridge does not answer with an assertion goes, with the caller's
 * original arguments, to the implementation it wraps, except a `conditional` request withheld
 * after a Pateat login of the page signed in, which stays pending until the page aborts it
 * (ADR 0034). Every `create` request goes there too, except one the background declines
 * because it lists a passkey of the vault right after Pateat signed the tab in (ADR 0007).
 *
 * Pateat stays outside wrappers that later scripts install by assigning `get` or `create`:
 * such an assignment, including another provider's restore of a saved function, becomes the
 * delegation target instead of replacing Pateat. A provider that redefines or deletes the
 * property still replaces it.
 *
 * A provider that falls back calls the function it saved, which is Pateat's wrapper. A call with
 * the same mediation as a request Pateat is still delegating, and either the same options object
 * or the same `publicKey` object (a shallow copy, as Bitwarden's conditional path makes), is such
 * a fallback and goes to the function present at install time. So does any call made
 * synchronously while Pateat is calling the function it delegates to, as a wrapper that rebuilds
 * the options before calling its saved function does. Once `MAX_CHAIN_DELEGATIONS` delegations
 * with the same mediation are in flight, a new call Pateat does not claim also goes to the
 * install-time function, which stops a wrapper that rebuilds the options asynchronously from
 * looping. If a provider injected before Pateat, that function is its wrapper even after it
 * restores the browser's own. `get` and `create` keep these records apart.
 */
export function installPasskeyPage(scope: PageScope = window): void {
  const container = scope.navigator.credentials as CredentialsContainer | undefined;
  const credentialClass = scope.PublicKeyCredential as typeof PublicKeyCredential | undefined;
  const responseClass = scope.AuthenticatorAssertionResponse as
    | typeof AuthenticatorAssertionResponse
    | undefined;
  if (scope.top !== scope || !container || !credentialClass || !responseClass) return;
  const credentialPrototype = credentialClass.prototype;
  const responsePrototype = responseClass.prototype;
  const origin = scope.location.origin;
  const post = (message: unknown) => scope.postMessage(message, origin);
  const AbortSignalClass = scope.AbortSignal;
  const DOMExceptionClass = scope.DOMException;
  const pending = new Map<
    string,
    { finish(result: PageResult | { kind: "aborted" }): void; acknowledge(): void }
  >();

  scope.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== scope || event.origin !== origin) return;
    const reply = v.safeParse(pageReplySchema, event.data);
    if (!reply.success) return;
    const operation = pending.get(reply.output.id);
    if (reply.output.type === "ack") operation?.acknowledge();
    else operation?.finish(reply.output.result);
  });

  /**
   * Posts a snapshot to the isolated relay and settles with its result, as `cancelled` once
   * the relay falls silent or `limit` passes, or as `aborted` when the caller's signal aborts.
   */
  const ask = (
    type: "get" | "create",
    request: BridgedGetRequest | BridgedCreateRequest,
    signal: AbortSignal | undefined,
    limit: number | undefined,
  ) => {
    const id = crypto.randomUUID();
    return new Promise<PageResult | { kind: "aborted" }>((resolve) => {
      const finish = (outcome: PageResult | { kind: "aborted" }) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        if (limitTimer !== undefined) clearTimeout(limitTimer);
        clearTimeout(ackTimer);
        signal?.removeEventListener("abort", onAbort);
        if (outcome.kind === "cancelled" || outcome.kind === "aborted")
          post({ channel: PAGE_CHANNEL, type: "cancel", id });
        resolve(outcome);
      };
      const onAbort = () => finish({ kind: "aborted" });
      const expire = () => finish({ kind: "cancelled" });
      // Each acknowledgement from the relay restarts this; the limit below does not move.
      let timer = setTimeout(expire, PAGE_TIMEOUT_MS);
      const limitTimer = limit === undefined ? undefined : setTimeout(expire, limit);
      // A removed or invalidated relay never acknowledges; do not hold the caller for long.
      const ackTimer = setTimeout(expire, RELAY_ACK_TIMEOUT_MS);
      pending.set(id, {
        finish,
        acknowledge() {
          clearTimeout(ackTimer);
          clearTimeout(timer);
          timer = setTimeout(expire, PAGE_TIMEOUT_MS);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      post({ channel: PAGE_CHANNEL, type, id, request });
    });
  };

  /** The caller's genuine signal, `null` for anything else, which the browser handles. */
  const signalOf = (options: unknown): AbortSignal | undefined | null => {
    const signal = (options as { signal?: unknown } | undefined)?.signal;
    if (signal === undefined) return undefined;
    return signal instanceof AbortSignalClass ? signal : null;
  };

  wrapMethod(container, "get", async (self, options, delegate) => {
    if (self !== container) return delegate();
    let request: BridgedGetRequest | undefined;
    try {
      request = snapshotGetOptions(options);
    } catch {
      request = undefined;
    }
    const signal = signalOf(options);
    // Anything but a genuine signal gets the browser's own handling, including its TypeError.
    if (!request || signal === null) return delegate();
    if (signal?.aborted) return delegate();
    // A conditional request may wait for a login of the page for as long as the relay
    // answers (ADR 0034).
    const conditional = request.mediation === "conditional";
    const result = await ask("get", request, signal, conditional ? undefined : PAGE_MAX_WAIT_MS);
    if (result.kind === "aborted") throw signal?.reason;
    // A Pateat login signed the page in: the request stays pending until the page aborts
    // it, as a conditional request whose autofill choice is never made does (ADR 0034).
    if (result.kind === "withheld" && conditional) {
      // The page may have aborted after the relay's answer arrived.
      if (signal?.aborted) throw signal.reason;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    // Chrome's own rejection when its prompt times out or is dismissed.
    if (result.kind === "not-allowed")
      throw new DOMExceptionClass(NOT_ALLOWED_MESSAGE, "NotAllowedError");
    if (result.kind === "assertion") {
      try {
        return toCredential(result.assertion, credentialPrototype, responsePrototype);
      } catch {
        // A malformed relay result is not a credential; let the browser answer instead.
      }
    }
    return delegate();
  });

  // Only a public-key registration that excludes credentials is checked; the background
  // declines one that lists a passkey of the vault right after a Pateat sign-in (ADR 0007).
  // A provider's non-configurable `create` stays as it is; `get` is wrapped already.
  if (typeof container.create === "function")
    try {
      wrapMethod(container, "create", async (self, options, delegate) => {
        if (self !== container) return delegate();
        let request: BridgedCreateRequest | undefined;
        try {
          request = snapshotCreateOptions(options);
        } catch {
          request = undefined;
        }
        const signal = signalOf(options);
        if (!request || signal === null || signal?.aborted) return delegate();
        const result = await ask("create", request, signal, PAGE_CREATE_MAX_WAIT_MS);
        // The browser rejects an aborted request with its reason; a provider may only listen.
        if (result.kind === "aborted") throw signal?.reason;
        // Chrome's own rejection of a dismissed prompt.
        if (result.kind === "decline")
          throw new DOMExceptionClass(NOT_ALLOWED_MESSAGE, "NotAllowedError");
        // Anything else leaves the request to the browser as it was made.
        return delegate();
      });
    } catch {
      // Registrations then reach that provider without Pateat's check.
    }
}
