import { describe, expect, it, vi } from "vitest";
import type { CryptoHost } from "../crypto/host";
import type { HostSessionRef } from "../crypto/wire";
import type { VaultEntry } from "../vault/record";
import { activeEntry } from "../vault/__fixtures__/vault";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { createConnectionRuntime } from "./runtime";
import { SETUP_PORT } from "./wire";

const stored = vi.hoisted(() => ({ entry: null as VaultEntry | null }));
vi.mock("../vault/storage", () => ({
  createIndexedDbVaultStore: () => ({
    read: async () => ({ ok: true, data: structuredClone(stored.entry) }),
    compareAndSwap: async () => ({ ok: false, error: { code: "storage-failed" } }),
    remove: async () => ({ ok: false, error: { code: "storage-failed" } }),
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
vi.mock("../settings", () => ({ createLocalSettingsRuntime: () => ({}) }));

function settingsPort(postMessage: () => void) {
  const listeners: { message?: (input: unknown) => void } = {};
  return {
    name: SETUP_PORT,
    sender: {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/options.html",
    },
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
