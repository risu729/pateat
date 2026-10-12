// Plain-language labels shared by the diagnostics page, its checks and the copied report.
// Each label that rewords a raw code keeps that code in parentheses.
import type { DiagnosticsConnection, DiagnosticsStatus } from "./wire";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const INSTALL_LABELS: Record<string, string> = {
  development: "unpacked install",
  normal: "Web Store install",
  admin: "policy install",
  sideload: "sideloaded install",
};

/** Chrome's `installType`: `development` means loaded unpacked. */
export function installLabel(installType: string): string {
  const label = Object.hasOwn(INSTALL_LABELS, installType)
    ? INSTALL_LABELS[installType]
    : undefined;
  return label ?? `${installType} install`;
}

/** What the provider session means for the next Sync. */
export function syncSignIn(state: DiagnosticsConnection["providerSession"]): string {
  switch (state) {
    case "active":
      return "sync sign-in active";
    case "refresh-required":
      // A Sync renews it without the password unless Bitwarden rejects the refresh token.
      return "sync sign-in kept, next Sync tries to renew it (refresh-required)";
    case "reauthentication-required":
      return "sync sign-in needs the password (reauthentication-required)";
    case "none":
      return "no sync sign-in (none)";
    default:
      return `sync sign-in unreadable (${state})`;
  }
}

/** `0 errors, 3 warnings`: the log's problems in its last 24 hours. */
export function problemCounts(logs: { recentErrors: number; recentWarnings: number }): string {
  return `${plural(logs.recentErrors, "error")}, ${plural(logs.recentWarnings, "warning")}`;
}

/** `1 recipe`, `2 recipes`: a count with its English noun. */
export function plural(value: number, noun: string, nouns = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : nouns}`;
}

/** `25 min`, `4 h` or `3 d`; a time in the future counts as `0 min`. */
export function age(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(0, Math.floor(ms / MINUTE_MS))} min`;
  if (ms < 48 * HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h`;
  return `${Math.floor(ms / (24 * HOUR_MS))} d`;
}

/** The Bitwarden server line: its kind and version, or why it could not be read. */
export function serverLabel(server: NonNullable<DiagnosticsConnection["server"]>): string {
  if (!server.ok)
    return server.error === "no-site-access"
      ? "server not checked (no-site-access)"
      : `server config failed (${server.error}${server.status === undefined ? "" : ` ${server.status}`})`;
  switch (server.kind) {
    case "bitwarden":
      return `Bitwarden server ${server.version}`;
    case "vaultwarden":
      return `Vaultwarden, compatible with Bitwarden ${server.version}`;
    default:
      return `third-party server, compatible with Bitwarden ${server.version}`;
  }
}

type ServiceDevice = NonNullable<DiagnosticsStatus["service"]["device"]>;

/** Whether the service would try recipe generation now; no request reached Claude. */
export function generationLabel(state: Extract<ServiceDevice, { ok: true }>["generation"]): string {
  switch (state) {
    case "ok":
      return "recipe generation available (ok)";
    case "credentials-not-configured":
      return "recipe generation off, no Claude credentials on the service (credentials-not-configured)";
    case "issuer-unavailable":
      return "recipe generation unavailable, the service cannot sign in to Claude (issuer-unavailable)";
    case "monthly-limit":
      return "recipe generation stopped for this month (monthly-limit)";
    case "daily-limit":
      return "recipe generation stopped for today (daily-limit)";
  }
}

/** Why the service's own record for this device could not be read. */
export function deviceFailureLabel(error: Extract<ServiceDevice, { ok: false }>["error"]): string {
  return error === "rejected"
    ? "service rejected this device (rejected)"
    : `service record not read (${error})`;
}
