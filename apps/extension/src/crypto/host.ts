import * as v from "valibot";
import type {
  BitwardenResult,
  LocalFieldMetadata,
  LocalFieldReference,
  LocalFieldValue,
  LocalCryptoSession,
  PreparedBitwardenAccount,
  LocalVaultMetadata,
  LocalPasskeyCredential,
} from "@pateat/bitwarden";
import { localVaultMetadataSchema } from "@pateat/bitwarden";
import {
  boundedMessage,
  commandSchema,
  CRYPTO_PORT,
  lifecycleSchema,
  progressSchema,
  replySchema,
  passkeyCandidatesSchema,
  passkeySignatureSchema,
  sessionSchema,
  uriCandidatesSchema,
  type HostOperation,
  type UriCandidates,
  type HostSessionRef,
  type HostUnlock,
} from "./wire";
import type { PasskeySignRequest, PasskeySignature } from "./passkey";
import { fromBase64Url } from "../passkeys/encoding";

type Listener<T extends unknown[]> = {
  addListener(listener: (...args: T) => void): void;
  removeListener(listener: (...args: T) => void): void;
};
export interface CryptoHostPort {
  name: string;
  sender?: {
    id?: string;
    url?: string;
    documentId?: string;
    tab?: unknown;
    frameId?: number;
    nativeApplication?: string;
  };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: Listener<[unknown]>;
  onDisconnect: Listener<[]>;
}
export interface CryptoHostDependencies {
  extensionId: string;
  offscreenUrl: string;
  getContexts(): Promise<{ documentId?: string; documentUrl?: string }[]>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  onConnect: Listener<[CryptoHostPort]>;
  randomId?: () => string;
  nowMs?: () => number;
  timeoutMs?: number;
  /** Only the probe build supplies deterministic metadata-only barriers. */
  checkpoint?: (stage: "before-dispatch" | "after-result") => Promise<void>;
  /** Probe-only shortened operation budget; bootstrap always retains its own budget. */
  requestTimeoutMs?: () => number;
}
const fail = (
  code:
    | "invalid-request"
    | "crypto-failed"
    | "crypto-locked"
    | "account-mismatch"
    | "cancelled"
    | "timeout"
    | "resource-limit",
): BitwardenResult<never> => ({ ok: false, error: { code } });
export type OpenedHostSession = {
  session: HostSessionRef;
  metadata: {
    connectionId: string;
    userId: string;
    accountVersion: "v1" | "v2";
    securityVersion: 1 | 2;
  };
};

function sameOrigin(targetUrl: string, origin: string): boolean {
  try {
    return new URL(targetUrl).origin === origin;
  } catch {
    return false;
  }
}

/** Background-internal API. Neither the options page nor content scripts get these operations. */
export function createCryptoHost(deps: CryptoHostDependencies) {
  const random = deps.randomId ?? (() => crypto.randomUUID());
  const generation = random();
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const now = deps.nowMs ?? Date.now;
  let disposed = false;
  let ready = false;
  let boundPort: CryptoHostPort | undefined;
  let creation: Promise<void> | undefined;
  let nativeBootstrap = false;
  let hello: (() => void) | undefined;
  let rejectHello: (() => void) | undefined;
  const sessions = new Map<string, HostSessionRef>();
  const closing = new Set<string>();
  const pending = new Map<
    string,
    {
      connectionId: string;
      operation: HostOperation;
      deadline: number;
      dispatched: boolean;
      resolve(result: BitwardenResult<unknown>): void;
      timer: ReturnType<typeof setTimeout>;
      cleanup(): void;
    }
  >();
  const resultCodes = new Set([
    "invalid-profile",
    "invalid-options",
    "invalid-request",
    "connection-mismatch",
    "account-mismatch",
    "authentication-expired",
    "unsupported-unlock",
    "cancelled",
    "timeout",
    "network",
    "redirect",
    "http-error",
    "response-too-large",
    "invalid-response",
    "invalid-crypto-input",
    "crypto-failed",
    "unsupported-crypto",
    "security-downgrade",
    "crypto-locked",
    "resource-limit",
    "invalid-field-input",
    "stale-field-reference",
    "field-denied",
    "field-missing",
    "unsupported-field",
    "invalid-totp",
    "unsupported-totp",
    "invalid-uri-input",
    "uri-context-unavailable",
  ]);
  function finish(id: string, result: BitwardenResult<unknown>) {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    job.cleanup();
    job.resolve(result);
  }
  function cancelMessage(requestId: string, operation: HostOperation) {
    return {
      version: 1,
      type: "crypto.cancel",
      generation,
      requestId,
      ...("session" in operation ? { session: operation.session } : {}),
    };
  }
  function cancelOwned(requestId: string, code: "crypto-locked" | "timeout") {
    const job = pending.get(requestId);
    if (!job) return;
    if ("session" in job.operation) sessions.delete(job.operation.session.sessionId);
    finish(requestId, fail(code));
    try {
      boundPort?.postMessage(cancelMessage(requestId, job.operation));
    } catch {
      if (boundPort) invalidate(boundPort);
    }
  }
  function terminateRef(session: HostSessionRef) {
    try {
      boundPort?.postMessage(cancelMessage(random(), { kind: "lock", session }));
    } catch {
      if (boundPort) invalidate(boundPort);
    }
  }
  function invalidate(port: CryptoHostPort) {
    if (boundPort !== port) return;
    boundPort = undefined;
    ready = false;
    sessions.clear();
    rejectHello?.();
    for (const id of [...pending.keys()]) finish(id, fail("crypto-failed"));
  }
  async function connect(port: CryptoHostPort) {
    const sender = port.sender;
    const connectingCreation = creation;
    if (
      disposed ||
      port.name !== CRYPTO_PORT ||
      !connectingCreation ||
      !sender ||
      sender.id !== deps.extensionId ||
      sender.url !== deps.offscreenUrl ||
      sender.tab !== undefined ||
      sender.frameId !== undefined ||
      sender.nativeApplication !== undefined ||
      boundPort
    ) {
      port.disconnect();
      return;
    }
    const contexts = await deps.getContexts().catch(() => []);
    const context = contexts[0];
    if (
      disposed ||
      boundPort ||
      creation !== connectingCreation ||
      contexts.length !== 1 ||
      context?.documentUrl !== deps.offscreenUrl ||
      typeof context.documentId !== "string" ||
      context.documentId.length === 0 ||
      context.documentId.length > 256 ||
      (sender.documentId !== undefined && sender.documentId !== context.documentId)
    ) {
      port.disconnect();
      return;
    }
    // Chrome's non-tab Port sender can omit documentId. The native singleton
    // context ID is opaque (observed as 32 hex characters), not a UUID. Its exact
    // fresh URL plus browser-reported sender identity binds this Port; a provided
    // sender documentId must still match, rather than being ignored.
    boundPort = port;
    port.onDisconnect.addListener(() => invalidate(port));
    port.onMessage.addListener((message) => {
      if (boundPort !== port || disposed || !boundedMessage(message)) return;
      const lifecycle = v.safeParse(lifecycleSchema, message);
      if (lifecycle.success) {
        if (lifecycle.output.type === "crypto.hello")
          port.postMessage({ version: 1, type: "crypto.reset", generation });
        else if (lifecycle.output.generation === generation) {
          ready = true;
          hello?.();
        }
        return;
      }
      if (!ready) return;
      const progress = v.safeParse(progressSchema, message);
      if (progress.success && progress.output.generation === generation) {
        const job = pending.get(progress.output.requestId);
        if (job?.connectionId === progress.output.connectionId) job.dispatched = true;
        return;
      }
      const parsed = v.safeParse(replySchema, message);
      if (!parsed.success || parsed.output.generation !== generation) return;
      const job = pending.get(parsed.output.requestId);
      if (!job || job.connectionId !== parsed.output.connectionId) return;
      if (now() >= job.deadline) {
        cancelOwned(parsed.output.requestId, "timeout");
        return;
      }
      const result = parsed.output.result;
      if (!result || typeof result !== "object" || !("ok" in result)) {
        finish(parsed.output.requestId, fail("crypto-failed"));
        return;
      }
      if (
        result.ok === false &&
        "error" in result &&
        result.error &&
        typeof result.error === "object" &&
        "code" in result.error &&
        resultCodes.has(String(result.error.code))
      ) {
        if (
          (result.error.code === "crypto-locked" ||
            result.error.code === "timeout" ||
            result.error.code === "crypto-failed") &&
          "session" in job.operation
        ) {
          const sessionId = job.operation.session.sessionId;
          sessions.delete(sessionId);
          for (const [id, other] of pending)
            if (
              id !== parsed.output.requestId &&
              "session" in other.operation &&
              other.operation.session.sessionId === sessionId
            )
              cancelOwned(id, "crypto-locked");
          port.postMessage(cancelMessage(parsed.output.requestId, job.operation));
        }
        finish(parsed.output.requestId, {
          ok: false,
          error: { code: result.error.code },
        } as BitwardenResult<never>);
        return;
      }
      if (result.ok !== true || !("data" in result)) {
        finish(parsed.output.requestId, fail("crypto-failed"));
        return;
      }
      if (job.operation.kind === "verify-received-ciphers") {
        const checked = v.safeParse(
          v.strictObject({
            verifiedCipherCount: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000)),
          }),
          result.data,
        );
        if (!checked.success) {
          cancelOwned(parsed.output.requestId, "crypto-locked");
          return;
        }
      }
      if (job.operation.kind === "catalog") {
        const metadata = v.safeParse(localVaultMetadataSchema, result.data);
        if (
          !metadata.success ||
          metadata.output.connectionId !== job.connectionId ||
          metadata.output.userId !== job.operation.session.userId ||
          metadata.output.snapshotId !== job.operation.session.snapshotId
        ) {
          cancelOwned(parsed.output.requestId, "crypto-locked");
          return;
        }
      }
      if (job.operation.kind === "match-uris") {
        const candidates = v.safeParse(uriCandidatesSchema, result.data);
        if (
          !candidates.success ||
          candidates.output.connectionId !== job.connectionId ||
          candidates.output.userId !== job.operation.session.userId ||
          candidates.output.snapshotId !== job.operation.session.snapshotId ||
          !sameOrigin(job.operation.targetUrl, candidates.output.targetOrigin)
        ) {
          cancelOwned(parsed.output.requestId, "crypto-locked");
          return;
        }
      }
      if (job.operation.kind === "passkey-candidates" || job.operation.kind === "passkey-sign") {
        const operation = job.operation;
        const bound = (entry: {
          connectionId: string;
          userId: string;
          snapshotId: string;
          itemId: string;
        }) =>
          entry.connectionId === job.connectionId &&
          entry.userId === operation.session.userId &&
          entry.snapshotId === operation.session.snapshotId &&
          entry.itemId === operation.itemId.toLowerCase();
        let valid: boolean;
        if (operation.kind === "passkey-candidates") {
          const listed = v.safeParse(passkeyCandidatesSchema, result.data);
          valid = listed.success && listed.output.every(bound);
        } else {
          const signed = v.safeParse(passkeySignatureSchema, result.data);
          const der = signed.success ? fromBase64Url(signed.output.signature) : undefined;
          valid =
            signed.success &&
            bound(signed.output) &&
            signed.output.credentialId === operation.credentialId &&
            der !== undefined &&
            der.length >= 8 &&
            der.length <= 72;
        }
        if (!valid) {
          cancelOwned(parsed.output.requestId, "crypto-locked");
          return;
        }
      }
      if (job.operation.kind === "export-unlock") {
        const exported = result.data as {
          userKey?: unknown;
          metadata?: LocalCryptoSession["metadata"];
        };
        if (
          typeof exported?.userKey !== "string" ||
          exported.userKey.length === 0 ||
          exported.userKey.length > 1_048_576 ||
          exported.metadata?.connectionId !== job.connectionId ||
          exported.metadata.userId !== job.operation.session.userId ||
          !["v1", "v2"].includes(exported.metadata.accountVersion) ||
          ![1, 2].includes(exported.metadata.securityVersion)
        ) {
          cancelOwned(parsed.output.requestId, "crypto-locked");
          return;
        }
      }
      if (job.operation.kind === "open") {
        const opened = result.data as OpenedHostSession;
        const ref = v.safeParse(sessionSchema, opened?.session);
        if (
          !ref.success ||
          ref.output.brokerGeneration !== generation ||
          ref.output.connectionId !== job.connectionId ||
          ref.output.userId !== job.operation.prepared.binding.userId ||
          ref.output.snapshotId !== job.operation.snapshotId ||
          opened.metadata?.userId !== ref.output.userId ||
          opened.metadata.connectionId !== job.connectionId ||
          opened.metadata.accountVersion !== job.operation.prepared.binding.accountVersion ||
          (opened.metadata.securityVersion !== 1 && opened.metadata.securityVersion !== 2) ||
          opened.metadata.securityVersion < job.operation.prepared.minimumSecurityVersion
        ) {
          finish(parsed.output.requestId, fail("crypto-failed"));
          return;
        }
      } else if (
        "session" in job.operation &&
        job.operation.kind !== "lock" &&
        !validSession(job.operation.session)
      ) {
        finish(parsed.output.requestId, fail("crypto-locked"));
        return;
      }
      void (async () => {
        if (job.operation.kind !== "lock" && job.operation.kind !== "close")
          await deps.checkpoint?.("after-result");
        if (boundPort !== port || !pending.has(parsed.output.requestId)) return;
        if (now() >= job.deadline) {
          cancelOwned(parsed.output.requestId, "timeout");
          return;
        }
        if (
          "session" in job.operation &&
          job.operation.kind !== "lock" &&
          !validSession(job.operation.session)
        ) {
          finish(parsed.output.requestId, fail("crypto-locked"));
          return;
        }
        if (job.operation.kind === "open") {
          const opened = result.data as OpenedHostSession;
          sessions.set(opened.session.sessionId, structuredClone(opened.session));
        }
        finish(parsed.output.requestId, { ok: true, data: result.data });
      })().catch(() => finish(parsed.output.requestId, fail("crypto-failed")));
    });
    // Connect can race the initial hello; this secret-free reset is idempotent.
    port.postMessage({ version: 1, type: "crypto.reset", generation });
  }
  const onConnect = (port: CryptoHostPort) => {
    if (port.name !== CRYPTO_PORT) return;
    void connect(port);
  };
  deps.onConnect.addListener(onConnect);
  async function ensure() {
    if (disposed) throw new Error();
    if (ready && boundPort) return;
    if (creation) return creation;
    // Native document creation cannot be cancelled. Quarantine a timed-out bootstrap
    // until its API call settles, rather than letting it race a replacement document.
    if (nativeBootstrap) throw new Error();
    nativeBootstrap = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const bounded = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        active = false;
        rejectHello?.();
        reject(new Error());
      }, timeoutMs);
    });
    const bootstrap = (async () => {
      if (
        timeoutMs < 1 ||
        timeoutMs > 30_000 ||
        !Number.isInteger(timeoutMs) ||
        !v.safeParse(v.pipe(v.string(), v.uuid()), generation).success
      )
        throw new Error();
      // A new service worker never adopts an old offscreen session or its in-flight jobs.
      const contexts = await deps.getContexts();
      if (!active || disposed) throw new Error();
      if (contexts.length) await deps.closeDocument();
      if (!active || disposed) throw new Error();
      const wait = new Promise<void>((resolve, reject) => {
        hello = resolve;
        rejectHello = () => reject(new Error());
      });
      // Prevent an unhandled rejected handshake if native document creation fails.
      void wait.catch(() => {});
      await deps.createDocument();
      if (!active || disposed) throw new Error();
      await wait;
    })().finally(() => {
      nativeBootstrap = false;
    });
    creation = Promise.race([bootstrap, bounded]);
    try {
      await creation;
    } catch (error) {
      active = false;
      if (boundPort) {
        const old = boundPort;
        invalidate(old);
        old.disconnect();
      }
      throw error;
    } finally {
      active = false;
      clearTimeout(timer!);
      hello = undefined;
      rejectHello = undefined;
      creation = undefined;
    }
  }
  function validSession(input: HostSessionRef) {
    const parsed = v.safeParse(sessionSchema, input);
    if (!parsed.success || parsed.output.brokerGeneration !== generation) return false;
    const owned = sessions.get(parsed.output.sessionId);
    return (
      owned &&
      Object.entries(owned).every(
        ([key, value]) => parsed.output[key as keyof HostSessionRef] === value,
      )
    );
  }
  async function request<T>(
    connectionId: string,
    operation: HostOperation,
    signal?: AbortSignal,
  ): Promise<BitwardenResult<T>> {
    if (disposed) return fail("crypto-locked");
    if (closing.has(connectionId) && operation.kind !== "close") return fail("crypto-locked");
    if (signal?.aborted) return fail("cancelled");
    const budget = deps.requestTimeoutMs?.() ?? timeoutMs;
    if (!Number.isInteger(budget) || budget < 1 || budget > 30_000) return fail("invalid-request");
    let command: {
      version: number;
      type: string;
      generation: string;
      requestId: string;
      connectionId: string;
      operation: HostOperation;
    };
    try {
      command = structuredClone({
        version: 1,
        type: "crypto.command",
        generation,
        requestId: random(),
        connectionId,
        operation,
      });
    } catch {
      return fail("invalid-request");
    }
    if (
      !boundedMessage(command) ||
      !v.safeParse(commandSchema, command).success ||
      pending.has(command.requestId)
    )
      return fail("invalid-request");
    operation = command.operation;
    if (
      operation.kind === "open" &&
      operation.prepared?.binding?.profile?.connectionId !== connectionId
    )
      return fail("account-mismatch");
    if ("session" in operation && operation.kind !== "lock" && !validSession(operation.session))
      return fail("crypto-locked");
    const destructive = operation.kind === "lock" || operation.kind === "close";
    if (
      pending.size >= (destructive ? 16 : 8) ||
      (operation.kind === "open" && sessions.size >= 4) ||
      ((operation.kind === "open" || operation.kind === "derive-auth") &&
        [...pending.values()].some(
          (job) => job.operation.kind === "open" || job.operation.kind === "derive-auth",
        ))
    )
      return fail("resource-limit");
    return new Promise<BitwardenResult<T>>((resolve) => {
      const cancel = (code: "cancelled" | "timeout") => {
        if (!pending.has(command.requestId)) return;
        // Invalidate the session immediately; the supervisor terminates its Worker before ACK.
        if ("session" in operation) sessions.delete(operation.session.sessionId);
        finish(command.requestId, fail(code));
        const port = boundPort;
        try {
          port?.postMessage(cancelMessage(command.requestId, operation));
        } catch {
          if (port) invalidate(port);
        }
      };
      const aborted = () => cancel("cancelled");
      const timer = setTimeout(() => cancel("timeout"), budget);
      pending.set(command.requestId, {
        connectionId,
        operation,
        deadline: now() + budget,
        dispatched: false,
        timer,
        resolve: (result) => resolve(result as BitwardenResult<T>),
        cleanup: () => signal?.removeEventListener("abort", aborted),
      });
      signal?.addEventListener("abort", aborted, { once: true });
      void (async () => {
        await ensure();
        if (!destructive) await deps.checkpoint?.("before-dispatch");
        if (!pending.has(command.requestId)) return;
        if (signal?.aborted || disposed || !boundPort || !ready) {
          finish(command.requestId, fail(signal?.aborted ? "cancelled" : "crypto-locked"));
          return;
        }
        if (
          "session" in operation &&
          operation.kind !== "lock" &&
          !validSession(operation.session)
        ) {
          finish(command.requestId, fail("crypto-locked"));
          return;
        }
        boundPort.postMessage(command);
      })().catch(() => finish(command.requestId, fail("crypto-failed")));
    });
  }
  return {
    generation,
    deriveAuthentication(
      input: {
        connectionId: string;
        email: string;
        password: string;
        prelogin: { mode: "legacy" | "password"; response: unknown };
      },
      signal?: AbortSignal,
    ) {
      return request<{ connectionId: string; masterPasswordHash: string }>(
        input.connectionId,
        { kind: "derive-auth", input },
        signal,
      );
    },
    open(
      input: {
        connectionId: string;
        prepared: PreparedBitwardenAccount;
        snapshotId: string;
        unlock: HostUnlock;
      },
      signal?: AbortSignal,
    ) {
      return request<OpenedHostSession>(
        input.connectionId,
        {
          kind: "open",
          prepared: input.prepared,
          snapshotId: input.snapshotId,
          unlock: input.unlock,
        },
        signal,
      );
    },
    decryptCipher(session: HostSessionRef, itemId: string, signal?: AbortSignal) {
      return request<unknown>(session.connectionId, { kind: "decrypt", session, itemId }, signal);
    },
    verifyReceivedCiphers(session: HostSessionRef, signal?: AbortSignal) {
      return request<{ verifiedCipherCount: number }>(
        session.connectionId,
        { kind: "verify-received-ciphers", session },
        signal,
      );
    },
    exportUnlockMaterial(session: HostSessionRef, signal?: AbortSignal) {
      return request<{ userKey: string; metadata: LocalCryptoSession["metadata"] }>(
        session.connectionId,
        { kind: "export-unlock", session },
        signal,
      );
    },
    listFields(session: HostSessionRef, itemId: string, signal?: AbortSignal) {
      return request<readonly LocalFieldMetadata[]>(
        session.connectionId,
        { kind: "list", session, itemId },
        signal,
      );
    },
    catalog(session: HostSessionRef, signal?: AbortSignal) {
      return request<LocalVaultMetadata>(
        session.connectionId,
        { kind: "catalog", session },
        signal,
      );
    },
    resolveField(
      session: HostSessionRef,
      ref: LocalFieldReference,
      grant: { allowedFieldIds: readonly string[]; nowMs?: number },
      signal?: AbortSignal,
    ) {
      return request<LocalFieldValue>(
        session.connectionId,
        { kind: "resolve", session, ref, ...grant },
        signal,
      );
    },
    /** Provider candidates for one target URL; no URI strings, values or grants leave the Worker. */
    matchUris(session: HostSessionRef, targetUrl: string, signal?: AbortSignal) {
      return request<UriCandidates>(
        session.connectionId,
        { kind: "match-uris", session, targetUrl },
        signal,
      );
    },
    /** Secret-free metadata for one item's stored passkey. */
    passkeyCandidates(session: HostSessionRef, itemId: string, signal?: AbortSignal) {
      return request<readonly LocalPasskeyCredential[]>(
        session.connectionId,
        { kind: "passkey-candidates", session, itemId },
        signal,
      );
    },
    /** A DER signature from the item's stored key; the key never leaves the Worker. */
    signPasskey(
      session: HostSessionRef,
      input: { itemId: string } & PasskeySignRequest,
      signal?: AbortSignal,
    ) {
      return request<PasskeySignature>(
        session.connectionId,
        {
          kind: "passkey-sign",
          session,
          itemId: input.itemId,
          credentialId: input.credentialId,
          rpId: input.rpId,
          authenticatorData: input.authenticatorData,
          clientDataHash: input.clientDataHash,
        },
        signal,
      );
    },
    async lock(session: HostSessionRef) {
      if (!validSession(session)) return fail("crypto-locked");
      terminateRef(session);
      sessions.delete(session.sessionId);
      for (const [id, job] of pending)
        if (
          "session" in job.operation &&
          job.operation.session.sessionId === session.sessionId &&
          job.operation.kind !== "lock"
        )
          cancelOwned(id, "crypto-locked");
      return request(session.connectionId, { kind: "lock", session });
    },
    async closeConnection(connectionId: string) {
      if (closing.has(connectionId)) return fail("crypto-locked");
      closing.add(connectionId);
      for (const [id, ref] of sessions)
        if (ref.connectionId === connectionId) {
          terminateRef(ref);
          sessions.delete(id);
        }
      for (const [id, job] of pending)
        if (job.connectionId === connectionId) cancelOwned(id, "crypto-locked");
      try {
        return await request(connectionId, { kind: "close" });
      } finally {
        closing.delete(connectionId);
      }
    },
    status() {
      return {
        generation,
        ready,
        pending: pending.size,
        dispatched: [...pending.values()].filter((job) => job.dispatched).length,
        sessions: sessions.size,
        offscreenDocumentBound: !!boundPort,
      };
    },
    async dispose() {
      disposed = true;
      ready = false;
      sessions.clear();
      deps.onConnect.removeListener(onConnect);
      if (boundPort) {
        const port = boundPort;
        invalidate(port);
        port.disconnect();
      }
      await deps.closeDocument().catch(() => {});
    },
  };
}
export type CryptoHost = ReturnType<typeof createCryptoHost>;
