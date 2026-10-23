import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "@pateat/contracts";
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
const settingsStore = vi.hoisted(() => {
  let snapshot: SettingsSnapshot = {
    version: 1,
    revision: 0,
    settings: { connections: [], excludedSites: [], siteDefaults: [], bindings: [] },
  };
  return {
    set: (value: SettingsSnapshot) => {
      snapshot = structuredClone(value);
    },
    get: () => structuredClone(snapshot),
    read: async () => structuredClone(snapshot),
    update: async (_revision: number | undefined, mutate: (value: SettingsSnapshot) => unknown) => {
      snapshot = mutate(structuredClone(snapshot)) as SettingsSnapshot;
      return structuredClone(snapshot);
    },
  };
});
vi.mock("../settings", () => ({
  createLocalSettingsRuntime: () => ({
    read: settingsStore.read,
    update: settingsStore.update,
  }),
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
    const runtime = createConnectionRuntime({} as CryptoHost, {
      registry: { list: async () => [], get: async () => undefined } as never,
      onVaultStateMayChange,
    });
    const port = settingsPort(() => undefined);
    expect(runtime.attach(port as never)).toBe(true);
    const requestId = crypto.randomUUID();
    port.send({ requestId, type: "connection.keep-alive", flowId: crypto.randomUUID() });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    expect(port.postMessage).toHaveBeenCalledWith({
      requestId,
      result: { ok: false, error: { code: "setup-expired" } },
    });
    expect(port.disconnect).not.toHaveBeenCalled();
    // A heartbeat every 20 seconds changes no vault state, so it re-reads none.
    expect(onVaultStateMayChange).not.toHaveBeenCalled();
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

describe("settings left by deleted connections", () => {
  it("are dropped when the runtime starts, keeping registered and base connections", async () => {
    const entry = (connectionId: string) => ({
      connectionId,
      enabled: true,
      selection: { mode: "all" as const, groupIds: [], itemIds: [] },
      excludedItemIds: [],
      excludedFields: [],
    });
    const synced = {
      origin: "https://example.com",
      provider: "bitwarden",
      userId: "user",
      itemId: "item",
    };
    settingsStore.set({
      version: 1,
      revision: 3,
      settings: {
        connections: [entry("demo"), entry(accountProfile.connectionId), entry("deleted")],
        excludedSites: [],
        siteDefaults: [synced],
        bindings: [],
      },
      fieldPolicies: [
        {
          connectionId: "deleted",
          snapshotId: "20000000-0000-4000-8000-000000000002",
          quarantinedItemIds: [],
        },
      ],
    });
    createConnectionRuntime({} as CryptoHost, {
      registry: {
        list: async () => [{ profile: { connectionId: accountProfile.connectionId } }],
        get: async () => undefined,
      } as never,
      baseCatalog: { connections: [{ id: "demo" } as never] },
    });
    await vi.waitFor(() =>
      expect(settingsStore.get().settings.connections.map((value) => value.connectionId)).toEqual([
        "demo",
        accountProfile.connectionId,
      ]),
    );
    expect(settingsStore.get()).not.toHaveProperty("fieldPolicies");
    expect(settingsStore.get().settings.siteDefaults).toEqual([synced]);
  });
});
