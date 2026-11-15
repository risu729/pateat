import * as v from "valibot";
import { vaultServerSchema, type VaultCatalog } from "@pateat/contracts";
import { ssoMethodRefSchema } from "../crypto/sso-wire";
import { trustedRecord, type TrustedRecord } from "../storage";
import { ssoOriginSchema } from "./sso-wire";

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
/**
 * One vault item by its provider account, as synced references name it (ADR 0023): the
 * same on every device, unlike the random per-device connection ID.
 */
const portableAccount = { provider: id, server: vaultServerSchema, userId: id, itemId: id };
export type SsoPortableAccount = {
  provider: string;
  server: string;
  userId: string;
  itemId: string;
};
/**
 * A site account's SSO method and the IdP item and origin chosen for it. No decrypted
 * value, label, username, comparison proof, field ID or vault snapshot enters it.
 */
export const ssoMappingSchema = v.strictObject({
  source: v.strictObject({
    ...portableAccount,
    method: ssoMethodRefSchema,
    /** SHA-256 of the encrypted source item: any change to it withdraws the mapping. */
    sourceEvidence: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
  }),
  selected: v.strictObject({ ...portableAccount, origin: ssoOriginSchema }),
});
export type SsoMapping = v.InferOutput<typeof ssoMappingSchema>;
export const MAX_SSO_MAPPINGS = 1000;
/**
 * A trusted device-local record, never synced: ADR 0085 keeps the account mapping local.
 * A reinstall or another device chooses the mapping again. Its entries already name
 * accounts as synced settings do, so a synced form needs no new identity.
 */
export const SSO_MAPPINGS_KEY = "pateat.login.sso-mappings.v1";
type Stored = { version: 1; entries: SsoMapping[] };
const storedSchema = v.object({ version: v.literal(1), entries: v.array(v.unknown()) });

/** The key a site account's method has in the store, from its portable identity. */
export const mappingKey = (source: SsoPortableAccount & { method: { number: number } }) =>
  JSON.stringify([
    source.provider,
    source.server,
    source.userId,
    source.itemId.toLowerCase(),
    source.method.number,
  ]);

/**
 * Whether the catalog shows an account is gone: its provider account has no connection,
 * or every open connection to it lacks the item. A connection whose account or items are
 * unknown, as while it is locked, never shows anything gone.
 */
export function goneFrom(catalog: Pick<VaultCatalog, "connections">) {
  return (account: SsoPortableAccount) => {
    const same = catalog.connections.filter(
      (entry) => entry.provider === account.provider && entry.server === account.server,
    );
    if (same.some((entry) => !entry.userId && !entry.lockedUserId)) return false;
    const mine = same.filter((entry) => (entry.userId ?? entry.lockedUserId) === account.userId);
    if (!mine.length) return true;
    if (mine.some((entry) => !entry.userId || !entry.snapshotId)) return false;
    return !mine.some((entry) =>
      entry.items.some((item) => item.id.toLowerCase() === account.itemId.toLowerCase()),
    );
  };
}

export class SsoMappingLimitError extends Error {
  constructor() {
    super("mapping-limit");
  }
}

export function createSsoMappingStore(
  record: TrustedRecord<Stored> = trustedRecord(SSO_MAPPINGS_KEY),
) {
  let queue: Promise<unknown> = Promise.resolve();
  /**
   * The stored mappings. A record or an entry that does not parse counts as none, as no
   * older format is kept, so the next save overwrites it. A failed read still throws.
   */
  async function read(): Promise<SsoMapping[]> {
    const parsed = v.safeParse(storedSchema, await record.read());
    if (!parsed.success) return [];
    const kept = new Map<string, SsoMapping>();
    for (const entry of parsed.output.entries) {
      const mapping = v.safeParse(ssoMappingSchema, entry);
      if (mapping.success) kept.set(mappingKey(mapping.output.source), mapping.output);
    }
    return [...kept.values()].slice(-MAX_SSO_MAPPINGS);
  }
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }
  const kept = (entries: SsoMapping[], gone?: (account: SsoPortableAccount) => boolean) =>
    gone ? entries.filter((entry) => !gone(entry.source) && !gone(entry.selected)) : entries;
  return {
    read,
    /** Removes one site account's method; `current` fences the write. */
    remove(
      source: SsoMapping["source"],
      current: () => boolean = () => true,
      gone?: (account: SsoPortableAccount) => boolean,
    ): Promise<boolean> {
      return serialized(async () => {
        const entries = await read();
        if (!current()) return false;
        const key = mappingKey(source);
        const rest = kept(entries, gone).filter((entry) => mappingKey(entry.source) !== key);
        await record.write({ version: 1, entries: rest }, current);
        return current();
      });
    },
    /**
     * Replaces one site account's method mapping, first dropping the mappings of accounts
     * the catalog shows are gone. Validation is never cached here.
     */
    save(
      mapping: SsoMapping,
      current: () => boolean = () => true,
      gone?: (account: SsoPortableAccount) => boolean,
    ): Promise<boolean> {
      return serialized(async () => {
        const parsed = v.parse(ssoMappingSchema, mapping);
        const entries = await read();
        if (!current()) return false;
        const key = mappingKey(parsed.source);
        const rest = kept(entries, gone).filter((entry) => mappingKey(entry.source) !== key);
        if (rest.length >= MAX_SSO_MAPPINGS) throw new SsoMappingLimitError();
        await record.write({ version: 1, entries: [...rest, parsed] }, current);
        return current();
      });
    },
    /** Drops the mappings of accounts that are gone; writes only when one is. */
    prune(gone: (account: SsoPortableAccount) => boolean): Promise<number> {
      return serialized(async () => {
        const entries = await read();
        const rest = kept(entries, gone);
        if (rest.length === entries.length) return 0;
        await record.write({ version: 1, entries: rest });
        return entries.length - rest.length;
      });
    },
  };
}
export type SsoMappingStore = ReturnType<typeof createSsoMappingStore>;
