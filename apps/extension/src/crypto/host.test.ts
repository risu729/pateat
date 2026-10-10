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
const offscreenUrl = `chrome-extension://${extensionId}/crypto-offscreen.html`;
const documentId = "10000000-0000-4000-8000-000000000001";
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
  } = {},
) {
  const onConnect = new Event<[CryptoHostPort]>();
  const onMessage = new Event<[unknown]>();
  const onDisconnect = new Event<[]>();
  const commands: HostCommand[] = [];
  const posted: unknown[] = [];
  let contexts = options.existing
    ? [{ documentId: "old-document", documentUrl: offscreenUrl }]
    : [];
  const port: CryptoHostPort = {
    name: CRYPTO_PORT,
    sender: { id: extensionId, url: offscreenUrl, documentId },
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
    contexts = [{ documentId, documentUrl: offscreenUrl }];
    onConnect.emit(port);
  });
  const host = createCryptoHost({
    extensionId,
    offscreenUrl,
    onConnect,
    getContexts: vi.fn(async () => structuredClone(contexts)),
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
    { id: extensionId, url: offscreenUrl },
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
