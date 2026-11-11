import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { DiagnosticsApp, type DiagnosticsClient } from "../../apps/extension/src/diagnostics/app";
import { formatLogExport } from "../../apps/extension/src/diagnostics/log-format";
import type { LogEntry } from "../../apps/extension/src/diagnostics/log-fields";
import type { LogExportScope } from "../../apps/extension/src/diagnostics/log-export";
import type { DiagnosticsStatus } from "../../apps/extension/src/diagnostics/wire";

const NOW = Date.UTC(2026, 10, 12, 12);
const retained: LogEntry[] = [
  { time: NOW - 25 * 3_600_000, level: "warn", event: "login.start", fields: {} },
  { time: NOW - 2 * 3_600_000, level: "error", event: "login.start", fields: {} },
  { time: NOW - 600_000, level: "info", event: "login.start", fields: {} },
  {
    time: NOW - 300_000,
    level: "warn",
    event: "login.start",
    fields: { origin: "https://private.example" },
  },
  { time: NOW, level: "error", event: "login.start", fields: {} },
  { time: NOW + 1, level: "error", event: "login.start", fields: {} },
];
const status: DiagnosticsStatus = {
  version: 1,
  collectedAt: NOW,
  build: {
    version: "0.1.0",
    revision: "synthetic",
    mode: "production",
    bitwardenSdk: "synthetic",
    bitwardenProtocol: "synthetic",
  },
  platform: { os: "linux", arch: "x86-64" },
  permissions: { permissions: [], origins: [], otherOrigins: 0 },
  actionIcon: "locked",
  cryptoHost: { ready: false, sessions: 0 },
  connections: [],
  service: { kind: "not-configured" },
  storage: {},
  logs: { entries: 999, bytes: 1024, recentErrors: 0, recentWarnings: 0 },
  checks: [],
};
function exported(includeSites = true, scope?: LogExportScope): string {
  return formatLogExport(retained, {
    version: "0.1.0",
    revision: "synthetic",
    exportedAt: NOW,
    includeSites,
    ...(scope ? { scope } : {}),
  });
}
function client() {
  return {
    load: vi.fn<DiagnosticsClient["load"]>().mockResolvedValue({ ok: true, status }),
    browser: vi.fn(async () => ({ name: "Chromium", version: "154", installType: "development" })),
    copy: vi.fn<DiagnosticsClient["copy"]>().mockResolvedValue(undefined),
    exportLogs: vi.fn<DiagnosticsClient["exportLogs"]>(async (includeSites, scope) => ({
      ok: true,
      text: exported(includeSites, scope),
    })),
    clearLogs: vi.fn<DiagnosticsClient["clearLogs"]>().mockResolvedValue({ ok: true }),
    setDebugLogs: vi.fn<DiagnosticsClient["setDebugLogs"]>().mockResolvedValue({ ok: true }),
    download: vi.fn<DiagnosticsClient["download"]>(),
  } satisfies DiagnosticsClient;
}
async function show(value: DiagnosticsClient) {
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <DiagnosticsApp client={value} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "Checks" })).toBeVisible();
  await page.getByRole("button", { name: "Download logs" }).click();
  await expect.element(page.getByRole("combobox", { name: "Time range" })).toBeVisible();
}
const preview = () => document.getElementById("logs-preview")?.textContent;
const range = () => page.getByRole("combobox", { name: "Time range" });
const severity = () => page.getByRole("combobox", { name: "Severity" });
const hideSites = () => page.getByRole("checkbox", { name: "Hide site addresses and recipe IDs" });
function deferredExport(value: ReturnType<typeof client>) {
  let resolve: (reply: Awaited<ReturnType<DiagnosticsClient["exportLogs"]>>) => void = () =>
    undefined;
  value.exportLogs.mockImplementationOnce(
    () =>
      new Promise((finish) => {
        resolve = finish;
      }),
  );
  return (text?: string) =>
    resolve(text === undefined ? { ok: false, error: "unavailable" } : { ok: true, text });
}
afterEach(async () => cleanup());

test("default export keeps all retained rows and uses its own snapshot count", async () => {
  const value = client();
  await show(value);
  expect(value.exportLogs).toHaveBeenCalledExactlyOnceWith(true);
  await expect.element(range()).toHaveValue("all");
  await expect.element(severity()).toHaveValue("all");
  await expect.poll(preview).toBe(exported());
  await expect.element(page.getByText("Showing 6 of 6 retained entries.")).toBeVisible();
  expect(preview()).toContain(new Date(NOW + 1).toISOString());
  expect(value.clearLogs).not.toHaveBeenCalled();
  expect(value.setDebugLogs).not.toHaveBeenCalled();
});

test("range and severity select the exact preview, saved file and copied text", async () => {
  const value = client();
  await show(value);
  await range().selectOptions("15m");
  await severity().selectOptions("problems");
  const scope = { range: "15m", severity: "problems" } as const;
  await expect.poll(preview).toBe(exported(true, scope));
  expect(value.exportLogs).toHaveBeenLastCalledWith(true, scope);
  await expect.element(page.getByText("Showing 2 of 6 retained entries.")).toBeVisible();
  await hideSites().click();
  const hidden = exported(false, scope);
  await expect.poll(preview).toBe(hidden);
  await page.getByRole("button", { name: "Save file" }).click();
  expect(value.download).toHaveBeenCalledExactlyOnceWith(
    hidden,
    expect.stringMatching(/^pateat-logs-\d{8}-\d{4}\.jsonl$/u),
  );
  await page.getByRole("button", { name: "Copy all" }).click();
  expect(value.copy).toHaveBeenCalledExactlyOnceWith(hidden);
  await expect.element(page.getByText("Copied 2 entries.")).toBeVisible();
  expect(value.clearLogs).not.toHaveBeenCalled();
  expect(value.setDebugLogs).not.toHaveBeenCalled();
});

test("pending filters disable Save and Copy and preserve the newest privacy choice", async () => {
  const value = client();
  await show(value);
  const earlier = deferredExport(value);
  await range().selectOptions("1h");
  await expect.element(page.getByRole("button", { name: "Save file" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Copy all" })).toBeDisabled();
  const latest = deferredExport(value);
  await hideSites().click();
  await expect.poll(preview).toBe("Updating preview…");
  expect(document.getElementById("logs-preview")?.getAttribute("aria-busy")).toBe("true");
  expect(preview()).not.toContain("private.example");
  await expect.element(page.getByText("Showing 6 of 6 retained entries.")).not.toBeInTheDocument();
  const scope = { range: "1h", severity: "all" } as const;
  expect(value.exportLogs).toHaveBeenLastCalledWith(false, scope);
  const hidden = exported(false, scope);
  latest(hidden);
  await expect.poll(preview).toBe(hidden);
  await expect.element(page.getByRole("button", { name: "Save file" })).toBeEnabled();
  earlier(exported(true, scope));
  await expect.poll(preview).toBe(hidden);
  await expect.element(hideSites()).toBeChecked();
  expect(preview()).not.toContain("private.example");
  await page.getByRole("button", { name: "Copy all" }).click();
  expect(value.copy).toHaveBeenCalledExactlyOnceWith(hidden);
});

test("late results cannot replace a newer range and severity selection", async () => {
  const value = client();
  await show(value);
  const first = deferredExport(value);
  await range().selectOptions("24h");
  const last = deferredExport(value);
  await severity().selectOptions("problems");
  const newest = exported(true, { range: "24h", severity: "problems" });
  last(newest);
  await expect.poll(preview).toBe(newest);
  first(exported(true, { range: "24h", severity: "all" }));
  await expect.poll(preview).toBe(newest);
  await expect.element(severity()).toHaveValue("problems");
  await expect.element(page.getByText("Showing 3 of 6 retained entries.")).toBeVisible();
});

test("a failed newest request closes its old preview despite an older success", async () => {
  const value = client();
  await show(value);
  const first = deferredExport(value);
  await range().selectOptions("15m");
  const last = deferredExport(value);
  await hideSites().click();
  last();
  await expect.element(page.getByText("Unable to read the logs.")).toBeVisible();
  first(exported(true, { range: "15m", severity: "all" }));
  await expect.poll(preview).toBeUndefined();
  await expect.element(page.getByRole("button", { name: "Save file" })).not.toBeInTheDocument();
  expect(value.download).not.toHaveBeenCalled();
  expect(value.copy).not.toHaveBeenCalled();
});

test("a header-only result is visible as empty while Save and Copy retain its exact bytes", async () => {
  const value = client();
  await show(value);
  const text = formatLogExport(retained.slice(2, 3), {
    version: "0.1.0",
    revision: "synthetic",
    exportedAt: NOW,
    includeSites: true,
    scope: { range: "15m", severity: "problems" },
  });
  await range().selectOptions("15m");
  value.exportLogs.mockResolvedValueOnce({ ok: true, text });
  await severity().selectOptions("problems");
  await expect.poll(preview).toBe(text);
  await expect
    .element(
      page.getByText(/^Showing 0 of 1 retained entries\. No entries match these filters\.$/u),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Save file" }).click();
  expect(value.download).toHaveBeenCalledExactlyOnceWith(text, expect.any(String));
  await page.getByRole("button", { name: "Copy all" }).click();
  expect(value.copy).toHaveBeenCalledExactlyOnceWith(text);
  await expect.element(page.getByText("Copied 0 entries.")).toBeVisible();
});

test("clearing closes a pending scoped export and its late reply cannot reopen it", async () => {
  const value = client();
  await show(value);
  const finish = deferredExport(value);
  await range().selectOptions("15m");
  await page.getByRole("button", { name: "Clear logs" }).click();
  expect(value.clearLogs).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Delete all log entries" }).click();
  await expect.element(page.getByText("Logs cleared.")).toBeVisible();
  finish(exported(true, { range: "15m", severity: "all" }));
  await expect.poll(preview).toBeUndefined();
  expect(value.clearLogs).toHaveBeenCalledExactlyOnceWith();
  expect(value.setDebugLogs).not.toHaveBeenCalled();
});

test("debug logging keeps a resolved scoped preview and does not reset its filters", async () => {
  const value = client();
  await show(value);
  await range().selectOptions("1h");
  const text = exported(true, { range: "1h", severity: "all" });
  await expect.poll(preview).toBe(text);
  await page.getByRole("button", { name: "Turn on debug logging", exact: true }).click();
  await expect.element(page.getByText("Debug logging is on until you turn it off.")).toBeVisible();
  await expect.poll(preview).toBe(text);
  await expect.element(range()).toHaveValue("1h");
  expect(value.exportLogs).toHaveBeenCalledTimes(2);
  expect(value.setDebugLogs).toHaveBeenCalledExactlyOnceWith(true);
});
