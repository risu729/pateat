import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CryptoHost } from "../crypto/host";
import { createConnectionRuntime } from "./runtime";
import { SETUP_PORT } from "./wire";

// Synthetic connections, vault records and replies only; no vault or provider is reached.

type Call = Mock<(...args: unknown[]) => Promise<unknown>>;
type VaultTimeout = { check(): Promise<void>; used(): Promise<void> };

const fakes = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  calls: {} as {
    disable: Call;
    begin: Call;
    continue: Call;
    sync: Call;
    resolveField: Call;
    signPasskey: Call;
    dispose: Mock<() => void>;
  },
  vaultFor: undefined as unknown as (profile: { connectionId: string }) => {
    manager: {
      resolveField(...args: unknown[]): Promise<{ ok: boolean }>;
      signPasskey(...args: unknown[]): Promise<{ ok: boolean }>;
    };
  },
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
vi.mock("../vault/storage", () => ({
  createIndexedDbVaultStore: ({ profile }: { profile: { connectionId: string } }) => ({
    read: async () => {
      const record = fakes.records.get(profile.connectionId);
      if (record instanceof Error) throw record;
      return record;
    },
    compareAndSwap: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
  }),
}));
vi.mock("../vault/manager", () => ({
  createLocalVaultManager: () => ({
    status: () => ({}),
    resolveField: (...args: unknown[]) => fakes.calls.resolveField(...args),
    signPasskey: (...args: unknown[]) => fakes.calls.signPasskey(...args),
  }),
}));
vi.mock("./setup", () => ({
  createConnectionSetupService: (deps: { vaultFor: typeof fakes.vaultFor }) => {
    fakes.vaultFor = deps.vaultFor;
    return {
      createCaller: () => ({
        disable: (...args: unknown[]) => fakes.calls.disable(...args),
        begin: (...args: unknown[]) => fakes.calls.begin(...args),
        continue: (...args: unknown[]) => fakes.calls.continue(...args),
        sync: (...args: unknown[]) => fakes.calls.sync(...args),
        dispose: () => fakes.calls.dispose(),
      }),
    };
  },
}));

const profile = (connectionId: string) => ({ connectionId });
const configurations = ["active-1", "disabled-1", "empty-1", "unreadable-1", "active-2"].map(
  (connectionId) => ({ label: connectionId, profile: profile(connectionId) }),
);
const registry = {
  list: vi.fn(async () => configurations),
  get: vi.fn(async (connectionId: string) =>
    configurations.find((entry) => entry.profile.connectionId === connectionId),
  ),
};

function runtime(vaultTimeout?: VaultTimeout) {
  const onVaultStateMayChange = vi.fn();
  const value = createConnectionRuntime(
    {} as CryptoHost,
    vaultTimeout
      ? { registry: registry as never, onVaultStateMayChange, vaultTimeout }
      : { registry: registry as never, onVaultStateMayChange },
  );
  return { runtime: value, onVaultStateMayChange };
}

function timeout(overrides: Partial<VaultTimeout> = {}) {
  return {
    check: vi.fn<VaultTimeout["check"]>(overrides.check ?? (async () => undefined)),
    used: vi.fn<VaultTimeout["used"]>(overrides.used ?? (async () => undefined)),
  };
}

function settingsPort() {
  const listeners: { message?: (input: unknown) => void } = {};
  const port = {
    name: SETUP_PORT,
    sender: {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/options.html",
    },
    postMessage: vi.fn<(message: { requestId: string; result: unknown }) => void>(),
    disconnect: vi.fn(),
    onDisconnect: { addListener: vi.fn() },
    onMessage: {
      addListener: (listener: (input: unknown) => void) => {
        listeners.message = listener;
      },
    },
  };
  return {
    port,
    send: (input: unknown) => listeners.message?.(input),
    /** The reply to one request, once it arrives. */
    async reply(requestId: string) {
      let found: unknown;
      await vi.waitFor(() => {
        found = port.postMessage.mock.calls.find(([message]) => message.requestId === requestId);
        expect(found).toBeDefined();
      });
      return (found as [{ result: unknown }])[0].result;
    },
  };
}

const begin = () => ({
  requestId: crypto.randomUUID(),
  type: "connection.begin",
  input: {
    kind: "existing",
    connectionId: "active-1",
    password: "synthetic-password",
    autoUnlock: "enable",
  },
});
const continuation = () => ({
  requestId: crypto.randomUUID(),
  type: "connection.continue",
  input: { flowId: crypto.randomUUID(), newDeviceOtp: "000000" },
});
const sync = () => ({
  requestId: crypto.randomUUID(),
  type: "connection.sync",
  connectionId: "active-1",
});

beforeEach(() => {
  fakes.records = new Map<string, unknown>([
    ["active-1", { ok: true, data: { state: "active" } }],
    ["disabled-1", { ok: true, data: { state: "disabled" } }],
    ["empty-1", { ok: true, data: undefined }],
    ["unreadable-1", { ok: false, error: { code: "storage-unavailable" } }],
    ["active-2", { ok: true, data: { state: "active" } }],
  ]);
  fakes.calls = {
    disable: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
    begin: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
    continue: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      ok: true,
      data: {},
    })),
    sync: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
    resolveField: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      ok: true,
      data: {},
    })),
    signPasskey: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      ok: true,
      data: {},
    })),
    dispose: vi.fn<() => void>(),
  };
  registry.list.mockClear();
  registry.get.mockClear();
});

describe("locking vaults for the vault timeout", () => {
  it("disables automatic unlock for active vaults and those it cannot read", async () => {
    const { runtime: connections, onVaultStateMayChange } = runtime();
    await connections.lockVaults();
    expect(fakes.calls.disable.mock.calls.map(([id]) => id)).toEqual([
      "active-1",
      "unreadable-1",
      "active-2",
    ]);
    expect(fakes.calls.dispose).toHaveBeenCalledOnce();
    expect(onVaultStateMayChange).toHaveBeenCalled();
  });

  it("tries every vault and then rejects with the first failure", async () => {
    fakes.calls.disable.mockImplementation(async (id: unknown) =>
      id === "active-1" || id === "active-2"
        ? { ok: false, error: { code: id === "active-1" ? "storage-unavailable" : "other" } }
        : { ok: true, data: {} },
    );
    const { runtime: connections, onVaultStateMayChange } = runtime();
    await expect(connections.lockVaults()).rejects.toThrow("storage-unavailable");
    expect(fakes.calls.disable.mock.calls.map(([id]) => id)).toEqual([
      "active-1",
      "unreadable-1",
      "active-2",
    ]);
    expect(fakes.calls.dispose).toHaveBeenCalledOnce();
    expect(onVaultStateMayChange).toHaveBeenCalled();
  });

  it("counts a vault whose record read or disable throws as not locked, and still tries the rest", async () => {
    fakes.records.set("active-1", new Error("idb"));
    fakes.calls.disable.mockImplementation(async (id: unknown) => {
      if (id === "unreadable-1") throw new Error("port");
      return { ok: true, data: {} };
    });
    const { runtime: connections } = runtime();
    await expect(connections.lockVaults()).rejects.toThrow("lock-failed");
    expect(fakes.calls.disable.mock.calls.map(([id]) => id)).toEqual(["unreadable-1", "active-2"]);
    expect(fakes.calls.dispose).toHaveBeenCalledOnce();
  });

  it("rejects when the registry cannot be read, after releasing the caller", async () => {
    registry.list.mockRejectedValueOnce(new Error("registry"));
    const { runtime: connections } = runtime();
    await expect(connections.lockVaults()).rejects.toThrow("registry");
    expect(fakes.calls.dispose).toHaveBeenCalledOnce();
    expect(fakes.calls.disable).not.toHaveBeenCalled();
  });

  it("does nothing without vaults", async () => {
    registry.list.mockResolvedValueOnce([]);
    const { runtime: connections } = runtime();
    await connections.lockVaults();
    expect(fakes.calls.disable).not.toHaveBeenCalled();
  });
});

describe("the vault timeout gate", () => {
  it("checks the timeout before each vault read and fails closed when it rejects", async () => {
    const control = timeout({
      check: async () => {
        throw new Error("lock-failed");
      },
    });
    const { runtime: connections } = runtime(control);
    await expect(connections.current("active-1")).rejects.toThrow("vault-unavailable");
    expect(control.check).toHaveBeenCalledOnce();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it("reads the vault after a passing check", async () => {
    const order: string[] = [];
    const control = timeout({
      check: async () => {
        order.push("check");
      },
    });
    registry.get.mockImplementationOnce(async (connectionId: string) => {
      order.push("registry");
      return configurations.find((entry) => entry.profile.connectionId === connectionId);
    });
    const { runtime: connections } = runtime(control);
    // The disabled synthetic vault stops right after the gate.
    await expect(connections.current("disabled-1")).rejects.toThrow("vault-unavailable");
    expect(order).toEqual(["check", "registry"]);
  });

  it("works without a vault timeout", async () => {
    const { runtime: connections } = runtime();
    await expect(connections.current("missing")).rejects.toThrow("invalid-configuration");
  });
});

describe("vault use for the vault timeout", () => {
  it("reports successful field reads and passkey signatures only", async () => {
    const control = timeout();
    runtime(control);
    const { manager } = fakes.vaultFor(profile("active-1"));
    await expect(manager.resolveField("x")).resolves.toMatchObject({ ok: true });
    expect(control.used).toHaveBeenCalledOnce();
    await manager.signPasskey("x");
    expect(control.used).toHaveBeenCalledTimes(2);
    fakes.calls.resolveField.mockResolvedValueOnce({ ok: false, error: { code: "x" } });
    fakes.calls.signPasskey.mockResolvedValueOnce({ ok: false, error: { code: "x" } });
    await expect(manager.resolveField("x")).resolves.toMatchObject({ ok: false });
    await manager.signPasskey("x");
    fakes.calls.resolveField.mockRejectedValueOnce(new Error("crypto"));
    await expect(manager.resolveField("x")).rejects.toThrow("crypto");
    expect(control.used).toHaveBeenCalledTimes(2);
    // The arguments reach the manager unchanged.
    expect(fakes.calls.resolveField).toHaveBeenLastCalledWith("x");
  });

  it("starts the time again before a sign-in from the settings page, and after it succeeds", async () => {
    const order: string[] = [];
    const control = timeout({
      used: async () => {
        order.push("used");
      },
    });
    fakes.calls.begin.mockImplementation(async () => {
      order.push("begin");
      return { ok: true, data: {} };
    });
    const { runtime: connections } = runtime(control);
    const page = settingsPort();
    expect(connections.attach(page.port as never)).toBe(true);
    const first = begin();
    page.send(first);
    expect(await page.reply(first.requestId)).toMatchObject({ ok: true });
    expect(page.port.disconnect).not.toHaveBeenCalled();
    expect(order).toEqual(["used", "begin", "used"]);
    // A failed sign-in still started the time first, but is not counted after.
    fakes.calls.begin.mockImplementationOnce(async () => {
      order.push("begin");
      return { ok: false, error: { code: "invalid-credentials" } };
    });
    const second = begin();
    page.send(second);
    expect(await page.reply(second.requestId)).toMatchObject({ ok: false });
    expect(order).toEqual(["used", "begin", "used", "used", "begin"]);
  });

  it("locks a vault whose time passed before a sign-in starts the time again", async () => {
    const order: string[] = [];
    const control = timeout({
      check: async () => {
        order.push("check");
        throw new Error("lock-failed");
      },
      used: async () => {
        order.push("used");
      },
    });
    fakes.calls.begin.mockImplementation(async () => {
      order.push("begin");
      return { ok: false, error: { code: "invalid-credentials" } };
    });
    const { runtime: connections } = runtime(control);
    const page = settingsPort();
    expect(connections.attach(page.port as never)).toBe(true);
    const request = begin();
    page.send(request);
    // A failed check does not stop the sign-in, which may be what unlocks the vault.
    expect(await page.reply(request.requestId)).toMatchObject({ ok: false });
    expect(order).toEqual(["check", "used", "begin"]);
  });

  it("starts the time again before a second sign-in step, and after it succeeds", async () => {
    const order: string[] = [];
    const control = timeout({
      used: async () => {
        order.push("used");
      },
    });
    fakes.calls.continue.mockImplementation(async () => {
      order.push("continue");
      return { ok: true, data: {} };
    });
    const { runtime: connections } = runtime(control);
    const page = settingsPort();
    expect(connections.attach(page.port as never)).toBe(true);
    const request = continuation();
    page.send(request);
    expect(await page.reply(request.requestId)).toMatchObject({ ok: true });
    expect(order).toEqual(["used", "continue", "used"]);
  });

  it("syncs only after a passing check, and answers unavailable when the check rejects", async () => {
    const control = timeout();
    const { runtime: connections } = runtime(control);
    const page = settingsPort();
    connections.attach(page.port as never);
    const first = sync();
    page.send(first);
    expect(await page.reply(first.requestId)).toEqual({ ok: true, data: {} });
    expect(control.check).toHaveBeenCalledOnce();
    expect(fakes.calls.sync).toHaveBeenCalledExactlyOnceWith("active-1");
    // A sync is not a sign-in.
    expect(control.used).not.toHaveBeenCalled();
    control.check.mockRejectedValueOnce(new Error("lock-failed"));
    const second = sync();
    page.send(second);
    expect(await page.reply(second.requestId)).toEqual({
      ok: false,
      error: { code: "setup-unavailable" },
    });
    expect(fakes.calls.sync).toHaveBeenCalledOnce();
    expect(page.port.disconnect).not.toHaveBeenCalled();
  });
});
