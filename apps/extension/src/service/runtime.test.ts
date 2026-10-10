import {
  createEnrollmentChallenge,
  enrollmentCode,
  type EnrollmentRedeemResult,
  type ServiceResponse,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createServiceRuntime,
  MIN_REDEEM_INTERVAL_MS,
  PAIRING_LIFETIME_MS,
  RATE_LIMIT_BACKOFF_MS,
  type ServiceStorage,
} from "./runtime";
import type { RedeemResult, RevokeResult, ServiceTransport } from "./transport";

// Synthetic origins, verifiers and credentials only.

const ORIGIN = "https://pateat.example.com";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;
const ISSUED: EnrollmentRedeemResult = {
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
  redeem: RedeemResult = { kind: "pending" },
  revoke: RevokeResult = { kind: "revoked" },
) {
  return {
    redeem: vi.fn<ServiceTransport["redeem"]>(async () => redeem),
    revoke: vi.fn<ServiceTransport["revoke"]>(async () => revoke),
  };
}

function setup(
  options: {
    storage?: ReturnType<typeof memoryStorage>;
    transport?: Pick<ServiceTransport, "redeem" | "revoke">;
    now?: () => number;
    hasSiteAccess?: (origin: string) => Promise<boolean>;
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const transport = options.transport ?? fakeTransport();
  const runtime = createServiceRuntime({
    storage,
    transport,
    hasSiteAccess: options.hasSiteAccess ?? (async () => true),
    now: options.now ?? (() => 1_000),
  });
  return { storage, transport, runtime };
}

const start = { version: 1, type: "service.pair.start", origin: ORIGIN, label: "Work laptop" };
const check = { version: 1, type: "service.pair.check" };

function stored(storage: ReturnType<typeof memoryStorage>) {
  return storage.value() as Record<string, unknown>;
}

describe("pairing", () => {
  it("starts with a fresh verifier that never leaves the background", async () => {
    const { storage, runtime } = setup();
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
    });
    const response = await runtime.handle(start);
    const record = stored(storage);
    const verifier = record["verifier"] as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(response)).not.toContain(verifier);
    const challenge = await createEnrollmentChallenge(verifier);
    expect(response).toEqual({
      ok: true,
      state: {
        kind: "pairing",
        origin: ORIGIN,
        label: "Work laptop",
        code: await enrollmentCode(verifier),
        enrollUrl: `${ORIGIN}/enroll?${new URLSearchParams({ challenge, label: "Work laptop" })}`,
        expiresAt: 1_000 + PAIRING_LIFETIME_MS,
      },
    });
  });

  it("replaces an unfinished pairing when started again", async () => {
    const { storage, runtime } = setup();
    await runtime.handle(start);
    const first = stored(storage)["verifier"];
    await runtime.handle({ ...start, origin: "https://other.example.com" });
    expect(stored(storage)["verifier"]).not.toBe(first);
    expect(stored(storage)["origin"]).toBe("https://other.example.com");
  });

  it.each([
    { ...start, origin: "http://pateat.example.com" },
    { ...start, origin: "https://pateat.example.com/" },
    { ...start, origin: "https://user@pateat.example.com" },
    { ...start, label: "" },
    { ...start, verifier: "A".repeat(43) },
    { version: 1, type: "service.unknown" },
  ])("rejects invalid requests: %j", async (request) => {
    const { storage, runtime } = setup();
    expect(await runtime.handle(request)).toEqual({ ok: false, error: "invalid-request" });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("keeps polling while the approval is pending", async () => {
    const transport = fakeTransport({ kind: "pending" });
    const { storage, runtime } = setup({ transport });
    await runtime.handle(start);
    const response = await runtime.handle(check);
    expect(response).toMatchObject({ ok: true, state: { kind: "pairing" } });
    expect(transport.redeem).toHaveBeenCalledWith(ORIGIN, stored(storage)["verifier"]);
  });

  it("keeps the pairing when the typed code does not match", async () => {
    const { storage, runtime } = setup({ transport: fakeTransport({ kind: "code-mismatch" }) });
    await runtime.handle(start);
    expect(await runtime.handle(check)).toMatchObject({
      ok: false,
      error: "code-mismatch",
      state: { kind: "pairing" },
    });
    expect(stored(storage)["kind"]).toBe("pairing");
  });

  it.each(["unreachable", "unexpected-response", "rate-limited"] as const)(
    "reports %s without dropping the pairing",
    async (error) => {
      const { storage, runtime } = setup({ transport: fakeTransport({ kind: "failed", error }) });
      await runtime.handle(start);
      expect(await runtime.handle(check)).toMatchObject({ ok: false, error });
      expect(stored(storage)["kind"]).toBe("pairing");
    },
  );

  it("replaces the verifier with the issued credential", async () => {
    const { storage, runtime } = setup({
      transport: fakeTransport({ kind: "issued", result: ISSUED }),
    });
    await runtime.handle(start);
    const response = await runtime.handle(check);
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

  it("abandons an expired pairing without contacting the service", async () => {
    let time = 1_000;
    const transport = fakeTransport();
    const { storage, runtime } = setup({ transport, now: () => time });
    await runtime.handle(start);
    time += PAIRING_LIFETIME_MS;
    expect(await runtime.handle(check)).toEqual({
      ok: false,
      error: "pairing-expired",
      state: { kind: "disconnected" },
    });
    expect(transport.redeem).not.toHaveBeenCalled();
    expect(storage.value()).toBeUndefined();
  });

  it("paces redemption and backs off after a rate limit", async () => {
    let time = 1_000;
    const transport = fakeTransport();
    const { runtime } = setup({ transport, now: () => time });
    await runtime.handle(start);
    await runtime.handle(check);
    time += MIN_REDEEM_INTERVAL_MS - 1;
    expect(await runtime.handle(check)).toMatchObject({ ok: true, state: { kind: "pairing" } });
    expect(transport.redeem).toHaveBeenCalledTimes(1);
    time += 1;
    transport.redeem.mockResolvedValueOnce({ kind: "failed", error: "rate-limited" });
    expect(await runtime.handle(check)).toMatchObject({ ok: false, error: "rate-limited" });
    time += RATE_LIMIT_BACKOFF_MS - 1;
    // A held-back check keeps reporting the rate limit rather than looking pending.
    expect(await runtime.handle(check)).toMatchObject({ ok: false, error: "rate-limited" });
    expect(transport.redeem).toHaveBeenCalledTimes(2);
    time += 1;
    await runtime.handle(check);
    expect(transport.redeem).toHaveBeenCalledTimes(3);
  });

  it("repeats a held-back failure only within the same pairing", async () => {
    let time = 1_000;
    const transport = fakeTransport({ kind: "code-mismatch" });
    const { runtime } = setup({ transport, now: () => time });
    await runtime.handle(start);
    await runtime.handle(check);
    time += 1;
    expect(await runtime.handle(check)).toMatchObject({ ok: false, error: "code-mismatch" });
    await runtime.handle({ version: 1, type: "service.pair.cancel" });
    await runtime.handle(start);
    expect(await runtime.handle(check)).toMatchObject({ ok: true, state: { kind: "pairing" } });
    expect(transport.redeem).toHaveBeenCalledTimes(1);
  });

  it("keeps a held-back failure when a new pairing cannot be saved", async () => {
    const transport = fakeTransport({ kind: "code-mismatch" });
    const { storage, runtime } = setup({ transport });
    await runtime.handle(start);
    await runtime.handle(check);
    const write = storage.write;
    storage.write = vi.fn(async () => {
      throw new Error("quota");
    });
    expect(await runtime.handle(start)).toEqual({ ok: false, error: "storage-unavailable" });
    storage.write = write;
    expect(await runtime.handle(check)).toMatchObject({ ok: false, error: "code-mismatch" });
    expect(transport.redeem).toHaveBeenCalledTimes(1);
  });

  it("needs Chrome site access to the service before contacting it", async () => {
    let allowed = false;
    const transport = fakeTransport();
    const { storage, runtime } = setup({ transport, hasSiteAccess: async () => allowed });
    expect(await runtime.handle(start)).toEqual({
      ok: false,
      error: "site-access-needed",
      state: { kind: "disconnected" },
    });
    expect(storage.write).not.toHaveBeenCalled();
    allowed = true;
    await runtime.handle(start);
    allowed = false;
    expect(await runtime.handle(check)).toMatchObject({
      ok: false,
      error: "site-access-needed",
      state: { kind: "pairing" },
    });
    expect(transport.redeem).not.toHaveBeenCalled();
  });

  it("treats a failed site access query as withheld", async () => {
    const { runtime } = setup({
      hasSiteAccess: async () => {
        throw new Error("invalid pattern");
      },
    });
    expect(await runtime.handle(start)).toMatchObject({ ok: false, error: "site-access-needed" });
  });

  it("keeps an issued credential whose write failed and saves it on the next request", async () => {
    const storage = memoryStorage();
    const { runtime } = setup({
      storage,
      transport: fakeTransport({ kind: "issued", result: ISSUED }),
    });
    await runtime.handle(start);
    const write = storage.write;
    storage.write = vi.fn(async () => {
      throw new Error("quota");
    });
    expect(await runtime.handle(check)).toEqual({ ok: false, error: "storage-unavailable" });
    storage.write = write;
    expect(await runtime.handle({ version: 1, type: "service.get" })).toMatchObject({
      ok: true,
      state: { kind: "connected", deviceId: ISSUED.deviceId },
    });
    expect(stored(storage)["credential"]).toBe(CREDENTIAL);
  });

  it("reports cancelling an expired pairing as expired", async () => {
    let time = 1_000;
    const { runtime } = setup({ now: () => time });
    await runtime.handle(start);
    time += PAIRING_LIFETIME_MS;
    expect(await runtime.handle({ version: 1, type: "service.pair.cancel" })).toEqual({
      ok: false,
      error: "pairing-expired",
      state: { kind: "disconnected" },
    });
  });

  it("cancels a pairing and forgets its verifier", async () => {
    const { storage, runtime } = setup();
    await runtime.handle(start);
    expect(await runtime.handle({ version: 1, type: "service.pair.cancel" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
    });
    expect(storage.value()).toBeUndefined();
  });

  it("refuses operations in the wrong state", async () => {
    const { runtime, transport } = setup();
    expect(await runtime.handle(check)).toEqual({
      ok: false,
      error: "wrong-state",
      state: { kind: "disconnected" },
    });
    expect(await runtime.handle({ version: 1, type: "service.disconnect" })).toMatchObject({
      error: "wrong-state",
    });
    expect(transport.redeem).not.toHaveBeenCalled();
  });

  it("redeems once when checks overlap", async () => {
    let release: () => void = () => undefined;
    const transport = fakeTransport();
    transport.redeem.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: "issued", result: ISSUED });
        }),
    );
    const { runtime } = setup({ transport });
    await runtime.handle(start);
    const first = runtime.handle(check);
    const second = runtime.handle(check);
    await vi.waitFor(() => expect(transport.redeem).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toMatchObject({ ok: true, state: { kind: "connected" } });
    expect(await second).toMatchObject({ ok: true, state: { kind: "connected" } });
    expect(transport.redeem).toHaveBeenCalledTimes(1);
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

  it("does not start another pairing", async () => {
    const { storage, runtime } = setup({ storage: memoryStorage(connected) });
    expect(await runtime.handle(start)).toMatchObject({
      ok: false,
      error: "wrong-state",
      state: { kind: "connected" },
    });
    expect(storage.value()).toEqual(connected);
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

  it("has no connection while pairing, unpaired or unreadable", async () => {
    const pairing = setup();
    await pairing.runtime.handle(start);
    expect(await pairing.runtime.connection()).toBeUndefined();
    expect(await setup().runtime.connection()).toBeUndefined();
    expect(
      await setup({
        storage: memoryStorage({ version: 1, kind: "connected" }),
      }).runtime.connection(),
    ).toBeUndefined();
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

  it("ignores a sync outcome after disconnecting", async () => {
    const { storage, runtime } = setup({ storage: memoryStorage(connected) });
    await runtime.handle({ version: 1, type: "service.disconnect" });
    await runtime.recordSync(ISSUED.deviceId, { syncedAt: 9_000 });
    expect(storage.value()).toBeUndefined();
  });
});

describe("storage failures", () => {
  it("fails closed and keeps a corrupt record until the owner forgets it", async () => {
    const corrupt = { version: 1, kind: "connected", origin: ORIGIN };
    const transport = fakeTransport();
    const { storage, runtime } = setup({ storage: memoryStorage(corrupt), transport });
    const responses: ServiceResponse[] = [];
    for (const request of [
      { version: 1, type: "service.get" },
      start,
      check,
      { version: 1, type: "service.disconnect" },
    ])
      // oxlint-disable-next-line no-await-in-loop -- requests are serialized anyway
      responses.push(await runtime.handle(request));
    expect(responses).toEqual(Array(4).fill({ ok: false, error: "storage-corrupt" }));
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toEqual({
      ok: true,
      state: { kind: "disconnected" },
    });
    expect(storage.value()).toBeUndefined();
    expect(transport.revoke).not.toHaveBeenCalled();
  });

  it("never forgets an issued credential that is waiting to be saved", async () => {
    const storage = memoryStorage();
    const { runtime } = setup({
      storage,
      transport: fakeTransport({ kind: "issued", result: ISSUED }),
    });
    await runtime.handle(start);
    const write = storage.write;
    storage.write = vi.fn(async () => {
      throw new Error("quota");
    });
    await runtime.handle(check);
    storage.write = write;
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toMatchObject({
      ok: false,
      error: "wrong-state",
      state: { kind: "connected" },
    });
    expect(stored(storage)["credential"]).toBe(CREDENTIAL);
  });

  it("does not forget when storage cannot be read or holds a pairing", async () => {
    const storage = memoryStorage();
    const { runtime } = setup({ storage });
    await runtime.handle(start);
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toMatchObject({
      ok: false,
      error: "wrong-state",
      state: { kind: "pairing" },
    });
    storage.read = vi.fn(async () => {
      throw new Error("denied");
    });
    expect(await runtime.handle({ version: 1, type: "service.forget" })).toEqual({
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

  it("reports unreadable and unwritable storage", async () => {
    const storage = memoryStorage();
    storage.write = vi.fn(async () => {
      throw new Error("quota");
    });
    const { runtime } = setup({ storage });
    expect(await runtime.handle(start)).toEqual({ ok: false, error: "storage-unavailable" });
    storage.read = vi.fn(async () => {
      throw new Error("denied");
    });
    expect(await runtime.handle({ version: 1, type: "service.get" })).toEqual({
      ok: false,
      error: "storage-unavailable",
    });
  });
});
