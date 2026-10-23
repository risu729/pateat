// Collects the diagnostics summary in the service worker (ADR 0019). Every field is a
// version, state, count, time or reason code; values, names, emails and hosts stay here.
import type { VaultSyncEntry } from "../connections/auto-sync";
import type { BitwardenProfile } from "@pateat/bitwarden";
import type { LocalSettings, ServiceState } from "@pateat/contracts";
import * as v from "valibot";
import type { SetupReply } from "../connections/types";
import type { DeviceStateResult } from "../service/transport";
import type { VaultEntry, VaultResult } from "../vault/record";
import type { VaultTimeoutSetting } from "../vault/timeout";
import type { LogSummary, RecentLog } from "./log";
import type { Pseudonyms } from "./pseudonym";
import {
  age,
  deviceFailureLabel,
  formatHours,
  generationLabel,
  plural,
  problemCounts,
  serverLabel,
  syncKeyKept,
  syncSignIn,
} from "./labels";
import type {
  DiagnosticsCheck,
  DiagnosticsConnection,
  DiagnosticsResponse,
  DiagnosticsStatus,
} from "./wire";

import { CLOCK_SKEW_WARNING_MS, RECIPE_SYNC_OVERDUE_MS } from "./limits";
export { CLOCK_SKEW_WARNING_MS, RECIPE_SYNC_OVERDUE_MS } from "./limits";

export const HEALTH_TIMEOUT_MS = 5_000;
/** A stalled store read must not leave the page collecting forever. */
export const DIAGNOSTICS_TIMEOUT_MS = 15_000;

export type ServerConfigResult =
  | { ok: true; data: { version: string; kind: "bitwarden" | "vaultwarden" | "third-party" } }
  | { ok: false; error: { code: string; status?: number } };

type StatusConnection = Extract<SetupReply, { kind: "status" }>["connections"][number];

export type DiagnosticsDependencies = {
  build: DiagnosticsStatus["build"];
  now?: () => number;
  pseudonym: Pseudonyms;
  platform(): Promise<{ os: string; arch: string }>;
  permissions(): Promise<{ permissions?: string[]; origins?: string[] }>;
  /** The manifest's own host patterns; any other granted origin is only counted. */
  declaredOrigins: readonly string[];
  /** Whether the install-time `https://*\/*` and `http://*\/*` access is still granted. */
  hasAllSiteAccess(): Promise<boolean>;
  connections: {
    status(): Promise<SetupReply>;
    read(connectionId: string): Promise<VaultResult<VaultEntry | null> | undefined>;
    /** The provider's public `/config`, only with the provider permission sync uses. */
    server(connectionId: string): Promise<ServerConfigResult | undefined>;
    /** The automatic check's record (ADR 0025); no revision value leaves it. */
    check(connectionId: string): Promise<VaultSyncEntry | undefined>;
  };
  cryptoHost(): { ready: boolean; sessions: number };
  /** The toolbar icon's own rule (`actionIconState`). */
  actionIcon(): Promise<"unlocked" | "locked">;
  /** This device's vault timeout (ADR 0075). */
  vaultTimeout?(): Promise<VaultTimeoutSetting>;
  serviceState(): Promise<ServiceState | undefined>;
  /** Only the paired origin is read, for its site access and health. */
  serviceOrigin(): Promise<string | undefined>;
  hasSiteAccess(origin: string): Promise<boolean>;
  /** `GET /v1/device` with the paired credential, only for that origin; nothing if unpaired. */
  serviceDevice(origin: string): Promise<DeviceStateResult | undefined>;
  fetch: typeof fetch;
  settings(): Promise<LocalSettings>;
  logs(): Promise<LogSummary>;
  recentLog(): Promise<RecentLog>;
  storage: {
    localBytes(): Promise<number>;
    recipeCache(): Promise<unknown>;
    recipeSchedule(): Promise<unknown>;
    settingsBase(): Promise<unknown>;
    settingsHold(): Promise<unknown>;
  };
};

function environment(
  profile: BitwardenProfile["environment"],
): DiagnosticsConnection["environment"] {
  return profile.kind === "cloud" ? `cloud-${profile.region}` : "self-hosted";
}

const cipherSchema = v.looseObject({
  type: v.number(),
  deletedDate: v.optional(v.unknown()),
  login: v.optional(
    v.nullable(
      v.looseObject({
        totp: v.optional(v.unknown()),
        fido2Credentials: v.optional(v.nullable(v.array(v.unknown()))),
      }),
    ),
  ),
});
const preparedSchema = v.looseObject({
  ciphers: v.array(v.unknown()),
  unavailableItems: v.optional(v.array(v.unknown())),
  kdf: v.optional(v.unknown()),
});
const kdfSchema = v.union([
  v.strictObject({ pBKDF2: v.strictObject({ iterations: v.number() }) }),
  v.strictObject({
    argon2id: v.strictObject({
      iterations: v.number(),
      memory: v.number(),
      parallelism: v.number(),
    }),
  }),
]);

/** Counts from the stored, still encrypted record: types and presence, never contents. */
function itemCounts(prepared: unknown): DiagnosticsConnection["items"] {
  const parsed = v.safeParse(preparedSchema, prepared);
  if (!parsed.success) return undefined;
  const items = { total: 0, login: 0, totp: 0, passkey: 0, unsupported: 0 };
  for (const entry of parsed.output.ciphers) {
    const cipher = v.safeParse(cipherSchema, entry);
    // Items in the trash are not offered for login.
    if (cipher.success && cipher.output.deletedDate) continue;
    items.total += 1;
    if (!cipher.success) continue;
    // CipherType.Login is 1 in the Bitwarden SDK.
    if (cipher.output.type === 1) items.login += 1;
    if (cipher.output.login?.totp) items.totp += 1;
    if (cipher.output.login?.fido2Credentials?.length) items.passkey += 1;
  }
  // Unsupported items are not among the ciphers; they are counted beside the total.
  items.unsupported = parsed.output.unavailableItems?.length ?? 0;
  return items;
}

function unlockKdf(
  prepared: unknown,
): Pick<DiagnosticsConnection, "kdfType" | "unlockKdf"> | undefined {
  const parsed = v.safeParse(v.looseObject({ kdf: kdfSchema }), prepared);
  if (!parsed.success) return undefined;
  const { kdf } = parsed.output;
  return "pBKDF2" in kdf
    ? { kdfType: "PBKDF2", unlockKdf: `PBKDF2-SHA256 ${kdf.pBKDF2.iterations}` }
    : {
        kdfType: "Argon2id",
        unlockKdf: `Argon2id m=${kdf.argon2id.memory} MiB t=${kdf.argon2id.iterations} p=${kdf.argon2id.parallelism}`,
      };
}

const serverErrorSchema = v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/u));

/** Reads the server config for an enabled connection; a disabled one sends nothing. */
async function serverConfig(
  deps: DiagnosticsDependencies,
  status: StatusConnection,
): Promise<DiagnosticsConnection["server"]> {
  if (status.state === "disabled") return undefined;
  const result = await deps.connections.server(status.connectionId).catch(() => undefined);
  if (!result) return { ok: false, error: "unavailable" };
  if (result.ok) return { ok: true, version: result.data.version, kind: result.data.kind };
  const { code, status: httpStatus } = result.error;
  return {
    ok: false,
    error:
      code === "provider-permission-required"
        ? "no-site-access"
        : v.is(serverErrorSchema, code)
          ? code
          : "unavailable",
    ...(httpStatus === undefined ? {} : { status: httpStatus }),
  };
}

async function connection(
  deps: DiagnosticsDependencies,
  status: StatusConnection,
  server: DiagnosticsConnection["server"],
): Promise<DiagnosticsConnection> {
  const id = `bitwarden:${await deps.pseudonym("connection", status.connectionId, 6)}`;
  const record = await deps.connections.read(status.connectionId).catch(() => undefined);
  const accepted = record?.ok ? record.data?.accepted : undefined;
  // Owner-approved: item counts only while the vault is unlocked in this worker.
  const items = accepted && status.state === "ready" ? itemCounts(accepted.prepared) : undefined;
  const kdf = accepted ? unlockKdf(accepted.prepared) : undefined;
  const check = await deps.connections.check(status.connectionId).catch(() => undefined);
  return {
    id,
    environment: environment(status.environment),
    state: status.state,
    autoUnlock: status.autoUnlock,
    providerSession: status.providerSession,
    ...(record && !record.ok ? { storageError: record.error.code } : {}),
    ...(accepted ? { acceptedAt: accepted.acceptedAt } : {}),
    ...(items ? { items } : {}),
    ...kdf,
    ...(server ? { server } : {}),
    ...(check?.checkedAt === undefined ? {} : { checkedAt: check.checkedAt }),
    ...(check?.outcome === undefined ? {} : { checkOutcome: check.outcome }),
    ...(check?.retryAt === undefined ? {} : { nextCheckAt: check.retryAt }),
  };
}

/** A commit or `development`; anything else, such as a host name, is refused. */
const revisionSchema = v.pipe(v.string(), v.regex(/^[0-9A-Za-z._-]{1,64}$/u));
const healthBodySchema = v.looseObject({
  status: v.literal("ok"),
  service: v.literal("pateat-api"),
  revision: revisionSchema,
});

/** One `GET /health`; the Date header gives the clock difference at the request midpoint. */
async function health(
  deps: DiagnosticsDependencies,
  origin: string,
  now: () => number,
): Promise<NonNullable<DiagnosticsStatus["service"]["health"]>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const started = now();
    let response: Response;
    try {
      response = await deps.fetch(new URL("/health", origin), {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return { ok: false, error: "network" };
    }
    const ended = now();
    if (!response.ok) return { ok: false, error: "status", status: response.status };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: "invalid-response" };
    }
    const parsed = v.safeParse(healthBodySchema, body);
    if (!parsed.success) return { ok: false, error: "invalid-response" };
    // An HTTP date (`Tue, 13 Oct 2026 14:00:34 GMT`) is not ISO 8601, which is all
    // Temporal reads, so Date.parse reads it.
    const date = Date.parse(response.headers.get("Date") ?? "");
    return {
      ok: true,
      revision: parsed.output.revision,
      ...(Number.isFinite(date) ? { skewMs: date - (started + ended) / 2 } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The service's own counts for this device's owner; it never rejects. */
async function device(
  deps: DiagnosticsDependencies,
  origin: string,
): Promise<DiagnosticsStatus["service"]["device"]> {
  let result: DeviceStateResult | undefined;
  try {
    result = await deps.serviceDevice(origin);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!result) return undefined;
  if (result.kind === "rejected") return { ok: false, error: "rejected" };
  if (result.kind === "failed") return { ok: false, error: result.error };
  const { pairedAt, recipes, settingsRevision, generation } = result.state;
  return { ok: true, pairedAt, recipes, settingsRevision, generation };
}

const recipeCacheSchema = v.looseObject({ recipes: v.array(v.unknown()) });
const scheduleSchema = v.looseObject({
  startedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  retryAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const baseSchema = v.looseObject({ revision: v.pipe(v.number(), v.integer(), v.minValue(0)) });
const holdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

async function service(
  deps: DiagnosticsDependencies,
  now: () => number,
): Promise<DiagnosticsStatus["service"]> {
  let state: ServiceState | undefined;
  try {
    state = await deps.serviceState();
  } catch {
    return { kind: "unavailable" };
  }
  if (!state || state.kind === "disconnected") return { kind: "not-configured" };
  const result: DiagnosticsStatus["service"] = {
    kind: "connected",
    ...(state.rejected ? { rejected: true } : {}),
    ...(state.cacheFull ? { cacheFull: true } : {}),
    ...(state.syncedAt === undefined ? {} : { syncedAt: state.syncedAt }),
  };
  const [cache, schedule, base, hold] = await Promise.all([
    deps.storage.recipeCache().catch(() => undefined),
    deps.storage.recipeSchedule().catch(() => undefined),
    deps.storage.settingsBase().catch(() => undefined),
    deps.storage.settingsHold().catch(() => undefined),
  ]);
  const recipes = v.safeParse(recipeCacheSchema, cache);
  if (recipes.success)
    result.recipes = {
      count: recipes.output.recipes.length,
      bytes: new TextEncoder().encode(JSON.stringify(cache)).byteLength,
    };
  const next = v.safeParse(scheduleSchema, schedule);
  // Sync treats a schedule that started after now, as after a clock change, as due now.
  if (next.success) {
    const at = now();
    result.nextSyncAt = next.output.startedAt <= at ? next.output.retryAt : at;
  }
  const revision = v.safeParse(baseSchema, base);
  if (revision.success) result.settingsRevision = revision.output.revision;
  const since = v.safeParse(holdSchema, hold);
  if (since.success) result.holdSince = since.output;
  const origin = await deps.serviceOrigin().catch(() => undefined);
  if (origin) {
    const access = await deps.hasSiteAccess(origin).catch(() => false);
    result.siteAccess = access;
    if (access) {
      // A rejected credential is not sent again.
      const [checked, record] = await Promise.all([
        health(deps, origin, now),
        state.rejected ? undefined : device(deps, origin),
      ]);
      result.health = checked;
      if (record) result.device = record;
    } else result.health = { ok: false, error: "no-site-access" };
  }
  return result;
}

function connectionChecks(item: DiagnosticsConnection, now: number): DiagnosticsCheck[] {
  const vault: DiagnosticsCheck = item.storageError
    ? { id: `vault:${item.id}`, level: "error", detail: `${item.id} ${item.storageError}` }
    : item.state === "review-required" || item.state === "unavailable"
      ? { id: `vault:${item.id}`, level: "warn", detail: `${item.id} ${item.state}` }
      : item.state === "disabled" || item.state === "locked"
        ? { id: `vault:${item.id}`, level: "info", detail: `${item.id} ${item.state}` }
        : { id: `vault:${item.id}`, level: "ok", detail: `${item.id} vault cache ${item.state}` };
  // Sync needs the vault's key, so an expired token renews only while it is kept.
  const session: DiagnosticsCheck =
    item.providerSession === "active" ||
    (item.providerSession === "refresh-required" && syncKeyKept(item))
      ? {
          id: `sync:${item.id}`,
          level: "ok",
          detail: `${item.id} ${syncSignIn(item.providerSession)}`,
        }
      : item.state === "disabled"
        ? { id: `sync:${item.id}`, level: "info", detail: `${item.id} sync sign-in not used` }
        : item.providerSession === "refresh-required"
          ? {
              id: `sync:${item.id}`,
              level: "info",
              detail: `${item.id} ${syncSignIn(item.providerSession)}; Sync needs the vault unlocked`,
            }
          : {
              id: `sync:${item.id}`,
              level: "warn",
              detail: `${item.id} ${syncSignIn(item.providerSession)}`,
            };
  // An unchanged vault keeps its copy, so its age alone is not a fault; the last check is.
  const checked =
    item.checkedAt === undefined
      ? ""
      : `; checked ${age(Math.max(0, now - item.checkedAt))} ago${item.checkOutcome ? `: ${item.checkOutcome}` : ""}`;
  const failing =
    item.checkOutcome === "failed" ||
    item.checkOutcome === "rate-limited" ||
    item.checkOutcome === "reauthentication-required" ||
    item.checkOutcome === "account-deleted";
  const synced: DiagnosticsCheck[] =
    item.acceptedAt === undefined
      ? []
      : [
          {
            id: `vault-age:${item.id}`,
            level: failing ? "warn" : "info",
            detail: `${item.id} vault synced ${age(now - item.acceptedAt)} ago${checked}`,
          },
        ];
  const server: DiagnosticsCheck[] = item.server
    ? [
        {
          id: `server:${item.id}`,
          level: item.server.ok ? "ok" : "warn",
          detail: `${item.id} ${serverLabel(item.server)}`,
        },
      ]
    : [];
  return [vault, session, ...synced, ...server];
}

/** Recipe generation, and whether this device's copy has caught up with the service. */
function deviceChecks(value: DiagnosticsStatus["service"]): DiagnosticsCheck[] {
  const { device: record } = value;
  if (!record) return [];
  if (!record.ok)
    return [{ id: "service-record", level: "warn", detail: deviceFailureLabel(record.error) }];
  // Each differs until the next sync, so a difference is information, not a fault.
  const differences: string[] = [];
  // A full cache holds only part of the recipes by design; its own check reports it.
  if (value.recipes && !value.cacheFull && value.recipes.count !== record.recipes)
    differences.push(`service ${plural(record.recipes, "recipe")}, cached ${value.recipes.count}`);
  // No stored base means settings never synced, which matches revision 0.
  const local = value.settingsRevision ?? 0;
  if (local !== record.settingsRevision)
    differences.push(`settings revision service ${record.settingsRevision}, here ${local}`);
  return [
    {
      id: "generation",
      level:
        record.generation === "ok"
          ? "ok"
          : record.generation === "credentials-not-configured"
            ? "info"
            : "warn",
      detail: generationLabel(record.generation),
    },
    differences.length
      ? {
          id: "service-copy",
          level: "info",
          detail: differences.join("; "),
        }
      : { id: "service-copy", level: "ok", detail: "recipes and settings match the service" },
  ];
}

function serviceChecks(value: DiagnosticsStatus["service"], now: number): DiagnosticsCheck[] {
  if (value.kind === "not-configured")
    return [{ id: "service", level: "info", detail: "Pateat service not paired" }];
  if (value.kind === "unavailable")
    return [{ id: "service", level: "error", detail: "service record unreadable" }];
  const checks: DiagnosticsCheck[] = [];
  const { health: result } = value;
  if (value.rejected)
    checks.push({ id: "service", level: "error", detail: "service rejected this device (401)" });
  else if (!result || result.ok)
    checks.push({ id: "service", level: "ok", detail: "Pateat service reachable" });
  else
    checks.push({
      id: "service",
      level: "error",
      detail:
        result.error === "status"
          ? `health ${result.status ?? "error"}`
          : result.error === "no-site-access"
            ? "no site access to the Pateat service"
            : `health ${result.error}`,
    });
  if (value.cacheFull)
    checks.push({ id: "recipe-cache", level: "warn", detail: "recipe cache full" });
  if (result?.ok && result.skewMs !== undefined) {
    const seconds = Math.round(Math.abs(result.skewMs) / 1000);
    checks.push(
      Math.abs(result.skewMs) > CLOCK_SKEW_WARNING_MS
        ? {
            id: "clock",
            level: "warn",
            detail: `clock ${seconds} s ${result.skewMs > 0 ? "behind" : "ahead of"} the service`,
          }
        : { id: "clock", level: "ok", detail: `clock within ${CLOCK_SKEW_WARNING_MS / 1000} s` },
    );
  }
  checks.push(...deviceChecks(value));
  if (value.syncedAt === undefined)
    checks.push({ id: "recipe-sync", level: "warn", detail: "recipes not synced yet" });
  else if (now - value.syncedAt > RECIPE_SYNC_OVERDUE_MS)
    checks.push({
      id: "recipe-sync",
      level: "warn",
      detail: `recipe sync overdue by ${formatHours(Math.floor(Temporal.Duration.from({ milliseconds: now - value.syncedAt - RECIPE_SYNC_OVERDUE_MS }).total("hours")))}`,
    });
  else checks.push({ id: "recipe-sync", level: "ok", detail: "recipes synced in the last 24 h" });
  return checks;
}

export async function collectDiagnostics(
  deps: DiagnosticsDependencies,
): Promise<DiagnosticsStatus> {
  const now = deps.now ?? Date.now;
  const [
    platform,
    permissions,
    siteAccess,
    setup,
    settings,
    localBytes,
    logs,
    recent,
    vaultTimeout,
  ] = await Promise.all([
    deps.platform().catch(() => ({ os: "unknown", arch: "unknown" })),
    deps.permissions().catch((): { permissions?: string[]; origins?: string[] } => ({})),
    deps.hasAllSiteAccess().catch(() => false),
    deps.connections.status().catch(() => undefined),
    deps.settings().catch(() => undefined),
    deps.storage.localBytes().catch(() => undefined),
    deps.logs().catch(() => undefined),
    deps.recentLog().catch(() => undefined),
    deps.vaultTimeout?.().catch(() => undefined),
  ]);
  const listed = setup?.ok && setup.kind === "status" ? setup.connections : [];
  // Network reads run together; each has its own timeout. Neither promise may reject,
  // since a failing store read below would leave them unawaited.
  const servers = listed.map((entry) => serverConfig(deps, entry));
  const pendingService = service(deps, now);
  const connections: DiagnosticsConnection[] = [];
  // Sequential native-store reads, as the setup status does.
  for (const [index, entry] of listed.entries())
    // eslint-disable-next-line no-await-in-loop
    connections.push(await connection(deps, entry, await servers[index]));
  const serviceStatus = await pendingService;
  const host = deps.cryptoHost();
  const collectedAt = now();
  const checks: DiagnosticsCheck[] = [
    siteAccess
      ? { id: "site-access", level: "ok", detail: "https://*/* and http://*/* site access granted" }
      : {
          id: "site-access",
          level: "error",
          detail: "https://*/* or http://*/* site access withheld",
        },
    host.ready
      ? { id: "crypto-host", level: "ok", detail: "crypto host ready" }
      : { id: "crypto-host", level: "info", detail: "crypto host idle (starts on demand)" },
    ...(setup?.ok
      ? []
      : [{ id: "connections", level: "error", detail: "connections unreadable" } as const]),
    ...connections.flatMap((item) => connectionChecks(item, collectedAt)),
    ...serviceChecks(serviceStatus, collectedAt),
    !logs
      ? { id: "logs", level: "error", detail: "logs unreadable" }
      : logs.recentErrors + logs.recentWarnings > 0
        ? {
            id: "logs",
            level: logs.recentErrors > 0 ? "warn" : "info",
            detail: `${problemCounts(logs)} logged in the last 24 h`,
          }
        : { id: "logs", level: "ok", detail: "no errors or warnings logged in the last 24 h" },
  ];
  return {
    version: 1,
    collectedAt,
    build: deps.build,
    platform,
    permissions: {
      permissions: (permissions.permissions ?? []).slice(0, 32),
      origins: (permissions.origins ?? [])
        .filter((origin) => deps.declaredOrigins.includes(origin))
        .slice(0, 32),
      otherOrigins: (permissions.origins ?? []).filter(
        (origin) => !deps.declaredOrigins.includes(origin),
      ).length,
    },
    // Unlocked only when every configured connection auto-unlocks, as the toolbar icon shows.
    actionIcon: await deps.actionIcon().catch(() => "locked" as const),
    ...(vaultTimeout ? { vaultTimeout } : {}),
    cryptoHost: { ready: host.ready, sessions: host.sessions },
    connections,
    service: serviceStatus,
    ...(settings
      ? {
          settings: {
            excludedSites: settings.excludedSites.length,
            siteDefaults: settings.siteDefaults.length,
            bindings: settings.bindings.length,
            passkeyBrowserSites: settings.passkeyBrowserSites.length,
          },
        }
      : {}),
    storage: localBytes === undefined ? {} : { localBytes },
    ...(logs ? { logs } : {}),
    ...(recent ? { recent } : {}),
    checks,
  };
}

/** Never rejects: a failure becomes `unavailable`, so the page shows it instead of hanging. */
export function createDiagnosticsHandler(deps: DiagnosticsDependencies) {
  return (): Promise<DiagnosticsResponse> =>
    new Promise<DiagnosticsResponse>((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: "unavailable" }),
        DIAGNOSTICS_TIMEOUT_MS,
      );
      void collectDiagnostics(deps)
        .then(
          (status): DiagnosticsResponse => ({ ok: true, status }),
          (): DiagnosticsResponse => ({ ok: false, error: "unavailable" }),
        )
        .then((response) => {
          clearTimeout(timer);
          resolve(response);
          return undefined;
        });
    });
}
