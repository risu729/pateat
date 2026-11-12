import * as v from "valibot";
import { trustedRecord, type TrustedRecord } from "../storage";
import { ssoSelectedSchema, ssoSourceSchema } from "./sso-wire";
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(8192));
/** Continuity metadata only. No decrypted values or field identifiers enter this store. */
export const ssoContinuitySchema = v.strictObject({
  provider: id,
  server: id,
  userId: id,
  snapshotId: v.pipe(v.string(), v.uuid()),
});
export const ssoMappingSchema = v.strictObject({
  source: ssoSourceSchema,
  selected: ssoSelectedSchema,
  sourceContinuity: ssoContinuitySchema,
  selectedContinuity: ssoContinuitySchema,
});
export type SsoMapping = v.InferOutput<typeof ssoMappingSchema>;
export const SSO_MAPPINGS_KEY = "pateat.login.sso-mappings";
const recordsSchema = v.pipe(
  v.array(ssoMappingSchema),
  v.maxLength(1000),
  v.check((records) => {
    const keys = records.map((entry) =>
      JSON.stringify([entry.source.account, entry.source.method]),
    );
    return new Set(keys).size === keys.length;
  }),
);
export function createSsoMappingStore(
  record: TrustedRecord<SsoMapping[]> = trustedRecord(SSO_MAPPINGS_KEY),
) {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async () => v.parse(recordsSchema, (await record.read()) ?? []);
  return {
    read,
    remove(source: SsoMapping["source"], current: () => boolean = () => true): Promise<boolean> {
      const next = queue.then(async () => {
        const records = await read();
        if (!current()) return false;
        await record.write(
          records.filter(
            (entry) =>
              entry.source.account.connectionId !== source.account.connectionId ||
              entry.source.account.itemId !== source.account.itemId ||
              entry.source.method.number !== source.method.number,
          ),
          current,
        );
        return current();
      });
      queue = next.catch(() => undefined);
      return next;
    },
    /** Serialized replacement of one account/method mapping. Validation is never cached here. */
    save(mapping: SsoMapping, current: () => boolean = () => true): Promise<boolean> {
      const next = queue.then(async () => {
        const parsed = v.parse(ssoMappingSchema, mapping);
        const records = await read();
        if (!current()) return false;
        const rest = records.filter(
          (entry) =>
            entry.source.account.connectionId !== parsed.source.account.connectionId ||
            entry.source.account.itemId !== parsed.source.account.itemId ||
            entry.source.method.number !== parsed.source.method.number,
        );
        if (rest.length >= 1000) throw new Error("mapping-limit");
        await record.write([...rest, parsed], current);
        return current();
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
export type SsoMappingStore = ReturnType<typeof createSsoMappingStore>;
