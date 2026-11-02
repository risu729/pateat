import * as v from "valibot";

/**
 * Whether this device sends what it sends on its own to the paired service: the login
 * records of ADR 0055 and the problem log lines of ADR 0066. A device setting the settings
 * page writes; it is never synced, since each device decides what leaves it. Absent means
 * on, as before the setting existed.
 */
export const SERVICE_REPORTS_KEY = "pateat.service-reports.v1";

export const serviceReportsSchema = v.strictObject({ send: v.boolean() });
export type ServiceReportsSetting = v.InferOutput<typeof serviceReportsSchema>;

/** Sending stays on until it is turned off (owner, 2026-11-02). */
export const DEFAULT_SERVICE_REPORTS: ServiceReportsSetting = { send: true };
/** A damaged record sends nothing rather than something the owner may have turned off. */
const DAMAGED_SERVICE_REPORTS: ServiceReportsSetting = { send: false };

/** The stored setting. Absent means the default; a value that does not parse is off. */
export function parseServiceReports(value: unknown): ServiceReportsSetting {
  if (value === undefined || value === null) return DEFAULT_SERVICE_REPORTS;
  const parsed = v.safeParse(serviceReportsSchema, value);
  return parsed.success ? parsed.output : DAMAGED_SERVICE_REPORTS;
}

/** Whether the stored setting sends; a record that cannot be read sends nothing. */
export async function serviceReportsOn(read: () => Promise<unknown>): Promise<boolean> {
  try {
    return parseServiceReports(await read()).send;
  } catch {
    return false;
  }
}
