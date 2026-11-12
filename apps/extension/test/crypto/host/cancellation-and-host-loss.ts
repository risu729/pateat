import { expect, it, vi } from "vitest";
import type { HostUnlock } from "../../../src/crypto/wire";
import { accountUserId } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Password } from "../../../../../packages/bitwarden/src/__fixtures__/crypto";
import type { CryptoHostTestContext } from "./context";

export function registerCancellationAndHostLossCases({
  harness,
  auth,
  argon2idAuth,
  prepared,
  openInput,
  within,
  snapshotId,
  itemId,
  connectionId,
}: Pick<
  CryptoHostTestContext,
  | "harness"
  | "auth"
  | "argon2idAuth"
  | "prepared"
  | "openInput"
  | "within"
  | "snapshotId"
  | "itemId"
  | "connectionId"
>) {
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

  it("opens vaults for six connections, past Bitwarden's 5 accounts, each with a sync candidate", async () => {
    const h = harness();
    const connections = [1, 2, 3, 4, 5, 6].map((index) => `connection-${index}`);
    // Each open answers its own delivered command, so they run one after another.
    // eslint-disable-next-line no-await-in-loop
    for (const owned of connections) await h.open(owned);
    // A sync opens each candidate while the connection's live session is still open.
    // eslint-disable-next-line no-await-in-loop
    for (const owned of connections) await h.open(owned);
    expect(h.host.status()).toMatchObject({ sessions: 12 });
  });

  it("refuses a third session of one connection", async () => {
    const h = harness();
    await h.open("connection-2");
    await h.open("connection-2");
    const sent = h.commands.length;
    // The live session and one sync candidate are a connection's whole share.
    expect(await h.host.open(openInput("connection-2"))).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(h.commands).toHaveLength(sent);
    expect(h.host.status()).toMatchObject({ sessions: 2 });
  });

  it("gives an Argon2id derivation its own longer budget", async () => {
    const h = harness({ timeoutMs: 100, argon2idTimeoutMs: 400 });
    const deriving = h.host.deriveAuthentication(argon2idAuth());
    const deriveCommand = await h.command(0);
    // Past the normal budget, within the Argon2id one.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const derived = { connectionId: "connection-2", masterPasswordHash: "synthetic-hash" };
    h.reply(deriveCommand, { ok: true, data: derived });
    expect(await deriving).toEqual({ ok: true, data: derived });
  });

  it("gives an Argon2id unlock with the master password the longer budget, and one with a retained key the normal one", async () => {
    const h = harness({ timeoutMs: 100, argon2idTimeoutMs: 400 });
    const argon2id = (unlock: HostUnlock) => {
      const input = openInput();
      return {
        ...input,
        prepared: {
          ...input.prepared,
          kdf: { argon2id: { iterations: 10, memory: 1024, parallelism: 4 } },
        },
        unlock,
      };
    };
    const withPassword = h.host.open(argon2id({ kind: "password", password: v1Password }));
    const passwordCommand = await h.command(0);
    // Past the normal budget, within the Argon2id one.
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.answerOpen(passwordCommand);
    expect(await withPassword).toMatchObject({ ok: true });
    // A retained key runs no KDF, whatever the account's KDF is.
    const withKey = h.host.open(argon2id({ kind: "decrypted-key", userKey: "synthetic-user-key" }));
    await h.command(1);
    expect(await withKey).toEqual({ ok: false, error: { code: "timeout" } });
  });

  it("gives a master password check the longer budget, since the account's KDF may be Argon2id", async () => {
    const h = harness({ timeoutMs: 100, argon2idTimeoutMs: 400 });
    const session = await h.open();
    const checked = h.host.verifyMasterPassword(session, "synthetic-guess");
    const checking = await h.command(1);
    // Past the normal budget, within the Argon2id one.
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.reply(checking, { ok: true, data: { matches: true } });
    expect(await checked).toEqual({ ok: true, data: { matches: true } });
  });

  it("times out an Argon2id derivation once its own budget runs out", async () => {
    const h = harness({ timeoutMs: 100, argon2idTimeoutMs: 200 });
    const deriving = h.host.deriveAuthentication(argon2idAuth());
    await h.command(0);
    expect(await deriving).toEqual({ ok: false, error: { code: "timeout" } });
  });

  it("lets an open wait behind an Argon2id derivation for that derivation's budget", async () => {
    const h = harness({ timeoutMs: 100, argon2idTimeoutMs: 400 });
    const deriving = h.host.deriveAuthentication(argon2idAuth());
    const deriveCommand = await h.command(0);
    const opening = h.host.open(openInput());
    // Past its own budget, it still waits instead of failing `resource-limit`.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await within(opening, 1)).toBe("waiting");
    h.reply(deriveCommand, {
      ok: true,
      data: { connectionId: "connection-2", masterPasswordHash: "synthetic-hash" },
    });
    expect(await deriving).toMatchObject({ ok: true });
    h.answerOpen(await h.command(1));
    expect(await opening).toMatchObject({ ok: true });
  });

  it("bounds native initialization work before the handshake by running one KDF job at a time", async () => {
    const h = harness({ automaticReady: false, timeoutMs: 300 });
    const first = h.host.deriveAuthentication(auth());
    const second = h.host.deriveAuthentication({ ...auth(), connectionId: "second-connection" });
    expect(await within(second, 20)).toBe("waiting");
    await vi.waitFor(() =>
      expect(h.posted).toContainEqual(expect.objectContaining({ type: "crypto.reset" })),
    );
    h.onMessage.emit({ version: 1, type: "crypto.ready", generation: h.host.generation });
    const firstCommand = await h.command(0);
    expect(firstCommand.connectionId).toBe(connectionId);
    // The second waits for the first instead of starting a concurrent KDF.
    expect(await within(second, 20)).toBe("waiting");
    expect(h.commands).toHaveLength(1);
    const firstHash = { connectionId, masterPasswordHash: "synthetic-hash-1" };
    h.reply(firstCommand, { ok: true, data: firstHash });
    expect(await first).toEqual({ ok: true, data: firstHash });
    const secondCommand = await h.command(1);
    expect(secondCommand.connectionId).toBe("second-connection");
    const secondHash = {
      connectionId: "second-connection",
      masterPasswordHash: "synthetic-hash-2",
    };
    h.reply(secondCommand, { ok: true, data: secondHash });
    expect(await second).toEqual({ ok: true, data: secondHash });
    expect(h.commands).toHaveLength(2);
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
}
