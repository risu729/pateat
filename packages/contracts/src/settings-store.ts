import * as v from "valibot";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  settingsRequestSchema,
  settingsSnapshotSchema,
  type SettingsError,
  type SettingsResponse,
  type SettingsRequest,
  type VaultCatalog,
} from "./settings";

export interface SettingsStorage {
  read(): Promise<unknown>;
  write(snapshot: unknown): Promise<void>;
}

function failure(code: SettingsError["code"], message: string): SettingsResponse {
  return { version: 1, ok: false, error: { code, message } };
}

/** One worker-owned queue serializes read/check/write; no other context writes storage. */
export function createSettingsStore(
  storage: SettingsStorage,
  catalog: VaultCatalog = DUMMY_VAULT_CATALOG,
) {
  let queue: Promise<unknown> = Promise.resolve();
  async function execute(request: SettingsRequest): Promise<SettingsResponse> {
    try {
      const stored = await storage.read();
      const parsed =
        stored === undefined
          ? {
              success: true as const,
              output: {
                version: 1 as const,
                revision: 0,
                settings: createDefaultSettings(catalog),
              },
            }
          : v.safeParse(settingsSnapshotSchema, stored);
      if (!parsed.success)
        return failure("storage-corrupt", "Stored settings are invalid. They were not replaced.");
      let snapshot = parsed.output;
      if (request.type === "settings.save") {
        if (request.expectedRevision !== snapshot.revision)
          return failure(
            "revision-conflict",
            "Settings changed in another window. Reload before saving.",
          );
        if (snapshot.revision >= Number.MAX_SAFE_INTEGER - 1)
          return failure("storage-corrupt", "The settings revision cannot be advanced.");
        snapshot = {
          version: 1,
          revision: snapshot.revision + 1,
          settings: request.settings,
        };
        await storage.write(snapshot);
      }
      return { version: 1, ok: true, snapshot, catalog };
    } catch {
      return failure("storage-unavailable", "Local settings storage is unavailable.");
    }
  }
  return {
    handle(value: unknown): Promise<SettingsResponse> {
      // Parse synchronously to detach the queued request from its caller's mutable data.
      const request = v.safeParse(settingsRequestSchema, value);
      if (!request.success) {
        const isSave =
          value !== null &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "settings.save";
        return Promise.resolve(
          failure(
            isSave ? "invalid-settings" : "invalid-request",
            "The settings request did not match the supported schema.",
          ),
        );
      }
      const pending = queue.then(() => execute(request.output));
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
