import { afterEach, describe, expect, vi } from "vitest";
import { createBitwardenAccountMapper } from "@pateat/bitwarden";
import { createCryptoHost, type CryptoHost, type CryptoHostPort } from "./host";
import { CRYPTO_PORT, type HostCommand, type HostSessionRef } from "./wire";
import {
  accountNow,
  accountProfile,
  accountUserId,
  rawV1Account,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email, v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { registerAuthorizationCases } from "../../test/crypto/host/authorization";
import { registerRequestFencingCases } from "../../test/crypto/host/request-fencing";
import { registerUriAndSessionLanesCases } from "../../test/crypto/host/uri-and-session-lanes";
import { registerCustomFieldDigestsCases } from "../../test/crypto/host/custom-field-digests";
import { registerLoginUsernamesCases } from "../../test/crypto/host/login-usernames";
import { registerPasskeysCases } from "../../test/crypto/host/passkeys";
import { registerCancellationAndHostLossCases } from "../../test/crypto/host/cancellation-and-host-loss";
import { registerSsoFencingCases } from "../../test/crypto/host/sso-fencing";

const extensionId = "synthetic-extension";
const offscreenUrl = `chrome-extension://${extensionId}/crypto-offscreen.html?host=10000000-0000-4000-8000-000000000001`;
const oldOffscreenUrl = `chrome-extension://${extensionId}/crypto-offscreen.html?host=10000000-0000-4000-8000-000000000002`;
// Measured Chrome OFFSCREEN_DOCUMENT IDs are opaque, not UUIDs.
const documentId = "F0C415033F9ADF891E9AB03CEFB1556B";
type NativeContext = { documentId?: string; documentUrl?: string };
const snapshotId = "20000000-0000-4000-8000-000000000001";
const itemId = "090c19ea-a61a-4df6-8963-262b97bc6266";
const connectionId = accountProfile.connectionId;
const disposed: CryptoHost[] = [];

class Event<T extends unknown[]> {
  private listeners = new Set<(...args: T) => void>();
  addListener(listener: (...args: T) => void) {
    this.listeners.add(listener);
  }
  removeListener(listener: (...args: T) => void) {
    this.listeners.delete(listener);
  }
  emit(...args: T) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

function prepared() {
  const raw = rawV1Account();
  const {
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: _type,
    refresh_token: refreshToken,
    ...encryptedAccount
  } = raw.token;
  const factory = createBitwardenAccountMapper(
    accountProfile,
    { kind: "bootstrap", email: v1Email },
    {
      nowSeconds: () => accountNow,
    },
  );
  if (!factory.ok) throw new Error("Synthetic mapper factory rejected");
  const mapped = factory.data.map({
    connectionId,
    sync: raw.sync,
    authenticated: {
      kind: "authenticated",
      tokens: { accessToken, tokenType: "Bearer", expiresIn, refreshToken },
      encryptedAccount,
    },
  });
  if (!mapped.ok) throw new Error("Synthetic fixture mapping rejected");
  return mapped.data;
}

/** An open request for an account prepared under `ownedConnectionId`. */
function openInput(ownedConnectionId: string = connectionId) {
  const mapped = prepared();
  return {
    connectionId: ownedConnectionId,
    prepared: {
      ...mapped,
      binding: {
        ...mapped.binding,
        profile: { ...mapped.binding.profile, connectionId: ownedConnectionId },
      },
    },
    snapshotId,
    unlock: { kind: "password" as const, password: v1Password },
  };
}

/** Settles with the promise's result, or "waiting" if it is still pending after `ms`. */
function within<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms)),
  ]);
}

function auth() {
  return {
    connectionId: String(connectionId),
    email: v1Email,
    password: v1Password,
    prelogin: { mode: "legacy" as const, response: { kdf: 0, kdfIterations: 100_000 } },
  };
}

/** A sign-in whose prelogin asks for Argon2id. */
function argon2idAuth(owner = "connection-2") {
  return {
    ...auth(),
    connectionId: owner,
    prelogin: {
      mode: "legacy" as const,
      response: { kdf: 1, kdfIterations: 2, kdfMemory: 16, kdfParallelism: 1 },
    },
  };
}

function harness(
  options: {
    timeoutMs?: number;
    argon2idTimeoutMs?: number;
    existing?: boolean;
    automaticReady?: boolean;
    checkpoint?: (stage: "before-dispatch" | "after-result") => Promise<void>;
    creationContexts?: NativeContext[];
    contextLookup?: () => Promise<void>;
  } = {},
) {
  const onConnect = new Event<[CryptoHostPort]>();
  const onMessage = new Event<[unknown]>();
  const onDisconnect = new Event<[]>();
  const commands: HostCommand[] = [];
  const posted: unknown[] = [];
  let contexts: NativeContext[] = options.existing
    ? [{ documentId: "old-document", documentUrl: oldOffscreenUrl }]
    : [];
  const port: CryptoHostPort = {
    name: CRYPTO_PORT,
    sender: { id: extensionId, url: offscreenUrl },
    onMessage,
    onDisconnect,
    disconnect: vi.fn(() => onDisconnect.emit()),
    postMessage: vi.fn((message: unknown) => {
      posted.push(structuredClone(message));
      const value = message as { type: string; generation: string };
      if (value.type === "crypto.reset" && options.automaticReady !== false)
        onMessage.emit({ version: 1, type: "crypto.ready", generation: value.generation });
      if (value.type === "crypto.command") commands.push(message as HostCommand);
    }),
  };
  const closeDocument = vi.fn(async () => {
    contexts = [];
  });
  const createDocument = vi.fn(async () => {
    contexts = options.creationContexts ?? [{ documentId, documentUrl: offscreenUrl }];
    onConnect.emit(port);
  });
  const getContexts = vi.fn(async () => {
    const snapshot = structuredClone(contexts);
    if (snapshot[0]?.documentId === documentId) await options.contextLookup?.();
    return snapshot;
  });
  const host = createCryptoHost({
    extensionId,
    offscreenUrl,
    onConnect,
    getContexts,
    closeDocument,
    createDocument,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.argon2idTimeoutMs !== undefined
      ? { argon2idTimeoutMs: options.argon2idTimeoutMs }
      : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
  });
  disposed.push(host);
  const reply = (command: HostCommand, result: unknown, extra: Record<string, unknown> = {}) => {
    onMessage.emit({
      version: 1,
      type: "crypto.result",
      generation: command.generation,
      requestId: command.requestId,
      connectionId: command.connectionId,
      result,
      ...extra,
    });
  };
  const command = async (index = 0) => {
    await vi.waitFor(() => expect(commands.length).toBeGreaterThan(index), { interval: 1 });
    return commands[index]!;
  };
  /** Answers a delivered open as its Worker would and returns the new session. */
  const answerOpen = (request: HostCommand) => {
    const session: HostSessionRef = {
      brokerGeneration: host.generation,
      connectionId: request.connectionId,
      userId: accountUserId,
      sessionId: crypto.randomUUID(),
      snapshotId,
    };
    reply(request, {
      ok: true,
      data: {
        session,
        metadata: {
          connectionId: request.connectionId,
          userId: accountUserId,
          accountVersion: "v1",
          securityVersion: 1,
        },
      },
    });
    return session;
  };
  const open = async (ownedConnectionId: string = connectionId) => {
    const index = commands.length;
    const pending = host.open(openInput(ownedConnectionId));
    // An open the host refuses settles without being delivered; show its result.
    expect(await Promise.race([pending, command(index).then(() => undefined)])).toBeUndefined();
    const session = answerOpen(commands[index]!);
    expect(await pending).toMatchObject({ ok: true, data: { session } });
    return session;
  };
  return {
    host,
    port,
    onConnect,
    onMessage,
    onDisconnect,
    posted,
    commands,
    command,
    reply,
    answerOpen,
    open,
    closeDocument,
    createDocument,
    getContexts,
    setContexts: (next: typeof contexts) => {
      contexts = next;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(disposed.splice(0).map((host) => host.dispose()));
  vi.restoreAllMocks();
});

describe("background-only crypto host authorization and handshake", () => {
  registerAuthorizationCases({
    harness,
    auth,
    extensionId,
    offscreenUrl,
    oldOffscreenUrl,
    documentId,
    connectionId,
  });
});

describe("fixed operations, session scope and reply fencing", () => {
  registerRequestFencingCases({ harness, auth, snapshotId, itemId, connectionId });

  const uriCandidates = {
    connectionId,
    userId: accountUserId,
    snapshotId,
    targetOrigin: "https://example.com",
    candidates: [{ itemId, matches: [{ uriIndex: 0, match: 0 }] }],
    unavailableUris: [{ itemId, uriIndex: 1, reason: "default-match-unavailable" }],
    unavailableItemIds: [],
  };
  registerUriAndSessionLanesCases({
    harness,
    auth,
    openInput,
    within,
    snapshotId,
    itemId,
    connectionId,
    uriCandidates,
  });

  const otherItem = "30000000-0000-4000-8000-000000000003";
  const digests = { digests: { [itemId]: "A".repeat(43), [otherItem]: null } };
  registerCustomFieldDigestsCases({ harness, itemId, otherItem, digests });

  const usernames = { usernames: { [itemId]: "alice@example.test", [otherItem]: null } };
  registerLoginUsernamesCases({ harness, itemId, otherItem, usernames });

  const passkeyBinding = { connectionId, userId: accountUserId, snapshotId, itemId };
  const storedPasskey = {
    ...passkeyBinding,
    credentialId: "EjRWeBI0QjSCNBI0VniavA",
    rpId: "example.com",
    userHandle: "c3ludGhldGljLXVzZXI",
    discoverable: true,
    counter: 0,
    userName: null,
  };
  const signInput = {
    itemId,
    credentialId: storedPasskey.credentialId,
    rpId: storedPasskey.rpId,
    authenticatorData: "A".repeat(50),
    clientDataHash: "B".repeat(43),
  };
  const passkeySignature = {
    ...passkeyBinding,
    credentialId: storedPasskey.credentialId,
    signature: "MAYCAQECAQE",
  };
  const passkeyMatches = {
    connectionId,
    userId: accountUserId,
    snapshotId,
    rpId: storedPasskey.rpId,
    candidates: [storedPasskey],
    unavailableItemIds: [crypto.randomUUID()],
  };
  registerPasskeysCases({
    harness,
    snapshotId,
    itemId,
    connectionId,
    storedPasskey,
    signInput,
    passkeySignature,
    passkeyMatches,
  });
});

describe("cancellation, deadlines and host loss", () => {
  registerCancellationAndHostLossCases({
    harness,
    auth,
    argon2idAuth,
    prepared,
    openInput,
    within,
    snapshotId,
    itemId,
    connectionId,
  });
});

describe("SSO crypto host input and result fencing", () => {
  const fieldId = `custom.${snapshotId}.0`;
  const sourceInput = { itemId, allowedFieldIds: [fieldId] };
  const candidateInput = {
    usernameProof: "P".repeat(43),
    candidates: [{ itemId, allowedFieldIds: ["login.username"] }],
  };
  const sourceResult = {
    itemId,
    snapshotId,
    sourceEvidence: "E".repeat(43),
    result: {
      status: "ready",
      methods: [
        {
          method: { number: 1 },
          fieldId,
          automatic: true,
          form: "bracket",
          label: "Example",
          usernameProof: "P".repeat(43),
        },
      ],
    },
  };
  const candidateResult = {
    snapshotId,
    candidates: [{ itemId, origins: ["https://idp.example.test"] }],
  };
  registerSsoFencingCases({
    harness,
    offscreenUrl,
    itemId,
    sourceInput,
    candidateInput,
    sourceResult,
    candidateResult,
  });
});
