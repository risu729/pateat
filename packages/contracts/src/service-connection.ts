import * as v from "valibot";
import { deviceIdSchema, deviceLabelSchema, profileIdSchema, profileSchema } from "./pairing";
import { normalizeHostname, parseSiteUrl } from "./settings";

// Options page ↔ background contracts for the optional sync service connection.
// The device credential stays in the background; it never crosses here (ADR 0020).

/** An exact HTTPS origin such as `https://pateat.example.com`, without a path. */
export const serviceOriginSchema = v.pipe(
  v.string(),
  v.maxLength(300),
  v.check((value) => {
    const url = parseSiteUrl(value);
    return (
      url?.protocol === "https:" &&
      url.origin === value &&
      // A trailing dot names another host to the browser, with its own cookies.
      normalizeHostname(url.hostname) === url.hostname
    );
  }, "Use an exact HTTPS origin"),
);

/** Parses what a person types, accepting a trailing slash and a host's trailing dot. */
export function normalizeServiceOrigin(input: string): string | undefined {
  const url = parseSiteUrl(input.trim());
  if (!url || url.pathname !== "/" || url.search || url.hash) return undefined;
  url.hostname = url.hostname.replace(/\.$/u, "");
  return v.safeParse(serviceOriginSchema, url.origin).success ? url.origin : undefined;
}

const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0));

export const serviceStateSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("disconnected") }),
  v.strictObject({
    kind: v.literal("connected"),
    origin: serviceOriginSchema,
    label: deviceLabelSchema,
    deviceId: deviceIdSchema,
    /** When recipes last synced completely; absent before the first complete sync. */
    syncedAt: v.optional(timestamp),
    /** The service no longer accepts this device; cached recipes still apply. */
    rejected: v.optional(v.literal(true)),
    /** Recipes outgrew the local cache or settings their limits; newer changes wait. */
    cacheFull: v.optional(v.literal(true)),
  }),
]);

export const serviceRequestSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("service.get") }),
  /** The background pairs with one request carrying the browser's login session. */
  v.strictObject({
    version: v.literal(1),
    type: v.literal("service.pair"),
    profileId: v.optional(profileIdSchema),
    origin: serviceOriginSchema,
    label: deviceLabelSchema,
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("service.disconnect") }),
  /** Forgets an unreadable local record without contacting the service. */
  v.strictObject({ version: v.literal(1), type: v.literal("service.forget") }),
]);

export const serviceErrorCodeSchema = v.picklist([
  "invalid-request",
  "profile-required",
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
  /** The service needs a sign-in first; the options page opens its `/manage` page. */
  "sign-in-needed",
  /** The service verified no acceptable sign-in for this account. */
  "sign-in-rejected",
  /** The service does not list this extension's ID. */
  "extension-not-allowed",
  /** The service has no pairing configuration. */
  "pairing-unavailable",
  /** The service could not fetch the keys it checks sign-ins with; try again later. */
  "access-keys-unavailable",
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
    profiles: v.optional(v.array(profileSchema)),
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
