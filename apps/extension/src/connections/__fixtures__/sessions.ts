import { vaultFailure } from "../../vault/record";
import { admitProviderSession, type ProviderSessionEntry } from "../session-record";
import type { ProviderSessionStore } from "../session-store";

/** In-memory compare-and-swap model. Native atomicity is tested in Chromium. */
export function memorySessionStore(options: {
  profile: unknown;
  cacheRevision: () => string | null;
}) {
  let value: unknown;
  const writes: (ProviderSessionEntry | null)[] = [];
  let failNext: "storage-uncertain" | undefined;
  const store: ProviderSessionStore = {
    async read() {
      if (value === undefined) return { ok: true, data: null };
      return admitProviderSession(value, options.profile);
    },
    async compareAndSwap(expectedRevision, next, guard) {
      if (failNext) {
        const code = failNext;
        failNext = undefined;
        return vaultFailure(code);
      }
      if (next) {
        const admitted = admitProviderSession(next, options.profile);
        if (!admitted.ok) return admitted;
      }
      const old = value === undefined ? null : admitProviderSession(value, options.profile);
      const oldRevision = old === null ? null : old.ok ? old.data.revision : undefined;
      if (oldRevision === undefined && expectedRevision !== null)
        return vaultFailure("invalid-cache-record");
      if (oldRevision !== undefined && oldRevision !== expectedRevision)
        return vaultFailure("storage-conflict");
      if (guard && options.cacheRevision() !== guard.cacheRevision)
        return vaultFailure("storage-conflict");
      value = next ? structuredClone(next) : undefined;
      writes.push(next ? structuredClone(next) : null);
      return { ok: true, data: { revision: next?.revision ?? null } };
    },
    close() {},
  };
  return {
    store,
    writes,
    raw: () => structuredClone(value),
    set: (next: unknown) => {
      value = structuredClone(next);
    },
    failNext: (code: "storage-uncertain") => {
      failNext = code;
    },
  };
}
