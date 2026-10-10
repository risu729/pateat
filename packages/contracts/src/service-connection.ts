import * as v from "valibot";
import { deviceIdSchema, deviceLabelSchema } from "./enrollment";
import { normalizeHostname, parseSiteUrl } from "./settings";

// Options page ↔ background contracts for the optional sync service connection.
// The verifier and device credential stay in the background; they never cross here.

/** An exact HTTPS origin such as `https://pateat.example.com`, without a path. */
export const serviceOriginSchema = v.pipe(
  v.string(),
  v.maxLength(300),
  v.check((value) => {
    const url = parseSiteUrl(value);
    return (
      url?.protocol === "https:" &&
      url.origin === value &&
      normalizeHostname(url.hostname) !== undefined
    );
  }, "Use an exact HTTPS origin"),
);

/** Parses what a person types, accepting a trailing slash. */
export function normalizeServiceOrigin(input: string): string | undefined {
  const url = parseSiteUrl(input.trim());
  if (!url || url.pathname !== "/" || url.search || url.hash) return undefined;
  return v.safeParse(serviceOriginSchema, url.origin).success ? url.origin : undefined;
}

const enrollmentCodeSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
);
const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0));

export const serviceStateSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("disconnected") }),
  v.pipe(
    v.strictObject({
      kind: v.literal("pairing"),
      origin: serviceOriginSchema,
      label: deviceLabelSchema,
      /** Shown to the owner to type on the approval page; not a credential. */
      code: enrollmentCodeSchema,
      enrollUrl: v.pipe(v.string(), v.url()),
      expiresAt: timestamp,
    }),
    // The options page opens this URL, so it must be the service's own approval page.
    v.check(
      (state) => state.enrollUrl.startsWith(`${state.origin}/enroll?`),
      "Use the service's approval page",
    ),
  ),
  v.strictObject({
    kind: v.literal("connected"),
    origin: serviceOriginSchema,
    label: deviceLabelSchema,
    deviceId: deviceIdSchema,
    /** When recipes last synced completely; absent before the first complete sync. */
    syncedAt: v.optional(timestamp),
    /** The service no longer accepts this device; cached recipes still apply. */
    rejected: v.optional(v.literal(true)),
    /** The owner's recipes outgrew the local cache; newer changes are not applied. */
    cacheFull: v.optional(v.literal(true)),
  }),
]);

export const serviceRequestSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("service.get") }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("service.pair.start"),
    origin: serviceOriginSchema,
    label: deviceLabelSchema,
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("service.pair.check") }),
  v.strictObject({ version: v.literal(1), type: v.literal("service.pair.cancel") }),
  v.strictObject({ version: v.literal(1), type: v.literal("service.disconnect") }),
  /** Forgets an unreadable local record without contacting the service. */
  v.strictObject({ version: v.literal(1), type: v.literal("service.forget") }),
]);

export const serviceErrorCodeSchema = v.picklist([
  "invalid-request",
  "storage-unavailable",
  /** The stored connection cannot be read; `service.forget` is the way out. */
  "storage-corrupt",
  /** Chrome site access to the service origin was withheld or declined. */
  "site-access-needed",
  /** The request needs a different connection state; `state` says which one exists. */
  "wrong-state",
  "unreachable",
  "unexpected-response",
  "rate-limited",
  "code-mismatch",
  "pairing-expired",
]);

export const serviceResponseSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    state: serviceStateSchema,
    /** Set by `service.disconnect`: whether the service confirmed the revocation. */
    revoked: v.optional(v.boolean()),
  }),
  v.strictObject({
    ok: v.literal(false),
    error: serviceErrorCodeSchema,
    state: v.optional(serviceStateSchema),
  }),
]);

export type ServiceState = v.InferOutput<typeof serviceStateSchema>;
export type ServiceRequest = v.InferOutput<typeof serviceRequestSchema>;
export type ServiceErrorCode = v.InferOutput<typeof serviceErrorCodeSchema>;
export type ServiceResponse = v.InferOutput<typeof serviceResponseSchema>;

export function parseServiceResponse(value: unknown): ServiceResponse {
  return v.parse(serviceResponseSchema, value);
}
