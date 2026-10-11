// Collects the diagnostics summary in the service worker (ADR 0019). Every field is a
// version, state, count, time or reason code; values, names, emails and hosts stay here.
import type { BitwardenProfile } from "@pateat/bitwarden";
import type { LocalSettings, ServiceState } from "@pateat/contracts";
import * as v from "valibot";
import type { SetupReply } from "../connections/types";
import type { VaultEntry, VaultResult } from "../vault/record";
import type { LogSummary } from "./log";
import type { Pseudonyms } from "./pseudonym";
import { age, syncSignIn } from "./labels";
import type {
  DiagnosticsCheck,
  DiagnosticsConnection,
  DiagnosticsResponse,
  DiagnosticsStatus,
} from "./wire";

/** A clock further off than one TOTP step makes generated codes fail. */
export const CLOCK_SKEW_WARNING_MS = 30_000;
/** Recipe sync normally runs every few minutes while the browser is in use. */
export const RECIPE_SYNC_OVERDUE_MS = 24 * 60 * 60 * 1000;
export const HEALTH_TIMEOUT_MS = 5_000;
/** A stalled store read must not leave the page collecting forever. */
export const DIAGNOSTICS_TIMEOUT_MS = 15_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

type StatusConnection = Extract<SetupReply, { kind: "status" }>["connections"][number];

export type DiagnosticsDependencies = {
  build: DiagnosticsStatus["build"];
  now?: () => number;
  pseudonym: Pseudonyms;
  platform(): Promise<{ os: string; arch: string }>;
  permissions(): Promise<{ permissions?: string[]; origins?: string[] }>;
  /** The manifest's own host patterns; any other granted origin is only counted. */
  declaredOrigins: readonly string[];
  /** Whether the install-time `https://*\/*` access is still granted. */
  hasAllSiteAccess(): Promise<boolean>;
  connections: {
    status(): Promise<SetupReply>;
    read(connectionId: string): Promise<VaultResult<VaultEntry | null> | undefined>;
  };
  cryptoHost(): { ready: boolean; sessions: number };
  /** The toolbar icon's own rule (`actionIconState`). */
  actionIcon(): Promise<"unlocked" | "locked">;
  serviceState(): Promise<ServiceState | undefined>;
  /** Only the paired origin is read, for its site access and health. */
  serviceOrigin(): Promise<string | undefined>;
  hasSiteAccess(origin: string): Promise<boolean>;
  fetch: typeof fetch;
  settings(): Promise<LocalSettings>;
  logs(): Promise<LogSummary>;
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

function unlockKdf(prepared: unknown): string | undefined {
  const parsed = v.safeParse(v.looseObject({ kdf: kdfSchema }), prepared);
  if (!parsed.success) return undefined;
  const { kdf } = parsed.output;
  return "pBKDF2" in kdf
    ? `PBKDF2-SHA256 ${kdf.pBKDF2.iterations}`
    : `Argon2id m=${kdf.argon2id.memory} MiB t=${kdf.argon2id.iterations} p=${kdf.argon2id.parallelism}`;
}

async function connection(
  deps: DiagnosticsDependencies,
  status: StatusConnection,
): Promise<DiagnosticsConnection> {
  const id = `bitwarden:${await deps.pseudonym("connection", status.connectionId, 6)}`;
  const record = await deps.connections.read(status.connectionId).catch(() => undefined);
  const accepted = record?.ok ? record.data?.accepted : undefined;
  // Owner-approved: item counts only while the vault is unlocked in this worker.
  const items = accepted && status.state === "ready" ? itemCounts(accepted.prepared) : undefined;
  const kdf = accepted ? unlockKdf(accepted.prepared) : undefined;
  return {
    id,
    environment: environment(status.environment),
    state: status.state,
    autoUnlock: status.autoUnlock,
    providerSession: status.providerSession,
    ...(record && !record.ok ? { storageError: record.error.code } : {}),
    ...(accepted ? { acceptedAt: accepted.acceptedAt } : {}),
    ...(items ? { items } : {}),
    ...(kdf ? { unlockKdf: kdf } : {}),
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

const recipeCacheSchema = v.looseObject({ recipes: v.array(v.unknown()) });
const scheduleSchema = v.looseObject({ retryAt: v.pipe(v.number(), v.integer(), v.minValue(0)) });
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
  if (state.kind === "pairing") return { kind: "pairing" };
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
  if (next.success) result.nextSyncAt = next.output.retryAt;
  const revision = v.safeParse(baseSchema, base);
  if (revision.success) result.settingsRevision = revision.output.revision;
  const since = v.safeParse(holdSchema, hold);
  if (since.success) result.holdSince = since.output;
  const origin = await deps.serviceOrigin().catch(() => undefined);
  if (origin) {
    const access = await deps.hasSiteAccess(origin).catch(() => false);
    result.siteAccess = access;
    result.health = access
      ? await health(deps, origin, now)
      : { ok: false, error: "no-site-access" };
  }
  return result;
}

function connectionChecks(item: DiagnosticsConnection, now: number): DiagnosticsCheck[] {
  const vault: DiagnosticsCheck = item.storageError
    ? { id: `vault:${item.id}`, level: "error", detail: `${item.id} ${item.storageError}` }
    : item.state === "review-required" || item.state === "unavailable"
      ? { id: `vault:${item.id}`, level: "warn", detail: `${item.id} ${item.state}` }
      : item.state === "disabled"
        ? { id: `vault:${item.id}`, level: "info", detail: `${item.id} disabled` }
        : { id: `vault:${item.id}`, level: "ok", detail: `${item.id} vault cache ${item.state}` };
  // Sync needs the stored unlock key, so an expired token renews only with auto-unlock on.
  const session: DiagnosticsCheck =
    item.providerSession === "active" ||
    (item.providerSession === "refresh-required" && item.autoUnlock === "enabled")
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
              detail: `${item.id} ${syncSignIn(item.providerSession)}, Sync needs auto-unlock (auto-unlock ${item.autoUnlock})`,
            }
          : {
              id: `sync:${item.id}`,
              level: "warn",
              detail: `${item.id} ${syncSignIn(item.providerSession)}`,
            };
  // The vault syncs only from the settings page, so an old copy is expected, not a fault.
  const synced: DiagnosticsCheck[] =
    item.acceptedAt === undefined
      ? []
      : [
          {
            id: `vault-age:${item.id}`,
            level: "info",
            detail: `${item.id} vault synced ${age(now - item.acceptedAt)} ago (Sync from settings only)`,
          },
        ];
  return [vault, session, ...synced];
}

function serviceChecks(value: DiagnosticsStatus["service"], now: number): DiagnosticsCheck[] {
  if (value.kind === "not-configured")
    return [{ id: "service", level: "info", detail: "Pateat service not paired" }];
  if (value.kind === "pairing")
    return [{ id: "service", level: "info", detail: "Pateat service pairing in progress" }];
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
  if (value.syncedAt === undefined)
    checks.push({ id: "recipe-sync", level: "warn", detail: "recipes not synced yet" });
  else if (now - value.syncedAt > RECIPE_SYNC_OVERDUE_MS)
    checks.push({
      id: "recipe-sync",
      level: "warn",
      detail: `recipe sync overdue by ${Math.floor((now - value.syncedAt - RECIPE_SYNC_OVERDUE_MS) / HOUR_MS)} h`,
    });
  else checks.push({ id: "recipe-sync", level: "ok", detail: "recipes synced in the last 24 h" });
  return checks;
}

export async function collectDiagnostics(
  deps: DiagnosticsDependencies,
): Promise<DiagnosticsStatus> {
  const now = deps.now ?? Date.now;
  const [platform, permissions, siteAccess, setup, settings, localBytes, logs] = await Promise.all([
    deps.platform().catch(() => ({ os: "unknown", arch: "unknown" })),
    deps.permissions().catch((): { permissions?: string[]; origins?: string[] } => ({})),
    deps.hasAllSiteAccess().catch(() => false),
    deps.connections.status().catch(() => undefined),
    deps.settings().catch(() => undefined),
    deps.storage.localBytes().catch(() => undefined),
    deps.logs().catch(() => undefined),
  ]);
  const listed = setup?.ok && setup.kind === "status" ? setup.connections : [];
  const connections: DiagnosticsConnection[] = [];
  // Sequential native-store reads, as the setup status does.
  for (const entry of listed)
    // eslint-disable-next-line no-await-in-loop
    connections.push(await connection(deps, entry));
  const serviceStatus = await service(deps, now);
  const host = deps.cryptoHost();
  const collectedAt = now();
  const checks: DiagnosticsCheck[] = [
    siteAccess
      ? { id: "site-access", level: "ok", detail: "https://*/* site access granted" }
      : { id: "site-access", level: "error", detail: "https://*/* site access withheld" },
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
      : logs.recentErrors > 0
        ? {
            id: "logs",
            level: "warn",
            detail: `${logs.recentErrors} errors logged in the last 24 h`,
          }
        : { id: "logs", level: "ok", detail: "no errors logged in the last 24 h" },
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
    cryptoHost: { ready: host.ready, sessions: host.sessions },
    connections,
    service: serviceStatus,
    ...(settings
      ? {
          settings: {
            excludedSites: settings.excludedSites.length,
            siteDefaults: settings.siteDefaults.length,
            bindings: settings.bindings.length,
          },
        }
      : {}),
    storage: localBytes === undefined ? {} : { localBytes },
    ...(logs ? { logs } : {}),
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
