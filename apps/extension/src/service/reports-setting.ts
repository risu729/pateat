import type { LocalSettings } from "@pateat/contracts";

/**
 * Whether this profile's devices send what they send on their own to the paired service:
 * the login records of ADR 0055 and the problem log lines of ADR 0066. Part of the synced
 * profile settings (`serviceReports`); absent means on, as before the setting existed.
 */
export type ServiceReportsSetting = { send: boolean; since?: number | undefined };

/** Sending stays on until it is turned off (owner, 2026-11-02). */
export const DEFAULT_SERVICE_REPORTS: ServiceReportsSetting = { send: true };

/** The setting in the current settings; settings that cannot be read send nothing. */
export async function readServiceReports(
  read: () => Promise<Pick<LocalSettings, "serviceReports">>,
): Promise<ServiceReportsSetting> {
  try {
    return (await read()).serviceReports ?? DEFAULT_SERVICE_REPORTS;
  } catch {
    return { send: false };
  }
}
