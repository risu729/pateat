// Plain-language labels shared by the diagnostics page, its checks and the copied report.
// Each label that rewords a raw code keeps that code in parentheses.
import type { TFunction } from "i18next";
import type { DiagnosticsConnection, DiagnosticsStatus } from "./wire";

/** Only presentation callers supply a translator; background checks/reports stay English. */
export type DiagnosticTranslator = TFunction;

const INSTALL_LABELS: Record<string, string> = {
  development: "unpacked install",
  normal: "Web Store install",
  admin: "policy install",
  sideload: "sideloaded install",
};

/** Chrome's `installType`: `development` means loaded unpacked. */
export function installLabel(installType: string, t?: DiagnosticTranslator): string {
  const label = Object.hasOwn(INSTALL_LABELS, installType)
    ? INSTALL_LABELS[installType]
    : undefined;
  return t
    ? label
      ? t(label)
      : t("{{type}} install", { type: installType })
    : (label ?? `${installType} install`);
}

/** What the provider session means for the next Sync. */
export function syncSignIn(
  state: DiagnosticsConnection["providerSession"],
  t?: DiagnosticTranslator,
): string {
  switch (state) {
    case "active":
      return t ? t("sync sign-in active") : "sync sign-in active";
    case "refresh-required":
      // A Sync renews it without the password unless Bitwarden rejects the refresh token.
      return t
        ? t("sync sign-in kept, next Sync tries to renew it (refresh-required)")
        : "sync sign-in kept, next Sync tries to renew it (refresh-required)";
    case "reauthentication-required":
      return t
        ? t("sync sign-in needs the password (reauthentication-required)")
        : "sync sign-in needs the password (reauthentication-required)";
    case "none":
      return t ? t("no sync sign-in (none)") : "no sync sign-in (none)";
    default:
      return t
        ? t("sync sign-in unreadable ({{state}})", { state })
        : `sync sign-in unreadable (${state})`;
  }
}

/** `0 errors, 3 warnings`: the log's problems in its last 24 hours. */
export function problemCounts(
  logs: { recentErrors: number; recentWarnings: number },
  t?: DiagnosticTranslator,
): string {
  return t
    ? t("{{errors}}, {{warnings}}", {
        errors: plural(logs.recentErrors, "error", "errors", t),
        warnings: plural(logs.recentWarnings, "warning", "warnings", t),
      })
    : `${plural(logs.recentErrors, "error")}, ${plural(logs.recentWarnings, "warning")}`;
}

/** `1 recipe`, `2 recipes`: a count with its English noun. */
export function plural(
  value: number,
  noun: string,
  nouns = `${noun}s`,
  t?: DiagnosticTranslator,
): string {
  return t
    ? t("diagnostics.count." + noun, { count: value })
    : `${value} ${value === 1 ? noun : nouns}`;
}

// Background checks and copied reports stay English; the page passes its translator instead.
const minutesFormat = new Intl.DurationFormat("en", {
  style: "short",
  minutesDisplay: "always",
});
const hoursFormat = new Intl.DurationFormat("en", { style: "short", hoursDisplay: "always" });
const daysFormat = new Intl.DurationFormat("en", { style: "short", daysDisplay: "always" });

/** An already chosen hour count, including zero; overdue syncs keep hours beyond 48. */
export function formatHours(hours: number): string {
  return hoursFormat.format({ hours });
}

/** `25 min`, `4 hr` or `3 days`; a time in the future counts as `0 min`. */
export function age(ms: number, t?: DiagnosticTranslator): string {
  const elapsed = Temporal.Duration.from({ milliseconds: Math.max(0, ms) });
  const hours = elapsed.total("hours");
  if (hours < 1) {
    const minutes = Math.floor(elapsed.total("minutes"));
    return t ? t("{{count}} min", { count: minutes }) : minutesFormat.format({ minutes });
  }
  if (hours < 48)
    return t ? t("{{count}} hr", { count: Math.floor(hours) }) : formatHours(Math.floor(hours));
  const days = Math.floor(elapsed.total("days"));
  return t ? t("{{count}} days", { count: days }) : daysFormat.format({ days });
}

/** The Bitwarden server line: its kind and version, or why it could not be read. */
export function serverLabel(
  server: NonNullable<DiagnosticsConnection["server"]>,
  t?: DiagnosticTranslator,
): string {
  if (!server.ok)
    return server.error === "no-site-access"
      ? t
        ? t("server not checked (no-site-access)")
        : "server not checked (no-site-access)"
      : t
        ? t("server config failed ({{error}})", {
            error: `${server.error}${server.status === undefined ? "" : ` ${server.status}`}`,
          })
        : `server config failed (${server.error}${server.status === undefined ? "" : ` ${server.status}`})`;
  switch (server.kind) {
    case "bitwarden":
      return t
        ? t("Bitwarden server {{version}}", { version: server.version })
        : `Bitwarden server ${server.version}`;
    case "vaultwarden":
      return t
        ? t("Vaultwarden, compatible with Bitwarden {{version}}", { version: server.version })
        : `Vaultwarden, compatible with Bitwarden ${server.version}`;
    default:
      return t
        ? t("third-party server, compatible with Bitwarden {{version}}", {
            version: server.version,
          })
        : `third-party server, compatible with Bitwarden ${server.version}`;
  }
}

type ServiceDevice = NonNullable<DiagnosticsStatus["service"]["device"]>;

/** Whether the service would try recipe generation now; no request reached Claude. */
export function generationLabel(
  state: Extract<ServiceDevice, { ok: true }>["generation"],
  t?: DiagnosticTranslator,
): string {
  switch (state) {
    case "ok":
      return t ? t("recipe generation available (ok)") : "recipe generation available (ok)";
    case "credentials-not-configured":
      return t
        ? t(
            "recipe generation off, no Claude credentials on the service (credentials-not-configured)",
          )
        : "recipe generation off, no Claude credentials on the service (credentials-not-configured)";
    case "issuer-unavailable":
      return t
        ? t(
            "recipe generation unavailable, the service cannot sign in to Claude (issuer-unavailable)",
          )
        : "recipe generation unavailable, the service cannot sign in to Claude (issuer-unavailable)";
    case "monthly-limit":
      return t
        ? t("recipe generation stopped for this month (monthly-limit)")
        : "recipe generation stopped for this month (monthly-limit)";
    case "daily-limit":
      return t
        ? t("recipe generation stopped for today (daily-limit)")
        : "recipe generation stopped for today (daily-limit)";
  }
}

/** Why the service's own record for this device could not be read. */
export function deviceFailureLabel(
  error: Extract<ServiceDevice, { ok: false }>["error"],
  t?: DiagnosticTranslator,
): string {
  return error === "rejected"
    ? t
      ? t("service rejected this device (rejected)")
      : "service rejected this device (rejected)"
    : t
      ? t("service record not read ({{error}})", { error })
      : `service record not read (${error})`;
}

/**
 * Whether a sync could renew an expired sign-in: it needs the vault's key, kept on disk
 * (automatic unlock on) or, while unlocked in this browser session, in memory (ADR 0075).
 */
export function syncKeyKept(item: { state: string; autoUnlock: string }): boolean {
  return (
    item.autoUnlock === "enabled" ||
    (item.autoUnlock === "disabled" && !["locked", "disabled", "unavailable"].includes(item.state))
  );
}
