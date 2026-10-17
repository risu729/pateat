import { CLOCK_SKEW_WARNING_MS, RECIPE_SYNC_OVERDUE_MS } from "./limits";
import {
  age,
  deviceFailureLabel,
  generationLabel,
  problemCounts,
  serverLabel,
  syncSignIn,
  type DiagnosticTranslator,
} from "./labels";
import type { DiagnosticsCheck, DiagnosticsStatus } from "./wire";

/** Translate known presentation states, keeping every raw code available for support. */
export function diagnosticsCode(code: string, t: DiagnosticTranslator): string {
  return t(`diagnostics.code.${code}`, { defaultValue: code });
}

/** Reword structured checks for the page; never rewrite background details or exports. */
export function diagnosticsCheckLabel(
  check: DiagnosticsCheck,
  status: DiagnosticsStatus,
  t: DiagnosticTranslator,
): string {
  const item = status.connections.find((entry) =>
    ["vault", "sync", "vault-age", "server"].some((kind) => check.id === `${kind}:${entry.id}`),
  );
  if (item) {
    if (check.id === `vault:${item.id}`) {
      if (item.storageError) return `${item.id} ${item.storageError}`;
      if (["review-required", "unavailable", "disabled"].includes(item.state))
        return `${item.id} ${diagnosticsCode(item.state, t)}`;
      return t("{{id}} vault cache {{state}}", {
        id: item.id,
        state: diagnosticsCode(item.state, t),
      });
    }
    if (check.id === `sync:${item.id}`) {
      if (
        item.state === "disabled" &&
        item.providerSession !== "active" &&
        !(item.providerSession === "refresh-required" && item.autoUnlock === "enabled")
      )
        return t("{{id}} sync sign-in not used", { id: item.id });
      const label = `${item.id} ${syncSignIn(item.providerSession, t)}`;
      return item.providerSession === "refresh-required" && item.autoUnlock !== "enabled"
        ? t("{{label}}; Sync needs auto-unlock", { label })
        : label;
    }
    if (check.id === `vault-age:${item.id}` && item.acceptedAt !== undefined) {
      const synced = t("{{id}} vault synced {{age}} ago", {
        id: item.id,
        age: age(status.collectedAt - item.acceptedAt, t),
      });
      return item.checkedAt === undefined
        ? synced
        : t("{{synced}}; checked {{age}} ago{{outcome}}", {
            synced,
            age: age(status.collectedAt - item.checkedAt, t),
            outcome: item.checkOutcome ? `: ${diagnosticsCode(item.checkOutcome, t)}` : "",
          });
    }
    if (check.id === `server:${item.id}` && item.server)
      return `${item.id} ${serverLabel(item.server, t)}`;
  }
  const service = status.service;
  switch (check.id) {
    case "site-access":
      return t(
        check.level === "ok"
          ? "https://*/* site access granted"
          : "https://*/* site access withheld",
      );
    case "crypto-host":
      return t(
        status.cryptoHost.ready ? "crypto host ready" : "crypto host idle (starts on demand)",
      );
    case "connections":
      return t("connections unreadable");
    case "logs":
      return !status.logs
        ? t("logs unreadable")
        : status.logs.recentErrors + status.logs.recentWarnings > 0
          ? t("{{problems}} logged in the last 24 h", { problems: problemCounts(status.logs, t) })
          : t("no errors or warnings logged in the last 24 h");
    case "service-record":
      return service.device && !service.device.ok
        ? deviceFailureLabel(service.device.error, t)
        : check.detail;
    case "generation":
      return service.device?.ok ? generationLabel(service.device.generation, t) : check.detail;
    case "service-copy": {
      const record = service.device;
      if (!record?.ok) return check.detail;
      const differences: string[] = [];
      if (service.recipes && !service.cacheFull && service.recipes.count !== record.recipes)
        differences.push(
          t("service {{remote}} recipes, cached {{local}}", {
            remote: record.recipes,
            local: service.recipes.count,
          }),
        );
      const local = service.settingsRevision ?? 0;
      if (local !== record.settingsRevision)
        differences.push(
          t("settings revision service {{remote}}, here {{local}}", {
            remote: record.settingsRevision,
            local,
          }),
        );
      return differences.length
        ? differences.join("; ")
        : t("recipes and settings match the service");
    }
    case "service": {
      if (service.kind === "not-configured") return t("Pateat service not paired");
      if (service.kind === "unavailable") return t("service record unreadable");
      if (service.rejected) return t("service rejected this device (401)");
      if (!service.health || service.health.ok) return t("Pateat service reachable");
      return service.health.error === "no-site-access"
        ? t("no site access to the Pateat service")
        : t("health {{error}}", {
            error:
              service.health.error === "status"
                ? (service.health.status ?? "error")
                : service.health.error,
          });
    }
    case "recipe-cache":
      return t("recipe cache full");
    case "clock": {
      const skew = service.health?.ok ? service.health.skewMs : undefined;
      if (skew === undefined) return check.detail;
      return check.level === "ok"
        ? t("clock within {{seconds}} s", { seconds: CLOCK_SKEW_WARNING_MS / 1000 })
        : t(
            skew > 0
              ? "clock {{seconds}} s behind the service"
              : "clock {{seconds}} s ahead of the service",
            { seconds: Math.round(Math.abs(skew) / 1000) },
          );
    }
    case "recipe-sync":
      return service.syncedAt === undefined
        ? t("recipes not synced yet")
        : check.level === "ok"
          ? t("recipes synced in the last 24 h")
          : t("recipe sync overdue by {{hours}} h", {
              hours: Math.floor(
                (status.collectedAt - service.syncedAt - RECIPE_SYNC_OVERDUE_MS) / (60 * 60 * 1000),
              ),
            });
    default:
      return check.detail;
  }
}
