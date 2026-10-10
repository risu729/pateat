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
/** The service allows about 10 redemptions a minute per client address. */
export const MIN_REDEEM_INTERVAL_MS = 6_000;
/** The service's rate-limit window; no redemption is attempted inside it after a 429. */
export const RATE_LIMIT_BACKOFF_MS = 60_000;

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
    /** When recipes last synced completely. */
    syncedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    /** The service answered 401: it no longer accepts this credential. */
    rejected: v.optional(v.literal(true)),
  }),
]);
type ServiceRecord = v.InferOutput<typeof recordSchema>;

/** What the background sync needs; never sent to the options page. */
export type ServiceConnection = {
  origin: string;
  deviceId: string;
  credential: string;
  rejected: boolean;
};

export interface ServiceStorage {
  read(): Promise<unknown>;
  write(record: ServiceRecord): Promise<void>;
  clear(): Promise<void>;
}

class StorageUnavailable extends Error {}
class StorageCorrupt extends Error {}

export function createServiceRuntime(options: {
  storage: ServiceStorage;
  transport: Pick<ServiceTransport, "redeem" | "revoke">;
  /** Whether Chrome currently lets the extension reach this origin. */
  hasSiteAccess: (origin: string) => Promise<boolean>;
  now?: () => number;
}) {
  const { storage, transport } = options;
  const hasSiteAccess = (origin: string) => options.hasSiteAccess(origin).catch(() => false);
  const now = options.now ?? Date.now;
  // One request at a time, so a check cannot race a cancel or a second start.
  let queue: Promise<unknown> = Promise.resolve();
  // Every open settings page polls through here, so redemption is paced once per worker.
  let nextRedeemAt = 0;
  // An issued credential whose write failed; the service has already spent the verifier.
  let unsaved: ServiceRecord | undefined;
  // A held-back check repeats the last redemption failure instead of hiding it.
  let lastFailure: ServiceErrorCode | undefined;

  async function load(): Promise<ServiceRecord | undefined> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      throw new StorageUnavailable();
    }
    if (stored === undefined) return undefined;
    const parsed = v.safeParse(recordSchema, stored);
    // A corrupt record is kept until the owner explicitly forgets it.
    if (!parsed.success) throw new StorageCorrupt();
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
        ...(record.syncedAt === undefined ? {} : { syncedAt: record.syncedAt }),
        ...(record.rejected ? { rejected: true } : {}),
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

  /** Drops an abandoned pairing on the next request after it expires. */
  async function current(): Promise<{ record: ServiceRecord | undefined; expired: boolean }> {
    if (unsaved) {
      await save(unsaved);
      unsaved = undefined;
    }
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
    if (request.type === "service.forget") {
      // Only an unreadable record is forgotten; a readable one may hold a live credential.
      if (!unsaved) {
        try {
          await load();
        } catch (error) {
          if (!(error instanceof StorageCorrupt)) throw error;
          await clear();
          return ok(undefined);
        }
      }
      return fail("wrong-state", (await current()).record);
    }
    const { record, expired } = await current();

    switch (request.type) {
      case "service.get":
        return ok(record);
      case "service.pair.start": {
        if (record?.kind === "connected") return fail("wrong-state", record);
        if (!(await hasSiteAccess(request.origin))) return fail("site-access-needed", record);
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
        lastFailure = undefined;
        return ok(pairing);
      }
      case "service.pair.check": {
        if (expired) return fail("pairing-expired", undefined);
        // Already paired, for example by an earlier check or a retried credential write.
        if (record?.kind === "connected") return ok(record);
        if (record?.kind !== "pairing") return fail("wrong-state", record);
        if (!(await hasSiteAccess(record.origin))) return fail("site-access-needed", record);
        if (now() < nextRedeemAt) return lastFailure ? fail(lastFailure, record) : ok(record);
        const result = await transport.redeem(record.origin, record.verifier);
        nextRedeemAt =
          now() +
          (result.kind === "failed" && result.error === "rate-limited"
            ? RATE_LIMIT_BACKOFF_MS
            : MIN_REDEEM_INTERVAL_MS);
        lastFailure =
          result.kind === "code-mismatch"
            ? "code-mismatch"
            : result.kind === "failed"
              ? result.error
              : undefined;
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
        try {
          await save(connected);
        } catch (error) {
          // Retried before the next request rather than losing a credential that exists.
          unsaved = connected;
          throw error;
        }
        return ok(connected);
      }
      case "service.pair.cancel":
        if (expired) return fail("pairing-expired", undefined);
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

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const pending = queue.then(task);
    queue = pending.catch(() => undefined);
    return pending;
  }

  return {
    handle(input: unknown): Promise<ServiceResponse> {
      return enqueue(() =>
        run(input).catch((error: unknown) => {
          if (error instanceof StorageUnavailable)
            return { ok: false, error: "storage-unavailable" } as const;
          if (error instanceof StorageCorrupt)
            return { ok: false, error: "storage-corrupt" } as const;
          throw error;
        }),
      );
    },
    /** The paired device for background sync, or nothing when unpaired or unreadable. */
    connection(): Promise<ServiceConnection | undefined> {
      return enqueue(async () => {
        const { record } = await current();
        return record?.kind === "connected"
          ? {
              origin: record.origin,
              deviceId: record.deviceId,
              credential: record.credential,
              rejected: record.rejected === true,
            }
          : undefined;
      }).catch(() => undefined);
    },
    /**
     * Records a sync outcome for the device that ran it. A record replaced meanwhile,
     * by disconnecting or pairing again, is left alone.
     */
    recordSync(deviceId: string, outcome: { syncedAt: number } | { rejected: true }) {
      return enqueue(async () => {
        const { record } = await current();
        if (record?.kind !== "connected" || record.deviceId !== deviceId) return;
        await save({ ...record, ...outcome });
      });
    },
  };
}
