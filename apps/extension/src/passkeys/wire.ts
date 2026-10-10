import * as v from "valibot";

/** Window message channel between the MAIN-world wrapper and the isolated relay. */
export const PAGE_CHANNEL = "pateat.passkey.v1";
/** MAIN-world backstop; the background normally answers or delegates well before this. */
export const PAGE_TIMEOUT_MS = 15_000;
/** Background budget for credential lookup and signing before delegating to the browser. */
export const RUNTIME_TIMEOUT_MS = 10_000;

const operationId = v.pipe(v.string(), v.uuid());
const base64Url = (maximum: number) =>
  v.pipe(v.string(), v.maxLength(maximum), v.regex(/^[A-Za-z0-9_-]*$/u));

export const assertionSchema = v.strictObject({
  credentialId: base64Url(1400),
  clientDataJSON: base64Url(8192),
  authenticatorData: base64Url(64),
  signature: base64Url(128),
  userHandle: v.nullable(base64Url(96)),
});

export const pageRequestSchema = v.variant("type", [
  v.strictObject({
    channel: v.literal(PAGE_CHANNEL),
    type: v.literal("get"),
    id: operationId,
    request: v.unknown(),
  }),
  v.strictObject({ channel: v.literal(PAGE_CHANNEL), type: v.literal("cancel"), id: operationId }),
]);

export const runtimeResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("assertion"), assertion: assertionSchema }),
  v.strictObject({ kind: v.literal("delegate"), reason: v.pipe(v.string(), v.maxLength(64)) }),
  v.strictObject({ kind: v.literal("cancelled") }),
]);
export type RuntimeResult = v.InferOutput<typeof runtimeResultSchema>;

export const pageResultSchema = v.strictObject({
  channel: v.literal(PAGE_CHANNEL),
  type: v.literal("result"),
  id: operationId,
  result: runtimeResultSchema,
});

export const runtimeMessageSchema = v.variant("type", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("passkey.get"),
    operationId,
    request: v.unknown(),
    userActivation: v.boolean(),
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("passkey.cancel"), operationId }),
]);
