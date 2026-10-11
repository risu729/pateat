import {
  deviceCredentialSchema,
  deviceIdSchema,
  deviceLabelSchema,
  serviceOriginSchema,
  serviceRequestSchema,
  type ServiceErrorCode,
  type ServiceResponse,
  type ServiceState,
} from "@pateat/contracts";
import * as v from "valibot";
import type { ServiceTransport } from "./transport";

// The stored record holds the only copy of the device credential. It lives in
// trusted extension storage and never crosses to the options page.
const recordSchema = v.strictObject({
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
  /** Recipes outgrew the local cache or settings their limits; cleared by a complete sync. */
  cacheFull: v.optional(v.literal(true)),
});
type ServiceRecord = v.InferOutput<typeof recordSchema>;

/** A sync outcome kept on the connected record for the settings page. */
export type RecipeSyncRecord = { syncedAt: number } | { rejected: true } | { cacheFull: true };

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
  transport: Pick<ServiceTransport, "pair" | "revoke">;
  /** Whether Chrome currently lets the extension reach this origin. */
  hasSiteAccess: (origin: string) => Promise<boolean>;
}) {
  const { storage, transport } = options;
  const hasSiteAccess = (origin: string) => options.hasSiteAccess(origin).catch(() => false);
  // One request at a time, so a second pairing cannot race the first or a disconnect.
  let queue: Promise<unknown> = Promise.resolve();
  // An issued credential whose write failed; the service has already created the device.
  let unsaved: ServiceRecord | undefined;

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

  function view(record: ServiceRecord | undefined): ServiceState {
    if (!record) return { kind: "disconnected" };
    return {
      kind: "connected",
      origin: record.origin,
      label: record.label,
      deviceId: record.deviceId,
      ...(record.syncedAt === undefined ? {} : { syncedAt: record.syncedAt }),
      ...(record.rejected ? { rejected: true } : {}),
      ...(record.cacheFull ? { cacheFull: true } : {}),
    };
  }

  const ok = (record: ServiceRecord | undefined, revoked?: boolean): ServiceResponse => ({
    ok: true,
    state: view(record),
    ...(revoked === undefined ? {} : { revoked }),
  });
  const fail = (error: ServiceErrorCode, record?: ServiceRecord | null): ServiceResponse =>
    record === null ? { ok: false, error } : { ok: false, error, state: view(record) };

  /** The stored record, after retrying a credential write that failed. */
  async function current(): Promise<ServiceRecord | undefined> {
    if (unsaved) {
      await save(unsaved);
      unsaved = undefined;
    }
    return load();
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
      return fail("wrong-state", await current());
    }
    const record = await current();

    switch (request.type) {
      case "service.get":
        return ok(record);
      case "service.pair": {
        if (record) return fail("wrong-state", record);
        // Without site access the request would be an ordinary CORS request; none is sent.
        if (!(await hasSiteAccess(request.origin))) return fail("site-access-needed", record);
        const result = await transport.pair(request.origin, request.label);
        // Nothing is stored until the service has created the device.
        if (result.kind === "sign-in-needed") return fail("sign-in-needed", record);
        if (result.kind === "failed") return fail(result.error, record);
        // The credential is shown nowhere and goes straight into trusted storage.
        const connected: ServiceRecord = {
          version: 1,
          kind: "connected",
          origin: request.origin,
          label: request.label,
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
      case "service.disconnect": {
        if (!record) return fail("wrong-state", record);
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
    /**
     * The paired device for background sync, or nothing when unpaired. It rejects when
     * the record cannot be read, so callers do not mistake that for a disconnect.
     * It reads storage directly, so a login lookup never waits behind a pairing or
     * revocation request in the queue; each storage read sees one whole record.
     */
    async connection(): Promise<ServiceConnection | undefined> {
      const record = await load();
      return record
        ? {
            origin: record.origin,
            deviceId: record.deviceId,
            credential: record.credential,
            rejected: record.rejected === true,
          }
        : undefined;
    },
    /**
     * Records a sync outcome for the device that ran it. A record replaced meanwhile,
     * by disconnecting or pairing again, is left alone.
     */
    recordSync(deviceId: string, outcome: RecipeSyncRecord) {
      return enqueue(async () => {
        const record = await current();
        if (record?.deviceId !== deviceId) return;
        // A complete sync means the cache fits again.
        const { cacheFull: _, ...rest } = record;
        await save("syncedAt" in outcome ? { ...rest, ...outcome } : { ...record, ...outcome });
      });
    },
  };
}
