import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  parseServiceReports,
  SERVICE_REPORTS_KEY,
  type ServiceReportsSetting,
} from "../service/reports-setting";
import { trustedRecord } from "../storage";
import { checkClass, StatusLines } from "./ui";

/** Reads and writes whether this device sends its own reports to the service; never synced. */
export interface ServiceReportsClient {
  read(): Promise<ServiceReportsSetting>;
  write(value: ServiceReportsSetting): Promise<void>;
}

/** The settings page's own `storage.local` record; the service worker follows its changes. */
export function createServiceReportsClient(): ServiceReportsClient {
  const record = trustedRecord<ServiceReportsSetting>(SERVICE_REPORTS_KEY);
  return {
    read: async () => parseServiceReports(await record.read()),
    write: (value) => record.write(value),
  };
}

const QUERY_KEY = ["settings", "service-reports"] as const;

/**
 * Whether this device sends a record of each ended login (ADR 0055) and its problem log
 * lines (ADR 0066) to the paired service. On by default.
 */
export function ServiceReports({ client }: { client: ServiceReportsClient }) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const setting = useQuery({ queryKey: QUERY_KEY, queryFn: () => client.read(), retry: false });
  const save = useMutation({
    mutationFn: (value: ServiceReportsSetting) => client.write(value),
    onMutate: () => setMessage(t("Saving…")),
    onSuccess: (_result, value) => {
      queryClient.setQueryData(QUERY_KEY, value);
      setMessage(t("Saved on this device."));
    },
    onError: () => setMessage(t("The setting could not be saved. Try again.")),
  });
  const value = setting.data;
  return (
    <div className="flex flex-col gap-2">
      <label className={checkClass}>
        <input
          id="service-reports"
          type="checkbox"
          checked={value?.send ?? false}
          disabled={!value || save.isPending}
          aria-describedby="service-reports-note"
          onChange={(event) => save.mutate({ send: event.target.checked, since: Date.now() })}
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
              "Each ended login's result and times, and the diagnostics log's warnings, errors and reasons Pateat did nothing on a page. Off: none are sent, and what was logged while off is never sent. Applies on this device only.",
            ),
          },
        ]}
      />
      <output id="service-reports-status" className="text-sm leading-5" aria-live="polite">
        {setting.isError ? t("Unavailable") : message}
      </output>
    </div>
  );
}
