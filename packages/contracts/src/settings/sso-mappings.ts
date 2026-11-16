import * as v from "valibot";
import { identifier, originSchema, vaultServerSchema } from "./schema-primitives";

/** One provider account's item, named as synced settings name accounts (ADR 0023). */
const itemReference = {
  provider: identifier,
  server: vaultServerSchema,
  userId: identifier,
  itemId: identifier,
};

/**
 * A site account's SSO method mapped to the vault item of its identity provider account
 * and the provider's sign-in origin (ADR 0085). It holds no label, username, field value
 * or proof. Every use checks it again against the vault, so a mapping that an edited item
 * no longer fits is refused, never trusted.
 */
export const ssoMappingSchema = v.strictObject({
  ...itemReference,
  method: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1_000_000)),
  idp: v.strictObject({
    ...itemReference,
    /** One of the IdP item's own URI origins, the only place its credentials may go. */
    origin: originSchema,
  }),
});
export type SsoMapping = v.InferOutput<typeof ssoMappingSchema>;

/**
 * At most this many mappings. One with cloud servers and an IdP origin of a usual length
 * takes about 300 bytes, so a full list stays near half of the 120 KiB settings document.
 */
export const MAX_SSO_MAPPINGS = 200;

/** The key of a site account's method: one mapping each. Item IDs ignore letter case. */
export const ssoMappingKey = (
  mapping: Pick<SsoMapping, "provider" | "server" | "userId" | "itemId" | "method">,
): string =>
  JSON.stringify([
    mapping.provider,
    mapping.server,
    mapping.userId,
    mapping.itemId.toLowerCase(),
    mapping.method,
  ]);

export const ssoMappingsSchema = v.pipe(
  v.array(ssoMappingSchema),
  v.maxLength(MAX_SSO_MAPPINGS),
  v.check(
    (mappings) => new Set(mappings.map(ssoMappingKey)).size === mappings.length,
    "Duplicate SSO mappings",
  ),
);
