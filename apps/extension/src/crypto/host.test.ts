import { afterEach, describe, expect, it, vi } from "vitest";
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

function auth() {
  return {
    connectionId: String(connectionId),
    email: v1Email,
    password: v1Password,
    prelogin: { mode: "legacy" as const, response: { kdf: 0, kdfIterations: 100_000 } },
  };
}

function harness(
  options: {
    timeoutMs?: number;
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
  const open = async (ownedConnectionId: string = connectionId) => {
    const index = commands.length;
    const mapped = prepared();
    const pending = host.open({
      connectionId: ownedConnectionId,
      prepared: {
        ...mapped,
        binding: {
          ...mapped.binding,
          profile: { ...mapped.binding.profile, connectionId: ownedConnectionId },
        },
      },
      snapshotId,
      unlock: { kind: "password", password: v1Password },
    });
    const request = await command(index);
    const session: HostSessionRef = {
      brokerGeneration: host.generation,
      connectionId: ownedConnectionId,
      userId: accountUserId,
      sessionId: crypto.randomUUID(),
      snapshotId,
    };
    reply(request, {
      ok: true,
      data: {
        session,
        metadata: {
          connectionId: ownedConnectionId,
          userId: accountUserId,
          accountVersion: "v1",
          securityVersion: 1,
        },
      },
    });
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
  await Promise.all(disposed.splice(0).map((host) => host.dispose()));
  vi.restoreAllMocks();
});

describe("background-only crypto host authorization and handshake", () => {
  it("leaves another subsystem's named Port untouched while still rejecting an owned crypto name from a spoofed sender", async () => {
    const h = harness();
    const unrelated = {
      ...h.port,
      name: "pateat.bitwarden-setup.v1",
      sender: { id: extensionId, url: `chrome-extension://${extensionId}/options.html` },
      disconnect: vi.fn(),
      postMessage: vi.fn(),
    };
    h.onConnect.emit(unrelated);
    await Promise.resolve();
    expect(unrelated.disconnect).not.toHaveBeenCalled();
    expect(unrelated.postMessage).not.toHaveBeenCalled();
    expect(h.getContexts).not.toHaveBeenCalled();
    expect(h.host.status()).toMatchObject({ ready: false, offscreenDocumentBound: false });
    const spoofed = { ...unrelated, name: CRYPTO_PORT, disconnect: vi.fn() };
    h.onConnect.emit(spoofed);
    await vi.waitFor(() => expect(spoofed.disconnect).toHaveBeenCalledOnce());
    expect(spoofed.postMessage).not.toHaveBeenCalled();
    expect(h.getContexts).not.toHaveBeenCalled();
  });
  it("closes a prior offscreen document and binds only the fresh browser document before sending secrets", async () => {
    const h = harness({ existing: true, automaticReady: false });
    const pending = h.host.deriveAuthentication(auth());
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalled());
    expect(h.closeDocument).toHaveBeenCalledOnce();
    expect(h.createDocument).toHaveBeenCalledOnce();
    expect(h.closeDocument.mock.invocationCallOrder[0]).toBeLessThan(
      h.createDocument.mock.invocationCallOrder[0]!,
    );
    expect(h.commands).toEqual([]);
    expect(h.posted).toEqual([{ version: 1, type: "crypto.reset", generation: h.host.generation }]);
    h.onMessage.emit({ version: 1, type: "crypto.ready", generation: crypto.randomUUID() });
    expect(h.commands).toEqual([]);
    h.onMessage.emit({ version: 1, type: "crypto.ready", generation: h.host.generation });
    const command = await h.command();
    expect(command.operation).toEqual({ kind: "derive-auth", input: auth() });
    h.reply(command, { ok: true, data: { connectionId, masterPasswordHash: "synthetic-hash" } });
    expect(await pending).toMatchObject({ ok: true });
  });

  it.each([
    { id: "other-extension", url: offscreenUrl, documentId },
    { id: extensionId, url: `chrome-extension://${extensionId}/options.html`, documentId },
    { id: extensionId, url: oldOffscreenUrl },
    { id: extensionId, url: `chrome-extension://${extensionId}/crypto-offscreen.html` },
    { id: extensionId, url: offscreenUrl, documentId: "" },
    { id: extensionId, url: offscreenUrl, documentId: "not-current-document" },
    { id: extensionId, url: offscreenUrl, documentId, tab: { id: 1 } },
    { id: extensionId, url: offscreenUrl, documentId, frameId: 0 },
    { id: extensionId, url: offscreenUrl, documentId, nativeApplication: "synthetic-native" },
  ])("rejects spoofed port identity case %# even if its name is correct", async (sender) => {
    const h = harness({ automaticReady: false, timeoutMs: 20 });
    h.port.sender = sender;
    const pending = h.host.deriveAuthentication(auth());
    await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
    expect(await pending).toEqual({ ok: false, error: { code: "timeout" } });
    expect(h.createDocument).toHaveBeenCalledOnce();
    expect(h.port.postMessage).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
  });

  it("rejects unsolicited ports before document creation", async () => {
    const h = harness();
    h.onConnect.emit(h.port);
    await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
    expect(h.createDocument).not.toHaveBeenCalled();
    expect(h.port.postMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, documentId])(
    "uses the singleton native context when sender documentId is %s",
    async (suppliedId) => {
      const h = harness();
      if (suppliedId !== undefined) h.port.sender!.documentId = suppliedId;
      const pending = h.host.deriveAuthentication(auth());
      const command = await h.command();
      expect(h.host.status()).toMatchObject({ ready: true, offscreenDocumentBound: true });
      expect(h.port.disconnect).not.toHaveBeenCalled();
      h.reply(command, { ok: false, error: { code: "unsupported-crypto" } });
      expect(await pending).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    },
  );

  it.each(
    [
      [],
      [{ documentId, documentUrl: oldOffscreenUrl }],
      [{ documentId }],
      [{ documentUrl: offscreenUrl }],
      [{ documentId: "", documentUrl: offscreenUrl }],
      [{ documentId: "x".repeat(257), documentUrl: offscreenUrl }],
      [
        { documentId, documentUrl: offscreenUrl },
        { documentId, documentUrl: offscreenUrl },
      ],
      [
        { documentId, documentUrl: offscreenUrl },
        { documentId: "old-document", documentUrl: oldOffscreenUrl },
      ],
    ].map((contexts) => ({ contexts })),
  )(
    "rejects nonauthoritative native contexts case %# without secret dispatch",
    async ({ contexts: nativeContexts }) => {
      const h = harness({ timeoutMs: 20, creationContexts: nativeContexts });
      const pending = h.host.deriveAuthentication(auth());
      await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
      expect(await pending).toEqual({ ok: false, error: { code: "timeout" } });
      expect(h.port.postMessage).not.toHaveBeenCalled();
      expect(h.commands).toEqual([]);
      expect(h.host.status()).toMatchObject({ ready: false, offscreenDocumentBound: false });
    },
  );

  it("rejects a delayed native context lookup after its bootstrap has expired", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi.fn(() => held);
    const h = harness({ timeoutMs: 20, contextLookup: lookup });
    const pending = h.host.deriveAuthentication(auth());
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    expect(await pending).toEqual({ ok: false, error: { code: "timeout" } });
    // The lookup still returns the previously valid browser context. Its old
    // creation identity must not bind the Port after cleanup changed lifecycle.
    release();
    await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
    expect(h.port.postMessage).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
    expect(h.host.status()).toMatchObject({ ready: false, offscreenDocumentBound: false });
  });
});

describe("fixed operations, session scope and reply fencing", () => {
  it("rejects malformed requests and pre-cancelled work without creating a host", async () => {
    const h = harness();
    expect(await h.host.deriveAuthentication({ ...auth(), connectionId: "" })).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(await h.host.deriveAuthentication(auth(), aborted.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  it.each(["generation", "requestId", "connectionId"])(
    "ignores replies with stale %s without settling current work",
    async (field) => {
      const h = harness();
      const pending = h.host.deriveAuthentication(auth());
      const command = await h.command();
      const settled = vi.fn();
      void pending.then(settled);
      h.reply(command, { ok: true, data: "stale-secret" }, { [field]: crypto.randomUUID() });
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(h.host.status().pending).toBe(1);
      h.reply(command, { ok: false, error: { code: "unsupported-crypto" } });
      expect(await pending).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    },
  );

  it.each([
    null,
    { ok: false, error: { code: "synthetic-secret-error", cause: "password" } },
    { ok: true },
  ])("sanitizes malformed response case %# without passing arbitrary errors", async (result) => {
    const h = harness();
    const pending = h.host.deriveAuthentication(auth());
    h.reply(await h.command(), result);
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-failed" } });
  });

  it.each(["brokerGeneration", "connectionId", "userId", "sessionId", "snapshotId"])(
    "rejects a changed session %s before any command is sent",
    async (field) => {
      const h = harness();
      const session = await h.open();
      const before = h.commands.length;
      expect(
        await h.host.decryptCipher({ ...session, [field]: crypto.randomUUID() }, itemId),
      ).toEqual({ ok: false, error: { code: "crypto-locked" } });
      expect(h.commands).toHaveLength(before);
    },
  );

  it("selects encrypted items by fixed item ID and preserves typed field grants", async () => {
    const h = harness();
    const session = await h.open();
    const ref = {
      connectionId,
      userId: accountUserId,
      itemId,
      snapshotId,
      fieldId: "login.password",
    };
    const pending = h.host.resolveField(session, ref, {
      allowedFieldIds: ["login.password"],
      nowMs: 59_000,
    });
    const command = await h.command(1);
    expect(command.operation).toEqual({
      kind: "resolve",
      session,
      ref,
      allowedFieldIds: ["login.password"],
      nowMs: 59_000,
    });
    h.reply(command, { ok: true, data: { kind: "text", value: "synthetic-field-value" } });
    expect(await pending).toEqual({
      ok: true,
      data: { kind: "text", value: "synthetic-field-value" },
    });
    expect(h.host.status()).not.toHaveProperty("password");
  });

  const uriCandidates = {
    connectionId,
    userId: accountUserId,
    snapshotId,
    targetOrigin: "https://example.com",
    candidates: [{ itemId, matches: [{ uriIndex: 0, match: 0 }] }],
    unavailableUris: [{ itemId, uriIndex: 1, reason: "default-match-unavailable" }],
    unavailableItemIds: [],
  };
  it("returns snapshot-bound URI candidates without URI strings", async () => {
    const h = harness();
    const session = await h.open();
    const matched = h.host.matchUris(session, "https://example.com/login");
    const request = await h.command(1);
    expect(request.operation).toEqual({
      kind: "match-uris",
      session,
      targetUrl: "https://example.com/login",
    });
    h.reply(request, { ok: true, data: uriCandidates });
    expect(await matched).toEqual({ ok: true, data: uriCandidates });
  });

  it.each([
    { ...uriCandidates, snapshotId: crypto.randomUUID() },
    { ...uriCandidates, targetOrigin: "https://example.net" },
    { ...uriCandidates, candidates: [{ itemId, matches: [], uri: "https://example.com" }] },
  ])("locks the session on a URI reply for another snapshot or shape case %#", async (data) => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.matchUris(session, "https://example.com/login");
    h.reply(await h.command(1), { ok: true, data });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await h.host.catalog(session)).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });

  it("forwards an unavailable URI context as its own result", async () => {
    const h = harness();
    const session = await h.open();
    const matched = h.host.matchUris(session, "https://example.com/login");
    h.reply(await h.command(1), { ok: false, error: { code: "uri-context-unavailable" } });
    expect(await matched).toEqual({ ok: false, error: { code: "uri-context-unavailable" } });
  });

  const passkeyBinding = { connectionId, userId: accountUserId, snapshotId, itemId };
  const storedPasskey = {
    ...passkeyBinding,
    credentialId: "EjRWeBI0QjSCNBI0VniavA",
    rpId: "example.com",
    userHandle: "c3ludGhldGljLXVzZXI",
    discoverable: true,
    counter: 0,
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
  it("finds snapshot-bound passkey metadata by RP ID and signs by item ID inside the Worker", async () => {
    const h = harness();
    const session = await h.open();
    const found = h.host.findPasskeys(session, "example.com");
    const finding = await h.command(1);
    expect(finding.operation).toEqual({ kind: "passkey-find", session, rpId: "example.com" });
    h.reply(finding, { ok: true, data: passkeyMatches });
    expect(await found).toEqual({ ok: true, data: passkeyMatches });
    const signed = h.host.signPasskey(session, signInput);
    const signing = await h.command(2);
    expect(signing.operation).toEqual({ kind: "passkey-sign", session, ...signInput });
    h.reply(signing, { ok: true, data: passkeySignature });
    expect(await signed).toEqual({ ok: true, data: passkeySignature });
  });

  it("forwards a per-item passkey failure without locking the session", async () => {
    const h = harness();
    const session = await h.open();
    const signed = h.host.signPasskey(session, signInput);
    h.reply(await h.command(1), { ok: false, error: { code: "unsupported-crypto" } });
    expect(await signed).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    const empty = { ...passkeyMatches, candidates: [], unavailableItemIds: [] };
    const found = h.host.findPasskeys(session, "example.com");
    h.reply(await h.command(2), { ok: true, data: empty });
    expect(await found).toEqual({ ok: true, data: empty });
  });

  it.each([
    { kind: "find", data: { ...passkeyMatches, snapshotId: crypto.randomUUID() } },
    { kind: "find", data: { ...passkeyMatches, rpId: "example.net" } },
    {
      kind: "find",
      data: { ...passkeyMatches, candidates: [{ ...storedPasskey, userId: crypto.randomUUID() }] },
    },
    {
      kind: "find",
      data: { ...passkeyMatches, candidates: [{ ...storedPasskey, rpId: "example.net" }] },
    },
    { kind: "find", data: { ...passkeyMatches, candidates: [storedPasskey, storedPasskey] } },
    {
      kind: "find",
      data: { ...passkeyMatches, unavailableItemIds: [storedPasskey.itemId.toUpperCase()] },
    },
    {
      kind: "find",
      data: { ...passkeyMatches, unavailableItemIds: [itemId, itemId.toUpperCase()] },
    },
    {
      kind: "find",
      data: { ...passkeyMatches, candidates: [{ ...storedPasskey, keyValue: "synthetic-key" }] },
    },
    { kind: "sign", data: { ...passkeySignature, userId: crypto.randomUUID() } },
    { kind: "sign", data: { ...passkeySignature, snapshotId: crypto.randomUUID() } },
    { kind: "sign", data: { ...passkeySignature, itemId: crypto.randomUUID() } },
    { kind: "sign", data: { ...passkeySignature, credentialId: "AQID" } },
    { kind: "sign", data: { ...passkeySignature, signature: "MAYC" } },
    { kind: "sign", data: { ...passkeySignature, privateKey: "synthetic-key" } },
  ])("locks the session on a passkey reply for another scope or shape case %#", async (reply) => {
    const h = harness();
    const session = await h.open();
    const pending =
      reply.kind === "find"
        ? h.host.findPasskeys(session, "example.com")
        : h.host.signPasskey(session, signInput);
    h.reply(await h.command(1), { ok: true, data: reply.data });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await h.host.catalog(session)).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });

  it.each([
    { ...signInput, authenticatorData: "A".repeat(49) },
    { ...signInput, clientDataHash: "B".repeat(42) + "=" },
    { ...signInput, credentialId: "" },
    { ...signInput, rpId: "x".repeat(254) },
  ])("rejects a malformed signing request before dispatch case %#", async (input) => {
    const h = harness();
    const session = await h.open();
    expect(await h.host.signPasskey(session, input)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(h.commands).toHaveLength(1);
  });

  it("lock immediately invalidates access and withholds a pending plaintext reply", async () => {
    const h = harness({ timeoutMs: 200 });
    const session = await h.open();
    const decrypting = h.host.decryptCipher(session, itemId);
    const decrypt = await h.command(1);
    const locking = h.host.lock(session);
    const lock = await h.command(2);
    expect(await h.host.listFields(session, itemId)).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
    h.reply(decrypt, { ok: true, data: { login: { password: "late-synthetic-secret" } } });
    expect(await decrypting).toEqual({ ok: false, error: { code: "crypto-locked" } });
    h.reply(lock, { ok: true, data: null });
    expect(await locking).toMatchObject({ ok: true });
  });
});

describe("cancellation, deadlines and host loss", () => {
  it.each(["before-dispatch", "after-result"] as const)(
    "closing a connection at %s cancels its pending open and cannot resurrect a session",
    async (checkpoint) => {
      let release!: () => void;
      let blocked = false;
      const entered = vi.fn();
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({
        checkpoint: async (stage) => {
          if (stage === checkpoint && !blocked) {
            blocked = true;
            entered();
            await gate;
          }
        },
      });
      const pending = h.host.open({
        connectionId,
        prepared: prepared(),
        snapshotId,
        unlock: { kind: "password", password: v1Password },
      });
      if (checkpoint === "after-result") {
        const command = await h.command();
        h.reply(command, {
          ok: true,
          data: {
            session: {
              brokerGeneration: h.host.generation,
              connectionId,
              userId: accountUserId,
              snapshotId,
              sessionId: crypto.randomUUID(),
            },
            metadata: {
              connectionId,
              userId: accountUserId,
              accountVersion: "v1",
              securityVersion: 1,
            },
          },
        });
      }
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      const closing = h.host.closeConnection(connectionId);
      const close = await h.command(checkpoint === "after-result" ? 1 : 0);
      expect(close.operation).toEqual({ kind: "close" });
      h.reply(close, { ok: true, data: null });
      expect(await closing).toMatchObject({ ok: true });
      expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
      release();
      await Promise.resolve();
      expect(h.host.status()).toMatchObject({ pending: 0, sessions: 0 });
      if (checkpoint === "before-dispatch")
        expect(h.commands.map((command) => command.operation.kind)).toEqual(["close"]);
    },
  );

  it("reserves destructive lock capacity even while unrelated data requests fill the pending limit", async () => {
    const h = harness();
    const a = await h.open();
    const b = await h.open("synthetic-other-connection");
    const pending = Array.from({ length: 8 }, () => h.host.decryptCipher(b, itemId));
    await h.command(9);
    expect(await h.host.decryptCipher(a, itemId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    const locking = h.host.lock(a);
    const command = await h.command(10);
    expect(command.operation).toEqual({ kind: "lock", session: a });
    h.reply(command, { ok: true, data: null });
    expect(await locking).toMatchObject({ ok: true });
    expect(await h.host.listFields(a, itemId)).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
    h.onDisconnect.emit();
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 8 }, () => ({ ok: false, error: { code: "crypto-failed" } })),
    );
  });

  it("bounds native initialization work before the handshake instead of admitting concurrent KDF jobs", async () => {
    const h = harness({ automaticReady: false, timeoutMs: 100 });
    const controller = new AbortController();
    const first = h.host.deriveAuthentication(auth(), controller.signal);
    expect(
      await h.host.deriveAuthentication({ ...auth(), connectionId: "second-connection" }),
    ).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    controller.abort();
    expect(await first).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(h.commands).toEqual([]);
  });

  it("cancellation at the dispatch barrier prevents any secret command delivery", async () => {
    let release!: () => void;
    const entered = vi.fn();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      checkpoint: async (stage) => {
        if (stage === "before-dispatch") {
          entered();
          await gate;
        }
      },
    });
    const controller = new AbortController();
    const pending = h.host.deriveAuthentication(auth(), controller.signal);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    release();
    await Promise.resolve();
    expect(h.commands).toEqual([]);
    expect(h.host.status().pending).toBe(0);
  });

  it("copies request inputs before asynchronous delivery so caller mutation cannot change the account or password", async () => {
    let release!: () => void;
    const entered = vi.fn();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      checkpoint: async (stage) => {
        if (stage === "before-dispatch") {
          entered();
          await gate;
        }
      },
    });
    const input = auth();
    const expected = structuredClone(input);
    const pending = h.host.deriveAuthentication(input);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    input.connectionId = "changed-connection";
    input.password = "changed-secret";
    input.prelogin.response.kdfIterations = 600_000;
    release();
    const command = await h.command();
    expect(command.connectionId).toBe(connectionId);
    expect(command.operation).toEqual({ kind: "derive-auth", input: expected });
    h.reply(command, { ok: false, error: { code: "cancelled" } });
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
  });

  it.each(["abort", "deadline"])(
    "sends a generation-bound cancellation on %s and ignores the late native result",
    async (cause) => {
      const h = harness({ timeoutMs: cause === "abort" ? 500 : 30 });
      const controller = new AbortController();
      const pending = h.host.deriveAuthentication(auth(), controller.signal);
      const command = await h.command();
      if (cause === "abort") controller.abort();
      expect(await pending).toEqual({
        ok: false,
        error: { code: cause === "abort" ? "cancelled" : "timeout" },
      });
      expect(h.posted).toContainEqual({
        version: 1,
        type: "crypto.cancel",
        generation: h.host.generation,
        requestId: command.requestId,
      });
      h.reply(command, { ok: true, data: { connectionId, masterPasswordHash: "late-secret" } });
      expect(h.host.status().pending).toBe(0);
    },
  );

  it("disconnect invalidates sessions and fails every pending job without native details", async () => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.decryptCipher(session, itemId);
    await h.command(1);
    h.onDisconnect.emit();
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-failed" } });
    expect(h.host.status()).toMatchObject({
      ready: false,
      pending: 0,
      sessions: 0,
      offscreenDocumentBound: false,
    });
    expect(await h.host.decryptCipher(session, itemId)).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
  });

  it("dispose synchronously locks access and settles pending work even when document cleanup fails", async () => {
    const h = harness();
    const pending = h.host.deriveAuthentication(auth());
    await h.command();
    h.closeDocument.mockRejectedValueOnce(new Error("synthetic-cleanup-secret"));
    const closing = h.host.dispose();
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-failed" } });
    expect(await h.host.deriveAuthentication(auth())).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
    await closing;
  });
});
