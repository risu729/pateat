import { normalizeBitwardenProfile, type BitwardenProfile } from "@pateat/bitwarden";
import {
  createVaultDatabase,
  PROVIDER_SESSIONS_STORE,
  RECORDS_STORE,
  runVaultTransaction,
} from "../vault/database";
import { vaultFailure, type VaultResult } from "../vault/record";
import {
  admitProviderSession,
  sameProviderSession,
  type ProviderSessionEntry,
} from "./session-record";

/** Cache authority captured by one operation. It is compared, never stored in the session. */
export type CacheGuard = { cacheRevision: string };
export interface ProviderSessionStore {
  read(): Promise<VaultResult<ProviderSessionEntry | null>>;
  /** Replace or delete (next = null) the session when its revision and, if given,
   * the active vault record revision both match in one native transaction. A stored
   * session that fails admission matches only expectedRevision = null. */
  compareAndSwap(
    expectedRevision: string | null,
    next: ProviderSessionEntry | null,
    guard?: CacheGuard,
  ): Promise<VaultResult<{ revision: string | null }>>;
  close(): void;
}

export function createIndexedDbProviderSessionStore(options: {
  profile: BitwardenProfile;
  indexedDB?: IDBFactory;
  databaseName?: string;
  timeoutMs?: number;
}): ProviderSessionStore {
  const normalized = normalizeBitwardenProfile(structuredClone(options.profile));
  const profile = normalized.ok ? normalized.data : undefined;
  const database = createVaultDatabase(options);
  const open = () => (profile ? database.open() : Promise.reject(new Error()));
  return {
    async read() {
      if (!profile) return vaultFailure("invalid-profile");
      try {
        return await runVaultTransaction<ProviderSessionEntry | null>(
          await open(),
          PROVIDER_SESSIONS_STORE,
          "readonly",
          database.timeout,
          (stores, set, abort) => {
            const request = stores(PROVIDER_SESSIONS_STORE).get(profile.connectionId);
            request.onsuccess = () => {
              if (request.result === undefined) {
                set({ ok: true, data: null });
                return;
              }
              const admitted = admitProviderSession(request.result, profile);
              if (!admitted.ok) {
                abort(admitted.error.code);
                return;
              }
              set(admitted);
            };
          },
        );
      } catch {
        return vaultFailure("storage-failed");
      }
    },
    async compareAndSwap(expectedRevision, next, guard) {
      if (!profile) return vaultFailure("invalid-profile");
      let admitted: ProviderSessionEntry | null = null;
      if (next) {
        const checked = admitProviderSession(next, profile);
        if (!checked.ok) return checked;
        if (checked.data.revision === expectedRevision) return vaultFailure("invalid-cache-record");
        admitted = checked.data;
      }
      try {
        return await runVaultTransaction<{ revision: string | null }>(
          await open(),
          [RECORDS_STORE, PROVIDER_SESSIONS_STORE],
          "readwrite",
          database.timeout,
          (stores, set, abort) => {
            const sessions = stores(PROVIDER_SESSIONS_STORE);
            const current = sessions.get(profile.connectionId);
            current.onsuccess = () => {
              // A stored session that fails admission is never reused. It has no trusted
              // revision, so only an expected-null delete or replace may overwrite it.
              const old =
                current.result === undefined ? null : admitProviderSession(current.result, profile);
              const oldRevision = old === null ? null : old.ok ? old.data.revision : undefined;
              if (oldRevision === undefined && expectedRevision !== null) {
                abort("invalid-cache-record");
                return;
              }
              if (oldRevision !== undefined && oldRevision !== expectedRevision) {
                abort("storage-conflict");
                return;
              }
              const write = () => {
                if (admitted) sessions.put(admitted, profile.connectionId);
                else sessions.delete(profile.connectionId);
                const readback = sessions.get(profile.connectionId);
                readback.onsuccess = () => {
                  if (
                    admitted
                      ? !sameProviderSession(readback.result, admitted)
                      : readback.result !== undefined
                  ) {
                    abort("storage-uncertain");
                    return;
                  }
                  set({ ok: true, data: { revision: admitted?.revision ?? null } });
                };
              };
              if (!guard) {
                write();
                return;
              }
              // The vault record is read raw: only its authority, not its encrypted contents.
              const record = stores(RECORDS_STORE).get(profile.connectionId);
              record.onsuccess = () => {
                const value = record.result as { revision?: unknown; state?: unknown } | undefined;
                if (value?.state !== "active" || value.revision !== guard.cacheRevision) {
                  abort("storage-conflict");
                  return;
                }
                write();
              };
            };
          },
        );
      } catch {
        return vaultFailure("storage-failed");
      }
    },
    close() {
      database.close();
    },
  };
}
