// Plain-language labels shared by the diagnostics page, its checks and the copied report.
// Each label that rewords a raw code keeps that code in parentheses.
import type { DiagnosticsConnection } from "./wire";

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

/** `25 min`, `4 h` or `3 d`; a time in the future counts as `0 min`. */
export function age(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(0, Math.floor(ms / MINUTE_MS))} min`;
  if (ms < 48 * HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h`;
  return `${Math.floor(ms / (24 * HOUR_MS))} d`;
}
