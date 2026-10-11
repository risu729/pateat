// The diagnostics page receives this summary from the service worker (ADR 0019). It holds
// versions, states, counts and reason codes only: no value, name, email, URL or host.
import * as v from "valibot";

export const DIAGNOSTICS_STATUS_REQUEST = { version: 1, type: "diagnostics.status" } as const;
export const diagnosticsRequestSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("diagnostics.status"),
});

const time = v.pipe(v.number(), v.integer(), v.minValue(0));
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const code = v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/u));
const label = v.pipe(v.string(), v.maxLength(128));

export const checkSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9:-]{1,64}$/u)),
  level: v.picklist(["ok", "info", "warn", "error"]),
  detail: label,
});
export type DiagnosticsCheck = v.InferOutput<typeof checkSchema>;

const connectionSchema = v.strictObject({
  /** An HMAC pseudonym of the connection ID, such as `bitwarden:5c1e9a`. */
  id: v.pipe(v.string(), v.regex(/^bitwarden:[0-9a-f]{6}$/u)),
  environment: v.picklist(["cloud-us", "cloud-eu", "self-hosted"]),
  state: v.picklist(["configured", "ready", "disabled", "review-required", "unavailable"]),
  autoUnlock: v.picklist(["enabled", "disabled", "unknown"]),
  providerSession: v.picklist([
    "none",
    "active",
    "refresh-required",
    "reauthentication-required",
    "unavailable",
  ]),
  /** The vault record's read failure, when it could not be read. */
  storageError: v.optional(code),
  acceptedAt: v.optional(time),
  items: v.optional(
    v.strictObject({
      total: count,
      login: count,
      totp: count,
      passkey: count,
      unsupported: count,
    }),
  ),
  /** Shown on the page only; never copied into a bug report. */
  unlockKdf: v.optional(label),
});
export type DiagnosticsConnection = v.InferOutput<typeof connectionSchema>;

const healthSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    revision: v.pipe(v.string(), v.regex(/^[0-9A-Za-z._-]{1,64}$/u)),
    /** Service `Date` minus the local clock at the request midpoint. */
    skewMs: v.optional(v.number()),
  }),
  v.strictObject({
    ok: v.literal(false),
    error: v.picklist(["no-site-access", "network", "status", "invalid-response"]),
    status: v.optional(count),
  }),
]);

const serviceSchema = v.strictObject({
  kind: v.picklist(["not-configured", "pairing", "connected", "unavailable"]),
  rejected: v.optional(v.literal(true)),
  cacheFull: v.optional(v.literal(true)),
  siteAccess: v.optional(v.boolean()),
  syncedAt: v.optional(time),
  settingsRevision: v.optional(count),
  holdSince: v.optional(time),
  recipes: v.optional(v.strictObject({ count, bytes: count })),
  nextSyncAt: v.optional(time),
  health: v.optional(healthSchema),
});

export const diagnosticsStatusSchema = v.strictObject({
  version: v.literal(1),
  collectedAt: time,
  build: v.strictObject({
    version: label,
    revision: label,
    mode: label,
    bitwardenSdk: label,
    bitwardenProtocol: label,
  }),
  platform: v.strictObject({ os: label, arch: label }),
  permissions: v.strictObject({
    permissions: v.pipe(v.array(label), v.maxLength(32)),
    /** Only patterns the manifest declares; granted hosts are counted, never named. */
    origins: v.pipe(v.array(label), v.maxLength(32)),
    otherOrigins: count,
  }),
  actionIcon: v.picklist(["unlocked", "locked"]),
  cryptoHost: v.strictObject({ ready: v.boolean(), sessions: count }),
  connections: v.pipe(v.array(connectionSchema), v.maxLength(64)),
  service: serviceSchema,
  settings: v.optional(
    v.strictObject({ excludedSites: count, siteDefaults: count, bindings: count }),
  ),
  storage: v.strictObject({ localBytes: v.optional(count) }),
  checks: v.pipe(v.array(checkSchema), v.maxLength(64)),
});
export type DiagnosticsStatus = v.InferOutput<typeof diagnosticsStatusSchema>;

export type DiagnosticsResponse =
  | { ok: true; status: DiagnosticsStatus }
  | { ok: false; error: "unavailable" };

export function parseDiagnosticsResponse(value: unknown): DiagnosticsResponse {
  return v.parse(
    v.variant("ok", [
      v.strictObject({ ok: v.literal(true), status: diagnosticsStatusSchema }),
      v.strictObject({ ok: v.literal(false), error: v.literal("unavailable") }),
    ]),
    value,
  );
}
