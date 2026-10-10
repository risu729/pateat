import {
  createEnrollmentChallenge,
  enrollmentCode,
  type EnrollmentRedeemResult,
  type ServiceResponse,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createServiceRuntime, PAIRING_LIFETIME_MS, type ServiceStorage } from "./runtime";
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
    transport?: ServiceTransport;
    now?: () => number;
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const transport = options.transport ?? fakeTransport();
  const runtime = createServiceRuntime({ storage, transport, now: options.now ?? (() => 1_000) });
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
    expect(await second).toMatchObject({ ok: false, error: "wrong-state" });
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

describe("storage failures", () => {
  it("fails closed and keeps a corrupt record", async () => {
    const corrupt = { version: 1, kind: "connected", origin: ORIGIN };
    const { storage, runtime } = setup({ storage: memoryStorage(corrupt) });
    const responses: ServiceResponse[] = [];
    for (const request of [{ version: 1, type: "service.get" }, start, check])
      // oxlint-disable-next-line no-await-in-loop -- requests are serialized anyway
      responses.push(await runtime.handle(request));
    expect(responses).toEqual(Array(3).fill({ ok: false, error: "storage-unavailable" }));
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
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
