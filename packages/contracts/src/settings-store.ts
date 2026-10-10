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
  type SettingsSnapshot,
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
  catalogSource:
    | VaultCatalog
    | ((snapshot: SettingsSnapshot) => Promise<VaultCatalog>) = DUMMY_VAULT_CATALOG,
  initialCatalog: VaultCatalog = typeof catalogSource === "function"
    ? { connections: [] }
    : catalogSource,
) {
  let queue: Promise<unknown> = Promise.resolve();
  class CorruptSettings extends Error {}
  async function readSnapshot(): Promise<SettingsSnapshot> {
    const stored = await storage.read();
    if (stored !== undefined) {
      const checked = v.safeParse(settingsSnapshotSchema, stored);
      if (!checked.success) throw new CorruptSettings();
      return checked.output;
    }
    return { version: 1, revision: 0, settings: createDefaultSettings(initialCatalog) };
  }
  async function catalogFor(snapshot: SettingsSnapshot) {
    return typeof catalogSource === "function" ? catalogSource(snapshot) : catalogSource;
  }
  async function execute(request: SettingsRequest): Promise<SettingsResponse> {
    try {
      let snapshot: SettingsSnapshot;
      try {
        snapshot = await readSnapshot();
      } catch (error) {
        return error instanceof CorruptSettings
          ? failure("storage-corrupt", "Stored settings are invalid. They were not replaced.")
          : failure("storage-unavailable", "Local settings storage is unavailable.");
      }
      if (request.type === "settings.save") {
        if (request.expectedRevision !== snapshot.revision)
          return failure(
            "revision-conflict",
            "Settings changed in another window. Reload before saving.",
          );
        if (snapshot.revision >= Number.MAX_SAFE_INTEGER - 1)
          return failure("storage-corrupt", "The settings revision cannot be advanced.");
        const nextSettings = request.settings;
        const displayed = await catalogFor(snapshot);
        // Only deliberate snapshot-bound review may remove unresolved custom denies.
        for (const prior of snapshot.settings.connections) {
          const policy = snapshot.fieldPolicies?.find(
            (entry) => entry.connectionId === prior.connectionId,
          );
          const metadata = displayed.connections.find((entry) => entry.id === prior.connectionId);
          const quarantine = new Set([
            ...(policy?.quarantinedItemIds ?? []),
            ...(metadata?.quarantinedItemIds ?? []),
            ...(!metadata?.snapshotId || policy?.snapshotId !== metadata.snapshotId
              ? [
                  ...(policy?.protectedItemIds ?? []),
                  ...prior.excludedFields
                    .filter((ref) => ref.fieldId.startsWith("custom."))
                    .map((ref) => ref.itemId),
                ]
              : []),
          ]);
          let next = nextSettings.connections.find(
            (entry) => entry.connectionId === prior.connectionId,
          );
          if (quarantine.size && !next) {
            next = structuredClone(prior);
            nextSettings.connections.push(next);
          }
          if (!next) continue;
          for (const ref of prior.excludedFields) {
            if (
              quarantine.has(ref.itemId) &&
              ref.fieldId.startsWith("custom.") &&
              !next.excludedFields.some(
                (entry) => entry.itemId === ref.itemId && entry.fieldId === ref.fieldId,
              )
            )
              next.excludedFields.push(ref);
          }
        }
        const policies = [...(snapshot.fieldPolicies ?? [])];
        for (const connection of nextSettings.connections) {
          const prior = snapshot.settings.connections.find(
            (entry) => entry.connectionId === connection.connectionId,
          );
          const history = [
            ...new Set(
              [...(prior?.excludedFields ?? []), ...connection.excludedFields]
                .filter((ref) => ref.fieldId.startsWith("custom."))
                .map((ref) => ref.itemId),
            ),
          ];
          if (!history.length) continue;
          const policy = policies.find((entry) => entry.connectionId === connection.connectionId);
          if (policy)
            policy.protectedItemIds = [
              ...new Set([...(policy.protectedItemIds ?? []), ...history]),
            ];
          else {
            const metadata = displayed.connections.find(
              (entry) => entry.id === connection.connectionId,
            );
            if (metadata?.snapshotId)
              policies.push({
                connectionId: connection.connectionId,
                snapshotId: metadata.snapshotId,
                quarantinedItemIds: [],
                protectedItemIds: history,
              });
          }
        }
        snapshot = {
          version: 1,
          revision: snapshot.revision + 1,
          settings: nextSettings,
          ...(policies.length ? { fieldPolicies: policies } : {}),
        };
        const finalSnapshot = v.safeParse(settingsSnapshotSchema, snapshot);
        if (!finalSnapshot.success)
          return failure(
            "invalid-settings",
            "The protected exclusions exceed the supported settings limits.",
          );
        snapshot = finalSnapshot.output;
        await storage.write(snapshot);
      }
      return { version: 1, ok: true, snapshot, catalog: await catalogFor(snapshot) };
    } catch {
      return failure("storage-unavailable", "Local settings storage is unavailable.");
    }
  }
  async function executeUpdate(
    expectedRevision: number | undefined,
    mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ) {
    const current = await readSnapshot();
    if (expectedRevision !== undefined && expectedRevision !== current.revision)
      throw new Error("revision-conflict");
    if (current.revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error("storage-corrupt");
    const next = v.parse(settingsSnapshotSchema, mutate(structuredClone(current)));
    next.revision = current.revision + 1;
    await storage.write(next);
    return next;
  }
  return {
    /** Background metadata read without loading the vault catalog. */
    read(): Promise<SettingsSnapshot> {
      const pending = queue.then(readSnapshot);
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    /** Trusted background-only mutation; the options save contract cannot change bindings. */
    update(
      expectedRevision: number | undefined,
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
    ): Promise<SettingsSnapshot> {
      const pending = queue.then(() => executeUpdate(expectedRevision, mutate));
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
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
