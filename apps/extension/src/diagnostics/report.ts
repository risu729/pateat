// The text "Copy for bug report" copies (ADR 0019). It keeps the KDF family but leaves out
// its parameters, which are shown on the page only.
import { installLabel, serverLabel, syncSignIn } from "./labels";
import type { DiagnosticsConnection, DiagnosticsStatus } from "./wire";

export type BrowserInfo = { name: string; version: string; installType: string };

/** ISO time to the minute, in UTC. */
export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

export function shortRevision(revision: string): string {
  return /^[0-9a-f]{40}$/u.test(revision) ? revision.slice(0, 7) : revision;
}

function connectionLine(entry: DiagnosticsConnection): string {
  const parts = [
    entry.environment,
    ...(entry.server ? [serverLabel(entry.server)] : []),
    entry.state,
    `auto-unlock ${entry.autoUnlock}`,
    syncSignIn(entry.providerSession),
  ];
  if (entry.storageError) parts.push(`storage ${entry.storageError}`);
  if (entry.acceptedAt !== undefined) parts.push(`synced ${utcMinute(entry.acceptedAt)}`);
  if (entry.kdfType) parts.push(`KDF ${entry.kdfType}`);
  if (entry.items)
    parts.push(
      `${entry.items.total} items (login ${entry.items.login}, TOTP ${entry.items.totp}, passkey ${entry.items.passkey}) + ${entry.items.unsupported} unsupported`,
    );
  return `${entry.id}: ${parts.join(" · ")}`;
}

function serviceLine(service: DiagnosticsStatus["service"]): string {
  const parts: string[] = [service.kind];
  if (service.rejected) parts.push("rejected");
  if (service.cacheFull) parts.push("cache full");
  if (service.health)
    parts.push(
      service.health.ok
        ? `revision ${shortRevision(service.health.revision)}`
        : `health ${service.health.error}${service.health.status === undefined ? "" : ` ${service.health.status}`}`,
    );
  if (service.syncedAt !== undefined) parts.push(`synced ${utcMinute(service.syncedAt)}`);
  if (service.settingsRevision !== undefined)
    parts.push(`settings revision ${service.settingsRevision}`);
  if (service.holdSince !== undefined) parts.push(`held since ${utcMinute(service.holdSince)}`);
  if (service.recipes) parts.push(`${service.recipes.count} recipes`);
  return `Pateat service: ${parts.join(" · ")}`;
}

export function formatReport(status: DiagnosticsStatus, browser: BrowserInfo): string {
  const { build } = status;
  const lines = [
    `Pateat ${build.version} (${shortRevision(build.revision)}) · ${build.mode} build · ${installLabel(browser.installType)} (${browser.installType})`,
    `${browser.name} ${browser.version} · ${status.platform.os} ${status.platform.arch}`,
    `Permissions: ${[...status.permissions.permissions, ...status.permissions.origins].join(", ")}${status.permissions.otherOrigins ? ` + ${status.permissions.otherOrigins} granted sites` : ""}`,
    `Bitwarden SDK ${build.bitwardenSdk} · protocol ${build.bitwardenProtocol}`,
    ...status.connections.map(connectionLine),
    serviceLine(status.service),
  ];
  if (status.settings)
    lines.push(
      `Settings: excluded sites ${status.settings.excludedSites} · site defaults ${status.settings.siteDefaults} · bindings ${status.settings.bindings}`,
    );
  lines.push(`Toolbar icon: ${status.actionIcon}`);
  const counts = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const check of status.checks) counts[check.level] += 1;
  const problems = status.checks.filter(
    (check) => check.level === "warn" || check.level === "error",
  );
  lines.push(
    `Checks: ${counts.ok} ok · ${counts.info} info · ${counts.warn} warn · ${counts.error} error`,
    ...problems.map((check) => `  ${check.level} ${check.detail}`),
  );
  if (status.storage.localBytes !== undefined)
    lines.push(`Storage: storage.local ${Math.ceil(status.storage.localBytes / 1024)} KB`);
  if (status.logs)
    lines.push(
      `Logs: ${status.logs.entries} entries (${Math.ceil(status.logs.bytes / 1024)} KB), ${status.logs.recentErrors} errors in 24 h${status.logs.debugUntil === undefined ? "" : `, debug until ${utcMinute(status.logs.debugUntil)}`}`,
    );
  const { recent } = status;
  if (recent?.updated)
    lines.push(
      `Updated ${utcMinute(recent.updated.time)} from ${shortRevision(recent.updated.from)}`,
    );
  if (recent?.problems.length)
    lines.push(
      "Recent problems (24 h, newest first):",
      ...recent.problems.map((line) => `  ${line}`),
    );
  if (recent?.passkeyDelegations.length)
    lines.push(
      `Passkey delegations (24 h): ${recent.passkeyDelegations.map(({ reason, count }) => `${reason} ${count}`).join(" · ")}`,
    );
  lines.push(`Collected ${utcMinute(status.collectedAt)}`);
  return lines.join("\n");
}
