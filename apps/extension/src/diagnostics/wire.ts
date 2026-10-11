// The diagnostics page receives this summary from the service worker (ADR 0019). It holds
// versions, states, counts and reason codes only: no value, name, email, URL or host.
import * as v from "valibot";

export const DIAGNOSTICS_STATUS_REQUEST = { version: 1, type: "diagnostics.status" } as const;
/** The page's only requests: read the summary, export or clear the logs, or enable debug logs. */
export const diagnosticsRequestSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("diagnostics.status") }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("diagnostics.logs.export"),
    includeSites: v.boolean(),
  }),
  v.strictObject({ version: v.literal(1), type: v.literal("diagnostics.logs.clear") }),
  v.strictObject({ version: v.literal(1), type: v.literal("diagnostics.logs.debug") }),
]);
export type DiagnosticsRequest = v.InferOutput<typeof diagnosticsRequestSchema>;

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
  /** The last automatic revision check, its result and, after a 429, the next allowed one. */
  checkedAt: v.optional(time),
  checkOutcome: v.optional(
    v.picklist([
      "unchanged",
      "synced",
      "deferred",
      "rate-limited",
      "failed",
      "reauthentication-required",
      "account-deleted",
      "skipped",
    ]),
  ),
  nextCheckAt: v.optional(time),
  items: v.optional(
    v.strictObject({
      total: count,
      login: count,
      totp: count,
      passkey: count,
      unsupported: count,
    }),
  ),
  /** The KDF family, copied into bug reports; its parameters stay in `unlockKdf`. */
  kdfType: v.optional(v.picklist(["PBKDF2", "Argon2id"])),
  /** Shown on the page only; never copied into a bug report. */
  unlockKdf: v.optional(label),
  /** The provider's `GET {api}/config`; absent for a disabled connection. */
  server: v.optional(
    v.variant("ok", [
      v.strictObject({
        ok: v.literal(true),
        /** Third-party servers report the Bitwarden version they are compatible with. */
        version: v.pipe(v.string(), v.regex(/^\d{1,4}\.\d{1,2}\.\d{1,4}$/u)),
        kind: v.picklist(["bitwarden", "vaultwarden", "third-party"]),
      }),
      v.strictObject({ ok: v.literal(false), error: code, status: v.optional(count) }),
    ]),
  ),
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

/** `GET /v1/device`: the service's own record for this device and its owner. */
const deviceSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    pairedAt: time,
    recipes: count,
    settingsRevision: count,
    generation: v.picklist([
      "ok",
      "credentials-not-configured",
      "issuer-unavailable",
      "monthly-limit",
      "daily-limit",
    ]),
  }),
  v.strictObject({
    ok: v.literal(false),
    error: v.picklist([
      "rejected",
      "unreachable",
      "unexpected-response",
      "rate-limited",
      "unavailable",
    ]),
  }),
]);

const serviceSchema = v.strictObject({
  kind: v.picklist(["not-configured", "connected", "unavailable"]),
  rejected: v.optional(v.literal(true)),
  cacheFull: v.optional(v.literal(true)),
  siteAccess: v.optional(v.boolean()),
  syncedAt: v.optional(time),
  settingsRevision: v.optional(count),
  holdSince: v.optional(time),
  recipes: v.optional(v.strictObject({ count, bytes: count })),
  nextSyncAt: v.optional(time),
  health: v.optional(healthSchema),
  device: v.optional(deviceSchema),
});

/**
 * `recentLog` in `log.ts`: lines of at most `RECENT_LINE_LENGTH`, `RECENT_PROBLEMS` lines,
 * `RECENT_DELEGATION_REASONS` reasons, and its revision and code checks.
 */
export const recentLogSchema = v.strictObject({
  problems: v.pipe(v.array(v.pipe(v.string(), v.maxLength(2048))), v.maxLength(10)),
  updated: v.optional(
    v.strictObject({ time, from: v.pipe(v.string(), v.regex(/^[0-9A-Za-z._-]{1,64}$/u)) }),
  ),
  passkeyDelegations: v.pipe(
    v.array(
      v.strictObject({
        reason: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9.:-]{0,63}$/u)),
        count,
      }),
    ),
    v.maxLength(32),
  ),
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
  logs: v.optional(
    v.strictObject({
      entries: count,
      bytes: count,
      recentErrors: count,
      debugUntil: v.optional(count),
    }),
  ),
  /** The log's lines for a bug report; sites are numbered apart from the download. */
  recent: v.optional(recentLogSchema),
  /** Up to four per connection plus the build, service, recipe and log checks. */
  checks: v.pipe(v.array(checkSchema), v.maxLength(320)),
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

const unavailableSchema = v.strictObject({ ok: v.literal(false), error: v.literal("unavailable") });
const logsResponseSchemas = {
  "diagnostics.logs.export": v.variant("ok", [
    v.strictObject({ ok: v.literal(true), text: v.string() }),
    unavailableSchema,
  ]),
  "diagnostics.logs.clear": v.variant("ok", [
    v.strictObject({ ok: v.literal(true) }),
    unavailableSchema,
  ]),
  "diagnostics.logs.debug": v.variant("ok", [
    v.strictObject({ ok: v.literal(true), debugUntil: time }),
    unavailableSchema,
  ]),
};
export type LogsRequestType = keyof typeof logsResponseSchemas;
export type LogsResponse<T extends LogsRequestType> = v.InferOutput<
  (typeof logsResponseSchemas)[T]
>;

export function parseLogsResponse<T extends LogsRequestType>(
  type: T,
  value: unknown,
): LogsResponse<T> {
  return v.parse(logsResponseSchemas[type], value) as LogsResponse<T>;
}
