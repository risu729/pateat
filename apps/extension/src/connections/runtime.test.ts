import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot, VaultCatalog } from "@pateat/contracts";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import type { CryptoHost } from "../crypto/host";
import { disabledEntry } from "../vault/__fixtures__/vault";
import { createConnectionRuntime } from "./runtime";
import { SETUP_PORT } from "./wire";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
  },
}));
const captured = vi.hoisted(() => ({
  catalog: undefined as undefined | ((snapshot: unknown) => Promise<unknown>),
  record: undefined as unknown,
}));
vi.mock("../settings", () => ({
  createLocalSettingsRuntime: (provider: { catalog(snapshot: unknown): Promise<unknown> }) => {
    captured.catalog = provider.catalog;
    return {};
  },
}));
// The vault record of a connection, without IndexedDB.
vi.mock("../vault/storage", () => ({
  createIndexedDbVaultStore: () => ({
    read: async () => ({ ok: true, data: captured.record }),
  }),
}));

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
    return (await captured.catalog!(snapshot)) as VaultCatalog;
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
    captured.record = disabledEntry();
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
    captured.record = disabledEntry(false);
    expect((await catalogOf({ registry: registry() })).connections[0]).not.toHaveProperty(
      "lockedUserId",
    );
  });

  it("names the account of a connection's accepted snapshot without unlocking it", async () => {
    captured.record = disabledEntry();
    const runtime = createConnectionRuntime({} as CryptoHost, { registry: registry() });
    expect(await runtime.account(accountProfile.connectionId)).toEqual({
      provider: "bitwarden",
      server: "cloud-us",
      userId: disabledEntry().accepted!.userId,
    });
    expect(await runtime.account("unknown-connection")).toBeUndefined();
  });
});
