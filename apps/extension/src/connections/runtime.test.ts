import { afterEach, describe, expect, it, vi } from "vitest";
import type { CryptoHost } from "../crypto/host";
import type { HostSessionRef } from "../crypto/wire";
import type { VaultEntry } from "../vault/record";
import type { SettingsSnapshot, VaultCatalog } from "@pateat/contracts";
import { activeEntry, disabledEntry, lockedEntry } from "../vault/__fixtures__/vault";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { legacyItemKey } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { createConnectionRuntime } from "./runtime";
import type { SetupReply } from "./types";
import { SETUP_PORT } from "./wire";

const stored = vi.hoisted(() => ({
  entry: null as VaultEntry | null,
  /** Lets a test's record writes land; absent, every write fails. */
  writable: false,
  /** Records of connections other than the fixture account's. */
  others: new Map<string, VaultEntry | null>(),
  /** Connections whose writes fail, or whose record does not parse. */
  unwritable: new Set<string>(),
  unreadable: new Set<string>(),
}));
vi.mock("../vault/storage", () => {
  const get = (id: string) => (stored.others.has(id) ? stored.others.get(id)! : stored.entry);
  const set = (id: string, value: VaultEntry) => {
    if (stored.others.has(id)) stored.others.set(id, value);
    else stored.entry = value;
  };
  return {
    createIndexedDbVaultStore: ({ profile }: { profile: { connectionId: string } }) => ({
      read: async () =>
        stored.unreadable.has(profile.connectionId)
          ? { ok: false, error: { code: "invalid-cache-record" } }
          : { ok: true, data: structuredClone(get(profile.connectionId)) },
      compareAndSwap: async (expected: string | null, next: VaultEntry) => {
        if (!stored.writable || stored.unwritable.has(profile.connectionId))
          return { ok: false, error: { code: "storage-failed" } };
        if ((get(profile.connectionId)?.revision ?? null) !== expected)
          return { ok: false, error: { code: "storage-conflict" } };
        set(profile.connectionId, structuredClone(next));
        return { ok: true, data: { revision: next.revision } };
      },
      remove: async () => ({ ok: false, error: { code: "storage-failed" } }),
      close: () => undefined,
    }),
  };
});
// This browser session's vault keys (`storage.session` in the extension).
const sessionKeys = vi.hoisted(() => new Map<string, { revision: string; userKey: string }>());
vi.mock("../vault/session-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vault/session-key")>()),
  createSessionKeyStore: (connectionId: string) => ({
    read: async () => structuredClone(sessionKeys.get(connectionId)),
    write: async (value: { revision: string; userKey: string }) => {
      sessionKeys.set(connectionId, structuredClone(value));
    },
    clear: async () => {
      sessionKeys.delete(connectionId);
    },
  }),
}));
// Sync sign-ins, which a log out forgets; none is saved here.
vi.mock("./session-store", () => ({
  createIndexedDbProviderSessionStore: () => ({
    read: async () => ({ ok: true, data: null }),
    compareAndSwap: async () => ({ ok: true, data: { revision: null } }),
    close: () => undefined,
  }),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
  },
}));
const settingsRuntime = vi.hoisted(() => ({
  catalog: undefined as undefined | ((snapshot: unknown) => Promise<VaultCatalog>),
}));
vi.mock("../settings", () => ({
  createLocalSettingsRuntime: (options: {
    catalog: (snapshot: unknown) => Promise<VaultCatalog>;
  }) => {
    settingsRuntime.catalog = options.catalog;
    return {};
  },
}));

function settingsPort(
  postMessage: () => void,
  url = "chrome-extension://synthetic-extension/options.html",
) {
  const listeners: { message?: (input: unknown) => void } = {};
  return {
    name: SETUP_PORT,
    sender: { id: "synthetic-extension", url },
    postMessage: vi.fn(postMessage),
    disconnect: vi.fn(),
    onDisconnect: { addListener: vi.fn() },
    onMessage: {
      addListener: (listener: (input: unknown) => void) => {
        listeners.message = listener;
      },
    },
    send: (input: unknown) => listeners.message?.(input),
  };
}

describe("settings-page setup port", () => {
  it("is open to the settings page reloaded at a section link, and to no other page", () => {
    const runtime = createConnectionRuntime({} as CryptoHost, {
      registry: { list: async () => [], get: async () => undefined } as never,
    });
    const page = "chrome-extension://synthetic-extension";
    const reloaded = settingsPort(() => undefined, `${page}/options.html#sync`);
    expect(runtime.attach(reloaded as never)).toBe(true);
    expect(reloaded.disconnect).not.toHaveBeenCalled();
    for (const url of [`${page}/options.html?view=other`, `${page}/popup.html`]) {
      const other = settingsPort(() => undefined, url);
      expect(runtime.attach(other as never)).toBe(true);
      expect(other.disconnect).toHaveBeenCalledOnce();
    }
  });

  it("disconnects when a reply cannot be sent, so the page fails at once instead of waiting", async () => {
    const runtime = createConnectionRuntime({} as CryptoHost, {
      registry: { list: async () => [], get: async () => undefined } as never,
    });
    const port = settingsPort(() => {
      throw new Error("Message length exceeded maximum allowed length.");
    });
    expect(runtime.attach(port as never)).toBe(true);
    port.send({ requestId: crypto.randomUUID(), type: "connection.status" });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  it("answers the page's heartbeat on the same port, expired when this worker holds no flow", async () => {
    const onVaultStateMayChange = vi.fn();
    const onSignIn = vi.fn();
    const runtime = createConnectionRuntime({} as CryptoHost, {
      registry: { list: async () => [], get: async () => undefined } as never,
      onVaultStateMayChange,
      onSignIn,
    });
    const port = settingsPort(() => undefined);
    expect(runtime.attach(port as never)).toBe(true);
    const requestId = crypto.randomUUID();
    port.send({ requestId, type: "connection.keep-alive", flowId: crypto.randomUUID() });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    const expired = { ok: false, error: { code: "setup-expired" } };
    expect(port.postMessage).toHaveBeenCalledWith({ requestId, result: expired });
    // The local log gets the sign-in that ended while it waited for its code.
    expect(onSignIn).toHaveBeenCalledExactlyOnceWith("keep-alive", expired);
    expect(port.disconnect).not.toHaveBeenCalled();
    // A heartbeat every 20 seconds changes no vault state, so it re-reads none.
    expect(onVaultStateMayChange).not.toHaveBeenCalled();
    // Each sign-in step is logged too; a status read is not.
    const begin = crypto.randomUUID();
    port.send({
      requestId: begin,
      type: "connection.begin",
      input: {
        kind: "existing",
        connectionId: "synthetic-missing",
        password: "synthetic-password",
      },
    });
    port.send({ requestId: crypto.randomUUID(), type: "connection.status" });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(3));
    expect(onSignIn).toHaveBeenCalledTimes(2);
    expect(onSignIn).toHaveBeenLastCalledWith("begin", {
      ok: false,
      error: { code: "invalid-request" },
    });
  });
});

describe("current vault catalog", () => {
  it("restores a vault whose session the crypto host has ended", async () => {
    const entry = activeEntry();
    stored.entry = entry;
    // Sessions the fake host still has; a Worker timeout or a lost offscreen document ends them.
    const sessions = new Set<string>();
    const host = {
      open: vi.fn<CryptoHost["open"]>(async (request) => {
        const session: HostSessionRef = {
          brokerGeneration: "synthetic-generation",
          connectionId: accountProfile.connectionId,
          userId: request.prepared.binding.userId,
          snapshotId: request.snapshotId,
          sessionId: crypto.randomUUID(),
        };
        sessions.add(session.sessionId);
        return {
          ok: true,
          data: {
            session,
            metadata: {
              connectionId: accountProfile.connectionId,
              userId: request.prepared.binding.userId,
              accountVersion: request.prepared.binding.accountVersion,
              securityVersion: 1,
            },
          },
        };
      }),
      verifyReceivedCiphers: vi.fn<CryptoHost["verifyReceivedCiphers"]>(async () => ({
        ok: true,
        data: { verifiedCipherCount: entry.accepted.prepared.ciphers.length },
      })),
      catalog: vi.fn<CryptoHost["catalog"]>(async (session) =>
        sessions.has(session.sessionId)
          ? {
              ok: true,
              data: {
                connectionId: session.connectionId,
                userId: session.userId,
                snapshotId: session.snapshotId,
                groups: [],
                items: [],
              },
            }
          : { ok: false, error: { code: "crypto-locked" } },
      ),
      lock: vi.fn<CryptoHost["lock"]>(async (session) => {
        sessions.delete(session.sessionId);
        return { ok: true, data: null };
      }),
      isOpen: vi.fn((session: HostSessionRef) => sessions.has(session.sessionId)),
    };
    const configuration = {
      profile: accountProfile,
      label: "Synthetic",
      email: "synthetic@example.com",
      deviceIdentifier: crypto.randomUUID(),
    };
    const runtime = createConnectionRuntime(host as unknown as CryptoHost, {
      registry: { list: async () => [configuration], get: async () => configuration } as never,
    });
    const id = accountProfile.connectionId;
    expect((await runtime.current(id)).catalog.snapshotId).toBe(entry.accepted.snapshotId);
    expect(host.open).toHaveBeenCalledOnce();
    sessions.clear();
    expect((await runtime.current(id)).catalog.snapshotId).toBe(entry.accepted.snapshotId);
    expect(host.open).toHaveBeenCalledTimes(2);
  });
});

describe("vault timeout and lock (ADR 0075)", () => {
  const id = accountProfile.connectionId;
  const configuration = {
    profile: accountProfile,
    label: "Synthetic",
    email: "synthetic@example.com",
    deviceIdentifier: crypto.randomUUID(),
  };
  const registry = { list: async () => [configuration], get: async () => configuration } as never;
  afterEach(() => {
    stored.entry = null;
    stored.writable = false;
    stored.others.clear();
    stored.unwritable.clear();
    stored.unreadable.clear();
    sessionKeys.clear();
  });
  function fakeHost() {
    const sessions = new Set<string>();
    const host = {
      open: vi.fn<CryptoHost["open"]>(async (request) => {
        const session: HostSessionRef = {
          brokerGeneration: "synthetic-generation",
          connectionId: id,
          userId: request.prepared.binding.userId,
          snapshotId: request.snapshotId,
          sessionId: crypto.randomUUID(),
        };
        sessions.add(session.sessionId);
        return {
          ok: true,
          data: {
            session,
            metadata: {
              connectionId: id,
              userId: request.prepared.binding.userId,
              accountVersion: request.prepared.binding.accountVersion,
              securityVersion: 1,
            },
          },
        };
      }),
      verifyReceivedCiphers: vi.fn<CryptoHost["verifyReceivedCiphers"]>(async () => ({
        ok: true,
        data: { verifiedCipherCount: activeEntry().accepted.prepared.ciphers.length },
      })),
      exportUnlockMaterial: vi.fn<CryptoHost["exportUnlockMaterial"]>(async (session) => ({
        ok: true,
        data: {
          metadata: {
            connectionId: id,
            userId: session.userId,
            accountVersion: "v1",
            securityVersion: 1,
          },
          userKey: legacyItemKey,
        },
      })),
      catalog: vi.fn<CryptoHost["catalog"]>(async (session) => ({
        ok: true,
        data: {
          connectionId: session.connectionId,
          userId: session.userId,
          snapshotId: session.snapshotId,
          groups: [],
          items: [],
        },
      })),
      resolveField: vi.fn<CryptoHost["resolveField"]>(async () => ({
        ok: true,
        data: { kind: "text", value: "synthetic-unit-password" },
      })),
      lock: vi.fn<CryptoHost["lock"]>(async (session) => {
        sessions.delete(session.sessionId);
        return { ok: true, data: null };
      }),
      isOpen: vi.fn((session: HostSessionRef) => sessions.has(session.sessionId)),
    };
    return host;
  }
  function timeout() {
    return {
      check: vi.fn(async (): Promise<void> => undefined),
      used: vi.fn(async (_opened?: string): Promise<void> => undefined),
      unclosed: vi.fn(async (_connectionId: string) => false),
    };
  }
  function runtimeWith(
    options: {
      vaultTimeout?: ReturnType<typeof timeout>;
      onVaultStateMayChange?: () => void;
      retention?: () => Promise<"durable" | "session">;
      registry?: never;
    } = {},
  ) {
    const host = fakeHost();
    const runtime = createConnectionRuntime(host as unknown as CryptoHost, {
      registry,
      containsPermission: async () => true,
      ...options,
    });
    return { host, runtime };
  }

  it("checks the timeout before opening a vault, and keeps it closed when the check fails", async () => {
    stored.entry = activeEntry();
    const vaultTimeout = timeout();
    const { host, runtime } = runtimeWith({ vaultTimeout });
    await runtime.current(id);
    expect(vaultTimeout.check).toHaveBeenCalledOnce();
    expect(vaultTimeout.check.mock.invocationCallOrder[0]).toBeLessThan(
      host.open.mock.invocationCallOrder[0]!,
    );
    vaultTimeout.check.mockRejectedValueOnce(new Error("lock-failed"));
    await expect(runtime.current(id)).rejects.toThrow("vault-unavailable");
  });
  it("a locked vault without this session's key is locked, not unavailable", async () => {
    stored.entry = lockedEntry();
    const { host, runtime } = runtimeWith();
    await expect(runtime.current(id)).rejects.toThrow("vault-locked");
    expect(host.open).not.toHaveBeenCalled();
    expect(await settingsRuntime.catalog!({})).toEqual({
      connections: [
        {
          id,
          label: "Synthetic",
          provider: "bitwarden",
          server: "cloud-us",
          // A locked vault still names its account, so its synced policy applies (ADR 0023).
          lockedUserId: lockedEntry().accepted!.userId,
          groups: [],
          items: [],
          state: "locked",
        },
      ],
    });
    expect(await runtime.vaultStates()).toEqual(["locked"]);
  });
  it("a locked vault unlocked in this browser session opens with its key", async () => {
    stored.entry = lockedEntry();
    sessionKeys.set(id, { revision: lockedEntry().revision, userKey: legacyItemKey });
    const { host, runtime } = runtimeWith();
    expect((await runtime.current(id)).catalog.snapshotId).toBe(lockedEntry().accepted.snapshotId);
    expect(host.open.mock.calls[0]![0].unlock).toEqual({
      kind: "decrypted-key",
      userKey: legacyItemKey,
    });
    expect(await runtime.vaultStates()).toEqual(["active"]);
  });
  it("a logged-out vault stays unavailable", async () => {
    stored.entry = disabledEntry();
    const { runtime } = runtimeWith();
    await expect(runtime.current(id)).rejects.toThrow("vault-unavailable");
    expect(await runtime.vaultStates()).toEqual(["disabled"]);
  });
  it("refuses a vault the timeout could not close", async () => {
    stored.entry = activeEntry();
    const vaultTimeout = timeout();
    vaultTimeout.unclosed.mockResolvedValueOnce(true);
    const { host, runtime } = runtimeWith({ vaultTimeout });
    await expect(runtime.current(id)).rejects.toThrow("vault-unavailable");
    expect(vaultTimeout.unclosed).toHaveBeenCalledWith(id);
    expect(host.open).not.toHaveBeenCalled();
    // An answer that cannot be read refuses too.
    vaultTimeout.unclosed.mockRejectedValueOnce(new Error("storage-failed"));
    await expect(runtime.current(id)).rejects.toThrow("vault-unavailable");
    expect(host.open).not.toHaveBeenCalled();
    expect((await runtime.current(id)).catalog.snapshotId).toBe(activeEntry().accepted.snapshotId);
  });

  describe("timeOut", () => {
    const other = { ...accountProfile, connectionId: "synthetic-account-b" };
    const two = [
      configuration,
      { ...configuration, profile: other, deviceIdentifier: crypto.randomUUID() },
    ];
    const twoRegistry = {
      list: async () => structuredClone(two),
      get: async (connectionId: string) =>
        structuredClone(two.find((entry) => entry.profile.connectionId === connectionId)),
    } as never;
    function withOther(entry: VaultEntry | null) {
      stored.others.set(other.connectionId, entry && { ...entry, profile: other });
    }

    it("locks each open vault, keeps its sign-in and counts it", async () => {
      stored.entry = activeEntry();
      stored.writable = true;
      const onVaultStateMayChange = vi.fn();
      const { host, runtime } = runtimeWith({ onVaultStateMayChange });
      await runtime.current(id);
      expect(await runtime.timeOut("lock")).toEqual({ closed: 1, failed: [] });
      expect(stored.entry).toMatchObject({ state: "locked", accepted: activeEntry().accepted });
      expect(Object.hasOwn(stored.entry!, "userKey")).toBe(false);
      expect(host.lock).toHaveBeenCalledOnce();
      expect(onVaultStateMayChange).toHaveBeenCalled();
      expect(await runtime.vaultStates()).toEqual(["locked"]);
    });
    it("acts only on the vaults it is given", async () => {
      stored.entry = activeEntry();
      stored.writable = true;
      const { runtime } = runtimeWith();
      expect(await runtime.timeOut("lock", ["synthetic-other"])).toEqual({
        closed: 0,
        failed: [],
      });
      expect(stored.entry).toEqual(activeEntry());
      expect(await runtime.timeOut("lock", [id])).toEqual({ closed: 1, failed: [] });
      expect(stored.entry?.state).toBe("locked");
    });
    it("counts a locked vault without its key as closed already for Lock, not for Log out", async () => {
      stored.entry = lockedEntry();
      stored.writable = true;
      const { runtime } = runtimeWith();
      expect(await runtime.timeOut("lock")).toEqual({ closed: 0, failed: [] });
      expect(stored.entry).toEqual(lockedEntry());
      // A log out still forgets its sign-in.
      expect(await runtime.timeOut("log-out")).toEqual({ closed: 1, failed: [] });
      expect(stored.entry).toMatchObject({ state: "disabled", accepted: lockedEntry().accepted });
    });
    it("counts a locked vault unlocked in this browser session as open", async () => {
      stored.entry = lockedEntry();
      stored.writable = true;
      sessionKeys.set(id, { revision: lockedEntry().revision, userKey: legacyItemKey });
      const { runtime } = runtimeWith();
      expect(await runtime.timeOut("lock")).toEqual({ closed: 1, failed: [] });
      expect(sessionKeys.has(id)).toBe(false);
    });
    it("skips vaults already logged out or never set up", async () => {
      for (const entry of [disabledEntry(), null]) {
        stored.entry = entry;
        stored.writable = true;
        const { runtime } = runtimeWith();
        // oxlint-disable-next-line no-await-in-loop -- one case at a time
        expect(await runtime.timeOut("log-out")).toEqual({ closed: 0, failed: [] });
        expect(stored.entry).toEqual(entry);
      }
    });
    it("a vault that does not close is named, and the others still close", async () => {
      stored.entry = activeEntry();
      withOther(activeEntry());
      stored.writable = true;
      stored.unwritable.add(id);
      const onVaultStateMayChange = vi.fn();
      const { runtime } = runtimeWith({ registry: twoRegistry, onVaultStateMayChange });
      expect(await runtime.timeOut("lock")).toEqual({ closed: 1, failed: [id] });
      expect(stored.entry).toEqual(activeEntry());
      expect(stored.others.get(other.connectionId)?.state).toBe("locked");
      expect(onVaultStateMayChange).toHaveBeenCalled();
      // Retried alone, it closes once its storage works again.
      stored.unwritable.clear();
      expect(await runtime.timeOut("lock", [id])).toEqual({ closed: 1, failed: [] });
      expect(stored.entry?.state).toBe("locked");
    });
    it("counts a vault whose record does not parse as nothing open, and not as failed", async () => {
      stored.unreadable.add(id);
      withOther(activeEntry());
      stored.writable = true;
      const { runtime } = runtimeWith({ registry: twoRegistry });
      expect(await runtime.timeOut("lock")).toEqual({ closed: 1, failed: [] });
      expect(stored.others.get(other.connectionId)?.state).toBe("locked");
    });
    it("a retry leaves out the vaults opened again since", async () => {
      stored.entry = activeEntry();
      withOther(activeEntry());
      stored.writable = true;
      const { runtime } = runtimeWith({ registry: twoRegistry });
      expect(await runtime.timeOut("lock", undefined, { except: [id] })).toEqual({
        closed: 1,
        failed: [],
      });
      expect(stored.entry).toEqual(activeEntry());
      expect(stored.others.get(other.connectionId)?.state).toBe("locked");
    });
  });

  it("keepKeys answers whether every key moved", async () => {
    stored.entry = activeEntry();
    stored.writable = true;
    const onVaultStateMayChange = vi.fn();
    const { runtime } = runtimeWith({ onVaultStateMayChange });
    expect(await runtime.keepKeys("session")).toBe(true);
    expect(stored.entry?.state).toBe("locked");
    expect(sessionKeys.get(id)).toEqual({
      revision: stored.entry!.revision,
      userKey: legacyItemKey,
    });
    expect(onVaultStateMayChange).toHaveBeenCalled();
    expect(await runtime.keepKeys("durable")).toBe(true);
    expect(stored.entry).toMatchObject({ state: "active", userKey: legacyItemKey });
    expect(sessionKeys.has(id)).toBe(false);
    stored.writable = false;
    expect(await runtime.keepKeys("session")).toBe(false);
    expect(stored.entry?.state).toBe("active");
  });

  it("a field read counts as use of the vault; a refused one does not", async () => {
    stored.entry = activeEntry();
    const vaultTimeout = timeout();
    const { host, runtime } = runtimeWith({ vaultTimeout });
    await runtime.current(id);
    const { manager } = runtime.vaultFor(accountProfile);
    const handle = manager.status().handle!;
    const ref = {
      connectionId: id,
      userId: handle.userId,
      snapshotId: handle.snapshotId,
      itemId: crypto.randomUUID(),
      fieldId: "login.password",
    };
    const grant = { snapshotId: handle.snapshotId, allowedFieldIds: ["login.password"] };
    expect((await manager.resolveField(handle, ref, grant)).ok).toBe(true);
    expect(vaultTimeout.used).toHaveBeenCalledOnce();
    host.resolveField.mockResolvedValueOnce({ ok: false, error: { code: "field-denied" } });
    expect((await manager.resolveField(handle, ref, grant)).ok).toBe(false);
    expect(vaultTimeout.used).toHaveBeenCalledOnce();
  });

  describe("settings-page requests", () => {
    /**
     * A settings page whose requests settle on their own reply. A request the test never
     * lets finish stays pending instead of failing after the test has ended.
     */
    function port() {
      const waiting = new Map<string, (result: unknown) => void>();
      const sent = settingsPort(() => undefined);
      sent.postMessage.mockImplementation(((reply: { requestId: string; result: unknown }) => {
        waiting.get(reply.requestId)?.(reply.result);
        waiting.delete(reply.requestId);
      }) as () => void);
      return {
        ...sent,
        request(message: Record<string, unknown>) {
          const requestId = crypto.randomUUID();
          const result = new Promise<unknown>((resolve) => waiting.set(requestId, resolve));
          sent.send({ requestId, ...message });
          return result;
        },
      };
    }
    /** Holds the host's open, so an unlock waits in the worker. */
    function heldOpen(host: ReturnType<typeof fakeHost>) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = host.open.getMockImplementation()!;
      host.open.mockImplementationOnce(async (request, signal) => {
        await held;
        return open(request, signal);
      });
      return release;
    }
    it("a retry leaves a vault being unlocked owed", async () => {
      stored.entry = lockedEntry();
      stored.writable = true;
      const vaultTimeout = timeout();
      const { host, runtime } = runtimeWith({ vaultTimeout });
      const release = heldOpen(host);
      const page = port();
      runtime.attach(page as never);
      const unlocking = page.request({
        type: "connection.unlock",
        input: { connectionId: id, password: "synthetic-password" },
      });
      await vi.waitFor(() => expect(host.open).toHaveBeenCalledOnce());
      expect(await runtime.timeOut("log-out", undefined, {})).toEqual({ closed: 0, failed: [id] });
      expect(await runtime.timeOut("log-out", [id], {})).toEqual({ closed: 0, failed: [id] });
      expect(stored.entry).toEqual(lockedEntry());
      release();
      expect(await unlocking).toMatchObject({ ok: true, kind: "unlocked" });
      await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledWith(id));
      // Once the unlock is recorded, a retry acts on the vault again.
      await vi.waitFor(async () =>
        expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 1, failed: [] }),
      );
    });
    it("the timeout's own action still closes a vault being unlocked", async () => {
      stored.entry = lockedEntry();
      stored.writable = true;
      const vaultTimeout = timeout();
      const { host, runtime } = runtimeWith({ vaultTimeout, retention: async () => "session" });
      const release = heldOpen(host);
      const page = port();
      runtime.attach(page as never);
      const unlocking = page.request({
        type: "connection.unlock",
        input: { connectionId: id, password: "synthetic-password" },
      });
      await vi.waitFor(() => expect(host.open).toHaveBeenCalledOnce());
      expect(await runtime.timeOut("lock")).toEqual({ closed: 0, failed: [] });
      release();
      expect(await unlocking).toMatchObject({ ok: false });
      expect(sessionKeys.has(id)).toBe(false);
      expect(stored.entry).toEqual(lockedEntry());
    });
    it("a vault stays out of the retries until its unlock is recorded as use", async () => {
      stored.entry = lockedEntry();
      stored.writable = true;
      const vaultTimeout = timeout();
      let record!: () => void;
      vaultTimeout.used.mockImplementation(async (opened?: string) => {
        if (opened)
          await new Promise<void>((resolve) => {
            record = resolve;
          });
      });
      const { runtime } = runtimeWith({ vaultTimeout });
      const page = port();
      runtime.attach(page as never);
      expect(
        await page.request({
          type: "connection.unlock",
          input: { connectionId: id, password: "synthetic-password" },
        }),
      ).toMatchObject({ ok: true, kind: "unlocked" });
      await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledWith(id));
      expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 0, failed: [id] });
      record();
      await vi.waitFor(async () =>
        expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 1, failed: [] }),
      );
    });
    it("a retry leaves a vault with a sign-in again in flight owed", async () => {
      stored.entry = activeEntry();
      stored.writable = true;
      const vaultTimeout = timeout();
      let started!: () => void;
      vaultTimeout.used.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            started = resolve;
          }),
      );
      const { runtime } = runtimeWith({ vaultTimeout });
      const page = port();
      runtime.attach(page as never);
      const signingIn = page.request({
        type: "connection.begin",
        input: { kind: "existing", connectionId: id, password: "synthetic-password" },
      });
      await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledOnce());
      expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 0, failed: [id] });
      expect(stored.entry).toEqual(activeEntry());
      started();
      await signingIn;
      await vi.waitFor(async () =>
        expect(await runtime.timeOut("lock", undefined, {})).toEqual({ closed: 1, failed: [] }),
      );
    });
    describe("two-step sign-in", () => {
      const flowId = "70000000-0000-4000-8000-000000000001";
      const challenge = {
        ok: true as const,
        kind: "mfa-required" as const,
        flowId,
        providers: [0 as const],
        expiresAt: Date.now() + 300_000,
      };
      const signedIn = {
        ok: true as const,
        kind: "ready" as const,
        connectionId: id,
        snapshotId: crypto.randomUUID(),
        policyReviewItemIds: [],
      };
      /** A settings page whose sign-in steps answer as the test says. */
      function twoStep(runtime: ReturnType<typeof runtimeWith>["runtime"]) {
        const steps = {
          begin: vi.fn(async (): Promise<SetupReply> => challenge),
          continue: vi.fn(async (): Promise<SetupReply> => signedIn),
        };
        const create = runtime.service.createCaller.bind(runtime.service);
        vi.spyOn(runtime.service, "createCaller").mockImplementation(() => ({
          ...create(),
          begin: steps.begin,
          continue: steps.continue,
        }));
        const page = port();
        runtime.attach(page as never);
        return { page, steps };
      }
      const code = (step = flowId) => ({
        type: "connection.continue",
        input: { flowId: step, twoFactor: { provider: 0, code: "000123" } },
      });
      const retry = (runtime: ReturnType<typeof runtimeWith>["runtime"]) =>
        runtime.timeOut("lock", undefined, {});

      it("the code step of a sign-in again keeps its vault out of the retries until recorded", async () => {
        stored.entry = activeEntry();
        stored.writable = true;
        const vaultTimeout = timeout();
        let record!: () => void;
        vaultTimeout.used.mockImplementation(async (opened?: string) => {
          if (opened)
            await new Promise<void>((resolve) => {
              record = resolve;
            });
        });
        const { runtime } = runtimeWith({ vaultTimeout });
        const { page, steps } = twoStep(runtime);
        expect(
          await page.request({
            type: "connection.begin",
            input: { kind: "existing", connectionId: id, password: "synthetic-password" },
          }),
        ).toEqual(challenge);
        let answer!: (reply: SetupReply) => void;
        steps.continue.mockImplementationOnce(
          () =>
            new Promise<SetupReply>((resolve) => {
              answer = resolve;
            }),
        );
        const finishing = page.request(code());
        await vi.waitFor(() => expect(steps.continue).toHaveBeenCalledOnce());
        expect(await retry(runtime)).toEqual({ closed: 0, failed: [id] });
        expect(stored.entry).toEqual(activeEntry());
        answer(signedIn);
        expect(await finishing).toEqual(signedIn);
        await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledWith(id));
        // Until the sign-in is recorded as use, a retry still leaves the vault alone.
        expect(await retry(runtime)).toEqual({ closed: 0, failed: [id] });
        record();
        await vi.waitFor(async () =>
          expect(await retry(runtime)).toEqual({ closed: 1, failed: [] }),
        );
        expect(stored.entry?.state).toBe("locked");
      });
      it("a refused code keeps the sign-in's vault for the next code", async () => {
        stored.entry = activeEntry();
        stored.writable = true;
        const vaultTimeout = timeout();
        const { runtime } = runtimeWith({ vaultTimeout });
        const { page, steps } = twoStep(runtime);
        await page.request({
          type: "connection.begin",
          input: { kind: "existing", connectionId: id, password: "synthetic-password" },
        });
        steps.continue.mockResolvedValueOnce({ ...challenge, invalidCode: true });
        expect(await page.request(code())).toMatchObject({ invalidCode: true });
        let answer!: (reply: SetupReply) => void;
        steps.continue.mockImplementationOnce(
          () =>
            new Promise<SetupReply>((resolve) => {
              answer = resolve;
            }),
        );
        const finishing = page.request(code());
        await vi.waitFor(() => expect(steps.continue).toHaveBeenCalledTimes(2));
        expect(await retry(runtime)).toEqual({ closed: 0, failed: [id] });
        answer({ ok: false, error: { code: "setup-expired" } });
        await finishing;
        // The flow ended: its next code no longer counts as opening the vault.
        await vi.waitFor(async () =>
          expect(await retry(runtime)).toEqual({ closed: 1, failed: [] }),
        );
        stored.entry = activeEntry();
        steps.continue.mockImplementationOnce(() => new Promise<SetupReply>(() => undefined));
        void page.request(code());
        await vi.waitFor(() => expect(steps.continue).toHaveBeenCalledTimes(3));
        expect(await retry(runtime)).toEqual({ closed: 1, failed: [] });
      });
      it("a code for a flow the worker never saw opens no vault", async () => {
        stored.entry = activeEntry();
        stored.writable = true;
        const { runtime } = runtimeWith({ vaultTimeout: timeout() });
        const { page, steps } = twoStep(runtime);
        steps.continue.mockImplementationOnce(() => new Promise<SetupReply>(() => undefined));
        void page.request(code(crypto.randomUUID()));
        await vi.waitFor(() => expect(steps.continue).toHaveBeenCalledOnce());
        expect(await retry(runtime)).toEqual({ closed: 1, failed: [] });
      });
      it("a new connection's first sign-in opens no vault the timeout owes", async () => {
        stored.entry = activeEntry();
        stored.writable = true;
        const { runtime } = runtimeWith({ vaultTimeout: timeout() });
        const { page, steps } = twoStep(runtime);
        await page.request({
          type: "connection.begin",
          input: {
            kind: "new",
            environment: { kind: "cloud", region: "us" },
            label: "Synthetic",
            email: "synthetic@example.com",
            password: "synthetic-password",
            enabled: true,
          },
        });
        steps.continue.mockImplementationOnce(() => new Promise<SetupReply>(() => undefined));
        void page.request(code());
        await vi.waitFor(() => expect(steps.continue).toHaveBeenCalledOnce());
        expect(await retry(runtime)).toEqual({ closed: 1, failed: [] });
      });
    });
    it("sync of a vault the timeout could not close is refused", async () => {
      stored.entry = activeEntry();
      const vaultTimeout = timeout();
      vaultTimeout.unclosed.mockResolvedValueOnce(true);
      const { runtime } = runtimeWith({ vaultTimeout });
      const page = port();
      runtime.attach(page as never);
      expect(await page.request({ type: "connection.sync", connectionId: id })).toEqual({
        ok: false,
        error: { code: "setup-unavailable" },
      });
      expect(vaultTimeout.unclosed).toHaveBeenCalledWith(id);
      // Once closed or opened again, the same sync reaches the setup service.
      expect(await page.request({ type: "connection.sync", connectionId: id })).not.toEqual({
        ok: false,
        error: { code: "setup-unavailable" },
      });
    });
    it("unlock checks the timeout, starts the time and unlocks offline", async () => {
      stored.entry = lockedEntry();
      const vaultTimeout = timeout();
      const { host, runtime } = runtimeWith({ vaultTimeout, retention: async () => "session" });
      const page = port();
      runtime.attach(page as never);
      expect(
        await page.request({
          type: "connection.unlock",
          input: { connectionId: id, password: "synthetic-password" },
        }),
      ).toEqual({ ok: true, kind: "unlocked", connectionId: id });
      expect(host.open.mock.calls[0]![0].unlock).toEqual({
        kind: "password",
        password: "synthetic-password",
      });
      expect(vaultTimeout.check.mock.invocationCallOrder[0]).toBeLessThan(
        host.open.mock.invocationCallOrder[0]!,
      );
      // Once before the unlock, so a check while it runs cannot lock it, and once after it.
      await vi.waitFor(() => expect(vaultTimeout.used).toHaveBeenCalledTimes(2));
      expect(sessionKeys.get(id)).toEqual({
        revision: lockedEntry().revision,
        userKey: legacyItemKey,
      });
    });
    it("a failed unlock does not count as use afterwards", async () => {
      stored.entry = lockedEntry();
      const vaultTimeout = timeout();
      const { host, runtime } = runtimeWith({ vaultTimeout });
      host.open.mockResolvedValueOnce({ ok: false, error: { code: "crypto-failed" } });
      const page = port();
      runtime.attach(page as never);
      expect(
        await page.request({
          type: "connection.unlock",
          input: { connectionId: id, password: "synthetic-wrong-password" },
        }),
      ).toEqual({ ok: false, error: { code: "crypto-failed" } });
      expect(vaultTimeout.used).toHaveBeenCalledOnce();
    });
    it("an unlock still runs when the check fails", async () => {
      stored.entry = lockedEntry();
      const vaultTimeout = timeout();
      vaultTimeout.check.mockRejectedValue(new Error("lock-failed"));
      const { runtime } = runtimeWith({ vaultTimeout, retention: async () => "session" });
      const page = port();
      runtime.attach(page as never);
      expect(
        await page.request({
          type: "connection.unlock",
          input: { connectionId: id, password: "synthetic-password" },
        }),
      ).toMatchObject({ ok: true, kind: "unlocked" });
    });
    it("lock locks without a timeout check", async () => {
      stored.entry = activeEntry();
      stored.writable = true;
      const vaultTimeout = timeout();
      const { runtime } = runtimeWith({ vaultTimeout });
      const page = port();
      runtime.attach(page as never);
      expect(await page.request({ type: "connection.lock", connectionId: id })).toEqual({
        ok: true,
        kind: "locked",
        connectionId: id,
      });
      expect(stored.entry?.state).toBe("locked");
      expect(vaultTimeout.check).not.toHaveBeenCalled();
      expect(vaultTimeout.used).not.toHaveBeenCalled();
    });
    it("sync waits for the check and is refused when it fails", async () => {
      stored.entry = activeEntry();
      const vaultTimeout = timeout();
      vaultTimeout.check.mockRejectedValue(new Error("lock-failed"));
      const { runtime } = runtimeWith({ vaultTimeout });
      const page = port();
      runtime.attach(page as never);
      expect(await page.request({ type: "connection.sync", connectionId: id })).toEqual({
        ok: false,
        error: { code: "setup-unavailable" },
      });
      expect(vaultTimeout.check).toHaveBeenCalledOnce();
    });
    it("sync on a locked vault asks for the unlock", async () => {
      stored.entry = lockedEntry();
      const vaultTimeout = timeout();
      const { runtime } = runtimeWith({ vaultTimeout });
      const page = port();
      runtime.attach(page as never);
      expect(await page.request({ type: "connection.sync", connectionId: id })).toEqual({
        ok: false,
        error: { code: "vault-locked" },
      });
    });
  });
});

describe("vault catalog", () => {
  const snapshot = {
    version: 1,
    revision: 1,
    settings: {
      connections: [],
      accountPolicies: [],
      itemPolicies: [],
      customFieldReviews: [],
      excludedSites: [],
      repromptSites: [],
      passkeyBrowserSites: [],
      siteDefaults: [],
      bindings: [],
    },
  } satisfies SettingsSnapshot;
  const configuration = {
    profile: accountProfile,
    label: "Synthetic vault",
    email: "synthetic@example.test",
    deviceIdentifier: "12345678-1234-4234-8234-123456789abc",
  };
  const registry = (configured = [configuration]) =>
    ({
      list: async () => configured,
      get: async (id: string) => configured.find((entry) => entry.profile.connectionId === id),
    }) as never;
  async function catalogOf(options: Parameters<typeof createConnectionRuntime>[1]) {
    createConnectionRuntime({} as CryptoHost, options);
    return (await settingsRuntime.catalog!(snapshot)) as VaultCatalog;
  }

  it.each<[string, () => Promise<boolean>, Partial<VaultCatalog>]>([
    ["waits for its first settings sync", async () => true, { settingsSyncPending: true }],
    [
      "cannot tell whether it waits",
      async () => Promise.reject(new Error("unreadable")),
      { settingsSyncPending: true },
    ],
    ["has synced settings", async () => false, {}],
  ])("says so while the device %s", async (_label, settingsSyncPending, expected) => {
    expect(await catalogOf({ registry: registry([]), settingsSyncPending })).toEqual({
      ...expected,
      connections: [],
    });
  });

  it("names a locked connection's server and last known account, without items", async () => {
    stored.entry = disabledEntry();
    const catalog = await catalogOf({ registry: registry() });
    expect(catalog).toEqual({
      connections: [
        {
          id: accountProfile.connectionId,
          label: "Synthetic vault",
          provider: "bitwarden",
          server: "cloud-us",
          lockedUserId: disabledEntry().accepted!.userId,
          groups: [],
          items: [],
          state: "unavailable",
        },
      ],
    });
    // A connection that never accepted a snapshot cannot name its account.
    stored.entry = disabledEntry(false);
    expect((await catalogOf({ registry: registry() })).connections[0]).not.toHaveProperty(
      "lockedUserId",
    );
  });

  it("names the account of a connection's accepted snapshot without unlocking it", async () => {
    stored.entry = disabledEntry();
    const runtime = createConnectionRuntime({} as CryptoHost, { registry: registry() });
    expect(await runtime.account(accountProfile.connectionId)).toEqual({
      provider: "bitwarden",
      server: "cloud-us",
      userId: disabledEntry().accepted!.userId,
    });
    expect(await runtime.account("unknown-connection")).toBeUndefined();
  });
});
