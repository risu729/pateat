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

  it("delivers one job per session at a time instead of refusing a concurrent one", async () => {
    // A passkey signed while a login matches the page's URI uses the same session's Worker.
    const h = harness();
    const a = await h.open();
    const b = await h.open("synthetic-other-connection");
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    const other = h.host.matchUris(b, url);
    const firstCommand = await h.command(2);
    // Another session's job is not held back by this one.
    const otherCommand = await h.command(3);
    expect(firstCommand.operation).toMatchObject({ kind: "match-uris", session: a });
    expect(otherCommand.operation).toMatchObject({ kind: "match-uris", session: b });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands).toHaveLength(4);
    const otherCandidates = { ...uriCandidates, connectionId: "synthetic-other-connection" };
    h.reply(otherCommand, { ok: true, data: otherCandidates });
    expect(await other).toEqual({ ok: true, data: otherCandidates });
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const secondCommand = await h.command(4);
    expect(secondCommand.operation).toMatchObject({ kind: "match-uris", session: a });
    h.reply(secondCommand, { ok: true, data: uriCandidates });
    expect(await second).toEqual({ ok: true, data: uriCandidates });
    expect(h.host.status()).toMatchObject({ pending: 0 });
  });

  it("lets a session's next job go once a waiting earlier job is cancelled", async () => {
    const h = harness();
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const controller = new AbortController();
    const waiting = h.host.matchUris(a, url, controller.signal);
    const third = h.host.matchUris(a, url);
    const firstCommand = await h.command(1);
    controller.abort();
    expect(await waiting).toEqual({ ok: false, error: { code: "cancelled" } });
    // The cancelled job never reaches the Worker, and the third still waits for the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands).toHaveLength(2);
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const thirdCommand = await h.command(2);
    h.reply(thirdCommand, { ok: true, data: uriCandidates });
    expect(await third).toEqual({ ok: true, data: uriCandidates });
    expect(h.commands).toHaveLength(3);
    expect(
      h.posted.filter((message) => (message as { type: string }).type === "crypto.cancel"),
    ).toHaveLength(0);
  });

  it("gives a job that waited for its turn a full budget once it is delivered", async () => {
    const h = harness({ timeoutMs: 300 });
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    const firstCommand = await h.command(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const secondCommand = await h.command(2);
    // Past the budget counted from admission, but within the one counted from delivery.
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.reply(secondCommand, { ok: true, data: uriCandidates });
    expect(await second).toEqual({ ok: true, data: uriCandidates });
  });

  it("refuses a job whose wait for its turn times out and keeps the session open", async () => {
    const h = harness({ timeoutMs: 300 });
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    const third = h.host.matchUris(a, url);
    const firstCommand = await h.command(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.reply(firstCommand, { ok: true, data: uriCandidates });
    expect(await first).toEqual({ ok: true, data: uriCandidates });
    const secondCommand = await h.command(2);
    // The third has waited its whole budget behind the second, without reaching the Worker.
    expect(await third).toEqual({ ok: false, error: { code: "resource-limit" } });
    h.reply(secondCommand, { ok: true, data: uriCandidates });
    expect(await second).toEqual({ ok: true, data: uriCandidates });
    const next = h.host.matchUris(a, url);
    h.reply(await h.command(3), { ok: true, data: uriCandidates });
    expect(await next).toEqual({ ok: true, data: uriCandidates });
    expect(h.commands).toHaveLength(4);
  });

  it("delivers an open for another connection once the open ahead of it settles", async () => {
    const h = harness();
    const first = h.host.open(openInput());
    const firstCommand = await h.command(0);
    // A page restores connection B while a sync of connection A opens its candidate.
    const second = h.host.open(openInput("connection-2"));
    expect(await within(second, 20)).toBe("waiting");
    expect(h.commands).toHaveLength(1);
    const a = h.answerOpen(firstCommand);
    expect(await first).toMatchObject({ ok: true, data: { session: a } });
    const secondCommand = await h.command(1);
    expect(secondCommand).toMatchObject({
      connectionId: "connection-2",
      operation: { kind: "open" },
    });
    const b = h.answerOpen(secondCommand);
    expect(await second).toMatchObject({ ok: true, data: { session: b } });
  });

  it("delivers a derive-auth once the open ahead of it settles", async () => {
    const h = harness();
    const opening = h.host.open(openInput());
    const openCommand = await h.command(0);
    // A manual sign-in starts while a restore opens another connection's vault.
    const deriving = h.host.deriveAuthentication({ ...auth(), connectionId: "connection-2" });
    expect(await within(deriving, 20)).toBe("waiting");
    expect(h.commands).toHaveLength(1);
    h.answerOpen(openCommand);
    expect(await opening).toMatchObject({ ok: true });
    const deriveCommand = await h.command(1);
    expect(deriveCommand.operation).toMatchObject({ kind: "derive-auth" });
    const derived = { connectionId: "connection-2", masterPasswordHash: "synthetic-hash" };
    h.reply(deriveCommand, { ok: true, data: derived });
    expect(await deriving).toEqual({ ok: true, data: derived });
  });

  it("refuses a waiting open whose wait outlasts its budget without delivering it", async () => {
    const h = harness({ timeoutMs: 300 });
    const first = h.host.open(openInput());
    const second = h.host.open(openInput("connection-2"));
    const third = h.host.open(openInput("connection-3"));
    const firstCommand = await h.command(0);
    expect(await within(second, 20)).toBe("waiting");
    await new Promise((resolve) => setTimeout(resolve, 130));
    h.answerOpen(firstCommand);
    expect(await first).toMatchObject({ ok: true });
    const secondCommand = await h.command(1);
    // The third has waited its whole budget behind the second, without reaching the Worker.
    expect(await third).toEqual({ ok: false, error: { code: "resource-limit" } });
    h.answerOpen(secondCommand);
    expect(await second).toMatchObject({ ok: true });
    expect(h.commands).toHaveLength(2);
    expect(
      h.posted.filter((message) => (message as { type: string }).type === "crypto.cancel"),
    ).toHaveLength(0);
  });

  it("fails a session's waiting jobs without delivering them when it is locked", async () => {
    const h = harness();
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    await h.command(1);
    const locking = h.host.lock(a);
    expect(await first).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await second).toEqual({ ok: false, error: { code: "crypto-locked" } });
    const lockCommand = await h.command(2);
    expect(lockCommand.operation).toEqual({ kind: "lock", session: a });
    h.reply(lockCommand, { ok: true, data: null });
    expect(await locking).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands.map((command) => command.operation.kind)).toEqual([
      "open",
      "match-uris",
      "lock",
    ]);
  });

  it("releases a session's waiting job when the job ahead of it fails", async () => {
    const h = harness();
    const a = await h.open();
    const url = "https://example.com/login";
    const first = h.host.matchUris(a, url);
    const second = h.host.matchUris(a, url);
    h.reply(await h.command(1), { ok: false, error: { code: "crypto-failed" } });
    expect(await first).toEqual({ ok: false, error: { code: "crypto-failed" } });
    expect(await second).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(h.host.status()).toMatchObject({ pending: 0 });
  });

  it("forwards an unavailable URI context as its own result", async () => {
    const h = harness();
    const session = await h.open();
    const matched = h.host.matchUris(session, "https://example.com/login");
    h.reply(await h.command(1), { ok: false, error: { code: "uri-context-unavailable" } });
    expect(await matched).toEqual({ ok: false, error: { code: "uri-context-unavailable" } });
  });

  const otherItem = "30000000-0000-4000-8000-000000000003";
  const digests = { digests: { [itemId]: "A".repeat(43), [otherItem]: null } };
  it("requests custom-field digests by item ID without a key and returns only digests", async () => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.customFieldDigests(session, [itemId, otherItem]);
    const request = await h.command(1);
    expect(request.operation).toEqual({
      kind: "custom-digest",
      session,
      itemIds: [itemId, otherItem],
    });
    h.reply(request, { ok: true, data: digests });
    expect(await pending).toEqual({ ok: true, data: digests });
  });

  it.each([
    [itemId, itemId.toUpperCase()],
    Array.from({ length: 2001 }, () => crypto.randomUUID()),
    ["not-a-uuid"],
  ])("rejects a malformed digest request before dispatch case %#", async (...ids) => {
    const h = harness();
    const session = await h.open();
    expect(await h.host.customFieldDigests(session, ids)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(h.commands).toHaveLength(1);
  });

  it.each([
    { digests: { [itemId]: "A".repeat(43) } },
    { digests: { ...digests.digests, [crypto.randomUUID()]: null } },
    { digests: { [itemId]: "A".repeat(42), [otherItem]: null } },
    { digests: { [itemId]: "synthetic-value", [otherItem]: null } },
    { ...digests, values: ["007"] },
  ])("locks the session on a digest reply of another shape case %#", async (data) => {
    const h = harness();
    const session = await h.open();
    const pending = h.host.customFieldDigests(session, [itemId, otherItem]);
    h.reply(await h.command(1), { ok: true, data });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await h.host.catalog(session)).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });

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
    // The session's jobs take turns: only the first is delivered, the rest wait.
    await h.command(2);
    expect(h.host.status()).toMatchObject({ pending: 8 });
    expect(await h.host.decryptCipher(a, itemId)).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    const locking = h.host.lock(a);
    const command = await h.command(3);
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

  it("opens a sync candidate for a connection while four connections have vaults open", async () => {
    const h = harness();
    const connections = [connectionId, "connection-2", "connection-3", "connection-4"];
    for (const owned of connections) await h.open(owned);
    // A sync opens its candidate while the connection's live session is still open.
    const candidate = await h.open("connection-2");
    expect(candidate.connectionId).toBe("connection-2");
    expect(h.host.status()).toMatchObject({ sessions: 5 });
  });

  it("refuses a fifth connection's vault and a third session of one connection", async () => {
    const h = harness();
    const connections = [connectionId, "connection-2", "connection-3", "connection-4"];
    for (const owned of connections) await h.open(owned);
    await h.open("connection-2");
    const sent = h.commands.length;
    expect(await h.host.open(openInput("connection-5"))).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    // The live session and one sync candidate are a connection's whole share.
    expect(await h.host.open(openInput("connection-2"))).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(h.commands).toHaveLength(sent);
    expect(h.host.status()).toMatchObject({ sessions: 5 });
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
      // The deadline runs on fake timers, so starting the document never races it.
      if (cause === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = harness({ timeoutMs: 30_000 });
      const controller = new AbortController();
      const pending = h.host.deriveAuthentication(auth(), controller.signal);
      const command = await h.command();
      if (cause === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(30_000);
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

  it.each(["timeout", "cancel", "disconnect"] as const)(
    "reports a session as no longer open after a %s ends it",
    async (cause) => {
      // The longest deadline, so a slow runner never times out the open itself.
      const h = harness({ timeoutMs: 30_000 });
      const session = await h.open();
      expect(h.host.isOpen(session)).toBe(true);
      expect(h.host.isOpen({ ...session, sessionId: crypto.randomUUID() })).toBe(false);
      if (cause === "disconnect") h.onDisconnect.emit();
      else {
        // Only this job's deadline runs on fake timers, so opening the session never races it.
        if (cause === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const controller = new AbortController();
        const pending = h.host.listFields(session, itemId, controller.signal);
        await h.command(1);
        if (cause === "cancel") controller.abort();
        else await vi.advanceTimersByTimeAsync(30_000);
        expect(await pending).toEqual({
          ok: false,
          error: { code: cause === "cancel" ? "cancelled" : "timeout" },
        });
      }
      expect(h.host.isOpen(session)).toBe(false);
    },
  );

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
