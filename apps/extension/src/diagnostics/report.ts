// The text "Copy for bug report" copies (ADR 0019). It keeps the KDF family but leaves out
// its parameters, which are shown on the page only. The report stays in English in every
// UI language; translation is confined to the page around this exact preview.
import { isoMinute } from "../time";
import {
  deviceFailureLabel,
  generationLabel,
  installLabel,
  plural,
  problemCounts,
  serverLabel,
  syncSignIn,
} from "./labels";
import { DEBUG_UNTIL_TURNED_OFF } from "./log";
import type { DiagnosticsConnection, DiagnosticsStatus } from "./wire";

export type BrowserInfo = { name: string; version: string; installType: string };

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
  if (entry.acceptedAt !== undefined) parts.push(`synced ${isoMinute(entry.acceptedAt)}`);
  if (entry.kdfType) parts.push(`KDF ${entry.kdfType}`);
  if (entry.items)
    parts.push(
      `${plural(entry.items.total, "item")} (login ${entry.items.login}, TOTP ${entry.items.totp}, passkey ${entry.items.passkey}) + ${entry.items.unsupported} unsupported`,
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
  if (service.syncedAt !== undefined) parts.push(`synced ${isoMinute(service.syncedAt)}`);
  if (service.settingsRevision !== undefined)
    parts.push(`settings revision ${service.settingsRevision}`);
  if (service.holdSince !== undefined) parts.push(`held since ${isoMinute(service.holdSince)}`);
  if (service.recipes) parts.push(plural(service.recipes.count, "recipe"));
  return `Pateat service: ${parts.join(" · ")}`;
}

/** What the service itself holds, beside the device's copy on the line above. */
function serviceRecordLine(record: NonNullable<DiagnosticsStatus["service"]["device"]>): string {
  if (!record.ok) return `Service record: ${deviceFailureLabel(record.error)}`;
  return `Service record: paired ${isoMinute(record.pairedAt)} · ${plural(record.recipes, "recipe")} · settings revision ${record.settingsRevision} · ${generationLabel(record.generation)}`;
}

export function formatReport(status: DiagnosticsStatus, browser: BrowserInfo): string {
  const { build } = status;
  const lines = [
    `Pateat ${build.version} (${shortRevision(build.revision)}) · ${build.mode} build · ${installLabel(browser.installType)} (${browser.installType})`,
    `${browser.name} ${browser.version} · ${status.platform.os} ${status.platform.arch}`,
    `Permissions: ${[...status.permissions.permissions, ...status.permissions.origins].join(", ")}${status.permissions.otherOrigins ? ` + ${plural(status.permissions.otherOrigins, "granted site")}` : ""}`,
    `Bitwarden SDK ${build.bitwardenSdk} · protocol ${build.bitwardenProtocol}`,
    ...status.connections.map(connectionLine),
    serviceLine(status.service),
    ...(status.service.device ? [serviceRecordLine(status.service.device)] : []),
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
      `Logs: ${plural(status.logs.entries, "entry", "entries")} (${Math.ceil(status.logs.bytes / 1024)} KB), ${problemCounts(status.logs)} in 24 h${status.logs.debugUntil === undefined ? "" : status.logs.debugUntil === DEBUG_UNTIL_TURNED_OFF ? ", debug on until turned off" : `, debug until ${isoMinute(status.logs.debugUntil)}`}`,
    );
  const { recent } = status;
  if (recent?.updated)
    lines.push(
      `Updated ${isoMinute(recent.updated.time)} from ${shortRevision(recent.updated.from)}`,
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
  // Pages that looked like a verification but were not sent (ADR 0035).
  if (recent?.unsentVerifications.length)
    lines.push(
      `Verification pages not sent (24 h): ${recent.unsentVerifications.map(({ reason, count }) => `${reason} ${count}`).join(" · ")}`,
    );
  lines.push(`Collected ${isoMinute(status.collectedAt)}`);
  return lines.join("\n");
}
