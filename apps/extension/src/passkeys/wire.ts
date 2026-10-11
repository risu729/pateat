import * as v from "valibot";

/** Window message channel between the MAIN-world wrapper and the isolated relay. */
export const PAGE_CHANNEL = "pateat.passkey.v1";
/**
 * MAIN-world backstop: the wrapper delegates once the relay has been silent this long. The relay
 * repeats its acknowledgement every `RELAY_HEARTBEAT_MS` while the background still works, so a
 * chooser window can keep the request open without the page learning that one is shown.
 */
export const PAGE_TIMEOUT_MS = 15_000;
/** How often the relay repeats its acknowledgement while a request is pending. */
export const RELAY_HEARTBEAT_MS = 5_000;
/** Without an acknowledgement from the isolated relay, the wrapper delegates after this. */
export const RELAY_ACK_TIMEOUT_MS = 1_000;
/** Background budget for credential lookup and signing before delegating to the browser. */
export const RUNTIME_TIMEOUT_MS = 10_000;
/** Longest a chooser window keeps a request open (ADR 0021). */
export const CHOOSER_MAX_WAIT_MS = 120_000;
/** A caller's shorter `timeout` is raised to this, as Chrome raises it for its own UI. */
export const CHOOSER_MIN_WAIT_MS = 10_000;
/** The wrapper's absolute limit, past the longest chooser wait, even while the relay answers. */
export const PAGE_MAX_WAIT_MS = CHOOSER_MAX_WAIT_MS + PAGE_TIMEOUT_MS;
/** Upper bound on a serialized snapshot; a maximal valid snapshot is about 100,000 characters. */
export const MAX_REQUEST_CHARACTERS = 131_072;

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

/**
 * The outcome the relay posts to the page. Every page listener can read it, so it never says why
 * Pateat delegated: a reason such as `no-credential` or `ambiguous-credential` would tell the site
 * whether a vault is connected and how many of its passkeys that vault holds.
 */
export const pageResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("assertion"), assertion: assertionSchema }),
  v.strictObject({ kind: v.literal("delegate") }),
  v.strictObject({ kind: v.literal("cancelled") }),
]);
export type PageResult = v.InferOutput<typeof pageResultSchema>;

/** Relay replies the MAIN-world wrapper accepts: an acknowledgement, then one result. */
export const pageReplySchema = v.variant("type", [
  v.strictObject({ channel: v.literal(PAGE_CHANNEL), type: v.literal("ack"), id: operationId }),
  v.strictObject({
    channel: v.literal(PAGE_CHANNEL),
    type: v.literal("result"),
    id: operationId,
    result: pageResultSchema,
  }),
]);

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
