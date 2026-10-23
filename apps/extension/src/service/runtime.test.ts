import type { DevicePairResult, ServiceResponse } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createServiceRuntime, type ServiceStorage } from "./runtime";
import type { PairResult, RevokeResult, ServiceTransport } from "./transport";

// Synthetic origins and credentials only.

const ORIGIN = "https://pateat.example.com";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;
const ISSUED: DevicePairResult = {
  version: 1,
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: CREDENTIAL,
};

function memoryStorage(initial?: unknown) {
  let value = initial;
  const storage: ServiceStorage & { value(): unknown } = {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (record) => {
      value = structuredClone(record);
    }),
    clear: vi.fn(async () => {
      value = undefined;
    }),
    value: () => value,
  };
  return storage;
}

function fakeTransport(
  pair: PairResult = { kind: "issued", result: ISSUED },
  revoke: RevokeResult = { kind: "revoked" },
) {
  return {
    pair: vi.fn<ServiceTransport["pair"]>(async () => pair),
    revoke: vi.fn<ServiceTransport["revoke"]>(async () => revoke),
  };
}

function setup(
  options: {
    storage?: ReturnType<typeof memoryStorage>;
    transport?: Pick<ServiceTransport, "pair" | "revoke">;
    hasSiteAccess?: (origin: string) => Promise<boolean>;
    onPaired?: (connection: { origin: string; deviceId: string }) => void;
    deviceRecipes?: Parameters<typeof createServiceRuntime>[0]["deviceRecipes"];
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const transport = options.transport ?? fakeTransport();
  const runtime = createServiceRuntime({
    storage,
    transport,
    hasSiteAccess: options.hasSiteAccess ?? (async () => true),
    ...(options.onPaired ? { onPaired: options.onPaired } : {}),
    ...(options.deviceRecipes ? { deviceRecipes: options.deviceRecipes } : {}),
  });
  return { storage, transport, runtime };
}

const pair = { version: 1, type: "service.pair", origin: ORIGIN, label: "Work laptop" };

function stored(storage: ReturnType<typeof memoryStorage>) {
  return storage.value() as Record<string, unknown>;
}

describe("pairing", () => {
  it("tells of a new pairing once its credential is stored, and a listener changes nothing", async () => {
    const onPaired = vi.fn(() => {
      throw new Error("listener");
    });
    const { storage, runtime } = setup({ onPaired });
    const response = await runtime.handle(pair);
    expect(response).toMatchObject({ ok: true, state: { kind: "connected" } });
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(onPaired).toHaveBeenCalledWith({
      origin: ORIGIN,
      deviceId: stored(storage)["deviceId"],
    });
    await runtime.handle(pair);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it("saves the issued credential and never returns it", async () => {
    const { storage, transport, runtime } = setup();
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
    });
    const response = await runtime.handle(pair);
    expect(transport.pair).toHaveBeenCalledWith(ORIGIN, "Work laptop", undefined);
    expect(response).toEqual({
      ok: true,
      state: {
        kind: "connected",
        origin: ORIGIN,
        label: "Work laptop",
        deviceId: ISSUED.deviceId,
      },
    });
    expect(JSON.stringify(response)).not.toContain(CREDENTIAL);
    expect(storage.value()).toEqual({
      version: 1,
      kind: "connected",
      origin: ORIGIN,
      label: "Work laptop",
      deviceId: ISSUED.deviceId,
      credential: CREDENTIAL,
    });
  });

  it.each([
    { ...pair, origin: "http://pateat.example.com" },
    { ...pair, origin: "https://pateat.example.com/" },
    { ...pair, origin: "https://user@pateat.example.com" },
    { ...pair, label: "" },
    { ...pair, label: "Tab\tlabel" },
    { ...pair, credential: CREDENTIAL },
    { version: 1, type: "service.unknown" },
  ])("rejects invalid requests: %j", async (request) => {
    const { storage, transport, runtime } = setup();
    expect(await runtime.handle(request)).toEqual({ ok: false, error: "invalid-request" });
    expect(storage.write).not.toHaveBeenCalled();
    expect(transport.pair).not.toHaveBeenCalled();
  });

  it("passes the chosen or new profile and returns the profiles to choose from", async () => {
    const profiles = [{ id: "00000000-0000-4000-8000-000000000010", name: "Default" }];
    const transport = fakeTransport({ kind: "profile", error: "profile-name-taken", profiles });
    const { storage, runtime } = setup({ transport });
    expect(await runtime.handle({ ...pair, newProfile: "Agent browser" })).toEqual({
      ok: false,
      error: "profile-name-taken",
      profiles,
    });
    expect(transport.pair).toHaveBeenLastCalledWith(ORIGIN, "Work laptop", {
      newProfile: "Agent browser",
    });
    await runtime.handle({ ...pair, profileId: profiles[0]?.id });
    expect(transport.pair).toHaveBeenLastCalledWith(ORIGIN, "Work laptop", {
      profileId: profiles[0]?.id,
    });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("stores nothing when the service asks for a sign-in", async () => {
    const { storage, runtime } = setup({ transport: fakeTransport({ kind: "sign-in-needed" }) });
    expect(await runtime.handle(pair)).toEqual({
      ok: false,
      error: "sign-in-needed",
      state: { kind: "disconnected" },
    });
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.value()).toBeUndefined();
  });

  it.each([
    "unreachable",
    "unexpected-response",
    "rate-limited",
    "sign-in-rejected",
    "extension-not-allowed",
    "pairing-unavailable",
    "access-keys-unavailable",
  ] as const)("reports %s and stores nothing", async (error) => {
    const { storage, runtime } = setup({ transport: fakeTransport({ kind: "failed", error }) });
    expect(await runtime.handle(pair)).toEqual({
      ok: false,
      error,
      state: { kind: "disconnected" },
    });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("needs Chrome site access to the service before contacting it", async () => {
    let allowed = false;
    const transport = fakeTransport();
    const { storage, runtime } = setup({ transport, hasSiteAccess: async () => allowed });
    expect(await runtime.handle(pair)).toEqual({
      ok: false,
      error: "site-access-needed",
      state: { kind: "disconnected" },
    });
    expect(transport.pair).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    allowed = true;
    expect(await runtime.handle(pair)).toMatchObject({ ok: true, state: { kind: "connected" } });
  });

  it("treats a failed site access query as withheld", async () => {
    const { runtime, transport } = setup({
      hasSiteAccess: async () => {
        throw new Error("invalid pattern");
      },
    });
    expect(await runtime.handle(pair)).toMatchObject({ ok: false, error: "site-access-needed" });
    expect(transport.pair).not.toHaveBeenCalled();
  });

  it("keeps an issued credential whose write failed and saves it on the next request", async () => {
    const storage = memoryStorage();
    const { runtime } = setup({ storage });
    const write = storage.write;
    storage.write = vi.fn(async () => {
      throw new Error("quota");
    });
    expect(await runtime.handle(pair)).toEqual({ ok: false, error: "storage-unavailable" });
    storage.write = write;
    expect(await runtime.handle({ version: 1, type: "service.get" })).toMatchObject({
      ok: true,
      state: { kind: "connected", deviceId: ISSUED.deviceId },
    });
    expect(stored(storage)["credential"]).toBe(CREDENTIAL);
  });

  it("refuses to disconnect while unpaired", async () => {
    const { runtime, transport } = setup();
    expect(await runtime.handle({ version: 1, type: "service.disconnect" })).toEqual({
      ok: false,
      error: "wrong-state",
      state: { kind: "disconnected" },
    });
    expect(transport.revoke).not.toHaveBeenCalled();
  });

  it("sends one request when pairings overlap", async () => {
    let release: () => void = () => undefined;
    const transport = fakeTransport();
    transport.pair.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: "issued", result: ISSUED });
        }),
    );
    const { runtime } = setup({ transport });
    const first = runtime.handle(pair);
    const second = runtime.handle(pair);
    await vi.waitFor(() => expect(transport.pair).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toMatchObject({ ok: true, state: { kind: "connected" } });
    expect(await second).toMatchObject({
      ok: false,
      error: "wrong-state",
      state: { kind: "connected" },
    });
    expect(transport.pair).toHaveBeenCalledTimes(1);
  });
});

describe("connected device", () => {
  const connected = {
    version: 1,
    kind: "connected",
    origin: ORIGIN,
    label: "Work laptop",
    deviceId: ISSUED.deviceId,
    credential: CREDENTIAL,
  };

  it("does not pair again", async () => {
    const transport = fakeTransport();
    const { storage, runtime } = setup({ storage: memoryStorage(connected), transport });
    expect(await runtime.handle(pair)).toMatchObject({
      ok: false,
      error: "wrong-state",
      state: { kind: "connected" },
    });
    expect(storage.value()).toEqual(connected);
    expect(transport.pair).not.toHaveBeenCalled();
  });

  it("revokes itself and forgets the credential", async () => {
    const transport = fakeTransport();
    const { storage, runtime } = setup({ storage: memoryStorage(connected), transport });
    expect(await runtime.handle({ version: 1, type: "service.disconnect" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
      revoked: true,
    });
    expect(transport.revoke).toHaveBeenCalledWith(ORIGIN, CREDENTIAL);
    expect(storage.value()).toBeUndefined();
  });

  it("forgets the credential even when the service cannot confirm", async () => {
    const transport = fakeTransport(undefined, { kind: "failed", error: "unreachable" });
    const { storage, runtime } = setup({ storage: memoryStorage(connected), transport });
    expect(await runtime.handle({ version: 1, type: "service.disconnect" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
      revoked: false,
    });
    expect(storage.value()).toBeUndefined();
  });
});

describe("background sync access", () => {
  const connected = {
    version: 1,
    kind: "connected",
    origin: ORIGIN,
    label: "Work laptop",
    deviceId: ISSUED.deviceId,
    credential: CREDENTIAL,
  };

  it("hands the credential only to the background sync", async () => {
    const { runtime } = setup({ storage: memoryStorage(connected) });
    expect(await runtime.connection()).toEqual({
      origin: ORIGIN,
      deviceId: ISSUED.deviceId,
      credential: CREDENTIAL,
      rejected: false,
    });
    expect(JSON.stringify(await runtime.handle({ version: 1, type: "service.get" }))).not.toContain(
      CREDENTIAL,
    );
  });

  it("has no connection while unpaired or unreadable", async () => {
    expect(await setup().runtime.connection()).toBeUndefined();
    // Unreadable is not unpaired: the recipe cache must not be cleared for it.
    await expect(
      setup({
        storage: memoryStorage({ version: 1, kind: "connected" }),
      }).runtime.connection(),
    ).rejects.toThrow();
  });

  it("shows sync outcomes for the same device only", async () => {
    const { storage, runtime } = setup({ storage: memoryStorage(connected) });
    await runtime.recordSync(ISSUED.deviceId, { syncedAt: 9_000 });
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: true,
      state: {
        kind: "connected",
        origin: ORIGIN,
        label: "Work laptop",
        deviceId: ISSUED.deviceId,
        syncedAt: 9_000,
      },
    });
    await runtime.recordSync(ISSUED.deviceId, { rejected: true });
    expect(await runtime.connection()).toMatchObject({ rejected: true });
    expect(await runtime.handle({ version: 1, type: "service.get" })).toMatchObject({
      state: { syncedAt: 9_000, rejected: true },
    });
    const before = structuredClone(storage.value());
    await runtime.recordSync("7a2e4d2f-6e1c-4b63-8e66-4e8b9f1f3c52", { syncedAt: 10_000 });
    expect(storage.value()).toEqual(before);
  });

  it("shows a full cache until the next complete sync", async () => {
    const { runtime } = setup({ storage: memoryStorage(connected) });
    await runtime.recordSync(ISSUED.deviceId, { cacheFull: true });
    expect(await runtime.handle({ version: 1, type: "service.get" })).toMatchObject({
      state: { cacheFull: true },
    });
    await runtime.recordSync(ISSUED.deviceId, { syncedAt: 9_000 });
    const response = await runtime.handle({ version: 1, type: "service.get" });
    expect(response).toMatchObject({ state: { syncedAt: 9_000 } });
    expect(response.ok && response.state).not.toHaveProperty("cacheFull");
  });

  it("answers a lookup without waiting behind a slow revocation", async () => {
    let finish: (result: RevokeResult) => void = () => undefined;
    const transport = fakeTransport();
    transport.revoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { runtime } = setup({ storage: memoryStorage(connected), transport });
    const disconnecting = runtime.handle({ version: 1, type: "service.disconnect" });
    await vi.waitFor(() => expect(transport.revoke).toHaveBeenCalledOnce());
    expect(await runtime.connection()).toMatchObject({ deviceId: ISSUED.deviceId });
    finish({ kind: "revoked" });
    await disconnecting;
    expect(await runtime.connection()).toBeUndefined();
  });

  it("ignores a sync outcome after disconnecting", async () => {
    const { storage, runtime } = setup({ storage: memoryStorage(connected) });
    await runtime.handle({ version: 1, type: "service.disconnect" });
    await runtime.recordSync(ISSUED.deviceId, { syncedAt: 9_000 });
    expect(storage.value()).toBeUndefined();
  });
});

describe("first settings sync since pairing (ADR 0023)", () => {
  const connected = {
    version: 1,
    kind: "connected",
    origin: ORIGIN,
    label: "Work laptop",
    deviceId: ISSUED.deviceId,
    credential: CREDENTIAL,
  };

  it("leaves a device that was never paired unaffected", async () => {
    expect(await setup().runtime.settingsSyncPending()).toBe(false);
  });

  it("waits from pairing until a settings sync is recorded, and keeps that through later outcomes", async () => {
    const { storage, runtime } = setup();
    await runtime.handle(pair);
    expect(await runtime.settingsSyncPending()).toBe(true);
    expect(await runtime.connection()).not.toHaveProperty("settingsSynced");
    await runtime.recordSync(ISSUED.deviceId, { settingsSynced: true });
    expect(await runtime.settingsSyncPending()).toBe(false);
    expect(await runtime.connection()).toMatchObject({ settingsSynced: true });
    for (const outcome of [{ cacheFull: true }, { syncedAt: 9_000 }, { rejected: true }] as const)
      // oxlint-disable-next-line no-await-in-loop -- outcomes are recorded in order
      await runtime.recordSync(ISSUED.deviceId, outcome);
    expect(stored(storage)).toMatchObject({ settingsSynced: true });
    expect(await runtime.settingsSyncPending()).toBe(false);
    // The settings page is not told; the record only gates vault use.
    const state = await runtime.handle({ version: 1, type: "service.get" });
    expect(state.ok && state.state).not.toHaveProperty("settingsSynced");
  });

  it("waits again after pairing anew", async () => {
    const { runtime } = setup({ storage: memoryStorage({ ...connected, settingsSynced: true }) });
    expect(await runtime.settingsSyncPending()).toBe(false);
    await runtime.handle({ version: 1, type: "service.disconnect" });
    expect(await runtime.settingsSyncPending()).toBe(false);
    await runtime.handle(pair);
    expect(await runtime.settingsSyncPending()).toBe(true);
  });

  it("waits while a new pairing's credential is not saved yet", async () => {
    const storage = memoryStorage();
    storage.write = vi.fn(async () => {
      throw new Error("Synthetic storage failure");
    });
    const { runtime } = setup({ storage });
    await runtime.handle(pair);
    expect(storage.write).toHaveBeenCalled();
    expect(await runtime.settingsSyncPending()).toBe(true);
  });

  it("ignores another device's settings sync", async () => {
    const { runtime } = setup({ storage: memoryStorage(connected) });
    await runtime.recordSync("7a2e4d2f-6e1c-4b63-8e66-4e8b9f1f3c52", { settingsSynced: true });
    expect(await runtime.settingsSyncPending()).toBe(true);
  });

  it("counts a record that cannot be read as waiting", async () => {
    const corrupt = setup({ storage: memoryStorage({ ...connected, settingsSynced: "yes" }) });
    expect(await corrupt.runtime.settingsSyncPending()).toBe(true);
    const storage = memoryStorage({ ...connected, settingsSynced: true });
    storage.read = vi.fn(async () => {
      throw new Error("Synthetic storage failure");
    });
    expect(await setup({ storage }).runtime.settingsSyncPending()).toBe(true);
  });
});

function connectedRecord() {
  return {
    version: 1,
    kind: "connected",
    origin: ORIGIN,
    label: "Work laptop",
    deviceId: ISSUED.deviceId,
    credential: CREDENTIAL,
  };
}

describe("storage failures", () => {
  it("fails closed and keeps a corrupt record until the owner forgets it", async () => {
    const corrupt = { version: 1, kind: "connected", origin: ORIGIN };
    const transport = fakeTransport();
    const { storage, runtime } = setup({ storage: memoryStorage(corrupt), transport });
    const responses: ServiceResponse[] = [];
    for (const request of [
      { version: 1, type: "service.get" },
      pair,
      { version: 1, type: "service.disconnect" },
    ])
      // oxlint-disable-next-line no-await-in-loop -- requests are serialized anyway
      responses.push(await runtime.handle(request));
    expect(responses).toEqual(Array(3).fill({ ok: false, error: "storage-corrupt" }));
    expect(transport.pair).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
    });
    expect(storage.value()).toBeUndefined();
    expect(transport.revoke).not.toHaveBeenCalled();
  });

  it("reads a record of an unknown kind as corrupt", async () => {
    const record = { ...connectedRecord(), kind: "paired" };
    const { runtime } = setup({ storage: memoryStorage(record) });
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: false,
      error: "storage-corrupt",
    });
  });

  it("never forgets an issued credential that is waiting to be saved", async () => {
    const storage = memoryStorage();
    const { runtime } = setup({ storage });
    const write = storage.write;
    storage.write = vi.fn(async () => {
      throw new Error("quota");
    });
    await runtime.handle(pair);
    storage.write = write;
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toMatchObject({
      ok: false,
      error: "wrong-state",
      state: { kind: "connected" },
    });
    expect(stored(storage)["credential"]).toBe(CREDENTIAL);
  });

  it("does not forget when storage cannot be read or holds nothing", async () => {
    const storage = memoryStorage();
    const { runtime } = setup({ storage });
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toEqual({
      ok: false,
      error: "wrong-state",
      state: { kind: "disconnected" },
    });
    storage.read = vi.fn(async () => {
      throw new Error("denied");
    });
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toEqual({
      ok: false,
      error: "storage-unavailable",
    });
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: false,
      error: "storage-unavailable",
    });
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it("never forgets a readable connection", async () => {
    const connected = {
      version: 1,
      kind: "connected",
      origin: ORIGIN,
      label: "Work laptop",
      deviceId: ISSUED.deviceId,
      credential: CREDENTIAL,
    };
    const { storage, runtime } = setup({ storage: memoryStorage(connected) });
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toMatchObject({
      ok: false,
      error: "wrong-state",
      state: { kind: "connected" },
    });
    expect(storage.value()).toEqual(connected);
  });
});

describe("recipes this device keeps as its own (ADR 0040)", () => {
  function heldRecipes(count = 0) {
    let held: number | undefined = count;
    return {
      count: vi.fn(async () => held),
      keepSynced: vi.fn(async () => {
        held = 3;
      }),
      clear: vi.fn(async () => {
        held = 0;
      }),
    };
  }

  it("keeps the synced recipes before it disconnects, when asked", async () => {
    const deviceRecipes = heldRecipes();
    const { runtime, transport } = setup({ deviceRecipes });
    await runtime.handle(pair);
    expect(
      await runtime.handle({ version: 1, type: "service.disconnect", keepRecipes: true }),
    ).toEqual({ ok: true, state: { kind: "disconnected", keptRecipes: 3 }, revoked: true });
    expect(deviceRecipes.keepSynced).toHaveBeenCalledOnce();
    expect(deviceRecipes.keepSynced.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transport.revoke).mock.invocationCallOrder[0]!,
    );
  });

  it("keeps nothing without being asked", async () => {
    const deviceRecipes = heldRecipes();
    const { runtime } = setup({ deviceRecipes });
    await runtime.handle(pair);
    expect(await runtime.handle({ version: 1, type: "service.disconnect" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
      revoked: true,
    });
    expect(deviceRecipes.keepSynced).not.toHaveBeenCalled();
  });

  it("stays paired when the recipes cannot be kept", async () => {
    const deviceRecipes = heldRecipes();
    deviceRecipes.keepSynced.mockRejectedValue(new Error("too large"));
    const { runtime, transport } = setup({ deviceRecipes });
    await runtime.handle(pair);
    expect(
      await runtime.handle({ version: 1, type: "service.disconnect", keepRecipes: true }),
    ).toMatchObject({ ok: false, error: "recipes-not-kept", state: { kind: "connected" } });
    expect(transport.revoke).not.toHaveBeenCalled();
  });

  it("says how many it holds, or that they cannot be read, and deletes them unpaired", async () => {
    const deviceRecipes = heldRecipes(2);
    const { runtime } = setup({ deviceRecipes });
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: true,
      state: { kind: "disconnected", keptRecipes: 2 },
    });
    expect(await runtime.handle({ version: 1, type: "service.delete-recipes" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
    });
    deviceRecipes.count.mockResolvedValue(-1);
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: true,
      state: { kind: "disconnected", keptRecipes: -1 },
    });
    // Storage that is unavailable for now shows no count rather than offering deletion.
    deviceRecipes.count.mockResolvedValue(undefined);
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
    });
  });

  it("deletes them only while unpaired", async () => {
    const deviceRecipes = heldRecipes(2);
    const { runtime } = setup({ deviceRecipes });
    await runtime.handle(pair);
    expect(await runtime.handle({ version: 1, type: "service.delete-recipes" })).toMatchObject({
      ok: false,
      error: "wrong-state",
    });
    expect(deviceRecipes.clear).not.toHaveBeenCalled();
  });
});
