import type * as Sdk from "@bitwarden/sdk-internal";
import { same, uuid } from "./account-response";
import { bitwardenEmail as email } from "./email";
import type { PreparedBitwardenAccount } from "./account-types";
export type {
  BitwardenAccountBinding,
  PreparedBitwardenAccount,
  BitwardenAccountMapper,
} from "./account-types";
export { createBitwardenAccountMapper } from "./account-map";
import * as v from "valibot";

import { normalizeBitwardenProfile } from "./environment";
import { failure, type BitwardenResult } from "./errors";
import {
  admitLocalCryptoCipher,
  localCryptoAccountContextSchema,
  encryptedCatalogContextSchema,
} from "./local-crypto";
import { admitBitwardenUriMatchContext } from "./uri";

/** Admit a previously accepted encrypted context without online tokens or expiring JWT claims.
 * This is structural admission only; restore must verify account state and every cipher with SDK.
 */
export function admitPreparedBitwardenAccount(
  input: unknown,
  expectedProfile: unknown,
): BitwardenResult<PreparedBitwardenAccount> {
  try {
    const expected = normalizeBitwardenProfile(expectedProfile);
    if (!expected.ok) return expected;
    const checked = v.safeParse(
      v.strictObject({
        binding: v.strictObject({
          profile: v.unknown(),
          userId: uuid,
          email,
          accountVersion: v.picklist(["v1", "v2"]),
        }),
        ...localCryptoAccountContextSchema.entries,
        ciphers: v.pipe(v.array(v.unknown()), v.maxLength(10_000)),
        unavailableItems: v.pipe(
          v.array(v.strictObject({ itemId: uuid, reason: v.literal("unsupported-cipher-type") })),
          v.maxLength(10_000),
        ),
        coverage: v.literal("received-envelope"),
        encryptedMetadata: encryptedCatalogContextSchema,
        uriMatchContext: v.optional(v.unknown()),
      }),
      structuredClone(input),
    );
    if (!checked.success) return failure("invalid-crypto-input");
    // A context that no longer readmits (for example after an IDNA table change) is dropped:
    // matching then reports it unavailable while unrelated field access keeps working.
    const uriMatchContext =
      checked.output.uriMatchContext === undefined
        ? undefined
        : admitBitwardenUriMatchContext(checked.output.uriMatchContext);
    const profile = normalizeBitwardenProfile(checked.output.binding.profile);
    if (!profile.ok || JSON.stringify(profile.data) !== JSON.stringify(expected.data))
      return failure("account-mismatch");
    const value = checked.output;
    if (
      value.binding.accountVersion !== ("V2" in value.accountCryptographicState ? "v2" : "v1") ||
      JSON.stringify(value.kdf) !== JSON.stringify(value.masterPasswordUnlock.kdf)
    )
      return failure("invalid-crypto-input");
    const organizations = new Set<string>();
    for (const entry of value.organizationKeys) {
      entry.organizationId = entry.organizationId.toLowerCase();
      if (organizations.has(entry.organizationId)) return failure("invalid-crypto-input");
      organizations.add(entry.organizationId);
    }
    const ids = new Set<string>();
    const ciphers: PreparedBitwardenAccount["ciphers"] = [];
    for (const cipher of value.ciphers) {
      const admitted = admitLocalCryptoCipher(cipher);
      if (!admitted.ok) return admitted;
      // The mapper caches only admitted copies, so a dropped key means another writer.
      if (!same(admitted.data, cipher)) return failure("invalid-crypto-input");
      const rawId = admitted.data.id as unknown;
      const id = typeof rawId === "string" ? rawId.toLowerCase() : undefined;
      const organizationId = admitted.data.organizationId as unknown as string | undefined;
      if (!id || ids.has(id) || ![1, 2, 3, 4].includes(admitted.data.type))
        return failure("invalid-crypto-input");
      if (organizationId && !organizations.has(organizationId.toLowerCase()))
        return failure("invalid-crypto-input");
      ids.add(id);
      ciphers.push({
        ...admitted.data,
        id,
        ...(organizationId ? { organizationId: organizationId.toLowerCase() } : {}),
      } as unknown as Sdk.Cipher);
    }
    for (const item of value.unavailableItems) {
      if (ids.has(item.itemId)) return failure("invalid-crypto-input");
      ids.add(item.itemId);
    }
    const { uriMatchContext: _retained, ...rest } = value;
    return {
      ok: true,
      data: {
        ...rest,
        binding: { ...value.binding, profile: profile.data },
        ciphers,
        ...(uriMatchContext ? { uriMatchContext } : {}),
      } as PreparedBitwardenAccount,
    };
  } catch {
    return failure("invalid-crypto-input");
  }
}
