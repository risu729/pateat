import {
  createEnrollmentChallenge,
  createEnrollmentVerifier,
  deviceCredentialSchema,
  deviceIdSchema,
  deviceLabelSchema,
  enrollmentCode,
  enrollmentVerifierSchema,
  serviceOriginSchema,
  serviceRequestSchema,
  type ServiceErrorCode,
  type ServiceResponse,
  type ServiceState,
} from "@pateat/contracts";
import * as v from "valibot";
import type { ServiceTransport } from "./transport";

/** A pairing that the owner has not completed is abandoned after this long. */
export const PAIRING_LIFETIME_MS = 15 * 60 * 1000;

// The stored record holds the only copies of the verifier and device credential.
// It lives in trusted extension storage and never crosses to the options page.
const recordSchema = v.variant("kind", [
  v.strictObject({
    version: v.literal(1),
    kind: v.literal("pairing"),
    origin: serviceOriginSchema,
    label: deviceLabelSchema,
    verifier: enrollmentVerifierSchema,
    startedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.strictObject({
    version: v.literal(1),
    kind: v.literal("connected"),
    origin: serviceOriginSchema,
    label: deviceLabelSchema,
    deviceId: deviceIdSchema,
    credential: deviceCredentialSchema,
  }),
]);
type ServiceRecord = v.InferOutput<typeof recordSchema>;

export interface ServiceStorage {
  read(): Promise<unknown>;
  write(record: ServiceRecord): Promise<void>;
  clear(): Promise<void>;
}

class StorageUnavailable extends Error {}

export function createServiceRuntime(options: {
  storage: ServiceStorage;
  transport: ServiceTransport;
  now?: () => number;
}) {
  const { storage, transport } = options;
  const now = options.now ?? Date.now;
  // One request at a time, so a check cannot race a cancel or a second start.
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<ServiceRecord | undefined> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      throw new StorageUnavailable();
    }
    if (stored === undefined) return undefined;
    const parsed = v.safeParse(recordSchema, stored);
    // A corrupt record is kept for inspection rather than silently replaced.
    if (!parsed.success) throw new StorageUnavailable();
    return parsed.output;
  }
  async function save(record: ServiceRecord) {
    try {
      await storage.write(record);
    } catch {
      throw new StorageUnavailable();
    }
  }
  async function clear() {
    try {
      await storage.clear();
    } catch {
      throw new StorageUnavailable();
    }
  }

  async function view(record: ServiceRecord | undefined): Promise<ServiceState> {
    if (!record) return { kind: "disconnected" };
    if (record.kind === "connected")
      return {
        kind: "connected",
        origin: record.origin,
        label: record.label,
        deviceId: record.deviceId,
      };
    const challenge = await createEnrollmentChallenge(record.verifier);
    const enrollUrl = new URL("/enroll", record.origin);
    enrollUrl.search = new URLSearchParams({ challenge, label: record.label }).toString();
    return {
      kind: "pairing",
      origin: record.origin,
      label: record.label,
      code: await enrollmentCode(record.verifier),
      enrollUrl: enrollUrl.href,
      expiresAt: record.startedAt + PAIRING_LIFETIME_MS,
    };
  }

  const ok = async (
    record: ServiceRecord | undefined,
    revoked?: boolean,
  ): Promise<ServiceResponse> => ({
    ok: true,
    state: await view(record),
    ...(revoked === undefined ? {} : { revoked }),
  });
  const fail = async (
    error: ServiceErrorCode,
    record?: ServiceRecord | null,
  ): Promise<ServiceResponse> =>
    record === null ? { ok: false, error } : { ok: false, error, state: await view(record) };

  /** Drops an abandoned pairing so its verifier does not linger. */
  async function current(): Promise<{ record: ServiceRecord | undefined; expired: boolean }> {
    const record = await load();
    if (record?.kind === "pairing" && now() >= record.startedAt + PAIRING_LIFETIME_MS) {
      await clear();
      return { record: undefined, expired: true };
    }
    return { record, expired: false };
  }

  async function run(input: unknown): Promise<ServiceResponse> {
    const parsed = v.safeParse(serviceRequestSchema, input);
    if (!parsed.success) return fail("invalid-request", null);
    const request = parsed.output;
    const { record, expired } = await current();

    switch (request.type) {
      case "service.get":
        return ok(record);
      case "service.pair.start": {
        if (record?.kind === "connected") return fail("wrong-state", record);
        // Starting again replaces an unfinished pairing and its verifier.
        const pairing: ServiceRecord = {
          version: 1,
          kind: "pairing",
          origin: request.origin,
          label: request.label,
          verifier: createEnrollmentVerifier(),
          startedAt: now(),
        };
        await save(pairing);
        return ok(pairing);
      }
      case "service.pair.check": {
        if (expired) return fail("pairing-expired", undefined);
        if (record?.kind !== "pairing") return fail("wrong-state", record);
        const result = await transport.redeem(record.origin, record.verifier);
        if (result.kind === "pending") return ok(record);
        if (result.kind === "code-mismatch") return fail("code-mismatch", record);
        if (result.kind === "failed") return fail(result.error, record);
        // The credential is shown nowhere and replaces the verifier in one write.
        const connected: ServiceRecord = {
          version: 1,
          kind: "connected",
          origin: record.origin,
          label: record.label,
          deviceId: result.result.deviceId,
          credential: result.result.credential,
        };
        await save(connected);
        return ok(connected);
      }
      case "service.pair.cancel":
        if (record?.kind !== "pairing") return fail("wrong-state", record);
        await clear();
        return ok(undefined);
      case "service.disconnect": {
        if (record?.kind !== "connected") return fail("wrong-state", record);
        const result = await transport.revoke(record.origin, record.credential);
        // Forget the credential even when the service is unreachable; the owner
        // can still revoke this device from the service's management page.
        await clear();
        return ok(undefined, result.kind === "revoked");
      }
    }
  }

  return {
    handle(input: unknown): Promise<ServiceResponse> {
      const pending = queue.then(() =>
        run(input).catch((error: unknown) => {
          if (error instanceof StorageUnavailable)
            return { ok: false, error: "storage-unavailable" } as const;
          throw error;
        }),
      );
      queue = pending.catch(() => undefined);
      return pending;
    },
  };
}
