import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import { DiagnosticsApp, type DiagnosticsClient } from "../../apps/extension/src/diagnostics/app";
import type { DiagnosticsStatus } from "../../apps/extension/src/diagnostics/wire";
import { DEBUG_UNTIL_TURNED_OFF } from "../../apps/extension/src/diagnostics/log";

// The diagnostics page with a synthetic summary: icon-led checks, the panels and debug logging.

const NOW = Date.UTC(2026, 9, 12, 20, 25);

function status(overrides: Partial<DiagnosticsStatus> = {}): DiagnosticsStatus {
  return {
    version: 1,
    collectedAt: NOW,
    build: {
      version: "0.1.0",
      revision: "786d218aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mode: "production",
      bitwardenSdk: "0.2.0-main.1100",
      bitwardenProtocol: "client 2026.2.0, Device-Type 2",
    },
    platform: { os: "win", arch: "x86-64" },
    permissions: {
      permissions: ["alarms", "storage", "offscreen"],
      origins: ["https://*/*"],
      otherOrigins: 0,
    },
    actionIcon: "unlocked",
    cryptoHost: { ready: false, sessions: 0 },
    connections: [
      {
        id: "bitwarden:3f9a1c",
        environment: "cloud-us",
        state: "ready",
        autoUnlock: "enabled",
        providerSession: "active",
        acceptedAt: NOW - 4 * 60_000,
        unlockKdf: "PBKDF2-SHA256 600000",
        server: { ok: true, version: "2026.9.1", kind: "bitwarden" },
      },
    ],
    service: { kind: "not-configured" },
    settings: { excludedSites: 2, siteDefaults: 2, bindings: 0, passkeyBrowserSites: 1 },
    storage: { localBytes: 900 },
    logs: { entries: 1284, bytes: 212 * 1024, recentErrors: 0, recentWarnings: 2 },
    checks: [
      { id: "site-access", level: "ok", detail: "https://*/* and http://*/* site access granted" },
      { id: "logs", level: "info", detail: "0 errors, 2 warnings logged in the last 24 h" },
      { id: "recipe-cache", level: "warn", detail: "recipe cache full" },
      { id: "connections", level: "error", detail: "connections unreadable" },
    ],
    ...overrides,
  };
}

function client(value: DiagnosticsStatus) {
  return {
    load: vi.fn(async () => ({ ok: true as const, status: value })),
    browser: vi.fn(async () => ({
      name: "Chrome",
      version: "154.0.8037.97",
      installType: "development",
    })),
    copy: vi.fn(async () => undefined),
    exportLogs: vi.fn(async () => ({ ok: true as const, text: "{}\n" })),
    clearLogs: vi.fn(async () => ({ ok: true as const })),
    setDebugLogs: vi.fn(async () => ({ ok: true as const })),
    download: vi.fn(),
  } satisfies DiagnosticsClient;
}

async function show(value: DiagnosticsClient, queryClient = new QueryClient()) {
  await render(
    <QueryClientProvider client={queryClient}>
      <DiagnosticsApp client={value} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "Checks" })).toBeVisible();
}

/** The open log preview's text, or `undefined` once it is closed. */
function preview(): string | undefined {
  return document.querySelector("#logs-preview")?.textContent ?? undefined;
}

afterEach(async () => {
  await cleanup();
});

test("each check is a line led by an icon, with its level read out", async () => {
  await show(client(status()));
  const lines = page.getByRole("list").first().getByRole("listitem");
  await expect
    .element(lines.nth(0))
    .toHaveTextContent("OK https://*/* and http://*/* site access granted");
  await expect.element(lines.nth(2)).toHaveTextContent("Warning recipe cache full");
  await expect.element(lines.nth(3)).toHaveTextContent("Error connections unreadable");
  for (const line of lines.all()) {
    const icon = line.element().querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  }
});

test("shows every panel's facts, with the build mode and no separators", async () => {
  await show(client(status()));
  await Promise.all(
    ["Version", "Settings and storage", "Bitwarden connections", "Pateat service", "Logs"].map(
      (name) => expect.element(page.getByRole("heading", { name, exact: true })).toBeVisible(),
    ),
  );
  await expect
    .element(page.getByRole("definition").filter({ hasText: /^0\.1\.0/u }))
    .toHaveTextContent("0.1.0 (786d218) production build");
  await expect
    .element(page.getByRole("definition").filter({ hasText: /^alarms/u }))
    .toHaveTextContent("alarms, storage, offscreen, https://*/*");
  await expect.element(page.getByText("PBKDF2-SHA256 600000")).toBeVisible();
  await expect.element(page.getByText("14 days")).toBeVisible();
  await expect
    .element(
      page.getByText(
        "No passwords, keys, field values, names or emails are shown, copied or saved",
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByText(/^With site addresses included, a download names page paths/u))
    .toBeVisible();
  expect(document.querySelector("main")!.textContent).not.toContain("·");
});

test("debug logging shows when it ends and turns off at once", async () => {
  const debugUntil = NOW + 24 * 60 * 60_000;
  const value = client(
    status({
      logs: { entries: 3, bytes: 1024, recentErrors: 0, recentWarnings: 0, debugUntil },
    }),
  );
  await show(value);
  await expect.element(page.getByText(/^on until 2026-10-13T20:25Z/u)).toBeVisible();
  await page.getByRole("button", { name: "Turn off debug logging" }).click();
  expect(value.setDebugLogs).toHaveBeenCalledWith(false);
  await expect.element(page.getByText("Debug logging is off.")).toBeVisible();
});

test("debug logging that is off turns on until it is turned off", async () => {
  const value = client(status());
  await show(value);
  await expect.element(page.getByText("off", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Turn on debug logging", exact: true }).click();
  expect(value.setDebugLogs).toHaveBeenCalledWith(true);
  await expect.element(page.getByText("Debug logging is on until you turn it off.")).toBeVisible();
});

test("debug logging that stays on says so", async () => {
  const value = client(
    status({
      logs: {
        entries: 3,
        bytes: 1024,
        recentErrors: 0,
        recentWarnings: 0,
        debugUntil: DEBUG_UNTIL_TURNED_OFF,
      },
    }),
  );
  await show(value);
  await expect.element(page.getByText("on until turned off", { exact: true })).toBeVisible();
});

test("turning debug logging on updates the page in place, keeping the open log preview", async () => {
  const before = status();
  let read: (value: Awaited<ReturnType<DiagnosticsClient["load"]>>) => void = () => undefined;
  const value = {
    ...client(before),
    load: vi.fn<DiagnosticsClient["load"]>(async () => ({ ok: true, status: before })),
    exportLogs: vi.fn(async () => ({ ok: true as const, text: '{"pateat":"0.1.0"}\n{}\n' })),
    setDebugLogs: vi.fn(async () => ({ ok: true as const, debugUntil: DEBUG_UNTIL_TURNED_OFF })),
  } satisfies DiagnosticsClient;
  await show(value);
  await page.getByRole("button", { name: "Download logs" }).click();
  await expect.poll(preview).toBe('{"pateat":"0.1.0"}\n{}\n');
  value.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        read = resolve;
      }),
  );
  await page.getByRole("button", { name: "Turn on debug logging", exact: true }).click();
  // The button and its line follow at once, while the summary is read again.
  await expect.element(page.getByRole("button", { name: "Turn off debug logging" })).toBeVisible();
  await expect.element(page.getByText("on until turned off", { exact: true })).toBeVisible();
  expect(value.load).toHaveBeenCalledTimes(2);
  expect(document.querySelector("#diagnostics-status")!.textContent).toBe("");
  await expect.poll(preview).toBe('{"pateat":"0.1.0"}\n{}\n');
  read({
    ok: true,
    status: status({
      logs: {
        entries: 1285,
        bytes: 212 * 1024,
        recentErrors: 0,
        recentWarnings: 2,
        debugUntil: DEBUG_UNTIL_TURNED_OFF,
      },
    }),
  });
  await expect.element(page.getByText("1285 (212 KB)")).toBeVisible();
  await expect.poll(preview).toBe('{"pateat":"0.1.0"}\n{}\n');
  await expect.element(page.getByText("Debug logging is on until you turn it off.")).toBeVisible();
});

test("Refresh starts over and closes the log preview", async () => {
  const value = {
    ...client(status()),
    load: vi.fn<DiagnosticsClient["load"]>(async () => ({ ok: true, status: status() })),
    exportLogs: vi.fn(async () => ({ ok: true as const, text: '{"pateat":"0.1.0"}\n{}\n' })),
  } satisfies DiagnosticsClient;
  await show(value);
  await page.getByRole("button", { name: "Download logs" }).click();
  await expect.poll(preview).toBe('{"pateat":"0.1.0"}\n{}\n');
  let read: (value: Awaited<ReturnType<DiagnosticsClient["load"]>>) => void = () => undefined;
  value.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        read = resolve;
      }),
  );
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.element(page.getByText("Collecting diagnostics…")).toBeVisible();
  read({ ok: true, status: status() });
  await expect.element(page.getByRole("heading", { name: "Checks" })).toBeVisible();
  expect(value.load).toHaveBeenCalledTimes(2);
  expect(preview()).toBeUndefined();
});

test("turning debug logging off drops its end time at once", async () => {
  const on = status({
    logs: {
      entries: 3,
      bytes: 1024,
      recentErrors: 0,
      recentWarnings: 0,
      debugUntil: DEBUG_UNTIL_TURNED_OFF,
    },
  });
  // The summary read again never arrives, so only the response changes the page.
  const value = {
    ...client(on),
    load: vi
      .fn<DiagnosticsClient["load"]>(() => new Promise(() => undefined))
      .mockResolvedValueOnce({ ok: true, status: on }),
  } satisfies DiagnosticsClient;
  await show(value);
  await page.getByRole("button", { name: "Turn off debug logging" }).click();
  await expect
    .element(page.getByRole("button", { name: "Turn on debug logging", exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("off", { exact: true })).toBeVisible();
  expect(value.load).toHaveBeenCalledTimes(2);
});

test("a failed read after clearing the logs keeps the page as shown", async () => {
  const value = {
    ...client(status()),
    load: vi
      .fn<DiagnosticsClient["load"]>(async () => ({ ok: false, error: "unavailable" }))
      .mockResolvedValueOnce({ ok: true, status: status() }),
  } satisfies DiagnosticsClient;
  const queryClient = new QueryClient();
  await show(value, queryClient);
  await page.getByRole("button", { name: "Clear logs" }).click();
  await page.getByRole("button", { name: "Delete all log entries" }).click();
  await expect.element(page.getByText("Logs cleared.")).toBeVisible();
  await expect.poll(() => queryClient.getQueryState(["diagnostics"])?.status).toBe("error");
  expect(value.load).toHaveBeenCalledTimes(2);
  await expect.element(page.getByRole("heading", { name: "Checks" })).toBeVisible();
  expect(document.querySelector("#diagnostics-status")!.textContent).toBe("");
});
