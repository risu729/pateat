import * as v from "valibot";

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2147483647));
const kdfType = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2147483647));
const optionalParameter = v.optional(v.nullable(positiveInteger));
const kdfSettingsSchema = v.pipe(
  v.looseObject({
    kdfType,
    iterations: positiveInteger,
    memory: optionalParameter,
    parallelism: optionalParameter,
  }),
  v.check((value) => value.kdfType !== 1 || (value.memory != null && value.parallelism != null)),
);
const fields = {
  salt: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1024)))),
};
const legacyFields = {
  kdf: kdfType,
  kdfIterations: positiveInteger,
  kdfMemory: optionalParameter,
  kdfParallelism: optionalParameter,
};

const legacyPreloginSchema = v.pipe(
  v.looseObject({
    ...legacyFields,
    ...fields,
    kdfSettings: v.optional(v.nullable(kdfSettingsSchema)),
  }),
  v.check((value) => value.kdf !== 1 || (value.kdfMemory != null && value.kdfParallelism != null)),
);
// The server declares kdfSettings nullable until its PM-28143 cleanup, and Bitwarden Cloud US
// (2026.9.2) answers this route with only the flat fields, so those stand in for it then.
const passwordPreloginSchema = v.pipe(
  v.looseObject({
    ...fields,
    kdfSettings: v.optional(v.nullable(kdfSettingsSchema)),
    kdf: v.optional(v.nullable(kdfType)),
    kdfIterations: v.optional(v.nullable(positiveInteger)),
    kdfMemory: optionalParameter,
    kdfParallelism: optionalParameter,
  }),
  v.check(
    (value) =>
      value.kdfSettings != null ||
      (value.kdf != null &&
        value.kdfIterations != null &&
        (value.kdf !== 1 || (value.kdfMemory != null && value.kdfParallelism != null))),
  ),
);
export type PreloginResponse =
  | v.InferOutput<typeof legacyPreloginSchema>
  | v.InferOutput<typeof passwordPreloginSchema>;

/** Transport structure only: no KDF execution, account-existence test or salt fallback. */
export function parsePreloginResponse(input: unknown, mode: "legacy" | "password") {
  const parsed =
    mode === "legacy"
      ? v.safeParse(legacyPreloginSchema, input)
      : v.safeParse(passwordPreloginSchema, input);
  if (!parsed.success) return undefined;
  const value = parsed.output;
  const settings = value.kdfSettings;
  if (
    settings &&
    ((value.kdf != null && value.kdf !== settings.kdfType) ||
      (value.kdfIterations != null && value.kdfIterations !== settings.iterations) ||
      (value.kdfMemory != null && value.kdfMemory !== settings.memory) ||
      (value.kdfParallelism != null && value.kdfParallelism !== settings.parallelism))
  )
    return undefined;
  return value;
}

const opaqueRecord = v.pipe(
  v.custom<Record<string, unknown>>(
    (input) => input !== null && typeof input === "object" && !Array.isArray(input),
  ),
  v.record(v.string(), v.unknown()),
);
const records = v.array(opaqueRecord);
export const encryptedSyncEnvelopeSchema = v.looseObject({
  object: v.literal("sync"),
  profile: v.looseObject({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
  folders: records,
  collections: records,
  ciphers: records,
  domains: v.nullable(opaqueRecord),
  policies: records,
  policiesNew: v.optional(v.nullable(records)),
  sends: records,
  userDecryption: v.optional(v.nullable(opaqueRecord)),
});

/** Opaque provider DTO; successful parsing does not make it an authoritative usable snapshot. */
export type EncryptedSyncEnvelope = v.InferOutput<typeof encryptedSyncEnvelopeSchema>;
