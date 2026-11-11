import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import type { LogExportScope } from "./log-export";

/** Filters choose the next exact export; they never change or clear stored entries. */
export function LogScopeControls({
  scope,
  onChange,
}: {
  scope: LogExportScope;
  onChange: (scope: LogExportScope) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <div className="flex flex-wrap gap-4 text-sm">
      <label className="flex flex-col gap-1">
        {t("Time range")}
        <select
          value={scope.range}
          onChange={(event) =>
            onChange({ ...scope, range: event.target.value as LogExportScope["range"] })
          }
        >
          <option value="all">{t("All retained entries")}</option>
          <option value="15m">{t("Last 15 minutes")}</option>
          <option value="1h">{t("Last hour")}</option>
          <option value="24h">{t("Last 24 hours")}</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        {t("Severity")}
        <select
          value={scope.severity}
          onChange={(event) =>
            onChange({ ...scope, severity: event.target.value as LogExportScope["severity"] })
          }
        >
          <option value="all">{t("All levels")}</option>
          <option value="problems">{t("Warnings and errors")}</option>
        </select>
      </label>
    </div>
  );
}
