import type { LocalSettings } from "@pateat/contracts";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { checkClass, Panel, StatusLines } from "./ui";

export const SERVICE_REPORTS_SECTION = "service-reports";

/**
 * Whether the profile's devices send a record of each ended login (ADR 0055) and their
 * problem log lines (ADR 0066) to the paired service. On by default; synced with the
 * profile like the other settings here.
 */
export function ServiceReports({
  draft,
  edit,
  now = Date.now,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
  now?: () => number;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const on = draft.serviceReports?.send ?? true;
  return (
    <Panel
      id={SERVICE_REPORTS_SECTION}
      headingId="service-reports-heading"
      title={t("Reports to the service")}
    >
      <label className={checkClass}>
        <input
          id="service-reports"
          type="checkbox"
          checked={on}
          aria-describedby="service-reports-note"
          onChange={(event) => {
            const send = event.target.checked;
            // The time lets devices pass over lines written while it was off.
            edit((settings) => {
              settings.serviceReports = { send, since: now() };
            });
          }}
        />
        {t("Send login records and problem reports to the service")}
      </label>
      <StatusLines
        id="service-reports-note"
        muted
        lines={[
          {
            tone: "idle",
            icon: Info,
            text: t(
              "Each ended login's result and times, and the diagnostics log's warnings, errors and reasons Pateat did nothing on a page. Off: none are sent, and what was logged while off is never sent. Applies on all your devices.",
            ),
          },
        ]}
      />
    </Panel>
  );
}
